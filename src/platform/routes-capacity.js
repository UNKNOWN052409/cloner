// Capacity dashboards API (task 4.2.11): per-region utilization, queue depth
// history, cost per job aggregates.
//
// INTEGRATOR MOUNT LINES (server.js is integrator-owned — do not edit there):
//
//   import { capacityRouter } from "./routes-capacity.js";
//   app.use("/api/capacity", capacityRouter());   // real DB pool inside
//
// Authorization posture: capacity dashboards are an OPERATOR surface (same
// posture as the 4.0.8 admin surface) — authRequired resolves the session,
// then a server-side admin-role guard rejects anyone else with 403. Anonymous
// callers get 401 before any data is touched. Ingest (POST /samples,
// POST /costs) sits behind the same guard: operators/workers push region
// samples and job costs with an admin credential (deliberately NOT
// anonymous-writable; a dedicated worker scope can be layered later).
//
// Endpoints (all under /api/capacity):
//   GET  /overview                 → full dashboard payload (window, totals,
//                                    regions[], queueDepthHistory, cost{})
//                                    ?windowMs=&bucketMs=&region=
//   GET  /regions                  → per-region aggregates only ?windowMs=&region=
//   GET  /queue-depth              → bucketed queue-depth history only
//                                    ?windowMs=&bucketMs=&region=
//   GET  /costs                    → cost-per-job aggregates only ?windowMs=&region=
//   GET  /samples/:region          → recent raw samples for one region
//                                    ?limit=&windowMs=
//   POST /samples                  → ingest one sample or an array (≤500):
//                                    { region, workerSlots, busySlots,
//                                      queueDepth, activeJobs, jobsCompleted,
//                                      jobsFailed, ts? }
//   POST /costs                    → ingest job cost { region, jobId?, status?,
//                                      costUsd, ts? }
//   POST /prune                    → retention prune ?olderThanMs=
//   GET  /capture?region=          → record ONE LIVE sample right now, derived
//                                    from the real clone-queue + worker
//                                    heartbeats (captureLiveSample), store it,
//                                    return it
import { Router } from "express";
import { authRequired } from "../auth/auth-middleware.js";
import { createCapacityAnalytics, captureLiveSample } from "../observability/capacity-analytics.js";

export function capacityRouter(deps = {}) {
  const analytics = deps.analytics || createCapacityAnalytics();
  const auth = deps.authRequired || authRequired;
  const adminGuard = deps.adminGuard || ((req, res, next) => {
    if (req.userRole !== "admin") return res.status(403).json({ error: "insufficient permissions" });
    next();
  });

  const router = Router();
  router.use(auth, adminGuard);

  // numeric query params (bounded again inside the engine)
  const windowOpts = (req) => ({
    windowMs: req.query.windowMs ? Number(req.query.windowMs) : undefined,
    bucketMs: req.query.bucketMs ? Number(req.query.bucketMs) : undefined,
    region: req.query.region ? String(req.query.region).slice(0, 64) : undefined,
  });

  router.get("/overview", async (req, res, next) => {
    try { res.json(await analytics.getCapacitySnapshot(windowOpts(req))); } catch (e) { next(e); }
  });

  router.get("/regions", async (req, res, next) => {
    try { res.json({ regions: await analytics.getRegionAggregates(windowOpts(req)) }); } catch (e) { next(e); }
  });

  router.get("/queue-depth", async (req, res, next) => {
    try { res.json(await analytics.getQueueDepthHistory(windowOpts(req))); } catch (e) { next(e); }
  });

  router.get("/costs", async (req, res, next) => {
    try { res.json({ cost: await analytics.getCostAggregates(windowOpts(req)) }); } catch (e) { next(e); }
  });

  router.get("/samples/:region", async (req, res, next) => {
    try {
      const limit = req.query.limit ? Number(req.query.limit) : undefined;
      const windowMs = req.query.windowMs ? Number(req.query.windowMs) : undefined;
      res.json(await analytics.listSamples(req.params.region, { limit, windowMs }));
    } catch (e) { next(e); }
  });

  // ingest — accepts a single sample object or an array / { samples: [...] }
  router.post("/samples", async (req, res, next) => {
    try {
      const body = req.body || {};
      const list = Array.isArray(body) ? body : Array.isArray(body.samples) ? body.samples : [body];
      if (!list.length || list.length > 500) return res.status(400).json({ error: "1..500 samples per request" });
      if (list.some((s) => !s || typeof s !== "object" || Array.isArray(s))) return res.status(400).json({ error: "each sample must be an object" });
      const inserted = Array.isArray(body) || Array.isArray(body.samples)
        ? await analytics.recordSamples(list)
        : await analytics.recordSample(body);
      res.status(201).json({ ok: true, count: Array.isArray(inserted) ? inserted.length : 1, samples: inserted });
    } catch (e) { next(e); }
  });

  router.post("/costs", async (req, res, next) => {
    try {
      const body = req.body || {};
      if (!body || typeof body !== "object" || Array.isArray(body)) return res.status(400).json({ error: "body must be an object" });
      if (body.costUsd === undefined) return res.status(400).json({ error: "costUsd required" });
      const inserted = await analytics.recordJobCost(body);
      res.status(201).json({ ok: true, cost: inserted });
    } catch (e) { next(e); }
  });

  router.post("/prune", async (req, res, next) => {
    try {
      const olderThanMs = req.query.olderThanMs ? Number(req.query.olderThanMs) : undefined;
      res.json(await analytics.pruneCapacityData({ olderThanMs }));
    } catch (e) { next(e); }
  });

  // one REAL live capture: reads the live clone-queue registry + metrics
  // registry worker heartbeats, persists it, returns the stored sample
  router.get("/capture", async (req, res, next) => {
    try {
      const { getCloneQueue } = await import("../queues/clone-queue.js");
      const { getMetricsRegistry } = await import("./metrics-registry.js");
      const region = req.query.region ? String(req.query.region).slice(0, 64) : "default";
      const live = captureLiveSample({ region, queue: getCloneQueue(), registry: getMetricsRegistry() });
      const stored = await analytics.recordSample(live);
      res.status(201).json({ ok: true, sample: stored });
    } catch (e) { next(e); }
  });

  // error handler: honest JSON errors, message truncated like sibling routers
  router.use((err, _req, res, _next) => {
    res.status(Number(err?.status) || 500).json({ error: String(err?.message || err).slice(0, 300) });
  });

  return router;
}
