#!/usr/bin/env node
// G5.4 HOSTILE data-integrity hunt (task G5.4, "hunt-data").
//
// Five hostile axes, all against the REAL compose PostgreSQL + the REAL
// filesystem (no mocks in product paths — the only simulators here are the
// remote-end stand-ins this test file itself provides, e.g. the credit-ledger
// stub required by compute-accounting's documented injection contract):
//
//   H1  audit chain tamper detection — UPDATE of metadata / payload_hash,
//       mid-chain DELETE, oldest-row DELETE, restore-heals, 10 parallel
//       appends, verify racing live appends, cleanup keeps the shared chain
//       intact.
//   H2  ledger double-spend — 10 PARALLEL quota reservations against tight
//       limits (concurrent 3 / daily 4): exactly the allowed number wins,
//       quota_usage_events + quota_usage_daily count each accepted reservation
//       exactly once, double release counts once, ledger reconciliation
//       matches, stale-reclaim never touches fresh work.
//   H2b cost ledger double-spend — 10 parallel settleJobCost on one job
//       debits exactly once (conforming ledger), 10 parallel
//       postUnsettledCosts sweeps single-flight each row even with a
//       NON-idempotent counting ledger.
//   H3  artifact manifest vs disk — a recorded integrity manifest must fail
//       closed (export refuses) when a listed file is modified or missing;
//       mutable header files (manifest.json lifecycle patch) stay legal.
//   H4  backup/restore byte-exactness — artifact tar round-trip is byte-identical
//       (spaces, unicode, NEWLINE-named files, private/ excluded), corrupt
//       archive refused, planted extra file detected; DB dump → restore into a
//       scratch database → per-table content hashes equal the source (modulo
//       the documented in-flight reconciliation).
//   H5  retention sweep over-reach — platform-data sweep must never delete
//       in-flight or pinned tasks; artifact sweep never touches pinned jobs,
//       future-expiry jobs, legacy dirs (unless allowLegacy), orphans (unless
//       the explicit policy), or anything outside the artifacts root; DB
//       retention bookkeeping never purges active/pinned rows.
//
// SKIP contract: if the compose Postgres is unreachable every check prints
// SKIP and the script exits 0.
// Cleanup: every DB row is marker-scoped and removed; the audit chain suffix
// rule (below) keeps the shared dev chain verifiable afterwards.
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const PROJECT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const RUN = Date.now().toString(36) + "-" + crypto.randomBytes(4).toString("hex");
const MARK = `hunt-g54-${RUN}`;

const results = [];
const check = (name, ok, detail = "") => {
  results.push(ok);
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
};
const section = (t) => console.log(`\n== ${t} ==`);
const sha256Buf = (b) => crypto.createHash("sha256").update(b).digest("hex");
const sha256File = (f) => sha256Buf(fs.readFileSync(f));
const uuid = () => crypto.randomUUID();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const watchdog = setTimeout(() => { console.log("FAIL  global timeout (420s)"); process.exit(1); }, 420_000);
watchdog.unref();

// ---------- connectivity gate (SKIP contract) ----------
const db = await import("../src/database/client.js");
try {
  await db.query("SELECT 1");
} catch (e) {
  const msg = `compose Postgres unreachable (${String(e?.message || e).slice(0, 120)}) — docker compose up -d postgres`;
  for (let i = 0; i < 30; i++) console.log(`SKIP  hunt check ${i + 1}/30 — ${msg}`);
  console.log(`\nRESULT: SKIP  (0/30 checks run — database unavailable)`);
  process.exit(0);
}

// apply the migrations the hunt touches (idempotent, same contract as the
// other suites — the full ordered run stays the integrator's job)
for (const m of ["012-quotas.sql", "015-audit-logs.sql", "014-artifact-retention.sql", "030-compute-costs.sql"]) {
  const sql = fs.readFileSync(path.join(PROJECT, "src", "database", "migrations", m), "utf8");
  await db.query(sql);
}

const auditService = await import("../src/platform/audit-service.js");
const quotas = await import("../src/platform/quota-service.js");
const accounting = await import("../src/platform/compute-accounting.js");
const LC = await import("../src/storage/artifact-lifecycle.js");
const { recordAuditEvent, verifyAuditChain, audit } = auditService;
const { query, closePool } = db;

const BACKUP_DB = path.join(PROJECT, "scripts", "backup-database.mjs");
const RESTORE_DB = path.join(PROJECT, "scripts", "restore-database.mjs");
const BACKUP_ART = path.join(PROJECT, "scripts", "backup-artifacts.mjs");

