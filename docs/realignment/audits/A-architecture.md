# A — Master Architecture Inventory (realignment audit, 2026-11-05)

Scope: frontend surfaces, full API route inventory, 12-engine mapping, queues/workers/
distributed/database, orchestration-path disentanglement. All claims grounded in files
read or commands run in this session. Product root: `D:/project 2/cloner`.

## 1. WHAT EXISTS

### Frontend surfaces
- `dashboard/index.html` (77 lines) + `dashboard/app.js` (228) + `dashboard/style.css` (380):
  a local 3-pane "live run" console. Views rendered (index.html:31-73): LEFT pipeline
  step feed + log; CENTER stage tabs Clone (iframe of `/preview/<run>/index.html`,
  1440px scaled fit, app.js:139-154) / Original (engine screenshots) / Side-by-side;
  RIGHT edit panel (element picker arm, instruction textarea, "Apply with model",
  brief box). Served ONLY by `src/server.js` (port 4173, server.js:27-28), started by the
  CLI (`src/cli.js:100`, `--serve-only` flag). It consumes `/api/events`, `/api/runs`,
  `/preview/*`, `/api/edit` (app.js:15,82,95,203) — dashboard-only endpoints; it never
  calls `/api/tasks` or creates jobs. It observes runs made by the CLI process.
- `platform-ui/` — **deleted**. Git: `git log --oneline -- platform-ui` shows exactly two
  commits: cdffb15 (added 3 files, 817 lines: app.js 397 / index.html 139 / style.css 281)
  and 4327ac8 = current HEAD ("Engine fidelity overhaul"), which deletes all 3 files,
  817 deletions (verified `git show --stat 4327ac8 -- platform-ui`). `ls platform-ui` →
  does not exist. Docs claim removal "entirely on 2026-11-03" (docs/ARCHITECTURE.md:6);
  git dates the deletion commit 2026-11-05 00:03 +0530 — substance correct, date ~2d off.
- `docs/ARCHITECTURE.md:47-65` documents decision G7.1 (backend-only): no static mounts,
  `/` → terminal 404 in the platform server. Confirmed: `src/platform/server.js:270-274`
  has no static mount and no `GET /`.

