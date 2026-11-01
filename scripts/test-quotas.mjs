#!/usr/bin/env node
// Resource quotas + usage accounting tests (task 4.0.4) — REAL PostgreSQL
// (docker compose instance, PG 5433) via src/database/client.js.
//
//   SKIP contract: if the compose Postgres is unreachable, every check prints a
//   SKIP line and the script exits 0 (per the phase rule "tests pass WITHOUT
//   live external services; PostgreSQL tests use the compose instance and print
//   a SKIP line if docker is unreachable").
//
// Coverage:
//   A. limits engage — concurrent, queued, jobs/day, storage bytes,
//      exploration minutes (env defaults + per-scope overrides + unlimited)
//   B. accounting accuracy after N stub jobs — started/completed/failed/
//      cancelled/retries/exploration_ms exactly as executed, not as submitted
//   C. org pool shared across members — two members draw from ONE org pool;
//      member A's usage blocks member B; personal scopes stay isolated
//   D. race safety — 24 simultaneous reservations against a limit of 4:
//      exactly 4 win, 20 rejected (advisory-lock + atomic capacity check)
//   E. retries/cancellations/worker crashes — retry accounting, cancel
//      accounting, stale-reservation reclaim + ledger reconciliation
//   F. middleware — typed 402/429 mapping, guard ordering (rejects BEFORE the
//      handler would queue), usage route shape, release idempotency
//   G. storage meter injection — mock meter drives the storage limit; the real
//      computeUsage from 4.0.5 is exercised directly on a temp tree
import { setTimeout as sleep } from "node:timers/promises";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";

const results = [];
const check = (name, ok, detail = "") => {
  results.push(ok);
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
};
const section = (t) => console.log(`\n-- ${t} --`);

const watchdog = setTimeout(() => { console.log("FAIL  global timeout (120s)"); process.exit(1); }, 120_000);
watchdog.unref();

// ---------- connectivity probe (SKIP contract) ----------
let db;
try {
  db = await import("../src/database/client.js");
  await db.query("SELECT 1");
} catch (e) {
  const msg = `docker compose Postgres unreachable (${String(e?.message || e).slice(0, 120)}) — start it with: docker compose up -d postgres`;
  const n = 40;
  for (let i = 0; i < n; i++) console.log(`SKIP  quota check ${i + 1}/${n} — ${msg}`);
  console.log(`\nRESULT: SKIP  (0/${n} checks run — database unavailable)`);
  process.exit(0);
}

// ---------- apply ONLY my migration (012) — full ordered run is the integrator's job ----------
try {
  const fsmod = await import("node:fs");
  const sql = fsmod.readFileSync(new URL("../src/database/migrations/012-quotas.sql", import.meta.url), "utf8");
  await db.query(sql);
} catch (e) {
  // idempotent re-run is fine; anything else is fatal
  console.log("FAIL  migration 012 failed to apply — " + String(e?.message || e).slice(0, 300));
  process.exit(1);
}

const Q = await import("../src/platform/quota-service.js");
const { query, closePool } = db;

