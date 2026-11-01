// Cloner platform server: task API, persistent sessions, WebSocket progress,
// preview + element picker, verification, export. The engine (src/*.js) does the
// reverse engineering; this is the product shell around it.
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import express from "express";
import { WebSocketServer } from "ws";
import { fileURLToPath } from "node:url";
import { bus } from "../events.js";
import { loadConfig } from "../config.js";
import { cloneUrl } from "../cloneUrl.js";
import { validatePublicUrl } from "../security/url-guard.js";
import { loadCookies } from "../browser.js";
import * as exploration from "./exploration-runner.js";
import * as wsAuth from "./ws-auth.js";
import * as tasks from "./tasks.js";
import * as sessions from "./sessions.js";
import { exportTask, exportV2Task } from "./exporter.js";
import { verifyTask } from "./verify.js";
import { authRequired, requireRole } from "../auth/auth-middleware.js";
import * as auth from "../auth/auth-service.js";
import * as taskRepo from "../database/task-repository.js";
import { migrate } from "../database/client.js";
// ---- Phase 4.0 modules (integration) ----
import { healthRoutes } from "./health-routes.js";                    // 4.0.7 probes + /metrics
import { resolveTenantScope } from "./tenant-scope.js";               // 4.0.1 tenant scoping
import { createOrgRouter } from "./org-routes.js";                    // 4.0.2 organizations
import { adminRouter } from "./admin-routes.js";                      // 4.0.8 admin surface
import { auditBridgeFromAuditService } from "./admin-service.js";
import * as auditService from "./audit-service.js";                   // 4.0.9 hash-chained audit
import { audit as auditEvents } from "./audit-service.js";
import { keysRouter, apiKeyAuth } from "./api-key-service.js";        // 4.0.6 API keys (+ rate limit)
import { quotaGuard, quotaUsageRoute, quotaReconcile, promoteReservation, releaseReservation } from "./quota-middleware.js"; // 4.0.4
import { getCloneQueue } from "../queues/clone-queue.js";
import { resolveArtifactPath, sweep as artifactSweep, enqueueSweep } from "../storage/artifact-lifecycle.js"; // 4.0.5

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export function startPlatform({ port = 4180 } = {}) {
  const app = express();
  app.use(express.json({ limit: "20mb" }));

  // ---- Phase 4.0 mount order (auth → tenant → quota → rate-limit → routes) ----
  // 1. Observability probes FIRST (4.0.7): /healthz /readyz /metrics stay
  //    unauthenticated so load balancers can probe them without a session.
  app.use(healthRoutes());

  // 2. Organization management (4.0.2): router carries its own authRequired and
  //    injects 4.0.1's resolveTenantScope as the tenant middleware (contract
  //    documented in org-routes.js header). Mounted before the task routes.
  app.use("/api/orgs", createOrgRouter({ authRequired, tenantScope: resolveTenantScope }));

  // 3. API-key management (4.0.6): session-authenticated key CRUD; X-API-Key
  //    on task/jobs routes below applies per-key scopes AND rate limits
  //    (rate-limiter.js) before the quota guard.
  app.use("/api/keys", keysRouter);

  // 4. Quota usage + admin reconcile (4.0.4, plan step 8).
  app.get("/api/quota/usage", authRequired, resolveTenantScope, quotaUsageRoute());
  app.post("/api/quota/reconcile", authRequired, requireRole("admin"), quotaReconcile());

  // 5. Admin surface (4.0.8): own authRequired + server-side admin guard,
  //    audit events land in the real hash-chained 4.0.9 audit_events table.
  app.use("/api/admin", adminRouter({ queue: getCloneQueue(), audit: auditBridgeFromAuditService(auditService) }));

  // ---- database migrations (run once at boot) ----
  migrate().catch((e) => console.error('[db] migration failed:', e.message));

  // ---- auth routes (spec §6) — security events land in audit_events (4.0.9) ----
  app.post('/api/auth/register', async (req, res) => {
    try {
      const { email, password } = req.body || {};
      const user = await auth.registerUser(email, password);
      auditSafe(auditEvents.register, { actorEmail: user.email, actorId: user.id, targetType: "user", targetId: user.id });
      res.json({ ok: true, userId: user.id, email: user.email });
    } catch (e) { res.status(400).json({ error: e.message.slice(0, 120) }); }
  });
  app.post('/api/auth/login', async (req, res) => {
    try {
      const { email, password } = req.body || {};
      const session = await auth.loginUser(email, password);
      auditSafe(auditEvents.loginSuccess, { actorEmail: session.email, actorId: session.userId, sessionId: session.token, targetType: "session", targetId: session.token });
      res.json({ ok: true, token: session.token, userId: session.userId, email: session.email, expiresAt: session.expiresAt });
    } catch (e) {
      auditSafe(auditEvents.loginFailure, { actorEmail: (req.body || {}).email || null, targetType: "session" });
      res.status(401).json({ error: e.message.slice(0, 120) });
    }
  });
  app.post('/api/auth/logout', authRequired, async (req, res) => {
    const token = (req.headers.authorization || '').replace('Bearer ', '');
    await auth.revokeSession(token);
    auditSafe(auditEvents.sessionRevoked, { actorId: req.userId, sessionId: token.slice(0, 12) + "…", targetType: "session", targetId: token.slice(0, 12) });
    res.json({ ok: true });
  });
  app.get('/api/auth/me', authRequired, (req, res) => {
    res.json({ userId: req.userId, email: req.userEmail, role: req.userRole });
  });

  // ---- static UI ----
  app.get("/", (_req, res) => res.sendFile(path.join(__dirname, "..", "..", "platform-ui", "index.html")));
  app.use("/ui", express.static(path.join(__dirname, "..", "..", "platform-ui")));
  // picker script injected into previews (element selection)
  const PICKER_JS = fs.readFileSync(path.join(__dirname, "..", "picker.js"), "utf8");

  // ---- tasks ----
  // Credentialed-caller chain (Phase 4.0 order: auth → tenant → quota →
  // rate-limit → handler). Anonymous local callers (the pre-existing platform-ui
  // dashboard) still work: when no Authorization header AND no X-API-Key header
  // are present the request proceeds with userId=null (personal scope), exactly
  // the pre-Phase-4 behavior. Once a credential IS presented it is enforced
  // fully — invalid token/key, wrong scope, rate limit or quota → rejected
  // before the handler (never silently degraded).
  // Soft tenant resolution (4.0.1): when the request names an org context it is
  // resolved strictly (member → scope, non-member → 403); when it does not, it
  // is a no-op so the anonymous/personal flow is unchanged.
  function resolveTenantScopeSoft(req, res, next) {
    const hasOrgCtx = !!(req.params?.orgId || req.headers?.["x-org-id"] || req.query?.orgId || req.body?.orgId);
    if (!hasOrgCtx) return next();
    return resolveTenantScope(req, res, next);
  }
  const credentialed = (opts = {}) => [
    (req, res, next) => {
      const hasBearer = !!(req.headers.authorization || "").startsWith("Bearer ");
      const hasKey = !!req.headers["x-api-key"];
      if (hasKey) return apiKeyAuth(opts.scope || "create:task")(req, res, next);
      if (hasBearer || req.query?.token) return authRequired(req, res, next);
      req.userId = null; // anonymous local dashboard (legacy posture)
      next();
    },
    resolveTenantScopeSoft, // 4.0.1: only when an org context was requested
    // quota guard (4.0.4) applies to identified callers only — quotas are
    // per-user/org scopes and an anonymous request has none. Anonymous/local
    // (req.userId null) passes through with NO reservation; req.quotaRelease
    // stays undefined and the handlers skip it (documented above).
    (req, res, next) => {
      if (!req.userId) return next();
      return quotaGuard({
        // quotaGuard expects a callable; accept a boolean or a per-request fn
        queued: (rq) => !!(typeof opts.queued === "function" ? opts.queued(rq) : opts.queued),
        estimatedBytes: (rq) => (typeof opts.estimatedBytes === "function" ? opts.estimatedBytes(rq) : opts.estimatedBytes || 0),
        explorationMinutes: (rq) => (typeof opts.explorationMinutes === "function" ? opts.explorationMinutes(rq) : opts.explorationMinutes || 0),
      })(req, res, next);
    },
  ];

  // POST /api/tasks — pipeline v2 parks a job in the queue (queued reservation
  // promoted at execution); v1 runs inline (running reservation). The handler
  // calls req.quotaRelease() when the job reaches a terminal state so usage
  // accounting matches actual execution (plan 4.0.4 steps 4/5).
  app.post("/api/tasks", ...credentialed({
    queued: (req) => req.body?.pipeline === "v2",
    estimatedBytes: () => 0,
    explorationMinutes: () => 0,
  }), async (req, res) => {
    const { url, username, password, cookies, storage, instructions, mode, pipeline } = req.body || {};
    if (!url || !/^https?:\/\//i.test(url)) return res.status(400).json({ error: "url required (http(s))" });
    const guard = await validatePublicUrl(url);
    if (!guard.ok) { if (req.quotaRelease) await req.quotaRelease({ outcome: "cancelled" }); return res.status(400).json({ error: "url rejected: " + guard.error }); }
    // pipeline "v2" → exploration + reconstruction + verification (integrated)
    // pipeline "v1" or absent → legacy cloneUrl flow (backward compatible)
    if (pipeline === "v2") {
      const entry = exploration.queueExploration({
        url, username, password, cookies, storage, instructions,
        userId: req.userId, orgId: req.tenantScope?.orgId || null,
      });
      auditSafe(auditEvents.taskCreate, { actorId: req.userId, targetType: "task", targetId: entry.tempId, metadata: { pipeline: "v2", url } });
      // quota lifecycle: a free slot may have started the job inline — promote
      // the queued reservation; release is deferred to the queue's terminal event
      const q = getCloneQueue();
      promoteReservation(req.quotaScope, req.quotaTaskKey, { userId: req.userId }).catch(() => {});
      q.onStatus(({ entry: e }) => {
        if (e.tempId !== entry.tempId && e.jobId !== entry.tempId) return;
        if (!["completed", "completed_with_limitations", "error", "cancelled"].includes(e.status)) return;
        releaseReservation(req.quotaScope, req.quotaTaskKey, { userId: req.userId, outcome: e.status === "error" ? "failed" : e.status === "cancelled" ? "cancelled" : "completed" }).catch(() => {});
      });
      res.json({ id: entry.tempId, status: entry.status, pipeline: "v2" });
      return;
    }
    const meta = tasks.createTask({ url, mode, username, password, cookies, storage, instructions, userId: req.userId || "local" });
    auditSafe(auditEvents.taskCreate, { actorId: req.userId, targetType: "task", targetId: meta.id, metadata: { pipeline: "v1", url } });
    res.json(meta);
    runTask(meta.id).catch((e) => {
      tasks.updateTask(meta.id, { status: "error", error: String(e.message || e).slice(0, 300) }, "failed");
      bus.emit("log", { level: "warn", msg: `task ${meta.id} failed: ${e.message}` });
    }).finally(() => {
      releaseReservation(req.quotaScope, req.quotaTaskKey, { userId: req.userId, outcome: "completed" }).catch(() => {});
    });
  });
  // GET surfaces: credential resolution + rate limiting, but NO quota
  // reservation (listing data must not consume a job slot). Same anonymous
  // fallback as above.
  const credentialedRead = (scope = "read:task") => [
    (req, res, next) => {
      const hasKey = !!req.headers["x-api-key"];
      const hasBearer = !!(req.headers.authorization || "").startsWith("Bearer ");
      if (hasKey) return apiKeyAuth(scope)(req, res, next);
      if (hasBearer || req.query?.token) return authRequired(req, res, next);
      req.userId = null;
      next();
    },
  ];

  // 3.5.9 lane-3 hardening: detail / destructive / export surfaces must not be
  // reachable by REMOTE anonymous callers. The legacy anonymous dashboard
  // posture is preserved for loopback only; identified callers resolve their
  // identity so the owner gates inside the handlers run with a real userId.
  // scope=null rejects API keys entirely (no key scope may perform that action).
  const localOrAuthed = (scope) => (req, res, next) => {
    const hasBearer = !!(req.headers.authorization || "").startsWith("Bearer ");
    const hasToken = !!req.query?.token;
    const hasKey = !!req.headers["x-api-key"];
    if (hasKey) {
      if (!scope) return res.status(403).json({ error: "api keys cannot perform this action (use a session)" });
      return apiKeyAuth(scope)(req, res, next);
    }
    if (hasBearer || hasToken) return authRequired(req, res, next);
    if (!wsAuth.isLoopback(req.socket?.remoteAddress)) return res.status(401).json({ error: "authentication required" });
    req.userId = null; // loopback dashboard legacy posture
    next();
  };

  app.get("/api/tasks", ...credentialedRead(), async (req, res) => {
    // authenticated (Bearer): only tasks created under this userId (meta.userId
    // is set by tasks.createTask / exploration payload); anonymous (local
    // dashboard, legacy posture): ownerless v2 jobs only — jobs created with
    // credentials never leak to unauthenticated callers (4.0.12). Legacy v1
    // tasks follow the same rule: an anonymous caller sees only the
    // ownerless/"local"-scope entries, never another user's tasks.
    const all = tasks.listTasks();
    const legacy = req.userId
      ? all.filter((t) => t.userId === req.userId)
      : all.filter((t) => !t.userId || t.userId === "local");
    const jobs = await exploration.listJobsFor(req.userId ? { userId: req.userId, role: req.userRole } : null);
    res.json([...legacy, ...jobs]);
  });

  // ---- exploration jobs (Phase 1 intelligence engine, spec §15) ----
  app.post("/api/jobs/explore", ...credentialed({ queued: true }), async (req, res) => {
    const { url, username, password, cookies, storage, policy } = req.body || {};
    if (!url || !/^https?:\/\//i.test(url)) return res.status(400).json({ error: "url required (http(s))" });
    const guard = await validatePublicUrl(url);
    if (!guard.ok) { if (req.quotaRelease) await req.quotaRelease({ outcome: "cancelled" }); return res.status(400).json({ error: "url rejected: " + guard.error }); }
    if (policy !== undefined && (typeof policy !== "object" || policy === null || Array.isArray(policy))) { if (req.quotaRelease) await req.quotaRelease({ outcome: "cancelled" }); return res.status(400).json({ error: "policy must be an object" }); }
    const entry = exploration.queueExploration({
      url, username, password, cookies, storage, policy,
      userId: req.userId, orgId: req.tenantScope?.orgId || null,
    });
    auditSafe(auditEvents.taskCreate, { actorId: req.userId, targetType: "task", targetId: entry.tempId, metadata: { kind: "exploration", url } });
    // quota: queued reservation → running when the job actually dispatches;
    // released with the outcome when it terminates (4.0.4 accounting).
    const q = getCloneQueue();
    q.onStatus(({ entry: e }) => {
      if (e.tempId !== entry.tempId && e.jobId !== entry.tempId) return;
      if (["exploring", "reconstructing", "verifying"].includes(e.status)) {
        promoteReservation(req.quotaScope, req.quotaTaskKey, { userId: req.userId }).catch(() => {});
      }
      if (["completed", "completed_with_limitations", "error", "cancelled"].includes(e.status)) {
        releaseReservation(req.quotaScope, req.quotaTaskKey, { userId: req.userId, outcome: e.status === "error" ? "failed" : e.status === "cancelled" ? "cancelled" : "completed" }).catch(() => {});
      }
    });
    res.json({ jobId: entry.tempId, status: entry.status });
  });
  app.get("/api/jobs", ...credentialedRead(), async (req, res) => {
    // 4.0.12: authenticated callers see only their own/org jobs; anonymous
    // (loopback dashboard, legacy posture) sees ownerless entries only.
    const jobs = await exploration.listJobsFor(req.userId ? { userId: req.userId, role: req.userRole } : null);
    res.json(jobs);
  });
  app.get("/api/jobs/:jobId", ...credentialedRead(), async (req, res) => {
    // 4.0.12: owner-gated (org members / owner / platform-admin; anonymous → 404)
    const job = exploration.getExplorationJob(req.params.jobId);
    if (!job) return res.status(404).json({ error: "job not found" });
    if (req.userId && !(await exploration.identityCanAccessJob(req.params.jobId, { userId: req.userId, role: req.userRole }))) return res.status(404).json({ error: "job not found" });
    if (!req.userId) {
      // anonymous callers only ever see ownerless legacy entries (dashboard)
      if (job.owner) return res.status(404).json({ error: "job not found" });
    }
    res.json(job);
  });
  app.get("/api/jobs/:jobId/artifacts/*", ...credentialedRead(), async (req, res) => {
    // 4.0.12: access to job artifacts is gated by job ownership — a non-member
    // (or anonymous caller) gets 404 regardless of which root resolves.
    const job = exploration.getExplorationJob(req.params.jobId);
    if (job?.owner) {
      const ok = req.userId ? await exploration.identityCanAccessJob(req.params.jobId, { userId: req.userId, role: req.userRole }) : false;
      if (!ok) return res.status(404).json({ error: "not found" });
    }
    // 4.0.5: resolve through artifact-lifecycle (org-scoped root first, legacy
    // artifacts/<jobId>/ fallback — hook (c) from the module header)
    const root = path.join(process.cwd(), "artifacts");
    const { path: resolvedRoot } = resolveArtifactPath(req.params.jobId, { orgId: req.tenantScope?.orgId || undefined });
    const jobRoot = path.resolve(resolvedRoot);
    const file = path.resolve(resolvedRoot, req.params[0] || "manifest.json");
    // traversal guard: the resolved file must stay inside BOTH artifacts/ and
    // the resolved job dir (a startsWith(root) check alone is bypassable by
    // ../-encoded paths into sibling directories like artifacts-leak/)
    const relRoot = path.relative(root, file);
    const relJob = path.relative(jobRoot, file);
    if (relRoot.startsWith("..") || path.isAbsolute(relRoot) || relJob.startsWith("..") || path.isAbsolute(relJob) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) return res.status(404).json({ error: "not found" });
    res.sendFile(file);
  });
  app.get("/api/tasks/:id", localOrAuthed("read:task"), async (req, res) => {
    // check legacy task store first, then exploration-runner (pipeline v2)
    const meta = tasks.loadTask(req.params.id);
    if (meta) {
      // 4.0.12: legacy store tasks are per-user — authenticated callers see
      // only their own; anonymous keeps the local-dashboard posture (own
      // "local"-scope entries only — never another user's task metadata).
      if (req.userId && meta.userId !== req.userId) return res.status(404).json({ error: "not found" });
      if (!req.userId && meta.userId && meta.userId !== "local") return res.status(404).json({ error: "not found" });
      return res.json(meta);
    }
    const job = exploration.getExplorationJob(req.params.id);
    if (job) {
      // 4.0.12: owner-gated — non-members/anonymous get the same 404 as a
      // missing task (no existence leak)
      const ok = req.userId
        ? await exploration.identityCanAccessJob(req.params.id, { userId: req.userId, role: req.userRole })
        : !job.owner;
      if (!ok) return res.status(404).json({ error: "not found" });
      return res.json({
        id: job.jobId, url: job.url, status: job.status,
        pipeline: "v2", artifactsDir: job.artifactsDir,
        reconstruction: job.reconstruction || null,
        verification: job.verification || null,
        history: job.history || [],
      });
    }
    return res.status(404).json({ error: "not found" });
  });
  app.delete("/api/tasks/:id", localOrAuthed(null), async (req, res) => {
    // 4.0.12: destructive + cross-user reachable → owner-gated the same way as
    // GET /api/tasks/:id (a non-member's DELETE is a plain 404, no deletion).
    // 3.5.9: remote anonymous callers are refused by the gate above; loopback
    // anonymous may only delete its own "local"-scope tasks.
    const meta = tasks.loadTask(req.params.id);
    if (meta) {
      if (req.userId && meta.userId !== req.userId) return res.status(404).json({ error: "not found" });
      if (!req.userId && meta.userId && meta.userId !== "local") return res.status(404).json({ error: "not found" });
    } else {
      const job = exploration.getExplorationJob(req.params.id);
      if (job) {
        const ok = req.userId
          ? await exploration.identityCanAccessJob(req.params.id, { userId: req.userId, role: req.userRole })
          : !job.owner;
        if (!ok) return res.status(404).json({ error: "not found" });
      }
    }
    sessions.release(req.params.id);
    tasks.deleteTask(req.params.id);
    auditSafe(auditEvents.taskDelete, { actorId: req.userId, targetType: "task", targetId: req.params.id });
    res.json({ ok: true });
  });

  // ---- clone preview (with element picker injected) ----
  app.get("/preview/:id", localOrAuthed("read:task"), (req, res) => res.redirect(`/preview/${req.params.id}/index.html`));
  app.get("/preview/:id/*", localOrAuthed("read:task"), (req, res) => {
    const dir = tasks.outDir(req.params.id);
    const file = path.resolve(dir, req.params[0] || "index.html");
    // 3.5.9: relative containment — a bare startsWith(dir) check is bypassable
    // by sibling dirs sharing the prefix (…/t1/out vs …/t1/out-extra/)
    const rel = path.relative(path.resolve(dir), file);
    if (rel.startsWith("..") || path.isAbsolute(rel)) return res.status(403).send("forbidden");
    if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) return res.status(404).send("not found yet");
    if (file.endsWith(".html")) {
      let html = fs.readFileSync(file, "utf8");
      html = html.replace(/<\/body>/i, `<script>${PICKER_JS}</script>`);
      res.type("html").send(html);
    } else res.sendFile(file);
  });

  // ---- chat / edit selected element (reuses engine edit flow) ----
  app.post("/api/tasks/:id/chat", localOrAuthed(null), async (req, res) => {
    const { selector, info = {}, instruction } = req.body || {};
    // 3.5.9: basename-only — a body file like "../../package.json" must not
    // escape the task's out/ dir for read+write below
    const file = path.basename(String(req.body?.file || "index.html"));
    if (!instruction) return res.status(400).json({ error: "instruction required" });
    const cfg = loadConfig();
    if (cfg.model.provider === "none" || !cfg.model.apiKey) return res.status(400).json({ error: "no vision model configured (Settings → API providers, phase 6)" });
    const target = path.join(tasks.outDir(req.params.id), file);
    if (!fs.existsSync(target)) return res.status(404).json({ error: "clone not ready" });
    try {
      const { routeChat } = await import("./model-router.js");
      const { EDIT_SYSTEM, EDIT_ELEMENT } = await import("../prompts.js");
      const html = fs.readFileSync(target, "utf8");
      const { out, provider } = await routeChat(
        cfg,
        [{ role: "system", content: EDIT_SYSTEM }, { role: "user", content: EDIT_ELEMENT({ file, fileContent: html, selector, info, instruction }) }],
        { maxTokens: 4000, timeoutMs: 280000 },
        "edit-element",
      );
      console.log(`[chat] edit via provider: ${provider}`);
      const patch = firstJson(out);
      if (!patch) throw new Error("model returned no JSON patch");
      let updated = html;
      if (patch.replaceHtml?.find && patch.replaceHtml?.html) updated = updated.replace(patch.replaceHtml.find, patch.replaceHtml.html);
      if (patch.removeSelector) updated = updated.replace(new RegExp(`<\\w+[^>]*${patch.removeSelector.replace(/[.#]/g, "\\$&")}[^>]*>[\\s\\S]*?</\\w+>`, "i"), "");
      if (patch.css) {
        fs.appendFileSync(path.join(tasks.outDir(req.params.id), "chat-fixes.css"), `\n/* ${new Date().toISOString()} — ${instruction.replace(/\*\//g, "")} */\n${patch.css}\n`);
        if (!updated.includes("chat-fixes.css")) updated = updated.replace(/<\/head>/i, `<link rel="stylesheet" href="chat-fixes.css"></head>`);
      }
      if (updated === html) throw new Error("empty patch");
      fs.writeFileSync(target, updated);
      broadcast({ type: "preview:reload", data: { task: req.params.id } });
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ error: e.message.slice(0, 200) });
    }
  });

  // ---- export ----
  app.post("/api/export/:id", localOrAuthed("export:task"), async (req, res) => {
    try {
      // a v2 task created via POST /api/tasks is held under its temp handle —
      // resolve it to the real jobId before touching the artifacts tree
      const job = exploration.getExplorationJob(req.params.id);
      const id = job?.jobId || req.params.id;
      const isV2 = fs.existsSync(path.join(process.cwd(), 'artifacts', id, 'manifest.json'));
      // 4.0.12: v2 exports are owner-gated (org members/owner/admin; anonymous
      // → 404, same as a missing task — no existence leak via error text)
      if (isV2) {
        const ok = req.userId
          ? await exploration.identityCanAccessJob(id, { userId: req.userId, role: req.userRole })
          : !(job && job.owner);
        if (!ok) return res.status(404).json({ error: "not found" });
      } else if (!fs.existsSync(tasks.taskDir(req.params.id))) {
        return res.status(404).json({ error: "not found" });
      } else {
        // 3.5.9: legacy v1 exports are per-user too — an authenticated caller
        // may not export another user's task; loopback anonymous only "local"
        const meta = tasks.loadTask(req.params.id);
        if (meta) {
          if (req.userId && meta.userId !== req.userId) return res.status(404).json({ error: "not found" });
          if (!req.userId && meta.userId && meta.userId !== "local") return res.status(404).json({ error: "not found" });
        }
      }
      // v2 → 4.0.5-hooked path (org-aware dir + fail-closed finalize/shred);
      // v1 → unchanged exportTask flow (purgeCredentials semantics intact)
      const { zipPath, size } = isV2
        ? await startExport({ id, orgId: req.tenantScope?.orgId || null })
        : await exportTask(req.params.id);
      auditSafe(auditEvents.taskExport, { actorId: req.userId, targetType: "task", targetId: id, metadata: { kind: isV2 ? "v2" : "v1", size } });
      sessions.release(req.params.id); // explicit finish → close the session
      res.json({ ok: true, download: `/api/export/${req.params.id}/download`, size });
    } catch (e) {
      res.status(500).json({ error: e.message.slice(0, 200) });
    }
  });
  app.get("/api/export/:id/download", localOrAuthed("export:task"), async (req, res) => {
    // 3.5.9: downloads were fully unauthenticated — any remote caller could
    // fetch another user's export by id enumeration. Owner-gated like the
    // export POST: v2 registry jobs via identityCanAccessJob, legacy v1 via
    // meta.userId ("local"-scope for loopback anonymous).
    const job = exploration.getExplorationJob(req.params.id);
    if (job?.owner) {
      const ok = req.userId
        ? await exploration.identityCanAccessJob(req.params.id, { userId: req.userId, role: req.userRole })
        : false;
      if (!ok) return res.status(404).json({ error: "not found" });
    }
    const meta = tasks.loadTask(req.params.id);
    if (meta) {
      if (req.userId && meta.userId !== req.userId) return res.status(404).json({ error: "not found" });
      if (!req.userId && meta.userId && meta.userId !== "local") return res.status(404).json({ error: "not found" });
    }
    // 4.0.12 QA fix: v2 export zips live in the ARTIFACTS tree
    // (exporter.exportV2Task → artifacts/<jobId>/export.zip), not the v1
    // platform-data store — the URL POST /api/export advertises resolved to
    // the v1 path only and 404'd for every v2 job. Resolve the same way the
    // POST does (registry jobId → artifact-lifecycle root, legacy fallback).
    const v2Id = job?.jobId || req.params.id;
    const { path: v2Dir } = resolveArtifactPath(v2Id, { orgId: req.tenantScope?.orgId || undefined });
    const v2zip = path.join(v2Dir, "export.zip");
    const zipPath = fs.existsSync(v2zip) ? v2zip : path.join(tasks.taskDir(req.params.id), "export.zip");
    if (!fs.existsSync(zipPath)) return res.status(404).json({ error: "export first" });
    res.download(zipPath, `clone-${req.params.id}.zip`);
  });

  // ---- sessions (inspection panel uses the persistent session) ----
  // 3.5.9: loopback-or-authed — session/provider stats are operator surfaces,
  // not anonymous public data (local dashboard unchanged).
  app.get("/api/sessions", localOrAuthed(null), (_req, res) => res.json(sessions.stats()));
  // provider router stats (multi-model usage, quota tracking — spec §12)
  app.get("/api/providers", localOrAuthed(null), async (_req, res) => {
    const { getProviders, usageStats } = await import("./model-router.js");
    const cfg = loadConfig();
    res.json({ providers: getProviders(cfg).map((p) => ({ name: p.name, provider: p.provider, model: p.model, capabilities: p.capabilities, hasKey: !!p.apiKey })), usage: usageStats() });
  });

  const server = http.createServer(app);
  // exposed additively so the export/release lifecycle can be driven from
  // tests and the worker path (4.0.4/4.0.5 integration)
  const startExport = makeV2Exporter();

  // ---- WebSocket: authenticated upgrade + task-scoped rooms (spec §6/§9) ----
  // The upgrade validates an optional token (cookie `cloner_session` or
  // ?token=) against the sessions table. Unauthenticated upgrades are refused
  // with 401 UNLESS they come from loopback — the local dashboard
  // (platform-ui) connects with no token and keeps working through the
  // "legacy" room. Authenticated sockets join their `user:<id>` room instead.
  const wss = new WebSocketServer({
    server,
    path: "/ws",
    verifyClient: (info, cb) => {
      wsAuth.authenticateUpgrade(info.req).then((identity) => {
        if (!identity && !wsAuth.isLoopback(info.req.socket?.remoteAddress)) {
          cb(false, 401, "Unauthorized"); // remote + no valid token → refuse the handshake
          return;
        }
        info.req.wsIdentity = identity; // null for the legacy loopback dashboard
        cb(true);
      });
    },
  });
  const sockets = new Set();
  wss.on("connection", (ws, req) => {
    const identity = req?.wsIdentity || null; // { userId, role, email } | null
    ws.identity = identity;
    ws.rooms = new Set();
    if (identity) ws.rooms.add(`user:${identity.userId}`);
    else ws.rooms.add("legacy"); // unauthenticated LOCAL only — remote ones never get here
    sockets.add(ws);
    // catchup replay: unchanged (full ring buffer) for the legacy dashboard;
    // scoped to tasks the identity may access for authenticated sockets
    wsAuth.scopedCatchup(bus.catchUp(), identity)
      .then((data) => { try { ws.send(JSON.stringify({ type: "catchup", data })); } catch {} })
      .catch(() => {});
    ws.on("close", () => sockets.delete(ws));
    ws.on("message", (raw) => {
      try {
        const msg = JSON.parse(raw.toString());
        if (msg.type === "join" && msg.task) {
          if (!identity) { ws.taskId = msg.task; return; } // legacy dashboard: unchanged
          // authenticated: subscribe only to tasks this identity may access
          // (defense in depth — the emit-side gate below is authoritative)
          wsAuth.canAccessTask(msg.task, identity)
            .then((ok) => { if (ok) ws.taskId = msg.task; })
            .catch(() => {});
        }
      } catch {}
    });
  });

  // Scoped broadcast. Task identity: v1 events carry msg.task; v2 (exploration)
  // events are tagged inside the wrapped bus payload (data.job) or data.task.
  // A task event fans out ONLY to sockets authorized for it. v2 exploration
  // jobs (4.0.12): owner-tagged at enqueue → owner/user/org-member gating via
  // authorizedUserIds; ownerless legacy entries stay visible to every
  // authenticated socket. Unknown-owner tasks → legacy room only (fail closed
  // for authenticated fan-out; the local dashboard is unaffected). Events
  // without a task id broadcast to everyone, as before.
  async function broadcast(msg) {
    let gate = null;
    try {
      const taskId = msg?.task || msg?.data?.job || msg?.data?.task || msg?.data?.taskId || null;
      if (taskId) {
        const users = [...new Set([...sockets].filter((s) => s.identity).map((s) => s.identity.userId))];
        const allowed = await wsAuth.authorizedUserIds(taskId, users);
        gate = (ws) => ws.rooms.has("legacy") || (ws.identity && allowed.has(ws.identity.userId));
      }
    } catch {
      gate = (ws) => ws.rooms.has("legacy"); // unexpected failure → legacy room only
    }
    for (const ws of sockets) {
      try {
        if (gate && !gate(ws)) continue;
        if (!ws.taskId || !msg.task || ws.taskId === msg.task) ws.send(JSON.stringify(msg));
      } catch {}
    }
  }
  // engine progress → WS (tagged with the running task) + server-side console
  // (stdout is the only place errors survive when no WS client is attached)
  const T0 = Date.now();
  const at = () => `+${((Date.now() - T0) / 1000).toFixed(1)}s`;
  for (const evt of ["step", "log", "tabs:found", "assets:progress", "assets:done", "page:goto", "run:done", "run:error", "polish:round"]) {
    bus.on(evt, (e) => {
      // 4.0.12 QA fix: the event's OWN job tag wins over the shared v1
      // currentTaskId global — a stale v1 id (set by the last legacy runTask)
      // used to hijack attribution of every later bus emission, breaking
      // delivery of correctly-tagged v2 org-job events (fail-closed, but the
      // owner got nothing). v1 engine emissions carry no tag (null) and fall
      // back to currentTaskId, exactly as before.
      broadcast({ type: evt, task: e?.job || currentTaskId || null, data: e });
      // events.js wraps payloads as {type, data, t} — read from e.data
      const d = e?.data || {};
      if (evt === "step") console.log(`[${at()}][${currentTaskId || "-"}] ${d.status || ""} ${d.msg || d.id || ""}`);
      else if (evt === "log") console.log(`[${at()}][${currentTaskId || "-"}] ${d.level === "warn" ? "WARN" : "·"} ${d.msg || ""}`);
      else if (evt === "run:error") console.error(`[${at()}][${currentTaskId || "-"}] RUN ERROR ${d.error || ""}`);
    });
  }
  let currentTaskId = null;

  // ---- audit helper: best-effort, never breaks a business flow (4.0.9) ----
  function auditSafe(fn, payload) {
    try { Promise.resolve(fn({ ...payload, actorType: payload.actorType || (req_user_type(payload) ? "user" : "local") })).catch(() => {}); } catch {}
  }
  const req_user_type = () => true; // HTTP callers are users; local dashboard keeps the default actor type

  // ---- task runner: engine pipeline + verification, wired to the task ----
  async function runTask(id) {
    const meta = tasks.loadTask(id);
    if (!meta) return;
    currentTaskId = id;
    tasks.updateTask(id, { status: "running" }, "clone started");
    const priv = path.join(tasks.taskDir(id), "private");
    const cookiesFile = fs.existsSync(path.join(priv, "cookies.json")) ? path.join(priv, "cookies.json") : null;
    const storageFile = fs.existsSync(path.join(priv, "storage.json")) ? JSON.parse(fs.readFileSync(path.join(priv, "storage.json"), "utf8")) : undefined;
    const out = tasks.outDir(id);
    const cookies = meta.hasCookies ? loadCookies(cookiesFile) : null;
    const cfg = loadConfig();
    // vision polish ON by default (model router handles providers); a task can opt out
    if (meta.noPolish) cfg.polish = { enabled: false };
    await cloneUrl(meta.url, cfg, out, { cookies, storage: storageFile, interactions: { waitMs: 800, max: 56, triggerMax: 140, budgetMs: 170000 } });
    tasks.updateTask(id, { status: "verifying" }, "clone complete — verifying");
    const artifacts = {};
    for (const f of ["index.html", "snapshot.mhtml", "exploration.md", "exploration.json", "design-tokens.json", "cloner-runtime.js", "clone.json"]) {
      const fp = path.join(out, f);
      if (fs.existsSync(fp)) artifacts[f.replace(".md", "").replace(".json", "").replace(".html", "").replace(".mhtml", "").replace(".js", "")] = f;
    }
    if (fs.existsSync(path.join(out, "scaffold"))) artifacts.scaffold = "scaffold/";
    const verification = await verifyTask(out);
    tasks.updateTask(id, { status: verification.passed ? "done" : "done", artifacts, verification }, `verification ${verification.passed ? "passed" : "completed with failures"}`);
    broadcast({ type: "task:done", task: id, data: { verification: verification.passed } });
  }

  // retention sweep (15-day default) on boot + hourly (v1 platform-data dirs,
  // src/platform/tasks.js) — the 4.0.5 artifacts-tree lifecycle sweep runs on
  // the queue adapter below (memory backend executes inline, as tested).
  const removed = tasks.sweepExpired();
  if (removed.length) console.log(`[retention] removed ${removed.length} expired task(s)`);
  setInterval(() => tasks.sweepExpired(), 3600_000).unref();

  // 4.0.5 artifact lifecycle: scheduled sweep through the queue adapter
  // (enqueueSweep contract — memory backend executes in-process; bullmq gets
  // the {kind:'artifact-sweep'} payload for a worker-side executor).
  try {
    const sweepEntry = enqueueSweep(getCloneQueue());
    console.log(`[lifecycle] artifact sweep ${sweepEntry.status} (${sweepEntry.sweepPayload?.kind || "artifact-sweep"})`);
  } catch (e) {
    console.warn(`[lifecycle] artifact sweep skipped: ${e.message}`);
  }
  setInterval(() => {
    try { enqueueSweep(getCloneQueue()); } catch (e) { console.warn(`[lifecycle] sweep failed: ${e.message}`); }
  }, 3600_000).unref();

  return new Promise((resolve) => {
    // broadcast is exposed additively so tests can drive the production emit path
    server.listen(port, () => {
      // Resolve with the ACTUAL bound port (server.address()), not the requested
      // one — callers passing port: 0 (bin/platform.js ephemeral boot, test
      // suites) would otherwise resolve port: 0 and cannot reach the server.
      const bound = server.address()?.port ?? port;
      resolve({ server, wss, port: bound, broadcast });
    });
  });
}

