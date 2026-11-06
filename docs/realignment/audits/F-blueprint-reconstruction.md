# F — Blueprint Generation & Reconstruction Engine (audit)

Scope: blueprint step (or its absence), instruction handling, generation of pages/CSS/assets,
framework preference, runnable-project/preview contract, parallelism inside reconstruction.
All claims below were verified by reading the cited files in this session or by running the
commands listed in "Evidence run in this session".

## 1. WHAT EXISTS

Two parallel reconstruction flows plus one dead orchestrator:

- **v1 CLI flow**: `bin/cloner.js:2` → `src/cli.js:63 main()` → `src/cloneUrl.js:11 cloneUrl()`
  (URL mode) or `cloneImage.js:8` (screenshot→LLM) / `cloneVideo.js` (video→LLM).
  v1 mirrors the original HTML (`rewriteHtml`, `assets.js:112`) and appends a replay runtime;
  it does NOT regenerate markup.
- **v2 platform flow**: `src/platform/server.js:419 POST /api/tasks` →
  `exploration.queueExploration` (`exploration-runner.js:27`) → queue
  (`queues/clone-queue.js`, BullMQ or memory) → `workers/clone-worker.js` (BullMQ) or in-process →
  **`src/queues/pipeline-job.js:39 runPipelineJob`** = the single 3-stage definition:
  runExplorationJob → `reconstructFromArtifacts` → `verifyTask` (pipeline-job.js:69, 89, 102).
- **Dead**: `src/orchestration/pipeline-orchestrator.js:15 executePipeline` (5 stages incl.
  `artifact_validation`) is imported by nothing — only a comment references it
  (`workers/clone-worker.js:54`). Its failure-stage detection reads
  `artifacts/${taskId}/.${s}.in_progress` marker files (pipeline-orchestrator.js:80) that no
  code ever creates (`setStage` writes DB rows, `task-repository.js:64`).

Reconstruction engine modules (all read this session):

- `reconstruction/reconstruction-pipeline.js` (517 lines): load → per-page analyze/generate →
  tokens/CSS → generateProject → validate → fallback-shell repair (MAX_ROUNDS=2, line 27) →
  post-loop augmentations (component patterns, workspace, responsive, app-state).
- `reconstruction/generation/project-generator.js` (236): `buildComponentCss` (25),
  `renderNode` (98), `generatePageHtml` (144), `generateProject` (174).
- `reconstruction/analysis/component-tree-builder.js` (130): DOM tree + cycle repair (18-47),
  semantic naming (59-83), repeated groups (102-118); `layout-analyzer.js` (117):
  flex/grid/gap inference from captured geometry (5-45), token builder (54-97), tokensCss (99-117).
- `reconstruction/website-understanding.js` (717): deterministic per-page evidence model
  (`buildUnderstandingPage`:487), REGION_KINDS vocabulary (46), vision hook only for
  confidence<0.5 containers (596-645), persisted per page as `pages/<id>/understanding.json`.
- `intelligence/dom-extractor.js` (121): in-page extraction script, MAX 1200 sampled elements
  (line 6-17), real-DOM parent resolution (69-79), extended per-element styles (45-55).
- `runtimeTemplate.js` (572): `buildRuntime` (46) = vanilla IIFE replay runtime embedding
  `window.__CLONER_INTERACTIONS` JSON; 4-layer click matching (runtimeTemplate.js:169-196):
  data-cloner-trigger → data-replay-id → structural path → text signature; plus ad-slot hooks
  (`withAdSlots`:538, `resolveCloneAdConfig`:493).
- `prompts.js` (82): SYSTEM_CLONER (3), CLONE_FROM_IMAGE (13), CLONE_FROM_VIDEO (24 —
  transcript "words are instructions"), POLISH (35), EDIT_ELEMENT (55).
- `vision.js` (217): provider-agnostic client (anthropic/openai/custom/none) with retry (72-78).
- `assets.js` (210): `downloadAssets` concurrency pool (34), `rewriteHtml` (112),
  `captureCss`/`finalizeCssRewrite` (158, 175) — v1 flow only.
