# Phase 1 — Architecture audit (Agent A deliverable)

Auditor: architecture-audit subagent, 2026-10-31. Repo: `D:\project 2\cloner`, branch `master`.
Method: full read of every module listed in the ask, static import graph, targeted greps, and four
runtime probe runs (probe1: captureResponsive; probe2: queue deadlock; run2/run3: artifacts-endpoint
escape — each named inline below with its exact command). Nothing in this document is
asserted from memory — every claim cites `path:line` or a command run during this audit.

**Verification baseline (run during this audit):**
- `node scripts/test-exploration.mjs` → `16 passed, 0 failed — pipeline took 7.6s` (matches the 16/16 claim in the handoff).
- `for f in $(find src -name "*.js"); do node --check "$f"; done` → `ALL CHECKED` (every module parses).

---

## 1. Current module graph

Edges below are the **static** import edges (grep `^import` across `src/**`). Three edges are
**hidden** by dynamic `import()` in the pipeline (see F1.4) and are listed with a ⚡.

### 1.1 Phase-1 intelligence engine (new)

| Module | Imports (deps) | Imported by | Role |
|---|---|---|---|
| `src/pipeline/exploration-pipeline.js` | browser.js, exploration/{exploration-policy,route-discovery,state-discovery}.js, intelligence/dom-extractor.js, assets/asset-manifest.js, storage/artifact-store.js, observability/logger.js ⚡events.js ⚡network/network-recorder.js ⚡interactions.js | platform/exploration-runner.js:5, scripts/test-exploration.mjs:6 | Orchestrator: auth → routes → per-page capture → DOM intel → states → graph → assets → manifest |
| `src/exploration/exploration-policy.js` | — (leaf) | pipeline:8 | Budgets, viewports, risk rules (`isSafeInteraction` — dead, F2.2) |
| `src/exploration/route-discovery.js` | observability/logger.js | pipeline:9 | Static links + SPA pushState/hash recorder |
| `src/exploration/state-discovery.js` | node:crypto (leaf) | pipeline:10 | State graph, fingerprints, `DOM_SIGNATURE_SCRIPT` |
| `src/intelligence/dom-extractor.js` | — (leaf) | pipeline:11 | `DOM_EXTRACTOR_SCRIPT` + `analyzeTypography` |
| `src/network/network-recorder.js` | — (leaf) | pipeline:56 (dynamic) | request/response ring buffer |
| `src/assets/asset-manifest.js` | node fs/path/crypto | pipeline:12 | manifest builder, `classifyResource`, `captureResponsive` (broken, F5.1) |
| `src/storage/artifact-store.js` | node fs/path | pipeline:13 | §15 tree writer + `redact()` |
| `src/observability/logger.js` | node fs/path | pipeline:14, exploration/route-discovery.js:4 | NDJSON logger + metrics |

### 1.2 Legacy engine (the "proven" clone engine, unchanged this phase)

| Module | Imports | Imported by |
|---|---|---|
| `src/browser.js` | events.js | cloneUrl.js:5, pipeline:7, platform/sessions.js:6, platform/server.js:13, platform/exhaustive-test.js:6, scripts/test-xclose.mjs |
| `src/interactions.js` | events.js | browser.js:229 (dynamic), pipeline:147 (dynamic) |
| `src/cloneUrl.js` | events.js, browser.js, assets.js, polish.js, runtimeTemplate.js | platform/server.js:12, src/cli.js:8 |
| `src/assets.js` | events.js | cloneUrl.js:6 |
| `src/polish.js` | events.js, browser.js, vision.js, prompts.js | cloneUrl.js:7 |
| `src/runtimeTemplate.js` | — | cloneUrl.js:8 |
| `src/cloneImage.js` / `src/cloneVideo.js` | events.js, vision.js, prompts.js | cli.js:9-10 |
| `src/config.js`, `src/events.js`, `src/prompts.js`, `src/vision.js`, `src/picker.js` | leaves | everywhere |

### 1.3 Platform shell

| Module | Imports | Imported by |
|---|---|---|
| `src/platform/server.js` | events.js, config.js, cloneUrl.js, browser.js, ./exploration-runner, ./tasks, ./sessions, ./exporter, ./verify ⚡./model-router ⚡../prompts.js | bin/platform.js:3, scripts/test-platform.mjs |
| `src/platform/exploration-runner.js` | pipeline/exploration-pipeline.js | platform/server.js:14 |
| `src/platform/tasks.js`, `sessions.js`, `exporter.js`, `verify.js`, `model-router.js`, `exhaustive-test.js` | browser.js (sessions, exhaustive-test) | server.js / internal |

