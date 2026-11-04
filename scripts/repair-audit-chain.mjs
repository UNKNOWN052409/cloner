#!/usr/bin/env node
// Audit-chain REPAIR (G5.4): re-anchor a broken hash-chain suffix.
//
// verifyAuditChain() reported a break? This is the operator response tool.
// It re-chains rows whose CONTENT is attested good by recomputing ONLY the two
// hash columns from the stored content — the audit payload columns (ts, actor,
// action, metadata, …) are never touched, so any later content edit is still
// tamper-detectable. Typical use: healing rows written before a writer bug was
// fixed (G5.4 found exactly this: non-string actor fields hashed the JS form
// while the TEXT column stored pg's JSON form — rows could never verify again).
//
//   node scripts/repair-audit-chain.mjs                 # DRY RUN — report only
//   node scripts/repair-audit-chain.mjs --apply         # re-anchor first break → tail
//   node scripts/repair-audit-chain.mjs --apply --from 858
//   node scripts/repair-audit-chain.mjs --note "reason"  # recorded in the marker event
//
// Safety:
//   • runs under the audit advisory lock (AUDIT_ADVISORY_KEY) in ONE transaction
//   • refuses when the chain prefix before the first break is itself broken
//     (then the whole chain needs re-anchoring from row 1 — pass --from 1)
//   • appends an admin.action marker event documenting the repair
//   • the append-only service module (src/platform/audit-service.js) stays pure:
//     all mutation lives HERE, behind an explicit operator flag
import path from "node:path";
import { fileURLToPath } from "node:url";
import crypto from "node:crypto";

const PROJECT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
process.chdir(PROJECT);

const argv = process.argv.slice(2);
const APPLY = argv.includes("--apply");
const noteIdx = argv.indexOf("--note");
const NOTE = noteIdx >= 0 ? String(argv[noteIdx + 1] || "") : "";
const fromIdx = argv.indexOf("--from");
const FROM = fromIdx >= 0 ? Number(argv[fromIdx + 1]) : null;

const { query, closePool, withTransaction } = await import("../src/database/client.js");
const audit = await import("../src/platform/audit-service.js");
const { verifyAuditChain, computeEventHash, AUDIT_ADVISORY_KEY, GENESIS_PREV_HASH } = audit;

async function main() {
  const v = await verifyAuditChain();
  console.log(`verify: ok=${v.ok} checked=${v.checked} brokenAt=${v.brokenAt} errors=${v.errors.length}`);
  if (v.ok) {
    console.log("nothing to repair — chain verifies");
    await closePool();
    return;
  }
  const firstBroken = FROM ?? v.brokenAt;
  if (firstBroken == null) {
    console.error("REFUSED: no broken row identified (pass --from <id>)");
    process.exit(1);
  }
  if (firstBroken !== 1) {
    // the prefix must verify up to the repair point; verifyAuditChain only
    // reports the FIRST break, so a firstBroken that equals brokenAt means the
    // prefix (rows < firstBroken) verified clean.
    const prefixClean = FROM == null || v.errors.every((e) => Number(e.id) >= firstBroken);
    if (!prefixClean) {
      console.error(`REFUSED: prefix before ${firstBroken} is also broken — re-anchor from row 1 (--from 1)`);
      process.exit(1);
    }
  }

  const rows = (
    await query(
      `SELECT id, ts, schema_version, actor_type, actor_id, actor_email, org_id, api_key_id, session_id,
              action, outcome, target_type, target_id, metadata, correlation_id, ip, prev_hash, payload_hash
       FROM audit_events WHERE id >= $1 ORDER BY id ASC`,
      [firstBroken]
    )
  ).rows;
  console.log(`${APPLY ? "APPLY" : "DRY-RUN"}: re-anchoring ${rows.length} row(s) from id ${firstBroken} → tail${NOTE ? ` (${NOTE})` : ""}`);

  const payloadOf = (row) => ({
    tsIso: row.ts.toISOString(),
    schemaVersion: row.schema_version,
    actorType: row.actor_type,
    actorId: row.actor_id,
    actorEmail: row.actor_email,
    orgId: row.org_id,
    apiKeyId: row.api_key_id,
    sessionId: row.session_id,
    action: row.action,
    outcome: row.outcome,
    targetType: row.target_type,
    targetId: row.target_id,
    metadata: row.metadata ?? {},
    correlationId: row.correlation_id,
    ip: row.ip,
  });

  let prev = null;
  const updates = [];
  for (const row of rows) {
    const prevHash = prev === null ? row.prev_hash : prev; // first row keeps its stored link
    const payloadHash = computeEventHash(prevHash, payloadOf(row));
    updates.push({ id: row.id, prevHash, payloadHash, oldHash: row.payload_hash });
    prev = payloadHash;
  }
  const changed = updates.filter((u) => u.payloadHash !== u.oldHash).length;
  console.log(`rows to rewrite: ${updates.length} (payload_hash changes: ${changed}); content columns: untouched`);

  if (!APPLY) {
    console.log("dry-run only — re-run with --apply to re-anchor");
    await closePool();
    return;
  }

  await withTransaction(async (client) => {
    await client.query("SELECT pg_advisory_xact_lock($1)", [AUDIT_ADVISORY_KEY]);
    for (const u of updates) {
      await client.query(
        `UPDATE audit_events SET prev_hash = $2, payload_hash = $3 WHERE id = $1 AND payload_hash = $4`,
        [u.id, u.prevHash, u.payloadHash, u.oldHash] // optimistic: refuse if someone edited the row mid-repair
      );
    }
  });
  console.log(`re-anchored ${updates.length} row(s)`);

  // document the repair IN the (now verifiable) chain
  const marker = await audit.recordAuditEvent({
    action: "admin.action",
    actorType: "service",
    actorEmail: "audit-chain-repair@ops.local",
    targetType: "audit_events",
    metadata: {
      repair: true,
      fromId: String(firstBroken),
      rowsRewritten: updates.length,
      reason: NOTE || "re-anchor after verifyAuditChain reported a break",
      tool: "scripts/repair-audit-chain.mjs",
    },
  });
  const vAfter = await verifyAuditChain();
  console.log(`marker event id=${marker.id}`);
  console.log(`verify after repair: ok=${vAfter.ok} checked=${vAfter.checked}`);
  if (!vAfter.ok) {
    console.error("chain STILL broken after repair — inspect manually");
    process.exit(1);
  }
  await closePool();
}

main().catch(async (e) => {
  console.error("repair failed:", e?.stack || e);
  await closePool().catch(() => {});
  process.exit(1);
});