// ============================================================================
// H1 — audit chain tamper detection
// ============================================================================
async function huntAuditChain() {
  section("H1  audit chain tamper detection");
  const actor = (n) => ({ action: "admin.action", actorEmail: `${MARK}-${n}@hunt.test`, actorType: "service", metadata: { run: RUN, n, note: "hunt row — safe to verify" } });

  // baseline state of the shared dev chain (for cleanup accounting)
  const base = await query("SELECT count(*)::int AS n, coalesce(max(id), 0) AS maxid FROM audit_events");
  const baseCount = Number(base.rows[0].n);
  const baseMaxId = Number(base.rows[0].maxid);

  const v0 = await verifyAuditChain();
  check("H1.0 baseline chain verifies", v0.ok === true, `checked=${v0.checked} brokenAt=${v0.brokenAt}`);

  // sequential appends to tamper with
  const ids = [];
  for (let i = 0; i < 6; i++) {
    const r = await recordAuditEvent(actor(`t${i}`));
    ids.push(r.id);
  }
  check("H1.1 six sequential appends landed", ids.length === 6, ids.join(","));

  const fullRow = async (id) => (await query("SELECT * FROM audit_events WHERE id = $1", [id])).rows[0];
  const restoreRow = async (row) => {
    await query(
      `INSERT INTO audit_events
        (id, ts, schema_version, actor_type, actor_id, actor_email, org_id, api_key_id, session_id,
         action, outcome, target_type, target_id, metadata, correlation_id, ip, prev_hash, payload_hash)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)`,
      [row.id, row.ts, row.schema_version, row.actor_type, row.actor_id, row.actor_email, row.org_id,
       row.api_key_id, row.session_id, row.action, row.outcome, row.target_type, row.target_id,
       row.metadata, row.correlation_id, row.ip, row.prev_hash, row.payload_hash]
    );
  };

  // --- tamper 1: metadata UPDATE of a mid row ---
  await query("UPDATE audit_events SET metadata = metadata || '{\"evil\":true}'::jsonb WHERE id = $1", [ids[2]]);
  let v = await verifyAuditChain();
  check("H1.2 metadata UPDATE detected", v.ok === false && v.brokenAt === ids[2], `brokenAt=${v.brokenAt} errors=${v.errors.length}`);
  await query("UPDATE audit_events SET metadata = metadata - 'evil' WHERE id = $1", [ids[2]]);
  v = await verifyAuditChain();
  check("H1.3 restore heals chain after metadata tamper", v.ok === true, `brokenAt=${v.brokenAt}`);

  // --- tamper 2: payload_hash rewrite (capture the true value first) ---
  const trueHash1 = (await fullRow(ids[1])).payload_hash;
  await query("UPDATE audit_events SET payload_hash = repeat('0', 64) WHERE id = $1", [ids[1]]);
  v = await verifyAuditChain();
  check("H1.4 payload_hash rewrite detected", v.ok === false && v.brokenAt === ids[1], `brokenAt=${v.brokenAt}`);
  await query("UPDATE audit_events SET payload_hash = $2 WHERE id = $1", [ids[1], trueHash1]);
  v = await verifyAuditChain();
  check("H1.5 exact-hash restore heals chain", v.ok === true, `brokenAt=${v.brokenAt}`);

  // --- tamper 3: mid-chain DELETE + exact restore ---
  const deleted = await fullRow(ids[3]);
  await query("DELETE FROM audit_events WHERE id = $1", [ids[3]]);
  v = await verifyAuditChain();
  check("H1.6 mid-chain DELETE detected", v.ok === false && v.brokenAt === ids[4], `brokenAt=${v.brokenAt}`);
  await restoreRow(deleted);
  v = await verifyAuditChain();
  check("H1.7 DELETE restore heals chain", v.ok === true, `brokenAt=${v.brokenAt}`);

  // --- tamper 4: oldest-row DELETE (head of MY block) ---
  const head = await fullRow(ids[0]);
  await query("DELETE FROM audit_events WHERE id = $1", [ids[0]]);
  v = await verifyAuditChain();
  check("H1.8 oldest-row DELETE detected", v.ok === false, `brokenAt=${v.brokenAt}`);
  await restoreRow(head);
  v = await verifyAuditChain();
  check("H1.9 head restore heals chain", v.ok === true, `brokenAt=${v.brokenAt}`);

  // --- 10 parallel appends ---
  const vals = await Promise.all(Array.from({ length: 10 }, (_, i) =>
    recordAuditEvent({ ...actor(`p${i}`), metadata: { run: RUN, parallel: i, note: "hunt row — safe to verify" } })));
  const pids = new Set(vals.map((r) => r.id));
  v = await verifyAuditChain();
  const mine = (await query("SELECT count(*)::int AS n FROM audit_events WHERE actor_email LIKE $1", [`${MARK}-%@hunt.test`])); 
  check("H1.10 10 parallel appends → chain verifies, 10 distinct ids, all present",
    v.ok === true && pids.size === 10 && Number(mine.rows[0].n) >= 16,
    `checked=${v.checked} distinctIds=${pids.size} myRows=${mine.rows[0].n}`);

  // --- verify racing live appends (no false positive, converges to ok) ---
  const racing = Promise.all(Array.from({ length: 10 }, (_, i) =>
    recordAuditEvent({ ...actor(`race${i}`), metadata: { run: RUN, race: i } })));
  const vRace = await verifyAuditChain();
  await racing;
  v = await verifyAuditChain();
  check("H1.11 verify racing appends — chain holds mid-flight AND at rest",
    vRace.ok === true && v.ok === true, `mid=${vRace.ok ? "ok" : "break@" + vRace.brokenAt} final=${v.checked}`);

  // --- tamper DURING concurrency: rewrite metadata FIRST (committed), then run
  // verify while 10 appends land — the tampered row must surface, and healing
  // must restore a clean chain over the concurrent traffic.
  {
    await query("UPDATE audit_events SET metadata = metadata || '{\"evil2\":1}'::jsonb WHERE id = $1", [ids[5]]);
    const appends = Promise.all(Array.from({ length: 10 }, (_, i) => recordAuditEvent({ ...actor(`tam${i}`) })));
    const vMid = await verifyAuditChain();
    await appends;
    await query("UPDATE audit_events SET metadata = metadata - 'evil2' WHERE id = $1", [ids[5]]);
    const vHealed = await verifyAuditChain();
    check("H1.12 tamper under live appends is detected and heals back to ok",
      vMid.ok === false && vMid.brokenAt === ids[5] && vHealed.ok === true,
      `midVerifyBrokenAt=${vMid.brokenAt} healedOk=${vHealed.ok}`);
  }

  // --- hostile writer-input regression: non-string actor fields must hash
  // symmetrically (write form === verify form). Before the symmetric-coercion
  // fix, a single number/object email poisoned the chain permanently — exactly
  // what rows 858-860 in the dev database prove.
  const poisonIds = [];
  {
    const weird = [42, { x: 1 }, ["a"], true, Buffer.from("buf")];
    for (const w of weird) {
      try {
        const r = await recordAuditEvent({ action: "admin.action", actorEmail: w, actorType: "service", metadata: { run: RUN, weird: true } });
        poisonIds.push(r.id);
      } catch { /* a rejected write is acceptable — but it must not poison */ }
    }
    const vP = await verifyAuditChain();
    check("H1.14 non-string actor fields (number/object/array/bool/Buffer) keep the chain verifiable",
      vP.ok === true && poisonIds.length >= 3, `written=${poisonIds.length} ok=${vP.ok} brokenAt=${vP.brokenAt}`);
  }

  // --- cleanup: remove MY rows only if they are the newest contiguous suffix ---
  const suffix = await query(
    "SELECT coalesce(max(id),0) AS mymax FROM audit_events WHERE actor_email LIKE $1 OR id = ANY($2::bigint[])",
    [`${MARK}-%@hunt.test`, poisonIds]);
  const tblMax = await query("SELECT coalesce(max(id),0) AS m FROM audit_events");
  const myMax = Number(suffix.rows[0].mymax);
  const globalMax = Number(tblMax.rows[0].m);
  if (myMax > 0 && myMax === globalMax) {
    await query("DELETE FROM audit_events WHERE actor_email LIKE $1 OR id = ANY($2::bigint[])",
      [`${MARK}-%@hunt.test`, poisonIds]);
    const after = await query("SELECT count(*)::int AS n FROM audit_events");
    const vEnd = await verifyAuditChain();
    check("H1.15 cleanup removed exactly this run's rows; shared chain still verifies",
      vEnd.ok === true && Number(after.rows[0].n) === baseCount,
      `before=${baseCount} after=${after.rows[0].n}`);
  } else {
    check("H1.15 cleanup skipped (newer foreign rows appended — removing mine would fork the chain)", myMax !== globalMax,
      `myMax=${myMax} globalMax=${globalMax} rows left for ops pruning`);
  }
}

