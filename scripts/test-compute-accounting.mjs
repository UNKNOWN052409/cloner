#!/usr/bin/env node
// Per-job compute accounting + cost model tests (task 4.2.12) — REAL
// PostgreSQL (docker compose instance, PG 5433) via src/database/client.js.
//
//   SKIP contract: if the compose Postgres is unreachable, every check prints a
//   SKIP line and the script exits 0 (per the phase rule "tests pass WITHOUT
//   live external services; PostgreSQL tests use the compose instance and print
//   a SKIP line if docker is unreachable").
//
// Coverage:
//   A. cost model + rates — env defaults, scope > global > env precedence,
//      null override clears, exact 6-decimal arithmetic (binary-exact AND
//      non-binary rates), runtime-minute ceiling, invalid quantities rejected
//      before anything is written, currency from override + mismatch refusal
//   B. accounting EXACT after N stub jobs — the named check: 10 stub jobs with
//      pre-computed quantities settle into exactly N cost rows and exactly N
//      ledger debits whose per-job amounts, component columns, totals and
//      scope summary all match the documented formula (independent arithmetic)
//   C. idempotency — re-settle never double-charges; failed settlement retries
//      the debit exactly once without recomputing cost
//   D. ledger contract — string/object/void refs, insufficient-credit
//      rejection ('rejected' row + typed error + ledger unchanged), arbitrary
//      failure ('failed'), absent ledger ('unposted' + settled:false), sweep
//      posting (postUnsettledCosts) with/without rejected rows
//   E. scope isolation — user pools isolated, org pool aggregates members'
//      jobs, per-scope rate override affects only its own scope
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
  for (let i = 0; i < n; i++) console.log(`SKIP  compute check ${i + 1}/${n} — ${msg}`);
  console.log(`\nRESULT: SKIP  (0/${n} checks run — database unavailable)`);
  process.exit(0);
}

// ---------- apply ONLY my migration (030) — full ordered run is the integrator's job ----------
try {
  const fsmod = await import("node:fs");
  const sql = fsmod.readFileSync(new URL("../src/database/migrations/030-compute-costs.sql", import.meta.url), "utf8");
  await db.query(sql);
} catch (e) {
  console.log("FAIL  migration 030 failed to apply — " + String(e?.message || e).slice(0, 300));
  process.exit(1);
}

const C = await import("../src/platform/compute-accounting.js");
const { query, closePool } = db;

// ---------- test scaffolding ----------
const TAG = "c4212" + crypto.randomBytes(3).toString("hex");
async function mkUser(label) {
  const email = `${TAG}-${label}-${crypto.randomBytes(4).toString("hex")}@compute.test`;
  const r = await query("INSERT INTO users (email, password_hash) VALUES ($1, 'x') RETURNING id", [email]);
  return r.rows[0].id;
}
async function mkOrg(label, ownerId) {
  const slug = `${TAG}-${label}-${crypto.randomBytes(3).toString("hex")}`;
  const r = await query(
    "INSERT INTO organizations (name, slug, owner_user_id, created_by) VALUES ($1, $2, $3, $3) RETURNING id",
    [`Compute org ${label}`, slug, ownerId]
  );
  return r.rows[0].id;
}
async function mkMembership(orgId, userId, role = "member") {
  await query("INSERT INTO org_members (org_id, user_id, role) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING", [orgId, userId, role]);
}
async function cleanup() {
  await query(`DELETE FROM compute_job_costs  WHERE scope_id IN (SELECT id FROM users WHERE email LIKE '${TAG}-%') OR scope_id IN (SELECT id FROM organizations WHERE slug LIKE '${TAG}-%')`);
  await query(`DELETE FROM compute_cost_rates WHERE scope_id IN (SELECT id FROM users WHERE email LIKE '${TAG}-%') OR scope_id IN (SELECT id FROM organizations WHERE slug LIKE '${TAG}-%')`);
  await query(`DELETE FROM compute_cost_rates WHERE scope_type = 'global'`);
  await query(`DELETE FROM org_members WHERE user_id IN (SELECT id FROM users WHERE email LIKE '${TAG}-%')`);
  await query(`DELETE FROM organizations WHERE slug LIKE '${TAG}-%'`);
  await query(`DELETE FROM users WHERE email LIKE '${TAG}-%'`);
}
await cleanup();
C.setCreditLedger(null); // every section injects its own ledger explicitly