function firstJson(text) {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const c = fenced ? fenced[1] : text;
  const s = c.indexOf("{");
  for (let e = c.lastIndexOf("}"); e > s; e = c.lastIndexOf("}", e - 1)) {
    try { return JSON.parse(c.slice(s, e + 1)); } catch {}
  }
  return null;
}

// ---- 4.0.5 export hooks (documented in artifact-lifecycle.js header) ----
//   (a) v2TaskDir → exportV2Dir (org-scoped roots readable, legacy fallback);
//   (b) v2 exports finalize with finalizeExportV2 — ZIP integrity verified
//       FAIL-CLOSED first, then private/ + sensitive-named files shredded
//       (same predicate the export filter uses), digest recorded in the
//       manifest lifecycle header.
// Both honor orgId when the caller carries a tenant scope.
function makeV2Exporter() {
  return async ({ id, orgId = null } = {}) => {
    const job = exploration.getExplorationJob(id);
    const jobId = job?.jobId || id;
    const v2Dir = resolveArtifactPath(jobId, { orgId: orgId || undefined }).path;
    const { exportV2Task } = await import("./exporter.js");
    const out = await exportV2Task(jobId);
    try {
      const { finalizeExportV2 } = await import("../storage/artifact-lifecycle.js");
      finalizeExportV2({ jobDir: v2Dir, zipPath: out.zipPath });
    } catch (e) {
      console.error(`[export] v2 finalize failed for ${jobId}: ${e.message}`);
    }
    return out;
  };
}