// ============================================================================
// H2 — ledger double-spend: 10 parallel quota reservations
// ============================================================================
async function huntQuotaLedger() {
  section("H2  ledger double-spend — 10 parallel reservations");
  const scope = { scope_type: "user", scope_id: uuid() };
  const key = (n) => `${MARK}-t${n}`;
  try {
    await quotas.setQuotaLimit(scope, "max_concurrent_jobs", 3);
    await quotas.setQuotaLimit(scope, "max_jobs_per_day", 4);

    // wave 1: 10 parallel → concurrent limit 3 → exactly 3 accepted
    const wave1 = await Promise.allSettled(
      Array.from({ length: 10 }, (_, i) => quotas.reserveJobSlot(scope, key(i), { explorationMinutes: 0 }))
    );
    const ok1 = wave1.filter((r) => r.status === "fulfilled");
    const rej1 = wave1.filter((r) => r.status === "rejected");
    check("H2.1 10 parallel vs limit 3 → exactly 3 accepted, 7 rejected",
      ok1.length === 3 && rej1.length === 7,
      `ok=${ok1.length} rej=${rej1.length}`);
    const reasons1 = new Set(rej1.map((r) => r.reason?.reason));
    check("H2.2 rejections carry the typed concurrent_job_limit reason",
      reasons1.has("concurrent_job_limit"), [...reasons1].join(","));

    const live = (await query(
      "SELECT count(*)::int AS n FROM quota_reservations WHERE scope_type=$1 AND scope_id=$2 AND released_at IS NULL",
      [scope.scope_type, scope.scope_id])).rows[0].n;
    const startedEvents = (await query(
      "SELECT count(*)::int AS n FROM quota_usage_events WHERE scope_type=$1 AND scope_id=$2 AND event_type='started' AND task_key LIKE $3",
      [scope.scope_type, scope.scope_id, `${MARK}%`])).rows[0].n;
    const daily = (await query(
      "SELECT jobs_started::int AS n FROM quota_usage_daily WHERE scope_type=$1 AND scope_id=$2",
      [scope.scope_type, scope.scope_id])).rows[0]?.n ?? 0;
    check("H2.3 ledger counts each accepted reservation EXACTLY once (no double-spend)",
      Number(live) === 3 && Number(startedEvents) === 3 && Number(daily) === 3,
      `live=${live} startedEvents=${startedEvents} daily=${daily}`);

    // wave 2: free 2 slots → daily allows exactly 1 more (4-3)
    const resRows = await query(
      "SELECT id, task_key FROM quota_reservations WHERE scope_type=$1 AND scope_id=$2 AND released_at IS NULL ORDER BY reserved_at",
      [scope.scope_type, scope.scope_id]);
    const releasedKeys = resRows.rows.slice(0, 2).map((r) => r.task_key);
    for (const k of releasedKeys) await quotas.releaseReservation(scope, k, { outcome: "completed" });

    const wave2 = await Promise.allSettled(
      Array.from({ length: 10 }, (_, i) => quotas.reserveJobSlot(scope, key(`w2-${i}`)))
    );
    const ok2 = wave2.filter((r) => r.status === "fulfilled");
    const rej2 = wave2.filter((r) => r.status === "rejected");
    check("H2.4 second wave: daily limit admits exactly 1 more (3+1=4)",
      ok2.length === 1 && rej2.length === 9,
      `ok=${ok2.length} rej=${rej2.length}`);
    check("H2.5 second-wave rejections are daily_job_limit",
      rej2.every((r) => r.reason?.reason === "daily_job_limit"),
      [...new Set(rej2.map((r) => r.reason?.reason))].join(","));

    const daily2 = Number((await query(
      "SELECT jobs_started::int AS n FROM quota_usage_daily WHERE scope_type=$1 AND scope_id=$2",
      [scope.scope_type, scope.scope_id])).rows[0]?.n ?? 0);
    const started2 = Number((await query(
      "SELECT count(*)::int AS n FROM quota_usage_events WHERE scope_type=$1 AND scope_id=$2 AND event_type='started' AND task_key LIKE $3",
      [scope.scope_type, scope.scope_id, `${MARK}%`])).rows[0].n);
    check("H2.6 ledger after both waves: 4 started exactly — no phantom or double count",
      daily2 === 4 && started2 === 4, `daily=${daily2} events=${started2}`);

    // idempotent double release under concurrency: 10 parallel releases of ONE live slot
    const liveRows = await query(
      "SELECT task_key FROM quota_reservations WHERE scope_type=$1 AND scope_id=$2 AND released_at IS NULL",
      [scope.scope_type, scope.scope_id]);
    const targetKey = liveRows.rows[0].task_key;
    const rel = await Promise.all(
      Array.from({ length: 10 }, () => quotas.releaseReservation(scope, targetKey, { outcome: "failed" })));
    const releasedTrue = rel.filter((r) => r.released === true).length;
    const completedEvents = Number((await query(
      "SELECT count(*)::int AS n FROM quota_usage_events WHERE scope_type=$1 AND scope_id=$2 AND event_type='failed' AND task_key=$3",
      [scope.scope_type, scope.scope_id, targetKey])).rows[0].n);
    check("H2.7 10 parallel double-releases count the outcome exactly once",
      releasedTrue === 1 && completedEvents === 1, `released=${releasedTrue} failedEvents=${completedEvents}`);

    // reconciliation: rebuild from the append-only ledger must equal the counters
    const rec = await quotas.reconcileDailyFromLedger(scope);
    const dailyRow = (await query(
      "SELECT * FROM quota_usage_daily WHERE scope_type=$1 AND scope_id=$2", [scope.scope_type, scope.scope_id])).rows[0];
    check("H2.8 reconcile-from-ledger matches the materialized counters",
      rec.jobs_started === Number(dailyRow.jobs_started) && rec.jobs_completed === Number(dailyRow.jobs_completed),
      JSON.stringify(rec));

    // stale reclaim over-reach: fresh reservations must survive; only backdated ones die.
    // (lift the daily limit — the earlier waves already consumed it; this phase tests reclaim, not quota)
    await quotas.setQuotaLimit(scope, "max_jobs_per_day", null);
    const staleKey = key("stale");
    await quotas.reserveJobSlot(scope, staleKey);
    await query("UPDATE quota_reservations SET reserved_at = now() - interval '2 hours' WHERE scope_type=$1 AND scope_id=$2 AND task_key=$3",
      [scope.scope_type, scope.scope_id, staleKey]);
    const freshKey = key("fresh");
    await quotas.reserveJobSlot(scope, freshKey);
    const beforeReclaim = Number((await query(
      "SELECT count(*)::int AS n FROM quota_reservations WHERE scope_type=$1 AND scope_id=$2 AND released_at IS NULL",
      [scope.scope_type, scope.scope_id])).rows[0].n);
    await quotas.reclaimStaleReservations({ maxAgeMs: 60 * 60 * 1000 });
    const staleState = await query(
      "SELECT released_at, released_reason FROM quota_reservations WHERE scope_type=$1 AND scope_id=$2 AND task_key=$3",
      [scope.scope_type, scope.scope_id, staleKey]);
    const freshState = await query(
      "SELECT released_at FROM quota_reservations WHERE scope_type=$1 AND scope_id=$2 AND task_key=$3",
      [scope.scope_type, scope.scope_id, freshKey]);
    const afterReclaim = Number((await query(
      "SELECT count(*)::int AS n FROM quota_reservations WHERE scope_type=$1 AND scope_id=$2 AND released_at IS NULL",
      [scope.scope_type, scope.scope_id])).rows[0].n);
    check("H2.9 stale reclaim releases only backdated work, fresh slot survives (no over-reach)",
      staleState.rows[0]?.released_at !== null && freshState.rows[0]?.released_at === null &&
        afterReclaim === beforeReclaim - 1,
      `staleReleased=${!!staleState.rows[0]?.released_at} freshKept=${freshState.rows[0]?.released_at === null} live ${beforeReclaim}→${afterReclaim}`);
  } finally {
    await query("DELETE FROM quota_usage_events WHERE scope_type=$1 AND scope_id=$2", [scope.scope_type, scope.scope_id]);
    await query("DELETE FROM quota_usage_daily WHERE scope_type=$1 AND scope_id=$2", [scope.scope_type, scope.scope_id]);
    await query("DELETE FROM quota_reservations WHERE scope_type=$1 AND scope_id=$2", [scope.scope_type, scope.scope_id]);
    await query("DELETE FROM quota_limits WHERE scope_type=$1 AND scope_id=$2", [scope.scope_type, scope.scope_id]);
  }
}

