// Resource quotas + usage accounting (task 4.0.4).
//
// Surface:
//   DEFAULT_LIMITS / resolveLimits(scope)     — env-configurable, no hard-coded
//                                               commercial tiers (plan step 9)
//   resolveScope({ userId, orgId })           — personal vs organization pool
//   checkQuota(scope, { estimatedBytes, explorationMinutes })
//                                             — read-only preflight, typed reason
//   reserveJobSlot(scope, taskKey, opts)      — ATOMIC reservation of one
//                                               execution slot (plan step 6):
//                                               pg_advisory_xact_lock +
//                                               INSERT + capacity check inside
//                                               one transaction, so concurrent
//                                               submissions cannot race past the
//                                               limit (plan step 7)
//   queueReservation(...) / promoteReservation(...)
//                                             — queued→running split so the
//                                               queued-jobs limit is distinct
//   releaseReservation(scope, taskKey, { reason, outcome, explorationMs })
//                                             — release + accounting (started/
//                                               retry/completed/failed/cancelled
//                                               + exploration_ms, plan step 5)
//   reclaimStaleReservations({ maxAgeMs })    — worker-crash reconciliation
//                                               (plan risk note)
//   getUsage(scope) / usageSummary()          — usage + limits + reasons (API)
//   reconcileDailyFromLedger(scope)           — rebuild materialized counters
//                                               from the append-only ledger
//   setQuotaLimit / getQuotaLimit             — per-scope overrides
//
// Storage accounting: consume the computeUsage(root) export from 4.0.5
// (src/storage/artifact-lifecycle.js) via an INJECTED interface — injectable
// meter, with the real import as the default so the dependency is real but
// tests can mock it without touching the filesystem.
import { query, withTransaction } from "../database/client.js";

// ---------- limits (env-configurable; NULL quota_limits value = unlimited) ----------

export const DEFAULT_LIMITS = {
  max_concurrent_jobs: () => Number(process.env.QUOTA_MAX_CONCURRENT_JOBS ?? 2),
  max_queued_jobs: () => Number(process.env.QUOTA_MAX_QUEUED_JOBS ?? 10),
  max_jobs_per_day: () => Number(process.env.QUOTA_MAX_JOBS_PER_DAY ?? 50),
  max_artifact_bytes: () => Number(process.env.QUOTA_MAX_ARTIFACT_BYTES ?? 5 * 1024 * 1024 * 1024),
  max_exploration_minutes_per_day: () => Number(process.env.QUOTA_MAX_EXPLORATION_MINUTES_PER_DAY ?? 120),
};

export const LIMIT_KEYS = Object.keys(DEFAULT_LIMITS);

export const LIMIT_REASONS = {
  max_concurrent_jobs: "concurrent_job_limit",
  max_queued_jobs: "queued_job_limit",
  max_jobs_per_day: "daily_job_limit",
  max_artifact_bytes: "storage_limit",
  max_exploration_minutes_per_day: "exploration_time_limit",
};

function envLimit(key) {
  const fn = DEFAULT_LIMITS[key];
  if (!fn) throw new Error(`unknown limit key: ${key}`);
  return fn();
}

// DB override wins; a NULL override value means "unlimited"; otherwise fall
// back to the env default. Unknown env values (NaN/garbage) fall back to the
// coded default so a typo cannot silently disable a quota.
// NOTE: inside an open transaction ALWAYS use resolveLimitsOn(client, scope) —
// the pool has max 10 clients and a transaction that waits on another pool
// client while holding one deadlocks under load (found by the race test).
export async function resolveLimits(scope) {
  return resolveLimitsOn(null, scope);
}

