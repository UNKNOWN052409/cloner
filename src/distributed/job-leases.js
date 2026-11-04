// Distributed job leases (task 4.2.8) — a job is owned by exactly ONE worker
// at a time via a lease with a TTL, renewed while the worker makes progress,
// and stolen by another worker once the TTL expires. This is what prevents
// duplicate execution of the same clone job when workers run in different
// regions/processes: the lease lives in SHARED state (PostgreSQL by default),
// and granting it is a single atomic statement — the race loser is skipped by
// the database itself, not by any client-side check.
//
//   acquire(jobId, workerId)  atomic grant — succeeds only when the job is
//                             unleased or the previous lease EXPIRED. While
//                             any lease is live (even your own) acquire is
//                             rejected with reason "held"; renewal is the
//                             only way to extend.
//   renew(jobId, workerId)    owner-only extension; fails once the TTL has
//                             passed (the owner has lost it and must compete
//                             again through acquire like everyone else).
//   steal(jobId, workerId)    explicit takeover of an EXPIRED lease — the
//                             "steal on expiry" path. Requires an existing
//                             (dead) lease; acquiring a never-leased job is
//                             acquire()'s job. Every steal bumps the epoch.
//   release(jobId, workerId)  owner-only voluntary release (normal completion).
//   validateOwnership(...)    fencing: only the current owner with the current
//                             epoch may write effects for the job. A worker
//                             that lost its lease (or is still running with a
//                             stale epoch after a steal) is rejected, so a
//                             slow zombie can never double-write artifacts.
//
// Epoch (fencing token): every takeover increments `epoch`. Callers should
// pass it into validateOwnership before each effectful write. The lease object
// also carries it so the orchestrator can compare generations.
//
// Clock authority: the Postgres backend makes every decision with the
// database's now() — client clocks across regions may be skewed, the shared
// store's clock cannot be (single authority). The memory backend uses an
// injectable clock (deterministic tests, single-process fallback).
//
// Backends (same convention as src/queues/clone-queue.js):
//   "postgres" — default, the real distributed path. Rows live in the
//                job_leases table (migration 017); every worker in every
//                region sees the same rows. Clean LeaseError when the DB is
//                unreachable or the migration has not been applied.
//   "memory"   — in-process fallback (opt-in via CLONER_LEASE_BACKEND=memory),
//                identical semantics, zero cross-process reach — matching the
//                clone-queue memory fallback. Tests inject a clock.
//
// Integration seam: src/workers/clone-worker.js (or the exploration runner)
// wraps a job's execution as acquire → periodic renew (ttl/3) → release;
// onLostLease(renew failure) → abort before further effectful writes.
import { defaultLeaseWorkerId, envLeaseBackend, envLeaseRegion, envLeaseTtlMs } from "./lease-env.js";

export { defaultLeaseWorkerId };

export class LeaseError extends Error {
  constructor(message, { code, cause } = {}) {
    super(message);
    this.name = "LeaseError";
    this.code = code || "lease_error";
    if (cause) this.cause = cause;
  }
}

// Normalize one backend row into the public lease shape. `nowMs` is the
// authoritative clock (DB clock for postgres rows, injected clock for memory).
const toMs = (v) => (v instanceof Date ? v.getTime() : Date.parse(v));
const toIso = (v) => new Date(toMs(v)).toISOString();

export function mapLeaseRow(row, nowMs) {
  if (!row) return null;
  const expiresMs = toMs(row.expiresAt);
  const renewedMs = toMs(row.renewedAt);
  return {
    jobId: row.jobId,
    owner: row.owner,
    region: row.region,
    // pg returns BIGINT as a string — normalize so epoch comparisons work
    epoch: Number(row.epoch),
    acquiredAt: toIso(row.acquiredAt),
    renewedAt: toIso(row.renewedAt),
    expiresAt: toIso(row.expiresAt),
    ttlMs: expiresMs - renewedMs,
    expired: expiresMs <= nowMs,
    active: expiresMs > nowMs,
  };
}

