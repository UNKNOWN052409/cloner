// Dashboard API routes (task G2.1 — dashboard aggregate).
//
//   GET /api/dashboard → live summary of the task store + the caller's quota
//   usage, in one call for the operator dashboard clients (headless since
//   G7.1 — the platform serves an API only).
//
// Data sources are the REAL product stores — never fixtures:
//   • tasks.listTasks()           (v1 legacy store, src/platform/tasks.js)
//   • exploration.listJobsFor()   (v2 pipeline registry, src/platform/exploration-runner.js)
//   • quota-service.getUsage()    (live limits + counters, src/platform/quota-service.js)
// The same visibility rules as GET /api/tasks apply: an authenticated caller
// sees their own legacy tasks + accessible v2 jobs; the anonymous loopback
// dashboard (legacy posture, see server.js) sees ownerless entries only.
//
// INTEGRATOR MOUNT LINE (server.js is integrator-owned — do not edit there):
//
//   import { dashboardRouter } from "./dashboard-routes.js";
//   app.use("/api/dashboard", dashboardRouter());
//
// The router resolves credentials itself, mirroring server.js `credentialedRead`:
// X-API-Key → apiKeyAuth("read:task"), Bearer/?token= → authRequired, else the
// anonymous local-dashboard posture (req.userId = null). Org context in
// x-org-id/?orgId is scoped strictly via resolveTenantScope (member → scope,
// non-member → 403) exactly like the task routes.
//
// Quota usage requires an identity (resolveScope throws without one — that is
// the real contract, 4.0.4): anonymous callers get quota:{available:false},
// authenticated callers get the live usage block.
// Every failure inside the quota block degrades to {available:false, reason}
// — the endpoint never 500s because one aggregate is unavailable.
import { Router } from "express";
import { authRequired } from "../auth/auth-middleware.js";
import { apiKeyAuth } from "./api-key-service.js";
import { resolveTenantScope } from "./tenant-scope.js";
import * as tasks from "./tasks.js";
import * as exploration from "./exploration-runner.js";
import { isLoopback } from "./ws-auth.js";
import { resolveScope, getUsage } from "./quota-service.js";

// Raw statuses seen in the two stores (v1 tasks.js / v2 pipeline-job.js).
const STATUS_BUCKETS = {
  running: new Set(["running", "verifying", "exploring", "reconstructing"]),
  done: new Set(["done", "completed", "completed_with_limitations", "exported"]),
  errors: new Set(["error", "cancelled"]),
};

function summarize(rows) {
  const byStatus = {};
  let running = 0, done = 0, errors = 0, pending = 0, v1 = 0, v2 = 0, verifiedPassed = 0;
  for (const r of rows) {
    byStatus[r.status] = (byStatus[r.status] || 0) + 1;
    if (STATUS_BUCKETS.running.has(r.status)) running++;
    else if (STATUS_BUCKETS.done.has(r.status)) done++;
    else if (STATUS_BUCKETS.errors.has(r.status)) errors++;
    else pending++;
    if (r.kind === "v1") v1++; else v2++;
    if (r.verificationPassed === true) verifiedPassed++;
  }
  return {
    total: rows.length,
    running, done, errors, pending,
    byStatus,
    pipelines: { v1, v2 },
    verifiedPassed,
    recentErrors: rows.filter((r) => STATUS_BUCKETS.errors.has(r.status)).slice(0, 5)
      .map((r) => ({ id: r.id, kind: r.kind, url: r.url, status: r.status, error: r.error || null })),
  };
}

// Normalize a legacy task meta / a v2 queue entry into one row shape so the
// summary and the UI table always agree.
function normalizeV1(t) {
  return {
    id: t.id, kind: "v1", url: t.url, status: t.status,
    createdAt: t.createdAt, finishedAt: t.finishedAt || null,
    verificationPassed: t.verification ? !!t.verification.passed : null,
    artifactsCount: t.artifacts ? Object.keys(t.artifacts).length : 0,
    // artifact FILE NAMES (history endpoint builds links from them; the
    // summary ignores the extra field) — additive, never credentials
    artifactNames: t.artifacts ? Object.keys(t.artifacts) : [],
    error: t.error || null,
  };
}
function normalizeV2(j) {
  return {
    id: j.jobId, kind: "v2", url: j.url, status: j.status,
    createdAt: j.queuedAt || j.startedAt || null, finishedAt: j.finishedAt || null,
    verificationPassed: j.verification ? !!j.verification.passed : null,
    artifactsCount: j.manifest?.pages != null ? Number(j.manifest.pages) : 0,
    error: j.error || null,
  };
}

