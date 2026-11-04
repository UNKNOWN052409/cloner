// Per-job compute accounting + cost model (task 4.2.12).
//
// Surface:
//   DEFAULT_RATES / RATE_KEYS / resolveRates(scope)
//                                             — env-configurable unit rates,
//                                               scope > global > env precedence,
//                                               one currency per scope
//   setRate(scope, rateKey, value)            — per-scope (or 'global') override;
//                                               value null clears the override
//   computeCost(quantities, rates)            — PURE cost model (no DB):
//                                                 runtimeMinutes = ceil(ms/60000)
//                                                 cost = round6(minutes × rate)
//                                                      + round6(slots  × rate)
//                                                      + round6(bytes  × rate)
//                                               round6(x) = round(x×1e6)/1e6 —
//                                               every stored number is exact at
//                                               6 decimals, never float dust
//   previewCost(scope, quantities)            — resolveRates + computeCost
//   settleJobCost(scope, taskKey, opts)       — ONE settlement per (scope, job),
//                                               advisory-lock + unique index
//                                               idempotent; computes cost, writes
//                                               compute_job_costs with a
//                                               rates_snapshot, then debits the
//                                               injected credit ledger
//   postUnsettledCosts({ ledger, ... })       — retry sweep for unposted/failed/
//                                               (optional) rejected rows
//   getJobCost(scope, taskKey) / costSummary(scope, { from, to })
//   setCreditLedger(ledger)                   — module-level ledger injection;
//                                               a per-call `ledger` option wins
//
// Credit ledger (INJECTED INTERFACE — this module never hard-codes one): the
// platform's real credit ledger (src/platform/credit-ledger.js) is GRANT-ONLY
// (free platform — no spend gate, no debit interface), so settlements stay
// 'unposted' until the orchestrator injects a debit-capable ledger; tests
// inject a mock — the ONLY mock allowed is on the test side:
//
//   ledger.debit({ scopeType, scopeId, userId, taskKey, amount, currency,
//                  reason: 'compute', breakdown, meta })
//     → Promise<{ ref?: string, ... } | string | void>
//     throws on refusal; insufficient credit is signalled by EITHER
//     error.name === 'InsufficientCreditsError' OR
//     error.code  === 'INSUFFICIENT_CREDITS' (→ row status 'rejected');
//     any other throw (→ row status 'failed').
//     DEBIT MUST BE IDEMPOTENT PER taskKey (a retry after a crash must not
//     double-charge) — the sweep re-posts only rows whose DB status is not
//     'posted', and the ledger dedupes as the second line of defense.
//
// Settlement failure policy: cost computation + the compute_job_costs row are
// the source of truth and NEVER fail because a ledger is absent; an absent
// ledger records status 'unposted' and settleJobCost returns
// { settled: false, reason: 'ledger_not_configured', record } — a later
// postUnsettledCosts() sweep posts it. A REFUSED debit throws
// LedgerSettlementError after marking the row ('rejected'/'failed') so callers
// observe the failure; the row stays retryable.
//
// Integration point (no router in this task): the job completion path calls
//   await settleJobCost(scopeForTask(task), taskKey, { userId, runtimeMs,
//     browserSlots, artifactBytes })   // ledger injected via setCreditLedger
// after quota-service.releaseReservation().
import { query, withTransaction } from "../database/client.js";

// ---------- rates (env-configurable; compute_cost_rates rows override) ----------

export const DEFAULT_RATES = {
  runtime_minute: () => envRate("COMPUTE_RATE_RUNTIME_MINUTE", 0.01),
  browser_slot: () => envRate("COMPUTE_RATE_BROWSER_SLOT", 0.005),
  artifact_byte: () => envRate("COMPUTE_RATE_ARTIFACT_BYTE", 0.00000001),
};

export const RATE_KEYS = Object.keys(DEFAULT_RATES);

export const GLOBAL_SCOPE = { scope_type: "global", scope_id: "00000000-0000-0000-0000-000000000000" };

const DEFAULT_CURRENCY = () => (process.env.COMPUTE_CURRENCY || "credits").trim() || "credits";

// Garbage env values (NaN/negative) fall back to the coded default so a typo
// cannot silently zero out a rate (mirrors quota-service envLimit).
function envRate(envKey, fallback) {
  const v = Number(process.env[envKey]);
  return Number.isFinite(v) && v >= 0 ? v : fallback;
}

function envDefault(key) {
  const fn = DEFAULT_RATES[key];
  if (!fn) throw new Error(`unknown rate key: ${key}`);
  return fn();
}