const userScope = (userId) => ({ scope_type: "user", scope_id: userId });
const orgScope = (orgId) => ({ scope_type: "org", scope_id: orgId });

// ---------- mock credit ledger (test-side ONLY — the product code injects the real one) ----------
function mkLedger({ balance = 1_000_000, refuse = [], fail = [] } = {}) {
  const debits = [];
  let bal = balance;
  return {
    debits,
    get balance() { return bal; },
    calls: 0,
    // The product contract: idempotent per taskKey, refuses insufficient credit
    // with the typed signal, records nothing on refusal.
    async debit(req) {
      this.calls++;
      if (refuse.includes(req.taskKey)) {
        const e = new Error(`insufficient credits: balance ${bal}`);
        e.name = "InsufficientCreditsError";
        e.code = "INSUFFICIENT_CREDITS";
        throw e;
      }
      if (fail.includes(req.taskKey)) throw new Error("ledger upstream 503");
      const prior = debits.find((d) => d.taskKey === req.taskKey && d.reason === req.reason);
      if (prior) return { ref: prior.ref }; // replay — never double-charge
      if (bal < req.amount) {
        const e = new Error(`insufficient credits: balance ${bal}`);
        e.name = "InsufficientCreditsError";
        e.code = "INSUFFICIENT_CREDITS";
        throw e;
      }
      const ref = `dbt-${debits.length + 1}`;
      debits.push({ ...req, ref });
      bal -= req.amount;
      return { ref, balanceAfter: bal };
    },
  };
}

// Independent implementation of the DOCUMENTED cost model (compute-accounting.js
// header) — the module under test must agree with this, bit for bit.
const r6 = (x) => Math.round(x * 1e6) / 1e6;
function expectedCost(ms, slots, bytes, rates) {
  const mins = Math.ceil(Math.round(ms) / 60000);
  return {
    runtimeMinutes: mins,
    costRuntime: r6(mins * rates.runtime_minute),
    costSlots: r6(Math.round(slots) * rates.browser_slot),
    costBytes: r6(Math.round(bytes) * rates.artifact_byte),
    total: r6(mins * rates.runtime_minute + Math.round(slots) * rates.browser_slot + Math.round(bytes) * rates.artifact_byte),
  };
}