- Preview serving: v1 `src/server.js:48-68` (/preview/:run/*); v2
  `src/platform/server.js:768-790` (`resolvePreviewDirs` v1 outDir → `<jobId>-project` →
  artifacts tree; owner-gated 790-813; relative-containment guard 816-818; picker injected
  into .html before send).

## 2. WHAT ACTUALLY WORKS (evidence-backed)

- The v2 generation path produces a complete static site on real data. Ran on a real artifact
  dir: `artifacts/bench-documentation-mvwxrhct-project/reconstruction-report.json` →
  `{status:"completed", passed:true, rounds:1, generatedFiles:7}`, with per-page
  `understanding` summaries for pages 001–007; the project tree contains index.html +
  6 route pages, styles/, runtime/, public/, package.json, both reports (ls output verified).
- `understanding.json` is really written: `artifacts/bench-documentation-mvwxrhct/pages/page-001/understanding.json`
  → components:13, regions {header,navigation,sidebar,workspace,card-grid,card,footer},
  vision {attempted:false} (node -e output).
- Interaction replay wiring is end-to-end: capture marks `data-cloner-trigger`
  (dom-extractor.js:29) → pipeline maps records to elements via `deriveInteractionRecords`
  (reconstruction-pipeline.js:48-104) → generator emits `data-replay-id`
  (project-generator.js:129-130) → runtime matches 4 ways (runtimeTemplate.js:169-196).
- Syntax integrity: `node --check` passed on all 9 audited files (see Evidence).
- Preview serving resolves v2 project dirs and is owner-gated (platform/server.js:768-830);
  post-hoc element edits work through `POST /api/tasks/:id/chat` → LLM patch → file write
  (platform/server.js:834-895, prompts.js EDIT_ELEMENT).
- The offline script `scripts/check-runtime-records.mjs` ran successfully against a generated
  project's runtime/interactions.js (parsed the embedded array; that run had 0 records —
  the project's pages recorded no interactions).

## 3. WHAT IS BROKEN / INCOMPLETE / DISCONNECTED

1. **No blueprint step exists.** `grep -rni "blueprint" src/ bin/` → 0 matches. The flow is
   capture → (internal per-page understanding) → deterministic generation. There is no
   structured implementation plan, no user-visible/editable artifact between capture and
   output, no approval gate.
2. **User instructions are silently dropped in v2.** POST /api/tasks accepts `instructions`
   (server.js:423, 20k limit at 350) and stores them (platform/tasks.js:31,45), and
   server.js:443-447 passes them to `queueExploration` — but
   `exploration-runner.js:27` does not destructure `instructions` and the queue payload
   (exploration-runner.js:43) omits it. `pipeline-job.js:46` destructures a payload that
   never had it. The only trace is a fake check in `verify.js:394-395`:
   `"task instructions carried"` pushes `ok:true` unconditionally when a task row has
   instructions — it verifies nothing and never reaches the engine.
3. **Instruction enforcement exists only post-hoc.** Two LLM instruction paths:
   video narration (prompts.js:28-30, prompt-only) and the chat edit endpoint
   (platform/server.js:834+). Nothing conditions *generation* on user instructions;
   there is no instruction→element/section matching at all.
4. **The understanding record does not feed the generator.**
   `generation/project-generator.js` never reads understanding data (grep: 0 hits);
   understanding.json consumers are workspace-analyzer.js, component-evidence.js (annotation),
   storage/artifact-lifecycle.js, skill-integration/style-spec.js. Generation is driven purely
   by dom.json + geometry, so the 13-classified-region model is dead weight for output.
5. **No output-framework support.** Output is always static HTML + 3 CSS files + 1 runtime.
   prompts.js:8 mandates "no frameworks unless clearly required" (LLM modes only). Stack
   detection (browser.js:453-476) is logged only (cloneUrl.js:271).
   `scripts/gen-scaffold.mjs` (React/Vite or Vue scaffold from measured tokens) is never
   invoked from product code (grep: 0 hits in src/), while `platform/exporter.js:172`
   advertises a `scaffold/` entry in export READMEs — the README line fires only if
   `meta.artifacts.scaffold` was set by that manual script.
6. **Parallelism inside reconstruction: none.** The page loop is sequential
   (reconstruction-pipeline.js:224-309; the only `await` is line 244 per page).
   Cross-job parallelism exists (clone-worker.js:38 `MAX_CONCURRENT` default 2), and v1 has
   internal parallelism (tabs 2-at-a-time cloneUrl.js:90-93; CSS Promise.all:171; asset pool
   assets.js:34) — but reconstruction itself is strictly serial.
7. **Speed is a user flag, not evidence-gated.** `--fast` (cli.js:78-79, 131-136) skips
   polish and tightens crawl waits; polish has a wall-clock budget (polish.js:32-35,
   CLONER_POLISH_BUDGET_MS default 120s). Nothing measures "sufficient evidence" before
   deciding fast vs thorough; MAX_ROUNDS=2 is unconditional.
8. **Dead orchestrator + placeholder bug**: `completeStage` computes
   `const duration = Date.now() - Date.now()` (task-repository.js:81 — always 0, comment
   says "will be computed properly"); orchestrator error-stage detection always yields
   "unknown" (marker files never written, pipeline-orchestrator.js:79-81).
9. Minor: generated `<title>` is the raw URL (project-generator.js:150), not the captured
   page title; generated package.json has no start/build scripts beyond `dev: npx serve .`
   (project-generator.js:179).

## 4. WHAT IS REUSABLE AS-IS

- `website-understanding.js` `buildUnderstandingPage` + component-evidence aggregation: the
  closest existing thing to an understanding record; evidence model with provenance and
  honest degradation. A site-level blueprint layer can be built directly on top of it.
- Deterministic generation core: component-tree-builder, layout-analyzer, buildComponentCss,
  tokensCss — proven on real sites (Tradovate fix history in comments), fully offline,
  deterministic (pipeline regenerates identically; repair loop relies on that).
- `runtimeTemplate.js` replay runtime (error isolation, idempotent replays, structural-path
  matching) — framework-independent, works for any static output.
- `pipeline-job.js` as the single pipeline definition (both execution paths share it) — the
  natural place to insert a blueprint stage.
- Preview serving + chat edit endpoint: already framework-agnostic over a directory of files.
- `vision.js` client + `prompts.js` prompt structure for any LLM blueprint/planning step.
- v1 asset machinery (assets.js) for anything that mirrors rather than regenerates.

## 5. WHAT NEEDS MODIFICATION (file-level)

1. **Add a blueprint stage** between exploration and reconstruction in
   `queues/pipeline-job.js` (runPipelineJob): merge per-page understanding models into a
   site-level blueprint (sections/components/routes/tokens), persist as
   `artifacts/<job>/blueprint.json`, thread it into `reconstructFromArtifacts`.
2. **Carry instructions end-to-end**: destructure `instructions` in
   `exploration-runner.js:27` and include it in the payload at :43; consume it in
   `pipeline-job.js` (blueprint input) and make `verify.js:394-395` a real check (e.g.
   blueprint.echo + an instruction-conditioned assertion) instead of `ok:true`.
3. **Make generation consume the blueprint**: `project-generator.js` currently takes only
   dom/css contexts (reconstruction-pipeline.js:372-381); add a blueprint arg that can
   override order, naming, and which regions render; gate understanding.json writes
   (reconstruction-pipeline.js:245) on the blueprint being built first.
4. **Framework preference plumbing**: add `framework` to task creation
   (platform/server.js taskFieldLimits + tasks.js), pass through queueExploration → payload
   → pipeline-job; implement an emitter in `generation/` (new module, e.g. framework emitters
   beside project-generator) or wire the existing `scripts/gen-scaffold.mjs` logic into the
   engine; make exporter's scaffold README line reflect a real artifact.
5. **Parallelize the per-page loop**: page-parallel understanding + generation
   (reconstruction-pipeline.js:221-309) with a bounded pool; keep CSS aggregation serial.
6. **Evidence-gated speed**: replace unconditional MAX_ROUNDS / --fast with an
   evidence-sufficiency check (e.g. skip vision hook + deep interactions only when
   understanding confidence and asset coverage exceed thresholds); wire the existing polish
   budget concept (polish.js:32) into reconstruction.
7. **Fix dead-code / placeholders before reuse**: delete or wire
   `orchestration/pipeline-orchestrator.js`; fix `completeStage` duration
   (task-repository.js:81).
8. **Title/UX polish**: pass captured `title` into `generatePageHtml`
   (project-generator.js:150 currently uses the URL).

## 6. COMPLETION EVIDENCE (what proves the realigned area is done)

- `grep -rni blueprint src/ | wc -l` > 0 and a persisted `artifacts/<job>/blueprint.json`
  referenced by reconstruction-report.json (`node -e` print of report.blueprint).
- POST /api/tasks with `instructions:"make the header sticky"` → the generated project's
  tokens.css/components.css or runtime contains the instruction's effect, and
  `verifyTask` output includes a non-trivially-passing instruction check (not the current
  unconditional `ok:true`).
- A v2 run with `framework:"react"` (or vue) yields a runnable scaffold:
  `cd artifacts/<job>-project && npm install && npm run dev` serves the clone (documented
  command in the export README; `ls scaffold/` in export.zip).
- Parallel reconstruction: run on a ≥5-page artifact dir; report timestamps show per-page
  understanding/generation overlap (reconstruction-report.json round durations shrink vs
  today's serial baseline: bench-documentation run = rounds:1).
- `node scripts/check-runtime-records.mjs artifacts/<job>-project/runtime/interactions.js`
  prints the recorded interaction count matching exploration.json behaviors.
- `node --check` on every touched file; regression: an unchanged v1 run produces
  byte-identical index.html where no blueprint/instructions were supplied.

## Key file map

| Concern | File:line |
|---|---|
| v2 pipeline definition (3 stages) | src/queues/pipeline-job.js:39 (exploration 69, reconstruction 89, verification 102) |
| Dead 5-stage orchestrator | src/orchestration/pipeline-orchestrator.js:15 (never imported) |
| Reconstruction entry | src/reconstruction/reconstruction-pipeline.js:165 |
| Interaction record derivation | src/reconstruction/reconstruction-pipeline.js:48 |
| Per-page generation loop | src/reconstruction/reconstruction-pipeline.js:221-309 |
| Understanding build + persist | src/reconstruction/reconstruction-pipeline.js:241-252; website-understanding.js:487,704 |
| Repair loop (MAX_ROUNDS=2) | src/reconstruction/reconstruction-pipeline.js:27,394-428 |
| Post-loop augmentations | src/reconstruction/reconstruction-pipeline.js:430-504 |
| CSS emission (.cx-N rules) | src/reconstruction/generation/project-generator.js:25-96 |
| Page HTML emission | src/reconstruction/generation/project-generator.js:144-161 |
| Project write (files/assets/pkg) | src/reconstruction/generation/project-generator.js:174-232 |
| Replay runtime | src/runtimeTemplate.js:46-452; matching 169-196 |
| Ad-slot hooks | src/runtimeTemplate.js:464-572 |
| DOM extraction (in-page) | src/intelligence/dom-extractor.js:5-109 |
| Tree build + semantic naming | src/reconstruction/analysis/component-tree-builder.js:4-130 |
| Layout/tokens | src/reconstruction/analysis/layout-analyzer.js:5-117 |
| Understanding record model | src/reconstruction/website-understanding.js:46,487-687 |
| Instruction prompts (LLM modes) | src/prompts.js:24-31 (video), 53-82 (edit) |
| Vision client | src/vision.js:15-189 |
| v1 assemble/mirror flow | src/cloneUrl.js:238-313 |
| Asset download/rewrite | src/assets.js:34-96,112-210 |
| Task creation + instructions field | src/platform/server.js:419-447; tasks.js:31,45 |
| Instructions dropped at enqueue | src/platform/exploration-runner.js:27,43 |
| Fake instruction check | src/platform/verify.js:394-395 |
| Preview v2 serving | src/platform/server.js:768-830 |
| Preview v1 serving | src/server.js:48-68 |
| Chat edit (post-hoc instruction) | src/platform/server.js:834-895 |
| Export (scaffold README line) | src/platform/exporter.js:172 |
| Framework scaffold (manual only) | scripts/gen-scaffold.mjs |
| Stack detection (logging only) | src/browser.js:453-476 |

## Evidence run in this session

- `grep -rni "blueprint" --include="*.js" src/ bin/ | wc -l` → 0
- `node --check` on pipeline-orchestrator.js, reconstruction-pipeline.js,
  project-generator.js, runtimeTemplate.js, assets.js, dom-extractor.js, cli.js,
  cloneUrl.js, website-understanding.js → all OK
- `node -e` summary of artifacts/bench-documentation-mvwxrhct-project/reconstruction-report.json
  → {status:"completed", passed:true, rounds:1, generatedFiles:7, understanding pages 001-007,
  streams ok:1 channel / static notes}
- `node -e` summary of artifacts/bench-documentation-mvwxrhct/pages/page-001/understanding.json
  → 13 components, regions header/navigation/sidebar/workspace/card-grid/card/footer
- `node scripts/check-runtime-records.mjs artifacts/exp-mvw64bt9vmce-project/runtime/interactions.js`
  → ran, parsed embedded array (0 records for that project)
- `grep -n "instructions" exploration-runner.js` → absent from signature/payload
- `grep -rn "gen-scaffold" src/` → 0 hits (manual script only)