// Precisely the three keys, non-negative finite numbers, one currency.
export function validateRates(obj) {
  const out = {};
  for (const key of RATE_KEYS) {
    const v = Number(obj?.[key]);
    if (!Number.isFinite(v) || v < 0) throw new Error(`invalid rate ${key}: ${String(obj?.[key])} (must be a non-negative finite number)`);
    out[key] = v;
  }
  const currency = String(obj?.currency || DEFAULT_CURRENCY()).trim() || "credits";
  out.currency = currency;
  return out;
}

// Precedence: per-scope row > platform 'global' row > env default. Currency:
// the first explicit currency found (scope rows first, then global, then env);
// all explicit rows of a scope must agree or this throws (config error).
// NOTE: inside an open transaction ALWAYS use resolveRatesOn(client, scope) —
// the pool has max 10 clients and a transaction that waits on another pool
// client while holding one deadlocks under load (found by the G5.4 hunt:
// 10 parallel settleJobCost calls hung the pool — same bug class
// quota-service.js documents for resolveLimitsOn).
export async function resolveRates(scope) {
  return resolveRatesOn(null, scope);
}

async function resolveRatesOn(client, scope) {
  const run = client ? (sql, params) => client.query(sql, params) : query;
  const rows = (
    await run(
      `SELECT scope_type, rate_key, rate_value, currency FROM compute_cost_rates
       WHERE (scope_type = 'global')
          OR (scope_type = $1 AND scope_id = $2)`,
      [scope.scope_type, scope.scope_id]
    )
  ).rows;
  const scoped = rows.filter((r) => r.scope_type === scope.scope_type);
  const global = rows.filter((r) => r.scope_type === "global");

  const rates = {};
  const sources = {};
  const contributing = []; // only rows whose rate is actually in effect
  for (const key of RATE_KEYS) {
    const s = scoped.find((r) => r.rate_key === key);
    if (s) {
      rates[key] = Number(s.rate_value);
      sources[key] = "scope";
      contributing.push(s);
    } else {
      const g = global.find((r) => r.rate_key === key);
      if (g) {
        rates[key] = Number(g.rate_value);
        sources[key] = "global";
        contributing.push(g);
      } else {
        rates[key] = envDefault(key);
        sources[key] = "env";
      }
    }
  }
  // Currency must agree across the rows that CONTRIBUTE a rate (a shadowed
  // row — e.g. a global row fully overridden by scope rows — is irrelevant).
  const currencies = contributing.map((r) => String(r.currency || "").trim()).filter(Boolean);
  if (new Set(currencies).size > 1) {
    throw new Error(`compute_cost_rates currency mismatch for scope ${scope.scope_type}:${scope.scope_id} — found ${[...new Set(currencies)].join(", ")}`);
  }
  rates.currency = currencies[0] || DEFAULT_CURRENCY();
  rates.sources = sources;
  return rates;
}

// value: non-negative number sets/updates the override; null clears it.
// scope may be a normal scope or the GLOBAL_SCOPE sentinel.
export async function setRate(scope, rateKey, value) {
  if (!RATE_KEYS.includes(rateKey)) throw new Error(`unknown rate key: ${rateKey}`);
  const global = scope.scope_type === "global";
  const scopeId = global ? GLOBAL_SCOPE.scope_id : String(scope.scope_id);
  if (!global && !/^[0-9a-f-]{36}$/i.test(scopeId)) throw new Error(`setRate: invalid scope_id ${scopeId}`);
  if (value === null) {
    await query(
      "DELETE FROM compute_cost_rates WHERE scope_type = $1 AND scope_id = $2 AND rate_key = $3",
      [scope.scope_type, scopeId, rateKey]
    );
    return;
  }
  const v = Number(value);
  if (!Number.isFinite(v) || v < 0) throw new Error("rate value must be a non-negative finite number or null (clear override)");
  await query(
    `INSERT INTO compute_cost_rates (scope_type, scope_id, rate_key, rate_value, currency)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (scope_type, scope_id, rate_key)
     DO UPDATE SET rate_value = EXCLUDED.rate_value, currency = EXCLUDED.currency, updated_at = now()`,
    [scope.scope_type, scopeId, rateKey, v, DEFAULT_CURRENCY()]
  );
}

// ---------- cost model (pure — the documented spec) ----------

// round6: the storage rule. Every published cost number is exact at 6 decimal
// places; floats never leak (0.02×3 → 0.060000000000000005 → 0.06).
export function round6(x) {
  return Math.round(Number(x) * 1e6) / 1e6;
}