// ---------- test scaffolding ----------
const TAG = "q404" + crypto.randomBytes(3).toString("hex");
async function mkUser(label) {
  const email = `${TAG}-${label}-${crypto.randomBytes(4).toString("hex")}@quota.test`;
  const r = await query("INSERT INTO users (email, password_hash) VALUES ($1, 'x') RETURNING id", [email]);
  return r.rows[0].id;
}
async function mkOrg(label, ownerId) {
  const slug = `${TAG}-${label}-${crypto.randomBytes(3).toString("hex")}`;
  const r = await query(
    "INSERT INTO organizations (name, slug, owner_user_id, created_by) VALUES ($1, $2, $3, $3) RETURNING id",
    [`Quota org ${label}`, slug, ownerId]
  );
  return r.rows[0].id;
}
async function mkMembership(orgId, userId, role = "member") {
  await query("INSERT INTO org_members (org_id, user_id, role) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING", [orgId, userId, role]);
}
async function cleanup() {
  // delete everything this run created (FK cascade handles children)
  await query(`DELETE FROM quota_usage_events WHERE scope_id IN (SELECT id FROM users WHERE email LIKE '${TAG}-%') OR scope_id IN (SELECT id FROM organizations WHERE slug LIKE '${TAG}-%')`);
  await query(`DELETE FROM quota_usage_daily  WHERE scope_id IN (SELECT id FROM users WHERE email LIKE '${TAG}-%') OR scope_id IN (SELECT id FROM organizations WHERE slug LIKE '${TAG}-%')`);
  await query(`DELETE FROM quota_reservations WHERE scope_id IN (SELECT id FROM users WHERE email LIKE '${TAG}-%') OR scope_id IN (SELECT id FROM organizations WHERE slug LIKE '${TAG}-%')`);
  await query(`DELETE FROM quota_limits      WHERE scope_id IN (SELECT id FROM users WHERE email LIKE '${TAG}-%') OR scope_id IN (SELECT id FROM organizations WHERE slug LIKE '${TAG}-%')`);
  await query(`DELETE FROM org_members WHERE user_id IN (SELECT id FROM users WHERE email LIKE '${TAG}-%')`);
  await query(`DELETE FROM organizations WHERE slug LIKE '${TAG}-%'`);
  await query(`DELETE FROM users WHERE email LIKE '${TAG}-%'`);
}
await cleanup();

const userScope = (userId) => ({ scope_type: "user", scope_id: userId });
const orgScope = (orgId) => ({ scope_type: "org", scope_id: orgId });

// pin limits for every scope this run touches: per-scope overrides make tests
// independent of env defaults and of other concurrent tasks' reservations.
async function pinLimits(scope, { concurrent = null, queued = null, perDay = null, bytes = null, minutes = null } = {}) {
  await Q.setQuotaLimit(scope, "max_concurrent_jobs", concurrent);
  await Q.setQuotaLimit(scope, "max_queued_jobs", queued);
  await Q.setQuotaLimit(scope, "max_jobs_per_day", perDay);
  await Q.setQuotaLimit(scope, "max_artifact_bytes", bytes);
  await Q.setQuotaLimit(scope, "max_exploration_minutes_per_day", minutes);
}