async function resolveLimitsOn(client, scope) {
  const run = client ? (sql, params) => client.query(sql, params) : query;
  const rows = (await run(
    "SELECT limit_key, limit_value FROM quota_limits WHERE scope_type = $1 AND scope_id = $2",
    [scope.scope_type, scope.scope_id]
  )).rows;
  const overrides = new Map(rows.map((r) => [r.limit_key, r.limit_value]));
  const limits = {};
  for (const key of LIMIT_KEYS) {
    if (overrides.has(key)) {
      const v = overrides.get(key);
      limits[key] = v === null ? null : Number(v);
    } else {
      const env = envLimit(key);
      limits[key] = Number.isFinite(env) && env > 0 ? env : null;
    }
  }
  return limits;
}

export async function setQuotaLimit(scope, limitKey, value) {
  if (!LIMIT_KEYS.includes(limitKey)) throw new Error(`unknown limit key: ${limitKey}`);
  if (value !== null && !(Number(value) > 0)) throw new Error("limit value must be a positive number or null (unlimited)");
  await query(
    `INSERT INTO quota_limits (scope_type, scope_id, limit_key, limit_value)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (scope_type, scope_id, limit_key)
     DO UPDATE SET limit_value = EXCLUDED.limit_value, updated_at = now()`,
    [scope.scope_type, scope.scope_id, limitKey, value]
  );
}

export async function getQuotaLimit(scope, limitKey) {
  const r = await query(
    "SELECT limit_value FROM quota_limits WHERE scope_type = $1 AND scope_id = $2 AND limit_key = $3",
    [scope.scope_type, scope.scope_id, limitKey]
  );
  if (!r.rows.length) return { key: limitKey, overridden: false, value: envLimit(limitKey) };
  const v = r.rows[0].limit_value;
  return { key: limitKey, overridden: true, value: v === null ? null : Number(v) };
}

// ---------- scope resolution ----------

// scope_type 'org' → one shared pool across all members (the org's tasks,
// storage and minutes are pooled); 'user' → the personal workspace.
export function resolveScope({ userId, orgId } = {}) {
  if (!userId) throw new Error("resolveScope: userId is required");
  if (orgId) return { scope_type: "org", scope_id: String(orgId), userId };
  return { scope_type: "user", scope_id: String(userId), userId };
}

// Effective scope for a task: org task → org pool; otherwise personal.
export function scopeForTask(task) {
  return resolveScope({ userId: task?.user_id, orgId: task?.org_id });
}

// ---------- day bucket (UTC) ----------

const utcDay = (d = new Date()) => d.toISOString().slice(0, 10);

// ---------- typed rejection reasons (middleware maps these to HTTP codes) ----------

export class QuotaExceededError extends Error {
  constructor(reason, detail = {}) {
    super(`quota exceeded: ${reason}`);
    this.name = "QuotaExceededError";
    this.reason = reason;      // one of LIMIT_REASONS values
    this.limit = detail.limit ?? null;
    this.used = detail.used ?? null;
    this.requested = detail.requested ?? null;
    this.scope = detail.scope ?? null;
  }
}

// ---------- usage reads ----------

async function dailyRow(scope, day = utcDay()) {
  return dailyRowOn(null, scope, day);
}

async function dailyRowOn(client, scope, day = utcDay()) {
  const run = client ? (sql, params) => client.query(sql, params) : query;
  const r = await run(
    `SELECT jobs_started, jobs_completed, jobs_failed, jobs_cancelled, retries, exploration_ms
     FROM quota_usage_daily WHERE scope_type = $1 AND scope_id = $2 AND day = $3`,
    [scope.scope_type, scope.scope_id, day]
  );
  return r.rows[0] || { jobs_started: 0, jobs_completed: 0, jobs_failed: 0, jobs_cancelled: 0, retries: 0, exploration_ms: 0 };
}

async function liveReservations(scope) {
  const r = await query(
    `SELECT state, count(*)::int AS n FROM quota_reservations
     WHERE scope_type = $1 AND scope_id = $2 AND released_at IS NULL
     GROUP BY state`,
    [scope.scope_type, scope.scope_id]
  );
  const out = { running: 0, queued: 0 };
  for (const row of r.rows) out[row.state] = Number(row.n);
  return out;
}

