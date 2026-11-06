# Audit D — Exploration engine and coverage model

Repo: D:/project 2/cloner (branch master, HEAD 4327ac8). All claims below were
verified by reading the cited files and/or running commands in this session.

Commands run: `node --check` on all 10 target files (all OK); `timeout 60 node
scripts/test-exploration-efficiency.mjs` → **32 passed, 0 failed, pipeline runs
took 31.6s (baseline 19331ms, optimized 12314ms), exit 0**; targeted greps cited
inline. `scripts/test-website-coverage.mjs` was NOT run (boots a browser and
runs 3 fixture jobs + reconstruction; its own per-job budget is 90s ×3 — clearly
over the audit's 60-second single-script cap). Its content is reported from
reading it.

## 1. WHAT EXISTS

Production path (what actually runs for platform clone jobs):
`src/platform/exploration-runner.js:27` queueExploration → `src/queues/clone-queue.js`
(memory backend by default, BullMQ when REDIS_URL set — clone-queue.js:3-10) →
`src/queues/pipeline-job.js:69` Stage 1 → `src/pipeline/exploration-pipeline.js`
runExplorationJob (388 lines) → stages 2-3 reconstruction/verification.

- src/exploration/route-discovery.js (295 ln): scored route queue; tracking-param
  strip (138-148, applied at 153); query-variant pre-navigation dedupe (170-186);
  SPA pushState/replaceState/hashchange init-script recorder (67-95);
  planNavigations/markExplored (264-282); stats() (284-293).
- src/exploration/state-discovery.js (287 ln): state graph nodes+edges
  (createStateGraph 81-267); sha1 fingerprint url+domSig (29-31); contentKey
  pathname+domSig (36-40); interactionPotentialScore (45-68); candidate queue
  addCandidate (184-215) / planStates (219-226) / markCandidateExplored
  (229-244); resumption via restore (100-108); DOM_SIGNATURE_SCRIPT (271-286).
- src/exploration/exploration-policy.js (66 ln): DEFAULT_POLICY budgets/
  viewports/risk/routes (5-33); resolvePolicy (35-43); isSafeInteraction (46-61)
  — DEAD CODE (zero callers, see §3); a second stale string-concat
  stateFingerprint (64-66) shadowed by the sha1 version.
- src/exploration/application-state-capture.js (231 ln): per-state probe of
  URL+hash/query+localStorage/sessionStorage+marked controls (101-143);
  credential redaction (42, 82-97); exportApplicationState (188-210).
- src/exploration/websocket-session-capture.js (301 ln): page.on("websocket")
  payload-SHAPE capture, all strings redacted, URLs query-stripped (1-37, 62-72).
- src/pipeline/asset-capture.js (63 ln): persists static network responses under
  assets/<type>/<hash>.<ext>, hash dedupe, 8MB/300-resource caps.
- src/interactions.js (895 ln): the real explorer — markTriggers (197-228),
  locateOverlay (242-279), pickerPass (369-502), topbarPass (507-567),
  captureInner (572-655), explorePass (658-793), recordInteractions 2-pass
  driver (804-895), exploration.json/md report (852-873).
- src/events.js (39 ln): bus + 500-event ring buffer + AsyncLocalStorage job tag.
- Tests: scripts/test-website-coverage.mjs (347 ln), test-exploration-efficiency.mjs
  (298 ln), test-asset-map.mjs, test-app-state-reconstruction.mjs.

## 2. WHAT ACTUALLY WORKS (verified)

- Route planning + dedupe. Ran `timeout 60 node scripts/test-exploration-efficiency.mjs`
  → 32/32 PASS: "duplicate query-variant navigations skipped BEFORE any fetch
  ({redundantRoutes:4, duplicatesSkipped:4})", "canonical query-less URL wins
  over queued parameterized twin", "routes kept score-ordered with seed pinned
  first", "completeness mode (prioritize:false) keeps every discovered URL
  navigable", "resumed graph restores the dedup index — 2 states restored",
  "coverage report intact (pct 100)". Tracking-param stripping confirmed in code
  at route-discovery.js:138-148 (`TRACKING_PARAM` regex: gclid/fbclid/utm_*/_gl/…,
  stripped in add() at line 153 before the `seen` fingerprint at 157); added in
  HEAD commit 4327ac8 ("tracking-param route strip", `git log -1
  -- src/exploration/route-discovery.js`).
- Clicking visible interactive elements: markTriggers enumerates
  `button,[role=button],[role=tab],[role=menuitem],a.btn,[class*=btn]…`
  (interactions.js:142), leaf-first sorted (148-156); explorePass scrolls into
  view + visibility probe then clicks (682-709); two passes catch controls
  revealed by pass 1 (804-850). Budgets enforced via deadline (674-677).
- Dropdowns/menus/dialogs/pickers: locateOverlay finds modal/dropdown/popup/
  popover/menu/dialog/picker/role=dialog/menu/listbox (253), captureInner
  clicks entries inside open overlays and re-opens between entries (640-653);
  dedicated pickerPass and topbarPass guarantee the richest overlays are
  captured before generic budget is spent (814-828).
- Exploring discovered routes: planNavigations-capped loop (exploration-pipeline.js:284-288)
  + second pass for SPA-discovered new documents (292-299).
- App-state + WS capture per page: sink attached before goto (95-96), exported
  per page with sink reset (228-237); app-state observation after interactions
  (247-248). node --check OK on all files.
- Asset persistence from network entries (asset-capture.js:23-62) wired into the
  pipeline (312-324) with assetManifest.capturedFromNetwork.

## 3. WHAT IS BROKEN / INCOMPLETE / DISCONNECTED

Required-behavior scorecard (file:line evidence):

1. Progressive scrolling with screenshots at meaningful positions — **MISSING**
   in the exploration pipeline. No scroll pass exists: grep "scroll" in
   exploration-pipeline.js / exploration/* = 0 hits. autoScroll (browser.js:340-358,
   called at 209) lives only in capturePage — the legacy v1 flow used by
   src/cloneUrl.js:54, NOT by runExplorationJob. Screenshots are one viewport
   shot per route (pipeline:169-171) + per-overlay shots (interactions.js:783-785);
   scrollIntoView (interactions.js:687) serves clicking only.
2. Clicking visible interactive elements — **PRESENT** (see §2).
3. Dropdowns/menus/tabs/dialogs — **PRESENT** for overlays and pickers;
   **PARTIAL** for tabs/selects: `[role=tab]` is marked and clicked like any
   button (142), but no tab-specific wait/pane capture; `<select>` elements are
   never opened or option-sampled anywhere in interactions.js; controls inside
   modals are rejected from marking (173, rej.inModal) and only reached via
   captureInner on already-open overlays.
4. Lazy-loaded content discovery — **MISSING as a pass**. Discovery relies on
   initial-viewport IntersectionObserver fires (fixtures/lazy-scroll.mjs rootMargin
   160px), incidental scrollIntoView, and clicking "load more"-style buttons
   ("load" is not in the DANGEROUS regex, so such buttons are marked). No
   scroll-to-bottom/IO flush before DOM extraction → below-fold lazy content is
   captured only by luck.
5. Recording resulting URLs and state changes — **PARTIAL**. SPA recorder
   captures pushState/replaceState/hashchange (route-discovery.js:67-95) but is
   harvested once per page AFTER all interactions (pipeline:241), so URL changes
   are not attributed to specific interactions; the graph node for an interaction
   uses synthetic `page.url()+"#"+rec.text` (pipeline:261), not the real
   post-click URL. application-state.json (URL+hash+storage) is per-route only.
6. Exploring discovered routes — **PRESENT** (§2).
7. Returning to previous states — **PARTIAL**. Per-click reset only: Escape +
   closeAddedModules + overlay cleanup (interactions.js:633-638, 739-754,
   877-879). `grep goBack|history.back` across src/ = 0 hits; the loop never
   re-navigates to a parent state; graph parentStateId (state-discovery.js:139)
   is recorded but never acted on.
8. Destructive-action guard — **PRESENT but hardcoded / PARTIAL**. The wired
   guard is interactions.js:19 `DANGEROUS` regex (buy|sell|submit|logout|delete…)
   + rejects: real-link anchors (167), form members (168), in-modal (173),
   close-icon/class (174-175). The CONFIGURABLE guard policy.risk
   (exploration-policy.js:20-26) is disconnected: `grep isSafeInteraction` over
   src/ scripts/ bin/ returns exactly 1 hit (its own definition); recordInteractions
   is called with {waitMs,max,triggerMax,budgetMs,outDir} only (pipeline:211-214,
   browser.js:276) — user risk policy is silently ignored by the explorer.
   exploration-policy.js:64-66 also exports an obsolete non-hashing
   stateFingerprint that would collide differently than the sha1 one if anyone
   imported it.
9. Route dedupe / tracking-param strip — **PRESENT, confirmed** (§2 + ran the
   efficiency test).
10. Exploration GRAPH with coverage/uncertainty — **PARTIAL**. Emitted graph =
    routes.json + states.json + transitions.json + states/index.json
    (pipeline:302-310). Node schema (state-discovery.js:137-149): id/url/
    parentStateId/fingerprint/interaction/viewport/screenshotRef/domRef/domSig/
    timestamp/status. Coverage = aggregate only (coverage-report.json
    routesDiscovered/routesExplored/coveragePct/statesRecorded + efficiency
    counters, pipeline:351-360). Gaps vs the required model: NO components and
    NO tokens in the graph (components are computed later per page by
    src/reconstruction/website-understanding.js buildUnderstandingPage; tokens
    live in pages/<id>/styles.json via dom-extractor) — the graph is
    routes/states/interactions/assets only; routes carry NO explored/unexplored
    status field (routes.push at route-discovery.js:191-199 has no status), so
    discovered-but-unplanned routes are countable via coveragePct but not
    enumerable; NO uncertainty/confidence fields anywhere in the graph. The only
    "stays unexplored" marker is candidate status "queued"
    (state-discovery.js:211) which survives if planStates never reached it.
11. Event timeline → /ws — **PARTIAL; live user observation is text-only today**.
    server.js:1091-1108 subscribes step/log/tabs:found/assets:progress/assets:
    done/page:goto/run:done/run:error/polish:round → owner-gated broadcast
    (1053-1087) with 500-event catchup (events.js:15-26, server.js:1029-1031).
    But during a v2 exploration the pipeline emits ZERO bus events itself
    (`grep bus.emit` in src/pipeline, src/exploration, src/assets = 0 hits);
    logger lines go only to logs/job.log NDJSON (logger.js:33-37). So /ws sees:
    interaction-module log/step lines (interactions.js), asset progress, and
    job:status transitions (server.js:1112-1121). No route-discovered /
    state-captured / screenshot / graph-delta events. Worse: with REDIS_URL the
    worker is a separate process (clone-queue.js:3-4) — its bus emissions never
    reach the server bus; only status is bridged, so live step/log detail is
    memory-backend-only. `onProgress` (pipeline:33) is declared and never called
    (1 occurrence) — dead streaming hook. Missing for live observation:
    pipeline-level timeline events, logger→bus mirroring, worker-process event
    forwarding, optional screenshot streaming.

## 4. WHAT IS REUSABLE AS-IS

- The whole src/exploration/ layer (route scoring/dedupe, state graph +
  candidate queue + resumption, app-state capture, WS shape capture) — clean,
  tested, deterministic exports (efficiency test 32/32).
- The pipeline skeleton in exploration-pipeline.js: budget deadlines, per-page
  artifact contract (dom/styles/network/websocket/application-state.json),
  coverage/failures reports, integrity manifest (369-376), bus-listener cleanup
  in finally (384-386).
- interactions.js explorer incl. pickerPass/topbarPass/captureInner and its
  DANGEROUS guard as the default.
- scripts/test-exploration-efficiency.mjs (ran green here) and
  scripts/test-website-coverage.mjs as the realignment regression base.

## 5. WHAT NEEDS MODIFICATION

- exploration-pipeline.js exploreRoute (~149-275): add a progressive
  scroll-to-bottom pass (with bounded steps + screenshot at N meaningful
  positions) before DOM extraction, to make lazy-load discovery deterministic
  (behavior currently only in legacy browser.js:340 autoScroll).
- pipeline:211 + interactions.js recordInteractions: accept and apply
  policy.risk (forbiddenText/types/containers) — merge with the hardcoded
  DANGEROUS regex; then delete or wire exploration-policy.js:46-61 isSafeInteraction
  and remove the stale 64-66 fingerprint.
- exploration-pipeline.js:241 + route-discovery.js: harvest SPA events per
  interaction (or tag each record with post-click page.url()) so interaction
  nodes carry real resulting URLs instead of synthetic `#text` (261).
- route-discovery.js routes.push (191-199): add explored/unexplored status per
  route; emit enumerated unexplored lists into coverage-report.json (351-360);
  add uncertainty fields (or reuse candidate scores) if the new architecture
  keeps the graph honest about what was not visited.
- Graph: add components/tokens node families (or stable references into
  styles.json / website-understanding output) if the realigned architecture
  requires the single routes/components/interactions/assets/tokens graph.
- Timeline: emit pipeline-level events (route:discovered, route:explored,
  state:captured, screenshot) to bus; mirror logger lines to bus; forward
  worker-process events (BullMQ path) so /ws works in production mode; either
  implement or drop the dead onProgress (pipeline:33).

## 6. COMPLETION EVIDENCE (for the realigned engine)

- `node scripts/test-exploration-efficiency.mjs` (ran here, 32/32 in 31.6s) and
  `node scripts/test-website-coverage.mjs` exit 0.
- New tests: (a) scroll-triggered lazy fixture (IntersectionObserver beyond
  rootMargin) yields images/entries in dom.json without a click; (b) a
  user-risk policy (e.g. custom forbiddenText) demonstrably blocks a marked
  trigger; (c) coverage-report.json enumerates every discovered route with
  explored/unexplored status and it matches pages[]; (d) a WS client joined to
  the task receives route/state/screenshot timeline events during a fixture run
  (both memory and BullMQ backends).
- Artifacts proving behavior per job: graph/states.json statuses, graph/routes.json
  with per-route status, reports/coverage-report.json efficiency block.

## Key file map

- Pipeline (production exploration stage): src/pipeline/exploration-pipeline.js
  (runExplorationJob :33; exploreRoute :149; route loop :284-299; graph writes
  :302-310; coverage report :351-360; dead onProgress :33)
- Queue/runner wiring: src/queues/pipeline-job.js:69, src/platform/exploration-runner.js:27
- Route model: src/exploration/route-discovery.js (strip :138-148, dedupe :170-186,
  plan :276-282, stats :284-293)
- State graph/candidates: src/exploration/state-discovery.js (addState :123,
  addCandidate :184, planStates :219, restore :100, DOM sig script :271)
- Policy: src/exploration/exploration-policy.js (risk :20-26, dead isSafeInteraction :46)
- Interactions explorer: src/interactions.js (DANGEROUS :19, classify :131-194,
  pickerPass :369, topbarPass :507, captureInner :572, explorePass :658,
  recordInteractions :804, report :852)
- App-state/WS captures: src/exploration/application-state-capture.js,
  src/exploration/websocket-session-capture.js
- Asset capture: src/pipeline/asset-capture.js:23
- Event bus: src/events.js; /ws bridge: src/platform/server.js:1004-1121
- Legacy v1 scroll path (not in production pipeline): src/browser.js:185-209,340-358
- Tests: scripts/test-exploration-efficiency.mjs (RAN, 32/32),
  scripts/test-website-coverage.mjs (read, not run), scripts/fixtures/lazy-scroll.mjs
