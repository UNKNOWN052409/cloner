// Capacity analytics engine (task 4.2.11 — Capacity dashboards API).
//
// Time-series aggregates over the capacity_samples / capacity_job_costs tables
// (migration 042) for the capacity dashboards surface:
//
//   • per-region utilization   — busy slots vs. provisioned slots per sample,
//                                aggregated to avg / peak / latest over a window
//   • queue depth history      — depth sampled per region, bucketed into fixed
//                                time buckets (default 60s) for the dashboard
//                                timeline
//   • cost per job aggregates  — per-region and overall job cost rollups
//                                (jobs, total, average, max) over the window
//
// Ingest side (REAL, not sampled from thin air):
//   • recordSample() / recordSamples()   — workers/operators push a region
//     sample; captureLiveSample() derives one from the LIVE clone-queue
//     registry + metrics-registry heartbeats (pending = queued entries,
//     busy = running entries, slots = worker heartbeats seen).
//   • recordJobCost()                    — the queue/pipeline records what a
//     job actually cost the operator.
//
// Cardinality guard (same posture as metrics-registry.js): region/status
// values are sanitized to [A-Za-z0-9_.-]{0,64} with a bounded fallback — raw
// URLs, job ids and user input are never stored as region labels. Numbers are
// clamped to non-negative finite integers.
//
// DB access is injected as a `query(text, params)` function (default: the real
// src/database/client.js pool, resolved lazily like health-routes.js does) so
// tests can point the engine at the real compose PostgreSQL or run against a
// fixture without touching product code.
const SAFE_LABEL_RE = /[^A-Za-z0-9_.-]/g;
const MAX_LABEL_LEN = 64;

export const COST_STATUSES = ["completed", "completed_with_limitations", "error", "cancelled"];
const OTHER = "other";

function safeRegion(value) {
  if (value === undefined || value === null || value === "") return "unknown";
  const s = String(value).replace(SAFE_LABEL_RE, "_").slice(0, MAX_LABEL_LEN);
  return s || "unknown";
}

function safeStatus(value) {
  if (value === undefined || value === null || value === "") return OTHER;
  const s = String(value).replace(SAFE_LABEL_RE, "_").slice(0, MAX_LABEL_LEN);
  return s || OTHER;
}

function toInt(v, fallback = 0) {
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) return fallback;
  return Math.floor(n);
}

// cost: non-negative finite number, rounded to 6 dp (the column scale)
function toCost(v) {
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.round(n * 1e6) / 1e6;
}

function toDate(v, fallbackMs) {
  if (v === undefined || v === null || v === "") return new Date(fallbackMs);
  if (v instanceof Date && !isNaN(v)) return v;
  const n = Number(v);
  const d = Number.isFinite(n) ? new Date(n) : new Date(v);
  return isNaN(d) ? new Date(fallbackMs) : d;
}

