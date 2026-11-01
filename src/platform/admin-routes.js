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

export function adminRouter(deps = {}) {
  const service = deps.service || createAdminService({
    audit: deps.audit,
    db: deps.db,
    queue: deps.queue,
    apiKeys: deps.apiKeys,
    retentionSweep: deps.retentionSweep,
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

  return router;
}
