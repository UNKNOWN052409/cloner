// Tenant-scope middleware (task 4.0.1).
//
// Resolves the tenant context { userId, orgId, role } for every request that
// names an organization and fails closed: a user who is not a member of the
// requested org gets 403 (existence of the org is not confirmed), a guessed or
// malformed org id gets 403, a task outside the resolved scope gets 404
// (indistinguishable from "does not exist"). All denials are written to the
// tenant_denials audit table (migration 010) and logged to the server log.
//
// MOUNTING (integrator note — src/platform/server.js is integrator-owned):
//   import { authRequired } from "../auth/auth-middleware.js";
//   import { resolveTenantScope, requireOrgRole, loadTaskScope } from "./tenant-scope.js";
//   // per org-scoped route:
//   app.get("/api/orgs/:orgId/tasks", authRequired, resolveTenantScope, handler);
//   // or globally after auth:
//   app.use(authRequired, resolveTenantScope);
//
// req.tenantScope shape:
//   { userId, orgId, role, personal }  — orgId:null means personal workspace.
import crypto from "node:crypto";
import { resolveTenantContext, getScopedTask, getScopedTaskWithArtifacts, roleAtLeast, logTenantDenial } from "../database/tenant-repository.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class TenantScopeError extends Error {
  constructor(message, status) {
    super(message);
    this.name = "TenantScopeError";
    this.status = status;
  }
}

// Pulls the requested org id from, in order of precedence:
//   1. path param /:orgId     2. X-Org-Id header   3. ?orgId= query   4. body.orgId
function requestedOrgId(req) {
  if (req.params?.orgId) return String(req.params.orgId);
  const header = req.headers?.["x-org-id"];
  if (header) return String(header);
  const qp = req.query?.orgId;
  if (qp) return String(qp);
  const body = req.body;
  if (body && typeof body === "object" && body.orgId) return String(body.orgId);
  return null;
}

// Express middleware — requires authRequired to have run first (req.userId).
// Never trusts a userId/orgId from the request body for authorization itself:
// the org id only selects WHICH org to check membership for.
export function resolveTenantScope(req, res, next) {
  if (!req.userId) {
    return res.status(401).json({ error: "authentication required" });
  }
  const orgId = requestedOrgId(req);
  resolveTenantContext(req.userId, orgId)
    .then((ctx) => {
      if (!ctx) {
        // Org missing, inactive, or caller not a member — one generic verdict,
        // no distinction between the three (no existence leak).
        logDeny(req, orgId, "resolveTenantScope", "not an active member of the organization");
        return res.status(403).json({ error: "org access denied" });
      }
      req.tenantScope = { userId: ctx.userId, orgId: ctx.orgId, role: ctx.role, personal: ctx.personal };
      req.orgId = ctx.orgId;
      req.orgRole = ctx.role;
      next();
    })
    .catch((e) => {
      console.error(`[tenant] scope resolution failed: ${e.message}`);
      res.status(500).json({ error: "tenant scope check failed" });
    });
}

// Express middleware factory — gates org-scoped privileged actions. Personal
// workspaces have no admin surface, so an org role is always required here.
export function requireOrgRole(minRole) {
  return (req, res, next) => {
    const ctx = req.tenantScope;
    if (!ctx || !ctx.orgId) {
      logDeny(req, ctx?.orgId || null, "requireOrgRole", "org role required (personal scope has no org role)");
      return res.status(403).json({ error: "org role required" });
    }
    if (!roleAtLeast(ctx.role, minRole)) {
      logDeny(req, ctx.orgId, "requireOrgRole", `role ${ctx.role} is below required ${minRole}`);
      return res.status(403).json({ error: "insufficient org role" });
    }
    next();
  };
}

// Express middleware factory — loads the task under the resolved tenant scope.
// A task owned by another org (or by another user in personal scope) yields
// 404: denied access is indistinguishable from a missing task, so guessed ids
// reveal nothing.
export function loadTaskScope(param = "id") {
  return (req, res, next) => {
    const taskId = req.params?.[param];
    if (!taskId) return res.status(400).json({ error: "task id required" });
    getScopedTaskWithArtifacts(taskId, req.tenantScope)
      .then((found) => {
        if (!found) {
          logDeny(req, req.tenantScope?.orgId || null, "loadTaskScope", "task outside tenant scope or not found", taskId);
          return res.status(404).json({ error: "task not found" });
        }
        req.task = found.task;
        req.artifacts = found.artifacts;
        next();
      })
      .catch((e) => {
        console.error(`[tenant] task scope load failed: ${e.message}`);
        res.status(500).json({ error: "task scope check failed" });
      });
  };
}

// WS/export integration helper (non-express): true iff the tenant context may
// access the task. ws-auth.js / exporter.js can adopt this without changing
// their existing signatures.
export async function canAccessTaskInScope(taskId, scope) {
  if (!taskId || !scope?.userId) return false;
  try {
    const task = await getScopedTask(taskId, scope);
    return !!task;
  } catch {
    return false; // fail closed
  }
}

// Denial plumbing -------------------------------------------------------------

function logDeny(req, orgId, action, reason, resourceId) {
  console.warn(`[security] tenant denial action=${action} userId=${req.userId || "anonymous"} orgId=${orgId || "-"} path=${req.method} ${req.originalUrl || req.url || ""} reason="${reason}"`);
  logTenantDenial({
    userId: req.userId || null,
    orgId: orgId || null,
    action,
    resourceType: resourceId ? "task" : "org",
    resourceId: resourceId || orgId || null,
    reason,
    ip: req.ip || null,
  }).catch(() => {});
}

// Maps a rejected repository call to an HTTP response. TenantError → its own
// status (client error), anything else → 500 without leaking internals.
export function sendTenantError(res, err) {
  const status = err instanceof TenantScopeError || err?.name === "TenantError" ? (err.status || 403) : 500;
  if (status >= 500) console.error(`[tenant] internal error: ${err?.message || err}`);
  res.status(status).json({ error: status >= 500 ? "internal error" : err.message });
}

// Small async wrapper so route handlers can simply throw.
export function scoped(handler) {
  return (req, res, next) => {
    Promise.resolve(handler(req, res, next)).catch((e) => sendTenantError(res, e));
  };
}

export function newOrgId() {
  return crypto.randomUUID();
}
