# H — Infrastructure & Platform Services audit (realignment)

Auditor: Infra & services auditor. Date: 2026-11-05. Repo: `D:/project 2/cloner` @ branch master (4327ac8).
Method: code reads + commands run in this session. Evidence is cited per claim. Read-only audit.

## 1. WHAT EXISTS

Runtime deps (`package.json`, read via node -e): exactly 7 — `bcryptjs ^3.0.3, bullmq ^6.5.3,
express ^4.21.2, ioredis ^6.0.0, pg ^8.23.1, playwright ^1.49.1, ws ^8.18.0`. `engines` field:
**absent** (`node -e` printed `engines: undefined`). No `.nvmrc` at repo root (`ls .nvmrc` → nothing).

- **Docker**: `Dockerfile` — 3 stages, all `node:24-alpine` (matches the plan's Node 24 assumption);
  musl-native chromium symlinked into playwright's browser registry with a build-time launch
  self-test (`chromium.launch()` gate, Dockerfile lines 24–26); non-root `node` user, tini entrypoint;
  CMD validates env first: `node src/config-schema.js api && exec node bin/platform.js --port 4180`.
- **Compose**: `docker-compose.yml` (dev: postgres:16-alpine @ host 5433, redis:7-alpine @ 6379,
  optional `worker` profile running `npm install && node src/workers/clone-worker.js`);
  `docker-compose.prod.yml` (api/worker/migrator one-shot migration gate, healthchecks, named volumes).
- **K8s**: `k8s/` — 00-namespace, 10-configmap, 20-secrets.yaml.example, 25-storage,
  30-control-plane, 40-workers (worker cmd: `node src/config-schema.js worker && exec node
  src/workers/clone-worker.js`, per-pod `CLONER_WORKER_ID` from metadata.name), 50-hpa
  (3 HPAs, min 2 replicas each).
- **PostgreSQL**: `src/database/client.js` — pg.Pool (defaults host 127.0.0.1 port 5433, max 10);
  `migrate()` with per-boot advisory lock (key 902101) + one-transaction-per-file (client.js:25–62).
  `src/database/migrations/` — 17 SQL files: 001-initial … 050-ad-settings. Tables created (grep of
  CREATE TABLE across migrations): users, sessions, tasks, task_stages, task_events, artifacts,
  stays, plans, user_plans, org_plans, organizations, org_members, org_invitations, tenant_denials,
  quota_limits, quota_reservations, quota_usage_events, quota_usage_daily, admin_quotas, api_keys,
  audit_events, job_leases, notification_preferences, notification_deliveries, compute_job_costs,
  compute_cost_rates, capacity_samples, capacity_job_costs, recon_patterns,
  recon_pattern_telemetry, oauth_states, oauth_accounts, project_versions, onboarding_profiles,
  activity_events, ad_slot_settings, ad_serving_events, ad_delivery_log. In-module idempotent DDL
  adds: billing_credit_grants, credit_ledger_entries, stripe_customers, workflow_hooks,
  workflow_hook_deliveries.
- **Live DB check (run here)**: `pg.Pool` probe → `PG OK, migrations applied: 17`, 44 tables listed.
- **Redis/BullMQ**: `src/queues/clone-queue.js` (651 lines) — one surface, two backends: `bullmq`
  when REDIS_URL/CLONER_REDIS_URL set AND reachable, else in-process `memory` fallback
  (backend resolved async at first enqueue; `CLONER_QUEUE_BACKEND=memory` forces memory,
  clone-queue.js:469–481). DLQ `clone-jobs-dead`; 3 attempts, exponential backoff; credential
  redaction before DLQ (redactCredentials, clone-queue.js:74–85). Worker:
  `src/workers/clone-worker.js` (336 lines) — bounded concurrency (MAX_CONCURRENT, default 2),
  transient-only retries via `isTransientError` + `UnrecoverableError`, withJobScope tagging,
  task_stages persistence, stalled-job recovery config, SIGTERM drain, Redis-or-memory heartbeat
  (`src/workers/worker-health.js`, key `cloner:worker:heartbeat:<workerId>`).
- **Multi-tenancy/orgs**: `src/database/tenant-repository.js` (290 lines; UUID guard, org CRUD,
  membership roles owner>admin>member, resolveTenantContext, org-scoped task reads, denial audit);
  `src/platform/org-service.js` (invitations, role changes), `src/platform/tenant-scope.js`,
  `src/platform/admin-routes.js`, `src/platform/quota-service.js`/`quota-middleware.js`.
- **Billing**: `src/platform/billing-stripe.js` (911 lines) — zero-dollar rework: BILLING_MODE
  unset ⇒ noop grant, never calls Stripe even with a key; prices hard-enforced $0; HMAC webhook
  verify; billingRouter mounted at `app.use("/api/billing", billingRouter())` (server.js:78) BEFORE
  express.json for raw webhook bytes. `src/platform/credit-ledger.js` (170 lines) — grant-only
  ledger, idempotent by eventId, no spend gate anywhere.
- **OAuth**: `src/platform/oauth-real.js` (431 lines) — Google-only (GitHub routes → 410 Gone),
  PKCE S256, real IdP endpoints, no mocks; mounted `/api/auth/oauth` (server.js:18, mount 18).
- **API keys**: `src/platform/api-key-service.js` (193 lines) — SHA-256 hash storage, raw key
  returned once, scopes create/read/export:task, per-key rate limits (`rate-limiter.js`), X-API-Key
  branch inside the `credentialed` wrapper (server.js:312).
- **Ads**: `src/platform/ads-optin.js` (103 lines, AsyncLocalStorage opt-in capture),
  `src/monetization/ad-providers.js`, `ad-slots.js`, `ad-config-api.js`; routers mounted
  `/api/ads`, `/api/ad-config` (server.js:170–171); `monetizeOptInMiddleware` imported
  (server.js:57) and the ad hook rides the payload (`monetize` in pipeline-job.js:38–50).
- **Observability**: `src/platform/health-routes.js` (`/healthz`, `/readyz`, `/metrics` — Prometheus
  text, gated loopback-or-admin since G5.2), `src/platform/metrics-registry.js` (248 lines,
  bounded cardinality), `src/observability/logger.js` (NDJSON per-job log), `trace-context.js` +
  `trace-export.js` (W3C traceparent producer→worker, JSONL sink), `routes-capacity.js` +
  `capacity-analytics.js`, `src/platform/compute-accounting.js` (cost rates → job costs).
- **Audit**: `src/platform/audit-service.js` (370 lines) — append-only hash chain
  (payload_hash = sha256(prev_hash+payload)), advisory-lock serialization, allowlisted event
  schema v1, retention 365d, verifyAuditChain; wired into admin surface and tenant denials.
- **Artifact lifecycle/replication**: `src/storage/artifact-store.js` (74 lines, per-job tree,
  credential redaction), `artifact-lifecycle.js` (612 lines — per-tenant roots, staged deletion,
  orphan detection, export shred verify), `artifact-replication.js` (554 lines — REPLICATION_REGIONS
  env, SHA256 per-replica manifests, geo-nearest delivery with origin fallback); replication +
  sweep attached to the queue in server.js:107–118.
- **Distributed plane**: `src/distributed/` — contracts.js (wire contracts, HMAC tokens),
  region-registry.js (783), worker-plane.js (819), job-leases.js (387, PG-backed atomic leases,
  backend via CLONER_LEASE_BACKEND), failover.js (929 — heartbeat sweep, re-route, re-replication;
  controller started in server.js:129–137, routes at `/api/distributed` admin-guarded),
  scheduler.js (731, resource-aware packing) and cost-aware-scheduler.js (780, SLA-beats-cost).
- **Worker scaling**: `src/workers/` — autoscaler.js (BullMQ metrics → policy → pool),
  scaling-policy.js (pure), worker-pool-manager.js (safe drain), worker-health.js.
- **62 npm scripts** (package.json): per-suite scripts incl. test:tenant-isolation, test:phase40,
  test:phase42, test:phase45, test:grand-final.

## 2. WHAT ACTUALLY WORKS (evidence-backed)

- **Postgres + migrations: WORKING.** Ran `pg.Pool` connect on 127.0.0.1:5433 → `PG OK, migrations
  applied: 17`, 44 tables present. Migration runner uses advisory lock + transactional files.
- **Multi-tenancy: WORKING.** Ran `node scripts/test-tenant-isolation.mjs` (the one permitted test;
  against the compose Postgres) → **"56/56 checks passed — all green"** (repository-level
  cross-tenant denial, HTTP 403/404 middleware denials, role gates, denial audit rows 162→163,
  legacy backward-compat B1–B4).
- **Quotas/orgs/admin/keys/audit/deploy/backup**: wired end-to-end in `src/platform/server.js`
  (mounts at lines 84–216: /api/orgs, /api/keys, /api/quota/*, /api/admin, /api/dashboard,
  /api/capacity, /api/distributed, /api/auth/oauth, /api/ads, /api/ad-config, /api/notifications,
  /api/email, /api/config, /api/recovery, /api/hooks) — names have dedicated suite scripts
  (test-org-management.mjs, test-quotas.mjs, test-api-keys.mjs, test-audit-logs.mjs,
  test-deployment.mjs, test-backup-recovery.mjs, etc.). NOT re-run here (one-test limit) — the
  cited proof is the named script + the live mount lines.
- **Queue abstraction: WORKING** by code path: `enqueue()` (clone-queue.js:138) → memory backend
  executes the shared `runPipelineJob` in-process (clone-queue.js:254 `d.run(...)`) or bullmq
  backend packs `{payload, jobId}` into Redis; QueueEvents copy status back onto entries;
  DLQ + credential redaction implemented producer-side.
- **Worker→engine seam: WORKING.** `startCloneWorker` (clone-worker.js:107) processor →
  `runPipelineJob` (src/queues/pipeline-job.js:29) which runs Stage 1 `runExplorationJob`
  (src/pipeline/exploration-pipeline.js), Stage 2 `reconstructFromArtifacts`
  (src/reconstruction/reconstruction-pipeline.js), Stage 3 `verifyTask` (src/platform/verify.js,
  which launches a real browser — worker hosts need chromium, Dockerfile provides it).
- **Env validation: WORKING.** `src/config-schema.js` (445 lines) with roles api/worker/migrator,
  secret redaction; used by Dockerfile CMD, prod compose migrator, k8s worker command.
- **Health/metrics/tracing**: `/metrics` Prometheus endpoint exists and is access-gated
  (health-routes.js:107); trace sink attached at boot (server.js:106 `attachTraceSinkFromEnv()`).
- **Failover controller: partially wired.** `createFailoverController` starts at boot
  (server.js:129–137) and serves admin routes; re-route dispatch resolves `job.payload.run`
  (failover.js:807–808, server.js:131–134) — only meaningful on the memory backend (see §3).

## 3. WHAT IS BROKEN / INCOMPLETE / DISCONNECTED

- **No `engines` field and no `.nvmrc`** — the Node 24 contract lives only in the Dockerfile
  (node:24-alpine). Local runs on any Node version boot silently; the realignment plan's Node 24
  assumption is enforced nowhere outside Docker.
- **Dev compose worker runs `npm install` at container start** (docker-compose.yml, worker
  command `npm install --no-audit --no-fund && node src/workers/clone-worker.js`) — a
  network-dependent install inside a volume-mounted source tree; prod uses the built image
  instead, so this is dev-only drift.
- **Dead + broken: `src/orchestration/pipeline-orchestrator.js` (95 lines).** `executePipeline`
  has zero callers (grep across src/, bin/, scripts/ → only the definition). Its failure path
  calls `require("fs")` (line 80) which is undefined under `"type":"module"` — proof it never ran.
  It duplicates the exact 3-stage seam that pipeline-job.js already owns.
- **Disconnected distributed modules (built, tested by scripts, but not boot-wired):**
  `src/distributed/scheduler.js`, `cost-aware-scheduler.js`, `worker-plane.js` are imported by no
  product entrypoint (grep of server.js/bin/ for autoscaler/WorkerPlane/costAware/scheduleJob →
  nothing); `src/workers/autoscaler.js` + `scaling-policy.js` + `worker-pool-manager.js` are
  likewise never started by bin/platform.js or clone-worker.js. `src/distributed/job-leases.js`
  is imported only by test scripts (test-job-leases.mjs, test-g52-hunt-backend.mjs) — no product
  path acquires a lease; duplicate execution across BullMQ workers is currently prevented by
  BullMQ's own lock only.
- **Region workers vs jobs**: `worker-plane.js` routes jobs "through the existing queue adapter
  contract" but nothing boots a region worker against a named queue; region-registry is a
  coordinator-side in-memory plane behind `/api/regions`.
- **Compute accounting is grant-only**: server.js sets `setCreditLedger(null)` (comment: "the free
  platform grant ledger is the real ledger; it is GRANT-ONLY"), so compute settlements persist
  with status 'unposted' by design — capacity/cost dashboards read data that is never reconciled
  to credits.
- **Failover re-route is memory-backend-coupled**: the queue payload carries a `run` closure on the
  memory path (clone-queue.js:138/254); `createQueueDispatcher` resolves `job.payload.run`
  (failover.js:807) which cannot survive a Redis round-trip. On BullMQ deployments re-route relies
  on the comment "a BullMQ deployment consumes the region queue from its worker process" — no such
  region-queue consumer is boot-wired.
- **k8s manifests unvalidated in CI terms**: scripts/test-k8s-manifests.mjs exists but was not run;
  manifests reference `cloner-platform:latest` image + `node src/config-schema.js worker`.
- **Stale doc risk**: README-PLATFORM.md (24 KB, dated Oct 30) predates the 4.5 zero-dollar
  billing/Google-only OAuth reworks described in code headers — treat prose, not code, as stale.

## 4. WHAT IS REUSABLE AS-IS FOR THE REALIGNMENT

- **The queue surface** `src/queues/clone-queue.js` (`enqueue/onStatus/getEntry/rekey/linkJobId/
  cancel/whenIdle/close`, backend auto-probe, DLQ, redaction) — the new orchestration pipeline can
  replace what happens *inside* a job without touching this surface.
- **The seam contract**: any new pipeline can slot in at `pipeline-job.js` level: payload in →
  `report(status,data)` callbacks → shaped result `{jobId, artifactsDir, status, passed, manifest,
  reconstruction, verification}` out. BullMQ worker, stage persistence (task_stages), tracing
  (`tracedExecutor`), withJobScope tagging and health are already generic.
- **Everything in §2 that is WORKING**: Postgres client/migrations, tenant-repository + tenant-scope,
  org-service, quota-service/middleware, api-key-service, audit-service (hash chain), oauth-real,
  credit-ledger, metrics-registry + health-routes, artifact-store/lifecycle/replication,
  worker-health, config-schema, Dockerfile/compose prod/k8s worker command.
- **Env contract** (`config-schema.js` SCHEMA) and the `.env.example` (32 KB) documentation of it.
- **The 17-file forward-only migration set** plus `_migrations` bookkeeping — additive evolution
  continues cleanly.

## 5. WHAT NEEDS MODIFICATION (file-level)

1. `package.json`: add `"engines": {"node": ">=24"}` (+ optional `.nvmrc`) so the Node 24 plan
   assumption is enforced outside Docker.
2. Delete or adopt `src/orchestration/pipeline-orchestrator.js` — it is dead, has the `require("fs")`
   ESM bug, and shadows the real seam. If the realignment wants a DB-driven orchestrator, rewrite it
   to call the same `runPipelineJob` contract rather than re-importing engine stages directly.
3. Replace the memory-backend `run`-closure channel (`enqueue({payload, run,...})`,
   clone-queue.js:138) with a pure-JSON payload contract so failover/worker-plane re-routes work on
   BullMQ too; update `createQueueDispatcher` (failover.js:807) accordingly.
4. Decide the fate of the unbuilt distributed layer: either wire `job-leases.js` (acquire before
   execute in clone-worker.js processor), `autoscaler/worker-pool-manager` (a small bootstrap in
   bin/worker or a new bin/autoscaler.js), `scheduler.js`/`cost-aware-scheduler.js`/`worker-plane.js`
   into boot paths — or cut them from the realigned product. Carrying ~3.7k lines of
   unbootstrapped scheduling code is the main OVERBUILT risk in this area.
5. `docker-compose.yml` worker service: replace runtime `npm install` with the built image
   (`cloner-platform:latest`, target runtime) to match prod.
6. `src/platform/compute-accounting.js` + server.js:129 comment: decide whether 'unposted'
   settlement is a realignment requirement (a debit-capable ledger injection point already exists).
7. Billing: for a free product, `billing-stripe.js` (911 lines) can be reduced to
   credit-ledger + webhook-verify if Stripe compatibility is no longer a goal; otherwise keep —
   it is self-contained and default-off.
8. If verification keeps launching a browser inside the worker (verify.js → launchBrowser), worker
   images/HPAs must retain the chromium layer — capture this as a hard deployment constraint in the
   realignment plan.

## 6. COMPLETION EVIDENCE FOR THE REALIGNED AREA

- `docker compose -f docker-compose.prod.yml up -d --build` → migrator exits 0, api/worker healthy.
- `node src/config-schema.js api && node src/config-schema.js worker` → clean under Node 24; with
  engines added, `node -e "require('./package.json').engines"` prints the node>=24 range.
- `npm run test:phase40` (12 suites) and `npm run test:grand-final` → all green, including
  test-tenant-isolation.mjs 56/56 (rerun as the regression gate).
- BullMQ path e2e: `docker compose --profile worker up -d worker` with REDIS_URL → job enqueued via
  POST /api/tasks reaches completed with task_stages rows (exploration/reconstruction/verification)
  and appears in `clone-jobs-dead` only on non-transient failure.
- Failover drill: stop a region worker, observe heartbeat-loss detection in `/api/distributed`
  routes and successful re-route of an in-flight job **on the BullMQ backend** (proves fix #3).
- Artifact lifecycle: `node scripts/test-artifact-lifecycle.mjs` + retention sweep emitting
  `artifact-sweep` payloads that complete on the worker path (defaultExecutor branch,
  clone-worker.js:263–274).
- `node scripts/test-k8s-manifests.mjs` green; HPA scales workers with CLONER_WORKER_ID uniqueness.

## KEY FILE MAP

| Concern | File |
|---|---|
| DB client + migrations runner | src/database/client.js (86) |
| Migration set (17 files, 44 tables) | src/database/migrations/001…050 |
| Tenancy repo | src/database/tenant-repository.js (290) |
| Task repo/stages | src/database/task-repository.js (126) |
| Queue adapter (memory/bullmq) | src/queues/clone-queue.js (651) |
| Shared 3-stage pipeline (SEAM) | src/queues/pipeline-job.js (105) |
| BullMQ worker | src/workers/clone-worker.js (336) |
| Worker health/heartbeat | src/workers/worker-health.js |
| Autoscale (unwired) | src/workers/autoscaler.js, scaling-policy.js, worker-pool-manager.js |
| Server/mount integrator | src/platform/server.js (mounts :84–216, sweep :1180–1193) |
| Billing (zero-dollar Stripe) | src/platform/billing-stripe.js (911) |
| Credit ledger (grant-only) | src/platform/credit-ledger.js (170) |
| Quotas | src/platform/quota-service.js, quota-middleware.js |
| Orgs | src/platform/org-service.js, org-routes.js |
| OAuth (Google-only) | src/platform/oauth-real.js (431) |
| API keys | src/platform/api-key-service.js (193) |
| Ads opt-in/serving | src/platform/ads-optin.js (103), src/monetization/ad-*.js |
| Audit (hash chain) | src/platform/audit-service.js (370) |
| Metrics/health | src/platform/metrics-registry.js (248), health-routes.js |
| Tracing | src/observability/trace-context.js, trace-export.js |
| Artifact store/lifecycle/replication | src/storage/artifact-store.js (74), artifact-lifecycle.js (612), artifact-replication.js (554) |
| Distributed (leases unwired) | src/distributed/job-leases.js (387) |
| Distributed (unwired schedulers) | src/distributed/scheduler.js (731), cost-aware-scheduler.js (780), worker-plane.js (819), region-registry.js (783), failover.js (929 — wired), contracts.js (377) |
| Env schema | src/config-schema.js (445) |
| Dead orchestrator | src/orchestration/pipeline-orchestrator.js (95) |
| Deployment | Dockerfile (node:24-alpine), docker-compose.yml, docker-compose.prod.yml, k8s/* |

## VERIFICATION COMMANDS RUN IN THIS SESSION

- `cat Dockerfile`; `node -e` package.json dump (engines absent; 7 deps; 62 scripts).
- `ls` of src/{database,queues,workers,distributed,platform,observability,storage,monetization},
  src/database/migrations (17 files), k8s, bin (cloner.js, platform.js only).
- `grep -o "CREATE TABLE IF NOT EXISTS …" migrations` → table census above.
- `pg.Pool` probe 127.0.0.1:5433 → "PG OK, migrations applied: 17" + 44-table list.
- `node scripts/test-tenant-isolation.mjs` → "56/56 checks passed — all green".
- `grep` wiring checks: executePipeline callers (none), job-leases consumers (tests only),
  autoscaler/scheduler/worker-plane boot wiring (none), billingRouter + monetizeOptInMiddleware
  mounts, setCreditLedger(null), failover controller start, enqueueSweep intervals.
- `node --check src/orchestration/pipeline-orchestrator.js` → syntax OK; `require("fs")` at line 80
  is a runtime ESM error on the (never-exercised) failure path.
- NOT run (one-test limit / not offline-in-60s candidates): test-worker-queue.mjs, test-quotas.mjs,
  test-org-management.mjs, test-api-keys.mjs, test-audit-logs.mjs, test-artifact-lifecycle.mjs,
  test-artifact-replication.mjs, test-k8s-manifests.mjs, test-free-billing.mjs,
  test-oauth-google-only.mjs, test-job-leases.mjs — each remains the named proof for its area.
