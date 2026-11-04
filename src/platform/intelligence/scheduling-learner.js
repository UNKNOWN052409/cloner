// Scheduling learner (Phase 5.0 — scheduling-intelligence area, task G3.3).
//
// Learns from ACTUAL execution outcomes (observed vs predicted runtime, and
// job outcomes) to produce a scheduling PREFERENCE ordering across regions —
// while hard scheduling constraints stay OUTSIDE the learner (the 4.2.13 +
// Phase 5.0 law: "learn from actual execution outcomes while preserving hard
// scheduling constraints"). This module never sees hard-infeasible candidates:
// applyOrdering() takes the CALLER's already-hard-filtered candidate list, and
// when a hardFilter is passed it runs BEFORE any learned scoring — an
// infeasible candidate is excluded even when its learned score is the best.
//
// Feeds (all real, already landed):
//   • runtime observations — the job-completion path (clone-queue terminal
//     events + compute_job_costs settlements) calls observe({ jobId, regionId,
//     predictedRuntimeMs, actualRuntimeMs, outcome }).
//   • historical outcomes — ingestHistory() accepts rows shaped like
//     capacity_job_costs (region/status/ts) and compute_job_costs
//     (task_key/runtime_ms): status trains per-region failure statistics;
//     ratios train only when both predicted and actual runtimes are present.
//
// Model (deterministic, bounded, explainable — no ML, matching the Phase 5.0
// note "Do not require machine learning for the first implementation"):
//   runtime factor per region = median(actual/predicted ratios), clamped to
//     [minFactor, maxFactor], applied only with >= minSamples ratios;
//     unlearned ⇒ factor 1 (never guesses from too little evidence).
//   failure rate per region = (failed + timedOut + 1) / (known + 4) —
//     Beta(1,3) Laplace smoothing, which doubles as an uncertainty penalty
//     (a zero-failure region with 2 samples scores 0.167, with 100 samples
//     0.0096 — thin evidence is distrusted, deterministically).
//   score(region) = runtimeFactor × (1 + failureWeight × failureRate);
//     lower is better. Ties break by regionId asc. Cancellations are operator
//     actions, not failures, and are excluded from the failure rate.
import { median } from "./robust-stats.js";

const DEFAULTS = Object.freeze({
  minSamples: 8,            // ratios required before a learned factor is applied
  minFactor: 0.25,          // learned factors are clamped to [minFactor, maxFactor]
  maxFactor: 4,
  failureWeight: 0.5,       // score multiplier contribution of the failure rate
  defaultRuntimeMs: 5 * 60_000, // fallback predicted runtime for history rows
  maxObservations: 10_000,  // global observation ring cap
  maxRatiosPerRegion: 1_000,
});

export const OUTCOMES = Object.freeze(["success", "failed", "timeout", "cancelled"]);
const KNOWN_FOR_FAILURE_RATE = new Set(["success", "failed", "timeout"]);

// map the real queue status vocabulary (clone-queue: completed,
// completed_with_limitations, error, cancelled; plus "timeout") onto learner
// outcomes. Unknown statuses → null (ignored, never guessed).
export function outcomeFromStatus(status) {
  const s = String(status || "").toLowerCase();
  if (s === "completed" || s === "completed_with_limitations") return "success";
  if (s === "error" || s === "failed") return "failed";
  if (s === "timeout" || s.endsWith("_timeout")) return "timeout";
  if (s === "cancelled" || s === "canceled") return "cancelled";
  return null;
}

export function sanitizeRegionId(regionId) {
  const s = String(regionId ?? "").replace(/[^A-Za-z0-9_.-]/g, "_").slice(0, 64);
  return s || "unknown";
}

const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
};