// ============================================================
section("A. cost model + rates");
{
  const u = await mkUser("rates");
  const s = userScope(u);

  // env defaults when no override rows exist anywhere
  const d = await C.resolveRates(s);
  check("A1: env defaults with no overrides (0.01/min, 0.005/slot, 1e-8/byte, credits)",
    d.runtime_minute === 0.01 && d.browser_slot === 0.005 && d.artifact_byte === 1e-8 && d.currency === "credits",
    JSON.stringify({ rm: d.runtime_minute, bs: d.browser_slot, ab: d.artifact_byte, cur: d.currency }));
  check("A2: env-default sources reported per key", d.sources.runtime_minute === "env" && d.sources.artifact_byte === "env", JSON.stringify(d.sources));

  // scope override wins
  await C.setRate(s, "runtime_minute", 0.25);
  const o = await C.resolveRates(s);
  check("A3: scope override wins over env (runtime_minute 0.25)", o.runtime_minute === 0.25 && o.sources.runtime_minute === "scope", JSON.stringify({ v: o.runtime_minute, src: o.sources.runtime_minute }));
  check("A4: non-overridden keys still env", o.browser_slot === 0.005 && o.sources.browser_slot === "env", "");

  // global row fills the gap under the scope override, above env
  await C.setRate(C.GLOBAL_SCOPE, "browser_slot", 0.125);
  await C.setRate(C.GLOBAL_SCOPE, "artifact_byte", 0.0078125);
  const g = await C.resolveRates(s);
  check("A5: global row used when scope lacks the key (0.125/slot, 0.0078125/byte)",
    g.browser_slot === 0.125 && g.artifact_byte === 0.0078125 && g.sources.browser_slot === "global",
    JSON.stringify({ bs: g.browser_slot, ab: g.artifact_byte, src: g.sources.browser_slot }));
  check("A6: scope override still beats global for its key", g.runtime_minute === 0.25 && g.sources.runtime_minute === "scope", "");

  // global applies to a different scope too
  const u2 = await mkUser("rates2");
  const g2 = await C.resolveRates(userScope(u2));
  check("A7: global row applies to every scope", g2.browser_slot === 0.125 && g2.runtime_minute === 0.01 && g2.sources.runtime_minute === "env", "");

  // pure model: binary-exact rates — no rounding subtleties, exact equality
  const binRates = { runtime_minute: 0.25, browser_slot: 0.125, artifact_byte: 0.0078125, currency: "credits" };
  const c1 = C.computeCost({ runtimeMs: 3 * 60_000, browserSlots: 2, artifactBytes: 1500 }, binRates);
  const e1 = expectedCost(3 * 60_000, 2, 1500, binRates);
  check("A8: pure model exact (3min/2slots/1500B → 0.75 + 0.25 + 11.71875)",
    c1.runtimeMinutes === 3 && c1.costRuntime === e1.costRuntime && c1.costSlots === e1.costSlots && c1.costBytes === e1.costBytes,
    JSON.stringify({ rt: c1.costRuntime, sl: c1.costSlots, by: c1.costBytes }));
  check("A9: total is the round6 sum of components", c1.costTotal === r6(0.75 + 0.25 + 11.71875), `total=${c1.costTotal}`);

  // non-binary rates — the documented round6 rule kills float dust
  const dust = C.computeCost({ runtimeMs: 3 * 60_000, browserSlots: 0, artifactBytes: 0 }, { runtime_minute: 0.02, browser_slot: 0.02, artifact_byte: 0.02, currency: "credits" });
  check("A10: round6 removes float dust (3×0.02 → 0.06, not 0.060000000000000005)", dust.costRuntime === 0.06 && dust.costTotal === 0.06, `got ${dust.costRuntime}`);

  // runtime minute ceiling
  const ceil = (ms) => C.computeCost({ runtimeMs: ms, browserSlots: 0, artifactBytes: 0 }, binRates).runtimeMinutes;
  check("A11: minute ceiling — 60000ms→1, 59999ms→1, 90001ms→2, 120000ms→2, 0→0",
    ceil(60_000) === 1 && ceil(59_999) === 1 && ceil(90_001) === 2 && ceil(120_000) === 2 && ceil(0) === 0,
    JSON.stringify([ceil(60_000), ceil(59_999), ceil(90_001), ceil(120_000), ceil(0)]));

  // invalid quantities rejected by the pure model
  let bad = null;
  try { C.computeCost({ runtimeMs: -5, browserSlots: 0, artifactBytes: 0 }, binRates); } catch (e) { bad = e; }
  let bad2 = null;
  try { C.computeCost({ runtimeMs: 0, browserSlots: NaN, artifactBytes: 0 }, binRates); } catch (e) { bad2 = e; }
  check("A12: negative runtimeMs / NaN slots rejected with clear errors", !!bad && !!bad2, `${bad?.message} | ${bad2?.message}`);

  // previewCost goes through the resolved (overridden) rates
  const pv = await C.previewCost(s, { runtimeMs: 60_000, browserSlots: 0, artifactBytes: 0 });
  check("A13: previewCost uses resolved scope rates", pv.cost.costRuntime === 0.25 && pv.rates.runtime_minute === 0.25, `cost=${pv.cost.costRuntime}`);

  // currency: override row carries it; a mismatched currency among CONTRIBUTING rows refuses
  await C.setRate(s, "artifact_byte", null); // clear scope key → global contributes for that key
  const cur = await C.resolveRates(s);
  check("A14: null override clears (artifact_byte falls back to global 0.0078125)", cur.artifact_byte === 0.0078125 && cur.sources.artifact_byte === "global", JSON.stringify({ v: cur.artifact_byte }));
  await query(
    "UPDATE compute_cost_rates SET currency = 'usd' WHERE scope_type = 'global' AND rate_key = 'browser_slot'"
  );
  let mis = null;
  try { await C.resolveRates(s); } catch (e) { mis = e; }
  check("A15: mismatched currency across contributing rows → clean error", !!mis && /currency mismatch/.test(mis.message), mis?.message || "no error");
  await query("UPDATE compute_cost_rates SET currency = 'credits' WHERE scope_type = 'global' AND rate_key = 'browser_slot'");
  // a fully-shadowed global row with a different currency is irrelevant (no throw)
  await C.setRate(s, "browser_slot", 0.5);
  await query("UPDATE compute_cost_rates SET currency = 'usd' WHERE scope_type = 'global' AND rate_key = 'browser_slot'");
  let shadow = null;
  try { await C.resolveRates(s); } catch (e) { shadow = e; }
  check("A16: shadowed row's currency is irrelevant (no false mismatch)", shadow === null, shadow?.message || "resolved ok");
  await query("UPDATE compute_cost_rates SET currency = 'credits' WHERE scope_type = 'global' AND rate_key = 'browser_slot'");
  await C.setRate(s, "browser_slot", null);

  // settle-time validation: a bad call writes NOTHING
  let sv = null;
  try { await C.settleJobCost(s, `${TAG}-bad`, { runtimeMs: -1 }); } catch (e) { sv = e; }
  const nothing = await query(`SELECT count(*)::int AS n FROM compute_job_costs WHERE task_key = $1`, [`${TAG}-bad`]);
  check("A17: invalid quantities at settle rejected, nothing written", !!sv && nothing.rows[0].n === 0, `${sv?.message} rows=${nothing.rows[0].n}`);
}