// Runtime is billed per STARTED minute: ceil(ms/60000); 0 ms bills 0 minutes.
export function runtimeMinutesOf(runtimeMs) {
  const ms = requireNonNegativeInt(runtimeMs, "runtimeMs");
  return Math.ceil(ms / 60000);
}

function requireNonNegativeInt(v, name) {
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) throw new Error(`${name} must be a non-negative finite number, got ${String(v)}`);
  return Math.round(n);
}

// quantities: { runtimeMs, browserSlots, artifactBytes } (ms/bytes may be
// fractional — rounded to the integer unit; slots must be a whole count).
// rates: { runtime_minute, browser_slot, artifact_byte } (+ optional currency).
export function computeCost(quantities, rates) {
  const runtimeMs = requireNonNegativeInt(quantities?.runtimeMs ?? 0, "runtimeMs");
  const browserSlots = requireNonNegativeInt(quantities?.browserSlots ?? 0, "browserSlots");
  const artifactBytes = requireNonNegativeInt(quantities?.artifactBytes ?? 0, "artifactBytes");
  const r = validateRates(rates);
  const runtimeMinutes = Math.ceil(runtimeMs / 60000);
  const costRuntime = round6(runtimeMinutes * r.runtime_minute);
  const costSlots = round6(browserSlots * r.browser_slot);
  const costBytes = round6(artifactBytes * r.artifact_byte);
  const costTotal = round6(costRuntime + costSlots + costBytes);
  return {
    runtimeMs,
    runtimeMinutes,
    browserSlots,
    artifactBytes,
    costRuntime,
    costSlots,
    costBytes,
    costTotal,
    currency: r.currency,
  };
}

export async function previewCost(scope, quantities) {
  const rates = await resolveRates(scope);
  return { rates, cost: computeCost(quantities, rates) };
}

// ---------- ledger injection (interface only — never mocked here) ----------

let creditLedger = null;
export function setCreditLedger(ledger) {
  creditLedger = ledger || null;
}
function ledgerFor(optsLedger) {
  return optsLedger || creditLedger;
}

export class LedgerSettlementError extends Error {
  constructor(message, detail = {}) {
    super(message);
    this.name = "LedgerSettlementError";
    this.status = detail.status; // 'rejected' | 'failed'
    this.cause = detail.cause;
    this.taskKey = detail.taskKey ?? null;
    this.record = detail.record ?? null;
  }
}

export function isInsufficientCreditsError(e) {
  return e && (e.name === "InsufficientCreditsError" || e.code === "INSUFFICIENT_CREDITS");
}

function ledgerRefOf(result) {
  if (result == null) return null;
  if (typeof result === "string") return result;
  if (typeof result === "object") {
    for (const k of ["ref", "id", "debitId", "reference", "transactionId"]) {
      if (typeof result[k] === "string" && result[k]) return result[k];
      if (typeof result[k] === "number") return String(result[k]);
    }
  }
  return null;
}

// 64-bit advisory key over "type:id:taskKey" under a "COST" prefix — distinct
// from quota-service's "QUOT" namespace; stable across processes. BigInt
// end-to-end (the fold exceeds Number's 2^53 safe range).
function advisoryJobKey(scope, taskKey) {
  const s = `${scope.scope_type}:${scope.scope_id}:${taskKey}`;
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  const BASE = 0x434f5354n * 0x100000000n; // 'COST' — fits int8 (max 9.22e18)
  return BASE + BigInt(h);
}

async function lockJobKeyOn(client, scope, taskKey) {
  await client.query("SELECT pg_advisory_xact_lock($1)", [advisoryJobKey(scope, taskKey)]);
}

// ---------- settlement ----------