// =====================================================================
// Postgres backend — the real distributed path.
// =====================================================================
export function createPostgresLeaseBackend({ query } = {}) {
  const LEASE_COLS = "job_id AS \"jobId\", owner, region, epoch, acquired_at AS \"acquiredAt\", renewed_at AS \"renewedAt\", expires_at AS \"expiresAt\"";
  // Default to the project's real PostgreSQL pool (src/database/client.js —
  // env-configured, PGHOST/PGPORT/…). Resolved lazily on first use so the
  // module imports without opening connections; an injected `query` (tests,
  // alternate pool) always wins.
  let qfn = typeof query === "function" ? query : null;
  async function q(text, params) {
    if (!qfn) {
      const client = await import("../database/client.js");
      qfn = client.query;
    }
    return qfn(text, params);
  }

  async function acquire(jobId, owner, region, ttlMs) {
    // One atomic statement: insert fresh, or take over an expired lease.
    // ON CONFLICT DO UPDATE WHERE is re-checked by PostgreSQL against the
    // latest committed row after the conflicting insert's lock is released
    // (READ COMMITTED), so concurrent racers get exactly one rowCount=1.
    const { rows, rowCount } = await q(
      `INSERT INTO job_leases (job_id, owner, region, epoch, acquired_at, renewed_at, expires_at)
       VALUES ($1, $2, $3, 1, now(), now(), now() + make_interval(secs => $4))
       ON CONFLICT (job_id) DO UPDATE
         SET owner = EXCLUDED.owner,
             region = EXCLUDED.region,
             epoch = job_leases.epoch + 1,
             acquired_at = now(),
             renewed_at = now(),
             expires_at = EXCLUDED.expires_at
       WHERE job_leases.expires_at <= now()
       RETURNING ${LEASE_COLS}`,
      [jobId, owner, region, ttlMs / 1000]
    );
    if (rowCount === 1) return { acquired: true, row: rows[0] };
    const cur = await getLeaseRow(jobId);
    return { acquired: false, reason: "held", row: cur };
  }

  async function renew(jobId, owner, ttlMs) {
    const { rows, rowCount } = await q(
      `UPDATE job_leases
          SET renewed_at = now(), expires_at = now() + make_interval(secs => $3)
        WHERE job_id = $1 AND owner = $2 AND expires_at > now()
        RETURNING ${LEASE_COLS}`,
      [jobId, owner, ttlMs / 1000]
    );
    if (rowCount === 1) return { renewed: true, row: rows[0] };
    // Classify the rejection with the DB's clock (the authority), not the
    // client's: live-but-wrong-owner → "not-owner", dead lease → "expired".
    const { rows: curRows } = await q(
      `SELECT ${LEASE_COLS}, (expires_at > now()) AS live FROM job_leases WHERE job_id = $1`,
      [jobId]
    );
    const cur = curRows[0];
    if (!cur) return { renewed: false, reason: "not-leased" };
    return { renewed: false, reason: cur.live ? "not-owner" : "expired", row: cur };
  }

  async function steal(jobId, owner, region, ttlMs) {
    const { rows, rowCount } = await q(
      `UPDATE job_leases
          SET owner = $2, region = $3, epoch = job_leases.epoch + 1,
              acquired_at = now(), renewed_at = now(),
              expires_at = now() + make_interval(secs => $4)
        WHERE job_id = $1 AND expires_at <= now()
        RETURNING ${LEASE_COLS}`,
      [jobId, owner, region, ttlMs / 1000]
    );
    if (rowCount === 1) return { acquired: true, stolen: true, row: rows[0] };
    const cur = await getLeaseRow(jobId);
    if (!cur) return { acquired: false, reason: "not-leased" };
    return { acquired: false, reason: "not-expired", row: cur };
  }

  async function release(jobId, owner) {
    const { rowCount } = await q(
      `DELETE FROM job_leases WHERE job_id = $1 AND owner = $2`,
      [jobId, owner]
    );
    if (rowCount === 1) return { released: true };
    const cur = await getLeaseRow(jobId);
    if (!cur) return { released: false, reason: "not-leased" };
    return { released: false, reason: "not-owner" };
  }

  async function getLeaseRow(jobId) {
    const { rows } = await q(
      `SELECT ${LEASE_COLS} FROM job_leases WHERE job_id = $1`,
      [jobId]
    );
    return rows[0] || null;
  }

  async function getLease(jobId) {
    return { lease: await getLeaseRow(jobId) };
  }

  async function listLeases() {
    const { rows } = await q(
      `SELECT ${LEASE_COLS} FROM job_leases ORDER BY job_id`
    );
    return { leases: rows };
  }

  async function close() { /* pool is owned by src/database/client.js */ }

  return { acquire, renew, steal, release, getLease, listLeases, close, backend: "postgres" };
}