export function createCapacityAnalytics(deps = {}) {
  const clock = deps.clock || (() => Date.now());

  // db: a query(text, params) fn. Default = the real shared pool (lazy import,
  // so mounting this module never requires PostgreSQL at import time).
  async function db(text, params) {
    if (deps.query) return deps.query(text, params);
    const { query } = await import("../database/client.js");
    return query(text, params);
  }

  // ---- ingest -----------------------------------------------------------

  function normalizeSample(input) {
    const now = clock();
    return {
      region: safeRegion(input?.region),
      ts: toDate(input?.ts, now),
      workerSlots: toInt(input?.workerSlots ?? input?.worker_slots, 0),
      busySlots: toInt(input?.busySlots ?? input?.busy_slots, 0),
      queueDepth: toInt(input?.queueDepth ?? input?.queue_depth, 0),
      activeJobs: toInt(input?.activeJobs ?? input?.active_jobs, 0),
      jobsCompleted: toInt(input?.jobsCompleted ?? input?.jobs_completed, 0),
      jobsFailed: toInt(input?.jobsFailed ?? input?.jobs_failed, 0),
    };
  }

  async function recordSample(input) {
    const s = normalizeSample(input);
    const r = await db(
      `INSERT INTO capacity_samples (region, ts, worker_slots, busy_slots, queue_depth, active_jobs, jobs_completed_delta, jobs_failed_delta)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING id, region, ts, worker_slots, busy_slots, queue_depth, active_jobs, jobs_completed_delta, jobs_failed_delta`,
      [s.region, s.ts, s.workerSlots, s.busySlots, s.queueDepth, s.activeJobs, s.jobsCompleted, s.jobsFailed],
    );
    return shapeSample(r.rows[0]);
  }

  // bounded bulk ingest (multi-row INSERT) for seeding/batch report — hard cap
  // keeps a single statement from blowing the parameter budget
  async function recordSamples(list) {
    const rows = (Array.isArray(list) ? list : []).slice(0, 500).map(normalizeSample);
    if (!rows.length) return [];
    const values = [];
    const params = [];
    rows.forEach((s, i) => {
      const b = i * 8;
      values.push(`($${b + 1}, $${b + 2}, $${b + 3}, $${b + 4}, $${b + 5}, $${b + 6}, $${b + 7}, $${b + 8})`);
      params.push(s.region, s.ts, s.workerSlots, s.busySlots, s.queueDepth, s.activeJobs, s.jobsCompleted, s.jobsFailed);
    });
    const r = await db(
      `INSERT INTO capacity_samples (region, ts, worker_slots, busy_slots, queue_depth, active_jobs, jobs_completed_delta, jobs_failed_delta)
       VALUES ${values.join(",")}
       RETURNING id, region, ts, worker_slots, busy_slots, queue_depth, active_jobs, jobs_completed_delta, jobs_failed_delta`,
      params,
    );
    return r.rows.map(shapeSample);
  }

  async function recordJobCost(input) {
    const region = safeRegion(input?.region);
    const status = COST_STATUSES.includes(String(input?.status)) ? String(input.status) : safeStatus(input?.status);
    const cost = toCost(input?.costUsd ?? input?.cost_usd);
    const jobId = input?.jobId === undefined || input?.jobId === null ? null : String(input.jobId).slice(0, 200);
    const ts = toDate(input?.ts, clock());
    const r = await db(
      `INSERT INTO capacity_job_costs (region, job_id, status, cost_usd, ts)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, region, job_id, status, cost_usd, ts`,
      [region, jobId, status, cost, ts],
    );
    const row = r.rows[0];
    return { id: row.id, region: row.region, jobId: row.job_id, status: row.status, costUsd: Number(row.cost_usd), ts: new Date(row.ts).toISOString() };
  }

  // ---- aggregates -------------------------------------------------------

  // window [from, to]; default = the trailing windowMs ending at clock().
  function resolveWindow(opts = {}) {
    const now = opts.now ? new Date(opts.now) : new Date(clock());
    const windowMs = Math.max(1000, Math.min(Number(opts.windowMs) || 3_600_000, 30 * 24 * 3_600_000));
    const bucketMs = Math.max(1000, Math.min(Number(opts.bucketMs) || 60_000, windowMs));
    const to = now;
    const from = new Date(to.getTime() - windowMs);
    return { from, to, windowMs, bucketMs };
  }

  // utilization per sample = busy/slots; 0 when unprovisioned (no slots) — a
  // region with no workers is not "fully busy", it is "no capacity"
  const SAMPLE_COLUMNS = `id, region, ts, worker_slots, busy_slots, queue_depth, active_jobs, jobs_completed_delta, jobs_failed_delta`;

  function shapeSample(row) {
    return {
      id: row.id,
      region: row.region,
      ts: new Date(row.ts).toISOString(),
      workerSlots: row.worker_slots,
      busySlots: row.busy_slots,
      queueDepth: row.queue_depth,
      activeJobs: row.active_jobs,
      jobsCompleted: row.jobs_completed_delta,
      jobsFailed: row.jobs_failed_delta,
      utilization: row.worker_slots > 0 ? Math.min(1, row.busy_slots / row.worker_slots) : 0,
    };
  }

  async function getRegionAggregates(opts = {}) {
    const { from, to } = opts.from && opts.to ? { from: toDate(opts.from, clock()), to: toDate(opts.to, clock()) } : resolveWindow(opts);
    const region = opts.region || null;
    const params = [from, to];
    let where = "ts >= $1 AND ts <= $2";
    if (region) { params.push(safeRegion(region)); where += ` AND region = $${params.length}`; }

    // windowed aggregates per region (avg/max of utilization, depth, busy)
    const agg = await db(
      `SELECT region,
              COUNT(*)::int AS samples,
              AVG(CASE WHEN worker_slots > 0 THEN LEAST(1.0, busy_slots::float / worker_slots) ELSE 0 END)::float AS utilization_avg,
              MAX(CASE WHEN worker_slots > 0 THEN LEAST(1.0, busy_slots::float / worker_slots) ELSE 0 END)::float AS utilization_peak,
              AVG(queue_depth)::float AS queue_depth_avg,
              MAX(queue_depth)::int AS queue_depth_peak,
              MAX(worker_slots)::int AS worker_slots_peak,
              AVG(busy_slots)::float AS busy_avg,
              SUM(jobs_completed_delta)::int AS jobs_completed,
              SUM(jobs_failed_delta)::int AS jobs_failed
       FROM capacity_samples
       WHERE ${where}
       GROUP BY region
       ORDER BY region`,
      params,
    );

    // latest sample per region within the window (DISTINCT ON)
    const latestParams = [from, to];
    let latestWhere = "ts >= $1 AND ts <= $2";
    if (region) { latestParams.push(safeRegion(region)); latestWhere += ` AND region = $${latestParams.length}`; }
    const latest = await db(
      `SELECT DISTINCT ON (region) ${SAMPLE_COLUMNS}
       FROM capacity_samples WHERE ${latestWhere}
       ORDER BY region, ts DESC, id DESC`,
      latestParams,
    );
    const latestByRegion = new Map(latest.rows.map((r) => [r.region, shapeSample(r)]));

    return agg.rows.map((r) => {
      const cur = latestByRegion.get(r.region);
      return {
        region: r.region,
        samples: Number(r.samples),
        workerSlotsPeak: Number(r.worker_slots_peak),
        workerSlotsCurrent: cur?.workerSlots ?? 0,
        busySlotsCurrent: cur?.busySlots ?? 0,
        busyAvg: round3(Number(r.busy_avg)),
        utilizationAvg: round3(Number(r.utilization_avg)),
        utilizationPeak: round3(Number(r.utilization_peak)),
        utilizationCurrent: cur?.utilization ?? 0,
        queueDepthCurrent: cur?.queueDepth ?? 0,
        queueDepthAvg: round3(Number(r.queue_depth_avg)),
        queueDepthPeak: Number(r.queue_depth_peak),
        activeJobsCurrent: cur?.activeJobs ?? 0,
        jobsCompleted: Number(r.jobs_completed),
        jobsFailed: Number(r.jobs_failed),
        successRate: round3(r.jobs_completed + r.jobs_failed > 0 ? r.jobs_completed / (r.jobs_completed + r.jobs_failed) : null),
      };
    });
  }

  async function getQueueDepthHistory(opts = {}) {
    const { from, to, bucketMs } = opts.from && opts.to
      ? { from: toDate(opts.from, clock()), to: toDate(opts.to, clock()), bucketMs: Math.max(1000, Math.min(Number(opts.bucketMs) || 60_000, toDate(opts.to, clock()) - toDate(opts.from, clock()))) }
      : resolveWindow(opts);
    const region = opts.region || null;
    const bucketSec = Math.round(bucketMs / 1000);
    const params = [from, to, bucketSec];
    let where = "ts >= $1 AND ts <= $2";
    if (region) { params.push(safeRegion(region)); where += ` AND region = $${params.length}`; }
    const r = await db(
      `SELECT to_timestamp(FLOOR(EXTRACT(EPOCH FROM ts) / $3) * $3) AS bucket,
              region,
              AVG(queue_depth)::float AS avg_depth,
              MAX(queue_depth)::int  AS peak_depth,
              COUNT(*)::int AS samples
       FROM capacity_samples
       WHERE ${where}
       GROUP BY 1, 2
       ORDER BY 1 ASC, region ASC`,
      params,
    );
    return {
      window: { from: from.toISOString(), to: to.toISOString(), windowMs: to - from, bucketMs },
      history: r.rows.map((row) => ({
        bucket: new Date(row.bucket).toISOString(),
        region: row.region,
        avgDepth: round3(Number(row.avg_depth)),
        peakDepth: Number(row.peak_depth),
        samples: Number(row.samples),
      })),
    };
  }

  async function getCostAggregates(opts = {}) {
    const { from, to } = opts.from && opts.to ? { from: toDate(opts.from, clock()), to: toDate(opts.to, clock()) } : resolveWindow(opts);
    const region = opts.region || null;
    const params = [from, to];
    let where = "ts >= $1 AND ts <= $2";
    if (region) { params.push(safeRegion(region)); where += ` AND region = $${params.length}`; }

    const overallRow = await db(
      `SELECT COUNT(*)::int AS jobs,
              COALESCE(SUM(cost_usd), 0)::float AS total,
              COALESCE(AVG(cost_usd), 0)::float AS avg_cost,
              COALESCE(MAX(cost_usd), 0)::float AS max_cost
       FROM capacity_job_costs WHERE ${where}`,
      params,
    );
    const byRegionRows = await db(
      `SELECT region, COUNT(*)::int AS jobs,
              COALESCE(SUM(cost_usd), 0)::float AS total,
              COALESCE(AVG(cost_usd), 0)::float AS avg_cost,
              COALESCE(MAX(cost_usd), 0)::float AS max_cost
       FROM capacity_job_costs WHERE ${where}
       GROUP BY region ORDER BY region`,
      params,
    );
    const byStatusRows = await db(
      `SELECT status, COUNT(*)::int AS jobs, COALESCE(SUM(cost_usd), 0)::float AS total
       FROM capacity_job_costs WHERE ${where}
       GROUP BY status ORDER BY status`,
      params,
    );

    const o = overallRow.rows[0];
    const overall = {
      jobs: Number(o.jobs),
      totalCostUsd: round3(Number(o.total)),
      avgCostPerJobUsd: round3(Number(o.avg_cost)),
      maxCostUsd: round3(Number(o.max_cost)),
    };
    return {
      overall,
      costPerJob: { usd: overall.avgCostPerJobUsd, jobs: overall.jobs }, // dashboard convenience alias
      byRegion: byRegionRows.rows.map((r) => ({
        region: r.region,
        jobs: Number(r.jobs),
        totalCostUsd: round3(Number(r.total)),
        avgCostPerJobUsd: round3(Number(r.avg_cost)),
        maxCostUsd: round3(Number(r.max_cost)),
      })),
      byStatus: byStatusRows.rows.map((r) => ({ status: r.status, jobs: Number(r.jobs), totalCostUsd: round3(Number(r.total)) })),
    };
  }

  // full dashboard payload — what GET /overview renders
  async function getCapacitySnapshot(opts = {}) {
    const { from, to, windowMs, bucketMs } = resolveWindow(opts);
    const [regions, queueDepthHistory, cost] = await Promise.all([
      getRegionAggregates({ from, to, region: opts.region }),
      getQueueDepthHistory({ from, to, bucketMs, region: opts.region }),
      getCostAggregates({ from, to, region: opts.region }),
    ]);
    const totals = {
      regions: regions.length,
      samples: regions.reduce((a, r) => a + r.samples, 0),
      jobsCompleted: regions.reduce((a, r) => a + r.jobsCompleted, 0),
      jobsFailed: regions.reduce((a, r) => a + r.jobsFailed, 0),
      utilizationAvg: round3(regions.length ? regions.reduce((a, r) => a + r.utilizationAvg, 0) / regions.length : 0),
      utilizationPeak: round3(regions.reduce((a, r) => Math.max(a, r.utilizationPeak), 0)),
    };
    totals.successRate = round3(totals.jobsCompleted + totals.jobsFailed > 0 ? totals.jobsCompleted / (totals.jobsCompleted + totals.jobsFailed) : null);
    return {
      window: { from: from.toISOString(), to: to.toISOString(), windowMs, bucketMs },
      totals,
      regions,
      queueDepthHistory,
      cost,
    };
  }

  // retention prune: removes samples + job costs strictly older than
  // (now - olderThanMs). olderThanMs is honored as requested, bounded only to
  // a 60s floor so a bad/degenerate request cannot silently delete fresh data
  // (default when omitted: 30 days).
  async function pruneCapacityData({ olderThanMs, now = null } = {}) {
    const requested = Number(olderThanMs);
    const spanMs = Number.isFinite(requested) && requested > 0
      ? Math.max(60_000, requested)
      : 30 * 24 * 3_600_000;
    const cutoff = new Date((now ? new Date(now) : new Date(clock())).getTime() - spanMs);
    const s = await db(`DELETE FROM capacity_samples WHERE ts < $1`, [cutoff]);
    const c = await db(`DELETE FROM capacity_job_costs WHERE ts < $1`, [cutoff]);
    return { cutoff: cutoff.toISOString(), samplesRemoved: s.rowCount, costsRemoved: c.rowCount };
  }

  // recent raw samples for one region (dashboard drill-down / debug surface)
  async function listSamples(region, { limit = 100, windowMs, now = null } = {}) {
    const { from, to } = resolveWindow({ windowMs, now });
    const r = await db(
      `SELECT ${SAMPLE_COLUMNS}
       FROM capacity_samples
       WHERE region = $1 AND ts >= $2 AND ts <= $3
       ORDER BY ts DESC, id DESC
       LIMIT $4`,
      [safeRegion(region), from, to, Math.max(1, Math.min(Number(limit) || 100, 500))],
    );
    return {
      window: { from: from.toISOString(), to: to.toISOString(), windowMs: to - from },
      region: safeRegion(region),
      samples: r.rows.map(shapeSample),
    };
  }

  return {
    recordSample,
    recordSamples,
    recordJobCost,
    getCapacitySnapshot,
    getRegionAggregates,
    getQueueDepthHistory,
    getCostAggregates,
    listSamples,
    pruneCapacityData,
    _normalizeSample: normalizeSample, // exposed for validation tests
  };
}