// Settle one job's compute cost. Idempotent per (scope, taskKey):
//   - an existing 'posted' row is returned untouched (no second debit),
//   - an existing unsettled row only retries the ledger posting (cost/rates
//     snapshot are NOT recomputed — the original settlement stands),
//   - a fresh row is computed from the CURRENT rates and inserted atomically.
//
// opts: { userId, runtimeMs, browserSlots, artifactBytes, ledger, meta }
// Returns { settled, reused?, reason?, record, debit? } — `settled:false` only
// when no ledger is configured (reason 'ledger_not_configured') or when the
// debit is refused (throws LedgerSettlementError instead — see class above).
export async function settleJobCost(scope, taskKey, {
  userId = null,
  runtimeMs = 0,
  browserSlots = 0,
  artifactBytes = 0,
  ledger,
  meta = {},
} = {}) {
  if (!taskKey || typeof taskKey !== "string") throw new Error("settleJobCost: taskKey is required");
  if (scope?.scope_type !== "user" && scope?.scope_type !== "org") {
    throw new Error(`settleJobCost: scope must be 'user' or 'org', got ${String(scope?.scope_type)}`);
  }

  // Validate quantities up-front so a bad call writes nothing.
  requireNonNegativeInt(runtimeMs, "runtimeMs");
  requireNonNegativeInt(browserSlots, "browserSlots");
  requireNonNegativeInt(artifactBytes, "artifactBytes");

  // Step 1: compute + persist the cost record (idempotent under the job lock).
  const record = await withTransaction(async (client) => {
    await lockJobKeyOn(client, scope, taskKey);
    const existing = await client.query(
      `SELECT * FROM compute_job_costs WHERE scope_type = $1 AND scope_id = $2 AND task_key = $3`,
      [scope.scope_type, scope.scope_id, taskKey]
    );
    if (existing.rows.length) return existing.rows[0];

    // client-aware read: NEVER touch the pool while holding this transaction's
    // client (10 parallel settles would deadlock — see resolveRatesOn note).
    const rates = await resolveRatesOn(client, scope);
    const cost = computeCost({ runtimeMs, browserSlots, artifactBytes }, rates);
    const ins = await client.query(
      `INSERT INTO compute_job_costs
         (task_key, scope_type, scope_id, user_id, runtime_ms, runtime_minutes,
          browser_slots, artifact_bytes, cost_runtime, cost_slots, cost_bytes,
          cost_total, currency, rates_snapshot, meta)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
       RETURNING *`,
      [
        taskKey, scope.scope_type, scope.scope_id, userId || null,
        cost.runtimeMs, cost.runtimeMinutes, cost.browserSlots, cost.artifactBytes,
        cost.costRuntime, cost.costSlots, cost.costBytes, cost.costTotal,
        cost.currency,
        JSON.stringify({
          runtime_minute: rates.runtime_minute,
          browser_slot: rates.browser_slot,
          artifact_byte: rates.artifact_byte,
          currency: rates.currency,
          sources: rates.sources,
        }),
        JSON.stringify(meta ?? {}),
      ]
    );
    return ins.rows[0];
  });

  // Step 2: settle against the credit ledger (only when still unsettled).
  const lg = ledgerFor(ledger);
  if (!lg) return { settled: false, reason: "ledger_not_configured", record: rowOut(record) };
  if (record.ledger_status === "posted") {
    return { settled: true, reused: true, record: rowOut(record), debit: null };
  }

  // G5.4 hardening: serialize the SETTLEMENT phase too. Step 1's transaction
  // (and its advisory lock) ends before the debit, so N concurrent settles can
  // all observe 'unposted' and each call ledger.debit — with a NON-idempotent
  // ledger that is a double charge (found by the G5.4 hunt: 10 parallel
  // settles produced 2 debit calls for one job). A SESSION-scoped advisory
  // lock over the same 64-bit job key is held across re-check → debit → mark.
  // It must NOT be a transaction lock: the debit is an external side effect
  // that stays outside any DB transaction (outbox pattern — a crash between
  // debit and mark is healed by the ledger's per-taskKey idempotency + the
  // sweep). Session and xact advisory locks share one lock space, so this also
  // serializes against postUnsettledCosts()'s xact lock.
  //
  // POOL-CRITICAL (G5.4, second half of the same hang): the other N-1 settles
  // are parked inside Step-1 transactions, each holding a pool client. Every
  // query in this phase MUST run on the dedicated lockClient — a pool query()
  // here waits for a client that this very call is pinning (deadlock observed:
  // 10 parallel settles hung the pool). markPosted/updatedRow therefore get
  // client-aware variants and markPostedOn/updatedRowOn run on lockClient.
  const { getPool } = await import("../database/client.js");
  const lockClient = await getPool().connect();
  const jobKey = advisoryJobKey(scope, taskKey);
  try {
    await lockClient.query("SELECT pg_advisory_lock($1)", [jobKey]);
    // re-read under the lock: another settle may have posted while we waited
    const cur = await lockClient.query(
      `SELECT * FROM compute_job_costs WHERE scope_type = $1 AND scope_id = $2 AND task_key = $3`,
      [scope.scope_type, scope.scope_id, taskKey]
    );
    if (cur.rows[0]?.ledger_status === "posted") {
      return { settled: true, reused: true, record: rowOut(cur.rows[0]), debit: null };
    }
    const latest = cur.rows[0] ?? record;

    const amount = Number(latest.cost_total);
    // On a retry the row's own stored meta is authoritative (original context).
    const posted = await debitRow(lg, scope, latest, userId, latest.meta ?? meta);
    if (posted.ok) {
      const r = await lockClient.query(
        `UPDATE compute_job_costs SET ledger_status = 'posted', ledger_ref = $2, ledger_error = NULL, settled_at = now(), updated_at = now() WHERE id = $1 RETURNING *`,
        [latest.id, posted.ref]
      );
      return { settled: true, reused: false, record: rowOut(r.rows[0]), debit: { ref: posted.ref, amount } };
    }
    // Refused: the row keeps the computed cost with a terminal-ish status;
    // postUnsettledCosts can retry later (top-up / transient outage fixed).
    const fr = await lockClient.query(
      `UPDATE compute_job_costs SET ledger_status = $2, ledger_error = $3, updated_at = now() WHERE id = $1 RETURNING *`,
      [latest.id, posted.status, posted.error]
    );
    const failedRecord = rowOut(fr.rows[0]);
    throw new LedgerSettlementError(`credit ledger debit failed for ${taskKey}: ${posted.error}`, {
      status: posted.status,
      cause: posted.cause,
      taskKey,
      record: failedRecord,
    });
  } finally {
    await lockClient.query("SELECT pg_advisory_unlock($1)", [jobKey]).catch(() => {});
    lockClient.release();
  }
}