Two HTTP servers coexist: `src/server.js` (legacy UI server, started by `src/cli.js:7`) and
`src/platform/server.js` (started by `bin/platform.js`). They are separate processes/ports; not a
coupling problem, but the graph is easy to misread because both are named "server".

**Status: DONE-OK** (complete static map above). *Caveat:* the map is only fully reconstructible
because I grepped for dynamic imports too — see F1.4.

---

## 2. Execution lifecycle — platform task vs exploration job

Two parallel, asymmetric subsystems share one process, one event bus, and no auth:

**Clone task** (`POST /api/tasks`, platform/server.js:33-42):
1. `tasks.createTask` persists `platform-data/<id>/task.json` (tasks.js:17-41) — status machine
   `queued → running → verifying → done` **on disk**, survives restart, has a 15-day retention
   sweep (tasks.js:96-107).
2. Fire-and-forget `runTask(id)` (server.js:187-211) calls engine `cloneUrl(...)`.
3. Cookies live in `platform-data/<id>/private/cookies.json`, shredded on export (exporter.js:112)
   and optionally at done/error (`PURGE_CREDS_ON_DONE`, tasks.js:63-72).

**Exploration job** (`POST /api/jobs/explore`, server.js:46-51):
1. `queueExploration` (exploration-runner.js:14-74) keeps the registry **in module-level Maps only**
   (exploration-runner.js:8-12) — nothing is persisted. After a platform restart every job id
   404s even though `artifacts/<jobId>/` is still on disk. Status: **WEAK** (asymmetric with
   tasks; artifacts become unreachable through the API).
2. Bounded queue, `MAX_EXPLORATION_JOBS` (default 2) — but the governor is broken, see F5.2.
3. Job id is minted in the pipeline (`exp-…`, pipeline.js:16-18); the HTTP response returns the
   temp handle `pending-…` (server.js:50); alias rekey happens via `aliases` Map
   (exploration-runner.js:55, 81-87). The exported `rekeyJob` (exploration-runner.js:76-79) has
   **zero callers** (grep: only its definition) — dead API, status **DONE-OK** as a finding.
4. Artifacts land in `artifacts/<jobId>/` per §15 — see §4 below for where the contract holds
   and where it silently doesn't.

**Status of lifecycle section: DONE-OK** (both flows traced end-to-end above with line evidence).

---

## 3. Findings

### F1. Tightly coupled modules — **DONE-OK**

1. **Global event bus is an unscoped broadcast.** `src/events.js:27` exports one process-wide
   singleton. Two consumers couple to *everything* on it:
   - The pipeline subscribes to `['step','log']` for **every job** (pipeline.js:36) and never
     unsubscribes. With N concurrent jobs, each job's `job.log` receives the engine events of all
     other jobs and of all clone tasks; and every job leaks 2 listeners on the shared bus — after
     ~50 jobs the bus's `setMaxListeners(100)` (events.js:7) starts warning. No `bus.off` anywhere
     in `src/pipeline/` (grep confirms).
   - `platform/server.js:174-183` tags **all** bus events with a single `currentTaskId` (server.js:184,
     set in `runTask` at server.js:190), so with two concurrent clone tasks each WS event is
     attributed to whichever task started last.
2. **The pipeline is a god-orchestrator.** `runExplorationJob` (pipeline.js:24-211) does auth
   detection, login submission, route seeding, per-page capture, screenshots, DOM intel writes,
   network flushing, graph building, responsive capture, manifest and reports — ~190 lines with
   direct knowledge of every artifact filename (`pages/.../dom.json`, `geometry.json`,
   `styles.json`, `network.json`, `graph/*.json`, `reports/*.json`). Any §15 layout change edits
   one 190-line function.
3. **The artifact-store abstraction leaks.** The pipeline passes the raw `store.dirs.root` string
   to `recordInteractions` (pipeline.js:150) and `captureResponsive` (pipeline.js:142), both of
   which do their own `fs` writes *around* the store (interactions.js:707-741 writes
   `exploration.json`/`exploration.md`/`_reference/states/*.png` at the job root; asset-manifest.js:55-75
   writes `_reference/responsive/`). The store's `writeJson/writeBinary` path discipline
   (artifact-store.js:22-39) is bypassed exactly where state evidence is written — which is why
   it lands outside the §15 tree (see §4).