// Read-only preflight used by the middleware BEFORE queueing. Throws
// QuotaExceededError with a typed reason; returns the current snapshot.
export async function checkQuota(scope, { estimatedBytes = 0, explorationMinutes = 0 } = {}) {
  const [limits, res, daily] = await Promise.all([
    resolveLimits(scope),
    liveReservations(scope),
    dailyRow(scope),
  ]);

  const reasons = [];
  const reject = (reason, limit, used, requested) =>
    reasons.push({ reason, limit, used, requested });

  const cLimit = limits.max_concurrent_jobs;
  if (cLimit !== null && res.running >= cLimit) reject(LIMIT_REASONS.max_concurrent_jobs, cLimit, res.running, 1);
  const qLimit = limits.max_queued_jobs;
  if (qLimit !== null && res.queued >= qLimit) reject(LIMIT_REASONS.max_queued_jobs, qLimit, res.queued, 1);
  const jLimit = limits.max_jobs_per_day;
  if (jLimit !== null && daily.jobs_started >= jLimit) reject(LIMIT_REASONS.max_jobs_per_day, jLimit, daily.jobs_started, 1);
  const bLimit = limits.max_artifact_bytes;
  if (bLimit !== null) {
    const used = await storageBytesUsed(scope);
    if (used + estimatedBytes > bLimit) reject(LIMIT_REASONS.max_artifact_bytes, bLimit, used, estimatedBytes);
  }
  const mLimit = limits.max_exploration_minutes_per_day;
  if (mLimit !== null) {
    const usedMin = Math.ceil(Number(daily.exploration_ms || 0) / 60000);
    if (usedMin + explorationMinutes > mLimit) reject(LIMIT_REASONS.max_exploration_minutes_per_day, mLimit, usedMin, explorationMinutes);
  }

  if (reasons.length) {
    const first = reasons[0];
    throw new QuotaExceededError(first.reason, {
      limit: first.limit, used: first.used, requested: first.requested, scope,
      reasons, // all violated quotas, for the API surface
    });
  }
  return { limits, running: res.running, queued: res.queued, daily };
}

// ---------- atomic reservation (plan steps 6 + 7) ----------

// pg_advisory_xact_lock over a per-scope key serializes capacity checks + slot
// inserts; two simultaneous submissions cannot both pass the count check.
function advisoryKey(scope) {
  // 64-bit key: fnv1a fold of "type:id" under a "QUOT" prefix — stable across
  // processes. BigInt end-to-end: the folded value exceeds Number's 2^53 safe
  // range, and node-pg serializes BigInt losslessly for int8 advisory keys.
  const s = `${scope.scope_type}:${scope.scope_id}`;
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  const BASE = 0x51554f54n * 0x100000000n; // fits int8 (max 9.22e18)
  return BASE + BigInt(h);
}

