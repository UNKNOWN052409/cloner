// Ops-intelligence router (Phase 5.0 — workload/cost/scheduling/failure
// intelligence, task G3.3).
//
// INTEGRATOR MOUNT LINE (server.js is integrator-owned — do not edit there):
//
//   import { intelligenceRouter } from "./intelligence/intelligence-routes.js";
//   app.use("/api/intelligence", intelligenceRouter());   // real engines inside
//
// Authorization posture: an OPERATOR surface (same posture as the 4.0.8 admin
// surface and the 4.2.11 capacity router, routes-capacity.js) — authRequired
// resolves the session, then a server-side admin-role guard rejects anyone
// else with 403; anonymous callers get 401 before any data is touched.
//
// Endpoints (all under /api/intelligence):
//   GET  /workload/model                 → trained-model summary
//   POST /workload/train                 → refresh() from the real job history
//   POST /workload/predict               → { job } per-job runtime/resource/
//                                          failure prediction
//   POST /workload/forecast              → { horizonMs?, windowMs? } arrival +
//                                          aggregate demand forecast
//   POST /cost/predict                   → { scope?, job?, quantities? } credit-side
//                                          cost prediction (real compute-accounting model)
//   POST /cost/strategies                → { scope?, job?, regionPricing?,
//                                          peakWindows? } ordered cheaper-execution options
//   GET  /scheduling/state               → learner summary (per-region factors + failure rates)
//   POST /scheduling/observe             → { jobId?, regionId, predictedRuntimeMs?,
//                                          actualRuntimeMs?, outcome } observation ingest
//   POST /scheduling/ingest-history      → { records: [...] } historical outcome ingest
//   POST /scheduling/order               → { candidates, hardFilter?, explain? } learned
//                                          preference ordering (hard constraints first;
//                                          hardFilter is a NAME: "region_health" |
//                                          "region_enabled" — never caller-supplied code)
//   GET  /failures/classes               → known failure-class registry
//   POST /failures/classify              → { message?|error?|defectKind? } classification
//   GET  /failures/patterns              → repair-history pattern aggregate (real
//                                          .repair/history.jsonl scan)
//   POST /failures/remediation           → { message?|defectKind?|classId?, patterns? }
//                                          bounded remediation proposal
//
// Degradation contract: reads NEVER 500 on a degraded engine — a failing data
// source returns 200 with { degraded: true, reason } (deterministic fallbacks
// live in the engines); only genuinely bad REQUESTS get 400.
import { Router } from "express";
import { authRequired } from "../../auth/auth-middleware.js";
import { createWorkloadPredictor } from "./workload-prediction.js";
import { createCostPredictor } from "./cost-prediction.js";
import { createSchedulingLearner } from "./scheduling-learner.js";
import { FAILURE_CLASSES, classifyFailure, loadRepairPatterns, proposeRemediation } from "./failure-classifier.js";

const DEGRADABLE = /unavailable|unreachable|ECONNREFUSED|ETIMEDOUT|terminated|connect/i;