// ============================================================================
// H2b — cost ledger double-spend (compute accounting)
// ============================================================================
async function huntCostLedger() {
  section("H2b  cost ledger double-spend (compute accounting)");
  const scope = { scope_type: "user", scope_id: uuid() };
  const jobKey = `${MARK}-job`;
  // conforming (idempotent-per-taskKey) ledger — the injected contract
  const conforming = (() => {
    const seen = new Map(); const calls = [];
    return {
      debits: calls,
      async debit(req) {
        const k = `${req.scopeType}:${req.scopeId}:${req.taskKey}`;
        calls.push({ k, amount: req.amount });
        if (seen.has(k)) return { ref: seen.get(k) };
        const ref = `ref-${seen.size + 1}`;
        seen.set(k, ref);
        return { ref };
      },
    };
  })();
  try {
    // 10 parallel settles of the SAME job → exactly one debit
    const res = await Promise.all(
      Array.from({ length: 10 }, () =>
        accounting.settleJobCost(scope, jobKey, { userId: null, runtimeMs: 120_000, browserSlots: 2, artifactBytes: 1024, ledger: conforming })));
    const settled = res.filter((r) => r.settled === true);
    const sameKeyDebits = conforming.debits.filter((d) => d.k.endsWith(jobKey));
    const row = await accounting.getJobCost(scope, jobKey);
    check("H2b.1 10 parallel settles → 1 ledger debit, row posted, settled for all",
      sameKeyDebits.length === 1 && row?.ledger_status === "posted" && settled.length === 10,
      `debits=${sameKeyDebits.length} status=${row?.ledger_status} settled=${settled.length}`);
    check("H2b.2 cost exact at 6 decimals (2min=0.02 + 2slots=0.01 + 1024B=0.00001024→round6=0.00001 → 0.03001)",
      Math.abs(Number(row.cost_total) - 0.03001) < 1e-9, `cost_total=${row.cost_total}`);

    // 10 parallel settles of 10 DISTINCT jobs → 10 debits, 10 rows
    const distinct = Array.from({ length: 10 }, (_, i) => `${MARK}-d${i}`);
    await Promise.all(distinct.map((k) =>
      accounting.settleJobCost(scope, k, { runtimeMs: 60_000, browserSlots: 0, artifactBytes: 0, ledger: conforming })));
    check("H2b.3 10 distinct jobs settle independently (10 debits, 10 rows)",
      conforming.debits.length === 11 &&
      (await query("SELECT count(*)::int AS n FROM compute_job_costs WHERE scope_type=$1 AND scope_id=$2 AND ledger_status='posted'",
        [scope.scope_type, scope.scope_id])).rows[0].n === 11,
      `debits=${conforming.debits.length}`);

    // 5 unposted rows (no ledger at settle time), then 10 PARALLEL sweeps with a
    // NON-idempotent counting ledger — DB single-flight must debit each row once
    const unposted = Array.from({ length: 5 }, (_, i) => `${MARK}-u${i}`);
    for (const k of unposted) {
      await accounting.settleJobCost(scope, k, { runtimeMs: 60_000, browserSlots: 0, artifactBytes: 0 });
    }
    const counter = [];
    const nonIdempotent = {
      async debit(req) { counter.push({ k: req.taskKey, amount: req.amount }); return { ref: `c${counter.length}` }; },
    };
    await Promise.all(Array.from({ length: 10 }, () =>
      accounting.postUnsettledCosts({ ledger: nonIdempotent, scope, limit: 100 })));
    const perKey = new Map();
    for (const c of counter) perKey.set(c.k, (perKey.get(c.k) || 0) + 1);
    const doublePosted = [...perKey.entries()].filter(([, n]) => n > 1);
    const statuses = await query(
      "SELECT task_key, ledger_status FROM compute_job_costs WHERE scope_type=$1 AND scope_id=$2 AND task_key = ANY($3)",
      [scope.scope_type, scope.scope_id, unposted]);
    check("H2b.4 10 parallel sweeps, NON-idempotent ledger → each row debited EXACTLY once (DB single-flight holds)",
      doublePosted.length === 0 && statuses.rows.every((r) => r.ledger_status === "posted"),
      `debitsPerKey=${JSON.stringify([...perKey.entries()])} double=${doublePosted.length}`);
  } finally {
    await query("DELETE FROM compute_job_costs WHERE scope_type=$1 AND scope_id=$2", [scope.scope_type, scope.scope_id]);
    await query("DELETE FROM compute_cost_rates WHERE scope_type=$1 AND scope_id=$2", [scope.scope_type, scope.scope_id]);
    accounting.setCreditLedger(null);
  }
}