4. **Dynamic imports hide real dependencies.** pipeline.js:28 (`events.js`), :56
   (`network-recorder.js`), :147 (`interactions.js`) and browser.js:229 (`interactions.js`) are
   plain runtime deps expressed as dynamic imports — there is no cycle to break
   (`events.js` imports nothing; `interactions.js` imports only `events.js`). Status: the
   edge-omission made the naive import graph wrong; flagged **WEAK** as a hygiene issue.

### F2. Duplicated logic — **DONE-OK**

1. **State fingerprint exists in three variants, two dead:**
   - `src/exploration/state-discovery.js:11-13` — `sha1(url::domSig).hex.slice(0,16)` — the one actually used by `addState`.
   - `src/pipeline/exploration-pipeline.js:20-22` — `domSigFingerprint`, byte-identical logic, **zero callers** (grep: only its definition).
   - `src/exploration/exploration-policy.js:63-65` — `stateFingerprint`, raw `url::sig` string (no hash), **zero callers**.
   Answer to the ask's question: yes — and worse than two places: two of the three are dead code
   that will drift.
2. **Risk filter duplicated with divergent regexes.** `src/exploration/exploration-policy.js:22`
   `forbiddenText` vs `src/interactions.js:19` `DANGEROUS` — they disagree: the policy has
   `pay|purchase|checkout|cancel order`; the engine has `order|close|send|cancel`. Critically,
   **`isSafeInteraction` (exploration-policy.js:45-60) has zero callers** (grep) — the pipeline
   never applies it; runtime safety is enforced solely by the legacy engine regex inside
   `interactions.js`. The "risk-aware policy" module is currently decorative.
3. **Two network recorders.** `browser.js:109-126 attachSniffer` (content-type interest filter,
   used by the clone engine) and `network/network-recorder.js:3-46` (ring buffer with method/status
   size/timing). Different shapes, same job, both alive.
4. **Three id generators** with the same `Date.now().toString(36)+rand` pattern:
   tasks.js:18 (`t…`), pipeline.js:16-18 (`exp-…`), exploration-runner.js:15 (`pending-…`). Cosmetic.
5. **No-op helper:** `totalFilesPlus` defined empty and called at asset-manifest.js:35/51.

### F3. Error-handling weaknesses — **DONE-OK**

Count of pure-swallow catch sites (`catch {}`, `catch(() => {})`, `catch(() => null)`,
`catch { return … }`), via
`grep -c "catch {}\|catch(() => {})\|catch(() => null)\|catch { return" src/*.js src/*/*.js`:

```
interactions.js 26   browser.js 14   pipeline/exploration-pipeline.js 11   platform/verify.js 10
cloneUrl.js 7   route-discovery.js 4   server.js(src) 4   sessions/tasks/exhaustive-test/runner 3 each
assets.js 2  logger.js 2  asset-manifest.js 2  vision.js 2  cli.js 1  cloneVideo.js 1  polish.js 1
(cloneImage, config, picker, prompts, exploration-policy, state-discovery, dom-extractor,
 network-recorder, artifact-store, events, exporter, model-router: 0)
Total pure-swallow lines: 83 (grep -n ... | wc -l)
```

The pattern is acceptable in page-scrape code, but three sites convert real faults into silent
data loss rather than scraper friction:
- pipeline.js:142 `.catch(() => null)` on `captureResponsive` — hides the **guaranteed** failure of F5.1; `responsive.json` is never written for any job (confirmed against the real artifact tree, §4).
- pipeline.js:116 `.catch(() => "sig-unavailable")` on the DOM signature — a failing signature collapses all states of that page into one fingerprint (`sig-unavailable` constant), defeating dedup silently.
- runner.js:30-35/56/64 cookie temp-file cleanup is try/catch'd on both delete paths and missing entirely if the process dies mid-run (see F6.2 chain).
The logger (observability/logger.js:31,34) also swallows its own write errors — self-defence, fine.

### F4. Dead / broken API surface — **DONE-OK**

- `rekeyJob` (exploration-runner.js:76-79) — 0 callers.
- `isSafeInteraction` + `DEFAULT_POLICY.risk` (exploration-policy.js:20-26,45-60) — 0 callers (see F2.2).
- `stateFingerprint` (exploration-policy.js:63-65) — 0 callers.
- `domSigFingerprint` (pipeline.js:20-22) — 0 callers.
- `graph.nodes` (state-discovery.js:16) is a one-time empty snapshot (`[...nodes.values()]`
  evaluated at factory time), not a live view — harmless today (pipeline uses `serialize()`,
  pipeline.js:165) but a trap for the next caller.