// Reserve one concurrent-execution slot. Throws QuotaExceededError when the
// scope is at capacity. Idempotent per live task (unique partial index).
export async function reserveJobSlot(scope, taskKey, { userId = null, estimatedBytes = 0, explorationMinutes = 0 } = {}) {
  return withTransaction(async (client) => {
    await client.query("SELECT pg_advisory_xact_lock($1)", [advisoryKey(scope)]);

    // idempotency: a live reservation for this task returns as-is
    const existing = await client.query(
      `SELECT id FROM quota_reservations
       WHERE scope_type = $1 AND scope_id = $2 AND task_key = $3 AND released_at IS NULL`,
      [scope.scope_type, scope.scope_id, taskKey]
    );
    if (existing.rows.length) return { reservationId: existing.rows[0].id, reused: true };

    const limits = await resolveLimitsOn(client, scope);
    const daily = await dailyRowOn(client, scope);
    const counts = await client.query(
      `SELECT
         count(*) FILTER (WHERE state = 'running')::int AS running,
         count(*) FILTER (WHERE state = 'queued')::int  AS queued
       FROM quota_reservations
       WHERE scope_type = $1 AND scope_id = $2 AND released_at IS NULL`,
      [scope.scope_type, scope.scope_id]
    );
    const running = Number(counts.rows[0].running);
    const queued = Number(counts.rows[0].queued);

    const reject = (reason, limit, used, requested) => {
      throw new QuotaExceededError(reason, { limit, used, requested, scope });
    };

    const cLimit = limits.max_concurrent_jobs;
    if (cLimit !== null && running >= cLimit) reject(LIMIT_REASONS.max_concurrent_jobs, cLimit, running, 1);
    const jLimit = limits.max_jobs_per_day;
    if (jLimit !== null && daily.jobs_started >= jLimit) reject(LIMIT_REASONS.max_jobs_per_day, jLimit, daily.jobs_started, 1);
    const bLimit = limits.max_artifact_bytes;
    if (bLimit !== null && estimatedBytes > 0) {
      const used = await storageBytesUsed(scope);
      if (used + estimatedBytes > bLimit) reject(LIMIT_REASONS.max_artifact_bytes, bLimit, used, estimatedBytes);
    }
    const mLimit = limits.max_exploration_minutes_per_day;
    if (mLimit !== null && explorationMinutes > 0) {
      const usedMin = Math.ceil(Number(daily.exploration_ms || 0) / 60000);
      if (usedMin + explorationMinutes > mLimit) reject(LIMIT_REASONS.max_exploration_minutes_per_day, mLimit, usedMin, explorationMinutes);
    }

    const ins = await client.query(
      `INSERT INTO quota_reservations (scope_type, scope_id, task_key, state, created_by_user_id)
       VALUES ($1, $2, $3, 'running', $4) RETURNING id`,
      [scope.scope_type, scope.scope_id, taskKey, userId]
    );
    await recordEventTx(client, scope, { userId, taskKey, eventType: "started", amount: 1 });
    await bumpDailyTx(client, scope, { jobsStarted: 1 });
    return { reservationId: ins.rows[0].id, reused: false };
  });
}

// Park a job pre-execution (queued-jobs limit is checked, concurrent is not).
export async function queueReservation(scope, taskKey, { userId = null } = {}) {
  return withTransaction(async (client) => {
    await client.query("SELECT pg_advisory_xact_lock($1)", [advisoryKey(scope)]);
    const existing = await client.query(
      `SELECT id, state FROM quota_reservations
       WHERE scope_type = $1 AND scope_id = $2 AND task_key = $3 AND released_at IS NULL`,
      [scope.scope_type, scope.scope_id, taskKey]
    );
    if (existing.rows.length) return { reservationId: existing.rows[0].id, state: existing.rows[0].state, reused: true };
    const limits = await resolveLimitsOn(client, scope);
    const qLimit = limits.max_queued_jobs;
    if (qLimit !== null) {
      const c = await client.query(
        `SELECT count(*)::int AS n FROM quota_reservations
         WHERE scope_type = $1 AND scope_id = $2 AND released_at IS NULL AND state = 'queued'`,
        [scope.scope_type, scope.scope_id]
      );
      if (Number(c.rows[0].n) >= qLimit) {
        throw new QuotaExceededError(LIMIT_REASONS.max_queued_jobs, {
          limit: qLimit, used: Number(c.rows[0].n), requested: 1, scope,
        });
      }
    }
    const ins = await client.query(
      `INSERT INTO quota_reservations (scope_type, scope_id, task_key, state, created_by_user_id)
       VALUES ($1, $2, $3, 'queued', $4) RETURNING id`,
      [scope.scope_type, scope.scope_id, taskKey, userId]
    );
    return { reservationId: ins.rows[0].id, state: "queued", reused: false };
  });
}