export function intelligenceRouter(deps = {}) {
  const auth = deps.authRequired || authRequired;
  const adminGuard = deps.adminGuard || ((req, res, next) => {
    if (req.userRole !== "admin") return res.status(403).json({ error: "insufficient permissions" });
    next();
  });

  const workload = deps.workload || createWorkloadPredictor();
  const cost = deps.cost || createCostPredictor({ workload });
  const learner = deps.learner || createSchedulingLearner();
  const patternsLoader = deps.loadRepairPatterns || loadRepairPatterns;
  const remediationProposer = deps.proposeRemediation || proposeRemediation;

  const router = Router();
  router.use(auth, adminGuard);

  // body must be a JSON object (bounded) — 400 otherwise
  const body = (req, res) => {
    const b = req.body;
    if (b === undefined) return {};
    if (!b || typeof b !== "object" || Array.isArray(b)) {
      res.status(400).json({ error: "request body must be a JSON object" });
      return null;
    }
    return b;
  };

  const degraded = (res, e) => res.status(200).json({ degraded: true, reason: String(e?.message || e).slice(0, 300) });
  const isDegradation = (e) => DEGRADABLE.test(String(e?.message || e));

  // ---- workload ----
  router.get("/workload/model", async (_req, res) => {
    try { res.json(workload.modelSummary()); } catch (e) { return degraded(res, e); }
  });
  router.post("/workload/train", async (_req, res) => {
    try { res.json(await workload.refresh()); } catch (e) { return degraded(res, e); }
  });
  router.post("/workload/predict", async (req, res) => {
    const b = body(req, res);
    if (b === null) return;
    try { res.json(workload.predict(b.job || b)); } catch (e) { return degraded(res, e); }
  });
  router.post("/workload/forecast", async (req, res) => {
    const b = body(req, res);
    if (b === null) return;
    try { res.json(workload.forecastWorkload({ horizonMs: b.horizonMs, windowMs: b.windowMs })); } catch (e) {
      if (/horizonMs/.test(String(e?.message || e))) return res.status(400).json({ error: e.message });
      return degraded(res, e);
    }
  });

  // ---- cost ----
  router.post("/cost/predict", async (req, res) => {
    const b = body(req, res);
    if (b === null) return;
    try { res.json(await cost.predictCost({ scope: b.scope, job: b.job, quantities: b.quantities })); } catch (e) {
      if (/must be a/.test(String(e?.message || e))) return res.status(400).json({ error: e.message });
      return degraded(res, e);
    }
  });
  router.post("/cost/strategies", async (req, res) => {
    const b = body(req, res);
    if (b === null) return;
    try { res.json(await cost.recommendStrategies({ scope: b.scope, job: b.job, quantities: b.quantities, regionPricing: b.regionPricing, peakWindows: b.peakWindows, tzOffsetMinutes: b.tzOffsetMinutes })); } catch (e) {
      if (/must be|not valid JSON/.test(String(e?.message || e))) return res.status(400).json({ error: e.message });
      return degraded(res, e);
    }
  });

  // ---- scheduling ----
  router.get("/scheduling/state", async (_req, res) => {
    try { res.json(learner.summarize()); } catch (e) { return degraded(res, e); }
  });
  router.post("/scheduling/observe", async (req, res) => {
    const b = body(req, res);
    if (b === null) return;
    const result = learner.observe(b);
    if (!result.accepted) return res.status(400).json({ error: result.reason });
    res.json(result);
  });
  router.post("/scheduling/ingest-history", async (req, res) => {
    const b = body(req, res);
    if (b === null) return;
    if (!Array.isArray(b.records)) return res.status(400).json({ error: "records must be an array" });
    res.json(learner.ingestHistory(b.records));
  });
  router.post("/scheduling/order", async (req, res) => {
    const b = body(req, res);
    if (b === null) return;
    if (!Array.isArray(b.candidates)) return res.status(400).json({ error: "candidates must be an array" });
    res.json(learner.applyOrdering(b.candidates, {
      hardFilter: typeof b.hardFilter === "string" ? hardFilterFromName(b.hardFilter) : null,
      explain: b.explain === true,
    }));
  });

  // ---- failures ----
  router.get("/failures/classes", (_req, res) => {
    res.json({ classes: FAILURE_CLASSES });
  });
  router.post("/failures/classify", (req, res) => {
    const b = body(req, res);
    if (b === null) return;
    res.json(classifyFailure(b));
  });
  router.get("/failures/patterns", async (req, res) => {
    try {
      const out = await patternsLoader({ maxProjects: boundedInt(req.query.maxProjects, 500), maxEntries: boundedInt(req.query.maxEntries, 10_000) });
      res.json(out);
    } catch (e) { return degraded(res, e); }
  });
  router.post("/failures/remediation", async (req, res) => {
    const b = body(req, res);
    if (b === null) return;
    try {
      const patterns = Array.isArray(b.patterns) ? b.patterns : (await patternsLoader({})).patterns;
      res.json(remediationProposer(b, { patterns, minPatternSuccessRate: b.minPatternSuccessRate, minPatternSamples: b.minPatternSamples, maxRemediationAttempts: b.maxRemediationAttempts }));
    } catch (e) {
      if (isDegradation(e)) return degraded(res, e);
      return res.status(400).json({ error: String(e?.message || e).slice(0, 300) });
    }
  });

  return router;
}

// named hard filters exposed over the wire (never arbitrary caller code):
//   "region_health"   — a candidate is feasible only when its `healthy` flag is true
//   "region_enabled"  — feasible only when `enabled` is not false
// Anything else → null (no filter): the learner's ordering stays a preference,
// hard constraints stay caller-owned.
function hardFilterFromName(name) {
  if (name === "region_health") return (c) => c.healthy === true;
  if (name === "region_enabled") return (c) => c.enabled !== false;
  return null;
}

function boundedInt(v, fallback) {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? Math.min(n, fallback) : fallback;
}
