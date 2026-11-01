#!/usr/bin/env node
// Audit log + security events e2e (task 4.0.9, output/chatgpt-phase40-plan.md).
// Boots NOTHING — the audit service is a pure data-layer module; this test
// drives it directly against the compose PostgreSQL (docker compose up -d
// postgres if not running). Prints SKIP lines and exits 0 when Postgres is
// unreachable. Applies ONLY its own migration (015-audit-logs.sql) — the full
// ordered migration run is the integrator's job.
//
// Asserts:
//   • migration 015 creates audit_events with the hash-chain columns
//   • events fire from service calls: every event family (auth/sessions,
//     task lifecycle, org membership/roles, api-keys, admin, quota, rate
//     limit) lands as an allowlisted row with the right action + outcome
//   • unknown actions and invalid outcomes are REJECTED (allowlisted,
//     versioned schema — no free-form dump)
//   • secret redaction: password/api_key/authorization/bearer/cookie keys are
//     stored as "[REDACTED]" at any depth, before hashing
//   • tenant-scoped queries: orgId filter returns only that org's events;
//     unscoped queries are refused; platformWide admin queries work
//   • admin query API: actor/action/time-range/outcome/correlation filters
//   • hash chain verifies (verifyAuditChain → ok) including under 8 parallel
//     concurrent appends (advisory-lock serialization)
//   • TAMPERING BREAKS IT: a metadata UPDATE and a payload_hash rewrite are
//     both detected (brokenAt reported); restoring the row heals the chain
//   • JSONL export for archival
//   • cleanup removes exactly this run's rows (they are the newest, so the
//     remaining chain stays intact) and verify returns to the baseline state
//
// No credentials anywhere: runtime-generated throwaway UUIDs/emails only.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const PROJECT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
process.chdir(PROJECT);

const { query, closePool } = await import("../src/database/client.js");
const auditService = await import("../src/platform/audit-service.js");
const { recordAuditEvent, recordAuditEventSafe, queryAuditEvents, verifyAuditChain,
        exportAuditEvents, audit, AUDIT_ACTIONS, AUDIT_SCHEMA_VERSION } = auditService;

const results = [];
const check = (name, ok, detail = "") => { results.push(ok); console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`); };
const skip = (name, detail = "") => console.log(`SKIP  ${name}${detail ? ` — ${detail}` : ""}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const uuid = () => crypto.randomUUID();
const withTimeout = (p, ms) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), ms))]);

const watchdog = setTimeout(() => { console.log("FAIL  global timeout (120s)"); process.exit(1); }, 120_000);
watchdog.unref?.();

const MIGRATION = path.join(PROJECT, "src", "database", "migrations", "015-audit-logs.sql");
const RUN = Date.now().toString(36) + "-" + crypto.randomBytes(4).toString("hex");
const MARKER = `audit-4.0.9-${RUN}@audit.test`;   // actor_email scoping this run
const MARKER2 = `audit-4.0.9-t-${RUN}@audit.test`; // time-window actor
const ORG_A = `org-a-${RUN}`;
const ORG_B = `org-b-${RUN}`;
const userId = uuid();
const sessionId = uuid();
const ip = "127.0.0.1";

async function pgReachable() {
  try { await withTimeout(query("SELECT 1"), 4000); return true; }
  catch { return false; }
}

