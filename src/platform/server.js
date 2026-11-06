// Cloner platform server: task API, persistent sessions, WebSocket progress,
// preview + element picker, verification, export. The engine (src/*.js) does the
// reverse engineering; this is the product shell around it.
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import express from "express";
import { WebSocketServer } from "ws";
import { fileURLToPath } from "node:url";
import { bus, withJobScope } from "../events.js";
import { loadConfig } from "../config.js";
import { cloneUrl } from "../cloneUrl.js";
import { validatePublicUrl } from "../security/url-guard.js";
import { loadCookies } from "../browser.js";
import * as exploration from "./exploration-runner.js";
import * as wsAuth from "./ws-auth.js";
import * as tasks from "./tasks.js";
import * as sessions from "./sessions.js";
import { exportTask, exportV2Task } from "./exporter.js";
import { verifyTask } from "../reconstruction/verify.js";
import { buildBlueprint } from "../reconstruction/blueprint.js"; // ADR-0003: blueprint approve re-run
import { authRequired, requireRole, tokenFingerprint } from "../auth/auth-middleware.js";
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
import { QuotaExceededError } from "./quota-service.js";
import { checkLimit, rateLimitHeaders } from "./rate-limiter.js";
import { getCloneQueue } from "../queues/clone-queue.js";
import { runPipelineJob } from "../queues/pipeline-job.js"; // 4.2.9 re-route fallback executor (mirrors clone-worker)
import { versionsRouter } from "./version-service.js";               // 4.1.3 project versions
import { resolveArtifactPath, sweep as artifactSweep, enqueueSweep } from "../storage/artifact-lifecycle.js"; // 4.0.5
import { dashboardRouter } from "./dashboard-routes.js";              // G2.1 dashboard summary + quota widgets
// ---- Phase 4.2 / 4.5 / G-series integrations (grand-final integration) ----
import { regionRouter, getRegionRegistry } from "../distributed/region-registry.js";               // 4.2.1 region registry
import { createReplicationRouter, attachReplicationToQueue } from "../storage/artifact-replication.js"; // 4.2.3 artifact replication
import { failoverRoutes, createFailoverController, createQueueDispatcher } from "../distributed/failover.js"; // 4.2.9 failover
import { attachTraceSinkFromEnv } from "../observability/trace-export.js";                          // 4.2.10 tracing export
import { capacityRouter } from "./routes-capacity.js";                                              // 4.2.11 capacity dashboards
import { hooksRouter, installWorkflowHooks, emitTaskLifecycleEvent } from "./workflow-hooks.js";    // 4.2.15 workflow hooks
import { notificationRouter } from "./notification-delivery.js";                                    // 4.2.16 notifications
import { githubPublishRouter } from "./github-publish-real.js";                                     // G1.1 real GitHub publish
import { createEmailRouter } from "./email-real.js";                                                // G1.2 real SMTP email
import { uiConfigRouter } from "./ui-config-routes.js";                                             // G2.3 provider config
import { createRecoveryRouter } from "./session-recovery.js";                                       // 4.5.3 export recovery
import { oauthRouter } from "./oauth-real.js";                                                      // 4.5.1 google-only OAuth
import { billingRouter, billingRawBody } from "./billing-stripe.js";                                // 4.5.2 zero-dollar billing
import { adsRouter } from "../monetization/ad-slots.js";                                            // 4.5.4 ad provider core
import { adConfigRouter } from "../monetization/ad-config-api.js";                                  // 4.5.5 per-task monetize flag
import { intelligenceRouter } from "./intelligence/intelligence-routes.js";                         // G3.3 ops intelligence
import { monetizeOptInMiddleware } from "./ads-optin.js";                                           // 4.5.5 opt-in capture
import { createPluginRegistry } from "../integrations/plugin-framework.js";                         // 4.2.14 plugin framework
import { settleJobCost, setCreditLedger, isInsufficientCreditsError, LedgerSettlementError } from "./compute-accounting.js";
import { resolveScope } from "./quota-service.js";
import { progressRoutes } from "./progress-routes.js";                          // progress build viewer (integrator mount line — progress-routes.js header)

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export function startPlatform({ port = 4180 } = {}) {
  const app = express();
  // G5.2 hunt hardening: management surfaces take SMALL JSON payloads only.
  // Mounted BEFORE the 20mb parser — the first matching parser consumes the
  // stream, so an oversized auth/key body is rejected with 413 without ever
  // being parsed or hashed (2MB bodies were previously accepted on
  // /api/auth/register — a bcrypt round on megabytes of password per request —
  // and on /api/keys; every route parsed up to 20MB).
  app.use("/api/auth", express.json({ limit: "32kb" }));
  app.use("/api/keys", express.json({ limit: "64kb" }));
  // Billing (4.5.2) BEFORE the global 20mb parser: the /webhook route needs the
  // EXACT raw request bytes for HMAC verification — billingRawBody() fails
  // closed (500 + actionable message) when a parser already consumed the
  // stream. checkout/portal parse their own small JSON inside the router.
  app.use("/api/billing", billingRouter());
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

  // 6. Dashboard aggregate (G2.1): task-history summary + caller quota usage for
  //    the operator dashboard clients (headless since G7.1 — API consumers only).
  //    Carries its own credentialedRead-style credential resolution (anonymous
  //    loopback keeps the legacy local-dashboard posture).
  app.use("/api/dashboard", dashboardRouter());

  // ---- distributed-plane boot wiring (4.2.x) — runs BEFORE the mounts that
  // reference the objects they create ----
  // Trace sink (4.2.10): spans export to JSONL when CLONER_TRACING != "0".
  attachTraceSinkFromEnv();

  // Artifact replication (4.2.3): copy-on-complete to REPLICATION_REGIONS
  // roots; a no-op (origin-only) when the env is unset.
  const detachReplication = attachReplicationToQueue(getCloneQueue());
  void detachReplication; // process-lifetime wiring; no shutdown path tears it down

  // Workflow hooks (4.2.15): v2 queue status → user webhook fan-out.
  installWorkflowHooks({ queue: getCloneQueue() });

  // Plugin framework (4.2.14): lifecycle hooks for first-party integrations;
  // audit events land in the hash-chained trail (never throws). Exposed on
  // globalThis so the quota guard's rejection path can reach it without an
  // import cycle.
  const plugins = createPluginRegistry({ audit: (e) => auditSafe(recordAuditEventSafe, e) });
  plugins.attachEventBus(bus);
  globalThis.__clonerPlugins = plugins;

  // Compute accounting (4.2.12): the free-platform grant ledger is the real
  // ledger; it is GRANT-ONLY (no debit interface — see credit-ledger.js), so
  // settlements persist with status 'unposted' until a debit-capable ledger is
  // injected. setCreditLedger(null) keeps the accounting path live with the
  // documented sweep upgrade path (one call with any debit-capable object).
  setCreditLedger(null);

  // Ops failover controller (4.2.9): heartbeat sweep + re-route handoff
  // through the REAL queue. A re-routed job's run closure resolves back to the
  // pipeline the payload already carries (memory backend executes in-process;
  // a BullMQ deployment consumes the region queue from its worker process).
  // resolveRun shape fix (wave 7): the shipped resolver returned `{ run: fn }`
  // — an OBJECT — so the memory backend's `d.run(...)` call errored every
  // re-routed entry with "d.run is not a function" (reproduced in
  // scripts/test-distributed-plane.mjs §6), and `job.payload.run` was in any
  // case always absent: the failover ledger round-trips every record through
  // JSON (MemoryStore AND RedisStore stringify), which drops functions.
  // resolveReroutedRun (bottom of this file) resolves the run BY JOB PAYLOAD —
  // the shared runPipelineJob / sweep rebuilt over the JSON-surviving payload,
  // exactly how clone-worker's defaultExecutor resolves the pipeline — and
  // returns the FUNCTION the dispatcher's `run:` slot expects.
  const failover = createFailoverController({
    dispatch: createQueueDispatcher(getCloneQueue(), resolveReroutedRun),
  });
  failover.start();

  // 7. Billing (4.5.2): mounted ABOVE (before express.json) — the /webhook
  //    route requires raw request bytes for signature verification.

  // 8. Recovery (4.5.3): one-click-export import + resume. express.raw is
  //    per-route inside the router (application/zip, 1GB); the tenant-scope
  //    middleware only validates membership when ?orgId= is present.
  app.use("/api/recovery", createRecoveryRouter({ authRequired, tenantScope: resolveTenantScope }));

  // 9. Notifications (4.2.16): per-user email/webhook preferences + delivery
  //    log; all rows session-scoped inside the router.
  app.use("/api/notifications", notificationRouter());

  // 10. Email (G1.2): real SMTP send + receipts (env-configured; 503
  //     EMAIL_NOT_CONFIGURED when SMTP_* is absent).
  app.use("/api/email", createEmailRouter());

  // 11. Model-provider config (G2.3): onboarding rotation + REAL probes; the
  //     router carries its own loopback-or-authed gate.
  app.use("/api/config", uiConfigRouter());

  // 12. Ads (4.5.4/4.5.5): provider-tag serving (public, anonymous session
  //     cookie for frequency caps) + per-task monetize flag management.
  app.use("/api/ads", adsRouter());
  app.use("/api/ad-config", adConfigRouter());

  // 13. Capacity dashboards (4.2.11): operator surface — the router carries
  //     authRequired + its own admin guard (403 non-admin).
  app.use("/api/capacity", capacityRouter());

  // 14. Ops intelligence (G3.3): same operator posture; engines degrade to
  //     200 {degraded:true} when their data source is unavailable.
  app.use("/api/intelligence", intelligenceRouter());

  // 15. Region registry admin (4.2.1): the registry is the coordinator's
  //     in-memory plane; guarded with the platform auth (operator surface).
  app.use("/api/regions", regionRouter({ registry: getRegionRegistry(), authRequired }));

  // 16. GitHub publish (G1.1): the router demands a guard — mounted AFTER the
  //     middleware family is defined below (see the github mount note there).
  // 17. Workflow hooks (4.2.15): user-defined lifecycle webhook receivers;
  //     the router carries its own authRequired.
  app.use("/api/hooks", hooksRouter);

  // 18. Google-only OAuth (4.5.1): self-contained login flow; sessions it
  //     creates satisfy the existing authRequired surfaces.
  app.use("/api/auth/oauth", oauthRouter());

  // 19. Distributed failover ops (4.2.9): region heartbeat/reroute/replica
  //     admin under one controller; admin-only for state-mutating routes.
  const failoverGuard = (req, res, next) => {
    if (req.userRole === "admin") return next();
    res.status(403).json({ error: "admin role required" });
  };
  app.use("/api/distributed", failoverRoutes({ controller: failover, guard: failoverGuard }));

  // ---- database migrations (run once at boot) ----
  migrate().catch((e) => console.error('[db] migration failed:', e.message));

  // ---- auth routes (spec §6) — security events land in audit_events (4.0.9) ----
  // G5.2 hunt hardening: per-IP throttle on the credential endpoints. They were
  // previously UNLIMITED — 40 rapid bad logins all returned 401 with no 429
  // (credential stuffing and bcrypt CPU burn were free). Limiter ids are
  // per-route + per-IP, never token material. Limits via env; a limiter outage
  // fails open so auth availability never depends on the limiter.
  const authLimits = () => ({
    perMinute: Number(process.env.AUTH_RATE_LIMIT_PER_MINUTE || 15),
    perHour: Number(process.env.AUTH_RATE_LIMIT_PER_HOUR || 150),
  });
  const authThrottle = (route) => async (req, res, next) => {
    try {
      const result = await checkLimit(`auth:${route}:${req.ip || "unknown"}`, authLimits());
      for (const [h, v] of Object.entries(rateLimitHeaders(result))) res.setHeader(h, v);
      if (!result.allowed) return res.status(429).json({ error: "too many attempts — try again later", retryAfterMs: result.retryAfterMs });
    } catch { /* rate limiter unavailable → fail open for auth availability */ }
    next();
  };
  app.post('/api/auth/register', authThrottle("register"), async (req, res) => {
    try {
      const { email, password } = req.body || {};
      const user = await auth.registerUser(email, password);
      auditSafe(auditEvents.register, { actorEmail: user.email, actorId: user.id, targetType: "user", targetId: user.id });
      res.json({ ok: true, userId: user.id, email: user.email });
    } catch (e) { res.status(400).json({ error: e.message.slice(0, 120) }); }
  });
  app.post('/api/auth/login', authThrottle("login"), async (req, res) => {
    try {
      const { email, password } = req.body || {};
      const session = await auth.loginUser(email, password);
      // hunt G5.3 fix: NEVER write the raw bearer token into the audit log —
      // audit_events.target_id was storing the full session credential, which
      // turned every audit reader (admin, exports, backups) into a session
      // hijack. Only a non-reversible fingerprint goes in.
      const tokFp = tokenFingerprint(session.token);
      auditSafe(auditEvents.loginSuccess, { actorEmail: session.email, actorId: session.userId, sessionId: tokFp, targetType: "session", targetId: tokFp });
      // G5.5 human-journey fix: hand the session to the BROWSER too (HttpOnly,
      // SameSite=Strict, 7-day TTL matching SESSION_TTL_MS). Browser
      // navigations (clone preview, iframe loads) cannot set an Authorization
      // header; ws-auth.authenticateUpgrade already trusted this exact cookie
      // for WS upgrades, and the preview/authed routes now resolve the same
      // identity from it. API-only callers keep using the Bearer header — the
      // cookie is additive, never a replacement.
      res.setHeader("Set-Cookie",
        `cloner_session=${session.token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${7 * 24 * 3600}`);
      res.json({ ok: true, token: session.token, userId: session.userId, email: session.email, expiresAt: session.expiresAt });
    } catch (e) {
      auditSafe(auditEvents.loginFailure, { actorEmail: (req.body || {}).email || null, targetType: "session" });
      res.status(401).json({ error: e.message.slice(0, 120) });
    }
  });
  app.post('/api/auth/logout', authRequired, async (req, res) => {
    const token = (req.headers.authorization || '').replace('Bearer ', '');
    await auth.revokeSession(token);
    const tokFp = tokenFingerprint(token); // fingerprint only — never the raw token
    auditSafe(auditEvents.sessionRevoked, { actorId: req.userId, sessionId: tokFp, targetType: "session", targetId: tokFp });
    // clear the browser-side session cookie set at login (G5.5 human journey)
    res.setHeader("Set-Cookie", "cloner_session=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0");
    res.json({ ok: true });
  });
  app.get('/api/auth/me', authRequired, (req, res) => {
    res.json({ userId: req.userId, email: req.userEmail, role: req.userRole });
  });

  // ---- API-first backend (G7.1 superseded by ADR-0004) ----
  // G7.1 ("backend-only, UI removed") is superseded: the 8-page product UI is
  // served statically from platform-ui/ at "/", mounted AFTER every route
  // below (see the static mount near the end of this function) so /api, /ws,
  // /preview and /progress keep absolute precedence. Clients still integrate
  // through /api/* (tasks, jobs, exports, admin, dashboard, config) and the
  // /ws event stream; generated CLONES are still served under /preview/:id.
  // picker script injected into previews (element selection)
  const PICKER_JS = fs.readFileSync(path.join(__dirname, "..", "picker.js"), "utf8");

  // ---- tasks ----
  // Credentialed-caller chain (Phase 4.0 order: auth → tenant → quota →
  // rate-limit → handler). Anonymous local callers (the pre-existing local
  // dashboard clients) still work: when no Authorization header AND no X-API-Key header
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
  // G5.1 hunt fix: a PRESENTED credential must be ENFORCED, never silently
  // downgraded to anonymous. Previously any Authorization value that was not
  // exactly "Bearer <token>" (empty header, bare "Bearer", lowercase scheme,
  // "Basic …") and an EMPTY x-api-key header fell through to the
  // loopback-anonymous branch — a caller who MEANT to authenticate received
  // anonymous 200s (probe: `bearer <valid>`, `Bearer `, `Basic …` all → 200 on
  // GET /api/tasks). Now: an Authorization header that is not "Bearer <tok>"
  // is a 401; an x-api-key header present in ANY form (including "") goes to
  // key validation (invalid → 401). Only a request with NO credential headers
  // at all reaches the loopback-anonymous legacy posture.
  function enforceOrAnonymous(req, res, next, { keyScope } = {}) {
    const auth = req.headers.authorization;
    if (auth !== undefined) {
      if (typeof auth !== "string" || !auth.startsWith("Bearer ") || auth.slice(7).trim() === "") {
        return res.status(401).json({ error: "malformed authorization header" });
      }
      return authRequired(req, res, next);
    }
    if (req.headers["x-api-key"] !== undefined) return apiKeyAuth(keyScope)(req, res, next);
    // G5.2 hunt hardening: ANONYMOUS task creation is loopback-only. A
    // REMOTE anonymous caller previously got free clone compute (real
    // browser jobs) with zero credentials — probe: remote POST /api/tasks
    // returned 200. The local dashboard keeps its legacy posture.
    if (!wsAuth.isLoopback(req.socket?.remoteAddress)) return res.status(401).json({ error: "authentication required" });
    req.userId = null; // anonymous local dashboard (legacy posture)
    next();
  }
  const credentialed = (opts = {}) => [
    (req, res, next) => enforceOrAnonymous(req, res, next, { keyScope: opts.scope || "create:task" }),
    resolveTenantScopeSoft, // 4.0.1: only when an org context was requested
    // quota guard (4.0.4) applies to identified callers only — quotas are
    // per-user/org scopes and an anonymous request has none. Anonymous/local
    // (req.userId null) passes through with NO reservation; req.quotaRelease
    // stays undefined and the handlers skip it (documented above).
    // G5.2 hunt fix: the org pool comes from the VALIDATED tenant scope, never
    // from body.orgId — a member of org A could otherwise smuggle
    // {orgId: <org B>} past the header-validated membership check and consume
    // org B's slots/daily accounting without membership (probe: reservation
    // landed in org B). tenantScope is authoritative whenever it resolved; it
    // is undefined only when no org context was named (→ personal scope).
    (req, res, next) => {
      if (!req.userId) return next();
      return quotaGuard({
        getOrgId: (rq) => rq.tenantScope?.orgId || null,
        // quotaGuard expects a callable; accept a boolean or a per-request fn
        queued: (rq) => !!(typeof opts.queued === "function" ? opts.queued(rq) : opts.queued),
        estimatedBytes: (rq) => (typeof opts.estimatedBytes === "function" ? opts.estimatedBytes(rq) : opts.estimatedBytes || 0),
        explorationMinutes: (rq) => (typeof opts.explorationMinutes === "function" ? opts.explorationMinutes(rq) : opts.explorationMinutes || 0),
      })(req, res, next);
    },
  ];

  // G5.2 hunt hardening: per-field payload caps on job submission. Previously
  // UNBOUNDED per field (30k instructions, 4k usernames, 1.6MB cookie blobs all
  // accepted at 200) — every accepted job carried the whole blob into the
  // registry entry, the queue payload and (v1) task.json.
  const TASK_FIELD_LIMITS = { instructions: 20_000, username: 500, password: 500, cookies: 1_500_000, storage: 1_500_000, policy: 200_000 };
  // ---- per-job compute accounting (4.2.12): the job-completion path settles
  // ONE cost row per (scope, taskKey) after the quota release. Never throws —
  // an accounting failure must never break a completed job's response shape.
  function dirSizeSync(dir) {
    try {
      let total = 0;
      const stack = [dir];
      while (stack.length) {
        const d = stack.pop();
        let entries;
        try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { continue; }
        for (const ent of entries) {
          const full = path.join(d, ent.name);
          try {
            if (ent.isDirectory()) stack.push(full);
            else if (ent.isFile()) total += fs.statSync(full).size;
          } catch { /* raced file — skip */ }
        }
      }
      return total;
    } catch { return 0; }
  }
  async function settleJobCostSafe({ userId, orgId, taskKey, queuedAt, finishedAt, artifactsDir, status }) {
    try {
      if (!userId || !taskKey) return; // anonymous/local tasks have no scope to bill
      if (!["completed", "completed_with_limitations", "error"].includes(status)) return; // cancelled jobs settle nothing
      const scope = resolveScope({ userId, orgId });
      const runtimeMs = Math.max(0,
        (Date.parse(finishedAt || "") || Date.now()) - (Date.parse(queuedAt || "") || Date.now()));
      const artifactBytes = artifactsDir ? dirSizeSync(artifactsDir) : 0;
      await settleJobCost(scope, taskKey, {
        userId,
        runtimeMs,
        browserSlots: 1, // one clone browser slot per job (the platform's concurrency unit)
        artifactBytes,
        meta: { status, pipeline: true },
      });
    } catch (e) {
      // refused/failed settlements are recorded on the row by settleJobCost
      // itself; only an unexpected crash lands here — log, never rethrow.
      console.warn(`[accounting] settle ${taskKey}: ${e?.message || e}`);
    }
  }
  function taskFieldError(body) {
    const b = body || {};
    const sizeOf = (v) => (typeof v === "string" ? v.length : v == null ? 0 : JSON.stringify(v).length);
    if (b.instructions !== undefined && String(b.instructions).length > TASK_FIELD_LIMITS.instructions) return { status: 400, error: `instructions too long (max ${TASK_FIELD_LIMITS.instructions} chars)` };
    if (b.username !== undefined && String(b.username).length > TASK_FIELD_LIMITS.username) return { status: 400, error: `username too long (max ${TASK_FIELD_LIMITS.username} chars)` };
    if (b.password !== undefined && String(b.password).length > TASK_FIELD_LIMITS.password) return { status: 400, error: `password too long (max ${TASK_FIELD_LIMITS.password} chars)` };
    if (b.cookies !== undefined && sizeOf(b.cookies) > TASK_FIELD_LIMITS.cookies) return { status: 413, error: "cookies payload too large (max ~1.5MB)" };
    if (b.storage !== undefined && sizeOf(b.storage) > TASK_FIELD_LIMITS.storage) return { status: 413, error: "storage payload too large (max ~1.5MB)" };
    if (b.policy !== undefined && sizeOf(b.policy) > TASK_FIELD_LIMITS.policy) return { status: 413, error: "policy payload too large (max ~200KB)" };
    return null;
  }
  // G5.2 hunt fix: a promotion REFUSAL (the scope really is at its concurrent
  // limit) must stop the job — the old `.catch(() => {})` swallowed the
  // QuotaExceededError and the job EXECUTED anyway, so two concurrent
  // submissions could both pass the read-only preflight and run past
  // max_concurrent_jobs (one reservation stuck 'queued' while its job ran).
  const cancelOnQuotaRefusal = (handle) => (e) => {
    if (e instanceof QuotaExceededError) getCloneQueue().cancel(handle).catch(() => {});
  };

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
    const fieldErr = taskFieldError(req.body);
    if (fieldErr) { if (req.quotaRelease) await req.quotaRelease({ outcome: "cancelled" }); return res.status(fieldErr.status).json({ error: fieldErr.error }); }
    // G5.1 hunt fix: EVERY 4xx after the quota guard must release the slot it
    // reserved — the url-required branch used to leak the reservation (two
    // malformed submissions permanently exhausted a fresh user's concurrent
    // limit; reproduced: 2× POST {} → 2 stuck 'running' rows → valid 3rd job
    // 429 QUOTA_EXCEEDED).
    if (!url || !/^https?:\/\//i.test(url)) { if (req.quotaRelease) await req.quotaRelease({ outcome: "cancelled" }); return res.status(400).json({ error: "url required (http(s))" }); }
    // G5.1 hunt fix: an unknown pipeline value must not silently launch the
    // legacy v1 browser flow — a typo'd "v3" used to run a completely
    // different pipeline (real browser job) with no error.
    if (pipeline !== undefined && pipeline !== "v1" && pipeline !== "v2") { if (req.quotaRelease) await req.quotaRelease({ outcome: "cancelled" }); return res.status(400).json({ error: "pipeline must be \"v1\" or \"v2\"" }); }
    const guard = await validatePublicUrl(url);
    if (!guard.ok) { if (req.quotaRelease) await req.quotaRelease({ outcome: "cancelled" }); return res.status(400).json({ error: "url rejected: " + guard.error }); }
    // pipeline "v2" → exploration + reconstruction + verification (integrated)
    // pipeline "v1" or absent → legacy cloneUrl flow (backward compatible)
    if (pipeline === "v2") {
      let entry;
      try {
        entry = exploration.queueExploration({
          url, username, password, cookies, storage, instructions,
          userId: req.userId, orgId: req.tenantScope?.orgId || null,
        });
      } catch (e) {
        // G5.1 hunt fix: a throw after reservation must not leak the slot
        if (req.quotaRelease) await req.quotaRelease({ outcome: "cancelled" });
        return res.status(500).json({ error: "internal error" });
      }
      auditSafe(auditEvents.taskCreate, { actorId: req.userId, targetType: "task", targetId: entry.tempId, metadata: { pipeline: "v2", url } });
      // quota lifecycle: a free slot may have started the job inline — promote
      // the queued reservation; release is deferred to the queue's terminal
      // event. G5.2: the terminal branch ALSO unsubscribes this listener —
      // every submission used to leave a permanent closure on the queue's
      // "status" event (probe: listenerCount grew 13→18 after 5 submissions
      // and never came back → unbounded memory on a long-lived server).
      const q = getCloneQueue();
      promoteReservation(req.quotaScope, req.quotaTaskKey, { userId: req.userId }).catch(cancelOnQuotaRefusal(entry.tempId));
      // G5.1 (BUG #9): v2 jobs get the same DB mirror as v1 — the admin task
      // inventory reads PostgreSQL, so a v2 clone that never lands a row is
      // invisible to the operator. The listener below keeps the row's status
      // in step with the pipeline's terminal state.
      let v2DbTaskId = null;
      if (req.userId) {
        taskRepo.createTask({ userId: req.userId, url, options: { pipeline: "v2", jobId: entry.tempId } })
          .then((row) => { v2DbTaskId = row.id; })
          .catch((e) => console.warn(`[tasks] db mirror failed for ${entry.tempId}: ${e.message}`));
      }
      const v2StatusCol = (s) => (s === "completed" ? "done" : s === "completed_with_limitations" ? "done" : s === "error" ? "error" : s === "cancelled" ? "cancelled" : s);
      const off = q.onStatus(({ entry: e }) => {
        if (e.tempId !== entry.tempId && e.jobId !== entry.tempId) return;
        if (!["completed", "completed_with_limitations", "error", "cancelled"].includes(e.status)) return;
        if (off) off();
        if (v2DbTaskId && req.userId) {
          // options.jobId = the registry handle (e.jobId once dispatch links it)
          // so the admin inventory can correlate a DB row with artifacts/<exp-…>
          const dbPatch = { status: v2StatusCol(e.status), completed_at: new Date().toISOString() };
          if (e.error) dbPatch.error = String(e.error).slice(0, 300);
          taskRepo.getTask(v2DbTaskId, req.userId)
            .then((row) => {
              const opts = { ...(row?.options || {}), jobId: e.jobId || entry.tempId };
              return taskRepo.updateTask(v2DbTaskId, req.userId, { ...dbPatch, options: opts });
            })
            .catch(() => {
              taskRepo.updateTask(v2DbTaskId, req.userId, dbPatch).catch(() => {});
            });
        }
        releaseReservation(req.quotaScope, req.quotaTaskKey, { userId: req.userId, outcome: e.status === "error" ? "failed" : e.status === "cancelled" ? "cancelled" : "completed" }).catch(() => {});
        // 4.2.12 per-job compute accounting (after the quota release, per the
        // integration contract) — cancelled jobs settle nothing.
        const terminalEntry = q.getEntry(e.jobId || entry.tempId);
        settleJobCostSafe({
          userId: req.userId, orgId: req.tenantScope?.orgId || null, taskKey: e.jobId || entry.tempId,
          queuedAt: terminalEntry?.queuedAt || entry.queuedAt, finishedAt: terminalEntry?.finishedAt || null,
          artifactsDir: e.artifactsDir || terminalEntry?.artifactsDir || null, status: e.status,
        });
      });
      res.json({ id: entry.tempId, status: entry.status, pipeline: "v2" });
      return;
    }
    const meta = tasks.createTask({ url, mode, username, password, cookies, storage, instructions, userId: req.userId || "local" });
    // G5.1 hunt fix (BUG #9): mirror the task into the DB `tasks` table — the
    // product API never wrote it, so the operator's admin task inventory
    // (GET /api/admin/tasks, reads PostgreSQL) and the database backup
    // (docs/BACKUP.md dumps `tasks`) silently missed every task the platform
    // created. Best-effort: identified callers get a real row (status derived
    // from the v1 lifecycle); anonymous/loopback tasks have no users.id to
    // reference (user_id is NOT NULL → skipped, same as before this fix).
    // A DB hiccup never fails the HTTP request — the file store stays the
    // source of truth for the API surfaces.
    if (req.userId) {
      meta.dbUserId = req.userId; // for the updateTask mirror (tasks.js reads it)
      taskRepo.createTask({ userId: req.userId, url, options: { mode: mode || "url", pipeline: "v1" } })
        .then((row) => tasks.attachDbTask(meta.id, row.id))
        .catch((e) => console.warn(`[tasks] db mirror failed for ${meta.id}: ${e.message}`));
    }
    auditSafe(auditEvents.taskCreate, { actorId: req.userId, targetType: "task", targetId: meta.id, metadata: { pipeline: "v1", url } });
    res.json(meta);
    runTask(meta.id).catch((e) => {
      tasks.updateTask(meta.id, { status: "error", error: String(e.message || e).slice(0, 300) }, "failed");
      bus.emit("log", { level: "warn", msg: `task ${meta.id} failed: ${e.message}` });
      // 4.2.12: a crashed v1 run settles as an errored job (runtime up to now).
      const metaNow = tasks.loadTask(meta.id);
      settleJobCostSafe({
        userId: req.userId, orgId: req.tenantScope?.orgId || null, taskKey: meta.id,
        queuedAt: metaNow?.createdAt || meta.createdAt, finishedAt: new Date().toISOString(),
        artifactsDir: tasks.outDir(meta.id), status: "error",
      });
    }).finally(() => {
      releaseReservation(req.quotaScope, req.quotaTaskKey, { userId: req.userId, outcome: "completed" }).catch(() => {});
    });
  });
  // GET surfaces: credential resolution + rate limiting, but NO quota
  // reservation (listing data must not consume a job slot).
  // G5.2 hunt hardening: (1) anonymous reads are loopback-only like the detail
  // surfaces — a REMOTE anonymous caller previously received the ownerless
  // job/task listings (job id + target URL disclosure); (2) an org context is
  // VALIDATED or refused, never silently ignored — X-Org-Id of a non-member
  // org used to return 200 with the personal list (probe: foreign and garbage
  // org headers both ignored).
  const credentialedRead = (scope = "read:task") => [
    (req, res, next) => enforceOrAnonymous(req, res, next, { keyScope: scope }),
    resolveTenantScopeSoft, // 4.0.1: org context (if named) is enforced, not ignored
  ];

  // 3.5.9 lane-3 hardening: detail / destructive / export surfaces must not be
  // reachable by REMOTE anonymous callers. The legacy anonymous dashboard
  // posture is preserved for loopback only; identified callers resolve their
  // identity so the owner gates inside the handlers run with a real userId.
  // scope=null rejects API keys entirely (no key scope may perform that action).
  // G5.5 human-journey fix: when no header is presented, a valid `cloner_session`
  // cookie (set by POST /api/auth/login) resolves the caller's identity BEFORE
  // the legacy anonymous posture applies. Browser navigations cannot set
  // Authorization headers — the same physical limitation the WS upgrade path
  // already solves with this cookie (ws-auth.js header) — so without this a
  // logged-in user's own /preview load arrived anonymous and owner-gated
  // surfaces answered 404. Header callers are unchanged; the cookie never
  // accepts ?token= (G5.3 posture); an invalid cookie falls through to the
  // pre-existing anonymous rules (loopback legacy / remote 401).
  const localOrAuthed = (scope) => async (req, res, next) => {
    // G5.1 hunt fix: same enforcement rule as enforceOrAnonymous — a PRESENTED
    // Authorization value that is not "Bearer <token>" is a 401, never an
    // anonymous downgrade. (Cookie identity is still honored first for the
    // legacy local dashboard posture.)
    const auth = req.headers.authorization;
    if (auth !== undefined && !(typeof auth === "string" && auth.startsWith("Bearer ") && auth.slice(7).trim() !== "")) {
      return res.status(401).json({ error: "malformed authorization header" });
    }
    const hasKey = req.headers["x-api-key"] !== undefined;
    if (hasKey) {
      if (!scope) return res.status(403).json({ error: "api keys cannot perform this action (use a session)" });
      return apiKeyAuth(scope)(req, res, next);
    }
    if (auth !== undefined) return authRequired(req, res, next); // header-only (hunt G5.3: no ?token=)
    const cookieIdentity = await wsAuth.authenticateCookie(req);
    if (cookieIdentity) {
      req.userId = cookieIdentity.userId;
      req.userEmail = cookieIdentity.email;
      req.userRole = cookieIdentity.role;
      return next();
    }
    if (!wsAuth.isLoopback(req.socket?.remoteAddress)) return res.status(401).json({ error: "authentication required" });
    req.userId = null; // loopback dashboard legacy posture
    next();
  };

  // 16. GitHub publish (G1.1): the router REFUSES to serve without a guard —
  //     mounted here (after localOrAuthed exists) with the same loopback-or-
  //     authed posture as every other local-operator surface.
  app.use("/api/github", githubPublishRouter({ guard: localOrAuthed("publish:task") }));

  // 20. Progress build viewer (swarm): the page + SSE stream the user watches
  //     while a clone builds. progress-routes.js ships NO guard of its own, so
  //     per its integrator contract the mount applies localOrAuthed — the same
  //     session-auth-or-loopback posture as the /ws upgrade (cookie/Bearer
  //     session OK, loopback legacy OK, remote anonymous 401; API keys excluded
  //     — the viewer is a browser page and no key scope serves it). The routes
  //     inside already carry the /progress prefix, so the router mounts BARE
  //     (bus defaults to the shared singleton) with the guard path-scoped here.
  const progressGuard = (req, res, next) => {
    if (req.path !== "/progress" && !req.path.startsWith("/progress/")) return next();
    return localOrAuthed(null)(req, res, next);
  };
  // Per-job ownership for the live SSE stream, mirroring the
  // /api/jobs/:jobId/artifacts gate: an owned job's build events stream only to
  // the owner/org members — an anonymous or foreign caller gets the same 404
  // the artifact read returns (no existence leak). Ownerless/unknown ids keep
  // the loopback legacy posture, exactly like artifact reads. Runs AFTER
  // progressGuard so req.userId is resolved before the gate consults it.
  const progressSseOwnership = async (req, res, next) => {
    const m = req.path.match(/^\/progress\/([^/]+)\/events$/);
    if (req.method !== "GET" || !m) return next();
    try {
      const jobId = decodeURIComponent(m[1]);
      const job = exploration.getExplorationJob(jobId);
      if (job?.owner) {
        const ok = req.userId ? await exploration.identityCanAccessJob(jobId, { userId: req.userId, role: req.userRole }) : false;
        if (!ok) return res.status(404).json({ error: "not found" });
      }
    } catch { /* registry lookup failure → legacy posture, same as the artifact gate */ }
    next();
  };
  app.use(progressGuard, progressSseOwnership, progressRoutes());

  // 21. Project versions (4.1.3): immutable version records + snapshot/rollback.
  //     The router carries NO guard of its own (version-service.js header
  //     documents this mount line) — mounted here with the platform's
  //     loopback-or-authed posture. GET /api/versions (the bare prefix the
  //     product UI's final page polls — platform-ui/pages/final.js) lists
  //     recent versions in the SAME { ok, versions } shape the per-task
  //     listing already returns, so the UI renders both identically.
  app.use("/api/versions", versionsRouter({ guard: localOrAuthed("read:task") }));

  app.get("/api/tasks", ...credentialedRead(), async (req, res) => {
    // authenticated (Bearer): only tasks created under this userId (meta.userId
    // is set by tasks.createTask / exploration payload); anonymous (local
    // dashboard, legacy posture): ownerless v2 jobs only — jobs created with
    // credentials never leak to unauthenticated callers (4.0.12). Legacy v1
    // tasks follow the same rule: an anonymous caller sees only the
    // ownerless/"local"-scope entries, never another user's tasks.
    // G5.1 consistency: a platform-admin's v1 view matches the v2 view —
    // listJobsFor(role:admin) returns everything, so the admin task list must
    // too (probe: admin saw 1 of 2 tasks in GET /api/tasks).
    const all = tasks.listTasks();
    const legacy = req.userId
      ? (req.userRole === "admin" ? all : all.filter((t) => t.userId === req.userId))
      : all.filter((t) => !t.userId || t.userId === "local");
    const jobs = await exploration.listJobsFor(req.userId ? { userId: req.userId, role: req.userRole } : null);
    res.json([...legacy, ...jobs]);
  });

  // ---- exploration jobs (Phase 1 intelligence engine, spec §15) ----
  app.post("/api/jobs/explore", ...credentialed({ queued: true }), async (req, res) => {
    const { url, username, password, cookies, storage, policy } = req.body || {};
    const fieldErr = taskFieldError(req.body);
    if (fieldErr) { if (req.quotaRelease) await req.quotaRelease({ outcome: "cancelled" }); return res.status(fieldErr.status).json({ error: fieldErr.error }); }
    // G5.1 hunt fix: same slot-leak as POST /api/tasks — the url-required 400
    // used to leak the queued reservation reserved by the guard above.
    if (!url || !/^https?:\/\//i.test(url)) { if (req.quotaRelease) await req.quotaRelease({ outcome: "cancelled" }); return res.status(400).json({ error: "url required (http(s))" }); }
    const guard = await validatePublicUrl(url);
    if (!guard.ok) { if (req.quotaRelease) await req.quotaRelease({ outcome: "cancelled" }); return res.status(400).json({ error: "url rejected: " + guard.error }); }
    if (policy !== undefined && (typeof policy !== "object" || policy === null || Array.isArray(policy))) { if (req.quotaRelease) await req.quotaRelease({ outcome: "cancelled" }); return res.status(400).json({ error: "policy must be an object" }); }
    let entry;
    try {
      entry = exploration.queueExploration({
        url, username, password, cookies, storage, policy,
        userId: req.userId, orgId: req.tenantScope?.orgId || null,
      });
    } catch (e) {
      // G5.1 hunt fix: a throw after reservation must not leak the slot
      if (req.quotaRelease) await req.quotaRelease({ outcome: "cancelled" });
      return res.status(500).json({ error: "internal error" });
    }
    auditSafe(auditEvents.taskCreate, { actorId: req.userId, targetType: "task", targetId: entry.tempId, metadata: { kind: "exploration", url } });
    // quota: queued reservation → running when the job actually dispatches;
    // released with the outcome when it terminates (4.0.4 accounting).
    // G5.2: promotion REFUSAL stops the job (see cancelOnQuotaRefusal) and the
    // listener unsubscribes at the terminal event (no accumulation).
    const q = getCloneQueue();
    const off = q.onStatus(({ entry: e }) => {
      if (e.tempId !== entry.tempId && e.jobId !== entry.tempId) return;
      if (["exploring", "reconstructing", "verifying"].includes(e.status)) {
        promoteReservation(req.quotaScope, req.quotaTaskKey, { userId: req.userId }).catch(cancelOnQuotaRefusal(entry.tempId));
      }
      if (["completed", "completed_with_limitations", "error", "cancelled"].includes(e.status)) {
        if (off) off();
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

  // ---- blueprint approve (ADR-0003 fidelity contract; wave 7 endpoints) ----
  // Re-runs blueprint.js buildBlueprint over the SAME artifacts dir with the
  // caller-edited scope and rewrites blueprint.json in place. Evidence-
  // preserving: buildBlueprint reads manifest.json + pages/* and touches
  // exactly one file (blueprint.json) — recorded evidence is never mutated.
  // Redacted inputs: only bounded, caller-supplied scope strings reach the
  // contract; the endpoint accepts neither credentials nor free-form text.
  // Contract: the product UI (platform-ui/pages/blueprint.js) POSTs
  // { scope: { include, exclude, notes }, jobId, approved }; the flat
  // { scopeInclude, scopeExclude } aliases are accepted too. Response
  // { ok: true, blueprint } — the UI keys its success notice on data.ok and
  // re-reads blueprint.json through the artifacts route on reload.
  app.post("/api/jobs/:jobId/blueprint/approve", ...credentialedRead(), async (req, res) => {
    // Same per-job ownership gate as the artifacts read (mirror
    // progressSseOwnership): an owned job approves only for the owner / org
    // members / platform-admin; anonymous or foreign callers get the same 404
    // the artifact read returns (no existence leak). Ownerless/unknown ids
    // keep the loopback legacy posture, exactly like artifact reads.
    const job = exploration.getExplorationJob(req.params.jobId);
    if (job?.owner) {
      const ok = req.userId ? await exploration.identityCanAccessJob(req.params.jobId, { userId: req.userId, role: req.userRole }) : false;
      if (!ok) return res.status(404).json({ error: "not found" });
    }
    // scope normalization: the UI's { scope: { include, exclude } } object or
    // the flat { scopeInclude, scopeExclude } — each an array of bounded
    // strings (a lone string is accepted as one entry); anything else is a 400,
    // never silently coerced into the contract.
    const scopeObj = (req.body?.scope && typeof req.body.scope === "object" && !Array.isArray(req.body.scope)) ? req.body.scope : null;
    const rawInclude = scopeObj ? scopeObj.include : req.body?.scopeInclude;
    const rawExclude = scopeObj ? scopeObj.exclude : req.body?.scopeExclude;
    const asScopeList = (v, field) => {
      const list = Array.isArray(v) ? v : v === undefined || v === null ? [] : [v];
      if (list.length > 20) return { error: `${field} accepts at most 20 entries` };
      const out = [];
      for (const item of list) {
        if (typeof item !== "string") return { error: `${field} entries must be strings` };
        // ';' and newlines are the parser's clause delimiters (blueprint.js
        // parseInstructions) — stripped so one entry stays one clause
        const t = item.replace(/[;\n\r]+/g, " ").trim();
        if (!t) continue;
        if (t.length > 200) return { error: `${field} entries max 200 chars` };
        out.push(t);
      }
      return { list: out };
    };
    const inc = asScopeList(rawInclude, "scopeInclude");
    if (inc.error) return res.status(400).json({ error: inc.error });
    const exc = asScopeList(rawExclude, "scopeExclude");
    if (exc.error) return res.status(400).json({ error: exc.error });
    if (!inc.list.length && !exc.list.length) return res.status(400).json({ error: "scopeInclude/scopeExclude (or scope.{include,exclude}) required" });
    // compose the edited scope as instruction clauses the deterministic parser
    // classifies (blueprint.js INCLUDE_RE / EXCLUDE_RE) — the same seam the
    // pipeline uses (reconstruction-pipeline.js → buildBlueprint instructions).
    // Entries that already carry a scope keyword pass through verbatim so a
    // re-approve of the UI's round-tripped scope is idempotent.
    const SCOPE_KW = /^(only|just|sirf|limit to|restrict to|exclude|skip|without|ignore|no need for|do not clone|don't clone|not the)\b/i;
    const clause = (item, kind) => (SCOPE_KW.test(item) ? item : kind === "include" ? `only ${item}` : `exclude ${item}`);
    const instructions = [
      ...inc.list.map((s) => clause(s, "include")),
      ...exc.list.map((s) => clause(s, "exclude")),
    ].join("; ");
    // SAME artifacts dir the artifacts read serves for this handle (resolved
    // through artifact-lifecycle — org-scoped root first, legacy fallback)
    const { path: artifactsDir } = resolveArtifactPath(req.params.jobId, { orgId: req.tenantScope?.orgId || undefined });
    const bp = buildBlueprint(artifactsDir, { instructions });
    if (!bp.ok) {
      const missing = /missing/i.test(bp.why || "");
      return res.status(missing ? 404 : 400).json({ error: String(bp.why || "blueprint failed").slice(0, 200) });
    }
    // no audit event exists for a blueprint approval (audit-service.js is not
    // extended here) — the rewritten blueprint.json itself carries the record
    // (generatedAt + instructions.raw + scope), which is the artifact of record
    res.json({ ok: true, blueprint: bp.blueprint });
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
    // G5.2 hunt fix: deleting a v2 job must also CANCEL its queue entry — the
    // old code returned ok while the job kept running (and holding its slot)
    // in the registry.
    if (exploration.getExplorationJob(req.params.id)) {
      getCloneQueue().cancel(req.params.id).catch(() => {});
    }
    // G5.1 hunt fix (BUG #8): the cancel must release the quota slot too.
    // The queue's cancel() does not emit a terminal status event on the
    // BullMQ path, so the submission listener above never ran its
    // releaseReservation branch — reproduced: two rapid submissions + two
    // DELETEs left two 'running' reservations forever and every later job
    // got 429 QUOTA_EXCEEDED. Deleting/cancelling is a terminal outcome for
    // the caller's slot regardless of which backend runs the job; the
    // release is a no-op (released=false) when the submission listener
    // already released it, and it fires only for the CALLER'S OWN request
    // context (req.quotaTaskKey), so a second user's DELETE can never free
    // someone else's slot.
    if (req.quotaRelease) await req.quotaRelease({ outcome: "cancelled" });
    // G5.1 (BUG #9 companion): DELETE removes the DB mirror row too — the admin
    // inventory must not resurrect deleted tasks after the next backup/restore.
    const v1Meta = tasks.loadTask(req.params.id);
    tasks.deleteTask(req.params.id);
    if (v1Meta?.dbTaskId && (req.userId || v1Meta.dbUserId)) {
      taskRepo.deleteTask(v1Meta.dbTaskId, req.userId || v1Meta.dbUserId).catch(() => {});
    }
    auditSafe(auditEvents.taskDelete, { actorId: req.userId, targetType: "task", targetId: req.params.id });
    res.json({ ok: true });
  });

  // ---- clone preview (with element picker injected) ----
  // G5.1 hunt: v2 (pipeline-v2) clones live in the ARTIFACTS tree — the site in
  // artifacts/<jobId>-project/, exploration evidence in artifacts/<jobId>/ —
  // while /preview only ever served the legacy v1 out dir. A completed v2 task
  // therefore showed "not found yet" in the Clone tab forever. resolvePreviewDirs
  // returns the candidate roots in priority order (v1 out dir → v2 project site →
  // v2 evidence tree) and the handler keeps the per-root containment guard
  // (3.5.9 relative check) — a request never escapes any single root.
  function resolvePreviewDirs(id, { orgId } = {}) {
    const dirs = [];
    try { dirs.push(path.resolve(tasks.outDir(id))); } catch { /* unknown v1 id */ }
    try {
      const job = exploration.getExplorationJob(id);
      if (job) {
        const root = resolveArtifactPath(job.jobId || id, { orgId: orgId || undefined }).path;
        dirs.push(path.resolve(root + "-project"));
        dirs.push(path.resolve(root));
      }
    } catch { /* registry unavailable — v1 only */ }
    return dirs;
  }
  app.get("/preview/:id", localOrAuthed("read:task"), (req, res) => res.redirect(`/preview/${req.params.id}/index.html`));
  app.get("/preview/:id/*", localOrAuthed("read:task"), async (req, res) => {
    // 4.0.12 posture for v2: an owned job's preview is owner-gated (anonymous /
    // non-member → the same 404 as a missing task — no existence leak)
    const job = exploration.getExplorationJob(req.params.id);
    if (job?.owner) {
      const ok = req.userId ? await exploration.identityCanAccessJob(req.params.id, { userId: req.userId, role: req.userRole }) : false;
      if (!ok) return res.status(404).send("not found yet");
    }
    // G5.5 human-journey fix: v1 previews carried NO owner gate — GET
    // /api/tasks/:id 404s another user's task (4.0.12) while /preview served
    // its whole clone tree to any loopback anonymous browser (the same
    // inconsistent posture the v2 branch above had already fixed). Mirror the
    // GET policy exactly: identified callers see only their own; anonymous
    // loopback keeps the legacy "local"-scope posture.
    const previewMeta = tasks.loadTask(req.params.id);
    if (previewMeta && !previewMeta.userId) previewMeta.userId = "local"; // pre-4.0 tasks were written without the field
    if (previewMeta) {
      if (req.userId && previewMeta.userId !== req.userId) return res.status(404).send("not found yet");
      if (!req.userId && previewMeta.userId !== "local") return res.status(404).send("not found yet");
    }
    for (const dir of resolvePreviewDirs(req.params.id, { orgId: req.tenantScope?.orgId })) {
      const file = path.resolve(dir, req.params[0] || "index.html");
      // 3.5.9: relative containment per root — a bare startsWith(dir) check is
      // bypassable by sibling dirs sharing the prefix (…/t1/out vs …/t1/out-extra/)
      const rel = path.relative(dir, file);
      if (rel.startsWith("..") || path.isAbsolute(rel)) continue; // try the next root, never escape this one
      if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) continue;
      if (file.endsWith(".html")) {
        let html = fs.readFileSync(file, "utf8");
        html = html.replace(/<\/body>/i, `<script>${PICKER_JS}</script>`);
        return res.type("html").send(html);
      }
      return res.sendFile(file);
    }
    return res.status(404).send("not found yet");
  });

  // ---- chat / edit selected element (reuses engine edit flow) ----
  // G7.1 hunt fix (g51 second-identity probe): the chat surface MUTATES a
  // clone's files but was the one surface never owner-gated — an authenticated
  // non-owner reached the model router and the file write on someone else's
  // clone (probe log: "[chat] edit via provider: …" fired for a foreign task
  // before the 500). Gate it exactly like GET/DELETE/export: v2 registry jobs
  // via identityCanAccessJob, legacy tasks via meta.userId — a non-member gets
  // the same 404 as a missing task, before any model call.
  app.post("/api/tasks/:id/chat", localOrAuthed(null), async (req, res) => {
    const v2job = exploration.getExplorationJob(req.params.id);
    if (v2job) {
      const ok = req.userId
        ? await exploration.identityCanAccessJob(req.params.id, { userId: req.userId, role: req.userRole })
        : !v2job.owner; // loopback anonymous keeps the legacy posture for ownerless jobs
      if (!ok) return res.status(404).json({ error: "not found" });
    } else {
      const gateMeta = tasks.loadTask(req.params.id);
      if (gateMeta) {
        if (req.userId && gateMeta.userId !== req.userId) return res.status(404).json({ error: "not found" });
        if (!req.userId && gateMeta.userId && gateMeta.userId !== "local") return res.status(404).json({ error: "not found" });
      }
    }
    const { selector, info = {}, instruction } = req.body || {};
    // G5.1 hunt hardening: bounded fields — selector/info/instruction reach the
    // model prompt and the chat-fixes.css comment verbatim, so an unbounded
    // field used to flow straight into prompts (prompt-injection surface) and
    // an oversized one burned model tokens for nothing.
    if (String(instruction ?? "").length > 4000) return res.status(400).json({ error: "instruction too long (max 4000 chars)" });
    if (String(selector ?? "").length > 500) return res.status(400).json({ error: "selector too long (max 500 chars)" });
    if (JSON.stringify(info ?? {}).length > 8000) return res.status(400).json({ error: "info payload too large (max ~8KB)" });
    // 3.5.9: basename-only — a body file like "../../package.json" must not
    // escape the task's out/ dir for read+write below
    const file = path.basename(String(req.body?.file || "index.html"));
    if (!instruction) return res.status(400).json({ error: "instruction required" });
    const cfg = loadConfig();
    if (cfg.model.provider === "none" || !cfg.model.apiKey) return res.status(400).json({ error: "no vision model configured (Settings → API providers, phase 6)" });
    // G5.1 hunt: element edits must reach v2 clones too — resolve the same site
    // tree /preview serves (v1 out dir, else the v2 <jobId>-project dir)
    const target = resolvePreviewDirs(req.params.id)
      .map((d) => path.join(d, file))
      .find((p) => fs.existsSync(p));
    if (!target) return res.status(404).json({ error: "clone not ready" });
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
        fs.appendFileSync(path.join(path.dirname(target), "chat-fixes.css"), `\n/* ${new Date().toISOString()} — ${instruction.replace(/\*\//g, "")} */\n${patch.css}\n`);
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
      // 4.2.15: exports are a lifecycle event (task.exported) — both pipelines.
      emitTaskLifecycleEvent({ status: "exported", taskId: id, url: null, userId: req.userId || null, orgId: req.tenantScope?.orgId || null, pipeline: isV2 ? "v2" : "v1", data: { size } }).catch(() => {});
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

  // ---- product UI static mount (ADR-0004: supersedes headless G7.1) ----
  // The 8-page product UI is plain static files from <repo>/platform-ui. The
  // mount sits AFTER every /api, /preview and /progress route above, so those
  // keep absolute precedence — express walks the stack in mount order and an
  // API route always answers first; express.static only ever sees what no
  // route claimed. /ws never reaches express at all (it is an http-server
  // upgrade handled by WebSocketServer, not middleware). A path matched by
  // neither a route nor a static file falls through to Express's terminal 404
  // — exactly the fallthrough this server had when it was headless.
  //
  // Posture: the static UI itself is PUBLIC, like a login page — no
  // localOrAuthed guard here, on purpose. The UI is inert HTML/JS until its
  // own code calls the API, and every data surface behind /api/* above keeps
  // its existing guard chain (credentialed / localOrAuthed / loopback
  // posture); guarding the shell would only hide the login screen from the
  // people it is for. No cookie/CSRF surface is introduced by serving files.
  const PLATFORM_UI_DIR = path.join(__dirname, "..", "..", "platform-ui");
  if (!fs.existsSync(PLATFORM_UI_DIR)) {
    console.warn("[platform-ui] directory missing — / falls through to 404 until the product UI is built");
  }
  app.use("/", express.static(PLATFORM_UI_DIR));

  // ---- terminal error handler (G5.2 hunt hardening) ----
  // Every error an async handler or the body parser produces must come back as
  // bounded JSON. Previously there was NO error middleware: express's dev
  // default answered parse failures with an HTML page (NODE_ENV unset → dev
  // mode → stack trace to the attacker), and an async throw that escaped a
  // handler would have been an unhandled rejection (process exit on modern
  // Node). body-parser errors carry their own 4xx status.
  app.use((err, _req, res, next) => {
    if (res.headersSent) return next(err);
    const status = Number(err?.status || err?.statusCode) || (err instanceof SyntaxError ? 400 : 500);
    const code = status >= 400 && status < 500 ? status : 500;
    if (code >= 500) console.error(`[http] unhandled route error: ${err?.message || err}`);
    res.status(code).json({ error: code >= 500 ? "internal error" : String(err?.message || "bad request").slice(0, 200) });
  });

  const server = http.createServer(app);
  // exposed additively so the export/release lifecycle can be driven from
  // tests and the worker path (4.0.4/4.0.5 integration)
  const startExport = makeV2Exporter();

  // ---- WebSocket: authenticated upgrade + task-scoped rooms (spec §6/§9) ----
  // The upgrade validates an optional token (cookie `cloner_session` or
  // ?token=) against the sessions table. Unauthenticated upgrades are refused
  // with 401 UNLESS they come from loopback — local dashboard API clients
  // connect with no token and keep working through the
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
    let acceptedIds = null;
    try {
      const taskId = msg?.task || msg?.data?.job || msg?.data?.task || msg?.data?.taskId || null;
      if (taskId) {
        const users = [...new Set([...sockets].filter((s) => s.identity).map((s) => s.identity.userId))];
        const allowed = await wsAuth.authorizedUserIds(taskId, users);
        gate = (ws) => ws.rooms.has("legacy") || (ws.identity && allowed.has(ws.identity.userId));
        // G5.5 human-journey fix: v2 clients only ever see the tempId the
        // POST /api/tasks response hands back ("pending-…"), while queue-side
        // events (worker path, quota lifecycle) are tagged with the REAL
        // jobId ("exp-…") — the old strict `ws.taskId === msg.task` filter
        // silently dropped every one of those events for the socket that had
        // joined by temp handle. Deliver to a joined id matching EITHER
        // handle (the registry maps one onto the other).
        acceptedIds = new Set([taskId]);
        const entry = getCloneQueue().getEntry(taskId);
        if (entry) {
          if (entry.jobId) acceptedIds.add(entry.jobId);
          if (entry.tempId) acceptedIds.add(entry.tempId);
        }
      }
    } catch {
      gate = (ws) => ws.rooms.has("legacy"); // unexpected failure → legacy room only
    }
    for (const ws of sockets) {
      try {
        if (gate && !gate(ws)) continue;
        if (!ws.taskId || !msg.task || acceptedIds?.has(ws.taskId)) ws.send(JSON.stringify(msg));
      } catch {}
    }
  }
  // engine progress → WS (tagged with the running task) + server-side console
  // (stdout is the only place errors survive when no WS client is attached)
  const T0 = Date.now();
  const at = () => `+${((Date.now() - T0) / 1000).toFixed(1)}s`;
  // the /ws live whitelist: legacy engine events + the four workflow.* viewer
  // event types (progress-routes.js WORKFLOW_EVENT_TYPES). The catchup replay
  // already ships them, but live traffic was filtered out here — a dashboard
  // watching a running build saw stage/todo events only on reconnect.
  for (const evt of ["step", "log", "tabs:found", "assets:progress", "assets:done", "page:goto", "run:done", "run:error", "polish:round",
    "workflow.stage", "workflow.todo.add", "workflow.todo.done", "workflow.agent"]) {
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

  // G5.5 human-journey fix: BullMQ worker-path clone jobs execute in a SEPARATE
  // process — their bus emissions never reach this server, so a human watching
  // a production (server+worker) deployment received NO live progress over the
  // WebSocket and had to poll blind. The queue adapter already funnels every
  // stage transition back through QueueEvents → onStatus (clone-queue.js);
  // bridge those status events onto the SAME owner-gated broadcast path (the
  // msg.task tag drives the authorizedUserIds gate in broadcast()).
  // kind-guard: internal bookkeeping entries (artifact-lifecycle sweep) are
  // not task progress and must not fan out as phantom job events.
  getCloneQueue().onStatus(({ entry, status, data }) => {
    if (!entry || entry.kind) return;
    const jobId = entry.jobId || entry.tempId;
    broadcast({ type: "job:status", task: jobId, data: { jobId, tempId: entry.tempId, status, url: entry.url, ...(data || {}) } });
  });

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
    // 4.2.15 lifecycle hooks: v1 runner emits the same lifecycle events the v2
    // queue path fans out (status → event mapping in workflow-hooks.js).
    emitTaskLifecycleEvent({ status: "running", taskId: id, url: meta.url, userId: meta.userId && meta.userId !== "local" ? meta.userId : null, pipeline: "v1" }).catch(() => {});
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
    // 4.2.15: v1 terminal → task.completed hook fan-out.
    emitTaskLifecycleEvent({ status: "done", taskId: id, url: meta.url, userId: meta.userId && meta.userId !== "local" ? meta.userId : null, pipeline: "v1", data: { verification: verification.passed } }).catch(() => {});
    // 4.2.12 per-job compute accounting for the v1 pipeline (the v2 path
    // settles from its queue listener; cancelled/anonymous settle nothing).
    settleJobCostSafe({
      userId: meta.userId && meta.userId !== "local" ? meta.userId : null,
      orgId: meta.orgId || null,
      taskKey: id,
      queuedAt: meta.createdAt || null,
      finishedAt: new Date().toISOString(),
      artifactsDir: out,
      status: "completed",
    });
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

// ---- 4.2.9 re-route run resolver (createQueueDispatcher's resolveRun seam) ----
// A re-routed job must EXECUTE on the memory backend like any other entry, so
// the dispatcher's `run` slot must receive a FUNCTION — the shipped
// `{ run: fn }` wrapper made the queue call an object ("d.run is not a
// function", reproduced in scripts/test-distributed-plane.mjs §6). The run is
// resolved BY JOB PAYLOAD (the ledger's JSON round-trip — MemoryStore AND
// RedisStore stringify — has already dropped every function, and the queue
// registry never holds closures either: clone-queue.js keeps `run` on the
// dispatch object, not the entry), mirroring src/workers/clone-worker.js
// defaultExecutor — the pipeline is rebuilt from the surviving payload:
//   • clone payloads → the shared runPipelineJob over the re-routed entry
//     (withJobScope tag + linkJobId registry hook, same as
//     exploration-runner.queueExploration's in-process closure);
//   • { kind: "artifact-sweep" } payloads → the same run closure
//     artifact-lifecycle.enqueueSweep attaches (never fed into the clone
//     pipeline; memory-backend convention: the run owns the terminal status).
// Exported for scripts/test-endpoints.mjs (offline re-route harness, which
// mirrors the production binding with its own queue instance via opts.queue).
export function resolveReroutedRun(job, { queue = null } = {}) {
  const q = queue || getCloneQueue();
  const payload = job?.payload && typeof job.payload === "object" ? job.payload : {};
  if (payload.kind === "artifact-sweep") {
    return async ({ entry: e, report }) => {
      e.status = "sweeping";
      report("sweeping");
      const { sweep } = await import("../storage/artifact-lifecycle.js");
      const result = sweep({ base: payload.root, execute: payload.execute !== false, allowLegacy: false, orphanPolicy: "skip" });
      report("swept");
      e.status = "completed"; // memory-backend convention: the run owns terminal status
      report("completed");
      return result ?? { ok: true };
    };
  }
  return ({ entry, report }) =>
    withJobScope(entry.tempId, () => runPipelineJob(payload, {
      entry, report,
      artifactsRoot: path.join(process.cwd(), "artifacts"),
      linkJobId: (tempId, jobId) => q.linkJobId(tempId, jobId),
    }));
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