export function createSchedulingLearner({ now = null, config = {} } = {}) {
  const cfg = { ...DEFAULTS, ...config };
  const nowMs = () => (typeof now === "function" ? now() : now != null ? Number(now) : Date.now());

  // regionId → { observations: n, ratios: [...], known, failed }
  const regions = new Map();
  let totalObservations = 0;

  function regionBucket(regionId, create = true) {
    const id = sanitizeRegionId(regionId);
    let b = regions.get(id);
    if (!b && create) {
      b = { observations: 0, ratios: [], known: 0, failed: 0 };
      regions.set(id, b);
    }
    return { id, bucket: b || null };
  }

  // ---- learning -------------------------------------------------------------

  // observe({ jobId, regionId, predictedRuntimeMs, actualRuntimeMs, outcome, at })
  // → { accepted, reason?, regionId, samples } — validation errors are
  // returned, never thrown (learning must never break a scheduling path).
  function observe({ jobId = null, regionId, predictedRuntimeMs = null, actualRuntimeMs = null, outcome, at = null } = {}) {
    if (typeof regionId !== "string" || !regionId.trim()) {
      return { accepted: false, reason: "regionId is required" };
    }
    // Accept learner outcomes (success/failed/timeout/cancelled) AND the real
    // queue status vocabulary (completed/error/...) via outcomeFromStatus —
    // the job-completion path reports statuses, not learner tokens. Anything
    // else is rejected, never guessed.
    let oc = String(outcome || "").toLowerCase();
    if (!OUTCOMES.includes(oc)) oc = outcomeFromStatus(oc) || "";
    if (!OUTCOMES.includes(oc)) {
      return { accepted: false, reason: `outcome must be one of ${OUTCOMES.join(", ")} (or a known queue status like completed/error/timeout/cancelled)` };
    }
    if (totalObservations >= cfg.maxObservations) {
      return { accepted: false, reason: `observation cap reached (${cfg.maxObservations}) — call reset() or raise config.maxObservations` };
    }
    const { id, bucket } = regionBucket(regionId, true);
    const predicted = num(predictedRuntimeMs);
    const actual = num(actualRuntimeMs);
    if (predicted && actual) {
      bucket.ratios.push(Math.min(cfg.maxFactor, Math.max(cfg.minFactor, actual / predicted)));
      if (bucket.ratios.length > cfg.maxRatiosPerRegion) bucket.ratios.splice(0, bucket.ratios.length - cfg.maxRatiosPerRegion);
    }
    if (KNOWN_FOR_FAILURE_RATE.has(oc)) {
      bucket.known += 1;
      if (oc !== "success") bucket.failed += 1; // failed + timeout
    }
    bucket.observations += 1;
    totalObservations += 1;
    return { accepted: true, regionId: id, jobId: jobId == null ? null : String(jobId).slice(0, 200), outcome: oc, at: at == null ? new Date(nowMs()).toISOString() : String(at), samples: bucket.observations };
  }

  // ingestHistory(records) → { ingested, skipped, byRegion } — accepts
  // snake_case (capacity_job_costs / compute_job_costs rows) or camelCase
  // records: { jobId|job_id|task_key, regionId|region, status|outcome,
  // predictedRuntimeMs?, actualRuntimeMs|runtimeMs|runtime_ms }.
  function ingestHistory(records) {
    let ingested = 0;
    let skipped = 0;
    const byRegion = {};
    for (const raw of Array.isArray(records) ? records : []) {
      if (!raw || typeof raw !== "object") { skipped += 1; continue; }
      const regionId = raw.regionId ?? raw.region;
      const status = raw.status ?? raw.outcome;
      const outcome = raw.outcome && OUTCOMES.includes(String(raw.outcome)) ? String(raw.outcome) : outcomeFromStatus(status);
      if (!outcome) { skipped += 1; continue; } // unknown status — never guessed
      const predicted = num(raw.predictedRuntimeMs ?? raw.predicted_runtime_ms ?? raw.estimatedRuntimeMs);
      const actual = num(raw.actualRuntimeMs ?? raw.actual_runtime_ms ?? raw.runtimeMs ?? raw.runtime_ms);
      const res = observe({ jobId: raw.jobId ?? raw.job_id ?? raw.task_key ?? null, regionId, predictedRuntimeMs: predicted, actualRuntimeMs: actual, outcome });
      if (!res.accepted) { skipped += 1; continue; }
      ingested += 1;
      byRegion[res.regionId] = (byRegion[res.regionId] || 0) + 1;
    }
    return { ingested, skipped, byRegion };
  }

  // ---- querying -------------------------------------------------------------

  function failureRateOf(bucket) {
    return (bucket.failed + 1) / (bucket.known + 4); // Beta(1,3) smoothing
  }

  function factorOf(bucket) {
    if (bucket.ratios.length < cfg.minSamples) return { factor: null, learned: false, samples: bucket.ratios.length };
    return { factor: clampFactor(median(bucket.ratios)), learned: true, samples: bucket.ratios.length };
  }

  function clampFactor(f) {
    return Math.min(cfg.maxFactor, Math.max(cfg.minFactor, f));
  }

  // regionStats(regionId) → learned statistics + explain strings.
  function regionStats(regionId) {
    const { id, bucket } = regionBucket(regionId, false);
    if (!bucket) {
      return { regionId: sanitizeRegionId(regionId), observations: 0, runtimeFactor: { factor: null, learned: false, samples: 0 }, failureRate: { value: 0.25, known: 0, failed: 0, learned: false }, score: 1 * (1 + cfg.failureWeight * 0.25), learned: false, explain: ["no observations — neutral factor 1, prior failure rate 0.25"] };
    }
    const f = factorOf(bucket);
    const fr = failureRateOf(bucket);
    const effFactor = f.learned ? f.factor : 1;
    const score = round6(effFactor * (1 + cfg.failureWeight * fr));
    const explain = [];
    if (f.learned) explain.push(`runtime factor = median of ${f.samples} actual/predicted ratio(s) = ${round6(f.factor)} (clamped to [${cfg.minFactor}, ${cfg.maxFactor}])`);
    else explain.push(`runtime factor neutral (1.0): only ${f.samples}/${cfg.minSamples} ratio sample(s) — too little evidence to learn from`);
    explain.push(`failure rate = (${bucket.failed} + 1) / (${bucket.known} + 4) = ${round6(fr)} — cancellations excluded (operator actions, not failures)`);
    return {
      regionId: id,
      observations: bucket.observations,
      runtimeFactor: f,
      failureRate: { value: round6(fr), known: bucket.known, failed: bucket.failed, learned: bucket.known > 0 },
      score,
      learned: f.learned,
      explain,
    };
  }

  // applyOrdering(candidates, { hardFilter }) — THE documented hard-constraint
  // boundary. candidates: [{ regionId, ... }]. hardFilter(c) → boolean runs
  // FIRST; infeasible candidates are excluded before any learned scoring and
  // recorded in `excluded` (never scored, never reordered, never resurrected).
  function applyOrdering(candidates, { hardFilter = null, explain = false } = {}) {
    if (!Array.isArray(candidates)) throw new Error("applyOrdering: candidates must be an array");
    const excluded = [];
    const feasible = [];
    for (const c of candidates) {
      if (!c || typeof c !== "object" || !c.regionId) {
        excluded.push({ candidate: c, reason: "missing regionId" });
        continue;
      }
      if (typeof hardFilter === "function") {
        let ok = false;
        try { ok = hardFilter(c) === true; } catch (e) {
          excluded.push({ candidate: c, reason: `hardFilter threw: ${String(e?.message || e).slice(0, 120)}` });
          continue;
        }
        if (!ok) { excluded.push({ candidate: c, reason: "hard filter infeasible (excluded before learned scoring)" }); continue; }
      }
      feasible.push(c);
    }

    const evaluations = feasible.map((c) => {
      const id = sanitizeRegionId(c.regionId);
      const st = regionStats(id);
      return { candidate: c, regionId: id, runtimeFactor: st.runtimeFactor.factor, failureRate: st.failureRate.value, score: st.score, learned: st.learned };
    });
    evaluations.sort((a, b) => a.score - b.score || a.regionId.localeCompare(b.regionId));

    const out = {
      ordered: evaluations.map((e) => e.candidate),
      evaluations,
      excluded,
      config: { minSamples: cfg.minSamples, failureWeight: cfg.failureWeight, factorClamp: [cfg.minFactor, cfg.maxFactor] },
    };
    if (explain) {
      out.explain = evaluations.map((e) => {
        const st = regionStats(e.regionId);
        return `${e.regionId}: score ${e.score} = factor ${e.runtimeFactor ?? "1 (unlearned)"} × (1 + ${cfg.failureWeight} × failureRate ${e.failureRate}) — ${st.explain.join("; ")}`;
      });
      if (excluded.length) out.explain.push(`${excluded.length} candidate(s) excluded by hard constraints before learned scoring`);
    }
    return out;
  }

  function preferredRegion(candidates, opts = {}) {
    const res = applyOrdering(candidates, opts);
    return res.ordered[0] ?? null;
  }

  // ---- lifecycle ------------------------------------------------------------

  function reset() {
    regions.clear();
    totalObservations = 0;
  }

  function summarize() {
    const byRegion = {};
    for (const [id] of regions.entries()) {
      const st = regionStats(id);
      byRegion[id] = { observations: st.observations, runtimeFactor: st.runtimeFactor, failureRate: st.failureRate, score: st.score, learned: st.learned };
    }
    return { totalObservations, regions: byRegion, config: { ...cfg } };
  }

  function toState() {
    return {
      version: 1,
      totalObservations,
      regions: Object.fromEntries([...regions.entries()].map(([id, b]) => [id, { observations: b.observations, ratios: b.ratios.slice(-cfg.maxRatiosPerRegion), known: b.known, failed: b.failed }])),
    };
  }

  function fromState(state) {
    if (!state || typeof state !== "object" || state.version !== 1) throw new Error("fromState: expected a toState() payload (version 1)");
    reset();
    for (const [id, b] of Object.entries(state.regions || {})) {
      const { bucket } = regionBucket(id, true);
      bucket.observations = Number(b.observations) || 0;
      bucket.ratios = (b.ratios || []).filter((n) => Number.isFinite(n) && n > 0).slice(-cfg.maxRatiosPerRegion);
      bucket.known = Number(b.known) || 0;
      bucket.failed = Number(b.failed) || 0;
      totalObservations += bucket.observations;
    }
    return summarize();
  }

  return { observe, ingestHistory, regionStats, applyOrdering, preferredRegion, reset, summarize, toState, fromState, outcomeFromStatus };
}

function round6(x) {
  return Math.round(Number(x) * 1e6) / 1e6;
}