// ============================================================
section("A. limits engage (defaults, overrides, unlimited)");
{
  const u = await mkUser("limits");
  const s = userScope(u);

  // env defaults apply with NO override rows
  const d = await Q.resolveLimits(s);
  check("A1: env defaults when no overrides exist",
    d.max_concurrent_jobs === 2 && d.max_jobs_per_day === 50 && d.max_artifact_bytes === 5 * 1024 ** 3,
    JSON.stringify(d));

  // override: concurrent = 2 → third concurrent job rejected
  await pinLimits(s, { concurrent: 2, queued: null, perDay: null, bytes: null, minutes: null });
  await Q.reserveJobSlot(s, `${TAG}-a1-1`);
  await Q.reserveJobSlot(s, `${TAG}-a1-2`);
  let err = null;
  try { await Q.reserveJobSlot(s, `${TAG}-a1-3`); } catch (e) { err = e; }
  check("A2: concurrent limit engages at the boundary", err instanceof Q.QuotaExceededError && err.reason === "concurrent_job_limit",
    err?.reason || "no rejection");
  check("A2: rejection carries typed detail (limit/used/requested)",
    err?.limit === 2 && err?.used === 2 && err?.requested === 1,
    `limit=${err?.limit} used=${err?.used} requested=${err?.requested}`);

  // release one → next reservation succeeds
  await Q.releaseReservation(s, `${TAG}-a1-1`, { outcome: "completed" });
  const ok3 = await Q.reserveJobSlot(s, `${TAG}-a1-3`);
  check("A3: release frees the slot (reservation is atomic, not leaked)", !!ok3.reservationId);

  // NULL override = unlimited
  await Q.setQuotaLimit(s, "max_concurrent_jobs", null);
  const ok4 = await Q.reserveJobSlot(s, `${TAG}-a1-4`);
  check("A4: NULL override = unlimited (concurrent cap disabled)", !!ok4.reservationId);

  // queued limit
  const u2 = await mkUser("queued");
  const s2 = userScope(u2);
  await pinLimits(s2, { queued: 2 });
  await Q.queueReservation(s2, `${TAG}-q1`);
  await Q.queueReservation(s2, `${TAG}-q2`);
  let qerr = null;
  try { await Q.queueReservation(s2, `${TAG}-q3`); } catch (e) { qerr = e; }
  check("A5: queued limit engages (queued ≠ concurrent pool)", qerr instanceof Q.QuotaExceededError && qerr.reason === "queued_job_limit",
    qerr?.reason || "no rejection");
  // promotion of a queued slot still respects the concurrent cap
  await pinLimits(s2, { concurrent: 1, queued: 5 });
  await Q.reserveJobSlot(s2, `${TAG}-run1`);
  await Q.queueReservation(s2, `${TAG}-q4`);
  let perr = null;
  try { await Q.promoteReservation(s2, `${TAG}-q4`); } catch (e) { perr = e; }
  check("A6: queued→running promotion re-checks the concurrent cap",
    perr instanceof Q.QuotaExceededError && perr.reason === "concurrent_job_limit", perr?.reason || "no rejection");

  // storage + exploration-minute limits (mocked meter)
  Q.setStorageMeter(() => 900);
  const u3 = await mkUser("storage");
  const s3 = userScope(u3);
  await pinLimits(s3, { bytes: 1000 });
  let serr = null;
  try { await Q.reserveJobSlot(s3, `${TAG}-s1`, { estimatedBytes: 200 }); } catch (e) { serr = e; }
  check("A7: storage limit engages (900 used + 200 requested > 1000)", serr instanceof Q.QuotaExceededError && serr.reason === "storage_limit",
    serr?.reason || "no rejection");
  let serr2 = null;
  try { await Q.reserveJobSlot(s3, `${TAG}-s2`, { estimatedBytes: 100 }); } catch (e) { serr2 = e; }
  check("A8: storage under the limit passes (900 + 100 = 1000)", serr2 === null, serr2?.reason || "reserved");

  const u4 = await mkUser("minutes");
  const s4 = userScope(u4);
  await pinLimits(s4, { minutes: 60 });
  await Q.reserveJobSlot(s4, `${TAG}-m0`);
  await Q.releaseReservation(s4, `${TAG}-m0`, { outcome: "completed", explorationMs: 30 * 60_000 });
  let merr = null;
  try { await Q.reserveJobSlot(s4, `${TAG}-m1`, { explorationMinutes: 31 }); } catch (e) { merr = e; }
  check("A9: exploration-minutes limit engages (30 used + 31 > 60)", merr instanceof Q.QuotaExceededError && merr.reason === "exploration_time_limit",
    merr?.reason || "no rejection");
  let merr2 = null;
  try { await Q.reserveJobSlot(s4, `${TAG}-m2`, { explorationMinutes: 30 }); } catch (e) { merr2 = e; }
  check("A10: exploration minutes at the boundary pass (30 + 30 = 60)", merr2 === null, merr2?.reason || "reserved");
  Q.setStorageMeter(null); // restore the real 4.0.5 meter
}

