// Workload prediction (Phase 5.0 — workload-prediction area, task G3.3).
//
// Predicts, BEFORE a job runs: job runtime, resource demand (browser slots,
// artifact bytes) and failure probability — trained on the job history the
// platform ALREADY records (4.2.11/4.2.12 landed the sources, none invented
// here):
//
//   • compute_job_costs   per-job measured quantities (runtime_ms,
//                         browser_slots, artifact_bytes, cost_total) — the
//                         accounting source of truth (migration 030)
//   • capacity_job_costs  per-job outcome (status: completed / error /
//                         cancelled ...) and region (migration 017)
//   • capacity_samples    per-region time series (arrival-rate forecast)
//
// The training data loader is INJECTABLE (dataSource.listJobs() or
// dataSource.query(text, params)). The DEFAULT is the real shared PostgreSQL
// pool (lazy import of ../database/client.js, same posture as
// src/observability/capacity-analytics.js), joining the two job tables on the
// job id (compute_job_costs.task_key == capacity_job_costs.job_id). When the
// database is unreachable the predictor degrades to a DETERMINISTIC FALLBACK —
// config class defaults + a fixed prior failure probability — and marks every
// such prediction `fallback: true`. Prediction never throws on missing data;
// a missing database is an operational fact, not a crash.
//
// Model: deterministic robust statistics, fully explainable (the plan's Phase
// 5.0 note: "Do not require machine learning"; cost-aware scheduling also
// demands determinism):
//   runtime      median of the job class's historical runtimes, interval =
//                [p10, p90] empirical quantiles of the same samples
//   resources    median browser slots (ceil) and artifact bytes (ceil) of the
//                class; region-scoped when the region has >= minRegionSamples
//   failure      Laplace-smoothed empirical rate (failures + 1) / (known + 4)
//                — with zero observations this collapses to 0.25, the same
//                value the fallback prior uses (Beta(1,3) prior)
//   arrivals     trailing-window job rate → horizon forecast with a Poisson
//                normal approximation (mean ± 1.96·sqrt(mean), clamped ≥ 0)
//
// Classing: a job lands in one of "small" | "medium" | "large" either
// explicitly (job.jobClass) or by its estimatedRuntimeMs (small < 5 min,
// medium < 20 min, large otherwise — config.classThresholdsMs). History rows
// are classed by their MEASURED runtime. Unknown classes fall back to "large"
// territory only through the explicit-config path, never silently.
import { median, quantile } from "./robust-stats.js";

const MINUTE_MS = 60_000;

const DEFAULTS = Object.freeze({
  classThresholdsMs: Object.freeze({ small: 5 * MINUTE_MS, medium: 20 * MINUTE_MS }),
  classDefaultRuntimeMs: Object.freeze({ small: 3 * MINUTE_MS, medium: 10 * MINUTE_MS, large: 45 * MINUTE_MS }),
  classDefaultBrowserSlots: Object.freeze({ small: 1, medium: 2, large: 4 }),
  classDefaultArtifactBytes: Object.freeze({ small: 512 * 1024, medium: 4 * 1024 * 1024, large: 32 * 1024 * 1024 }),
  minRegionSamples: 8,     // region-scoped stats need at least this many
  minRuntimeSamples: 3,    // quantile intervals need at least this many
  arrivalWindowMs: 24 * 60 * MINUTE_MS, // trailing window for the arrival rate
  historyLimit: 2000,      // bound on rows pulled from the default loader
});

// explicit classing: explicit jobClass wins; else thresholds on the estimate.
export function classifyJobClass(job = {}, config = {}) {
  const cfg = { ...DEFAULTS, ...config };
  const explicit = String(job.jobClass || "").toLowerCase();
  if (["small", "medium", "large"].includes(explicit)) return explicit;
  const ms = Number(job.estimatedRuntimeMs);
  const runtime = Number.isFinite(ms) && ms >= 0 ? ms : cfg.classDefaultRuntimeMs.medium;
  if (runtime < cfg.classThresholdsMs.small) return "small";
  if (runtime < cfg.classThresholdsMs.medium) return "medium";
  return "large";
}

