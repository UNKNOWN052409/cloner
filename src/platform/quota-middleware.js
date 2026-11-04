// Quota enforcement middleware (task 4.0.4) — rejects quota violations BEFORE
// queueing (typed 402/429-style errors), exposes the usage surface, and hands
// handlers the resolved scope + released-reservation callback.
//
// Mounting (integrator-owned src/platform/server.js — additive lines):
//
//   import { quotaGuard, quotaUsageRoute, quotaReconcile } from "./quota-middleware.js";
//   app.get("/api/quota/usage", authRequired, quotaUsageRoute());        // plan step 8
//   app.post("/api/tasks", authRequired, quotaGuard({ estimatedBytesFrom: ... }), ...existing handler)
//   app.post("/api/jobs/explore", authRequired, quotaGuard(), ...existing handler)
//   app.post("/api/quota/reconcile", authRequired, requireRole("admin"), quotaReconcile())
//
// The guard NEVER queues — it only reserves capacity atomically and attaches
// `req.quotaRelease()`; the route handler calls it when the job finishes (or
// the error path / reclaimStaleReservations covers it after a crash).
import { resolveScope, checkQuota, reserveJobSlot, queueReservation, releaseReservation,
         promoteReservation, reclaimStaleReservations, getUsage, QuotaExceededError } from "./quota-service.js";

// HTTP shape per rejection reason:
//   402 PAYMENT_REQUIRED — hard volume/pool exhaustion (storage pool, daily job
//     allowance) — the classic "quota" semantics; retrying immediately will
//     never succeed.
//   429 TOO_MANY_REQUESTS — transient capacity (concurrent slots, queue depth,
//     daily exploration minutes) — a Retry-After hint is attached.
const REASON_STATUS = {
  storage_limit: 402,
  daily_job_limit: 402,
  concurrent_job_limit: 429,
  queued_job_limit: 429,
  exploration_time_limit: 429,
};

export function statusForReason(reason) {
  return REASON_STATUS[reason] || 429;
}

function sendQuotaError(res, err, includeAll = true, req = null) {
  const status = statusForReason(err.reason);
  res.set("Retry-After", status === 429 ? "30" : "3600");
  const body = {
    ok: false,
    error: err.message,
    code: "QUOTA_EXCEEDED",
    reason: err.reason,
    limit: err.limit,
    used: err.used,
    requested: err.requested,
  };
  if (includeAll && Array.isArray(err.reasons) && err.reasons.length > 1) body.reasons = err.reasons;
  // 4.2.14 plugin framework: the quota-deny hook fans out to registered
  // plugins (events:quota.deny scope). Wired through globalThis.__clonerPlugins
  // (set by server.js boot) to avoid an import cycle; never throws, never
  // delays the rejection response.
  try {
    const plugins = globalThis.__clonerPlugins;
    if (plugins && typeof plugins.notifyQuotaDeny === "function") {
      plugins.notifyQuotaDeny({
        scope: err.scope || req?.quotaScope || null,
        userId: req?.userId || null,
        orgId: req?.tenantScope?.orgId || null,
        reason: err.reason, limit: err.limit, used: err.used, requested: err.requested,
      });
    }
  } catch { /* hooks must never break a quota decision */ }
  return res.status(status).json(body);
}

// Resolve the effective scope for this request: explicit orgId (validated
// against membership by the caller's tenant middleware) or the personal scope.
// opts:
//   getOrgId(req)      → org id for org-pooled submissions (default req.body.orgId)
//   queued(req)        → true when this endpoint parks the job instead of
//                        running it inline (default false)
//   estimatedBytes(req), explorationMinutes(req) → preflight estimates
export function quotaGuard(opts = {}) {
  const getOrgId = opts.getOrgId || ((req) => req.body?.orgId);
  const isQueued = opts.queued || (() => false);
  const estBytes = opts.estimatedBytes || (() => 0);
  const estMinutes = opts.explorationMinutes || (() => 0);

  return async function quotaGuardMw(req, res, next) {
    try {
      const scope = resolveScope({ userId: req.userId, orgId: getOrgId(req) });
      const estimatedBytes = estBytes(req) || 0;
      const explorationMinutes = estMinutes(req) || 0;

      // preflight first (cheapest rejection, full multi-reason detail)
      await checkQuota(scope, { estimatedBytes, explorationMinutes });

      const taskKey = opts.taskKey
        ? opts.taskKey(req)
        : `req-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

      // atomic reservation INSIDE the middleware — by the time next() runs the
      // slot is held, so N simultaneous requests cannot all pass (plan step 7)
      const slot = isQueued(req)
        ? await queueReservation(scope, taskKey, { userId: req.userId })
        : await reserveJobSlot(scope, taskKey, { userId: req.userId, estimatedBytes, explorationMinutes });

      req.quotaScope = scope;
      req.quotaTaskKey = taskKey;
      req.quotaReservationId = slot.reservationId;
      // handler calls this on job completion; outcome ∈ completed|failed|cancelled
      req.quotaRelease = async ({ outcome = "completed", explorationMs = 0, retries = 0 } = {}) => {
        if (req._quotaReleased) return { released: false, alreadyReleased: true };
        req._quotaReleased = true;
        if (isQueued(req) && slot.state === "queued") {
          // queued jobs promote to running when they actually execute; a
          // terminal release from the queued state releases directly
          return releaseReservation(scope, taskKey, { userId: req.userId, outcome, explorationMs, retries });
        }
        return releaseReservation(scope, taskKey, { userId: req.userId, outcome, explorationMs, retries });
      };
      next();
    } catch (e) {
      if (e instanceof QuotaExceededError) return sendQuotaError(res, e, true, req);
      return res.status(500).json({ ok: false, error: "quota check failed: " + String(e?.message || e).slice(0, 160) });
    }
  };
}

// GET /api/quota/usage — current usage, limits and live rejection reasons for
// the caller's (or ?orgId=) scope.
export function quotaUsageRoute() {
  return async function quotaUsageMw(req, res) {
    try {
      const orgId = req.query?.orgId || null;
      const scope = resolveScope({ userId: req.userId, orgId });
      const usage = await getUsage(scope);
      res.json({ ok: true, usage });
    } catch (e) {
      res.status(500).json({ ok: false, error: String(e?.message || e).slice(0, 160) });
    }
  };
}

// POST /api/quota/reconcile — admin: worker-crash reservation reclaim +
// ledger→daily rebuild for every scope touched today (plan risk note).
export function quotaReconcile() {
  return async function quotaReconcileMw(req, res) {
    try {
      const reclaimed = await reclaimStaleReservations({ maxAgeMs: Number(req.body?.maxAgeMs) || undefined });
      const touched = [...new Set(reclaimed.map((r) => `${r.scope_type}:${r.scope_id}`))];
      const reconciled = [];
      for (const k of touched) {
        const [scope_type, scope_id] = k.split(":");
        const { reconcileDailyFromLedger } = await import("./quota-service.js");
        reconciled.push({ scope: k, ...(await reconcileDailyFromLedger({ scope_type, scope_id })) });
      }
      res.json({ ok: true, reclaimed: reclaimed.map((r) => ({ scope: `${r.scope_type}:${r.scope_id}`, task: r.task_key })), reconciled });
    } catch (e) {
      res.status(500).json({ ok: false, error: String(e?.message || e).slice(0, 160) });
    }
  };
}

// promote + release helpers re-exported for the worker path (4.0.3 contract):
// a BullMQ worker promotes its queued reservation before executing and calls
// releaseReservation with the job outcome.
export { promoteReservation, releaseReservation, reclaimStaleReservations };