// Sweep-retry unsettled rows. Claims each row under its job advisory lock and
// re-checks the status inside the lock, so concurrent sweeps never double-post
// (plus the ledger contract itself is idempotent per taskKey).
export async function postUnsettledCosts({
  ledger,
  scope = null,
  limit = 100,
  includeRejected = false,
} = {}) {
  const lg = ledgerFor(ledger);
  if (!lg) throw new Error("postUnsettledCosts: no credit ledger configured (pass { ledger } or setCreditLedger first)");
  const statuses = includeRejected ? ["unposted", "failed", "rejected"] : ["unposted", "failed"];
  const candidates = (
    await query(
      `SELECT * FROM compute_job_costs
       WHERE ledger_status = ANY($1)
         AND (${scope ? "scope_type = $2 AND scope_id = $3" : "TRUE"})
       ORDER BY created_at
       LIMIT $4`,
      scope ? [statuses, scope.scope_type, scope.scope_id, Math.max(1, Math.floor(limit))] : [statuses, Math.max(1, Math.floor(limit))]
    )
  ).rows;

  const results = [];
  for (const row of candidates) {
    const rowScope = { scope_type: row.scope_type, scope_id: row.scope_id };
    try {
      const outcome = await withTransaction(async (client) => {
        await lockJobKeyOn(client, rowScope, row.task_key);
        const cur = await client.query(
          "SELECT * FROM compute_job_costs WHERE id = $1 FOR UPDATE",
          [row.id]
        );
        if (!cur.rows.length || cur.rows[0].ledger_status === "posted") return { skipped: true, id: row.id };
        // debit AFTER claiming (row locked); a crash between debit and commit
        // replays the same debit — the ledger dedupes by taskKey (contract).
        const posted = await debitRow(lg, rowScope, cur.rows[0], cur.rows[0].user_id, cur.rows[0].meta ?? {});
        if (!posted.ok) {
          await client.query(
            `UPDATE compute_job_costs SET ledger_status = $2, ledger_error = $3, updated_at = now() WHERE id = $1`,
            [row.id, posted.status, posted.error]
          );
          return { id: row.id, ok: false, status: posted.status, error: posted.error };
        }
        await client.query(
          `UPDATE compute_job_costs SET ledger_status = 'posted', ledger_ref = $2, ledger_error = NULL, settled_at = now(), updated_at = now() WHERE id = $1`,
          [row.id, posted.ref]
        );
        return { id: row.id, ok: true, ref: posted.ref, amount: Number(cur.rows[0].cost_total) };
      });
      results.push(outcome);
    } catch (e) {
      results.push({ id: row.id, ok: false, error: String(e?.message || e) });
    }
  }
  return { attempted: candidates.length, results };
}

