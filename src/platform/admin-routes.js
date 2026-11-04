// Admin API routes (task 4.0.8): secure administrative surfaces.
//
// INTEGRATOR MOUNT LINE (server.js is integrator-owned — do not edit there):
//
//   import { adminRouter } from "./admin-routes.js";
//   import { getCloneQueue } from "../queues/clone-queue.js";
//   import * as auditService from "./audit-service.js";
//   import { auditBridgeFromAuditService } from "./admin-service.js";
//   app.use("/api/admin", adminRouter({
//     queue: getCloneQueue(),
//     audit: auditBridgeFromAuditService(auditService),
//   }));
//
// `audit` is the injected 4.0.9 interface ({ record(event) }); events conform
// to the audit-service schema v1 allowlist (admin.access / admin.action).
// If omitted, admin-service falls back to a bounded in-memory audit sink, so
// every admin action still emits an auditable event before the bridge is wired.
//
// Authorization is enforced SERVER-SIDE and independently of any frontend
// visibility: authRequired resolves the session, then the guard rejects
// anything that is not the platform-admin role with 403 (denials are audited).
import crypto from "node:crypto";
import { Router } from "express";
import { authRequired } from "../auth/auth-middleware.js";
import { createAdminService } from "./admin-service.js";
import { queryAuditEvents, verifyAuditChain } from "./audit-service.js"; // 4.0.9 (G2.2: read APIs for the admin UI)
import { HEARTBEAT_KEY_PREFIX } from "../workers/worker-health.js";      // 4.0.3 (G2.2: worker discovery)

// ---- G2.2 ui-admin: worker/region status discovery --------------------------
// Scans the REAL Redis heartbeat store the clone workers publish to
// (src/workers/worker-health.js: cloner:worker:heartbeat:<workerId>, JSON with
// TTL). A lazily-connected shared client is reused across requests; a failed
// connect backs off for COOLDOWN_MS so an unreachable Redis never hot-loops.
// No Redis (or no workers yet) is a valid, reported state — never an error page.
function createWorkerStatusProvider({ queue, redisUrl }) {
  const TTL_MS = () => Number(process.env.CLONER_HEARTBEAT_TTL || 45_000);
  let redis = null;
  let lastFailedAt = 0;
  const COOLDOWN_MS = 10_000;

  async function ensureRedis() {
    if (redis) return redis;
    if (!redisUrl) return null;
    if (Date.now() - lastFailedAt < COOLDOWN_MS) return null;
    lastFailedAt = Date.now();
    try {
      const IORedis = (await import("ioredis")).default;
      const c = new IORedis(redisUrl, {
        lazyConnect: true, connectTimeout: 1500,
        maxRetriesPerRequest: 1, retryStrategy: () => null, enableOfflineQueue: false,
      });
      c.on("error", () => {}); // connect() rejection is the report path
      await c.connect();
      redis = c;
      return redis;
    } catch {
      return null;
    }
  }

  async function discoverHeartbeats() {
    const client = await ensureRedis();
    if (!client) return { available: false, snapshots: [] };
    const pattern = HEARTBEAT_KEY_PREFIX + "*";
    const keys = [];
    let cursor = "0";
    for (let i = 0; i < 40 && cursor !== "0" || i === 0; i++) {
      const res = await client.scan(cursor, "MATCH", pattern, "COUNT", 200);
      cursor = String(res[0]);
      keys.push(...res[1]);
      if (keys.length >= 500) break; // bounded: heartbeats are few by design
    }
    if (!keys.length) return { available: true, snapshots: [] };
    const raws = await client.mget(...keys.slice(0, 500));
    const snapshots = [];
    for (let i = 0; i < keys.length; i++) {
      try {
        const snap = JSON.parse(raws[i]);
        if (snap && typeof snap === "object") snapshots.push({ key: keys[i], snap });
      } catch { /* malformed snapshot: skip, never fail the endpoint */ }
    }
    return { available: true, snapshots };
  }

  return async function workerStatus() {
    const { available, snapshots } = await discoverHeartbeats();
    const now = Date.now();
    const ttl = TTL_MS();
    const workers = snapshots.map(({ key, snap }) => {
      const ageMs = Number.isFinite(Number(snap.ts)) ? Math.max(0, now - Number(snap.ts)) : null;
      return {
        workerId: String(snap.workerId || key.slice(HEARTBEAT_KEY_PREFIX.length)),
        region: snap.region || null,
        host: snap.host || null,
        pid: snap.pid ?? null,
        status: snap.status || "unknown",      // running | draining | stopped
        freshness: ageMs != null && ageMs <= ttl * 2 ? "fresh" : "stale",
        ageMs,
        lastBeatAt: ageMs != null ? new Date(now - ageMs).toISOString() : null,
        startedAt: snap.startedAt || null,
        concurrency: snap.concurrency ?? null,
        queueCounts: snap.queueCounts || null,
      };
    }).sort((a, b) => a.workerId.localeCompare(b.workerId));

    // region rollup (a worker without a region groups as "(unspecified)")
    const regionMap = new Map();
    for (const w of workers) {
      const region = w.region || "(unspecified)";
      const r = regionMap.get(region) || { region, workers: 0, running: 0, draining: 0, stale: 0 };
      r.workers++;
      if (w.status === "running") r.running++;
      if (w.status === "draining") r.draining++;
      if (w.freshness === "stale") r.stale++;
      regionMap.set(region, r);
    }

    // queue depth from the REAL queue registry (memory or bullmq-backed)
    const jobs = queue ? queue.listJobs() : [];
    const byStatus = {};
    for (const j of jobs) byStatus[j.status] = (byStatus[j.status] || 0) + 1;

    return {
      available,
      note: available ? null : "worker heartbeat store unreachable (CLONER_REDIS_URL/REDIS_URL) — worker liveness unknown",
      workers,
      regions: [...regionMap.values()].sort((a, b) => a.region.localeCompare(b.region)),
      queue: { backend: queue ? queue.backend : null, total: jobs.length, byStatus },
      checkedAt: new Date().toISOString(),
    };
  };
}