- `asset-manifest.js:78` sets `results.layoutChanged` on an **array** object; when the pipeline
  writes it via `writeJson` (pipeline.js:143) `JSON.stringify` drops the property — the
  layout-change flag is computed then thrown away. (Unreachable until F5.1 is fixed, but a second
  bug on the same line of code.)

### F5. Runtime-verified bugs (probes executed during this audit)

**F5.1 `captureResponsive` references an undefined variable — responsive capture can never work. — DONE-OK**
`src/assets/asset-manifest.js:55` takes the parameter `page`, but the body calls
`p.setViewportSize / p.waitForTimeout / p.evaluate / p.screenshot` (asset-manifest.js:60-73).
Probe (temp dir, exact command `node probe1.mjs` importing the repo module):

```
REJECTED with: ReferenceError: p is not defined
```

Combined with pipeline.js:142's `.catch(() => null)` this is a silent permanent feature loss:
cross-checked against a real previous job — `artifacts/exp-mvw2vb8g456g/` contains
`_reference/responsive/` (empty) and **no** `pages/page-001/responsive.json`.

**F5.2 Exploration queue permanently loses concurrency slots; new jobs starve. — DONE-OK**
`running` is a Set of entry objects when a job launches directly (exploration-runner.js:70) but
of **launch closures** when drained from the queue (exploration-runner.js:93-98, `running.add(next)`),
while completion only ever does `running.delete(entry)` (exploration-runner.js:57, 65). Each
queued job therefore leaks one stale closure into `running`; after `MAX_CONCURRENT` queued jobs,
`running.size` never drops below the cap and the queue never drains.
Probe (stub pipeline completing in 100 ms, real runner copied verbatim; `node run.mjs` with `MAX_EXPLORATION_JOBS` default 2):

```
t+800ms after 4 jobs (2 direct, 2 queued): [jobs 1-4 all "completed"]
t+1.6s after job 5 (should have completed ~100ms later): [jobs 1-4 completed, job 5 {"status":"queued"}]
```

Job 5 stayed `queued` forever. On the live platform this means: after two queued jobs ever exist,
**all subsequent explore submissions hang in `queued` until restart**. Severity: high (product-facing deadlock).

**F5.3 (minor, same probe session) `startPlatform({ port: 0 })` resolves `port: 0`.**
platform/server.js:218-220 resolves the requested argument, not `server.address().port`. Any
caller asking for an ephemeral port gets 0 back. Verified in the endpoint probe below (first
attempt failed with `EADDRNOTAVAIL` until a fixed port was used).

### F4bis. Artifacts endpoint path escape + credential temp-file chain — **DONE-OK (both halves probed)**

Guard at platform/server.js:58-60 is a `startsWith` on the joined path with no trailing separator
and no normalization of `..` in the wildcard segment.
Probe (`node run3.mjs`, server booted via `startPlatform`, sentinel file at the **artifacts root**):

```
/api/jobs/x/artifacts/..%2Fprobe-secret.txt          -> 200 LEAKED (artifact-root file served)
/api/jobs/x/artifacts/%2e%2e/probe-secret.txt        -> 404 (UI HTML; path normalized by client)
/api/jobs/x/artifacts/sub/..%2F..%2Fprobe-secret.txt -> 200 LEAKED
/api/jobs/..%2F/artifacts/probe-secret.txt           -> 404 {"error":"not found"}  (jobId ".." alone is safe)
```

Why this matters beyond a generic path-traversal note: `queueExploration` writes plaintext
cookies to `artifacts/tmp-cookies-<ts>.json` (exploration-runner.js:31-34) — the **artifacts root**,
exactly the location this escape reaches — and deletes it only in `.then`/`.catch` (runner.js:56, 64;
no `finally`). A job that crashes the process (or a SIGKILL during exploration) leaves cookies on
disk at a URL-reachable path. Chain = WEAK today, HIGH if a job ever dies mid-run.
Fix direction: (a) `path.relative` containment check, (b) pass cookies as an array — the pipeline
already accepts `cookies` (pipeline.js:24, 47) and the runner's cookie-file round-trip is
unnecessary, (c) write temp files outside `artifacts/` with a `finally` unlink.

