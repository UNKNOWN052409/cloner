// Organization REST routes (phase 4.0.2). Exposes an Express router that the
// integrator mounts in src/platform/server.js (INTEGRATOR-OWNED file — the
// mount line is documented in the phase summary, not added here):
//
//   app.use("/api/orgs", createOrgRouter({ authRequired, tenantScope: <4.0.1 tenant middleware> }));
//
// Middleware is injected so this router works with the real 4.0.1 tenant
// middleware once it lands, and with a mock in tests:
//   - authRequired (default: ../auth/auth-middleware.js authRequired) sets req.userId.
//   - tenantScope (default: the pass-through below) is applied to every
//     org-scoped route AFTER authRequired, with req.params already parsed.
//     The 4.0.1 contract: the middleware may set req.tenant; when
//     req.tenant.orgId is present it must match the route's :orgId or the
//     request is a cross-tenant access and is denied (403).
import { Router } from "express";
import { authRequired as defaultAuthRequired } from "../auth/auth-middleware.js";
import * as orgService from "./org-service.js";

// Fallback tenant scope for when 4.0.1 has not landed yet: seeds a minimal
// req.tenant and enforces the orgId-match part of the contract when a tenant
// context (real or mock) already provided an orgId.
function fallbackTenantScope(req, res, next) {
  req.tenant = req.tenant || { type: "user", userId: req.userId };
  if (req.params?.orgId && req.tenant?.orgId && req.tenant.orgId !== req.params.orgId) {
    return res.status(403).json({ error: "cross-tenant access denied" });
  }
  next();
}

export function createOrgRouter({ authRequired = defaultAuthRequired, tenantScope = fallbackTenantScope } = {}) {
  const router = Router();
  // map service errors (which carry .status) to HTTP responses; everything
  // else is a 500 with a truncated message (no internals leaked)
  const wrap = (fn) => (req, res) => {
    fn(req, res).catch((e) => {
      const status = e?.status || 500;
      res.status(status).json({ error: String(e?.message || "internal error").slice(0, 200) });
    });
  };

  // ---- organizations ----
  router.post("/", authRequired, wrap(async (req, res) => {
    const { name, description, slug } = req.body || {};
    const result = await orgService.createOrg({ userId: req.userId, name, description, slug });
    res.status(201).json(result);
  }));

  router.get("/", authRequired, wrap(async (req, res) => {
    res.json(await orgService.listOrgs(req.userId));
  }));

  router.get("/:orgId", authRequired, tenantScope, wrap(async (req, res) => {
    res.json(await orgService.getOrg(req.params.orgId, req.userId));
  }));

  router.patch("/:orgId", authRequired, tenantScope, wrap(async (req, res) => {
    res.json(await orgService.updateOrg(req.params.orgId, req.userId, req.body || {}));
  }));

  router.delete("/:orgId", authRequired, tenantScope, wrap(async (req, res) => {
    res.json(await orgService.deleteOrg(req.params.orgId, req.userId));
  }));

  // ---- membership ----
  router.get("/:orgId/members", authRequired, tenantScope, wrap(async (req, res) => {
    res.json(await orgService.listMembers(req.params.orgId, req.userId));
  }));

  router.patch("/:orgId/members/:memberUserId", authRequired, tenantScope, wrap(async (req, res) => {
    res.json(await orgService.changeMemberRole(req.params.orgId, req.userId, req.params.memberUserId, req.body?.role));
  }));

  router.delete("/:orgId/members/:memberUserId", authRequired, tenantScope, wrap(async (req, res) => {
    res.json(await orgService.removeMember(req.params.orgId, req.userId, req.params.memberUserId));
  }));

  // ---- invitations ----
  router.post("/:orgId/invitations", authRequired, tenantScope, wrap(async (req, res) => {
    const { email, role, ttlHours } = req.body || {};
    const ttlMs = ttlHours !== undefined ? Number(ttlHours) * 3600_000 : undefined;
    const result = await orgService.inviteMember({ orgId: req.params.orgId, actorId: req.userId, email, role, ttlMs });
    res.status(201).json(result);
  }));

  router.get("/:orgId/invitations", authRequired, tenantScope, wrap(async (req, res) => {
    res.json(await orgService.listInvitations(req.params.orgId, req.userId));
  }));

  router.post("/:orgId/invitations/:inviteId/revoke", authRequired, tenantScope, wrap(async (req, res) => {
    res.json(await orgService.revokeInvitation(req.params.orgId, req.params.inviteId, req.userId));
  }));

  // redeeming an invitation is not org-scoped (the acceptor is not a member yet)
  router.post("/invitations/accept", authRequired, wrap(async (req, res) => {
    res.json(await orgService.acceptInvitation(req.body?.token, req.userId));
  }));

  return router;
}

export default createOrgRouter;