// ============================================================
section("B. accounting exact after N stub jobs");
{
  const u = await mkUser("stubjobs");
  const s = userScope(u);
  await C.setRate(s, "runtime_minute", 0.25);
  await C.setRate(s, "browser_slot", 0.125);
  await C.setRate(s, "artifact_byte", 0.0078125);

  const ledger = mkLedger({ balance: 10_000_000 }); // section B's largest job costs ~78k credits
  // 10 stub jobs with PRE-DETERMINED quantities (incl. zero-slot, zero-byte, sub-minute)
  const jobs = [
    { key: `${TAG}-j01`, ms: 3 * 60_000, slots: 2, bytes: 1500 },
    { key: `${TAG}-j02`, ms: 59_999, slots: 1, bytes: 0 },
    { key: `${TAG}-j03`, ms: 0, slots: 0, bytes: 4096 },
    { key: `${TAG}-j04`, ms: 90_001, slots: 3, bytes: 10_000_000 },
    { key: `${TAG}-j05`, ms: 61 * 60_000, slots: 0, bytes: 512 },
    { key: `${TAG}-j06`, ms: 60_000, slots: 1, bytes: 1 },
    { key: `${TAG}-j07`, ms: 123_456, slots: 2, bytes: 654_321 },
    { key: `${TAG}-j08`, ms: 1, slots: 0, bytes: 0 },
    { key: `${TAG}-j09`, ms: 10 * 60_000, slots: 4, bytes: 2_000_000 },
    { key: `${TAG}-j10`, ms: 3599_999, slots: 1, bytes: 42 },
  ];
  const rates = await C.resolveRates(s);
  const expected = jobs.map((j) => ({ ...j, exp: expectedCost(j.ms, j.slots, j.bytes, rates) }));

  for (const j of jobs) {
    await C.settleJobCost(s, j.key, { userId: u, runtimeMs: j.ms, browserSlots: j.slots, artifactBytes: j.bytes, ledger });
  }

  const rows = (await query(
    `SELECT * FROM compute_job_costs WHERE scope_type = 'user' AND scope_id = $1 ORDER BY task_key`,
    [s.scope_id]
  )).rows;
  check("B1: exactly N=10 cost rows after N=10 stub jobs", rows.length === 10, `rows=${rows.length}`);

  check("B2: exactly N=10 ledger debits, one per job", ledger.debits.length === 10, `debits=${ledger.debits.length}`);

  // per-job: component columns and debit amount each match the documented formula
  let perJobOk = true;
  const perJobDetail = [];
  for (let i = 0; i < jobs.length; i++) {
    const row = rows.find((r) => r.task_key === jobs[i].key);
    const e = expected[i].exp;
    const got = row ? {
      rm: Number(row.runtime_minutes), cr: Number(row.cost_runtime), cs: Number(row.cost_slots), cb: Number(row.cost_bytes), ct: Number(row.cost_total),
    } : null;
    const ok = row
      && got.rm === e.runtimeMinutes
      && got.cr === e.costRuntime && got.cs === e.costSlots && got.cb === e.costBytes
      && got.ct === e.total
      && ledger.debits.some((d) => d.taskKey === jobs[i].key)
      && Number(ledger.debits.find((dd) => dd.taskKey === jobs[i].key)?.amount) === e.total;
    if (!ok) perJobOk = false;
    perJobDetail.push(`${jobs[i].key.slice(-3)}: got ${JSON.stringify(got)} want ${JSON.stringify({ rm: e.runtimeMinutes, cr: e.costRuntime, cs: e.costSlots, cb: e.costBytes, ct: e.total })}`);
  }
  check("B3: every job's runtime_minutes/cost_runtime/cost_slots/cost_bytes/cost_total and debit amount exactly match the documented formula", perJobOk, perJobDetail.join(" | "));

  const sumRows = rows.reduce((a, r) => a + Number(r.cost_total), 0);
  const sumDebits = ledger.debits.reduce((a, d) => a + d.amount, 0);
  const sumExpected = expected.reduce((a, j) => a + j.exp.total, 0);
  check("B4: sum(debits) == sum(cost_total) == hand-computed expected total",
    r6(sumDebits) === r6(sumRows) && r6(sumRows) === r6(sumExpected),
    `debits=${r6(sumDebits)} rows=${r6(sumRows)} expected=${r6(sumExpected)}`);

  const zeroByte = rows.find((r) => r.task_key === jobs[2].key); // j03: 0ms, 0 slots, 4096B
  check("B5: zero-quantity jobs billed only for what they used (j03: 0 min, 0 slots)",
    Number(zeroByte.runtime_minutes) === 0 && Number(zeroByte.browser_slots) === 0 && Number(zeroByte.cost_runtime) === 0 && Number(zeroByte.cost_slots) === 0,
    JSON.stringify({ rm: zeroByte.runtime_minutes, bs: zeroByte.browser_slots }));

  const snap = rows[0].rates_snapshot;
  check("B6: rates_snapshot frozen per job (rates + sources + currency)",
    snap.runtime_minute === 0.25 && snap.browser_slot === 0.125 && snap.artifact_byte === 0.0078125 && snap.currency === "credits" && snap.sources.runtime_minute === "scope",
    JSON.stringify(snap));

  const allPosted = rows.every((r) => r.ledger_status === "posted" && r.settled_at !== null && r.ledger_ref !== null);
  check("B7: all 10 rows posted to the ledger with refs + settled_at", allPosted, JSON.stringify(rows.map((r) => r.ledger_status)));

  const debitsWellFormed = ledger.debits.every((d) =>
    d.reason === "compute" && d.scopeType === "user" && d.scopeId === s.scope_id && d.userId === u
    && typeof d.breakdown.runtimeMinutes === "number" && d.currency === "credits");
  check("B8: debit requests carry scope/user/reason/breakdown/currency", debitsWellFormed, JSON.stringify(ledger.debits[0] || null));

  const summary = await C.costSummary(s);
  check("B9: scope summary exact (jobs=10, sums match, byStatus posted=10)",
    summary.jobs === 10
    && summary.runtimeMinutes === rows.reduce((a, r) => a + Number(r.runtime_minutes), 0)
    && summary.browserSlots === rows.reduce((a, r) => a + Number(r.browser_slots), 0)
    && summary.artifactBytes === rows.reduce((a, r) => a + Number(r.artifact_bytes), 0)
    && r6(summary.costTotal) === r6(sumExpected)
    && summary.byStatus.posted === 10 && summary.byStatus.unposted === 0,
    JSON.stringify(summary));

  const j10 = rows.find((r) => r.task_key === jobs[9].key); // 3599999ms → exactly 60 started minutes
  check("B10: 3599999ms bills exactly 60 started minutes", Number(j10.runtime_minutes) === 60, `got ${j10.runtime_minutes}`);
}