---

## 4. §15 artifact contract vs reality — **DONE-OK (with two deviations)**

Actual tree of a real job (`find artifacts/exp-mvw2vb8g456g`):

```
artifacts/exp-mvw2vb8g456g/
  manifest.json  exploration.json  exploration.md          <- exploration.json/md: NOT in the §15 tree
  pages/page-001/{dom,geometry,network,styles}.json, screenshot-viewport.png   <- responsive.json MISSING
  graph/{routes,states,transitions}.json
  assets/manifest.json
  reports/{coverage-report,exploration-summary,failures}.json
  logs/job.log
  _reference/states/t2-Add-module.png                          <- state evidence: NOT in the §15 tree
  _reference/responsive/                                       <- empty (F5.1)
  states/                                                      <- created by artifact-store.js:12, EMPTY
```

Conforms: `manifest.json`, `pages/page-NNN/{dom,geometry,network,styles}.json` +
`screenshot-viewport.png`, `graph/` trio, `assets/manifest.json`, `reports/` trio, `logs/job.log`.
Deviations: (1) `states/` is an empty dir — state screenshots land in `_reference/states/` because
`recordInteractions` writes its own layout (interactions.js:707-741); (2) `responsive.json` never
written (F5.1); (3) `exploration.json`/`exploration.md` sit at the job root, uncontracted.
Either the store should own these writes or the contract in docs/phase-1/README.md:20-28 should
be amended — do not leave both truth sources.

---

## 5. Target module-boundary proposal (Phase 2)

Principle: keep every call-site-stable export (§6) untouched; move *wiring*, not signatures.

1. **Event bus scoping** (fixes F1.1): add a correlation envelope — `bus.emit(type, data, {corrId})`
   and `bus.scope(corrId)` returning a filtered emitter. Pipeline and server subscribe via scope;
   the catch-up ring buffer keeps its shape. `bus`/`catchUp()` signatures unchanged.
2. **Pipeline decomposition** (fixes F1.2): split `runExplorationJob` body into
   `exploration/steps/{auth,page-capture,states,finalize}.js`, each a pure `(ctx) => ctx` step over
   `{ page, store, logger, policy, network, graph }`. `runExplorationJob` keeps its exact signature
   and becomes linear composition. Artifact filenames stop being pipeline constants and become
   store methods (`store.writePageArtifact(pageId, kind, data)`).
3. **One risk module** (fixes F2.2): `interactions.js` imports `DEFAULT_POLICY.risk` from
   exploration-policy instead of its local `DANGEROUS`; keep behavior-compatible defaults so the
   clone engine's record set doesn't change. Decide explicitly whether `isSafeInteraction` gets
   wired into the pipeline or is deleted — it must not stay dead.
4. **One fingerprint** (fixes F2.1): `state-discovery.js` exports `stateFingerprint(url, sig)` =
   current sha1 impl; pipeline and policy import it; delete the other two copies.
5. **Store as the only filesystem seam** (fixes F1.3 + §4 deviations): `recordInteractions` and
   `captureResponsive` accept an injectable writer (default: current fs behavior for the clone
   path); the pipeline passes the store, so state screenshots land under `states/` and
   exploration reports under `reports/`.
6. **Runner correctness** (fixes F5.2, F4bis): track queue occupancy by entry id in both paths
   (or `running = Map(id → entry)`); persist the registry to `platform-data/explorations.json`
   (or accept ephemerality and return 410 for unknown ids with on-disk artifacts); drop the
   cookie temp file entirely; harden the artifacts route with `path.relative` containment.
7. **Keep the engine/platform seam as-is** — it is already clean: `platform/server.js` touches the
   engine only through `cloneUrl` (server.js:200) and `runExplorationJob` (via runner), plus
   `loadCookies` for task cookies (server.js:13, 196). Preserve exactly that.

---

## 6. Working public APIs that must survive refactoring — **DONE-OK**

Each entry below has a verified caller in-tree (grep evidence cited).

**Engine:**
- `browser.js`: `loadCookies`, `launchBrowser`, `newContext`, `attachSniffer`, `capturePage`,
  `captureMhtmlSnapshot`, `discoverTabs`, `renderCloneScreenshot` (browser.js:15-511; callers:
  cloneUrl.js:5, pipeline.js:7, sessions.js:6, platform/server.js:13, scripts).