// ---------------------------------------------------------------------------
// LIVE capture: derive one region sample from the REAL running system — the
// clone-queue registry (queued = pending, running statuses = busy) and the
// metrics-registry worker heartbeats (slots = heartbeats seen, busy = active
// jobs they report). No synthetic numbers: everything is read from live state.
const RUNNING_STATUSES = new Set(["running", "exploring", "reconstructing", "verifying"]);
const PENDING_STATUSES = new Set(["queued"]);

export function captureLiveSample({ region = "default", queue = null, registry = null, clock: clockFn = () => Date.now(), jobsCompleted = 0, jobsFailed = 0 } = {}) {
  let pending = 0;
  let running = 0;
  if (queue && typeof queue.listJobs === "function") {
    for (const j of queue.listJobs()) {
      if (PENDING_STATUSES.has(j.status)) pending += 1;
      else if (RUNNING_STATUSES.has(j.status)) running += 1;
    }
  }
  let workerSlots = 0;
  let busy = running;
  if (registry && registry.workerHeartbeats instanceof Map) {
    workerSlots = Math.max(registry.workerHeartbeats.size, running);
    const heartbeatActive = [...registry.workerHeartbeats.values()].reduce((a, h) => a + (Number(h?.active) || 0), 0);
    busy = Math.max(heartbeatActive, running);
  } else if (!registry && queue) {
    workerSlots = running; // no heartbeat feed: busy == provisioned → utilization 1 while running
  }
  return {
    region,
    ts: new Date(clockFn()),
    workerSlots,
    busySlots: busy,
    queueDepth: pending,
    activeJobs: running,
    jobsCompleted,
    jobsFailed,
  };
}

const round3 = (n) => Math.round(Number(n) * 1000) / 1000;