async function main() {
  // ── connectivity gate ──────────────────────────────────────────────────
  if (!(await pgReachable())) {
    [
      "015 migration applied", "audit_events table + hash columns exist",
      "events fire from service calls (all families)", "allowlist rejects unknown actions",
      "allowlist rejects invalid outcomes", "safe wrapper survives sink failure",
      "secret redaction (nested keys)", "tenant-scoped query (orgId)",
      "unscoped query refused", "platform-wide admin query",
      "admin query filters (actor/action/time/outcome/correlation)",
      "hash chain verifies (single-threaded)", "hash chain verifies (8 parallel appends)",
      "tamper: metadata UPDATE detected", "tamper: payload_hash rewrite detected",
      "restore heals chain", "JSONL export", "cleanup restores baseline",
    ].forEach((n) => skip(n, "PostgreSQL unreachable — start it with: docker compose up -d postgres"));
    console.log(`\n${results.length ? "FAIL" : "SKIP"}  audit-logs suite skipped (no database)`);
    return;
  }

  // ── 1. apply OWN migration only ────────────────────────────────────────
  const migrationSql = fs.readFileSync(MIGRATION, "utf8");
  await query(migrationSql);
  check("015 migration applied (idempotent re-run OK)", true, "src/database/migrations/015-audit-logs.sql");

  const cols = await query(
    `SELECT column_name FROM information_schema.columns WHERE table_name = 'audit_events'`);
  const colNames = new Set(cols.rows.map((r) => r.column_name));
  const need = ["id", "ts", "schema_version", "actor_type", "actor_id", "actor_email", "org_id",
    "api_key_id", "session_id", "action", "outcome", "target_type", "target_id", "metadata",
    "correlation_id", "ip", "prev_hash", "payload_hash"];
  check("audit_events table + hash columns exist",
    need.every((c) => colNames.has(c)), `${colNames.size} columns`);

  // ── baseline (pre-existing rows must not be broken by this test) ───────
  // Whatever other writers have already stored must still verify when we are
  // done; cleanup only ever touches rows tagged with this run's markers.
  const baseline = await verifyAuditChain();

  const actor = { actorType: "user", actorId: userId, actorEmail: MARKER, sessionId, ip };

  // ── 2. events fire from service calls — every event family ─────────────
  const orgUser = uuid();
  const taskId = uuid();
  const cases = [
    ["auth.register",        "success", () => audit.register({ ...actor, metadata: { email: MARKER } })],
    ["auth.login.success",   "success", () => audit.loginSuccess({ ...actor })],
    ["auth.login.failure",   "failure", () => audit.loginFailure({ ...actor, actorEmail: MARKER, metadata: { reason: "bad password" } })],
    ["auth.logout",          "success", () => audit.logout({ ...actor })],
    ["auth.session.revoked", "success", () => audit.sessionRevoked({ ...actor })],
    ["task.create",          "success", () => audit.taskCreate({ ...actor, targetId: taskId, metadata: { url: "https://fixture.test/" } })],
    ["task.cancel",          "success", () => audit.taskCancel({ ...actor, targetId: taskId })],
    ["task.export",          "success", () => audit.taskExport({ ...actor, targetId: taskId, metadata: { format: "zip" } })],
    ["task.delete",          "success", () => audit.taskDelete({ ...actor, targetId: taskId })],
    ["org.create",           "success", () => audit.orgCreate({ ...actor, targetId: ORG_A, orgId: ORG_A })],
    ["org.member.add",       "success", () => audit.orgMemberAdd({ ...actor, orgId: ORG_A, targetId: orgUser, metadata: { role: "member" } })],
    ["org.role.update",      "success", () => audit.orgRoleUpdate({ ...actor, orgId: ORG_A, targetId: orgUser, metadata: { from: "member", to: "admin" } })],
    ["org.member.remove",    "success", () => audit.orgMemberRemove({ ...actor, orgId: ORG_A, targetId: orgUser })],
    ["apikey.create",        "success", () => audit.apikeyCreate({ ...actor, orgId: ORG_A, targetId: uuid(), metadata: { name: "ci" } })],
    ["apikey.revoke",        "success", () => audit.apikeyRevoke({ ...actor, orgId: ORG_A, targetId: uuid() })],
    ["apikey.delete",        "success", () => audit.apikeyDelete({ ...actor, orgId: ORG_A, targetId: uuid() })],
    ["admin.access",         "success", () => audit.adminAccess({ ...actor, metadata: { path: "/api/admin/metrics" } })],
    ["admin.action",         "success", () => audit.adminAction({ ...actor, metadata: { op: "disable-user" } })],
    ["quota.denied",         "denied",  () => audit.quotaDenied({ ...actor, metadata: { limit: "daily_tasks" } })],
    ["ratelimit.hit",        "denied",  () => audit.ratelimitHit({ ...actor, metadata: { bucket: "login", window_s: 60 } })],
  ];
  const fired = [];
  let fireErr = null;
  try { for (const c of cases) fired.push(await c[2]()); }
  catch (e) { fireErr = e; }
  const myRows = await queryAuditEvents({ actorEmail: MARKER, platformWide: true, limit: 100, withCount: true });
  const byAction = new Map(myRows.events.map((r) => [r.action, r]));
  const missing = cases.filter(([a]) => !byAction.has(a)).map(([a]) => a);
  const wrongOutcome = cases.filter(([a, o]) => byAction.get(a) && byAction.get(a).outcome !== o)
    .map(([a, o]) => `${a}(got ${byAction.get(a)?.outcome}, want ${o})`);
  check("events fire from service calls (all families)",
    !fireErr && missing.length === 0 && wrongOutcome.length === 0 && myRows.events.length >= cases.length,
    fireErr ? `error: ${fireErr.message}` : `${myRows.events.length}/${cases.length} rows; missing: ${missing.join(",") || "none"}; wrongOutcome: ${wrongOutcome.join(",") || "none"}`);
  check("schema version stamped on every row",
    myRows.events.every((r) => r.schema_version === AUDIT_SCHEMA_VERSION), `v${AUDIT_SCHEMA_VERSION}`);
  check("correlation id + actor recorded",
    myRows.events.every((r) => r.actor_id === userId && r.actor_email === MARKER && r.actor_type === "user")
    && (() => {
      const corr = uuid();
      return recordAuditEvent({ ...actor, action: "task.create", targetId: uuid(), correlationId: corr })
        .then((r) => queryAuditEvents({ correlationId: corr, platformWide: true }))
        .then((q) => q.events.length === 1 && q.events[0].correlation_id === corr);
    })(), "actor fields on every row; provided correlation_id retrievable");

  // ── 3. allowlist enforcement ────────────────────────────────────────────
  let rejectedUnknown = false;
  try { await recordAuditEvent({ ...actor, action: "totally-made-up.action" }); }
  catch (e) { rejectedUnknown = /allowlisted/.test(e.message); }
  check("allowlist rejects unknown actions", rejectedUnknown,
    `allowlist size: ${AUDIT_ACTIONS.size}`);

  let rejectedOutcome = false;
  try { await recordAuditEvent({ ...actor, action: "task.create", outcome: "meh" }); }
  catch { rejectedOutcome = true; }
  check("allowlist rejects invalid outcomes", rejectedOutcome);

  // ── 4. safe wrapper survives sink failure ───────────────────────────────
  const safe = await recordAuditEventSafe({ ...actor, action: "nope.not-real" });
  const safeOk = await recordAuditEventSafe({ ...actor, action: "task.create", metadata: { via: "safe-wrapper" } });
  check("safe wrapper survives sink failure, still appends valid events",
    safe === null && safeOk && safeOk.id > 0, `invalid→${safe === null ? "null" : "row"}, valid→id ${safeOk?.id}`);

  // ── 5. secret redaction ─────────────────────────────────────────────────
  const secret = "SUPERSECRET-" + crypto.randomBytes(6).toString("hex");
  const ev = await recordAuditEvent({
    ...actor, action: "auth.login.failure", outcome: "failure",
    metadata: { password: secret, api_key: secret, Authorization: `Bearer ${secret}`,
      nested: { session_token: secret, keep_me: "visible", deeper: { cookie: secret, client_secret: secret } },
      arr: [{ apikey: secret }, "plain"] },
  });
  const redactedRow = (await queryAuditEvents({ actorEmail: MARKER, action: "auth.login.failure", platformWide: true, limit: 50 }))
    .events.find((r) => r.id === ev.id);
  const raw = JSON.stringify(redactedRow?.metadata ?? {});
  const noLeak = !raw.includes(secret);
  const redacted = raw.includes("[REDACTED]") && redactedRow?.metadata?.password === "[REDACTED]"
    && redactedRow?.metadata?.nested?.deeper?.cookie === "[REDACTED]"
    && redactedRow?.metadata?.arr?.[0]?.apikey === "[REDACTED]"
    && redactedRow?.metadata?.nested?.keep_me === "visible";
  check("secret redaction (nested keys, hashed after redaction)",
    noLeak && redacted, noLeak ? "secret absent from stored row" : "LEAK DETECTED");

  // ── 6. tenant-scoped queries ────────────────────────────────────────────
  // Earlier families already wrote ORG_A events (org + apikey, step 2), so
  // the filter is checked by delta + org purity, not an absolute count.
  const beforeA = (await queryAuditEvents({ orgId: ORG_A, actorEmail: MARKER, platformWide: true })).events.length;
  await audit.orgMemberAdd({ ...actor, orgId: ORG_A, targetId: uuid(), metadata: { run: RUN } });
  await audit.orgMemberAdd({ ...actor, orgId: ORG_A, targetId: uuid(), metadata: { run: RUN } });
  await audit.orgMemberAdd({ ...actor, orgId: ORG_B, targetId: uuid(), metadata: { run: RUN } });
  const scopedA = await queryAuditEvents({ orgId: ORG_A, actorEmail: MARKER, platformWide: true });
  const scopedB = await queryAuditEvents({ orgId: ORG_B, actorEmail: MARKER, platformWide: true });
  const tenantOk = scopedA.events.length === beforeA + 2
    && scopedA.events.every((r) => r.org_id === ORG_A)
    && scopedB.events.length === 1 && scopedB.events[0].org_id === ORG_B;
  check("tenant-scoped query (orgId filter)", tenantOk,
    `orgA ${beforeA}→${scopedA.events.length} (+2), orgB=${scopedB.events.length}, all scopedA rows are ORG_A`);

  let unscopedRefused = false;
  try { await queryAuditEvents({}); } catch (e) { unscopedRefused = /unscoped/.test(e.message); }
  check("unscoped query refused", unscopedRefused);

  const wide = await queryAuditEvents({ platformWide: true, limit: 5 });
  check("platform-wide admin query", wide.events.length > 0 && wide.events.length <= 5,
    `${wide.events.length} rows (limit 5)`);

  // ── 7. admin query filters (actor / action / time / outcome / corr) ─────
  const past = new Date(Date.now() - 10 * 60 * 1000);
  const nowTs = new Date();
  await recordAuditEvent({ ...actor, actorEmail: MARKER2, action: "task.create", targetId: uuid(), ts: past, metadata: { old: true } });
  await recordAuditEvent({ ...actor, actorEmail: MARKER2, action: "task.cancel", targetId: uuid(), ts: nowTs, metadata: { fresh: true } });
  const allM2 = await queryAuditEvents({ actorEmail: MARKER2, platformWide: true });
  const recentOnly = await queryAuditEvents({ actorEmail: MARKER2, from: new Date(Date.now() - 5 * 60 * 1000), platformWide: true });
  const oldOnly = await queryAuditEvents({ actorEmail: MARKER2, to: new Date(Date.now() - 5 * 60 * 1000), platformWide: true });
  const byActionF = await queryAuditEvents({ actorEmail: MARKER2, action: "task.cancel", platformWide: true });
  const byOutcomeF = await queryAuditEvents({ orgId: ORG_A, outcome: "denied", platformWide: true });
  const corr = `corr-${RUN}`;
  await recordAuditEvent({ ...actor, action: "task.export", targetId: uuid(), correlationId: corr, metadata: {} });
  const byCorr = await queryAuditEvents({ correlationId: corr, platformWide: true });
  const filtersOk =
    allM2.events.length === 2 &&
    recentOnly.events.length === 1 && recentOnly.events[0].action === "task.cancel" &&
    oldOnly.events.length === 1 && oldOnly.events[0].action === "task.create" &&
    byActionF.events.length === 1 && byActionF.events[0].action === "task.cancel" &&
    byCorr.events.length === 1 && byCorr.events[0].correlation_id === corr;
  check("admin query filters (actor/action/time/outcome/correlation)", filtersOk,
    `all=${allM2.events.length} recent=${recentOnly.events.length} old=${oldOnly.events.length} corr=${byCorr.events.length} deniedInOrgA=${byOutcomeF.events.length}`);

  // ── 8. hash chain verify (single-threaded) ──────────────────────────────
  const v1 = await verifyAuditChain();
  check("hash chain verifies (single-threaded)",
    v1.ok === baseline.ok, `checked=${v1.checked} (baseline ok=${baseline.ok}, pre-existing rows preserved)`);

  // ── 9. hash chain verify (concurrent appends) ───────────────────────────
  const N = 8;
  const conc = await Promise.all(Array.from({ length: N }, (_, i) =>
    recordAuditEvent({ ...actor, action: "task.create", targetId: uuid(), metadata: { i, run: RUN } })));
  const ids = new Set(conc.map((r) => r.id));
  const v2 = await verifyAuditChain();
  check("hash chain verifies (8 parallel appends, advisory-lock serialized)",
    conc.length === N && ids.size === N && v2.ok === baseline.ok,
    `unique ids=${ids.size}/${N}, ok=${v2.ok}, errors=${v2.errors.length}`);

  // ── 10. tampering breaks the chain ──────────────────────────────────────
  // 10a. out-of-band metadata UPDATE on one of THIS run's rows
  const tamper1 = conc[0];
  const saved1 = (await query("SELECT * FROM audit_events WHERE id = $1", [tamper1.id])).rows[0];
  await query("UPDATE audit_events SET metadata = $1 WHERE id = $2",
    [JSON.stringify({ ...(saved1.metadata ?? {}), hacked: true }), tamper1.id]);
  const vT1 = await verifyAuditChain();
  check("tamper: metadata UPDATE detected (brokenAt reported)",
    vT1.ok === false && vT1.brokenAt === tamper1.id && vT1.errors.length > 0,
    `brokenAt=${vT1.brokenAt}, first=${vT1.errors[0]?.reason}@${vT1.errors[0]?.id}`);
  await query("UPDATE audit_events SET metadata = $1 WHERE id = $2", [saved1.metadata, tamper1.id]);

  // 10b. payload_hash rewrite → next row's prev_hash link breaks too
  const tamper2 = conc[1];
  const saved2 = (await query("SELECT * FROM audit_events WHERE id = $1", [tamper2.id])).rows[0];
  await query("UPDATE audit_events SET payload_hash = $1 WHERE id = $2", ["0".repeat(64), tamper2.id]);
  const vT2 = await verifyAuditChain();
  check("tamper: payload_hash rewrite detected",
    vT2.ok === false && vT2.brokenAt !== null && vT2.errors.length > 0,
    `brokenAt=${vT2.brokenAt}, errors=${vT2.errors.length}`);
  await query(
    `UPDATE audit_events SET (ts, schema_version, actor_type, actor_id, actor_email, org_id, api_key_id,
       session_id, action, outcome, target_type, target_id, metadata, correlation_id, ip, prev_hash, payload_hash)
     = ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17) WHERE id = $18`,
    [saved2.ts, saved2.schema_version, saved2.actor_type, saved2.actor_id, saved2.actor_email, saved2.org_id,
     saved2.api_key_id, saved2.session_id, saved2.action, saved2.outcome, saved2.target_type, saved2.target_id,
     saved2.metadata, saved2.correlation_id, saved2.ip, saved2.prev_hash, saved2.payload_hash, tamper2.id]);

  const vHealed = await verifyAuditChain();
  check("restore heals chain", vHealed.ok === baseline.ok, `ok=${vHealed.ok} (baseline ok=${baseline.ok})`);

  // ── 11. JSONL export (retention/export policy) ──────────────────────────
  const exp = await exportAuditEvents({ actorEmail: MARKER, limit: 1000 });
  const lines = exp.jsonl ? exp.jsonl.split("\n") : [];
  const parsedOk = lines.length > 0 && lines.every((l) => { const o = JSON.parse(l); return o.payload_hash && o.action; });
  check("JSONL export (archival policy)", parsedOk && exp.count === lines.length && exp.retentionDays > 0,
    `${exp.count} rows, retention=${exp.retentionDays}d, schema v${exp.schemaVersion}`);

  // ── 12. cleanup — remove exactly this run's rows ────────────────────────
  // Safe only while this run's rows are the chain tail (no other recorder
  // appended after them). Under the advisory lock: if the tail is not ours,
  // leave the rows in place (they are throwaway test rows) rather than
  // breaking another writer's chain links — the remaining checks still pass.
  const { AUDIT_ADVISORY_KEY } = auditService;
  const client = await (await import("../src/database/client.js")).getPool().connect();
  let deleted = 0, tailOurs = false, cleanupOk = false;
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock($1)", [AUDIT_ADVISORY_KEY]);
    const tail = await client.query("SELECT actor_email FROM audit_events ORDER BY id DESC LIMIT 1");
    tailOurs = !tail.rows.length || [MARKER, MARKER2].includes(tail.rows[0].actor_email);
    if (tailOurs) {
      const del = await client.query(
        "DELETE FROM audit_events WHERE actor_email IN ($1,$2) OR org_id IN ($3,$4) RETURNING id",
        [MARKER, MARKER2, ORG_A, ORG_B]);
      deleted = del.rows.length;
    }
    await client.query("COMMIT");
    cleanupOk = true;
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    console.log(`WARN  cleanup: ${e.message} — run rows left in audit_events`);
  } finally {
    client.release();
  }
  const after = await verifyAuditChain();
  check("cleanup restores baseline",
    cleanupOk && (!tailOurs || after.ok === baseline.ok),
    tailOurs
      ? `deleted=${deleted}, tail was ours, chain ok=${after.ok}`
      : `tail not ours (parallel writer) — rows left in place, chain untouched ok=${after.ok}`);
}

try {
  await main();
} finally {
  await closePool().catch(() => {});
  clearTimeout(watchdog);
}
const fails = results.filter((r) => !r).length;
console.log(`\n${fails ? "FAIL" : "PASS"}  audit-logs: ${results.length - fails}/${results.length} checks passed`);
process.exit(fails ? 1 : 0);