export function dashboardRouter() {
  const router = Router();

  // credential resolution — identical posture to server.js credentialedRead,
  // kept local so the router mounts with zero extra wiring.
  // G5.1 alignment: server.js's credentialedRead now ENFORCES any presented
  // Authorization value (malformed → 401) via enforceOrAnonymous — mirror that
  // here so a caller who MEANT to authenticate can never silently degrade to
  // the anonymous dashboard posture.
  router.use((req, res, next) => {
    const auth = req.headers.authorization;
    if (auth !== undefined) {
      if (typeof auth !== "string" || !auth.startsWith("Bearer ") || auth.slice(7).trim() === "") {
        return res.status(401).json({ error: "malformed authorization header" });
      }
      return authRequired(req, res, next);
    }
    if (req.headers["x-api-key"] !== undefined) return apiKeyAuth("read:task")(req, res, next);
    if (!isLoopback(req.socket?.remoteAddress)) return res.status(401).json({ error: "authentication required" });
    req.userId = null;
    next();
  });

  router.get("/", async (req, res) => {
    // org context requested → strict tenant resolution (member → scope, else 403)
    const hasOrgCtx = !!(req.headers["x-org-id"] || req.query?.orgId);
    if (hasOrgCtx && req.userId != null) {
      return resolveTenantScope(req, res, () => send(req, res));
    }
    return send(req, res);

    async function send(req, res) {
      try {
        const identity = req.userId
          ? { authenticated: true, userId: req.userId, email: req.userEmail || null, role: req.userRole || null }
          : { authenticated: false, userId: null, email: null, role: null };
        const orgId = req.tenantScope?.orgId || null;

        // ---- task store (same visibility as GET /api/tasks) ----
        // G5.1 consistency fix: listJobsFor (v2) gives a platform-admin ALL
        // jobs, but this v1 filter showed the admin only their own tasks —
        // the operator's dashboard summary undercounted (probe: admin token
        // saw total=1 while two tasks existed). An admin now sees the full
        // v1 store, matching the v2 side and the admin task inventory.
        const legacy = req.userId
          ? (req.userRole === "admin"
            ? tasks.listTasks()
            : tasks.listTasks().filter((t) => t.userId === req.userId))
          : tasks.listTasks().filter((t) => !t.userId || t.userId === "local");
        const jobs = await exploration.listJobsFor(req.userId ? { userId: req.userId, role: req.userRole } : null);
        // system pseudo-jobs (e.g. the artifact-sweep entry the queue adapter
        // registers at boot) are not tasks — they carry no url and must not
        // pollute the dashboard summary or table
        const realJobs = jobs.filter((j) => !!j.url);
        const rows = [...legacy.map(normalizeV1), ...realJobs.map(normalizeV2)]
          .sort((a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || "")));

        // ---- quota usage (identified callers only) ----
        let quota;
        if (!req.userId) {
          quota = { available: false, reason: "sign-in required" };
        } else {
          try {
            const scope = resolveScope({ userId: req.userId, orgId });
            quota = { available: true, usage: await getUsage(scope) };
          } catch (e) {
            quota = { available: false, reason: String(e?.message || e).slice(0, 160) };
          }
        }

        res.json({
          ok: true,
          generatedAt: new Date().toISOString(),
          loopbackLegacy: !req.userId && isLoopback(req.socket?.remoteAddress),
          identity,
          summary: summarize(rows),
          quota,
        });
      } catch (e) {
        res.status(500).json({ ok: false, error: String(e?.message || e).slice(0, 200) });
      }
    }
  });

  // GET /api/dashboard/history — task-history rows (task 4.1.2): per-user
  // list with status, duration, artifact links; pagination + status filter.
  // Same credential resolution and visibility rules as the summary above.
  router.get("/history", async (req, res) => {
    try {
      if (!req.userId) return res.json({ ok: true, rows: [], total: 0, note: "anonymous dashboard posture — history is per-user" });
      const limit = Math.max(1, Math.min(Number(req.query.limit) || 25, 100));
      const offset = Math.max(0, Number(req.query.offset) || 0);
      const status = String(req.query.status || "").trim();

      const legacy = req.userId
        ? (req.userRole === "admin" ? tasks.listTasks() : tasks.listTasks().filter((t) => t.userId === req.userId))
        : [];
      const jobs = await exploration.listJobsFor({ userId: req.userId, role: req.userRole });
      const realJobs = jobs.filter((j) => !!j.url);

      let rows = [...legacy.map(normalizeV1), ...realJobs.map(normalizeV2)];
      if (status) rows = rows.filter((r) => r.status === status);
      rows.sort((a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || "")));
      const total = rows.length;
      rows = rows.slice(offset, offset + limit);

      // per-row enrichment (4.1.2): duration + artifact links
      for (const r of rows) {
        r.durationMs = r.createdAt && r.finishedAt
          ? Math.max(0, Date.parse(r.finishedAt) - Date.parse(r.createdAt))
          : null;
        if (r.kind === "v2") {
          r.artifactLinks = [`/api/jobs/${r.id}/artifacts/manifest.json`];
        } else {
          r.artifactLinks = (r.artifactNames && r.artifactNames.length)
            ? r.artifactNames.map((f) => `/preview/${r.id}/out/${f}`)
            : [];
        }
      }
      res.json({ ok: true, rows, total, limit, offset });
    } catch (e) {
      res.status(500).json({ ok: false, error: String(e?.message || e).slice(0, 200) });
    }
  });

  return router;
}