// queued → running under the same advisory lock; concurrent limit re-checked.
export async function promoteReservation(scope, taskKey, { userId = null } = {}) {
  return withTransaction(async (client) => {
    await client.query("SELECT pg_advisory_xact_lock($1)", [advisoryKey(scope)]);
    const cur = await client.query(
      `SELECT id, state FROM quota_reservations
       WHERE scope_type = $1 AND scope_id = $2 AND task_key = $3 AND released_at IS NULL`,
      [scope.scope_type, scope.scope_id, taskKey]
    );
    if (!cur.rows.length) throw new Error(`promoteReservation: no live reservation for ${taskKey}`);
    if (cur.rows[0].state === "running") return { reservationId: cur.rows[0].id, state: "running", promoted: false };
    const limits = await resolveLimitsOn(client, scope);
    const cLimit = limits.max_concurrent_jobs;
    if (cLimit !== null) {
      const c = await client.query(
        `SELECT count(*)::int AS n FROM quota_reservations
         WHERE scope_type = $1 AND scope_id = $2 AND released_at IS NULL AND state = 'running'`,
        [scope.scope_type, scope.scope_id]
      );
      if (Number(c.rows[0].n) >= cLimit) {
        throw new QuotaExceededError(LIMIT_REASONS.max_concurrent_jobs, {
          limit: cLimit, used: Number(c.rows[0].n), requested: 1, scope,
        });
      }
    }
    await client.query(
      "UPDATE quota_reservations SET state = 'running', updated_at = now() WHERE id = $1",
      [cur.rows[0].id]
    );
    return { reservationId: cur.rows[0].id, state: "running", promoted: true };
  });
}

// ---------- release + accounting (plan steps 4/5) ----------

// Release the slot and record the outcome. outcome: 'completed' | 'failed' |
// 'cancelled'; retries>0 records retry events (retries are accounted as part
// of the same job's lifecycle, plan step 5).
// Accounting is tied to the actual release: when no live reservation exists
// (already released / never reserved) this is a no-op — a double release must
// never double-count (caught by test F9).
export async function releaseReservation(scope, taskKey, {
  userId = null,
  outcome = "completed",
  explorationMs = 0,
  retries = 0,
} = {}) {
  return withTransaction(async (client) => {
    await client.query("SELECT pg_advisory_xact_lock($1)", [advisoryKey(scope)]);
    const rel = await client.query(
      `UPDATE quota_reservations
       SET released_at = now(), released_reason = $4, updated_at = now()
       WHERE scope_type = $1 AND scope_id = $2 AND task_key = $3 AND released_at IS NULL
       RETURNING id`,
      [scope.scope_type, scope.scope_id, taskKey, outcome]
    );
    if (!rel.rows.length) return { released: false, reservationId: null };
    if (retries > 0) {
      await recordEventTx(client, scope, { userId, taskKey, eventType: "retry", amount: Number(retries) });
    }
    if (Number(explorationMs) > 0) {
      await recordEventTx(client, scope, { userId, taskKey, eventType: "exploration_ms", amount: Number(Math.round(explorationMs)) });
    }
    const events = { completed: "completed", failed: "failed", cancelled: "cancelled" };
    const evt = events[outcome] || "completed";
    await recordEventTx(client, scope, { userId, taskKey, eventType: evt, amount: 1 });
    await bumpDailyTx(client, scope, {
      jobsCompleted: outcome === "completed" ? 1 : 0,
      jobsFailed: outcome === "failed" ? 1 : 0,
      jobsCancelled: outcome === "cancelled" ? 1 : 0,
      retries: Number(retries) || 0,
      explorationMs: Math.max(0, Math.round(Number(explorationMs) || 0)),
    });
    return { released: true, reservationId: rel.rows[0].id };
  });
}

// Worker-crash reconciliation: reservations older than maxAgeMs with no
// heartbeat are released as 'cancelled' (interrupted jobs — plan step 5/risk
// note). Returns what was reclaimed.
export async function reclaimStaleReservations({ maxAgeMs = Number(process.env.QUOTA_STALE_RESERVATION_MS ?? 30 * 60 * 1000) } = {}) {
  const r = await query(
    `UPDATE quota_reservations
     SET released_at = now(), released_reason = 'stale', updated_at = now()
     WHERE released_at IS NULL AND reserved_at < now() - make_interval(secs => $1)
     RETURNING scope_type, scope_id, task_key`,
    [Math.max(1, Math.floor(maxAgeMs / 1000))]
  );
  const reclaimed = r.rows;
  for (const row of reclaimed) {
    await recordEvent(row, { eventType: "cancelled", amount: 1, payload: { reason: "stale-reclaim" } });
    await bumpDaily(row, { jobsCancelled: 1 });
  }
  return reclaimed;
}