// sanitize an injected/history row into the internal record shape; returns
// null for rows that carry nothing usable.
export function normalizeJobRecord(row, tsFallback = null) {
  if (!row || typeof row !== "object") return null;
  const num = (v) => {
    const n = Number(v);
    return Number.isFinite(n) && n >= 0 ? n : null;
  };
  const runtimeMs = num(row.runtimeMs ?? row.runtime_ms);
  const browserSlots = num(row.browserSlots ?? row.browser_slots);
  const artifactBytes = num(row.artifactBytes ?? row.artifact_bytes);
  const tsRaw = row.ts ?? row.created_at ?? row.createdAt;
  let ts = null;
  if (tsRaw != null) {
    const d = Number.isFinite(Number(tsRaw)) && String(tsRaw).trim() !== "" ? new Date(Number(tsRaw)) : new Date(tsRaw);
    if (!isNaN(d)) ts = d.toISOString();
  }
  if (!ts) ts = tsFallback;
  const status = row.status == null ? null : String(row.status).slice(0, 64);
  const region = row.region == null || row.region === "" ? null : String(row.region).replace(/[^A-Za-z0-9_.-]/g, "_").slice(0, 64);
  if (runtimeMs == null && browserSlots == null && artifactBytes == null && !status) return null;
  return { jobId: row.jobId ?? row.job_id ?? row.task_key ?? row.taskKey ?? null, runtimeMs, browserSlots, artifactBytes, status, region, ts };
}

const KNOWN_OUTCOMES = new Set(["completed", "completed_with_limitations", "error", "cancelled", "timeout"]);
const FAILURE_OUTCOMES = new Set(["error", "timeout"]);

export function outcomeOf(status) {
  const s = String(status || "").toLowerCase();
  if (!s || !KNOWN_OUTCOMES.has(s)) return "unknown";
  if (FAILURE_OUTCOMES.has(s)) return "failed";
  if (s === "cancelled") return "cancelled";
  return "success";
}