// ============================================================
section("C. idempotency — double settle never double charges");
{
  // back to the env-default baseline (section A left global rows behind; C
  // overrides only runtime_minute, so slot/byte rates must be the env ones)
  await query("DELETE FROM compute_cost_rates WHERE scope_type = 'global'");
  const u = await mkUser("idem");
  const s = userScope(u);
  await C.setRate(s, "runtime_minute", 0.5);
  const ledger = mkLedger({});

  // 2min × 0.5 + 1 slot × 0.005 + 100 B × 1e-8 = 1.005001 (env slot/byte rates)
  const EXPECT1 = 1.005001;
  const first = await C.settleJobCost(s, `${TAG}-idem1`, { userId: u, runtimeMs: 2 * 60_000, browserSlots: 1, artifactBytes: 100, ledger });
  const again = await C.settleJobCost(s, `${TAG}-idem1`, { userId: u, runtimeMs: 99 * 60_000, browserSlots: 9, artifactBytes: 999, ledger });
  const rows = (await query(`SELECT * FROM compute_job_costs WHERE task_key = $1`, [`${TAG}-idem1`])).rows;
  check("C1: re-settle returns the ORIGINAL record untouched (1 row, no recompute)",
    rows.length === 1 && again.reused === true && again.settled === true
    && Number(rows[0].runtime_ms) === 2 * 60_000 && Number(rows[0].cost_total) === EXPECT1 && Number(rows[0].runtime_minutes) === 2,
    `rows=${rows.length} reused=${again.reused} cost=${rows[0]?.cost_total}`);
  check("C2: re-settle did NOT debit again (1 call, 1 debit total)",
    ledger.debits.length === 1 && ledger.calls === 1, `debits=${ledger.debits.length} calls=${ledger.calls}`);
  check("C3: first settle debited once with the computed amount", first.settled === true && ledger.debits[0]?.amount === EXPECT1, `amount=${ledger.debits[0]?.amount}`);

  // distinct task keys settle independently
  await C.settleJobCost(s, `${TAG}-idem2`, { userId: u, runtimeMs: 60_000, browserSlots: 0, artifactBytes: 0, ledger });
  check("C4: distinct task keys settle independently (2 debits)", ledger.debits.length === 2, `debits=${ledger.debits.length}`);

  // a 'failed' row retries ONLY the debit — cost + snapshot stand
  const ledger2 = mkLedger({ fail: [`${TAG}-idem3`] });
  let err = null;
  try { await C.settleJobCost(s, `${TAG}-idem3`, { userId: u, runtimeMs: 4 * 60_000, browserSlots: 0, artifactBytes: 0, ledger: ledger2 }); } catch (e) { err = e; }
  const before = (await query(`SELECT * FROM compute_job_costs WHERE task_key = $1`, [`${TAG}-idem3`])).rows[0];
  check("C5: upstream ledger failure → typed error, row 'failed', cost recorded",
    err instanceof C.LedgerSettlementError && err.status === "failed" && before.ledger_status === "failed" && Number(before.cost_total) === 2,
    `${err?.name}/${err?.status} cost=${before?.cost_total}`);
  const ledger2b = mkLedger({});
  const retry = await C.settleJobCost(s, `${TAG}-idem3`, { userId: u, runtimeMs: 4 * 60_000, browserSlots: 0, artifactBytes: 0, ledger: ledger2b });
  const after = (await query(`SELECT * FROM compute_job_costs WHERE task_key = $1`, [`${TAG}-idem3`])).rows[0];
  check("C6: retry of failed row posts the debit exactly once, cost NOT recomputed",
    retry.settled === true && retry.reused === false && ledger2b.debits.length === 1 && ledger2b.debits[0].amount === 2
    && Number(after.cost_total) === 2 && Number(after.runtime_ms) === 4 * 60_000 && after.ledger_status === "posted",
    `debits=${ledger2b.debits.length} cost=${after.cost_total} status=${after.ledger_status}`);
}