// ============================================================
section("B. accounting accuracy after N stub jobs");
{
  const u = await mkUser("acct");
  const s = userScope(u);
  await pinLimits(s, { concurrent: null, perDay: null }); // unlimited for the accounting run

  const N = 12;
  const jobs = [];
  for (let i = 0; i < N; i++) jobs.push(await Q.reserveJobSlot(s, `${TAG}-b-${i}`));
  check("B1: all N stub jobs reserved", jobs.length === N && jobs.every((j) => j.reservationId));

  // outcomes: 6 completed (with retries), 3 failed, 2 cancelled, 1 left running (released later)
  for (let i = 0; i < 6; i++) await Q.releaseReservation(s, `${TAG}-b-${i}`, { outcome: "completed", explorationMs: 10 * 60_000, retries: i % 2 });
  for (let i = 6; i < 9; i++) await Q.releaseReservation(s, `${TAG}-b-${i}`, { outcome: "failed", explorationMs: 5 * 60_000 });
  for (let i = 9; i < 11; i++) await Q.releaseReservation(s, `${TAG}-b-${i}`, { outcome: "cancelled" });
  // job 11 stays live until after the usage read below

  const usage = await Q.getUsage(s);
  check("B2: jobsStartedToday counts actual reservations (12, not submissions)", usage.jobsStartedToday === N, `got ${usage.jobsStartedToday}`);
  check("B3: completed/failed/cancelled counted per outcome",
    usage.jobsCompletedToday === 6 && usage.jobsFailedToday === 3 && usage.jobsCancelledToday === 2,
    `c=${usage.jobsCompletedToday} f=${usage.jobsFailedToday} x=${usage.jobsCancelledToday}`);
  check("B4: retries accounted (3 of the completed jobs retried once)", usage.retriesToday === 3, `got ${usage.retriesToday}`);
  check("B5: exploration minutes = executed ms only (6×10s + 3×5s = 75 min)",
    usage.explorationMinutesToday === 75, `got ${usage.explorationMinutesToday}`);
  check("B6: one job still live → running = 1", usage.running === 1, `got ${usage.running}`);
  check("B7: wouldReject empty while nothing is at a limit", Array.isArray(usage.wouldReject) && usage.wouldReject.length === 0,
    JSON.stringify(usage.wouldReject));

  await Q.releaseReservation(s, `${TAG}-b-11`, { outcome: "completed", explorationMs: 2 * 60_000 });

  // ledger is the source of truth — reconcile and get the same numbers
  const rec = await Q.reconcileDailyFromLedger(s);
  check("B8: ledger reconciliation reproduces the materialized counters",
    rec.jobs_started === N && rec.jobs_completed === 7 && rec.jobs_failed === 3 && rec.jobs_cancelled === 2 && rec.retries === 3 && rec.exploration_ms === (75 + 2) * 60_000,
    JSON.stringify(rec));
  // B8b: raw ledger event rows match the accounting (retries: 3 releases × 1
  // event with amount 1 each; exploration_ms: 9 releases carrying ms)
  const events = await query(
    `SELECT event_type, count(*)::int AS n, coalesce(sum(amount),0)::bigint AS amt FROM quota_usage_events WHERE scope_type='user' AND scope_id=$1 GROUP BY event_type`,
    [u]
  );
  const byType = Object.fromEntries(events.rows.map((r) => [r.event_type, { n: Number(r.n), amt: Number(r.amt) }]));
  // exploration_ms: 9 releases → 9 events (job 11's release included = 10),
  // totaling 75 + 2 = 77 minutes
  check("B8b: ledger event counts match the accounting row-for-row",
    byType.started?.n === 12 && byType.completed?.n === 7 && byType.failed?.n === 3 && byType.cancelled?.n === 2
      && byType.retry?.n === 3 && byType.retry?.amt === 3
      && byType.exploration_ms?.n === 10 && byType.exploration_ms?.amt === 77 * 60_000,
    JSON.stringify(byType));
}