// ---------- storage accounting (computeUsage from 4.0.5, injected) ----------

// Injectable meter. Default: dynamically import the REAL computeUsage from
// 4.0.5 (src/storage/artifact-lifecycle.js:181) once. Tests inject a mock via
// setStorageMeter() — the interface is `async meter(orgIdOrNull) → bytes`.
let storageMeter = null;
export function setStorageMeter(fn) { storageMeter = fn; }

async function loadDefaultMeter() {
  const { computeUsage } = await import("../storage/artifact-lifecycle.js");
  const usage = computeUsage(); // whole artifacts tree (default root)
  return (scopeId) => {
    const orgBucket = usage.orgs?.[String(scopeId)];
    if (orgBucket) return Number(orgBucket.bytes || 0); // org pool = that org's subtree
    return Number(usage.legacy?.bytes || 0); // personal/legacy scope = legacy bucket
  };
}

async function getMeter() {
  if (storageMeter) return storageMeter;
  if (!getMeter._default) getMeter._default = loadDefaultMeter();
  return getMeter._default;
}

export async function storageBytesUsed(scope) {
  const meter = await getMeter();
  return meter(scope.scope_id, scope);
}

// ---------- API surface: usage + limits + rejection reasons (plan step 8) ----------

export async function getUsage(scope) {
  const [limits, res, daily, bytes] = await Promise.all([
    resolveLimits(scope),
    liveReservations(scope),
    dailyRow(scope),
    storageBytesUsed(scope),
  ]);
  const usage = {
    scope: { type: scope.scope_type, id: scope.scope_id },
    day: utcDay(),
    limits,
    running: res.running,
    queued: res.queued,
    jobsStartedToday: Number(daily.jobs_started),
    jobsCompletedToday: Number(daily.jobs_completed),
    jobsFailedToday: Number(daily.jobs_failed),
    jobsCancelledToday: Number(daily.jobs_cancelled),
    retriesToday: Number(daily.retries),
    explorationMinutesToday: Math.round(Number(daily.exploration_ms || 0) / 60000),
    storageBytesUsed: Number(bytes),
  };
  // the quota checks that would reject the NEXT job right now (plan step 8:
  // "expose … quota rejection reasons")
  const reasons = [];
  if (limits.max_concurrent_jobs !== null && res.running >= limits.max_concurrent_jobs) {
    reasons.push({ reason: LIMIT_REASONS.max_concurrent_jobs, limit: limits.max_concurrent_jobs, used: res.running });
  }
  if (limits.max_queued_jobs !== null && res.queued >= limits.max_queued_jobs) {
    reasons.push({ reason: LIMIT_REASONS.max_queued_jobs, limit: limits.max_queued_jobs, used: res.queued });
  }
  if (limits.max_jobs_per_day !== null && usage.jobsStartedToday >= limits.max_jobs_per_day) {
    reasons.push({ reason: LIMIT_REASONS.max_jobs_per_day, limit: limits.max_jobs_per_day, used: usage.jobsStartedToday });
  }
  if (limits.max_artifact_bytes !== null && bytes >= limits.max_artifact_bytes) {
    reasons.push({ reason: LIMIT_REASONS.max_artifact_bytes, limit: limits.max_artifact_bytes, used: bytes });
  }
  if (limits.max_exploration_minutes_per_day !== null && usage.explorationMinutesToday >= limits.max_exploration_minutes_per_day) {
    reasons.push({ reason: LIMIT_REASONS.max_exploration_minutes_per_day, limit: limits.max_exploration_minutes_per_day, used: usage.explorationMinutesToday });
  }
  usage.wouldReject = reasons;
  return usage;
}