- `interactions.js`: `recordInteractions` (interactions.js:704; callers browser.js:230, pipeline.js:148).
- `cloneUrl.js`: `cloneUrl` (callers platform/server.js:200, cli.js:8).
- `assets.js`: `downloadAssets`, `absoluteUrl`, `rewriteHtml`, `captureCss`, `finalizeCssRewrite`
  (assets.js:34-175; caller cloneUrl.js:6).
- `polish.js`: `runPolish` (cloneUrl.js:7) · `runtimeTemplate.js`: `buildRuntime` (cloneUrl.js:8;
  also asserted by wf-fixture-run.mjs:72) · `config.js`: `loadConfig` · `events.js`: `bus` + `catchUp()`
  (server.js:156).
- `cloneImage.js` / `cloneVideo.js` CLI modes (cli.js:9-10).

**Platform:**
- `startPlatform` (platform/server.js:22; bin/platform.js:3, scripts/test-platform.mjs).
- Task API: `POST/GET /api/tasks`, `GET/DELETE /api/tasks/:id`, `POST /api/tasks/:id/chat`,
  `/preview/:id/*`, `POST /api/export/:id` (+`/download`), `GET /api/sessions`, `GET /api/providers`, WS `/ws`.
- `tasks.js`: `createTask/updateTask/loadTask/saveTask/listTasks/deleteTask/purgeCredentials/sweepExpired/taskDir/outDir`
  (server.js, exporter.js, verify flows).
- `sessions.js`: `acquire/get/release/stats` (server.js:143) · `exporter.js`: `exportTask`,
  `isSensitiveName`, `stageClean` · `verify.js`: `verifyTask` (server.js:208) · `model-router.js`:
  `routeChat/getProviders/usageStats` (server.js:98,146-148).

**Phase-1 intelligence engine:**
- `runExplorationJob` (pipeline.js:24; runner.js:5, test-exploration.mjs:6).
- `queueExploration`, `getExplorationJob`, `listJobs` (runner.js; server.js:49,54,52).
  *(Note: `rekeyJob` is dead — deleting it is safe; listed for awareness, not preservation.)*
- `resolvePolicy`, `DEFAULT_POLICY` (pipeline.js:8; test config shapes).
- `createRouteDiscovery`, `SPA_RECORDER_SCRIPT` · `createStateGraph`, `DOM_SIGNATURE_SCRIPT` ·
  `DOM_EXTRACTOR_SCRIPT`, `analyzeTypography` · `buildAssetManifest`, `classifyResource` ·
  `createArtifactStore`, `redact` · `createLogger` — all consumed by pipeline.js:8-14
  (`captureResponsive` also public but broken; fix signature, keep name).
- HTTP: `POST /api/jobs/explore`, `GET /api/jobs`, `GET /api/jobs/:jobId` (tempId alias),
  `GET /api/jobs/:jobId/artifacts/*`.

---

## 7. Test coverage vs spec §17's 15 fixture types — **partly MISSING (spec unavailable)**