// =====================================================================
// Memory backend — single-process fallback / deterministic test seam.
// Shared `store` lets several manager instances in ONE process behave like
// several workers against the same coordination store.
// =====================================================================
export function createMemoryLeaseBackend({ now = () => Date.now(), store = new Map() } = {}) {
  const tick = () => now();

  function acquire(jobId, owner, region, ttlMs) {
    const t = tick();
    const cur = store.get(jobId);
    // _expiresMs is the numeric authority; the ISO string is display-only.
    // (Comparing the ISO string against the numeric clock would coerce to
    // NaN and wrongly treat a live lease as expired.)
    if (cur && cur._expiresMs > t) return { acquired: false, reason: "held", row: { ...cur } };
    const row = {
      jobId, owner, region,
      epoch: cur ? cur.epoch + 1 : 1,
      acquiredAt: new Date(t).toISOString(),
      renewedAt: new Date(t).toISOString(),
      expiresAt: new Date(t + ttlMs).toISOString(),
      _expiresMs: t + ttlMs,
      _renewedMs: t,
    };
    store.set(jobId, row);
    return { acquired: true, stolen: Boolean(cur), row: { ...row } };
  }

  function renew(jobId, owner, ttlMs) {
    const t = tick();
    const cur = store.get(jobId);
    if (!cur) return { renewed: false, reason: "not-leased" };
    if (cur._expiresMs <= t) return { renewed: false, reason: "expired", row: { ...cur } };
    if (cur.owner !== owner) return { renewed: false, reason: "not-owner", row: { ...cur } };
    cur.renewedAt = new Date(t).toISOString();
    cur._renewedMs = t;
    cur.expiresAt = new Date(t + ttlMs).toISOString();
    cur._expiresMs = t + ttlMs;
    return { renewed: true, row: { ...cur } };
  }

  function steal(jobId, owner, region, ttlMs) {
    const t = tick();
    const cur = store.get(jobId);
    if (!cur) return { acquired: false, reason: "not-leased" };
    if (cur._expiresMs > t) return { acquired: false, reason: "not-expired", row: { ...cur } };
    return acquire(jobId, owner, region, ttlMs); // expired → takeover (epoch+1)
  }

  function release(jobId, owner) {
    const cur = store.get(jobId);
    if (!cur) return { released: false, reason: "not-leased" };
    if (cur.owner !== owner) return { released: false, reason: "not-owner" };
    store.delete(jobId);
    return { released: true };
  }

  function getLease(jobId) {
    const cur = store.get(jobId);
    return { lease: cur ? { ...cur } : null };
  }

  function listLeases() {
    return { leases: [...store.values()].map((r) => ({ ...r })) };
  }

  function close() { store.clear(); }

  return { acquire, renew, steal, release, getLease, listLeases, close, backend: "memory" };
}