async function debitRow(lg, scope, record, userId, meta) {
  const req = {
    scopeType: scope.scope_type,
    scopeId: scope.scope_id,
    userId: userId ?? null,
    taskKey: record.task_key,
    amount: Number(record.cost_total),
    currency: record.currency,
    reason: "compute",
    breakdown: {
      runtimeMinutes: Number(record.runtime_minutes),
      browserSlots: Number(record.browser_slots),
      artifactBytes: Number(record.artifact_bytes),
    },
    meta: meta ?? {},
  };
  try {
    const res = await lg.debit(req);
    return { ok: true, ref: ledgerRefOf(res) };
  } catch (e) {
    return {
      ok: false,
      status: isInsufficientCreditsError(e) ? "rejected" : "failed",
      error: String(e?.message || e).slice(0, 500),
      cause: e,
    };
  }
}

async function markPosted(id, ref) {
  const r = await query(
    `UPDATE compute_job_costs SET ledger_status = 'posted', ledger_ref = $2, ledger_error = NULL, settled_at = now(), updated_at = now() WHERE id = $1 RETURNING *`,
    [id, ref]
  );
  return rowOut(r.rows[0]);
}

function updatedRow(id, status, error) {
  // Best-effort synchronous status write so the thrown error's .record
  // reflects reality; the caller re-reading getJobCost sees the same state.
  return query(
    `UPDATE compute_job_costs SET ledger_status = $2, ledger_error = $3, updated_at = now() WHERE id = $1 RETURNING *`,
    [id, status, error]
  ).then((r) => rowOut(r.rows[0]));
}

// ---------- reads ----------

function rowOut(row) {
  if (!row) return null;
  return {
    ...row,
    runtime_ms: Number(row.runtime_ms),
    runtime_minutes: Number(row.runtime_minutes),
    browser_slots: Number(row.browser_slots),
    artifact_bytes: Number(row.artifact_bytes),
    cost_runtime: Number(row.cost_runtime),
    cost_slots: Number(row.cost_slots),
    cost_bytes: Number(row.cost_bytes),
    cost_total: Number(row.cost_total),
  };
}

export async function getJobCost(scope, taskKey) {
  const r = await query(
    "SELECT * FROM compute_job_costs WHERE scope_type = $1 AND scope_id = $2 AND task_key = $3",
    [scope.scope_type, scope.scope_id, taskKey]
  );
  return rowOut(r.rows[0] || null);
}

// Scope cost summary, optionally bounded by settlement creation time (ISO).
export async function costSummary(scope, { from, to } = {}) {
  const conds = ["scope_type = $1", "scope_id = $2"];
  const params = [scope.scope_type, scope.scope_id];
  if (from) { params.push(new Date(from)); conds.push(`created_at >= $${params.length}`); }
  if (to) { params.push(new Date(to)); conds.push(`created_at <= $${params.length}`); }
  const r = await query(
    `SELECT
       count(*)::int AS jobs,
       coalesce(sum(runtime_ms), 0)::bigint AS runtime_ms,
       coalesce(sum(runtime_minutes), 0)::int AS runtime_minutes,
       coalesce(sum(browser_slots), 0)::int AS browser_slots,
       coalesce(sum(artifact_bytes), 0)::bigint AS artifact_bytes,
       coalesce(sum(cost_runtime), 0) AS cost_runtime,
       coalesce(sum(cost_slots), 0) AS cost_slots,
       coalesce(sum(cost_bytes), 0) AS cost_bytes,
       coalesce(sum(cost_total), 0) AS cost_total,
       min(currency) AS currency,
       count(*) FILTER (WHERE ledger_status = 'posted')::int AS posted,
       count(*) FILTER (WHERE ledger_status = 'unposted')::int AS unposted,
       count(*) FILTER (WHERE ledger_status = 'rejected')::int AS rejected,
       count(*) FILTER (WHERE ledger_status = 'failed')::int AS failed
     FROM compute_job_costs WHERE ${conds.join(" AND ")}`,
    params
  );
  const row = r.rows[0];
  return {
    scope: { type: scope.scope_type, id: scope.scope_id },
    jobs: Number(row.jobs),
    runtimeMs: Number(row.runtime_ms),
    runtimeMinutes: Number(row.runtime_minutes),
    browserSlots: Number(row.browser_slots),
    artifactBytes: Number(row.artifact_bytes),
    costRuntime: Number(row.cost_runtime),
    costSlots: Number(row.cost_slots),
    costBytes: Number(row.cost_bytes),
    costTotal: Number(row.cost_total),
    currency: row.currency,
    byStatus: {
      posted: Number(row.posted),
      unposted: Number(row.unposted),
      rejected: Number(row.rejected),
      failed: Number(row.failed),
    },
  };
}