// cross-scope summary for an admin/dashboards surface
export async function usageSummary() {
  const r = await query(
    `SELECT scope_type, scope_id,
            count(*) FILTER (WHERE released_at IS NULL AND state = 'running')::int AS running,
            count(*) FILTER (WHERE released_at IS NULL AND state = 'queued')::int  AS queued
     FROM quota_reservations GROUP BY scope_type, scope_id`
  );
  const d = await query(
    `SELECT scope_type, scope_id, jobs_started, exploration_ms
     FROM quota_usage_daily WHERE day = $1`,
    [utcDay()]
  );
  const byScope = new Map();
  for (const row of r.rows) {
    const k = `${row.scope_type}:${row.scope_id}`;
    byScope.set(k, { scope_type: row.scope_type, scope_id: row.scope_id, running: Number(row.running), queued: Number(row.queued), jobsStartedToday: 0, explorationMsToday: 0 });
  }
  for (const row of d.rows) {
    const k = `${row.scope_type}:${row.scope_id}`;
    const e = byScope.get(k) || { scope_type: row.scope_type, scope_id: row.scope_id, running: 0, queued: 0, jobsStartedToday: 0, explorationMsToday: 0 };
    e.jobsStartedToday = Number(row.jobs_started);
    e.explorationMsToday = Number(row.exploration_ms);
    byScope.set(k, e);
  }
  return [...byScope.values()];
}

// ---------- ledger reconciliation (interrupted runs — plan risk note) ----------

// Rebuild one scope's materialized daily counters from the append-only ledger.
export async function reconcileDailyFromLedger(scope, day = utcDay()) {
  const dayStart = `${day}T00:00:00.000Z`;
  const dayEnd = `${day}T23:59:59.999Z`;
  return withTransaction(async (client) => {
    await client.query("SELECT pg_advisory_xact_lock($1)", [advisoryKey(scope)]);
    const r = await client.query(
      `SELECT
         count(*) FILTER (WHERE event_type = 'started')::int    AS jobs_started,
         count(*) FILTER (WHERE event_type = 'completed')::int  AS jobs_completed,
         count(*) FILTER (WHERE event_type = 'failed')::int     AS jobs_failed,
         count(*) FILTER (WHERE event_type = 'cancelled')::int  AS jobs_cancelled,
         coalesce(sum(amount) FILTER (WHERE event_type = 'retry'), 0)::int AS retries,
         coalesce(sum(amount) FILTER (WHERE event_type = 'exploration_ms'), 0)::bigint AS exploration_ms
       FROM quota_usage_events
       WHERE scope_type = $1 AND scope_id = $2 AND created_at >= $3 AND created_at <= $4`,
      [scope.scope_type, scope.scope_id, dayStart, dayEnd]
    );
    const row = r.rows[0];
    await client.query(
      `INSERT INTO quota_usage_daily
         (scope_type, scope_id, day, jobs_started, jobs_completed, jobs_failed, jobs_cancelled, retries, exploration_ms, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, now())
       ON CONFLICT (scope_type, scope_id, day) DO UPDATE SET
         jobs_started = EXCLUDED.jobs_started,
         jobs_completed = EXCLUDED.jobs_completed,
         jobs_failed = EXCLUDED.jobs_failed,
         jobs_cancelled = EXCLUDED.jobs_cancelled,
         retries = EXCLUDED.retries,
         exploration_ms = EXCLUDED.exploration_ms,
         updated_at = now()`,
      [scope.scope_type, scope.scope_id, day,
       Number(row.jobs_started), Number(row.jobs_completed), Number(row.jobs_failed),
       Number(row.jobs_cancelled), Number(row.retries), Number(row.exploration_ms)]
    );
    return {
      jobs_started: Number(row.jobs_started),
      jobs_completed: Number(row.jobs_completed),
      jobs_failed: Number(row.jobs_failed),
      jobs_cancelled: Number(row.jobs_cancelled),
      retries: Number(row.retries),
      exploration_ms: Number(row.exploration_ms),
    };
  });
}