// ============================================================
section("C. org pool shared across members");
{
  const owner = await mkUser("org-owner");
  const mA = await mkUser("org-ma");
  const mB = await mkUser("org-mb");
  const org = await mkOrg("pool", owner);
  await mkMembership(org, mA);
  await mkMembership(org, mB);
  const pool = orgScope(org);

  // org pool limit: 2 concurrent — set on the ORG scope
  await pinLimits(pool, { concurrent: 2 });
  const scopeA = { scope_type: "org", scope_id: org, userId: mA };
  const scopeB = { scope_type: "org", scope_id: org, userId: mB };

  await Q.reserveJobSlot(scopeA, `${TAG}-c-a1`);
  await Q.reserveJobSlot(scopeB, `${TAG}-c-b1`);   // DIFFERENT member, SAME pool
  let err = null;
  try { await Q.reserveJobSlot(scopeA, `${TAG}-c-a2`); } catch (e) { err = e; }
  check("C1: member B's job consumes the shared org pool (A blocked at cap)",
    err instanceof Q.QuotaExceededError && err.reason === "concurrent_job_limit", err?.reason || "no rejection");

  // members' PERSONAL scopes are untouched by org usage
  await pinLimits(userScope(mA), { concurrent: 2 });
  const personal = await Q.reserveJobSlot(userScope(mA), `${TAG}-c-personal`);
  check("C2: org usage does not leak into the member's personal scope", !!personal.reservationId);

  // release from member B's handle → member A can proceed (same pool)
  await Q.releaseReservation(scopeB, `${TAG}-c-b1`, { outcome: "completed" });
  const ok = await Q.reserveJobSlot(scopeA, `${TAG}-c-a3`);
  check("C3: pool capacity is shared both ways (B's release frees A's slot)", !!ok.reservationId);

  // org-scoped storage pool via the injected meter
  Q.setStorageMeter((scopeId) => String(scopeId) === String(org) ? 800 : 0);
  await pinLimits(pool, { concurrent: null, bytes: 1000 });
  let berr = null;
  try { await Q.reserveJobSlot(scopeB, `${TAG}-c-b2`, { estimatedBytes: 300 }); } catch (e) { berr = e; }
  check("C4: org storage pool shared — 800 used, 300 requested > 1000",
    berr instanceof Q.QuotaExceededError && berr.reason === "storage_limit", berr?.reason || "no rejection");
  Q.setStorageMeter(null);

  const usage = await Q.getUsage(pool);
  check("C5: org usage surface reports the pooled scope",
    usage.scope.type === "org" && usage.scope.id === String(org), JSON.stringify(usage.scope));
}

// ============================================================
section("D. race safety — simultaneous submissions at the boundary");
{
  const u = await mkUser("race");
  const s = userScope(u);
  await pinLimits(s, { concurrent: 4, perDay: null });

  const LIMIT = 4, TOTAL = 24;
  const attempt = (i) => Q.reserveJobSlot(s, `${TAG}-d-${i}`)
    .then(() => "ok")
    .catch((e) => (e instanceof Q.QuotaExceededError ? `rejected:${e.reason}` : `ERROR:${e.message}`));
  const outcomes = await Promise.all(Array.from({ length: TOTAL }, (_, i) => attempt(i)));
  const won = outcomes.filter((o) => o === "ok").length;
  const rejectedConcurrent = outcomes.filter((o) => o === "rejected:concurrent_job_limit").length;
  const unexpected = outcomes.filter((o) => o.startsWith("ERROR:"));
  check(`D1: exactly ${LIMIT} of ${TOTAL} simultaneous submissions win the race`, won === LIMIT, `won=${won}`);
  check("D2: every loser rejected with the typed concurrent reason", rejectedConcurrent === TOTAL - LIMIT && unexpected.length === 0,
    `rejected=${rejectedConcurrent} unexpected=${JSON.stringify(unexpected)}`);
  const live = await query(
    `SELECT count(*)::int AS n FROM quota_reservations WHERE scope_type='user' AND scope_id=$1 AND released_at IS NULL`,
    [u]
  );
  check("D3: no over-reservation in the database", live.rows[0].n === LIMIT, `live=${live.rows[0].n}`);
  const daily = await query(
    `SELECT jobs_started FROM quota_usage_daily WHERE scope_type='user' AND scope_id=$1 AND day = (now() at time zone 'utc')::date`,
    [u]
  );
  check("D4: daily accounting raced safely too (exactly 4 started)", Number(daily.rows[0]?.jobs_started) === LIMIT,
    `started=${daily.rows[0]?.jobs_started}`);
}