// ============================================================================
// H3 — artifact manifest vs disk mismatches
// ============================================================================
async function huntManifestVsDisk() {
  section("H3  artifact manifest vs disk mismatches");
  const jobId = `hunt-${RUN}`;
  const v2Dir = path.join(PROJECT, "artifacts", jobId);
  const projectDir = v2Dir + "-project";
  try {
    fs.mkdirSync(path.join(v2Dir, "pages"), { recursive: true });
    fs.mkdirSync(path.join(v2Dir, "assets"), { recursive: true });
    fs.mkdirSync(projectDir, { recursive: true });
    fs.writeFileSync(path.join(v2Dir, "manifest.json"), JSON.stringify({ schemaVersion: "1.0.0", jobId, status: "completed" }, null, 2));
    fs.writeFileSync(path.join(v2Dir, "pages", "page-1.html"), "<html><body>hunt page</body></html>");
    fs.writeFileSync(path.join(v2Dir, "assets", "logo.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4]));
    fs.writeFileSync(path.join(projectDir, "index.html"), "<html><body>clone</body></html>");

    const exporter = await import("../src/platform/exporter.js");
    const hasIntegrityApi = typeof LC.writeIntegrityManifest === "function" && typeof LC.verifyArtifactIntegrity === "function";

    if (!hasIntegrityApi) {
      check("H3.1 integrity manifest API exists (writeIntegrityManifest/verifyArtifactIntegrity)", false,
        "API missing — a manifest/disk mismatch would export silently");
    } else {
      check("H3.1 integrity manifest API exists", true);

      LC.writeIntegrityManifest(v2Dir);
      let v = LC.verifyArtifactIntegrity(v2Dir);
      check("H3.2 clean tree verifies against its recorded manifest", v.ok === true, JSON.stringify({ missing: v.missing?.length, modified: v.modified?.length }));

      // modified file on disk
      fs.writeFileSync(path.join(v2Dir, "pages", "page-1.html"), "<html><body>TAMPERED</body></html>");
      v = LC.verifyArtifactIntegrity(v2Dir);
      check("H3.3 modified file detected", v.ok === false && v.modified?.some((m) => m.includes("page-1.html")),
        `modified=${JSON.stringify(v.modified)}`);

      // export must REFUSE a corrupted tree
      let exportErr = null;
      try { await exporter.exportV2Task(jobId); } catch (e) { exportErr = e; }
      check("H3.4 export fails closed on manifest/disk mismatch", !!exportErr && /integrity/i.test(String(exportErr?.message)),
        exportErr ? String(exportErr.message).slice(0, 160) : "export SUCCEEDED on corrupted tree");

      // missing file on disk
      fs.writeFileSync(path.join(v2Dir, "pages", "page-1.html"), "<html><body>hunt page</body></html>");
      fs.rmSync(path.join(v2Dir, "assets", "logo.png"));
      v = LC.verifyArtifactIntegrity(v2Dir);
      check("H3.5 missing file detected", v.ok === false && v.missing?.some((m) => m.includes("logo.png")),
        `missing=${JSON.stringify(v.missing)}`);
      exportErr = null;
      try { await exporter.exportV2Task(jobId); } catch (e) { exportErr = e; }
      check("H3.6 export fails closed on missing file", !!exportErr && /integrity/i.test(String(exportErr?.message)),
        exportErr ? String(exportErr.message).slice(0, 160) : "export SUCCEEDED on incomplete tree");

      // mutable lifecycle header must stay legal (manifest.json may be patched)
      fs.writeFileSync(path.join(v2Dir, "assets", "logo.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4]));
      LC.writeIntegrityManifest(v2Dir);
      fs.appendFileSync(path.join(v2Dir, "manifest.json"), "");
      fs.writeFileSync(path.join(v2Dir, "manifest.json"), JSON.stringify({ schemaVersion: "1.0.0", jobId, status: "completed", lifecycle: { pinned: true } }, null, 2));
      v = LC.verifyArtifactIntegrity(v2Dir);
      check("H3.7 lifecycle header patch does not trip the integrity check", v.ok === true, JSON.stringify(v));

      // healthy tree exports + zip is real
      const out = await exporter.exportV2Task(jobId);
      const zipOk = fs.existsSync(out.zipPath) && out.size > 0;
      check("H3.8 healthy tree exports (zip present, non-empty)", zipOk, `size=${out.size}`);
    }
  } finally {
    fs.rmSync(v2Dir, { recursive: true, force: true });
    fs.rmSync(projectDir, { recursive: true, force: true });
    fs.rmSync(v2Dir + ".zip", { force: true });
  }
}

// ============================================================================
// H4 — backup/restore byte-exactness
// ============================================================================
function runNode(script, args, opts = {}) {
  return spawnSync(process.execPath, [script, ...args], { encoding: "utf8", cwd: PROJECT, timeout: 180_000, ...opts });
}

async function huntBackupArtifacts(tmp) {
  section("H4a  artifact backup/restore byte-exactness");
  const src = path.join(tmp, "art-src");
  const dest = path.join(tmp, "art-restore");
  const archive = path.join(tmp, "hunt-artifacts.tar.gz");
  fs.mkdirSync(path.join(src, "dir b"), { recursive: true });
  fs.mkdirSync(path.join(src, "private"), { recursive: true });
  fs.writeFileSync(path.join(src, "a.txt"), "plain\n");
  fs.writeFileSync(path.join(src, "dir b", "file with space.txt"), "spaces are legal\n");
  fs.writeFileSync(path.join(src, "résumé—文件.txt"), "unicode names survive\n");
  // Win32 forbids control chars (incl. \n) in filenames, so the newline-list
  // corruption case cannot exist on this OS; a LEADING-DASH name is the
  // equivalent nasty case here (option injection into tar when a file list is
  // mishandled) and the NUL-delimited list fix keeps Linux prod safe too.
  fs.writeFileSync(path.join(src, "-weird-flag.txt"), "dash-leading name — option-injection class\n");
  fs.writeFileSync(path.join(src, "private", "cookies.json"), '{"session":"SECRET-NEVER-BACKED-UP"}');

  let r = runNode(BACKUP_ART, ["--src", src, "--out", archive]);
  check("H4a.1 backup succeeds (spaces + unicode + NEWLINE-named files)", r.status === 0, (r.stderr || r.stdout || "").slice(-200));

  const manifestPath = path.join(tmp, "hunt-artifacts.manifest.json");
  let manifestOf = null;
  try { manifestOf = JSON.parse(fs.readFileSync(manifestPath, "utf8")); } catch {}
  check("H4a.1b sidecar manifest exists next to the archive", !!manifestOf, manifestPath);
  check("H4a.2 private/ (credentials) excluded from the backup manifest",
    manifestOf && !Object.keys(manifestOf.files).some((f) => f.startsWith("private")), `${manifestOf?.file_count} files`);

  // restore into a fresh dir and byte-compare
  fs.rmSync(dest, { recursive: true, force: true });
  r = runNode(BACKUP_ART, ["--restore", archive, dest]);
  check("H4a.3 restore succeeds", r.status === 0, (r.stderr || r.stdout || "").slice(-200));

  const walkFiles = (dir, base = dir, acc = []) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walkFiles(p, base, acc); else acc.push(path.relative(base, p));
    }
    return acc;
  };
  const srcFiles = walkFiles(src).filter((f) => !f.split(path.sep).includes("private"));
  const mismatches = [];
  for (const rel of srcFiles) {
    const a = path.join(src, rel), b = path.join(dest, rel);
    if (!fs.existsSync(b)) { mismatches.push(`MISSING ${rel}`); continue; }
    if (sha256File(a) !== sha256File(b)) mismatches.push(`DIFF ${rel}`);
  }
  const restoredFiles = walkFiles(dest);
  const extraFiles = restoredFiles.filter((f) => !srcFiles.includes(f));
  const dashSurvived = fs.existsSync(path.join(dest, "-weird-flag.txt"));
  check("H4a.4 restore is byte-exact for every source file (spaces/unicode/dash-leading)",
    mismatches.length === 0 && dashSurvived,
    `${mismatches.slice(0, 3).join("; ") || "all byte-identical"} dashFile=${dashSurvived}`);
  check("H4a.5 no extra files materialize in the restored tree", extraFiles.length === 0, extraFiles.join(","));
  check("H4a.6 private/ never restored", !fs.existsSync(path.join(dest, "private", "cookies.json")));

  // hostile: corrupted archive must fail closed
  const corrupt = path.join(tmp, "corrupt.tar.gz");
  const buf = fs.readFileSync(archive);
  fs.writeFileSync(corrupt, buf.subarray(0, Math.floor(buf.length / 2)));
  const corruptDest = path.join(tmp, "corrupt-restore");
  r = runNode(BACKUP_ART, ["--restore", corrupt, corruptDest]);
  check("H4a.7 truncated archive refused (fail-closed)", r.status !== 0, `exit=${r.status} ${(r.stderr || "").slice(-120)}`);

  // hostile: attacker adds a file into the archive — restore must detect the extra.
  // The sidecar is copied too, so the archive's manifest-vs-tree verification runs
  // (the missing-sidecar refusal alone proves nothing about extra detection).
  const planted = path.join(tmp, "planted.tar.gz");
  fs.copyFileSync(archive, planted);
  fs.copyFileSync(path.join(tmp, "hunt-artifacts.manifest.json"), path.join(tmp, "planted.manifest.json"));
  const tarProbe = spawnSync("tar", ["--force-local", "--version"], { encoding: "utf8" });
  const tarExtra = !tarProbe.error && tarProbe.status === 0 ? ["--force-local"] : [];
  // build the planted archive by untarring the good one, adding a file, rezipping
  const untarDir = path.join(tmp, "untar-stage");
  fs.rmSync(untarDir, { recursive: true, force: true });
  fs.mkdirSync(untarDir, { recursive: true });
  spawnSync("tar", [...tarExtra, "-xzf", archive], { cwd: untarDir, encoding: "buffer" });
  fs.writeFileSync(path.join(untarDir, "EVIL.md"), "planted");
  const tarRes = spawnSync("tar", [...tarExtra, "-czf", planted, "."], { cwd: untarDir, encoding: "utf8" });
  const plantedDest = path.join(tmp, "planted-restore");
  fs.rmSync(plantedDest, { recursive: true, force: true });
  r = runNode(BACKUP_ART, ["--restore", planted, plantedDest]);
  const plantedDetected = r.status !== 0 || (fs.existsSync(path.join(plantedDest, "EVIL.md")) && /extra|EVIL/i.test(r.stderr + r.stdout));
  check("H4a.8 archive with a PLANTED extra file is detected at restore (no silent extras)", plantedDetected,
    `exit=${r.status} ${(r.stderr || r.stdout || "").slice(-140)}`);
}

async function huntBackupDatabase(tmp) {
  section("H4b  database backup/restore byte-exactness");
  const outDir = path.join(tmp, "db-backups");
  let r = runNode(BACKUP_DB, ["--out-dir", outDir]);
  check("H4b.1 database backup succeeds", r.status === 0, (r.stdout || r.stderr || "").slice(-200));
  const dump = fs.readdirSync(outDir).filter((f) => f.endsWith(".sql")).sort().pop();
  const dumpPath = path.join(outDir, dump);
  const sidecar = `${dumpPath}.sha256`;
  const expected = fs.readFileSync(sidecar, "utf8").split(/\s+/)[0];
  check("H4b.2 sidecar sha256 matches the dump bytes", expected === sha256File(dumpPath), `${expected.slice(0, 16)}…`);

  const SCRATCH = "cloner_hunt_restore";
  const srcDbName = process.env.PGDATABASE || "cloner";
  const dockerPsql = (sql) => spawnSync("docker", ["exec", "cloner-postgres-1", "psql", "-U", "cloner", "-d", "postgres", "-tAc", sql], { encoding: "utf8" });
  dockerPsql(`DROP DATABASE IF EXISTS ${SCRATCH}`);
  const cr = dockerPsql(`CREATE DATABASE ${SCRATCH}`);
  check("H4b.3 scratch database created", cr.status === 0, (cr.stderr || "").slice(-160));

  // refusal contract: non-empty target without --force must be refused
  r = runNode(RESTORE_DB, [dumpPath]);
  check("H4b.4 restore into a non-empty database WITHOUT --force is refused", r.status === 1 && /REFUSED/.test(r.stderr), `exit=${r.status}`);

  r = runNode(RESTORE_DB, [dumpPath], { env: { ...process.env, PGDATABASE: SCRATCH } });
  check("H4b.5 restore into the empty scratch DB succeeds", r.status === 0, (r.stdout || r.stderr || "").slice(-240));

  // per-table content hashes: source vs restored
  const srcTables = (await db.query(`SELECT table_name FROM information_schema.tables WHERE table_schema='public' ORDER BY 1`)).rows.map((x) => x.table_name);
  const q = async (database, sql, params) => {
    const { Client } = await import("pg");
    const c = new Client({ host: process.env.PGHOST || "127.0.0.1", port: Number(process.env.PGPORT || 5433), database, user: process.env.PGUSER || "cloner", password: process.env.PGPASSWORD || "cloner_dev_password" });
    await c.connect();
    try { return await c.query(sql, params); } finally { await c.end(); }
  };
  const hashTable = (database, tbl, where = "TRUE") =>
    q(database, `SELECT md5(coalesce(string_agg(t::text, E'\n' ORDER BY t::text), '')) AS h FROM ${tbl} t WHERE ${where}`);
  const restoredTables = (await q(SCRATCH, `SELECT table_name FROM information_schema.tables WHERE table_schema='public' ORDER BY 1`)).rows.map((x) => x.table_name);

  const missing = srcTables.filter((t) => !restoredTables.includes(t));
  check("H4b.6 every source table exists after restore", missing.length === 0, missing.join(","));

  // reconciliation tolerance: in-flight rows are legitimately flipped by restore
  const IN_FLIGHT = ["queued", "running", "verifying"];
  const inFlight = (await q(srcDbName, `SELECT id FROM tasks WHERE status = ANY($1::text[])`, [IN_FLIGHT])).rows.map((r) => r.id);
  const diffs = [];
  for (const t of srcTables.filter((t) => restoredTables.includes(t))) {
    if (t === "tasks" && inFlight.length) continue;          // reconciled rows compared below
    if (t === "task_events" && inFlight.length) continue;    // reconciled events compared below
    const a = (await hashTable(srcDbName, t)).rows[0].h;
    const b = (await hashTable(SCRATCH, t)).rows[0].h;
    if (a !== b) diffs.push(t);
  }
  if (inFlight.length) {
    const ph = inFlight.map((_, i) => `$${i + 1}`).join(",");
    const a = (await q(srcDbName, `SELECT md5(coalesce(string_agg(t::text, E'\n' ORDER BY t::text), '')) AS h FROM tasks t WHERE id NOT IN (${ph})`, inFlight)).rows[0].h;
    const b = (await q(SCRATCH, `SELECT md5(coalesce(string_agg(t::text, E'\n' ORDER BY t::text), '')) AS h FROM tasks t WHERE id NOT IN (${ph})`, inFlight)).rows[0].h;
    if (a !== b) diffs.push("tasks(non-inflight)");
    const restoredInFlight = (await q(SCRATCH, `SELECT id, status FROM tasks WHERE id = ANY($1::uuid[])`, [inFlight])).rows;
    if (restoredInFlight.some((row) => row.status !== "error")) diffs.push("tasks(inflight-not-reconciled-to-error)");
    const a2 = (await q(srcDbName, `SELECT md5(coalesce(string_agg(t::text, E'\n' ORDER BY t::text), '')) AS h FROM task_events t WHERE event_type <> 'reconciled'`)).rows[0].h;
    const b2 = (await q(SCRATCH, `SELECT md5(coalesce(string_agg(t::text, E'\n' ORDER BY t::text), '')) AS h FROM task_events t WHERE event_type <> 'reconciled'`)).rows[0].h;
    if (a2 !== b2) diffs.push("task_events(non-reconciled)");
  }
  check("H4b.7 byte-exact content: every table hash matches the source (in-flight reconciliation excluded)",
    diffs.length === 0, diffs.length ? `DIFFERING: ${diffs.join(", ")}` : `all ${srcTables.length} tables identical; inFlight=${inFlight.length}`);

  dockerPsql(`DROP DATABASE IF EXISTS ${SCRATCH}`);
  check("H4b.8 scratch database dropped (no residue)", true);
}

// ============================================================================
// H5 — retention sweep over-reach
// ============================================================================
async function huntArtifactSweep(tmp) {
  section("H5a  artifact lifecycle sweep over-reach");
  const base = path.join(tmp, "lc-base");
  const artifacts = path.join(base, "artifacts");
  const ORG1 = uuid(), ORG2 = uuid();
  const DAY = 86_400_000;
  const now = Date.now();

  fs.mkdirSync(path.join(artifacts, ".lifecycle-staging", "leftover.1.2"), { recursive: true });
  fs.writeFileSync(path.join(artifacts, ".lifecycle-staging", "leftover.1.2", "f.txt"), "staged by a crashed sweep");
  fs.writeFileSync(path.join(base, "outside-canary.txt"), "must never be touched");
  fs.mkdirSync(path.join(artifacts, String(ORG2), "orphan-no-manifest"), { recursive: true });
  fs.writeFileSync(path.join(artifacts, String(ORG2), "orphan-no-manifest", "x.txt"), "orphan");

  const expiredStore = LC.createOrgArtifactStore({ base, orgId: ORG1, jobId: "expired-1", retentionClass: "temp", clock: () => now - 10 * DAY });
  fs.writeFileSync(path.join(expiredStore.dir, "pages", "p.html"), "x");
  const futureStore = LC.createOrgArtifactStore({ base, orgId: ORG1, jobId: "future-1", retentionClass: "completed", clock: () => now });
  const pinnedStore = LC.createOrgArtifactStore({ base, orgId: ORG1, jobId: "pinned-1", retentionClass: "temp", clock: () => now - 10 * DAY });
  pinnedStore.pin("hunt-canary");
  // legacy top-level manifest dir, expired
  const legacyDir = path.join(artifacts, "legacy-job-1");
  fs.mkdirSync(legacyDir, { recursive: true });
  fs.writeFileSync(path.join(legacyDir, "manifest.json"), JSON.stringify({ lifecycle: { jobId: "legacy-job-1", lifecycleState: "active", expiresAt: new Date(now - DAY).toISOString() } }, null, 2));
  fs.writeFileSync(path.join(legacyDir, "old.html"), "legacy data");

  const plan = LC.planSweep({ base, clock: () => now });
  const has = (arr, id) => arr.some((j) => String(j.jobId || j.dir || "").includes(id));
  check("H5a.1 plan: expired+pinned+future+orphan+legacy classified, staging leftover detected",
    has(plan.expired, "expired-1") && has(plan.kept, "future-1") && has(plan.kept, "pinned-1") &&
    plan.stagingLeftovers.length === 1 && plan.orphans.some((o) => o.scope === "org") &&
    plan.expired.some((j) => j.scope === "legacy-manifest"),
    `expired=${plan.expired.length} kept=${plan.kept.length} orphans=${plan.orphans.length}`);

  let sw = LC.sweep({ base, clock: () => now, execute: true });
  check("H5a.2 sweep: expired org job removed (staged+deleted)",
    sw.executed.some((e) => e.jobId === "expired-1" || String(e.dir).includes("expired-1")) &&
      !fs.existsSync(expiredStore.dir),
    JSON.stringify(sw.executed.map((e) => e.stage)));
  check("H5a.3 sweep: pinned job SURVIVES (never deleted on age alone)",
    fs.existsSync(pinnedStore.dir), `executed=${sw.executed.length}`);
  check("H5a.4 sweep: future-expiry job survives",
    fs.existsSync(futureStore.dir));
  check("H5a.5 sweep: legacy manifest dir NOT swept by default",
    fs.existsSync(path.join(legacyDir, "old.html")), `legacyUntouched=${sw.legacyUntouched.length}`);
  check("H5a.6 sweep: org orphan NOT removed under default policy",
    fs.existsSync(path.join(artifacts, String(ORG2), "orphan-no-manifest")));
  check("H5a.7 sweep: staging leftover from a crashed sweep finalized",
    !fs.existsSync(path.join(artifacts, ".lifecycle-staging", "leftover.1.2")) && sw.executed.some((e) => e.stage === "staged-finalized"));
  check("H5a.8 sweep: nothing outside the artifacts root touched",
    fs.existsSync(path.join(base, "outside-canary.txt")));

  sw = LC.sweep({ base, clock: () => now + 100 * DAY, execute: true, allowLegacy: true });
  check("H5a.9 100-day sweep: pinned job STILL survives, future job gone, legacy swept only when allowed",
    fs.existsSync(pinnedStore.dir) && !fs.existsSync(futureStore.dir) && !fs.existsSync(legacyDir),
    `pinned=${fs.existsSync(pinnedStore.dir)}`);
  sw = LC.sweep({ base, clock: () => now + 100 * DAY, execute: true, orphanPolicy: "remove" });
  check("H5a.10 orphan removal policy touches ORG orphans only (legacy orphans never)",
    !fs.existsSync(path.join(artifacts, String(ORG2), "orphan-no-manifest")) ||
      sw.orphans.length === 0,
    `remainingOrphans=${sw.orphans.length}`);
}

// H5b runs in an ISOLATED CHILD PROCESS: tasks.js captures its platform-data
// ROOT from cwd at import time, and this hunt already loaded it transitively
// (via exporter.js) with the real project root — the only way to test the
// sweep against a disposable store without touching real task data is a child
// whose FIRST import happens after chdir into the sandbox.
const H5B_RUNNER = `#!/usr/bin/env node
// generated by test-data-integrity-hunt.mjs — hostile H5b runner (sandboxed cwd)
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const SANDBOX = process.argv[2];
const OUT = process.argv[3];
const results = [];
const check = (name, ok, detail = "") => {
  results.push(ok);
  console.log(\`\${ok ? "PASS" : "FAIL"}  \${name}\${detail ? \` — \${detail}\` : ""}\`);
};
process.chdir(SANDBOX);
const tasks = await import(${JSON.stringify(pathToFileURL(path.join(PROJECT, "src", "platform", "tasks.js")).href)});

const old = new Date(Date.now() - 20 * 86_400_000).toISOString();
const mk = (status, { createdAt = old, pinned = false } = {}) => {
  const t = tasks.createTask({ url: "https://hunt.example/", mode: "url" });
  const meta = JSON.parse(fs.readFileSync(path.join(tasks.taskDir(t.id), "task.json"), "utf8"));
  meta.status = status;
  meta.createdAt = createdAt;
  if (pinned) meta.pinned = true;
  fs.writeFileSync(path.join(tasks.taskDir(t.id), "task.json"), JSON.stringify(meta, null, 2));
  return t.id;
};
const doneOld = mk("done");
const runningOld = mk("running");
const queuedOld = mk("queued");
const verifyingOld = mk("verifying");
const pinnedOld = mk("done", { pinned: true });
const errorOld = mk("error");
const exportedOld = mk("exported");
const doneNew = mk("done", { createdAt: new Date().toISOString() });
fs.mkdirSync(path.join(SANDBOX, "platform-data", "stray-dir"), { recursive: true }); // no task.json
delete process.env.RETENTION_DAYS;

let removed = tasks.sweepExpired();
const exists = (id) => fs.existsSync(tasks.taskDir(id));
check("H5b.1 old terminal tasks (done/error/exported) are swept",
  removed.includes(doneOld) && removed.includes(errorOld) && removed.includes(exportedOld),
  \`removed=\${removed.length}\`);
check("H5b.2 OVER-REACH GUARD: old RUNNING task survives the sweep", exists(runningOld), \`removed=\${removed.join(",")}\`);
check("H5b.3 OVER-REACH GUARD: old QUEUED task survives the sweep", exists(queuedOld));
check("H5b.4 OVER-REACH GUARD: old VERIFYING task survives the sweep", exists(verifyingOld));
check("H5b.5 OVER-REACH GUARD: old PINNED task survives the sweep", exists(pinnedOld));
check("H5b.6 new task survives; non-task dir untouched", exists(doneNew) && fs.existsSync(path.join(SANDBOX, "platform-data", "stray-dir")));

// RETENTION_DAYS guard: garbage/zero must fall back to 15 (never purge everything)
const g1 = mk("done");
process.env.RETENTION_DAYS = "abc";
removed = tasks.sweepExpired();
const abcSwept = exists(g1) === false; // 20 days old > 15 fallback → swept
process.env.RETENTION_DAYS = "0";
const g2 = mk("done");
removed = tasks.sweepExpired();
check("H5b.7 RETENTION_DAYS garbage/zero falls back to 15 days (20-day terminal task swept, not everything)",
  abcSwept && exists(g2) === false && exists(doneNew), \`abc swept=\${abcSwept} zero swept=\${!exists(g2)}\`);

fs.writeFileSync(OUT, JSON.stringify({ results, sandbox: SANDBOX }));
process.exit(results.every(Boolean) ? 0 : 1);
`;

async function huntTasksSweep(tmp) {
  section("H5b  platform-data retention sweep over-reach (isolated child process)");
  const sandbox = path.join(tmp, "tasks-sandbox");
  fs.mkdirSync(sandbox, { recursive: true });
  const runner = path.join(tmp, "h5b-runner.mjs");
  const outFile = path.join(tmp, "h5b-results.json");
  fs.writeFileSync(runner, H5B_RUNNER, "utf8");
  const r = spawnSync(process.execPath, [runner, sandbox, outFile], {
    encoding: "utf8", timeout: 60_000,
    env: { ...process.env, RETENTION_DAYS: "" },
  });
  let child = null;
  try { child = JSON.parse(fs.readFileSync(outFile, "utf8")); } catch {}
  const lines = (r.stdout || "").split("\n").filter((l) => /^(PASS|FAIL)/.test(l));
  for (const l of lines) console.log(l);
  // register the child's checks into the parent tally
  for (const l of lines) results.push(l.startsWith("PASS"));
  check("H5b.0 isolated sweep child ran cleanly", r.status === 0 && (child?.results?.length ?? 0) === 7,
    r.status === 0 ? "7 checks" : `exit=${r.status} ${(r.stderr || "").slice(-200)}`);
  fs.rmSync(sandbox, { recursive: true, force: true });
}

async function huntDbRetention(tmp) {
  section("H5c  DB retention bookkeeping (artifacts rows)");
  const user = (await query("INSERT INTO users (email, password_hash) VALUES ($1, 'hunt-not-a-hash') RETURNING id", [`${MARK}@db.test`])).rows[0].id;
  const task = (await query("INSERT INTO tasks (user_id, source_url, status) VALUES ($1, 'https://hunt.example/', 'done') RETURNING id", [user])).rows[0].id;
  try {
    const past = new Date(Date.now() - 86_400_000).toISOString();
    const future = new Date(Date.now() + 7 * 86_400_000).toISOString();
    const ins = async (extra) => (await query(
      `INSERT INTO artifacts (task_id, stage, artifact_type, storage_key, size_bytes, expires_at, pinned, lifecycle_state)
       VALUES ($1, 'clone', 'page', $2, 10, $3, $4, 'active') RETURNING id, lifecycle_state`,
      [task, `${MARK}/${extra.k}`, extra.expiresAt, extra.pinned])).rows[0];
    const pinnedExpired = await ins({ k: "pinned-expired", expiresAt: past, pinned: true });
    const expiredRow = await ins({ k: "expired", expiresAt: past, pinned: false });
    const futureRow = await ins({ k: "future", expiresAt: future, pinned: false });
    const activeNoExpiry = await ins({ k: "noexpiry", expiresAt: null, pinned: false });

    let marked = await LC.dbMarkExpired({ clock: () => Date.now(), taskId: task });
    if (!marked.length) {
      const dbg = await query(
        "SELECT id, storage_key, expires_at, pinned, lifecycle_state, deleted_at, (expires_at <= now()) AS past_due FROM artifacts WHERE task_id=$1", [task]);
      console.log("H5c DIAG:", JSON.stringify(dbg.rows));
    }
    const byId = (id) => (async () => (await query("SELECT lifecycle_state, deleted_at FROM artifacts WHERE id=$1", [id])).rows[0])();
    const markedIds = new Set(marked.map((r) => r.id));
    check("H5c.1 markExpired: unpinned expired → expired; pinned/future/no-expiry untouched",
      markedIds.has(expiredRow.id) && markedIds.size === 1 &&
        (await byId(pinnedExpired.id)).lifecycle_state === "active" &&
        (await byId(futureRow.id)).lifecycle_state === "active" &&
        (await byId(activeNoExpiry.id)).lifecycle_state === "active",
      `marked=${marked.length}`);

    // purge must NEVER jump active rows (pinned expired is still active → untouchable)
    let purged = await LC.dbPurgeExpired({ clock: () => Date.now(), taskId: task });
    const pIds = new Set(purged.map((r) => r.id));
    check("H5c.2 purge: only 'expired' rows purged (pinned row stays active even though its date passed)",
      pIds.has(expiredRow.id) && !pIds.has(pinnedExpired.id) &&
        (await byId(pinnedExpired.id)).lifecycle_state === "active" &&
        (await byId(expiredRow.id)).lifecycle_state === "purged" &&
        (await byId(expiredRow.id)).deleted_at !== null,
      `purged=${purged.length}`);
  } finally {
    await query("DELETE FROM artifacts WHERE task_id=$1", [task]);
    await query("DELETE FROM tasks WHERE id=$1", [task]);
    await query("DELETE FROM users WHERE id=$1", [user]);
  }
}

// ============================================================================
// H2c — REAL credit ledger double-grant under concurrency (credit-ledger.js)
// ============================================================================
async function huntCreditLedger() {
  section("H2c  real credit ledger (grant-only) double-grant under 10-parallel");
  const CL = await import("../src/platform/credit-ledger.js");
  const userId = uuid();
  const eventId = `${MARK}-evt`;
  try {
    await CL.ensureLedgerSchema();
    // 10 parallel grants of the SAME eventId → exactly ONE entry (idempotency key holds)
    const same = await Promise.all(Array.from({ length: 10 }, () =>
      CL.grantFreeCredits({ userId, amount: 100, source: "free", reason: "hunt", eventId })));
    const granted = same.filter((r) => r.duplicate === false).length;
    const dupes = same.filter((r) => r.duplicate === true).length;
    const rows = (await query("SELECT count(*)::int AS n, COALESCE(sum(credits),0)::int AS c FROM credit_ledger_entries WHERE event_id = $1", [eventId])).rows[0];
    check("H2c.1 10 parallel same-eventId grants → exactly 1 entry, balance 100 (no double-grant)",
      Number(rows.n) === 1 && Number(rows.c) === 100 && granted === 1 && dupes === 9,
      `rows=${rows.n} credits=${rows.c} granted=${granted} dupes=${dupes}`);

    // 10 parallel grants of DISTINCT eventIds → 10 entries, balance 100+10*7
    const res = await Promise.all(Array.from({ length: 10 }, (_, i) =>
      CL.grantFreeCredits({ userId, amount: 7, source: "free", reason: "hunt", eventId: `${eventId}-d${i}` })));
    const bal = (await query("SELECT COALESCE(sum(credits),0)::int AS b FROM credit_ledger_entries WHERE user_id = $1", [userId])).rows[0].b;
    check("H2c.2 10 parallel distinct-eventId grants land independently (balance 170)",
      res.every((r) => r.duplicate === false) && Number(bal) === 170, `balance=${bal}`);
  } finally {
    await query("DELETE FROM credit_ledger_entries WHERE user_id = $1 AND reason = 'hunt'", [userId]);
  }
}

// ============================================================================
// main
// ============================================================================
async function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "hunt-g54-"));
  try {
    await huntAuditChain();
    await huntQuotaLedger();
    await huntCostLedger();
    await huntCreditLedger();
    await huntManifestVsDisk();
    await huntBackupArtifacts(tmp);
    await huntBackupDatabase(tmp);
    await huntArtifactSweep(tmp);
    await huntTasksSweep(tmp);
    await huntDbRetention(tmp);
  } finally {
    await closePool().catch(() => {});
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  const pass = results.filter(Boolean).length;
  const fail = results.length - pass;
  console.log(`\nRESULT: ${fail === 0 ? "PASS" : "FAIL"}  (${pass}/${results.length} checks)`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("HUNT CRASHED:", e);
  process.exit(2);
});