// ---------- internals (tx-aware helpers) ----------

function recordEventTx(client, scope, { userId = null, taskKey = null, eventType, amount = 1, payload = {} }) {
  return client.query(
    `INSERT INTO quota_usage_events (scope_type, scope_id, user_id, task_key, event_type, amount, payload)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [scope.scope_type, scope.scope_id, userId, taskKey, eventType, amount, JSON.stringify(payload)]
  );
}

function bumpDailyTx(client, scope, { jobsStarted = 0, jobsCompleted = 0, jobsFailed = 0, jobsCancelled = 0, retries = 0, explorationMs = 0 } = {}) {
  if (!jobsStarted && !jobsCompleted && !jobsFailed && !jobsCancelled && !retries && !explorationMs) return Promise.resolve();
  return client.query(
    `INSERT INTO quota_usage_daily
       (scope_type, scope_id, day, jobs_started, jobs_completed, jobs_failed, jobs_cancelled, retries, exploration_ms)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     ON CONFLICT (scope_type, scope_id, day) DO UPDATE SET
       jobs_started = quota_usage_daily.jobs_started + EXCLUDED.jobs_started,
       jobs_completed = quota_usage_daily.jobs_completed + EXCLUDED.jobs_completed,
       jobs_failed = quota_usage_daily.jobs_failed + EXCLUDED.jobs_failed,
       jobs_cancelled = quota_usage_daily.jobs_cancelled + EXCLUDED.jobs_cancelled,
       retries = quota_usage_daily.retries + EXCLUDED.retries,
       exploration_ms = quota_usage_daily.exploration_ms + EXCLUDED.exploration_ms,
       updated_at = now()`,
    [scope.scope_type, scope.scope_id, utcDay(), jobsStarted, jobsCompleted, jobsFailed, jobsCancelled, retries, explorationMs]
  );
}

// non-tx variants (used by reclaimStaleReservations outside a transaction);
// each runs as its own autocommit statement on the pool.
async function recordEvent(scope, { userId = null, taskKey = null, eventType, amount = 1, payload = {} }) {
  await query(
    `INSERT INTO quota_usage_events (scope_type, scope_id, user_id, task_key, event_type, amount, payload)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [scope.scope_type, scope.scope_id, userId, taskKey, eventType, amount, JSON.stringify(payload)]
  );
}
async function bumpDaily(scope, deltas) {
  const { jobsStarted = 0, jobsCompleted = 0, jobsFailed = 0, jobsCancelled = 0, retries = 0, explorationMs = 0 } = deltas || {};
  if (!jobsStarted && !jobsCompleted && !jobsFailed && !jobsCancelled && !retries && !explorationMs) return;
  await query(
    `INSERT INTO quota_usage_daily
       (scope_type, scope_id, day, jobs_started, jobs_completed, jobs_failed, jobs_cancelled, retries, exploration_ms)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     ON CONFLICT (scope_type, scope_id, day) DO UPDATE SET
       jobs_started = quota_usage_daily.jobs_started + EXCLUDED.jobs_started,
       jobs_completed = quota_usage_daily.jobs_completed + EXCLUDED.jobs_completed,
       jobs_failed = quota_usage_daily.jobs_failed + EXCLUDED.jobs_failed,
       jobs_cancelled = quota_usage_daily.jobs_cancelled + EXCLUDED.jobs_cancelled,
       retries = quota_usage_daily.retries + EXCLUDED.retries,
       exploration_ms = quota_usage_daily.exploration_ms + EXCLUDED.exploration_ms,
       updated_at = now()`,
    [scope.scope_type, scope.scope_id, utcDay(), jobsStarted, jobsCompleted, jobsFailed, jobsCancelled, retries, explorationMs]
  );
}