// ============================================================
section("E. retries, cancellations, worker crashes (stale reclaim)");
{
  const u = await mkUser("reclaim");
  const s = userScope(u);
  await pinLimits(s, { concurrent: 1 });

  await Q.reserveJobSlot(s, `${TAG}-e-live`);
  // simulate a crashed worker: backdate the reservation, then reclaim
  await query(`UPDATE quota_reservations SET reserved_at = now() - interval '1 hour' WHERE task_key = $1`, [`${TAG}-e-live`]);
  const reclaimed = await Q.reclaimStaleReservations({ maxAgeMs: 30 * 60_000 });
  check("E1: stale reservation reclaimed after the simulated crash",
    reclaimed.some((r) => r.task_key === `${TAG}-e-live`), `reclaimed=${reclaimed.length}`);
  const after = await Q.reserveJobSlot(s, `${TAG}-e-next`);
  check("E2: reclaimed slot is usable again (no permanent leak)", !!after.reservationId);

  // fresh (non-stale) reservations survive the reclaim
  const still = await query(
    `SELECT count(*)::int AS n FROM quota_reservations WHERE scope_type='user' AND scope_id=$1 AND released_at IS NULL AND released_reason IS NULL`,
    [u]
  );
  check("E3: reclaim touched only stale rows", still.rows[0].n === 1, `live=${still.rows[0].n}`);

  // retry accounting through the ledger: one job, 2 retries, failed
  await Q.releaseReservation(s, `${TAG}-e-next`, { outcome: "failed", explorationMs: 60_000, retries: 2 });
  const ledger = await query(
    `SELECT event_type, amount FROM quota_usage_events WHERE scope_type='user' AND scope_id=$1 AND task_key=$2`,
    [u, `${TAG}-e-next`]
  );
  // events of one release share a transaction timestamp — assert the multiset
  const types = ledger.rows.map((r) => r.event_type).sort();
  const retryAmounts = ledger.rows.filter((r) => r.event_type === "retry").map((r) => Number(r.amount));
  check("E4: ledger records the full lifecycle (started → retry×2 → failed + exploration_ms)",
    types.join(",") === ["exploration_ms", "failed", "retry", "started"].join(",") && retryAmounts.length === 1 && retryAmounts[0] === 2,
    `types=${types.join("|")} retryAmount=${retryAmounts[0]}`);
  const usage = await Q.getUsage(s);
  check("E5: failed+cancelled jobs surface in the usage API",
    usage.jobsFailedToday >= 1 && usage.jobsCancelledToday >= 1, `f=${usage.jobsFailedToday} x=${usage.jobsCancelledToday}`);
}