// =====================================================================
// Manager — the worker-facing surface over either backend.
// =====================================================================
export function createLeaseManager({
  backend = envLeaseBackend(),
  ttlMs = envLeaseTtlMs(),
  region = envLeaseRegion(),
  workerId = defaultLeaseWorkerId(),
  query,       // postgres backend seam (defaults to src/database/client.js)
  now,         // memory backend clock seam (deterministic tests)
} = {}) {
  if (ttlMs <= 0 || !Number.isFinite(ttlMs)) {
    throw new LeaseError(`lease ttlMs must be a positive number, got ${ttlMs}`, { code: "lease_config" });
  }
  // `backend` is a backend NAME ("postgres" | "memory") or an ALREADY-CREATED
  // backend object — the injection seam tests use to share one coordination
  // store between several manager instances (simulating several workers).
  const store = (backend && typeof backend === "object")
    ? backend
    : backend === "postgres"
      ? createPostgresLeaseBackend({ query })
      : backend === "memory"
        ? createMemoryLeaseBackend({ now })
        : null;
  if (!store || typeof store.acquire !== "function") {
    throw new LeaseError(`unknown lease backend ${typeof backend === "string" ? JSON.stringify(backend) : "(object missing acquire)" } (use "postgres", "memory", or a backend object)`, { code: "lease_backend" });
  }
  // Authoritative clock for read-side reporting (expired/active flags).
  // Decision-side clocks are the backend's own: DB now() for postgres,
  // the injected clock for memory. `now` here only pins the report view.
  const nowMs = now || (() => Date.now());

  const own = (worker) => worker || workerId;

  async function acquire(jobId, worker, { ttl: ttlOverride } = {}) {
    const ttl = ttlOverride || ttlMs;
    try {
      const res = await store.acquire(jobId, own(worker), region, ttl);
      if (res.acquired) return { acquired: true, lease: mapLeaseRow(res.row, nowMs()) };
      return { acquired: false, reason: res.reason, owner: res.row?.owner, lease: mapLeaseRow(res.row, nowMs()) };
    } catch (err) {
      throw new LeaseError(`lease acquire failed for job ${jobId}: ${err.message}`, { code: "lease_db", cause: err });
    }
  }

  async function renew(jobId, worker, { ttl: ttlOverride } = {}) {
    const ttl = ttlOverride || ttlMs;
    try {
      const res = await store.renew(jobId, own(worker), ttl);
      if (res.renewed) return { renewed: true, lease: mapLeaseRow(res.row, nowMs()) };
      return { renewed: false, reason: res.reason, owner: res.row?.owner, lease: mapLeaseRow(res.row, nowMs()) };
    } catch (err) {
      throw new LeaseError(`lease renew failed for job ${jobId}: ${err.message}`, { code: "lease_db", cause: err });
    }
  }

  async function steal(jobId, worker, { ttl: ttlOverride } = {}) {
    const ttl = ttlOverride || ttlMs;
    try {
      const res = await store.steal(jobId, own(worker), region, ttl);
      if (res.acquired) return { acquired: true, stolen: true, lease: mapLeaseRow(res.row, nowMs()) };
      return { acquired: false, stolen: false, reason: res.reason, owner: res.row?.owner, lease: mapLeaseRow(res.row, nowMs()) };
    } catch (err) {
      throw new LeaseError(`lease steal failed for job ${jobId}: ${err.message}`, { code: "lease_db", cause: err });
    }
  }

  async function release(jobId, worker) {
    try {
      return await store.release(jobId, own(worker));
    } catch (err) {
      throw new LeaseError(`lease release failed for job ${jobId}: ${err.message}`, { code: "lease_db", cause: err });
    }
  }

  async function getLease(jobId) {
    try {
      const { lease } = await store.getLease(jobId);
      return { lease: mapLeaseRow(lease, nowMs()) };
    } catch (err) {
      throw new LeaseError(`lease lookup failed for job ${jobId}: ${err.message}`, { code: "lease_db", cause: err });
    }
  }

  async function listLeases() {
    try {
      const { leases } = await store.listLeases();
      return { leases: leases.map((r) => mapLeaseRow(r, nowMs())) };
    } catch (err) {
      throw new LeaseError(`lease list failed: ${err.message}`, { code: "lease_db", cause: err });
    }
  }

  // Fencing check for effectful writes: valid only while THIS worker still
  // owns the job with the SAME epoch it observed. A stale epoch after a steal
  // is rejected even though the owner field happens to match (re-acquire by
  // the same worker after expiry produces a NEW epoch — old effects fenced).
  async function validateOwnership(jobId, worker, epoch) {
    const { lease } = await getLease(jobId);
    if (!lease) return { valid: false, reason: "not-leased" };
    if (lease.owner !== own(worker)) return { valid: false, reason: "not-owner", lease };
    if (epoch != null && lease.epoch !== epoch) return { valid: false, reason: "stale-epoch", lease };
    if (!lease.active) return { valid: false, reason: "expired", lease };
    return { valid: true, lease };
  }

  async function close() { await store.close(); }

  return {
    backend: store.backend,
    ttlMs,
    region,
    workerId,
    acquire, renew, steal, release, getLease, listLeases, validateOwnership, close,
  };
}

export default createLeaseManager;
