# Implementation Specification — Architectural Realignment of the Cloner Product

- **Date:** 2026-11-05
- **Repository:** `D:/project 2/cloner` (branch master, HEAD 4327ac8)
- **Purpose:** Architectural realignment of the existing product, per the owner's directive. This is
  NOT a new feature phase and NOT a roadmap. It re-wires, connects, and completes the system that
  already exists, grounded in eight parallel audits under `docs/realignment/audits/`
  (A-architecture, B-frontend, C-session-auth, D-exploration, E-understanding-artifacts,
  F-blueprint-reconstruction, G-verification-repair-export, H-infra-platform). Every factual claim
  below cites a file path or command taken from those audits; anything not evidenced by an audit is
  marked **UNVERIFIED — audit follow-up needed**.

## Non-goals

- **No rebuild of working infrastructure.** Multi-tenancy (tenant-repository 56/56), billing
  (zero-dollar billing-stripe.js), regional worker plane, API keys, integrations (OAuth, email,
  GitHub, ads, notifications, workflow hooks) are **retained as-is** (audit H §4).
- **No duplicate orchestration pipeline.** There is exactly one pipeline definition
  (`src/queues/pipeline-job.js`); the orphaned 5-stage orchestrator is deleted, not revived
  (audit A §3.1, H §3).
- **No mandatory cloud AI dependency.** Deterministic/local-first behavior is preserved: the
  understanding engine's vision hook defaults to provider "none" and makes zero network calls
  (`src/reconstruction/website-understanding.js:610`, audit E §1); offline suites use a fetch
  tripwire (audit E §2).
- **No automatic publishing.** GitHub publish remains an owner-triggered route
  (`src/platform/github-publish-real.js`, mounted `src/platform/server.js:592`); nothing is pushed
  or published without explicit owner authorization.
- **File-write cap.** Every implementation write stays within a **350-line cap per write**;
  larger changes are split across multiple writes.
- **No framework migration of the backend.** Express 4 + Postgres + BullMQ/memory queue stay
  (audit H §1: 7 runtime deps).

## Target architecture at a glance

**12 logical engines** (each mapped to existing files; "MISSING" = to be created):

| # | Engine | Current anchor (evidence) |
|---|--------|---------------------------|
| 1 | Intake | Inline in `src/platform/server.js` POST /api/tasks (field caps `server.js:350`, URL guard `:437`) + `src/cli.js` arg parsing; to be extracted to `src/intake/` (audit A §5) |
| 2 | Session | `src/browser.js` (Playwright engine), `src/browser/browser-pool.js` (58/58 pool test, audit C §2), `src/platform/sessions.js` (in-memory Map, `sessions.js:1-15`), `src/auth/auth-middleware.js` + `src/auth/auth-service.js` |
| 3 | Exploration | `src/pipeline/exploration-pipeline.js` + `src/exploration/{route-discovery,state-discovery,exploration-policy,application-state-capture,websocket-session-capture}.js` + `src/interactions.js` (audits A §4, D §1) |
| 4 | Understanding | `src/reconstruction/website-understanding.js` (717 L, 79/79 suite green) + `src/reconstruction/component-evidence.js` (audit E) |
| 5 | Blueprint | **MISSING** — `grep -rni "blueprint" src/ bin/` → 0 matches (audits A §5, E §1, F §3.1) |
| 6 | Reconstruction | `src/reconstruction/reconstruction-pipeline.js` + `generation/project-generator.js` + `analysis/{component-tree-builder,layout-analyzer}.js` + `src/runtimeTemplate.js` (audit F §1) |
| 7 | Asset | `src/assets/asset-manifest.js` + `src/pipeline/asset-capture.js` + `src/storage/artifact-store.js` — consolidate under one Asset boundary (audit A §5) |
| 8 | Verification | `src/platform/verify.js` (3-stage loop, MAX_ROUNDS=3 `verify.js:22`) + `src/reconstruction/visual-fidelity-analyzer.js` + `visual-diff-classifier.js` + `scripts/compare-clone.mjs` (audit G §1) |
| 9 | Repair | `src/reconstruction/{repair-planner,repair-executor,repair-history}.js` + `autoRemediate` (`verify.js:512`) (audit G §1) |
| 10 | Export/Delivery | `src/platform/exporter.js` + `export-context.js` + `github-publish-real.js` + unmounted `static-export.js` / `version-service.js` (audit G §1) |
| 11 | Orchestration | `src/queues/pipeline-job.js` (single 3-stage definition) + `src/queues/clone-queue.js` (memory/BullMQ) + `src/workers/clone-worker.js` + `src/workers/worker-health.js` (audits A §2, H §1) |
| 12 | Platform services | Auth/tenancy/quota/billing/keys/audit/observability/health routers + `src/storage/artifact-lifecycle.js` + `artifact-replication.js` (audit H §1) |

**8 product pages** (route names per audit B §5; frontend does not exist today):

| # | Page | SPA route | Disposition (audit B §5) |
|---|------|-----------|--------------------------|
| 1 | Projects Dashboard | `/projects` | RESTORE-FROM-HISTORY (platform-ui task sidebar) + `/api/dashboard` enrichment |
| 2 | New Clone | `/projects/new` | REBUILD — needs `scope` + `framework` fields on POST /api/tasks |
| 3 | Live Exploration | `/projects/:id/exploration` | REBUILD — WS timeline + `pages/<id>/*` artifacts + `/api/sessions` |
| 4 | Website Intelligence | `/projects/:id/intelligence` | REBUILD — pure frontend over existing artifacts + one aggregate endpoint |
| 5 | Clone Blueprint | `/projects/:id/blueprint` | NEW — requires new `blueprint.json` artifact |
| 6 | Reconstruction Workspace | `/projects/:id/build` | REBUILD — jobs/logs/repair-round views |
| 7 | Comparison & QA | `/projects/:id/qa` | RESTORE-FROM-HISTORY + EXTEND — diff heatmap, A\|B slider, verification cards |
| 8 | Final Project | `/projects/:id/final` | RESTORE-FROM-HISTORY + FIX — preview/ZIP/GitHub + mount versions router |

**Single orchestration pipeline** — one definition, two execution backends:

```
Intake → Session → Exploration → Understanding → Blueprint → Reconstruction
       → Verification → Repair → Export
```

Implemented as stages inside `src/queues/pipeline-job.js runPipelineJob` (today:
`runExplorationJob` → `reconstructFromArtifacts` → `verifyTask`, `pipeline-job.js:69,89,102`,
audit F §1), executed identically by the memory backend (`clone-queue.js:239-275`) and the BullMQ
worker (`clone-worker.js:310`), audits A §2. Intake runs at POST /api/tasks before enqueue;
Session establishment runs at exploration start; Export remains a post-job owner-triggered route
(`POST /api/export/:id`, `server.js:899`); Repair runs inside the verification loop (`verify.js:661-696`).

---

## Decision: Headless platform (G7.1) vs the 8-page product workflow

**What the audits found:**

- Decision G7.1 ("backend-only, UI removed") is documented at `docs/ARCHITECTURE.md:47-65` and
  implemented: `src/platform/server.js:270-274` has no static mount, no `GET /`; every non-API
  path falls through to a terminal 404; only clones are served under `/preview/:id/*`
  (`server.js:789-790`) (audits A §1, B §1).
- `platform-ui/` is **deleted at HEAD**: it existed only in commit `cdffb15` (3 files, 817 lines:
  index.html 139 / app.js 397 / style.css 281) and was deleted by current HEAD commit `4327ac8`.
  `docs/ARCHITECTURE.md:6` claims removal "entirely on 2026-11-03"; git dates the deletion commit
  2026-11-05 00:03 +0530 — substance correct, date ~2 days off (audit A §1).
- `dashboard/` (`dashboard/index.html` + `app.js` + `style.css`, served by `src/server.js:27-28`,
  port 4173) is the **legacy cloner UI for CLI-run observability**: it consumes only
  `/api/events`, `/api/runs`, `/preview/*`, `/api/edit`, `/api/ask`, never calls `/api/tasks`, and
  observes runs made by the CLI process (audit A §1, B §1).
- **No blocking reason against restoring a product frontend was surfaced by any audit.** On the
  contrary: every backend surface the deleted UI consumed is still mounted (tasks, jobs, artifacts,
  export, chat, WS — audit B §2); the WS fan-out is owner-scoped and working (audit B §2); the
  element-picker contract (`src/picker.js`, injected at `server.js:280`) is intact (audit B §2);
  and the deleted UI's WS handler already covered all 13 server event types
  (history `platform-ui/app.js:330-355`, audit B §2).
- G7.1's own rationale is obsolete: platform-ui was removed because a 397-line vanilla file could
  not carry 8 product pages (audit B §5), not because a frontend is unwanted.

**Recommendation (one option):** **Supersede G7.1.** Build a focused 8-page SPA in a new source
tree (`web/`, NEW — path does not exist today), served by the platform server itself via one
sanctioned static mount `app.use("/app", express.static(<dist>))` plus SPA history-fallback,
replacing the terminal-404 comment at `src/platform/server.js:271-273` (exact serving design per
audit B §5). Reuse the platform-ui interaction logic restored from git history (`git show
cdffb15:platform-ui/app.js`, `index.html`, `style.css`) as the skeleton — its WS handling, task
sidebar, compare slider, exploration table, verification cards, picker protocol, chat-bar task
creation and export flow are all contracts-compatible with today's mounted API (audit B §4) —
and restyle it into the 8 pages. Same-origin `/api` + `/ws` + cookies means no CORS changes
(audit B §4). No second server, no reverse proxy.

**Label: DECISION-CONFIRMED-BY-OWNER-DIRECTIVE.** The owner's realignment directive explicitly
directs the 8-page product workflow served by the platform; the audits surfaced no blocking
reason; the legacy `dashboard/` trio remains untouched as the local CLI operator console
(`src/server.js`, port 4173) and is not part of the 8-page product.

---

## 1. Actual existing frontend routes and their responsibilities

There are exactly two live frontend surfaces (one per server) plus one deleted one. No SPA exists.

### 1.1 Legacy engine/dashboard server — `src/server.js` (181 lines, port 4173)

Started only by the CLI (`src/cli.js:100`, `--serve-only` flag) (audit A §1). All handlers inline;
no router files (audit A §1):

| Route | Line | Responsibility |
|---|---|---|
| `GET /` | server.js:27 | Serves `dashboard/index.html` |
| `GET /static/*` | server.js:28 | Serves `dashboard/` assets |
| `GET /api/runs` | server.js:31 | Inline fs scan of `outputs/*/clone.json` (v1 run list) |
| `GET /preview/:run/*` + `GET /preview/:run` | server.js:49, 68 | Serves v1 clone output; picker injected (server.js:14, 61) |
| `GET /api/events` | server.js:71 | Bus event stream (500-event ring, `src/events.js:5-27`) |
| `POST /api/edit` | server.js:74 | Inline vision edit of picked element |
| `POST /api/ask` | server.js:129 | Inline chat |
| `WS /ws` | server.js:143 | Bus events bridged to WS (server.js:155-157) |

**Frontend served:** `dashboard/index.html` (77 L) + `dashboard/app.js` (228 L) + `style.css`
(380 L) — a 3-pane single-run console: LEFT pipeline step feed + log; CENTER tabs Clone (iframe of
`/preview/<run>/index.html`, 1440px scaled fit, app.js:139-154) / Original (engine screenshots) /
Side-by-side; RIGHT element-picker arm + instruction textarea + "Apply with model" + brief box
(audit A §1). It **never calls `/api/tasks` and never creates jobs** — it observes CLI runs only
(audit A §1). Keep as-is (operator console).