export function adminRouter(deps = {}) {
  const service = deps.service || createAdminService({
    audit: deps.audit,
    db: deps.db,
    queue: deps.queue,
    apiKeys: deps.apiKeys,
    retentionSweep: deps.retentionSweep,
  });

  // G2.2 additions: injectable so suites can stand in the remote ends; defaults
  // are the REAL 4.0.9 audit-service query/verify functions.
  const auditQuery = deps.auditQuery || queryAuditEvents;
  const auditChainVerify = deps.auditChainVerify || verifyAuditChain;
  const workerStatus = deps.workerStatus || createWorkerStatusProvider({
    queue: deps.queue || null,
    // dev-compose default mirrors src/database/client.js (127.0.0.1) — the
    // heartbeat store is the same Redis the clone workers/queue use
    redisUrl: deps.redisUrl ?? (process.env.CLONER_REDIS_URL || process.env.REDIS_URL || "redis://127.0.0.1:6379"),
  });

  const router = Router();

  // per-request correlation id, echoed in every audit event this request emits
  router.use((req, _res, next) => {
    req.correlationId = crypto.randomUUID();
    next();
  });

  // server-side admin gate — hidden frontend controls are NOT the mechanism
  const adminGuard = (req, res, next) => {
    if (req.userRole !== "admin") {
      // denied administrative access is itself audited (plan 4.0.9 step 4);
      // events conform to the 4.0.9 schema v1 allowlist (admin.access/denied)
      Promise.resolve(service.audit.record({
        schemaVersion: 1,
        ts: new Date(),
        actorType: "user",
        action: "admin.access",
        outcome: "denied",
        actorId: req.userId || null,
        actorEmail: req.userEmail || null,
        targetType: "admin-route",
        targetId: req.originalUrl,
        metadata: { operation: `${req.method} ${req.originalUrl}`, role: req.userRole || null },
        correlationId: req.correlationId,
      })).catch(() => {});
      return res.status(403).json({ error: "insufficient permissions" });
    }
    next();
  };

  router.use(authRequired, adminGuard);

  const actorOf = (req) => ({ id: req.userId, email: req.userEmail, correlationId: req.correlationId });

  // errors thrown by the service are audited here with outcome:"failure"
  // unless the service already audited them (flag set on the error object)
  const handler = (action, fn) => (req, res) => {
    Promise.resolve(fn(req, res, actorOf(req)))
      .catch(async (e) => {
        const status = Number(e?.status) || 500;
        if (!e?.alreadyAudited) {
          await service.audit.record({
            schemaVersion: 1, ts: new Date(), actorType: "user", outcome: "failure",
            action: /get|list/i.test(action) ? "admin.access" : "admin.action",
            actorId: req.userId || null, actorEmail: req.userEmail || null,
            targetType: "admin-route", targetId: req.originalUrl,
            metadata: { operation: action, error: String(e?.message || e).slice(0, 300) },
            correlationId: req.correlationId,
          }).catch(() => {});
        }
        res.status(status).json({ error: String(e?.message || e).slice(0, 300) });
      });
  };

  // ---- users & organizations ----
  router.get("/users", handler("admin.users.list", async (req, res, actor) => {
    const out = await service.listUsers({ limit: req.query.limit, offset: req.query.offset, actor });
    res.json({ ...out, correlationId: actor.correlationId });
  }));
  router.get("/users/:id", handler("admin.users.get", async (req, res, actor) => {
    const out = await service.getUser(req.params.id, { actor });
    res.json({ ...out, correlationId: actor.correlationId });
  }));
  router.get("/orgs", handler("admin.orgs.list", async (req, res, actor) => {
    const out = await service.listOrganizations({ limit: req.query.limit, offset: req.query.offset, actor });
    res.json({ ...out, correlationId: actor.correlationId });
  }));

  // ---- tasks: read-only inspection of any task + forced cancellation ----
  router.get("/tasks", handler("admin.tasks.list", async (req, res, actor) => {
    const out = await service.listAllTasks({
      status: req.query.status, limit: req.query.limit, offset: req.query.offset, actor,
    });
    res.json({ ...out, correlationId: actor.correlationId });
  }));
  router.get("/tasks/:id", handler("admin.tasks.get", async (req, res, actor) => {
    const out = await service.getTaskAsAdmin(req.params.id, { actor });
    res.json({ ...out, correlationId: actor.correlationId });
  }));
  router.post("/tasks/:id/cancel", handler("admin.tasks.cancel", async (req, res, actor) => {
    const out = await service.forceCancelTask(req.params.id, { actor, reason: req.body?.reason });
    res.json({ ...out, correlationId: actor.correlationId });
  }));

  // ---- quotas ----
  router.put("/users/:id/quota", handler("admin.users.quota.update", async (req, res, actor) => {
    const out = await service.setQuota(req.params.id, req.body?.quota ?? req.body, { actor });
    res.json({ ...out, correlationId: actor.correlationId });
  }));
  router.get("/users/:id/quota", handler("admin.users.quota.get", async (req, res, actor) => {
    const out = await service.getQuota(req.params.id, { actor });
    res.json({ ...out, correlationId: actor.correlationId });
  }));

  // ---- api keys ----
  router.post("/api-keys/:keyId/revoke", handler("admin.api_keys.revoke", async (req, res, actor) => {
    const out = await service.revokeApiKey(req.params.keyId, { actor });
    res.json({ ...out, correlationId: actor.correlationId });
  }));

  // ---- retention ----
  router.post("/retention/sweep", handler("admin.retention.sweep", async (req, res, actor) => {
    const out = await service.triggerRetentionSweep({ actor });
    res.json({ ...out, correlationId: actor.correlationId });
  }));

  // ---- G2.2 ui-admin: audit trail viewer + chain verification + workers ----
  // All three are read-only, platform-scoped (admin-only by the router-wide
  // guard above) and audit their own access through the injected sink, so the
  // viewer itself is accountable in the trail it displays.
  const auditAccess = async (actor, { operation, targetType, targetId = null, details = {} }) => {
    await service.audit.record({
      schemaVersion: 1, ts: new Date(), actorType: "user",
      action: "admin.access", outcome: "success",
      actorId: actor.id || null, actorEmail: actor.email || null,
      targetType, targetId,
      metadata: { operation, ...details },
      correlationId: actor.correlationId,
    }).catch(() => {});
  };

  router.get("/audit", handler("admin.audit.list", async (req, res, actor) => {
    const q = req.query || {};
    const filters = {
      action: q.action || undefined,
      actionPrefix: q.actionPrefix || undefined,
      outcome: q.outcome || undefined,
      actorEmail: q.actorEmail || undefined,
      targetType: q.targetType || undefined,
      targetId: q.targetId || undefined,
      correlationId: q.correlationId || undefined,
      from: q.from || undefined,
      to: q.to || undefined,
      limit: q.limit || undefined,
      offset: q.offset || undefined,
      withCount: q.withCount !== "false",
      platformWide: true, // admin-only route; service refuses unscoped queries otherwise
    };
    const out = await auditQuery(filters);
    await auditAccess(actor, { operation: "admin.audit.list", targetType: "audit-collection", details: { count: out.events?.length ?? 0, filters: { actionPrefix: filters.actionPrefix, outcome: filters.outcome } } });
    res.json({ ...out, correlationId: actor.correlationId });
  }));

  router.get("/audit/verify", handler("admin.audit.verify", async (req, res, actor) => {
    const limit = req.query.limit ? Number(req.query.limit) : undefined;
    const out = await auditChainVerify({ limit });
    await auditAccess(actor, { operation: "admin.audit.verify", targetType: "audit-chain", targetId: "verify", details: { ok: out.ok, checked: out.checked } });
    res.json({ ...out, verifiedAt: new Date().toISOString(), correlationId: actor.correlationId });
  }));

  router.get("/workers", handler("admin.workers.status", async (req, res, actor) => {
    const out = await workerStatus();
    await auditAccess(actor, { operation: "admin.workers.status", targetType: "worker-collection", details: { available: out.available, workers: out.workers.length, backend: out.queue?.backend } });
    res.json({ ...out, correlationId: actor.correlationId });
  }));

  return router;
}