export function createWorkloadPredictor({ dataSource = null, now = null, config = {} } = {}) {
  const cfg = { ...DEFAULTS, ...config };
  const nowMs = () => (typeof now === "function" ? now() : now != null ? Number(now) : Date.now());

  // model: classId (+ optional regionId) → aggregate statistics
  let model = emptyModel();

  function emptyModel() {
    return {
      trainedAt: null,
      jobCount: 0,
      classes: {}, // classId → { runtimes[], slots[], bytes[], outcomes{known,failed,cancelled}, byRegion: Map-ish }
      arrival: { tsSamples: [] }, // trailing ts list (bounded) for the arrival rate
    };
  }

  function classOf(record) {
    return classifyJobClass({ jobClass: record.jobClass, estimatedRuntimeMs: record.runtimeMs ?? undefined }, cfg);
  }

  function addRecord(record) {
    const cls = classOf(record);
    const bucket = model.classes[cls] || (model.classes[cls] = {
      runtimes: [], slots: [], bytes: [],
      known: 0, failed: 0,
      regions: new Map(), // regionId → { runtimes, known, failed }
    });
    if (Number.isFinite(record.runtimeMs) && record.runtimeMs > 0) bucket.runtimes.push(record.runtimeMs);
    if (Number.isFinite(record.browserSlots)) bucket.slots.push(record.browserSlots);
    if (Number.isFinite(record.artifactBytes)) bucket.bytes.push(record.artifactBytes);
    const outcome = outcomeOf(record.status);
    if (outcome === "success") bucket.known += 1;
    else if (outcome === "failed") { bucket.known += 1; bucket.failed += 1; }
    if (record.region && (outcome === "success" || outcome === "failed")) {
      const r = bucket.regions.get(record.region) || { runtimes: [], known: 0, failed: 0 };
      if (Number.isFinite(record.runtimeMs) && record.runtimeMs > 0) r.runtimes.push(record.runtimeMs);
      r.known += 1;
      if (outcome === "failed") r.failed += 1;
      bucket.regions.set(record.region, r);
    }
    if (record.ts) {
      model.arrival.tsSamples.push(record.ts);
      if (model.arrival.tsSamples.length > 50000) model.arrival.tsSamples.splice(0, model.arrival.tsSamples.length - 50000);
    }
    model.jobCount += 1;
  }

  // ---- training -----------------------------------------------------------

  // DEFAULT data source: the real DB. Lazy import — importing this module
  // never opens a connection (offline CI contract), and a failing query is
  // reported, never thrown.
  async function defaultLoadJobs() {
    const { query } = await import("../../database/client.js");
    const r = await query(
      `SELECT c.task_key AS job_id, c.runtime_ms, c.browser_slots, c.artifact_bytes,
              c.created_at AS ts,
              j.status, j.region
       FROM compute_job_costs c
       LEFT JOIN LATERAL (
         SELECT status, region FROM capacity_job_costs j2
         WHERE j2.job_id = c.task_key
         ORDER BY j2.ts DESC LIMIT 1
       ) j ON TRUE
       ORDER BY c.created_at DESC
       LIMIT $1`,
      [cfg.historyLimit]
    );
    return r.rows;
  }

  async function loadHistoryRows() {
    if (dataSource && typeof dataSource.listJobs === "function") return dataSource.listJobs();
    if (dataSource && typeof dataSource.query === "function") return (await dataSource.query(
      `SELECT c.task_key AS job_id, c.runtime_ms, c.browser_slots, c.artifact_bytes,
              c.created_at AS ts, j.status, j.region
       FROM compute_job_costs c
       LEFT JOIN LATERAL (
         SELECT status, region FROM capacity_job_costs j2
         WHERE j2.job_id = c.task_key
         ORDER BY j2.ts DESC LIMIT 1
       ) j ON TRUE
       ORDER BY c.created_at DESC
       LIMIT $1`,
      [cfg.historyLimit]
    )).rows;
    return defaultLoadJobs();
  }

  // refresh() → { trained, jobCount, skipped, reason?, byClass } — re-trains
  // from the data source. A failing source (e.g. PostgreSQL down) returns
  // { trained: false, reason } and leaves any previously-trained model intact.
  async function refresh() {
    let rows;
    try {
      rows = await loadHistoryRows();
    } catch (e) {
      return { trained: false, jobCount: model.jobCount, skipped: true, reason: `history source unavailable: ${String(e?.message || e).slice(0, 200)}`, byClass: {} };
    }
    model = emptyModel();
    let skipped = 0;
    for (const raw of rows || []) {
      const rec = normalizeJobRecord(raw);
      if (!rec) { skipped += 1; continue; }
      addRecord(rec);
    }
    model.trainedAt = new Date(nowMs()).toISOString();
    return { trained: true, jobCount: model.jobCount, skipped, byClass: classSummary() };
  }

  function classSummary() {
    const out = {};
    for (const [cls, b] of Object.entries(model.classes)) {
      out[cls] = {
        runtimeSamples: b.runtimes.length,
        knownOutcomes: b.known,
        failures: b.failed,
        regions: b.regions.size,
      };
    }
    return out;
  }

  // seed training from an in-memory list (tests / offline runs); identical
  // semantics to refresh() but never touches the DB.
  function trainFromRecords(records) {
    model = emptyModel();
    let skipped = 0;
    for (const raw of Array.isArray(records) ? records : []) {
      const rec = normalizeJobRecord(raw);
      if (!rec) { skipped += 1; continue; }
      addRecord(rec);
    }
    model.trainedAt = new Date(nowMs()).toISOString();
    return { trained: true, jobCount: model.jobCount, skipped, byClass: classSummary() };
  }

  // ---- prediction ---------------------------------------------------------

  function pickSamples(cls, regionId) {
    const b = model.classes[cls];
    if (!b) return null;
    if (regionId) {
      const r = b.regions.get(regionId);
      if (r && r.runtimes.length >= cfg.minRegionSamples) {
        return { runtimes: r.runtimes, known: r.known, failed: r.failed, scope: "region" };
      }
    }
    return { runtimes: b.runtimes, known: b.known, failed: b.failed, scope: "class" };
  }

  function laplaceFailureRate(known, failed) {
    // Beta(1,3) prior: (failed + 1) / (known + 4). With zero observations this
    // is exactly 0.25 — the same value the no-data fallback advertises.
    return (failed + 1) / (known + 4);
  }

  // predict(job) → {
  //   jobClass, basis: "history" | "fallback",
  //   runtimeMs: { estimate, low, high, scope, samples },
  //   resources: { browserSlots, artifactBytes, samples },
  //   failureProbability: { value, knownOutcomes, failures, scope },
  //   fallback: bool, explain: string[]
  // }
  function predict(job = {}) {
    const cls = classifyJobClass(job, cfg);
    const regionId = job.regionId ? String(job.regionId).replace(/[^A-Za-z0-9_.-]/g, "_").slice(0, 64) : null;
    const explain = [];
    const samples = pickSamples(cls, regionId) || { runtimes: [], known: 0, failed: 0, scope: "none" };

    // runtime
    let runtime;
    if (samples.runtimes.length >= cfg.minRuntimeSamples) {
      const estimate = median(samples.runtimes);
      runtime = {
        estimate: Math.round(estimate),
        low: Math.round(quantile(samples.runtimes, 0.1)),
        high: Math.round(quantile(samples.runtimes, 0.9)),
        scope: samples.scope,
        samples: samples.runtimes.length,
      };
      explain.push(`runtime = median of ${samples.runtimes.length} ${cls} runtime sample(s) (${samples.scope} scope); interval = p10..p90`);
    } else {
      const estimate = Number.isFinite(Number(job.estimatedRuntimeMs)) && Number(job.estimatedRuntimeMs) > 0
        ? Number(job.estimatedRuntimeMs)
        : cfg.classDefaultRuntimeMs[cls];
      runtime = { estimate: Math.round(estimate), low: Math.round(estimate * 0.5), high: Math.round(estimate * 1.5), scope: "default", samples: samples.runtimes.length };
      explain.push(`runtime fallback: fewer than ${cfg.minRuntimeSamples} sample(s) — used ${Number.isFinite(Number(job.estimatedRuntimeMs)) && Number(job.estimatedRuntimeMs) > 0 ? "caller estimate" : `${cls} class default`}`);
    }

    // resources
    const b = model.classes[cls];
    let slots;
    let bytes;
    if (b && b.slots.length >= cfg.minRuntimeSamples) {
      slots = Math.max(0, Math.ceil(median(b.slots)));
      explain.push(`browserSlots = ceil(median of ${b.slots.length} sample(s))`);
    } else {
      slots = cfg.classDefaultBrowserSlots[cls];
      explain.push("browserSlots fallback: class default");
    }
    if (b && b.bytes.length >= cfg.minRuntimeSamples) {
      bytes = Math.max(0, Math.ceil(median(b.bytes)));
      explain.push(`artifactBytes = ceil(median of ${b.bytes.length} sample(s))`);
    } else {
      bytes = cfg.classDefaultArtifactBytes[cls];
      explain.push("artifactBytes fallback: class default");
    }

    // failure probability
    const p = laplaceFailureRate(samples.known, samples.failed);
    const fallback = samples.runtimes.length < cfg.minRuntimeSamples || samples.known === 0;
    if (samples.known > 0) explain.push(`failureProbability = (${samples.failed} + 1) / (${samples.known} + 4) — Laplace-smoothed empirical rate, ${samples.scope} scope`);
    else explain.push("failureProbability fallback: Beta(1,3) prior with no observed outcomes");

    return {
      jobClass: cls,
      basis: fallback ? "fallback" : "history",
      runtimeMs: runtime,
      resources: { browserSlots: slots, artifactBytes: bytes, samples: b ? b.slots.length : 0 },
      failureProbability: { value: round6(p), knownOutcomes: samples.known, failures: samples.failed, scope: samples.scope },
      fallback,
      explain,
    };
  }

  // ---- fleet-level arrival forecast ---------------------------------------

  // forecastWorkload({ horizonMs }) → expected job count + aggregate demand
  // for the horizon, from the trailing-window arrival rate of the trained
  // history. Poisson normal approximation for the interval (documented).
  function forecastWorkload({ horizonMs = 60 * MINUTE_MS, windowMs = null } = {}) {
    const h = Number(horizonMs);
    if (!Number.isFinite(h) || h <= 0) throw new Error("forecastWorkload: horizonMs must be a positive number");
    const win = Number.isFinite(Number(windowMs)) && Number(windowMs) > 0 ? Number(windowMs) : cfg.arrivalWindowMs;
    const cutoff = nowMs() - win;
    const recent = model.arrival.tsSamples.map((t) => Date.parse(t)).filter((t) => Number.isFinite(t) && t >= cutoff);
    const ratePerMs = recent.length / win; // jobs per ms
    const mean = ratePerMs * h;
    const sd = Math.sqrt(Math.max(0, mean));
    const low = Math.max(0, mean - 1.96 * sd);
    const high = mean + 1.96 * sd;

    // aggregate demand: horizon mean jobs × the platform median per-job demand
    const allRuntimes = [];
    const allSlots = [];
    const allBytes = [];
    for (const b of Object.values(model.classes)) {
      allRuntimes.push(...b.runtimes);
      allSlots.push(...b.slots);
      allBytes.push(...b.bytes);
    }
    const jobRuntime = allRuntimes.length ? median(allRuntimes) : cfg.classDefaultRuntimeMs.medium;
    const jobSlots = allSlots.length ? median(allSlots) : cfg.classDefaultBrowserSlots.medium;
    const jobBytes = allBytes.length ? median(allBytes) : cfg.classDefaultArtifactBytes.medium;

    return {
      horizonMs: h,
      windowMs: win,
      arrivalRatePerHour: round6(ratePerMs * 3_600_000),
      jobs: {
        expected: round6(mean),
        low: round6(low),
        high: round6(high),
        method: recent.length ? "poisson-normal-approx (mean ± 1.96·sqrt(mean))" : "prior-zero",
        samples: recent.length,
      },
      aggregateDemand: {
        runtimeMs: round6(mean * jobRuntime),
        browserSlotSeconds: round6(mean * jobSlots * (jobRuntime / 1000)),
        artifactBytes: round6(mean * jobBytes),
        perJobBasis: { runtimeMs: Math.round(jobRuntime), browserSlots: Math.ceil(jobSlots), artifactBytes: Math.ceil(jobBytes), samples: allRuntimes.length },
      },
      fallback: recent.length === 0,
    };
  }

  // ---- state (persistence / inspection) -----------------------------------

  function toState() {
    const classes = {};
    for (const [cls, b] of Object.entries(model.classes)) {
      classes[cls] = {
        runtimes: b.runtimes.slice(-5000),
        slots: b.slots.slice(-5000),
        bytes: b.bytes.slice(-5000),
        known: b.known,
        failed: b.failed,
        regions: Object.fromEntries([...b.regions.entries()].map(([k, v]) => [k, { runtimes: v.runtimes.slice(-2000), known: v.known, failed: v.failed }])),
      };
    }
    return { version: 1, trainedAt: model.trainedAt, jobCount: model.jobCount, classes, arrival: { tsSamples: model.arrival.tsSamples.slice(-5000) } };
  }

  function fromState(state) {
    if (!state || typeof state !== "object" || state.version !== 1) throw new Error("fromState: expected a toState() payload (version 1)");
    model = emptyModel();
    model.trainedAt = state.trainedAt || null;
    model.jobCount = Number(state.jobCount) || 0;
    for (const [cls, b] of Object.entries(state.classes || {})) {
      const bucket = model.classes[cls] || (model.classes[cls] = { runtimes: [], slots: [], bytes: [], known: 0, failed: 0, regions: new Map() });
      bucket.runtimes = (b.runtimes || []).filter((n) => Number.isFinite(n) && n > 0);
      bucket.slots = (b.slots || []).filter((n) => Number.isFinite(n) && n >= 0);
      bucket.bytes = (b.bytes || []).filter((n) => Number.isFinite(n) && n >= 0);
      bucket.known = Number(b.known) || 0;
      bucket.failed = Number(b.failed) || 0;
      for (const [k, v] of Object.entries(b.regions || {})) {
        bucket.regions.set(k, { runtimes: (v.runtimes || []).filter((n) => Number.isFinite(n) && n > 0), known: Number(v.known) || 0, failed: Number(v.failed) || 0 });
      }
    }
    model.arrival.tsSamples = (state.arrival?.tsSamples || []).filter((t) => Number.isFinite(Date.parse(t)));
    return { jobCount: model.jobCount, classes: classSummary() };
  }

  return {
    refresh,
    trainFromRecords,
    predict,
    forecastWorkload,
    classifyJobClass: (job) => classifyJobClass(job, cfg),
    modelSummary: () => ({ trainedAt: model.trainedAt, jobCount: model.jobCount, byClass: classSummary() }),
    toState,
    fromState,
  };
}

function round6(x) {
  return Math.round(Number(x) * 1e6) / 1e6;
}