### 1.2 Platform API server — `src/platform/server.js` (1240 lines, port 4180 via `bin/platform.js`)

Deliberately headless (G7.1): comment block `src/platform/server.js:271-273` — "headless backend
(G7.1: the platform's own UI was removed) … There are NO static mounts: '/' and every non-API
path fall through to the terminal 404" (audit B §1). The only pages served are clone previews:
`GET /preview/:id` redirect (server.js:789) and `GET /preview/:id/*` (server.js:790,
owner-gated 790-813, picker injected, audit G §1). Full mounted route inventory (audit A §1):

| Route(s) | Handler module | server.js line |
|---|---|---|
| `/api/billing` (incl. raw-body HMAC webhook) | `src/platform/billing-stripe.js` | 78 |
| `/healthz`, `/readyz`, `/metrics` | `src/platform/health-routes.js` | 84 |
| `/api/orgs` | `src/platform/org-routes.js` | 89 |
| `/api/keys` | `src/platform/api-key-service.js` keysRouter | 94 |
| `/api/quota/usage`, `/api/quota/reconcile` | `src/platform/quota-middleware.js` | 97-98 |
| `/api/admin/*` (users, orgs, tasks+cancel, quota, key revoke, retention sweep, audit+verify, workers) | `src/platform/admin-routes.js` (admin-routes.js:210-305) | 102 |
| `/api/dashboard`, `/api/dashboard/history` | `src/platform/dashboard-routes.js` (dashboard-routes.js:117,181) | 108 |
| `/api/recovery` | `src/platform/session-recovery.js` | 154 |
| `/api/notifications` | `src/platform/notification-delivery.js` | 158 |
| `/api/email` (/send, /receipts) | `src/platform/email-real.js` (email-real.js:573,582) | 162 |
| `/api/config` | `src/platform/ui-config-routes.js` (ui-config-routes.js:234-338) | 166 |
| `/api/ads`, `/api/ad-config` | `src/monetization/ad-slots.js`, `ad-config-api.js` | 170-171 |
| `/api/capacity` | `src/platform/routes-capacity.js` | 175 |
| `/api/intelligence` | `src/platform/intelligence/intelligence-routes.js` (14 routes, :83-163) | 179 |
| `/api/regions` | `src/distributed/region-registry.js` | 183 |
| `/api/hooks` | `src/platform/workflow-hooks.js` | 189 |
| `/api/auth/oauth` (/providers, /google/start, /google/callback) | `src/platform/oauth-real.js` | 193 |
| `/api/distributed` (admin-guarded) | `src/distributed/failover.js` | 201 |
| `POST/GET /api/auth/register\|login\|logout\|me` (inline) | server.js | 224-268 |
| `POST /api/tasks` / `GET /api/tasks` / `GET/DELETE /api/tasks/:id` (inline) | server.js | 418, 594, 691, 720 |
| `/api/github` (/status, /publish/:taskId) | `src/platform/github-publish-real.js` (github-publish.js:474,481 per audit A; mount :592) | 592 |
| `POST /api/jobs/explore` / `GET /api/jobs` / `GET /api/jobs/:jobId` / `GET /api/jobs/:jobId/artifacts/*` | server.js | 613, 652, 658, 669 |
| `GET /preview/:id/*` | server.js | 789-790 |
| `POST /api/tasks/:id/chat` | server.js | 835 |
| `POST /api/export/:id` / `GET /api/export/:id/download` | server.js | 899, 938 |
| `GET /api/sessions` / `GET /api/providers` | server.js | 971, 973 |
| `WS /ws` | server.js | 1005 |

WS event contract: on connect a `catchup` replay (500-event ring, `src/events.js:5-27`); client
sends `{type:"join",task}`; server forwards exactly `step, log, tabs:found, assets:progress,
assets:done, page:goto, run:done, run:error, polish:round` (whitelist `server.js:1087`), plus
`preview:reload` (:891), `job:status` (:1123), `task:done` (:1159); rooms are owner-scoped
(loopback anonymous legacy room vs authenticated user rooms, `server.js:1009-1097`) (audit B §1).

### 1.3 Deleted product frontend — `platform-ui/` (restorable from git)

Existed only at commit `cdffb15`: single-page 5-tab workspace (Clone preview iframe, Original
screenshot, Compare with diff heatmap + draggable A|B slider, Exploration behaviors table,
Verification stage cards), task sidebar with status dots, chat bar (URL → new task), element
inspector, export button, WS activity log (audit B §1). Deleted by HEAD commit `4327ac8`
(audit A §1). Its logic worked against routes still mounted today (audit B §2) — see Decision.

### 1.4 What does NOT exist

No SPA, no routing, no login screen, none of the 8 pages; every non-API platform path 404s
(audit B §3). The legacy `dashboard/` does not talk to the v2 pipeline (audit B §3).

---

## 2. Actual backend modules and their responsibilities
Entries (audit A key file map): `bin/cloner.js` -> `src/cli.js` `main()` (v1 direct run; optionally starts the
dashboard server, `cli.js:100`); `bin/platform.js` -> platform server start (port 4180); `npm run worker` ->
`src/workers/clone-worker.js` (standalone BullMQ mode requires REDIS_URL, `clone-worker.js:322-326`).

### 2.1 Orchestration (Engine 11)

| Module | Responsibility (evidence: audits A §2, F §1, H §1, C §3) |
|---|---|
| `src/queues/pipeline-job.js` | **The single pipeline definition**: `runPipelineJob` = `runExplorationJob` -> `reconstructFromArtifacts` -> `verifyTask` (:39, stages :69/:89/:102). Backend-agnostic: payload in, `report(status,data)` callbacks, shaped result `{jobId, artifactsDir, status, passed, manifest, reconstruction, verification}` out (H §4) |
| `src/queues/clone-queue.js` (651 L) | One surface, two backends: `bullmq` when REDIS_URL set AND reachable, else in-process `memory` (resolved async at first enqueue; `CLONER_QUEUE_BACKEND=memory` forces memory, :469-481). Memory `#memDispatch` runs the `run` closure in-process (:239-275); bullmq packs `{payload, jobId}` into Redis (:214). Bounded queue: cancel, DLQ `clone-jobs-dead`, duplicate-dispatch guard (:243-246), DLQ credential redaction (:73-84, :613-621), removeOnComplete/Fail counts (:216-219) |
| `src/workers/clone-worker.js` (336 L) | BullMQ `defaultExecutor` -> `runPipelineJob` (:292, :310); artifact-sweep case (:284-290); `MAX_CONCURRENT` default 2 (:38); transient-only retries (`isTransientError` + `UnrecoverableError`); `task_stages` persistence (CANONICAL_STAGE map ~:57); stalled recovery; SIGTERM drain |
| `src/workers/worker-health.js` | Redis-or-memory heartbeat `cloner:worker:heartbeat:<workerId>` |
| `src/orchestration/pipeline-orchestrator.js` (95 L) | **DEAD**: `executePipeline` (5 stages incl. `artifact_validation`) has ZERO callers; mentioned only in a comment (`clone-worker.js:54`); failure detection reads `.in_progress` marker files no code creates (:80); failure path `require("fs")` (:80) is an ESM runtime error — proof it never ran; Stage 5 calls the v1 `exportTask` (L60) (A §3.1, F §3.8, G §3.13, H §3) |

### 2.2 Session & browser (Engine 2)

| Module | Responsibility (evidence: audit C §1, §3; A §5) |
|---|---|
| `src/browser.js` (655 L) | Playwright engine: cookie import JSON + Netscape (`loadCookies` :20-53); launch fallback chromium -> msedge -> chrome (:64-81); SSRF-guarded contexts (`src/security/request-guard.js`); storage replay `addInitScript` (:88-93); WebGL `preserveDrawingBuffer` (:96-107); login-form detection (:292-296); MHTML snapshot (:321-338); legacy `autoScroll` (:340-358, v1 flow only); stack-detection logging (:453-476) |
| `src/browser/browser-pool.js` (594 L) | Per-worker pool: warm-context reuse keyed on config signature (:170-178), navigation-budget recycle (:421-425), OS-RSS ceiling (:79-156), sweeper (:482-499), `verifyNoLeaks` fail-closed (:528-545), `withLease` dirty-context marking (:581-591). **Disconnected from the pipeline** — only `scripts/test-browser-pool.mjs` exercises it; the pipeline does per-job `launchBrowser({headless:true})` (`exploration-pipeline.js:72`) |
| `src/cloneUrl.js` | v1 URL flow; headful Cloudflare-challenge retry (`isChallenge` :334-336, retry :55-63) — the only human-in-the-loop pattern in the repo |
| `src/platform/sessions.js` | In-memory Map, 30-min idle (:1-15); single-process only (A §5) |
| `src/auth/auth-middleware.js` + `auth-service.js` | Product's own auth: bearer header sessions (:9-27; fingerprint :43-53), bcrypt + DB-backed sessions |

### 2.3 Intake (Engine 1)

Inline today: `POST /api/tasks` destructures `{url, username, password, cookies, storage, instructions, mode, pipeline}`
with `TASK_FIELD_LIMITS` caps (`server.js:350`, check :398-403), URL guard (:437), pipeline validation (:435,
defaults to **v1** when `pipeline` absent, :439); plus `src/cli.js` arg parsing (A §5, C §1, F §1).
No `src/intake/` module exists (A §5).

### 2.4 Exploration (Engine 3)

| Module | Responsibility (evidence: audits C §1, D §1/§3, E §1) |
|---|---|
| `src/platform/exploration-runner.js` | `queueExploration` (:27-62) builds the queue payload; puts `username/password/cookies/storage` in (:39) but **omits `instructions`** (F §3.2) |
| `src/pipeline/exploration-pipeline.js` (388 L) | Stage-1 engine: budget deadlines; login fill/submit/verify (:110-135); `exploreRoute` (:149-275); per-page artifact contract (dom/geometry/styles/responsive/network/websocket/application-state); graph + coverage writes (:302-360); integrity manifest (:369-376); dead `onProgress` hook (:33) |
| `src/exploration/route-discovery.js` (295 L) | Scored route queue; tracking-param strip (:138-148, applied :153); query-variant dedupe (:170-186); SPA pushState/replaceState/hashchange recorder (:67-95, harvested once per page at pipeline :241); routes carry **no explored status** (:191-199) |
| `src/exploration/state-discovery.js` (287 L) | State graph nodes/edges; sha1 fingerprint (:29-31); contentKey (:36-40); candidate queue (:184-215); resumption `restore` (:100-108) |
| `src/exploration/exploration-policy.js` (66 L) | `DEFAULT_POLICY.risk` blocklist (:20-26) + `isSafeInteraction` (:46-61) are **dead code** (grep: 1 hit, own definition); stale non-hashing `stateFingerprint` (:64-66) (C §3, D §3.8) |
| `src/interactions.js` (895 L) | The real explorer: hardcoded `DANGEROUS` regex (:19); trigger marking (:197-228); overlay location (:242-279); pickerPass (:369-502); topbarPass (:507-567); captureInner (:572-655); explorePass (:658-793); 2-pass `recordInteractions` (:804-895); exploration.json/md writer (:852-873) |
| `application-state-capture.js` (231 L) + `websocket-session-capture.js` (301 L) | Per-state URL/storage probe with credential redaction (:42, :82); WS payload-shape capture, redacted (:41, :78-80) |
| `src/pipeline/asset-capture.js` (63 L) | Persists static network responses `assets/<type>/<hash>.<ext>`, hash dedupe, 8MB/300-resource caps; wired at pipeline :312-324 |
| `src/events.js` (39 L) | Bus + 500-event ring + job tag. During v2 exploration the pipeline emits ZERO bus events (`grep bus.emit` in src/pipeline, src/exploration, src/assets = 0 hits) (D §3.11) |

### 2.5 Understanding (Engine 4)

| Module | Responsibility (evidence: audit E §1; F §1) |
|---|---|
| `src/reconstruction/website-understanding.js` (717 L) | Deterministic per-page evidence model: `buildUnderstandingPage` (:487); votes (:224-360); hierarchy (:564-585); interaction context (:587-594); vision hook only for confidence < 0.5 containers, provider default "none" -> zero network (:596-645, :610) |
| `src/reconstruction/component-evidence.js` (447 L) | Evidence records `{source,ref,note,weight}` (:39); noisy-OR `aggregateConfidence` (:52-65); `electKind` (:97-118); cross-page pattern registry (:255-385, patternId "pat-"+sha256[:12] :218); `annotateUnderstanding` (:413) |
| `src/reconstruction/artifact-loader.js` (64 L) | manifest.json-gated tree loader; distinguishes missing vs empty vs malformed (:37-45) |
| `src/intelligence/dom-extractor.js` (121 L) | In-page extraction (max 1200 sampled elements); real-DOM parent resolution (:69-79); `data-cloner-trigger` marking (:29) |

### 2.6 Reconstruction (Engine 6)

| Module | Responsibility (evidence: audits E §1, F §1) |
|---|---|
| `src/reconstruction/reconstruction-pipeline.js` (517 L) | Load -> per-page analyze/generate -> tokens/CSS -> `generateProject` -> validate -> fallback-shell repair (MAX_ROUNDS=2 :27, :394-428) -> augmentations (patterns :442, responsive :489, app-state). Serial page loop (:221-309). `deriveInteractionRecords` re-derivation (:48-104). Writes `understanding.json` (:245, re-annotated :446), `design-tokens.json` (:322), `reconstruction-report.json/.md` (:511-514) |
| `generation/project-generator.js` (236 L) | `buildComponentCss` (:25); `renderNode` (:98); `generatePageHtml` (:144; raw-URL title :150); `generateProject` (:174-232); emits `cx-{i}` + `data-cloner-trigger`/`data-replay-id`/`data-stream-target` (:98-135). **Never reads understanding data** (grep 0 hits) (E §3.1, F §3.4) |
| `analysis/component-tree-builder.js` (130 L) + `layout-analyzer.js` (117 L) | DOM tree + cycle repair, semantic naming, repeated groups; flex/grid/gap inference, token builder |
| `src/runtimeTemplate.js` (572 L) | Vanilla replay runtime `buildRuntime` (:46); 4-layer click matching (:169-196); ad-slot hooks (`withAdSlots` :538, `resolveCloneAdConfig` :493 — couples runtime to monetization, A §5) |
| v1 flow | `src/cloneUrl.js` (mirror + replay: index.html/page-N.html :260-261, snapshot.mhtml :266, `design-tokens.json` :272 tokensV2 schema, clone.json :273-289, cloner-runtime.js :294); `src/assets.js` (:34 pool, :112 rewriteHtml, :158/:175 CSS); `src/vision.js` (provider-agnostic client :15-189); `src/prompts.js` (SYSTEM_CLONER :3, CLONE_FROM_VIDEO :24, EDIT_ELEMENT :55) |

### 2.7 Verification & Repair (Engines 8-9)

| Module | Responsibility (evidence: audit G §1, §3) |
|---|---|
| `src/platform/verify.js` (702 L) | `verifyTask` (:626), 3 stages: functional trigger replay (:88, OPEN_GATE 0.6 :23); optimization/completeness (~:330-403, incl. fake `"task instructions carried"` check :394-395); visual via `scripts/compare-clone.mjs` (:406; `_reference/comparison.txt` + `diff.png`, compare-clone.mjs:140-148) + EXACT-HEX tokens (:452-505). MAX_ROUNDS=3 (:22); budget default 8 min (:640); `autoRemediate` (:512); repair loop (:661-696); output `_reference/verification.json` (:700). Fidelity at 1440x900, page-001 only (:564-581) |
| `visual-fidelity-analyzer.js` (779 L) | `analyzeFidelity` (:566): 12x8 grid diff (:299, threshold 30); element pairing (:111); typography/color/stacking/geometry mismatches (:186/:205/:223/:244); missing/extra (:674-681); visual regions (:509/:431); `refineTypography` (:721) |
| `visual-diff-classifier.js` (294 L) | `classifyDefects` (:103); DEFECT_KINDS geometry/typography/color/missing-asset/missing-component/stacking (:45) + visual-region (:56); severity (:83); repair action per defect |
| `responsive-analyzer.js` (820 L) | `inferResponsiveRules`, `capturePerViewportEvidence`, `augmentProjectWithResponsive` — reconstruction-time only (wired reconstruction-pipeline.js:16,489); **not used by verification** |
| `repair-planner.js` (242 L) | `planRepairs` (:165); REPAIR_KINDS css-override/token-fix/asset-remap/interaction-rewire/geometry-fix (:43); confidence 0.6 (:52); always skips `missing-component` (:134-135) |
| `repair-executor.js` (287 L) | `executeRepairs` (:146): snapshot -> measure -> apply -> re-measure -> keep-or-rollback (:221); hard stop on first non-improving round (:233-236); `runRepairLoop` (:277) |
| `repair-history.js` (111 L) | JSONL `appendHistory` (:95); snapshot/restore (:27/:66) |

### 2.8 Export / Delivery (Engine 10)

| Module | Responsibility (evidence: audit G §1, §3; B §3) |
|---|---|
| `src/platform/exporter.js` (237 L) | `exportV2Task` (:21; integrity fail-closed :30-37; staging filter :42-51; `verifyStagedTree` :118; docs/INSPECTION.md :59-68; `makeZip` :206); `purgeCredentials` + shred (:197-198); `isSensitiveName` (:92). Hardcodes legacy `artifacts/<id>` (:19) vs org-scoped dir in `makeV2Exporter` (server.js:1224-1230) (G §3.14) |
| `src/platform/export-context.js` (359 L) | context.json contract (pointers-only evidence :125-145; redacted env :109; partialState :155; resumePlan :178; integrity :328). Documented hook at exporter.js:53-54 **never landed** — `writeContextJson` called only by `scripts/test-context-export.mjs` (G §3.3) |
| `github-publish-real.js` (499 L) / `github-publish.js` (266 L) | Mounted `/api/github` (server.js:592), safety-gated REST push / duplicate test-only, `import express` at file bottom (:266) (G §3.6) |
| `static-export.js` (197 L) | netlify/vercel targets + `verifyLinks`; **unmounted** (G §3.4) |
| `version-service.js` | Immutable snapshots/rollback; **unmounted** — documents its own mount at :21-23 but `grep versionsRouter src/platform/server.js` returns nothing (B §3, G §3.5) |

### 2.9 Platform services, storage, DB, distributed (Engine 12)

- DB: `src/database/client.js` (pg pool, advisory-lock migrations :25-62); `task-repository.js`
  (`completeStage` computes `Date.now() - Date.now()` = always 0, :78/:81); `tenant-repository.js` (290 L);
  17 forward-only migrations -> 44 tables (users, sessions, tasks, task_stages, task_events, artifacts, plans,
  organizations, org_members, quota_*, api_keys, audit_events, job_leases, notification_*, compute_*,
  recon_patterns, oauth_*, project_versions, onboarding_profiles, activity_events, ad_*; in-module adds:
  billing_credit_grants, credit_ledger_entries, stripe_customers, workflow_hook*). Audit-cycle probe:
  "PG OK, migrations applied: 17" (H §1-2). **Duplicate prefix 017** (A §3.6).
- Services: `tenant-scope.js`, `org-service.js`, `quota-service.js`+`quota-middleware.js`,
  `api-key-service.js` (SHA-256 hashed keys, scopes, per-key rate limits), `billing-stripe.js` (911 L zero-dollar,
  default-off), `credit-ledger.js` (grant-only), `audit-service.js` (370 L hash chain), `oauth-real.js`
  (Google-only, PKCE S256), `ads-optin.js`, `metrics-registry.js` (248 L), `compute-accounting.js`
  (settlements persist 'unposted' — `setCreditLedger(null)` at server.js) (H §1-3).
- Storage: `artifact-store.js` (74 L write helpers + recursive `redact` :55-76); `artifact-lifecycle.js`
  (612 L per-tenant roots, staged deletion, orphan detection); `artifact-replication.js` (554 L per-replica
  SHA256 manifests, geo-nearest delivery); replication+sweep attached at server.js:107-118 (E §1, H §1).
- Observability: `logger.js` (NDJSON per-job, scrub :29-32); `trace-context.js` (credential-key drop :101-113) +
  `trace-export.js` (W3C traceparent) (C §1, H §1).
- Distributed — wired: `region-registry.js`, `failover.js` (controller started server.js:129-137; re-route
  resolves `job.payload.run`, failover.js:807 — memory-backend-only), `contracts.js`. Test-only, never
  boot-wired: `scheduler.js` (731), `worker-plane.js` (819), `job-leases.js` (387 PG-backed atomic leases),
  `cost-aware-scheduler.js` (780), `src/workers/autoscaler.js`, `scaling-policy.js`,
  `worker-pool-manager.js` (:49-58 spawns real clone-workers but no bootstrap starts it) (A §3.4, C §2, H §3).
- Env/deploy: `src/config-schema.js` (445 L, roles api/worker/migrator, secret redaction; warns
  `PURGE_CREDS_ON_DONE` not default at :275). `package.json`: 7 deps, 62 scripts, **no `engines` field**,
  no `.nvmrc` (H §1). Dockerfile node:24-alpine + chromium self-test; docker-compose.yml (postgres:16 @5433,
  redis:7; worker profile runs `npm install` at container start); docker-compose.prod.yml; k8s/* (H §1, §3).

---

## 3. Missing or disconnected components

Consolidated from all eight audits; each item carries its evidence citation.

**Missing engines / artifacts**

1. **Blueprint engine: MISSING entirely.** `grep -rni "blueprint" src/ bin/` -> 0 matches; no
   blueprint artifact, writer, reader, or schema anywhere (audits A §5, E §3.9, F §3.1).
2. **Intake engine: not a module** — inline in `src/platform/server.js` POST /api/tasks (:350,
   :424-447) and `src/cli.js`; extraction needed if the 12-engine architecture keeps it (audit A §5).
3. **Canonical understanding records missing under their required names** (audit E §1 status
   table): `pages.json` MISSING (page inventory lives only in `manifest.json.pages`),
   `components.json` MISSING (real data is per-page `understanding.json`, written at
   reconstruction not capture; the cross-page pattern registry is built but never persisted —
   component-evidence.js:372-384 vs reconstruction-pipeline.js:442), `interactions.json` MISSING
   (knowledge spread across dom.json triggers, transitions.json, exploration.json, states/*.html
   and re-derived by `deriveInteractionRecords` at reconstruction time), `exploration-coverage.json`
   MISSING (real name `reports/coverage-report.json`), `responsive-layouts.json` MISSING (real:
   `pages/page-001/responsive.json` only — first page hardcoded, exploration-pipeline.js:192-199,
   reconstruction-pipeline.js:483), `screenshots/` not a directory (per-page PNGs + refs in
   graph/states.json only).
4. **Two divergent `design-tokens.json` schemas** under one name: v1 `cloneUrl.js:272` (tokensV2
   browser probe) vs v2 `reconstruction-pipeline.js:322` (`buildTokens`); verify.js HEX stage
   (:454, :518) reads the artifacts one; cross-reading the v1 shape would break it (audit E §3.7).

**Dead / orphaned code**

5. `src/orchestration/pipeline-orchestrator.js` — zero callers, `require("fs")` ESM bug on its
   failure path, wrong v1 export in Stage 5 (audits A §3.1, F §3.8, G §3.13, H §3).
6. Unmounted routers: `static-export.js` (/api/static-export, :184), `activity-routes.js`
   (/api/activity, :108-140), `routes-public-v1.js` (/api/v1, :101-126), `billing-hooks.js`
   (/api/billing-hooks, :149), `onboarding-service.js` router (/api/onboarding, :145-163)
   (audit A §3.2).
7. Orphaned services: `job-diagnostics.js`, `version-service.js` (router implemented but never
   mounted — page 8 has no version API), `template-service.js` — no importers; plus
   `exhaustive-test.js` sitting inside `src/platform/` (audits A §3.2-3.3, B §3, G §3.5).
8. Duplicate GitHub surface: `github-publish.js` (test-only) vs mounted `github-publish-real.js`;
   the former has `import express` at file bottom after usage (:266) (audit G §3.6).
9. `exploration-policy.js` `isSafeInteraction` + `policy.risk`: DEAD in the product path; the real
   gate is the `interactions.js:19` hardcoded `DANGEROUS` regex, which omits
   `pay|purchase|checkout` and adds `order|send|close`; `recordInteractions` never receives a
   policy arg (exploration-pipeline.js:211-214) (audits C §3, D §3.8).
10. Stale UI-era files: `scripts/test-ui-admin.mjs`, `test-ui-dashboard.mjs`,
    `test-ui-onboarding.mjs`, `vite.config-admin.mjs` reference `platform-ui/src/views/*.vue` and
    `platform-ui/dist/admin` paths that never existed in git; `scripts/audit-completeness.mjs:41`
    still lists platform-ui as a product dir; `README-PLATFORM.md` still documents platform-ui as
    live (lines 23, 79-90, 108-145) (audits A §3.5, B §3).
11. `completeStage` duration always 0 (`task-repository.js:78-81`; C §3 cites :78, F §3.8 cites :81).
12. Dead `onProgress` hook (exploration-pipeline.js:33; declared, never called) (audit D §3.11).

**Disconnected wires (where the end-to-end lifecycle breaks)**

13. **Legacy v1 path is still the default**: POST /api/tasks defaults to v1 inline `runTask()`
    when `pipeline` is absent (server.js:439); v2 is opt-in (audits A §3.7, F §1).
14. **User instructions silently dropped in v2**: accepted and stored at intake (server.js:423,
    tasks.js:31,45) but omitted from the queue payload (exploration-runner.js:27/:43), never
    destructured by pipeline-job.js:46, and "verified" by a fake unconditional `ok:true` check
    (verify.js:394-395) (audit F §3.2).
15. **Understanding is write-only for generation**: project-generator.js never reads
    understanding.json; generation re-derives trees from raw dom.json and re-runs analyzeLayout
    per round (reconstruction-pipeline.js:230, :233-235, :326-332) (audits E §3.1, F §3.4).
16. **Browser pool disconnected**: exploration still does per-job `launchBrowser` (pipeline:72);
    `withLease`/warm-context reuse is never reached by product code (audit C §3).
17. **`/ws` blind during v2 exploration**: the pipeline emits zero bus events; fine-grained
    progress reaches clients only as coarse `job:status`; with REDIS_URL the worker is a separate
    process so its bus never reaches the server (no forwarding) (audits D §3.11, B §3).
18. **`/api/jobs/:jobId/artifacts/*` serves files but has no directory listing** (server.js:669) —
    clients cannot discover pages without fetching manifest.json first (audit B §3).
19. **`/api/versions` orphan**: router implemented (version-service.js:21-23 documents its own
    mount), never mounted (audits B §3, G §3.5).
20. **`static-export.js` unmounted** — netlify/vercel delivery unreachable (audit G §3.4).
21. **context.json hook never landed** in `exportV2Task` (export-context.js:22-35 documents the
    exact hook point; grep shows a test-only caller) (audit G §3.3).
22. **No verification gate on export**: `exportV2Task` checks manifest/index/integrity but never
    `verification.json` — failed-verification clones deliver silently (audit G §3.12).
23. **Verification is single-page and non-responsive**: fidelity measured at 1440x900 against
    page-001 only (verify.js:564-581); zero responsive/breakpoint logic in verify.js; pages 2+ of
    a multi-page clone are never visually verified (audit G §3.1-3.2).
24. **Repair-loop gate quirk**: 3.4.5 defect repairs run ONLY when `autoRemediate` returned no
    fixes (verify.js:661-668); the executor hard-stops the whole plan on the first non-improving
    action (repair-executor.js:233-236); `missing-component` is never repaired
    (repair-planner.js:134-135) (audit G §3.9-3.11).
25. **INSPECTION.md omits verification** (exporter.js:59-68 embeds only exploration.md)
    (audit G §3.8).
26. **Org-scope path mismatch in export**: exporter.js:19 hardcodes the legacy root vs
    server.js:1228-1230 org-scoped dir (audit G §3.14).
27. **Session/auth gaps**: no MFA/CAPTCHA pause (grep mfa|captcha|otp -> only cloneUrl.js:336);
    auth verified by one weak signal (password-field probe, pipeline:130-135); no mid-exploration
    re-auth; no post-job session persistence (no `storageState()` anywhere); resume explicitly runs
    WITHOUT session (session-recovery.js:268-273) (audit C §3).
28. **Plaintext credentials in the live BullMQ queue**: `{username,password,cookies,storage}`
    serialized into Redis job data (exploration-runner.js:39 -> clone-queue.js:214), only rolled
    off by removeOnComplete/Fail counts; the DLQ copy is redacted but the live copy is not
    (audit C §3).
29. **Exploration behavior gaps**: no progressive-scroll/lazy-load pass (grep "scroll" in
    exploration-pipeline + exploration/ = 0; `autoScroll` lives only in legacy browser.js:340-358);
    SPA URL events harvested once per page so interaction nodes carry synthetic
    `page.url()+"#"+rec.text` (pipeline:261); routes carry no explored status; graph has no
    components/tokens/uncertainty; no return-to-previous-state (`grep goBack|history.back` = 0)
    (audit D §3.1, 3.4, 3.5, 3.7, 3.10).
30. **Distributed plane built but not boot-wired**: `job-leases.js` never guards real execution
    (duplicate execution prevented only by BullMQ's own lock); `scheduler.js`, `worker-plane.js`,
    `cost-aware-scheduler.js`, `autoscaler.js`, `scaling-policy.js`, `worker-pool-manager.js` are
    imported only by test scripts; failover re-route cannot survive a Redis round-trip
    (`job.payload.run` closure, failover.js:807) (audits A §3.4, H §3).
31. **Node version contract unenforced**: no `engines` field, no `.nvmrc`; the Node 24 assumption
    lives only in the Dockerfile (audit H §3).
32. **Duplicate migration prefix 017** (audit A §3.6).
33. **New-Clone contract gaps**: no `scope` (pages/sections) and no `framework` (output
    preference) fields anywhere on POST /api/tasks; stack is only detected, never requested
    (exploration-policy risk knobs are not a page picker) (audits B §3, F §3.5).
34. **No aggregate intelligence endpoint** — a client must fetch ~10 artifact files individually
    (audit B §3).

---

## 4. Required architecture changes

Work is mapped to the owner's priorities. **P0 = fix the end-to-end lifecycle, make exploration
reliable and observable, establish canonical understanding artifacts, connect blueprint to
reconstruction. P1 = visual/functional reconstruction quality, autonomous repair with regression
tests. P2 = frontend pages alignment, concurrency/distributed validation.** Working infra
(multi-tenancy, billing, regional workers, API keys, integrations) is retained, not rebuilt.
Standing constraints: ONE orchestration pipeline only (`src/queues/pipeline-job.js`); no mandatory
cloud AI (deterministic/local-first preserved, vision provider default "none" — website-understanding.js:610);
every file write stays within the 350-line cap; nothing is pushed or published without owner
authorization.

### 4.1 P0 — End-to-end lifecycle (single pipeline)

- **R-P0.1 Make v2 the only product path.** POST /api/tasks defaults to `pipeline:"v2"` when
  absent (replacing the v1 default at server.js:439); v1 stays available for the CLI flow only
  (`src/cli.js` -> `cloneUrl.js`), documented as CLI-legacy (audit A §5).
- **R-P0.2 Delete the orphaned orchestrator.** Remove
  `src/orchestration/pipeline-orchestrator.js` (zero callers, ESM bug) — no duplicate pipeline is
  revived; stage persistence stays in `task_stages` via the existing worker path (clone-worker.js
  CANONICAL_STAGE map) (audits A §3.1, H §5.2).
- **R-P0.3 Extend the single pipeline with the realigned stages** inside
  `src/queues/pipeline-job.js runPipelineJob`: Exploration (existing :69) -> Understanding
  (canonical-record emission, promoted from reconstruction internals) -> **Blueprint (new stage)**
  -> Reconstruction (existing :89, now blueprint-consuming) -> Verification (existing :102, repair
  stays inside this loop). Intake remains pre-queue validation at POST /api/tasks; Session
  establishment is the first act of exploration; Export remains the owner-triggered post-job route
  (server.js:899). Insertion point per audit F §5.1.
- **R-P0.4 Carry instructions end-to-end.** Destructure `instructions` in
  `exploration-runner.js:27` and include it in the payload (:43); consume it in pipeline-job.js as
  blueprint input; replace the fake check at verify.js:394-395 with a real instruction-echo +
  instruction-conditioned assertion (audit F §5.2).
- **R-P0.5 Intake extraction.** Extract POST /api/tasks validation into `src/intake/`
  (field caps server.js:350, URL guard :437, pipeline validation :435) so the 12-engine
  architecture has a real Intake engine; add `scope` and `framework` request fields (see R-P2.1).
  New module path is NEW (does not exist today) (audits A §5, B §5).
- **R-P0.6 Credential hygiene on the queue.** Apply `redactCredentials` (clone-queue.js:76-84) to
  the LIVE enqueue (:214) and re-supply credentials worker-side from `private/`, or encrypt at
  enqueue; DLQ stays as-is (audit C §5.5).
- **R-P0.7 Wire the browser pool.** `exploration-pipeline.js:72` acquires from a worker
  BrowserPool (`withLease`, markDirty after login/interaction recording) instead of per-job
  `launchBrowser` (audit C §5.2).
- **R-P0.8 Make `PURGE_CREDS_ON_DONE=1` mandatory in production mode** (config-schema.js:275
  warns today; make it an error in production) (audit C §5.6).

### 4.2 P0 — Exploration reliable and observable

- **R-P0.9 Wire the configurable risk policy.** `exploration-pipeline.js:211` + `interactions.js
  recordInteractions` accept and apply `policy.risk` (merge with the hardcoded `DANGEROUS` regex
  at interactions.js:19); delete or wire `isSafeInteraction` (exploration-policy.js:46-61) and
  remove the stale fingerprint (:64-66) (audits C §5.1, D §5).
- **R-P0.10 Progressive scroll + lazy-load pass.** Add a bounded scroll-to-bottom pass with
  screenshots at meaningful positions before DOM extraction in `exploreRoute` (pipeline:149-275),
  porting the legacy `autoScroll` behavior (browser.js:340-358) into the pipeline (audit D §5).
- **R-P0.11 Real interaction URLs + route status.** Harvest SPA events per interaction (or tag
  records with post-click `page.url()`) so interaction nodes carry real resulting URLs instead of
  synthetic `#text` (pipeline:241, :261); add explored/unexplored status to
  `route-discovery.js:191-199` and enumerate unexplored routes in coverage-report.json (:351-360);
  add uncertainty fields from candidate scores (audit D §5).
- **R-P0.12 Timeline to /ws.** Emit pipeline-level events (route:discovered, route:explored,
  state:captured, screenshot) to the bus; mirror logger lines to the bus; forward worker-process
  events on the BullMQ path so /ws works in production mode; extend the whitelist at
  server.js:1087; implement or drop `onProgress` (pipeline:33) (audit D §5).
- **R-P0.13 Session hardening.** Harden login verification (probe URL change / account control /
  protected-route re-fetch; record structured `authVerified` in the manifest :343); add MFA/CAPTCHA
  pause with job status `awaiting_human` plus a take-over route; persist an opt-in post-login
  session snapshot to `private/session-state.json` via `ctx.storageState()` with credential
  scrubbing, shredded by the same purge path (tasks.js:76-81) (audit C §5.3, §5.4, §5.7).

### 4.3 P0 — Canonical understanding artifacts

- **R-P0.14 Emit the missing canonical records** (writers: exploration-pipeline.js +
  reconstruction-pipeline.js, schemas owned by the artifact-contract agent): `pages.json` (from
  manifest.pages), `components.json` (merge per-page understanding.json + PERSIST the pattern
  registry from component-evidence.buildComponentRegistry, not just the summary),
  `interactions.json` (persist interaction records at exploration time; keep derivation as
  fallback), `exploration-coverage.json` (upgrade of coverage-report.json with per-route
  explored status), `responsive-layouts.json` (aggregate per-page responsive.json; remove the
  page-001 hardcodes at exploration-pipeline.js:192 and reconstruction-pipeline.js:483), and a
  `screenshots/` index recording each PNG + its state refs (audit E §5.1).
- **R-P0.15 Unify design-tokens.json** to one schema (recommend the `buildTokens` shape;
  migrate the cloneUrl.js:272 writer; re-point verify.js:454/:518 consumers) (audit E §5.2).
- **R-P0.16 Write understanding.json for every page** even when reconstruction skips the page
  (empty-evidence pages currently get none, reconstruction-pipeline.js:225-227) (audit E §5.7).
- **R-P0.17 Fix the artifact allowlist.** `job-diagnostics.js:23-26` allowlists
  `components.json`/`interaction-records.json` which have no writers, while understanding.json,
  reports/*, graph/*, integrity.json are invisible to listing — replace with the real record set
  (audit E §5.5).
- **R-P0.18 Traceability map.** Extend component records with
  `{elementIndex, understandingId, file, generatedClass:"cx-N", wiring:{dataClonerTrigger,
  data-replay-id, data-stream-target}, verification:{check,passed}}`, emitted after
  generateProject (reconstruction-pipeline.js:372-381) and extended by verify.js stages — the
  chain today exists only implicitly (dom.json elements[i] -> u-{i} -> cx-{i} -> wiring attrs,
  website-understanding.js:407-409 / project-generator.js:101,121,130,135) (audit E §5.4).
- **R-P0.19 Resolve the geometry/styles duplication**: document geometry.json (a slice(0,60)
  duplicate of dom.json, pipeline:185) as a bounded preview and stop loading it as a required
  page artifact (artifact-loader.js:33), or keep it and stop re-deriving layout from dom.json
  (audit E §5.6).

### 4.4 P0 — Blueprint connected to reconstruction

- **R-P0.20 Blueprint stage + artifact.** New builder module (NEW path, e.g. `src/blueprint/`)
  merges per-page understanding models into a site-level blueprint (sections/components/routes/
  tokens/interactions) and persists `artifacts/<job>/blueprint.json`; persisted between
  exploration and reconstruction; threaded into `reconstructFromArtifacts`
  (insertion at pipeline-job.js per audit F §5.1). `blueprint.json` schema is specified in §5.
- **R-P0.21 Generation consumes the blueprint/understanding.** `project-generator.js` (currently
  zero understanding hits) accepts a blueprint arg that can override order, naming, and which
  regions render; gate understanding.json writes (reconstruction-pipeline.js:245) on the
  blueprint being built first; keep the raw-DOM path only as a degraded fallback (audits E §5.3, F §5.3).
- **R-P0.22 Framework preference plumbing.** Add `framework` to task creation (server.js
  TASK_FIELD_LIMITS + tasks.js), pass through queueExploration -> payload -> pipeline-job ->
  reconstruction; implement framework emitters beside project-generator (NEW files) and wire the
  existing `scripts/gen-scaffold.mjs` logic into the engine (today: grep gen-scaffold in src/ =
  0 hits); make exporter.js:172 scaffold README line reflect a real artifact (audit F §5.4).

### 4.5 P1 — Reconstruction/verification quality and autonomous repair

- **R-P1.1 Multi-page + responsive verification.** Loop verification over all manifest.json pages
  (today page-001 only, verify.js:564-568); add a stage-4 responsive comparison using
  `responsive-analyzer.capturePerViewportEvidence` (L75+) over policy viewports; emit
  per-page/per-viewport entries in `_reference/verification.json` (audit G §5).
- **R-P1.2 Repair policy fixes.** Run 3.4.5 defect repairs in every failing round (fix the
  exclusive gate at verify.js:661-668); replace the executor hard stop (repair-executor.js:233-236)
  with per-action quarantine or a configurable stop; add a bounded add-component repair action in
  repair-planner.js (today unconditional skip at :134-135) (audit G §5).
- **R-P1.3 Export hardening.** Insert `writeContextJson` at exporter.js:53-54 (the documented
  hook); add a verification gate to `exportV2Task` (fail or warn-closed on missing/failed
  verification.json); extend INSPECTION.md (:59-68) with the verification summary (passed?,
  stage failures, defect-kind counts, repairLoop stats, limitations); switch `v2TaskDir` (:19) to
  the org-scoped `exportV2Dir` from artifact-lifecycle.js; auto-snapshot a version via
  `version-service.snapshotProject` after successful export (audit G §5).
- **R-P1.4 Mount delivery routers.** Mount `staticExportRouter` and `versionsRouter` in
  src/platform/server.js (one line each) or delete the modules — the spec mounts them (Decision +
  audits B §5.8, G §5).
- **R-P1.5 Determinism + parallel reconstruction.** Parallelize the per-page loop
  (reconstruction-pipeline.js:221-309) with a bounded pool (CSS aggregation stays serial);
  evidence-gated speed (replace unconditional MAX_ROUNDS / --fast with an
  evidence-sufficiency check; wire the polish budget concept polish.js:32-35); pass captured
  `title` into generatePageHtml (raw URL today, :150); fix `completeStage` duration
  (task-repository.js:78-81) (audits F §5.5-5.8, G §5).
- **R-P1.6 UI-side QA surface.** The Comparison & QA page renders verification.json /
  comparison.txt / diff.png / responsive.json (data exists on disk; zero UI consumers today —
  dashboard/app.js has no "verification" references) (audit G §3.7).

### 4.6 P2 — Frontend pages and concurrency/distributed validation

- **R-P2.1 Frontend.** Build the 8-page SPA (`web/`, NEW) per the Decision: restore platform-ui
  logic from commit cdffb15, restyle into 8 routes, mount at `/app` + SPA fallback replacing the
  terminal-404 comment (server.js:271-273); extend POST /api/tasks with `scope` (pages/sections ->
  policy mapping) and `framework`; add one aggregate intelligence endpoint to avoid ~10 fetches;
  add an artifacts directory-listing endpoint; update README-PLATFORM.md (stale platform-ui
  prose) (audits B §5, §6).
- **R-P2.2 Concurrency/distributed validation.** Replace the memory-backend `run`-closure payload
  scheduler/cost-aware-scheduler/worker-plane unless a regional need is demonstrated; validate
  k8s manifests; fix the dev-compose worker `npm install` drift (audit H §5.3-5.5).
- **R-P2.3 Platform hygiene.** Add `"engines": {"node": ">=24"}` + `.nvmrc`; rename the duplicate
  017 migration prefix; delete the duplicate `github-publish.js`; retire stale
  test-ui-*/vite-config files; fix `scripts/audit-completeness.mjs:41` PRODUCT_DIRS; remove
  `exhaustive-test.js` from src/platform/ (audits A §3.5-3.6, G §3.6, H §5.1).
- **R-P2.4 Retained infra guard.** Do NOT rebuild multi-tenancy, billing, regional workers, API
  keys, integrations — regression-protected via existing suites (test:phase40 et al.,
  package.json:40) (audit H §4).

---

## 5. Database and artifact contracts

### 5.1 Database (retained; additive only)

- Storage: PostgreSQL via `src/database/client.js` (pg pool, advisory-lock serialized boot
  migrations :25-62); 17 forward-only migration files in `src/database/migrations/`; live state:
  "migrations applied: 17", 44 tables (audit H §1-2).
- Core tables used by the pipeline: `users`, `sessions`, `tasks`, `task_stages` (stage
  persistence; CANONICAL_STAGE map in clone-worker.js ~:57), `task_events`, `artifacts`,
  `project_versions` (for the versions engine once mounted), `audit_events`, `job_leases`
  (PG-backed atomic leases for the P2 concurrency work), `org_*`/`tenant_denials`/`quota_*`
  (tenancy + quotas), `notification_*`, `compute_*`, `recon_pattern*`, `oauth_*`, `ad_*`
  (audit H §1 table census).
- Credential posture: `task-repository.createTask` persists `options` only — `{pipeline, jobId}` —
  never credentials (task-repository.js:5-13; callers server.js:460-464/:506-510); v1 session
  files live at `platform-data/<id>/private/cookies.json|storage.json` (tasks.js:36-37) with
  `purgeCredentials` (tasks.js:76-97) and exporter shred (exporter.js:44, 88-103, 197-198)
  (audit C §1, §3).
- **No new tables are required by this realignment** for P0/P1 (all new artifacts are files in the
  artifact tree). The MFA pause reuses task/job status values, not a new table — the exact status
  surface (`awaiting_human` on the runner entry + route) is specified by audit C §5.4. Any
  additional DB need discovered during implementation is UNVERIFIED — audit follow-up needed.
- Fix: rename one duplicate `017-*.sql` prefix (017-job-leases.sql vs 017-notification-delivery.sql)
  to a unique prefix before any new migration is added (audit A §3.6).

### 5.2 Artifact tree contract (the product's real data model)

Phase-1 tree written by `src/pipeline/exploration-pipeline.js` via `src/storage/artifact-store.js`
(writeJson/writeBinary/writeText/writeManifest :20-44; recursive redaction :60-74); verified
against a real 12-page job `artifacts/exp-mw2g7mm5r76m` (audits E §1, B §2):

| Path | Writer | Content (observed schema) |
|---|---|---|
| `manifest.json` | exploration-pipeline.js:328-346 | The loader gate (`artifact-loader.js:17-21`); `pages[{pageId,url,route,records,domSampled}]` (:339,346) |
| `pages/{id}/screenshot-viewport.png` | :170 | Viewport capture |
| `pages/{id}/dom.json` | :184 | `{pageId,url,total,sampled,elements,repeated,fixed,sticky,typography}`; element carries `i,tag,role,ariaName,id,dataClonerTrigger,href,src,cls,text,parent,children,rect,layout,style` |
| `pages/{id}/geometry.json` | :185 | Truncated duplicate of dom.json (`elements.slice(0,60)`) — resolve per R-P0.19 |
| `pages/{id}/styles.json` | :188 | `{pageId,typography,bodyStyle,htmlStyle,elements[{i,tag,cls,style}]}` |
| `pages/{id}/responsive.json` | :192-199 | First page only today — generalize per R-P0.14 |
| `pages/{id}/network.json` / `websocket.json` / `application-state.json` | :223/:228/:235 | Redacted captures (schemaVersion/generator/redacted headers) |
| `graph/routes.json` | :303 | `{routes[{url,source,discoveredAt,score,reasons[],seed}],policy}` — no status field today |
| `graph/states.json` | :304 | `{nodes,edges,stats}`; node `{id,url,parentStateId,fingerprint,interaction,viewport,screenshotRef,domRef,domSig,timestamp,status}` |
| `graph/transitions.json` | :305 | Edges `{id,fromStateId,toStateId,trigger,action,expected,actual,success,evidence}` |
| `states/index.json` + `states/{pageId}/{tN,mN}.html` | :306-310, :260 | State snapshots |
| `assets/manifest.json` | :324 | buildAssetManifest + capturedFromNetwork |
| `reports/exploration-summary.json` / `coverage-report.json` / `failures.json` | :347/:351/:361 | Coverage `{routesDiscovered,routesExplored,coveragePct,statesRecorded,budget,efficiency}` |
| `integrity.json` | artifact-lifecycle (:371-376) | Hash manifest |
| `exploration.json` + `exploration.md` | src/interactions.js:855 | `{generatedAt,statesDir,behaviors[{trigger,opens,childPanels,screenshot}]}` |

Reconstruction/verification writes (audits E §1, F §1, G §1): `pages/{id}/understanding.json`
(reconstruction-pipeline.js:245,:446), `design-tokens.json` (:322), `reconstruction-report.json/.md`
(:511-514), generated project (index.html, route pages, `styles/{tokens,layout,components}.css`,
`runtime/interactions.js` + streams/app-state/responsive/workspace augmentations),
`_reference/{verification.json, comparison.txt, diff.png, clone-verify.png}` (verify.js:700,
compare-clone.mjs:140-148), export ZIP with `project/` + `docs/INSPECTION.md` (exporter.js:42-53).

### 5.3 New canonical records introduced by this realignment (NEW; names per audit E §5.1)

All NEW records are written into the existing artifact tree by the existing writers
(exploration-pipeline.js / reconstruction-pipeline.js); schemas are owned by the artifact-contract
agent (Agent 5, §6) and validated by extending `src/reconstruction/artifact-loader.js`:

| Record | Built from | Consumed by |
|---|---|---|
| `pages.json` | manifest.json.pages (exploration-pipeline.js:339,346) | SPA Projects/Intelligence pages; loader |
| `components.json` | per-page understanding.json + `buildComponentRegistry` output (component-evidence.js:372-384, today only summarized into reconstruction-report) | SPA Intelligence/Blueprint; generation input (R-P0.21) |
| `interactions.json` | interaction records persisted at exploration time (deriveInteractionRecords logic, reconstruction-pipeline.js:48-104) | SPA Build page; runtime wiring; verification stage 1 |
| `exploration-coverage.json` | coverage-report.json (:351) + per-route status (route-discovery.js:191-199) | SPA Exploration page; uncertainty display |
| `responsive-layouts.json` | per-page responsive.json aggregated (all pages, not page-001) | QA page; verification stage 4 |
| `screenshots/` index | per-page PNGs + graph states screenshotRefs | SPA Exploration/QA pages |
| `blueprint.json` | components.json + transitions + tokens + instructions echo | **The blueprint engine's artifact**; reconstruction input (R-P0.20/21); SPA Blueprint page |

`blueprint.json` required shape (derived from the audit-observed inputs; final schema is Agent 6's
deliverable, reviewed against this table): `{jobId, sourceTaskId, instructionsEcho,
routes:[{url,title,order}], sections:[{pageId, regionKind (REGION_KINDS vocabulary,
website-understanding.js:46), componentIds[]}], components:[{id, kind, patternId?, confidence,
elementIndex, evidence[]}], tokens: <unified design-tokens shape>, interactions:[record refs],
framework, createdAt}`. Any field beyond this table is UNVERIFIED — audit follow-up needed.

### 5.4 Traceability chain (contract)

`dom.json elements[i]` -> understanding `u-{i}` (elementIndex, website-understanding.js:407-409)
-> generated `class="cx-{i}"` (project-generator.js:101) -> wiring attrs `data-cloner-trigger`
(:121), `data-replay-id` (:130), `data-stream-target` (:135) -> runtime 4-layer matching
(runtimeTemplate.js:169-196) -> verification stage records the linked check. After R-P0.18 the
chain is explicit in `components.json` + `_reference/verification.json`; today it exists only
implicitly and verification stages carry no component references (audit E §3.2).

### 5.5 API contract additions (owned by the orchestration/server agent; routes per audit B §5)

- POST /api/tasks gains optional `scope` and `framework` (server.js TASK_FIELD_LIMITS + tasks.js)
  (audit B §5.2, F §5.4).
- One aggregate intelligence endpoint for page 4 (avoid ~10 per-file fetches) (audit B §5.4).
- Artifacts directory listing alongside `GET /api/jobs/:jobId/artifacts/*` (server.js:669 has no
  listing) (audit B §3).
- `awaiting_human` job status + take-over route for the MFA pause (audit C §5.4).
- Mount `/app` SPA static + fallback; mount `versionsRouter` (/api/versions/:taskId);
  mount `staticExportRouter` (audits B §5, G §5).
- WS whitelist extension for the new timeline events (server.js:1087) (audit D §5).
- Exact route paths for the aggregate/listing/take-over endpoints are UNVERIFIED — audit
  follow-up needed (no audit names them; they must be chosen during implementation, one owner:
  Agent 1).

---

## 6. Parallel agent task assignments
Eight implementation agents, mirroring the eight audit areas. Rule: **ONE owner per shared contract**
(all others consume contracts, never edit the owner's files). Every write stays within the 350-line
cap; nothing is pushed or published.

**Shared contracts and their single owners:** queue payload + pipeline stage/result contract ->
**A1**; platform route surface (all `src/platform/server.js` edits: mounts, v2 default, WS
whitelist, `/app`) -> **A1**; artifact tree schemas + loader validation (`artifact-loader.js`) ->
**A5**; `blueprint.json` schema -> **A6**; `_reference/verification.json` schema -> **A7**; WS
timeline event vocabulary -> **A4** (emitters; whitelist wired into server.js by A1); credential
redaction policy -> **A3** (API change requests implemented in A5-owned `artifact-store.js`);
canonical-record emission (files in exploration-pipeline.js) -> **A4** (writer, to A5's schemas).

- **A1 — Orchestration & server integration (audit A).** R-P0.1 v2 default; R-P0.2 delete
  orchestrator; R-P0.3 pipeline stages incl. blueprint insertion; R-P0.4 instructions carry
  (exploration-runner.js); R-P0.5 extract `src/intake/`; R-P0.6 queue payload redaction;
  R-P0.12 whitelist wiring; R-P2.2 payload contract (clone-queue.js); all §5.5 mounts;
  `docs/ARCHITECTURE.md` G7.1 supersession note. Files: `src/queues/pipeline-job.js`,
  `src/queues/clone-queue.js`, `src/platform/exploration-runner.js`, `src/platform/server.js`,
  `src/intake/**` (NEW), `src/orchestration/**` (delete), `docs/ARCHITECTURE.md`.
- **A2 — Frontend (audit B).** R-P2.1: restore platform-ui logic from commit cdffb15
  (`git show cdffb15:platform-ui/app.js` + index.html + style.css), build `web/` SPA with the 8
  routes, global nav shell, picker integration (`src/picker.js` contract), WS client with catchup,
  export/GitHub flows; README-PLATFORM.md rewrite (B §6.4). Files: `web/**` (NEW),
  `README-PLATFORM.md`. Consumes §5.2-5.3 artifacts, §5.5 APIs, verification schema (A7). No
  backend edits.
- **A3 — Session & auth (audit C).** R-P0.7 pool lease API (consumed by A4's pipeline change);
  R-P0.13 login-verification hardening, `awaiting_human` pause + take-over route module, opt-in
  session snapshot; R-P0.8 production-purge request to A8; redaction API change requests.
  Files: `src/browser.js`, `src/browser/browser-pool.js`, `src/platform/tasks.js`,
  `src/platform/session-pause-routes.js` (NEW, mounted by A1). Depends on A1 (mount + payload), A4
  (pipeline call-sites).
- **A4 — Exploration (audit D).** R-P0.9 risk policy into `recordInteractions`; R-P0.10
  scroll/lazy-load pass; R-P0.11 real URLs + route status + uncertainty; R-P0.12 bus emitters;
  R-P0.14 exploration-time canonical records (pages.json, interactions.json,
  exploration-coverage.json, per-page responsive); pool/policy call-site swap (A3's API);
  graph component/token refs to A5's schema. Files: `src/pipeline/exploration-pipeline.js`,
  `src/exploration/route-discovery.js`, `src/exploration/state-discovery.js`,
  `src/exploration/exploration-policy.js`, `src/interactions.js`, `src/pipeline/asset-capture.js`.
  Depends on A5 (schemas), A3 (APIs), A1 (stage hooks).
- **A5 — Understanding & artifact contracts (audit E).** R-P0.14 schema definitions +
  components.json assembly (registry persistence) + screenshots index; R-P0.15 unified tokens
  schema; R-P0.16 spec (implemented by A6); R-P0.17 job-diagnostics allowlist fix; R-P0.18
  traceability fields; R-P0.19 geometry resolution; extend artifact-loader.js validation to the
  canonical set. Files: `src/reconstruction/website-understanding.js`,
  `src/reconstruction/component-evidence.js`, `src/reconstruction/artifact-loader.js`,
  `src/storage/artifact-store.js`, `src/platform/job-diagnostics.js`. Schema authority; consumed
  by A4/A6/A7.
- **A6 — Blueprint & reconstruction (audit F).** R-P0.20 blueprint builder + blueprint.json
  writer/reader; R-P0.21 generation consumes blueprint/understanding; R-P0.22 framework plumbing +
  emitters + gen-scaffold wiring; R-P1.5 page-parallel loop, evidence-gated speed, title fix;
  R-P0.16 implementation; v1 tokens-writer migration (cloneUrl.js:272). Files: `src/blueprint/**`
  (NEW), `src/reconstruction/reconstruction-pipeline.js`,
  `src/reconstruction/generation/**` (incl. NEW emitters),
  `src/reconstruction/analysis/component-tree-builder.js`,
  `src/reconstruction/analysis/layout-analyzer.js`, `src/cloneUrl.js` (tokens writer only).
  Depends on A5, A1 (stage insertion), A7 (instruction-check contract).
- **A7 — Verification, repair & export (audit G).** R-P1.1 multi-page + responsive stage 4;
  R-P1.2 repair policy fixes; R-P1.3 context.json hook, verification gate, INSPECTION.md summary,
  org-scoped export dir, version snapshot; real instruction check (replacing verify.js:394-395,
  R-P0.4 verification side); delete duplicate `github-publish.js`; prep versions/static-export
  routers for A1's mounts. Files: `src/platform/verify.js`,
  `src/reconstruction/visual-fidelity-analyzer.js`, `src/reconstruction/visual-diff-classifier.js`,
  `src/reconstruction/responsive-analyzer.js`, `src/reconstruction/repair-planner.js`,
  `src/reconstruction/repair-executor.js`, `src/reconstruction/repair-history.js`,
  `src/platform/exporter.js`, `src/platform/export-context.js`, `src/platform/version-service.js`,
  `src/platform/static-export.js`, `src/platform/github-publish.js` (delete). Depends on A5, A6
  (blueprint.echo), A1 (mounts).
- **A8 — Infra & platform services (audit H).** R-P2.3 engines + `.nvmrc`, 017 prefix, stale-file
  retirement, audit-completeness PRODUCT_DIRS, exhaustive-test removal; R-P2.2 distributed
  validation (job-leases acquire in clone-worker; cut decision for scheduler/worker-plane/
  cost-aware-scheduler; failover dispatcher update); dev-compose worker fix; PURGE_CREDS_ON_DONE
  production enforcement in config-schema (A3's request); `completeStage` fix
  (task-repository.js:78-81); k8s validation. Files: `package.json`, `.nvmrc` (NEW),
  `src/config-schema.js`, `src/database/client.js`, `src/database/task-repository.js`,
  `src/database/migrations/**` (017 rename), `docker-compose.yml`, `docker-compose.prod.yml`,
  `k8s/**`, `src/distributed/job-leases.js`, `src/distributed/failover.js`,
  `src/distributed/scheduler.js`, `src/distributed/cost-aware-scheduler.js`,
  `src/distributed/worker-plane.js`, `src/workers/clone-worker.js` (lease acquire +
  payload-contract consumption only), `src/workers/autoscaler.js`, `src/workers/scaling-policy.js`,
  `src/workers/worker-pool-manager.js`, `src/platform/compute-accounting.js`,
  `scripts/audit-completeness.mjs`, `scripts/test-ui-admin.mjs`, `scripts/test-ui-dashboard.mjs`,
  `scripts/test-ui-onboarding.mjs`, `vite.config-admin.mjs`, `src/platform/exhaustive-test.js`
  (remove). Depends on A1 (payload contract shape).

**Zero-overlap check:** every listed file belongs to exactly one agent. Cross-agent needs go
through the contract table above, not shared file edits.

### 6.1 Dependency ordering

1. **A1** first (payload contract + stage registry + v2 default); **A8**'s engines/migration fix in
   parallel. 2. **A5** second (schema authority) — A4/A6/A7 implement to its schemas. 3. **A3 + A4**
   parallel after 1+5 (pool/policy wiring; exploration reliability + record emission). 4. **A6**
   after 1+5(+4). 5. **A7** after 5+6. 6. **A2** after 1+5+6+7 (frontend consumes all contracts).
   7. **A8** distributed validation after A1's payload contract (P2 window).

---

## 7. File ownership and dependency mapping

Exclusive modification rights (zero overlaps). Files not listed are read-only for all agents.

| Agent | May modify (exclusive) |
|---|---|
| A1 Orchestration | `src/queues/pipeline-job.js`; `src/queues/clone-queue.js`; `src/platform/exploration-runner.js`; `src/platform/server.js`; `src/intake/**` (NEW); `src/orchestration/**` (delete); `docs/ARCHITECTURE.md` |
| A2 Frontend | `web/**` (NEW); `README-PLATFORM.md` |
| A3 Session | `src/browser.js`; `src/browser/browser-pool.js`; `src/platform/tasks.js`; `src/platform/session-pause-routes.js` (NEW) |
| A4 Exploration | `src/pipeline/exploration-pipeline.js`; `src/exploration/route-discovery.js`; `src/exploration/state-discovery.js`; `src/exploration/exploration-policy.js`; `src/interactions.js`; `src/pipeline/asset-capture.js` |
| A5 Understanding | `src/reconstruction/website-understanding.js`; `src/reconstruction/component-evidence.js`; `src/reconstruction/artifact-loader.js`; `src/storage/artifact-store.js`; `src/platform/job-diagnostics.js` |
| A6 Blueprint/Reconstruction | `src/blueprint/**` (NEW); `src/reconstruction/reconstruction-pipeline.js`; `src/reconstruction/generation/**` (incl. NEW emitters); `src/reconstruction/analysis/component-tree-builder.js`; `src/reconstruction/analysis/layout-analyzer.js`; `src/cloneUrl.js` (tokens writer only) |
| A7 Verify/Repair/Export | `src/platform/verify.js`; `src/reconstruction/visual-fidelity-analyzer.js`; `src/reconstruction/visual-diff-classifier.js`; `src/reconstruction/responsive-analyzer.js`; `src/reconstruction/repair-planner.js`; `src/reconstruction/repair-executor.js`; `src/reconstruction/repair-history.js`; `src/platform/exporter.js`; `src/platform/export-context.js`; `src/platform/version-service.js`; `src/platform/static-export.js`; `src/platform/github-publish.js` (delete) |
| A8 Infra | `package.json`; `.nvmrc` (NEW); `src/config-schema.js`; `src/database/client.js`; `src/database/task-repository.js`; `src/database/migrations/**` (017 rename); `docker-compose.yml`; `docker-compose.prod.yml`; `k8s/**`; `src/distributed/job-leases.js`; `src/distributed/failover.js`; `src/distributed/scheduler.js`; `src/distributed/cost-aware-scheduler.js`; `src/distributed/worker-plane.js`; `src/workers/clone-worker.js`; `src/workers/autoscaler.js`; `src/workers/scaling-policy.js`; `src/workers/worker-pool-manager.js`; `src/platform/compute-accounting.js`; `scripts/audit-completeness.mjs`; `scripts/test-ui-admin.mjs`; `scripts/test-ui-dashboard.mjs`; `scripts/test-ui-onboarding.mjs`; `vite.config-admin.mjs`; `src/platform/exhaustive-test.js` (remove) |

Untouched-by-design (retained, read-only): `src/auth/**`, `src/platform/{org-routes,org-service,
tenant-scope,quota-service,quota-middleware,api-key-service,billing-stripe,credit-ledger,
oauth-real,audit-service,metrics-registry,health-routes,notification-delivery,email-real,
workflow-hooks,ui-config-routes,dashboard-routes,admin-routes,session-recovery,routes-capacity,
intelligence/**}.js`, `src/database/tenant-repository.js`, `src/storage/{artifact-lifecycle,
artifact-replication}.js`, `src/observability/**`, `src/monetization/**`, `src/runtimeTemplate.js`,
`src/assets.js`, `src/vision.js`, `src/prompts.js`, `src/events.js`, `src/picker.js`,
`src/security/request-guard.js`, `src/platform/sessions.js` (durable store is a future need,
single-process acceptable today — audit A §5; any change here is UNVERIFIED — audit follow-up
needed), `dashboard/**` (legacy operator console), `Dockerfile`, `bin/**`.

New test scripts (each owner adds their own, named `scripts/test-<area>-realignment.mjs`) are
new files and therefore collision-free; npm script registration goes through A8 (package.json
owner).

Dependency graph (must-resolve-before):

```
A1 payload/stage contract ──> A4 stage hooks, A6 blueprint stage, A8 lease/queue consumption
A5 schemas ──> A4 record emission, A6 generation input, A7 verification refs
A3 pool/lease API ──> A4 call-site swap
A6 blueprint.json ──> A7 instruction check + export gate, A2 blueprint page
A7 verification.json schema ──> A2 QA page
A1 route surface (/app, versions, static-export, aggregates) ──> A2 all pages
A8 env/migrations ──> all gates
```

---

## 8. End-to-end acceptance tests

The user journey: **provide URL -> explore -> see intelligence -> review blueprint -> reconstruct
-> compare -> receive working project.** Commands use real npm scripts from `package.json`
(where they exist) and the platform API. All run offline against local fixtures.

### 8.1 Journey script (local, no cloud)

Setup (compose dev stack: postgres 16 @5433, redis 7 @6379 per docker-compose.yml; exact service
names UNVERIFIED — audit follow-up needed, use `docker compose config --services` first):

```
node src/config-schema.js api                     # env contract clean (audit H §6)
docker compose up -d                              # postgres + redis (audit H §1)
npm run platform &                                # bin/platform.js -> :4180
node scripts/serve-fixture.mjs &                  # local fixture origin (audit B §6.5)
node scripts/fixtures/lazy-scroll.mjs &           # lazy-load fixture (audit D, §1)
curl -sf localhost:4180/healthz                   # must return healthy
```

J1 Intake+Session (fix R-P0.1/5/13):
```
curl -s -X POST localhost:4180/api/auth/register -H 'content-type: application/json' \
  -d '{"email":"a@b.c","password":"test1234"}'          # 200, session cookie
curl -s -X POST localhost:4180/api/tasks -H 'content-type: application/json' -b cookies.txt \
  -d '{"url":"http://127.0.0.1:<fixture-port>/","pipeline":"v2","instructions":"make the header sticky","framework":"static"}'
# 202-style enqueue; task appears in GET /api/tasks; instructions NOT dropped (R-P0.4)
```

J2 Exploration observable (R-P0.9..12):
- WS client joins `{type:"join",task}` and receives catchup + timeline events
  (`route:discovered`, `route:explored`, `state:captured`) during the run — today only coarse
  `job:status` arrives (audit D §3.11). Works on BOTH memory and BullMQ backends
  (BullMQ: `npm run worker` with REDIS_URL, package.json:13).
- Lazy-load fixture: images/entries appear in `pages/<id>/dom.json` without a click
  (R-P0.10; fixture per audit D §6).
- Risk policy: a custom `forbiddenText` in the intake policy demonstrably blocks a marked
  trigger (R-P0.9; test design per audit D §6).

J3 Intelligence (R-P0.14/17):
```
curl -s localhost:4180/api/jobs/<jobId>/artifacts/manifest.json -b cookies.txt
curl -s localhost:4180/api/jobs/<jobId>/artifacts/graph/routes.json -b cookies.txt   # routes WITH explored status
curl -s localhost:4180/api/jobs/<jobId>/artifacts/blueprint.json -b cookies.txt      # NEW artifact exists
curl -s localhost:4180/api/jobs/<jobId>/artifacts/design-tokens.json -b cookies.txt  # ONE schema (buildTokens shape)
```

J4 Blueprint review (R-P0.20): `blueprint.json` parses, echoes `instructions` ("make the header
sticky"), lists routes/sections/components; SPA `/projects/:id/blueprint` renders it.

J5 Reconstruction (R-P0.21/22, R-P1.5):
```
node -e "const r=require('./artifacts/<jobId>-project/reconstruction-report.json'); console.log(r.blueprint, r.rounds, r.generatedFiles)"
# report references blueprint.json; generation consumed it (no re-derive-only path)
grep -c "sticky" artifacts/<jobId>-project/styles/*.css artifacts/<jobId>-project/runtime/*.js
# instruction effect present somewhere in the output (audit F §6)
node scripts/check-runtime-records.mjs artifacts/<jobId>-project/runtime/interactions.js
# record count matches exploration.json behaviors (audit F §6)
```

J6 Compare (R-P1.1/1.2):
```
curl -s "localhost:4180/preview/<taskId>/_reference/verification.json" -b cookies.txt
# per-page (>=2 pages) + per-viewport entries; defect kinds classified; repairLoop stats present
```

J7 Export (R-P1.3/1.4, R-P0.2):
```
curl -s -X POST localhost:4180/api/export/<taskId> -b cookies.txt
curl -s -o export.zip localhost:4180/api/export/<taskId>/download -b cookies.txt
unzip -l export.zip   # lists project/index.html, docs/INSPECTION.md (with verification summary), context.json; NO private/ member
curl -sf localhost:4180/api/versions/<taskId> -b cookies.txt   # >= 1 version row post-export
```

### 8.2 Regression suites (must stay green; real npm scripts, package.json:10-72)

| Gate | Command | Baseline (from audits) |
|---|---|---|
| Exploration efficiency | `npm run test:exploration-efficiency` | 32/32 in 31.6s (audit D §2) |
| Website coverage | `npm run test:coverage` | not run by audits (browser-based); must pass post-change |
| Understanding | `npm run test:reconstruction` (incl. test-website-understanding.mjs) | 79/79 (audit E §2) |
| Visual fidelity + repair | `npm run test:visual-fidelity` | fidelity 35/35 run (G §2); repair 30/30 prior-run artifact (G §1) |
| Platform API | `npm run test:platform` | existing; extended to assert 8 SPA routes + `/api/versions/:taskId` JSON (audit B §6.2) |
| Browser pool | `npm run test:browser-pool` | 58/58 (audit C §2) |
| Tenancy | `npm run test:tenant-isolation` | 56/56 (audit H §2) |
| Platform infra | `npm run test:phase40` | 12 suites green (commit cd0d00e; H §6) |
| Context export | `npm run test:context-export` | exists; passes once the exporter hook lands (G §6.4) |
| Full sweep | `npm run test:grand-final` | phase40+phase42+phase45 (package.json:72) |

### 8.3 Static gates (commands from the audits)

```
grep -rni "blueprint" src/ | wc -l                  # > 0 (writer+reader exist)   [audit F §6]
git grep -n "platform-ui" README-PLATFORM.md        # empty                        [audit B §6.4]
ls src/database/migrations/*.sql | sed 's/-.*//' | sort | uniq -d   # empty        [audit A §6]
node -e "console.log(require('./package.json').engines)"           # node >=24     [audit H §6]
grep -rn "executePipeline" src/ scripts/ bin/       # no call sites (file deleted) [audit A §6]
grep -rn "isSafeInteraction" src/interactions.js    # a call site exists           [audit C §6]
grep -n "launchBrowser" src/pipeline/exploration-pipeline.js   # no per-job launch [audit C §6]
curl -s localhost:4180/app/projects | grep -qi '<div id="root"'    # SPA mounted   [audit B §6.1]
```

### 8.4 Per-page SPA proof (audit B §6.5)

One screenshot per SPA page captured against the local fixture (`scripts/serve-fixture.mjs`,
offline) showing non-empty content: `/projects`, `/projects/new`, `/projects/:id/exploration`,
`/projects/:id/intelligence`, `/projects/:id/blueprint`, `/projects/:id/build`,
`/projects/:id/qa`, `/projects/:id/final`.

---

## 9. Execution order and integration gates

Gates are hard: the named command(s) must be green before the next stage starts. Baselines are
the audit-executed results recorded in §8.2.

| Stage | Owners | Work | Integration gate (must pass before next stage) |
|---|---|---|---|
| **G0 Baseline** | all | Record green baselines on HEAD before any change | `npm run test:exploration-efficiency` (32/32); `npm run test:reconstruction` (79/79); `npm run test:visual-fidelity` (35/35); `npm run test:browser-pool` (58/58); `npm run test:tenant-isolation` (56/56); `node src/config-schema.js api` clean — all already demonstrated by the audits (§8.2) |
| **G1 Contract** | A1, A8 | v2 default; payload purity; pipeline stage registry; delete orchestrator; engines+`.nvmrc`; 017 prefix; `completeStage` fix | `node --check` on all touched entries (per audit A §6); `npm run test:worker-queue`; `npm run test:tenant-isolation` 56/56; `grep -rn executePipeline src/ scripts/ bin/` -> no call sites; migration prefix dup check empty (§8.3) |
| **G2 P0 exploration + artifacts** | A4, A5 (+A3 pool/policy APIs) | Scroll/lazy pass; risk policy; real URLs; route status; bus events; canonical records; tokens unification; allowlist fix; pool wiring; queue redaction; login hardening + awaiting_human | `npm run test:exploration-efficiency` 32/32; `npm run test:coverage` exit 0; `npm run test:browser-pool` 58/58; new realignment suites green (risk-block, lazy-fixture, WS timeline on both backends, awaiting-human pause — test designs per audits D §6, C §6); artifact census: canonical set present in a fixture job (audit E §6) |
| **G3 Blueprint -> reconstruction** | A6 (+A7 check contract) | blueprint.json stage; generation consumes it; instructions carried; framework plumbing; page-parallel loop; understanding for every page | `npm run test:reconstruction` 79/79; J3-J5 journey probes pass (blueprint.json echoes instructions; reconstruction-report references blueprint; instruction effect in output — audit F §6); `node --check` clean |
| **G4 P1 verify/repair/export** | A7 | Multi-page + responsive stage 4; repair policy; context.json hook; verification gate; INSPECTION.md; export dir scoping; version snapshot; mounts prep (versions/static-export routers handed to A1) | `npm run test:visual-fidelity` 35/35 + repair 30/30; `npm run test:context-export` green; 2-page/3-viewport fixture yields per-page per-viewport verification entries (audit G §6.3); J6-J7 pass; A1 mounts versions/static-export and `curl localhost:4180/api/versions/<taskId>` returns JSON (audit B §6.2) |
| **G5 P2 frontend** | A2 (+A1 mounts) | 8-page SPA at /app; README rewrite; aggregate + listing endpoints live | `npm run test:platform` green with 8-route + versions assertions (audit B §6.2); `curl -s localhost:4180/app/projects` serves the SPA root (§8.3); per-page screenshots non-empty (§8.4); `git grep platform-ui README-PLATFORM.md` empty |
| **G6 P2 concurrency + final** | A8 (+A1) | job-leases wiring (or cut decision recorded); failover BullMQ path; k8s validation; compose fix | `npm run test:phase42`; `npm run test:phase45`; BullMQ e2e: job reaches completed with task_stages rows (audit H §6); `npm run test:grand-final` fully green; final full-journey run J1-J7 recorded with logs |

Rollback rule: any gate failure reverts the offending agent's changes only (exclusive file
ownership makes this safe); the pipeline contract (A1) never carries another agent's
in-progress edits.

---

## 10. Evidence-based completion assessment

### 10.1 Current real state (per audit, evidence actually executed during the audit cycle)

| Area | State | Evidence actually run |
|---|---|---|
| Architecture (A) | Boot wiring real (20+ routers, mount order, error middleware); one shared pipeline; two live write-paths (v1 default) + one dead orchestrator | `node --check` on bin/platform.js, server.js, clone-queue.js, clone-worker.js, dashboard/app.js -> all OK; full route census grep (audit A §2, §3) |
| Frontend (B) | No product UI at all; platform server headless; platform-ui restorable from cdffb15; API+WS layer complete enough to drive all 8 pages | artifact-tree inspection of `artifacts/bench-documentation-mvwxrhct` (manifest, graph, states, assets, pages, reports, _reference) (audit B §2) |
| Session/auth (C) | Launch/pool/cookies/redaction solid; login fill unverified against live target; pool disconnected; no MFA pause; plaintext queue payloads | `timeout 100 node scripts/test-browser-pool.mjs` -> PASS 58/58 (audit C §2) |
| Exploration (D) | Dedupe/interactions/graph solid; scroll/lazy pass missing; zero bus events from pipeline; risk policy dead | `timeout 60 node scripts/test-exploration-efficiency.mjs` -> 32 passed, 0 failed, 31.6s, exit 0; `test-website-coverage.mjs` read but NOT run (audit D header) |
| Understanding (E) | Engine deterministic and green; canonical records missing under required names; understanding write-only; no traceability artifact | `node scripts/test-website-understanding.mjs` -> 79 passed, 0 failed, exit 0; `node -e` schema probes on artifacts/exp-mw2g7mm5r76m (audit E §2) |
| Blueprint/reconstruction (F) | Generation works on real data (7 files, rounds:1); blueprint absent; instructions dropped; serial loop | `node -e` on reconstruction-report.json + understanding.json; `node scripts/check-runtime-records.mjs`; `grep -rni blueprint` -> 0; `node --check` on 9 files (audit F §2, evidence section) |
| Verify/repair/export (G) | Fidelity/classifier proven; repair loop bounded; export integrity fail-closed; but single-page/no-responsive verify, no export gate, unmounted delivery routers | `node scripts/test-visual-fidelity.mjs` -> 35/35 (live Chromium); `node --check` on 16 files; repair 30/30 read from prior-run artifact, NOT re-run (audit G header, §2) |
| Infra/platform (H) | PG 17 migrations/44 tables live; tenancy green; queue/worker seam real; distributed plane unbootstrapped; no engines field | pg.Pool probe -> "PG OK, migrations applied: 17"; `node scripts/test-tenant-isolation.mjs` -> 56/56; grep wiring checks (audit H §2, §6) |

Not executed by anyone (stays open until G0/G6): `test-website-coverage.mjs` (audit D),
`test-autonomous-repair.mjs` fresh run (audit G), the phase42/phase45 suites (audit H),
live-target login flows (audit C guardrails).

### 10.2 Evidence required per Definition-of-Done step

Every DoD claim must carry ALL of:

1. **Actual execution evidence** — the exact command, exit code, and pass/fail counts (e.g.
   "32/32, exit 0"), captured from a run in the repo, not paraphrased. Suite commands are those
   in §8.2; static gates are those in §8.3.
2. **Reproduction steps** — environment (compose up, fixture server, REDIS_URL set/unset for the
   backend under test), fixture used (`scripts/serve-fixture.mjs`,
   `scripts/fixtures/lazy-scroll.mjs`), and the seed URL/job id.
3. **Logs** — `artifacts/<jobId>/logs/job.log` NDJSON (logger.js:33-37) showing the stage
   sequence with redaction intact; `task_stages` rows for exploration/reconstruction/verification
   (clone-worker.js CANONICAL_STAGE map); WS capture of the timeline events for the observable-
   exploration claim (both backends).
4. **Root-cause analysis** — for every bug fixed (§3 items), the audit citation (e.g.
   "instructions dropped: exploration-runner.js:27/:43, audit F §3.2"), the fix commit, and the
   failing-before/passing-after pair.
5. **Verified fixes** — each §3/§4 fix demonstrated by a regression test that fails without the
   fix (new realignment suites) and passes with it; no fix is "done" on code-read alone.
6. **Independent regression testing** — after each gate, the full §8.2 table re-run by an agent
   other than the fix owner; `npm run test:grand-final` green at G6; byte-identity check for
   untouched v1 behavior (unchanged v1 run produces identical `index.html` — audit F §6).

**Completion assessment rule:** an area is DONE only when its audit's §6 "completion evidence"
list is satisfied with executed commands (audits A-D, E, F, G, H each define their own evidence
list — cross-referenced in §8 and §9 above), and the whole product is DONE only when the J1-J7
journey passes end-to-end on both queue backends with logs attached. Anything less is reported
as partial, with the missing evidence named.