### API routes (grep of all router/app registrations + full read of both servers)
`src/server.js` (dashboard, 181 lines): GET `/` (27), `/static/*` (28), `/api/runs` (31,
inline fs scan of outputs/*/clone.json), `/preview/:run/*` (49) + `/preview/:run` (68),
`/api/events` (71), POST `/api/edit` (74, inline vision edit), POST `/api/ask` (129,
inline chat); WS `/ws` (143). All handlers inline; no router files.

`src/platform/server.js` (product API, 1240 lines, port 4180 via bin/platform.js) —
route → handler file:
- `express.json` guards: /api/auth 32kb, /api/keys 64kb (72-73)
- `/api/billing` → billing-stripe.js (78, mounted before 20mb parser for raw-body HMAC)
- `/healthz` `/readyz` `/metrics` → health-routes.js (84, unauthenticated probes)
- `/api/orgs` → org-routes.js (89)
- `/api/keys` → api-key-service.js keysRouter (94)
- `/api/quota/usage` + `/api/quota/reconcile` → quota-middleware.js (97-98)
- `/api/admin/*` → admin-routes.js (102): users, orgs, tasks(+cancel), user quota,
  api-key revoke, retention sweep, audit(+verify), workers (admin-routes.js:210-305)
- `/api/dashboard` → dashboard-routes.js (108)
- `/api/recovery` → session-recovery.js (154)
- `/api/notifications` → notification-delivery.js (158)
- `/api/email` → email-real.js (162): /send, /receipts (email-real.js:573,582)
- `/api/config` → ui-config-routes.js (166)
- `/api/ads` → monetization/ad-slots.js (170); `/api/ad-config` → ad-config-api.js (171)
- `/api/capacity` → routes-capacity.js (175)
- `/api/intelligence` → platform/intelligence/intelligence-routes.js (179)
- `/api/regions` → distributed/region-registry.js (183)
- `/api/hooks` → workflow-hooks.js (189)
- `/api/auth/oauth` → oauth-real.js (193): /providers, /google/start, /google/callback
- `/api/distributed` → distributed/failover.js (201, admin-guarded)
- inline in server.js: POST/GET `/api/auth/register|login|logout|me` (224-268),
  POST `/api/tasks` (418), GET `/api/tasks` (594), GET `/api/tasks/:id` (691),
  DELETE `/api/tasks/:id` (720), GET `/preview/:id/*` (789-790),
  `/api/github` → github-publish-real.js (592: /status 474, /publish/:taskId 481),
  POST `/api/jobs/explore` (613), GET `/api/jobs` (652), `/api/jobs/:jobId` (658),
  `/api/jobs/:jobId/artifacts/*` (669), POST `/api/tasks/:id/chat` (835),
  POST `/api/export/:id` (899), GET `/api/export/:id/download` (938),
  GET `/api/sessions` (971), GET `/api/providers` (973); WS `/ws` (1005).

## 2. WHAT ACTUALLY WORKS (executed or read-verified)

- `node --check bin/platform.js src/platform/server.js src/queues/clone-queue.js
  src/workers/clone-worker.js dashboard/app.js` → ALL SYNTAX OK (run this session).
- Platform server boot wiring is real: 20+ routers mounted with explicit mount order
  (auth → tenant → quota → rate-limit) and a terminal JSON error middleware
  (server.js:986-992).
- The v2 pipeline is one shared definition: `src/queues/pipeline-job.js runPipelineJob`
  = runExplorationJob → reconstructFromArtifacts → verifyTask (pipeline-job.js:69-110),
  executed by BOTH backends: memory `#memDispatch` runs the `run` closure in-process
  (clone-queue.js:239-275) and BullMQ worker `defaultExecutor` → runPipelineJob
  (clone-worker.js:310; standalone worker requires REDIS_URL, clone-worker.js:322-326).
- Memory backend is the default and falls back from bullmq when Redis is unset/unreachable
  (clone-queue.js:1-15, 112 "provisional until the (async) Redis probe settles").
- DB: PostgreSQL via `pg` pool (src/database/client.js:5-21), migrations applied at boot
  with advisory-lock serialization (client.js:28-55), 17 SQL files in
  src/database/migrations/ (001,010,011,012,013,014,015,016,017-job-leases,
  017-notification-delivery,018,030,040,041,042,043,050).
- Dashboard↔server loop is coherent: dashboard/app.js targets only src/server.js
  endpoints; bus events bridged to WS (server.js:155-157); picker injected into previews
  (server.js:14,61).

## 3. WHAT IS BROKEN / INCOMPLETE / DISCONNECTED

1. **Orphaned 5-stage orchestrator**: `src/orchestration/pipeline-orchestrator.js
   executePipeline` (95 lines: exploration, artifact_validation, reconstruction,
   verification, export; writes Postgres task_stages via task-repository) has ZERO
   callers — repo-wide grep for `executePipeline` matches only its own definition.
   `clone-worker.js` mentions it only in a comment (line 54). Dead code; its export
   stage duplicates platform/server.js:899.
2. **Unmounted route modules** (defined, never imported by any src entry):
   `static-export.js` (/api/static-export, static-export.js:184),
   `activity-routes.js` (/api/activity, activity-routes.js:108-140),
   `routes-public-v1.js` (/api/v1 public API, routes-public-v1.js:101-126),
   `billing-hooks.js` (/api/billing-hooks, billing-hooks.js:149),
   `github-publish.js` (superseded by github-publish-real.js — duplicate surface),
   `onboarding-service.js` router (/api/onboarding, onboarding-service.js:145-163).
3. **Orphaned services**: `job-diagnostics.js`, `version-service.js`, `template-service.js`
   — no importers anywhere in src/ (grep run). `exhaustive-test.js` sits in src/platform/
   (test code inside the product tree).
4. **Test-only distributed plane**: `distributed/scheduler.js`, `worker-plane.js`,
   `job-leases.js` are imported only by scripts/test-*.mjs (grep evidence); `job-leases`
   never guards real queue execution. `workers/autoscaler.js`, `worker-pool-manager.js`,
   `scaling-policy.js` likewise test-only. Wired distributed pieces: region-registry,
   failover (controller started at server.js:142-146), artifact-replication, trace-export,
   cost-aware-scheduler (reached via platform/intelligence/cost-prediction.js).
5. **Stale UI artifacts despite G7.1**: `scripts/test-ui-admin.mjs`,
   `test-ui-dashboard.mjs`, `test-ui-onboarding.mjs`, `vite.config-admin.mjs` still
   exist and reference `platform-ui/src/views/*.vue` and `platform-ui/dist/admin` —
   paths that never existed in git's platform-ui (only 3 files ever). They are not wired
   into package.json scripts (checked), but ARCHITECTURE.md:63 claims they were
   "retired"; `scripts/audit-completeness.mjs:41` still lists platform-ui as a product dir.
6. **Duplicate migration prefix** 017 (017-job-leases.sql + 017-notification-delivery.sql)
   — sort-stable today, but the numeric collision invites future mis-ordering.
7. **Two live product write-paths** (details in §5e): pipeline v1 (inline cloneUrl, no
   queue, platform/server.js:503-533) and pipeline v2 (queue). POST /api/tasks defaults
   to v1 when `pipeline` is absent (server.js:439) — the legacy path is still the default
   product behavior.

## 4. WHAT IS REUSABLE AS-IS

- The single pipeline definition `src/queues/pipeline-job.js` (3-stage, backend-agnostic,
  123 lines) — the correct spine for the new Reconstruction/Verification engines.
- Both execution backends: memory clone-queue (bounded, cancel, dead-letter, duplicate
  dispatch guard — clone-queue.js:243-246) and BullMQ worker (concurrency, transient
  retry, stalled recovery, graceful drain — clone-worker.js:1-35).
- Exploration: `src/pipeline/exploration-pipeline.js` + `src/exploration/*` (policy,
  route/state discovery, application-state + websocket capture) — wired and complete.
- Reconstruction: `src/reconstruction/reconstruction-pipeline.js` (load → analyze →
  generate → repair, MAX_ROUNDS=2) + analysis/ generation/ intelligence/ submodules.
- Verification: `src/platform/verify.js` 3-step loop (functional / optimization+completeness
  / visual, verify.js:1-8). Repair: repair-planner.js, repair-executor.js, repair-history.js.
- Export: `src/platform/exporter.js` (fail-closed credential shredding, exporter.js:1-8).
- Auth/tenancy/quota/audit middleware chain and all mounted Phase 4.x routers.
- Dashboard trio (src/server.js + dashboard/*) as the operator console for local runs.

## 5. WHAT NEEDS MODIFICATION

- **Intake engine: MISSING as a module** — intake logic is inline in platform/server.js
  POST /api/tasks (field caps server.js:350, URL guard 437, pipeline validation 435) and
  src/cli.js arg parsing. Extract into src/intake/ if the 12-engine architecture keeps it.
- **Blueprint engine: MISSING** — `grep -rli blueprint src/` returns zero matches. The
  nearest functional analog is understanding output + generation/project-generator.js;
  decide whether "blueprint" is a rename or genuinely new code.
- **Session engine**: src/platform/sessions.js (in-memory Map, 30-min idle, sessions.js:1-15)
  — single-process only; needs a durable store for the new architecture.
- **Runtime engine**: src/runtimeTemplate.js — reusable, but its ad-slot hook couples it
  to monetization (runtimeTemplate.js:8-12).
- **Asset engine**: src/assets/asset-manifest.js + src/pipeline/asset-capture.js +
  src/storage/artifact-store.js — consolidate under one Asset boundary.
- **Delete or wire**: pipeline-orchestrator.js (delete, or make clone-worker call it
  instead of pipeline-job if DB stage persistence is wanted); unmounted routers
  (static-export, activity, public-v1, billing-hooks, onboarding); orphaned services
  (job-diagnostics, version-service, template-service); stale test-ui-*/vite configs;
  audit-completeness.mjs PRODUCT_DIRS.
- **Default pipeline**: make v2 the default on POST /api/tasks (or document v1 as
  CLI-legacy-only).

### (e) Orchestration-path trace: who calls whom

Four entry points, one shared pipeline definition, one orphaned orchestrator:
- **CLI**: bin/cloner.js → src/cli.js `main()` → optionally startServer (dashboard,
  cli.js:100) then cloneUrl/cloneImage/cloneVideo directly (cli.js:137). No queue.
- **Platform v1**: POST /api/tasks without `pipeline` → tasks.createTask → inline
  `runTask()` (server.js:1133) → cloneUrl() → verifyTask(). No queue, in-process.
- **Platform v2 (product path)**: POST /api/tasks pipeline=v2 or POST /api/jobs/explore →
  exploration-runner.queueExploration (exploration-runner.js:28) →
  getCloneQueue().enqueue(payload, run: runPipelineJob) — memory backend executes the
  closure in-process (clone-queue.js:253-255); bullmq backend enqueues Redis "clone-jobs",
  consumed by src/workers/clone-worker.js defaultExecutor → runPipelineJob
  (clone-worker.js:292,310), with artifact-sweep special case (clone-worker.js:284-290).
- **Orphaned**: orchestration/pipeline-orchestrator.js executePipeline — 5 stages + DB
  writes, zero callers.
Verdict: **one pipeline** (pipeline-job.js) executed by two backends, plus a legacy v1
inline flow still defaulting on POST /api/tasks, plus one dead orchestrator.

## 6. COMPLETION EVIDENCE (for the realigned version)

- Route census: `grep -rn -E "(router|app)\.(get|post|put|delete|use)\(" src/platform/*.js`
  matches a published route table 1:1; every router mounted exactly once; the unmount
  check `for m in static-export activity-routes routes-public-v1 billing-hooks
  onboarding job-diagnostics version-service; do grep -rn "$m" src/platform/server.js;
  done` → empty (or intentional).
- One pipeline: `grep -rn executePipeline src/ scripts/ bin/` shows a real call site
  (or the file is deleted); `node --check` clean on all touched entries.
- `git log -- platform-ui` ends at the deletion commit; `ls platform-ui` fails; no
  platform-ui strings outside audit scripts.
- `ls src/database/migrations/*.sql | sed 's/-.*//' | sort | uniq -d` → empty.
- Worker proof: REDIS_URL set + `npm run worker` consumes "clone-jobs"; stage writes land
  in task_stages (clone-worker.js CANONICAL_STAGE map, line ~57).
- End-to-end: POST /api/tasks {"pipeline":"v2"} → queue entry → artifacts/<jobId>/
  manifest.json + <jobId>-project/ + verification in GET /api/tasks/:id.

## Key file map

| Area | Files |
|---|---|
| Local dashboard server | src/server.js (181); views: dashboard/index.html, app.js, style.css |
| Platform API | src/platform/server.js (1240) |
| Shared pipeline | src/queues/pipeline-job.js (3 stages) |
| Queue adapter | src/queues/clone-queue.js (memory + bullmq) |
| Worker | src/workers/clone-worker.js (+ worker-health.js; autoscaler/pool/scaling = test-only) |
| Exploration | src/pipeline/exploration-pipeline.js; src/exploration/* (5 modules) |
| Understanding | src/reconstruction/website-understanding.js; src/intelligence/dom-extractor.js |
| Reconstruction | src/reconstruction/reconstruction-pipeline.js + analysis/ generation/ intelligence/ |
| Asset | src/assets/asset-manifest.js, src/pipeline/asset-capture.js, src/storage/artifact-store.js |
| Runtime | src/runtimeTemplate.js |
| Verification | src/platform/verify.js |
| Repair | src/reconstruction/repair-planner.js, repair-executor.js, repair-history.js |
| Export | src/platform/exporter.js (export-context.js used by session-recovery.js) |
| Intake | none (inline in platform/server.js + cli.js) |
| Blueprint | none (zero matches in src/) |
| Session | src/platform/sessions.js (in-memory) |
| DB | src/database/client.js, task-repository.js, tenant-repository.js, migrations/ (17 SQL) |
| Distributed (wired) | distributed/region-registry.js, failover.js; storage/artifact-replication.js |
| Distributed (test-only) | distributed/scheduler.js, worker-plane.js, job-leases.js; cost-aware-scheduler.js (via cost-prediction.js) |
| Orphaned | orchestration/pipeline-orchestrator.js; platform/{static-export,activity-routes,routes-public-v1,billing-hooks,github-publish,onboarding-service,job-diagnostics,version-service,template-service,exhaustive-test}.js |
| Entries | bin/cloner.js → src/cli.js; bin/platform.js → startPlatform; npm run worker → clone-worker.js |