**Honest blocker:** the authoritative spec document (with §17's enumerated 15 fixture types) is
**not present in the repo**. Searches run: `grep -rln "§" --include="*.md" --include="*.txt" .`
(only README-PLATFORM.md and docs/phase-1/README.md, which reference §-numbers but do not contain
the fixture list), `find . -iname "*spec*"`, listing of `.zcode/`, the parent directory, and the
workflow draft/run dirs — all empty. I therefore **cannot** produce a per-type DONE/MISSING
matrix against the official list; filling one in would be fabrication. What follows is the
verifiable inventory of what the three named scripts actually exercise.

**Status of this section: WEAK** — coverage of the *implementations* is verified; the mapping to
§17's named types is **MISSING** pending the spec text.

### 7.1 What each script covers (verified by reading + running)

| Script | Fixture source | Fixture capabilities exercised | Verified? |
|---|---|---|---|
| `scripts/test-exploration.mjs` | inline 3-route site (test-exploration.mjs:14-31): shared nav, per-page `<h1>`+unique text, modal overlay with form (text/email inputs, select, checkbox) + close button, 2 tabs with panes | multi-page nav-link discovery, route dedup, modal overlay state, HTML form inside overlay, tabs, state-graph nodes/edges, §15 tree, redaction, budget ceiling | **Yes** — ran it: 16/16 in 7.6s |
| `scripts/serve-fixture.mjs` + `fixture-toolbar.html` | 88-line toolbar fixture: icon-only buttons inside `btn-group`s with `title`/`aria-label`, picker menu with 5 module entries, module panel with `<canvas>` chart | icon-button classification (glyph-vs-control), picker overlay + inner entries, canvas snapshotting | Served+consumed by wf-fixture-run (not re-run here — see 7.3) |
| `scripts/wf-fixture-run.mjs` | same toolbar fixture via ephemeral server (wf-fixture-run.mjs:26-38) | **the clone pipeline** (`bin/cloner.js`), 14 checks (counted at wf-fixture-run.mjs:56-86): exit 0, substantive index.html, ≥3 trigger marks, btn-icon title, mhtml exists/valid/content, 6 runtime records, inner modules, picker overlay, canvas→img, clone.json wiring, no multi-arg/markTriggers evaluate failures | **Not run during this audit** — it exercises the clone engine, not the Phase-1 pipeline; noted, not counted |
| `scripts/test-xclose.mjs` | **not a fixture** — loads a saved clone at hardcoded `platform-data/tmvvfttcya7to/out/index.html` (test-xclose.mjs:6) | clone-runtime behaviors: module ✕-close + `data-cloner-hidden`, Escape restore, picker open with ≥3 inner entries, inner click opens module | **Not run**; flagged fragile — the retention sweep (tasks.js:96-107) or any other machine invalidates the hardcoded path |

### 7.2 Coverage gaps (fixture types no current script exercises)

Derived from the pipeline's own capability surface (auth login pipeline.js:73-87, SPA recorder
route-discovery.js:7-29/85-92, tabs discovery, viewports exploration-policy.js:14-18, network
recorder) — none of these has a driving fixture:

- authenticated login flow (code exists, zero fixture coverage)
- SPA pushState/hash routing (`fromSpaEvents` untested end-to-end)
- iframes / nested contexts
- data tables / grids / virtualized lists
- JS-driven dropdown menus beyond the picker proxy
- date pickers, file inputs, drag-and-drop
- websocket/realtime streams (canvas settle logic in browser.js:137-162 untested)
- nested modals / modal-over-modal; transient toasts as a *captured* state
- redirects, 404/5xx pages, slow-network, offline
- responsive/mobile viewports — actively broken (F5.1), `responsive.json` never produced
- multi-tab flows (`discoverTabs` untested)

### 7.3 What I did not run, explicitly

- `scripts/wf-fixture-run.mjs` and `scripts/test-xclose.mjs` were **not executed** during this
  audit (read-only analysis). They are clone-engine and clone-runtime tests respectively; the ask
  asked me to *state coverage*, which I did from the source. No pass/fail is claimed for them.
- The §15-conformance claims in §4 are from the real tree of a **prior** job plus the fresh
  `test-exploration.mjs` run's output dir, both inspected directly.

---

## 8. Findings status summary

| # | Finding | Status |
|---|---|---|
| 1 | Module graph mapped (static + hidden dynamic edges) | DONE-OK |
| 2 | Lifecycle: platform task (persistent) vs exploration job (in-memory, restart-fragile) | DONE-OK (fragility itself: WEAK) |
| 3 | Coupling: unscoped global bus, god-orchestrator pipeline, store abstraction leak | DONE-OK |
| 4 | Duplication: 3 fingerprint variants (2 dead), 2 divergent risk regexes (policy one dead), 2 network recorders | DONE-OK |
| 5 | Error handling: 83 silent-catch sites; 3 swallow real data loss | DONE-OK |
| 6 | Dead surface: `rekeyJob`, `isSafeInteraction`, `stateFingerprint`, `domSigFingerprint`, stale `graph.nodes`, lost `layoutChanged` | DONE-OK |
| 7 | Bug: `captureResponsive` undefined `p` → responsive capture never works (probed) | DONE-OK (verified) |
| 8 | Bug: exploration queue starvation deadlock (probed) | DONE-OK (verified) — **high severity** |
| 9 | Bug: artifact endpoint `..%2F` escape reaches artifacts root (probed) + cookie temp-file chain | DONE-OK (verified) — **high severity** |
| 10 | §15 tree: `states/` empty, evidence in `_reference/`, `responsive.json` absent | DONE-OK (verified) |
| 11 | §17 15-fixture-type mapping | MISSING (spec text not in repo) — inventory in §7 is what is knowable |
| 12 | `startPlatform({port:0})` resolves 0 (probed) | DONE-OK (minor) |