// ============================================================
section("F. middleware — typed 402/429, order, usage route");
{
  const express = (await import("express")).default;
  const mw = await import("../src/platform/quota-middleware.js");
  const { authRequired } = await import("../src/auth/auth-middleware.js");
  const auth = await import("../src/auth/auth-service.js");

  const app = express();
  app.use(express.json());
  app.post("/api/quotest/tasks", authRequired, mw.quotaGuard(), (req, res) => res.json({ ok: true, gotHere: true, taskKey: req.quotaTaskKey }));
  app.get("/api/quotest/usage", authRequired, mw.quotaUsageRoute());
  app.post("/api/quotest/reconcile", authRequired, mw.quotaReconcile());

  const u = await mkUser("mw");
  const token = crypto.randomBytes(32).toString("hex");
  await query("INSERT INTO sessions (user_id, token_hash, expires_at) VALUES ($1, $2, now() + interval '1 hour')",
    [u, crypto.createHash("sha256").update(token).digest("hex")]);
  const s = userScope(u);
  // generous concurrent cap, tight DAILY cap — the 402 path must come from the
  // daily limit, not from slots held by earlier sections
  await pinLimits(s, { concurrent: 5, perDay: 2 });

  const server = app.listen(0);
  await new Promise((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const hdr = { "content-type": "application/json", authorization: `Bearer ${token}` };
  const post = async (p, body = {}) => {
    const r = await fetch(base + p, { method: "POST", headers: hdr, body: JSON.stringify(body) });
    return { status: r.status, body: await r.json().catch(() => ({})), retryAfter: r.headers.get("retry-after") };
  };

  const r1 = await post("/api/quotest/tasks", { url: "https://example.com/" });
  check("F1: under the limit → handler reached, slot attached", r1.status === 200 && r1.body.gotHere === true, JSON.stringify(r1.body));

  const r2 = await post("/api/quotest/tasks", { url: "https://example.com/" });
  check("F2: 2nd job OK (perDay=2), then the 3rd hits the daily 402 — BEFORE any queueing",
    r2.status === 200);
  const r3 = await post("/api/quotest/tasks", { url: "https://example.com/" });
  check("F3: typed 402 PAYMENT_REQUIRED on the daily limit", r3.status === 402 && r3.body.reason === "daily_job_limit" && r3.body.code === "QUOTA_EXCEEDED",
    `status=${r3.status} reason=${r3.body.reason}`);

  // concurrent 429 path: fresh user, concurrent=1, one live slot, one more request
  const u2 = await mkUser("mw-conc");
  const t2 = crypto.randomBytes(32).toString("hex");
  await query("INSERT INTO sessions (user_id, token_hash, expires_at) VALUES ($1, $2, now() + interval '1 hour')",
    [u2, crypto.createHash("sha256").update(t2).digest("hex")]);
  await pinLimits(userScope(u2), { concurrent: 1, perDay: null });
  const hdr2 = { "content-type": "application/json", authorization: `Bearer ${t2}` };
  await fetch(base + "/api/quotest/tasks", { method: "POST", headers: hdr2, body: "{}" }); // slot 1 held (never released)
  const r4 = await fetch(base + "/api/quotest/tasks", { method: "POST", headers: hdr2, body: "{}" });
  const r4b = await r4.json().catch(() => ({}));
  check("F4: typed 429 TOO_MANY_REQUESTS on the concurrent limit + Retry-After",
    r4.status === 429 && r4b.reason === "concurrent_job_limit" && r4.headers.get("retry-after") === "30",
    `status=${r4.status} reason=${r4b.reason} retry-after=${r4.headers.get("retry-after")}`);

  // usage route exposes usage + limits + live rejection reasons (plan step 8)
  const ur = await fetch(base + "/api/quotest/usage", { headers: hdr }).then((r) => r.json());
  check("F5: usage route exposes usage+limits+wouldReject",
    ur.ok === true && ur.usage.limits.max_jobs_per_day === 2 && ur.usage.jobsStartedToday === 2
      && ur.usage.wouldReject.some((x) => x.reason === "daily_job_limit"),
    JSON.stringify(ur.usage?.wouldReject));

  const rec = await post("/api/quotest/reconcile", {});
  check("F6: reconcile route reclaims nothing fresh and reports clean", rec.status === 200 && Array.isArray(rec.body.reclaimed),
    `reclaimed=${rec.body.reclaimed?.length}`);

  // guard runs BEFORE the handler: a rejected request never reaches next()
  check("F7: rejected requests never reach the handler (guard order)",
    r3.status === 402 && !("gotHere" in r3.body), JSON.stringify(r3.body));

  // release idempotency via the middleware callback
  server.close();
  await new Promise((r) => server.once("close", r));
}

// release idempotency (service level, deterministic)
{
  const u = await mkUser("idem");
  const s = userScope(u);
  await pinLimits(s, { concurrent: 2 });
  await Q.reserveJobSlot(s, `${TAG}-f-idem`);
  const r1 = await Q.releaseReservation(s, `${TAG}-f-idem`, { outcome: "completed" });
  const r2 = await Q.releaseReservation(s, `${TAG}-f-idem`, { outcome: "completed" });
  check("F8: double release is safe (second is a no-op, no double accounting)",
    r1.released === true && r2.released === false, `r1=${r1.released} r2=${r2.released}`);
  const started = await query(
    `SELECT jobs_started, jobs_completed FROM quota_usage_daily WHERE scope_type='user' AND scope_id=$1 AND day=(now() at time zone 'utc')::date`,
    [u]
  );
  check("F9: double release did not double-count started/completed",
    Number(started.rows[0]?.jobs_started) === 1 && Number(started.rows[0]?.jobs_completed) === 1,
    `s=${started.rows[0]?.jobs_started} c=${started.rows[0]?.jobs_completed}`);
}

// ============================================================
section("G. storage meter — injection + real computeUsage (4.0.5)");
{
  // G1: injection drives the limit (already exercised in A7/A8 + C4) — here the
  // REAL computeUsage from 4.0.5 is exercised against a temp artifacts tree.
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "quota404-"));
  const orgId = crypto.randomUUID();
  // layout: artifacts/<orgId>/<jobId>/manifest.json + files (computeUsage's org bucket)
  const jobDir = path.join(tmp, "artifacts", orgId, "job-1");
  fs.mkdirSync(jobDir, { recursive: true });
  // fixed exact bytes → the size assertions below are independent of JSON formatting
  const orgManifest = Buffer.from(`{"lifecycle":{"orgId":"${orgId}","jobId":"job-1"}}`);
  fs.writeFileSync(path.join(jobDir, "manifest.json"), orgManifest);
  fs.writeFileSync(path.join(jobDir, "data.bin"), Buffer.alloc(4096, 7));
  const legacyDir = path.join(tmp, "artifacts", "legacy-job");
  fs.mkdirSync(legacyDir, { recursive: true });
  const legacyManifest = Buffer.from('{"ok":true}');
  fs.writeFileSync(path.join(legacyDir, "manifest.json"), legacyManifest);
  fs.writeFileSync(path.join(legacyDir, "page.html"), Buffer.alloc(1024, 1));

  const { computeUsage } = await import("../src/storage/artifact-lifecycle.js");
  const usage = computeUsage(path.join(tmp, "artifacts"));
  check("G1: real computeUsage (4.0.5) buckets org bytes exactly (data + manifest)",
    usage.orgs[orgId]?.bytes === orgManifest.length + 4096, JSON.stringify(usage.orgs?.[orgId] || null) + ` manifest=${orgManifest.length}`);
  const legacyBytes = legacyManifest.length + 1024;
  check("G2: legacy bucket counted separately (personal scope reads legacy)",
    usage.legacy.bytes === legacyBytes, `legacy=${usage.legacy.bytes} expected=${legacyBytes}`);

  // wire the real meter through the service's injection seam
  const realUsage = computeUsage(path.join(tmp, "artifacts"));
  Q.setStorageMeter((scopeId) => Number(realUsage.orgs?.[String(scopeId)]?.bytes || realUsage.legacy?.bytes || 0));
  const u = await mkUser("real-meter");
  const s = userScope(u);
  // cap sits just above the legacy usage: a small extra request fits, a big one does not
  await pinLimits(s, { bytes: legacyBytes + 500 });
  let err = null;
  try { await Q.reserveJobSlot(s, `${TAG}-g1`, { estimatedBytes: 400 }); } catch (e) { err = e; }
  check("G3: real-meter usage under the cap passes (legacy + 400 ≤ cap)", err === null, err?.reason || "reserved");
  let err2 = null;
  try { await Q.reserveJobSlot(s, `${TAG}-g2`, { estimatedBytes: 600 }); } catch (e) { err2 = e; }
  check("G4: storage limit rejects when real usage + request exceeds the cap",
    err2 instanceof Q.QuotaExceededError && err2.reason === "storage_limit", err2?.reason || "no rejection");
  Q.setStorageMeter(null);
  fs.rmSync(tmp, { recursive: true, force: true });
}

// ============================================================
const fails = results.filter((r) => !r).length;
console.log(`\nRESULT: ${fails ? "FAIL" : "PASS"}  (${results.length - fails}/${results.length} checks passed)`);
await cleanup();
await closePool();
process.exit(fails ? 1 : 0);