// ============================================================
section("D. ledger contract");
{
  const u = await mkUser("ledger");
  const s = userScope(u);
  await C.setRate(s, "runtime_minute", 1);

  // ref extraction: string / object / void
  const strLedger = { async debit() { return "ref-string-1"; } };
  const r1 = await C.settleJobCost(s, `${TAG}-d1`, { userId: u, runtimeMs: 60_000, ledger: strLedger });
  const objLedger = { async debit() { return { ref: "ref-obj-2", balanceAfter: 10 }; } };
  const r2 = await C.settleJobCost(s, `${TAG}-d2`, { userId: u, runtimeMs: 60_000, ledger: objLedger });
  const voidLedger = { async debit() { /* void — debit happened, no ref */ } };
  const r3 = await C.settleJobCost(s, `${TAG}-d3`, { userId: u, runtimeMs: 60_000, ledger: voidLedger });
  const drows = (await query(`SELECT task_key, ledger_ref, ledger_status FROM compute_job_costs WHERE scope_id = $1 ORDER BY task_key`, [s.scope_id])).rows;
  check("D1: string return → ledger_ref captured", drows.find((r) => r.task_key === `${TAG}-d1`).ledger_ref === "ref-string-1", drows[0]?.ledger_ref);
  check("D2: object { ref } → ledger_ref captured", drows.find((r) => r.task_key === `${TAG}-d2`).ledger_ref === "ref-obj-2", drows[1]?.ledger_ref);
  check("D3: void return → still 'posted' with null ref", drows.find((r) => r.task_key === `${TAG}-d3`).ledger_status === "posted" && r3.debit.ref === null, "");

  // insufficient credit: typed rejection, row 'rejected', ledger unchanged
  const poor = mkLedger({ balance: 0.5 });
  let err = null;
  try { await C.settleJobCost(s, `${TAG}-d4`, { userId: u, runtimeMs: 3 * 60_000, ledger: poor }); } catch (e) { err = e; }
  const d4 = (await query(`SELECT * FROM compute_job_costs WHERE task_key = $1`, [`${TAG}-d4`])).rows[0];
  check("D4: insufficient credits → LedgerSettlementError(status 'rejected'), row 'rejected' with error text, NO debit recorded",
    err instanceof C.LedgerSettlementError && err.status === "rejected"
    && d4.ledger_status === "rejected" && d4.ledger_error !== null && d4.ledger_ref === null
    && poor.debits.length === 0 && Number(d4.cost_total) === 3,
    `${err?.name}/${err?.status} ledger_error=${d4?.ledger_error?.slice(0, 40)}`);

  // isInsufficientCreditsError recognises both signals
  const e1 = Object.assign(new Error("x"), { name: "InsufficientCreditsError" });
  const e2 = Object.assign(new Error("x"), { code: "INSUFFICIENT_CREDITS" });
  const e3 = new Error("network down");
  check("D5: isInsufficientCreditsError matches name OR code, not plain errors",
    C.isInsufficientCreditsError(e1) && C.isInsufficientCreditsError(e2) && !C.isInsufficientCreditsError(e3), "");

  // absent ledger: accounting survives, settlement deferred
  C.setCreditLedger(null);
  const r6 = await C.settleJobCost(s, `${TAG}-d6`, { userId: u, runtimeMs: 60_000 });
  const d6 = (await query(`SELECT * FROM compute_job_costs WHERE task_key = $1`, [`${TAG}-d6`])).rows[0];
  check("D6: no ledger configured → settled:false reason 'ledger_not_configured', row 'unposted' with exact cost",
    r6.settled === false && r6.reason === "ledger_not_configured" && d6.ledger_status === "unposted" && Number(d6.cost_total) === 1,
    `${r6.reason} cost=${d6.cost_total}`);

  // sweep posts unposted rows exactly once; rejected rows need includeRejected
  const sweepLedger = mkLedger({});
  const sweep1 = await C.postUnsettledCosts({ ledger: sweepLedger, scope: s });
  const d6b = (await query(`SELECT ledger_status FROM compute_job_costs WHERE task_key = $1`, [`${TAG}-d6`])).rows[0];
  const sweep2 = await C.postUnsettledCosts({ ledger: sweepLedger, scope: s });
  check("D7: postUnsettledCosts posts the unposted row exactly once; re-sweep finds nothing unsettled",
    sweep1.results.length === 1 && sweep1.results[0].ok === true && d6b.ledger_status === "posted"
    && sweep2.results.length === 0 && sweepLedger.debits.length === 1,
    `sweep1=${JSON.stringify(sweep1.results)} sweep2=${JSON.stringify(sweep2.results)} debits=${sweepLedger.debits.length}`);

  // includeRejected: the D4 rejected row is retried only when asked
  const sweep3 = await C.postUnsettledCosts({ ledger: sweepLedger, scope: s });
  const sweep4 = await C.postUnsettledCosts({ ledger: sweepLedger, scope: s, includeRejected: true });
  const d4b = (await query(`SELECT ledger_status FROM compute_job_costs WHERE task_key = $1`, [`${TAG}-d4`])).rows[0];
  check("D8: rejected rows skipped by default sweep, posted with includeRejected:true",
    sweep3.results.length === 0 && sweep4.results.length === 1 && sweep4.results[0].ok === true && d4b.ledger_status === "posted",
    `sweep3=${sweep3.results.length} sweep4=${sweep4.results.length} d4=${d4b.ledger_status}`);

  // module-level injection via setCreditLedger
  const modLedger = mkLedger({});
  C.setCreditLedger(modLedger);
  const r9 = await C.settleJobCost(s, `${TAG}-d9`, { userId: u, runtimeMs: 60_000 });
  check("D9: module-level setCreditLedger injection works (per-call still wins)",
    r9.settled === true && modLedger.debits.length === 1, `debits=${modLedger.debits.length}`);
  C.setCreditLedger(null);

  // postUnsettledCosts without any ledger → clean error, not a silent no-op
  let noLg = null;
  try { await C.postUnsettledCosts({}); } catch (e) { noLg = e; }
  check("D10: postUnsettledCosts without a ledger refuses cleanly", !!noLg && /no credit ledger configured/.test(noLg.message), noLg?.message || "no error");
}

// ============================================================
section("E. scope isolation");
{
  // env-default baseline (A's global rows would change the org's slot/byte rates)
  await query("DELETE FROM compute_cost_rates WHERE scope_type = 'global'");
  const uA = await mkUser("isoA");
  const uB = await mkUser("isoB");
  const owner = await mkUser("isoOwner");
  const org = await mkOrg("iso", owner);
  await mkMembership(org, uA);
  await mkMembership(org, uB);

  await C.setRate(orgScope(org), "runtime_minute", 0.1);
  const ledger = mkLedger({});

  // member A's personal job
  await C.settleJobCost(userScope(uA), `${TAG}-eA`, { userId: uA, runtimeMs: 2 * 60_000, browserSlots: 1, artifactBytes: 0, ledger });
  // both members' ORG jobs land in the one org pool
  await C.settleJobCost(orgScope(org), `${TAG}-eO1`, { userId: uA, runtimeMs: 3 * 60_000, browserSlots: 0, artifactBytes: 0, ledger });
  await C.settleJobCost(orgScope(org), `${TAG}-eO2`, { userId: uB, runtimeMs: 4 * 60_000, browserSlots: 2, artifactBytes: 100, ledger });

  const sumA = await C.costSummary(userScope(uA));
  const sumB = await C.costSummary(userScope(uB));
  const sumOrg = await C.costSummary(orgScope(org));
  // eA personal: 2min × env 0.01 + 1 slot × env 0.005 = 0.025
  check("E1: personal pools isolated — A has its job (0.025), B is empty",
    sumA.jobs === 1 && r6(sumA.costTotal) === 0.025 && sumB.jobs === 0 && sumB.costTotal === 0,
    `A=${JSON.stringify({ jobs: sumA.jobs, total: sumA.costTotal })} B=${JSON.stringify({ jobs: sumB.jobs, total: sumB.costTotal })}`);
  // org: eO1 = 3min × 0.1 = 0.3; eO2 = 4min × 0.1 + 2 slots × 0.005 + 100 B × 1e-8 = 0.410001
  check("E2: org pool aggregates BOTH members' jobs (2 jobs, 0.710001 credits)",
    sumOrg.jobs === 2 && r6(sumOrg.costTotal) === r6(0.3 + 0.4 + 2 * 0.005 + 100 * 0.00000001),
    JSON.stringify({ jobs: sumOrg.jobs, total: sumOrg.costTotal }));

  // per-scope rate override affects only that scope
  const rateA = await C.resolveRates(userScope(uA));
  const rateOrg = await C.resolveRates(orgScope(org));
  check("E3: scope rate overrides do not leak (A=0.01 env, org=0.1 override)",
    rateA.runtime_minute === 0.01 && rateOrg.runtime_minute === 0.1,
    `A=${rateA.runtime_minute} org=${rateOrg.runtime_minute}`);

  check("E4: getJobCost unknown task → null", (await C.getJobCost(userScope(uB), `${TAG}-never`)) === null, "");
  const got = await C.getJobCost(orgScope(org), `${TAG}-eO1`);
  check("E5: getJobCost returns the settled record with numeric fields",
    got && got.task_key === `${TAG}-eO1` && got.cost_total === 0.3 && got.ledger_status === "posted",
    JSON.stringify({ cost: got?.cost_total, status: got?.ledger_status }));

  // date-bounded summary excludes rows outside the window
  const future = await C.costSummary(orgScope(org), { from: new Date(Date.now() + 60_000).toISOString() });
  check("E6: date-bounded summary (from: future) excludes settled rows", future.jobs === 0 && future.costTotal === 0, JSON.stringify({ jobs: future.jobs }));
}

// ============================================================
const fails = results.filter((r) => !r).length;
console.log(`\nRESULT: ${fails ? "FAIL" : "PASS"}  (${results.length - fails}/${results.length} checks passed)`);
await cleanup();
await closePool();
process.exit(fails ? 1 : 0);
