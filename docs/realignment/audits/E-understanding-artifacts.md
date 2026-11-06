# Audit E — Canonical Website Understanding Record & Artifact Contracts

Area: `src/reconstruction/website-understanding.js`, `src/reconstruction/artifact-loader.js`, the
artifact tree written during a clone, and the traceability chain from observed DOM to verified result.
Evidence basis: code reads (path:line), real outputs under `artifacts/exp-mw2g7mm5r76m` (Tradovate,
12 pages, newest full job), `output/bench-*` (v1 flow), `platform-data/tmvv9vf2xhatx` (platform job),
and one executed offline test (§2).

## 1. WHAT EXISTS

**Understanding engine** — `src/reconstruction/website-understanding.js` (717 lines). Public API:
`buildUnderstandingPage(pageArtifacts, opts)` (:487) turns one captured page (dom.json elements +
styles.json + geometry.json + network.json + screenshot) into a per-page unified model;
`pageArtifactsFromLoaded` (:462) adapts `artifact-loader.loadArtifacts().pages[n]`;
`understandArtifactsDir` (:704) whole-dir convenience; `summarizeUnderstanding` (:690).
Deterministic layer: `collectVotes` (:224-360) votes per element from dom-tag/dom-role/dom-aria/
dom-class/geometry/css/repetition sources; vision hook only for containers with confidence < 0.5
(:596-645, default provider "none" → zero network :610); hierarchy pass :564-585; interaction
context pass :587-594 (trigger marks + network-observed img pathnames).

**Evidence type** — `src/reconstruction/component-evidence.js` (447 lines). One record = one
observation: `{ source, ref, note, weight }` (`makeEvidence` :39, closed vocab `EVIDENCE_SOURCES`
:22-32 incl. network/vision). Confidence = per-source MAX weight then noisy-OR across sources,
capped 0.99 (`aggregateConfidence` :52-65). `mergeEvidenceLists` dedups by (source,ref) :71-89.
`electKind` deterministic election :97-118. Cross-page pattern registry `buildComponentRegistry`
(:255-385, structure+behavior+context facets, minPages=2, patternId = "pat-"+sha256[:12] :218),
`annotateUnderstanding` (:413) adds `component.pattern`.

**Loader/validator** — `src/reconstruction/artifact-loader.js` (64 lines). `manifest.json` is the
gate (:17-21, missing ⇒ "not a phase-1 artifact directory"). Per manifest page reads
`pages/{id}/dom.json|styles.json|geometry.json|network.json` + `screenshot-viewport.png`
(:26-46); `graph/states.json` (+ warning if transitions.json missing :52-54);
`assets/manifest.json` + `capturedFromNetwork.entries[].localPath` (:56-60). Distinguishes
missing vs empty vs malformed.

**Phase-1 writers** — `src/pipeline/exploration-pipeline.js` (388 lines) via
`src/storage/artifact-store.js` (`writeJson/writeBinary/writeText/writeManifest` :20-44; recursive
`redact` of credential-shaped keys/URLs :60-74). Writes (line refs are exploration-pipeline.js):
`pages/{id}/screenshot-viewport.png` (:170), `dom.json` (:184), `geometry.json` (:185),
`styles.json` (:188), `responsive.json` first page only (:192-199), `network.json` (:223),
`websocket.json` (:228), `application-state.json` (:235), `graph/routes.json` (:303),
`graph/states.json` (:304), `graph/transitions.json` (:305), `states/index.json` (:306-310),
`assets/manifest.json` (:324), `manifest.json` (:328-346), `reports/exploration-summary.json`
(:347), `reports/coverage-report.json` (:351), `reports/failures.json` (:361), plus
`integrity.json` via artifact-lifecycle (:371-376). Interaction captures: `exploration.json` +
`exploration.md` written by `src/interactions.js:855` into the same root (pipeline passes
`outDir: store.dirs.root` :213); state HTML `states/{pageId}/{tN|mN}.html` (:260); state shots
`_reference/states/`.

**Reconstruction writes** — `src/reconstruction/reconstruction-pipeline.js` (517 lines):
`pages/{id}/understanding.json` (:245, re-written annotated with patterns :446),
`design-tokens.json` in artifactsDir (:322), `reconstruction-report.json/.md` in outDir (:511-514).
Generated project (via `generation/project-generator.js` `generateProject` :372): `index.html` /
route-slug pages, `styles/tokens.css|layout.css|components.css`, `runtime/interactions.js`
(+ workspace.css, responsive.css, streams.js, app-state.js augmentations). **v1 flow**
`src/cloneUrl.js`: `index.html`/`page-N.html` (:260-261), `snapshot.mhtml` (:266),
`design-tokens.json` (:272, browser `tokensV2`), `clone.json` (:273-289), `cloner-runtime.js` (:294).
**Verification** `src/platform/verify.js`: required-artifact lists :251-263
(v1: index.html, clone.json, snapshot.mhtml, exploration.json, design-tokens.json,
cloner-runtime.js; v2: index.html + styles/* + runtime/interactions.js, plus artifactsDir
manifest.json + design-tokens.json :301-305); writes verification result (`_reference/verification.json`
in the real job; stages array with passed flags :650).

**Required-record status table** (name → status → real name / writer):

| Required record | Status | Real name + writer |
|---|---|---|
| routes.json | EXISTS-UNDER-OTHER-NAME | `graph/routes.json` — exploration-pipeline.js:303; `{routes:[{url,source,discoveredAt,score,reasons[],seed}],policy}` |
| pages.json | MISSING | page inventory is `manifest.json.pages[{pageId,url,route,records,domSampled}]` — exploration-pipeline.js:339,346 |
| components.json | MISSING | real: `pages/{id}/understanding.json` — reconstruction-pipeline.js:245,446 (reconstruction-stage, not capture); `job-diagnostics.js:26` allowlists "components.json" — never written |
| interactions.json | MISSING | spread across `dom.json.dataClonerTrigger` (expl-pipeline.js:175-176), `graph/transitions.json` edges, `exploration.json` (interactions.js:855), `states/{pageId}/{tN,mN}.html`, generated `runtime/interactions.js`; re-derived by `deriveInteractionRecords` (reconstruction-pipeline.js:48-104); allowlist name "interaction-records.json" (job-diagnostics.js:25) has zero writers |
| assets.json | EXISTS-UNDER-OTHER-NAME | `assets/manifest.json` — exploration-pipeline.js:324 (buildAssetManifest + capturedFromNetwork) |
| design-tokens.json | EXISTS-AS-NAMED (2 divergent schemas) | artifactsDir: reconstruction-pipeline.js:322 `buildTokens` → `{colors[[hex,count]],backgrounds,fonts,fontSizes,spacing,radii,bodyBackground,bodyColor,sourceEvidence}`; v1 outDir: cloneUrl.js:272 `tokensV2` browser probe (different shape) |
| responsive-layouts.json | MISSING | real: `pages/page-001/responsive.json` — exploration-pipeline.js:198, **first explored page only**; `{captures:[{viewport,width,height,geometry{containers[{cls,w,h,display,flexDirection,gridCols},...]}}]}` |
| exploration-coverage.json | MISSING | real: `reports/coverage-report.json` — exploration-pipeline.js:351; `{routesDiscovered,routesExplored,coveragePct,statesRecorded,budget,efficiency{routes,states}}` |
| screenshots/ | NOT A DIRECTORY | per-page `pages/{id}/screenshot-viewport.png` (:170), state shots `_reference/states/{id}-{label}.png`, responsive `_reference/responsive/*.png`; refs recorded in `graph/states.json.nodes[].screenshotRef` |
| blueprint.json | MISSING | zero hits for "blueprint" in src/ and scripts/ (grep run); also flagged missing in docs/realignment/audits/A-architecture.md:147-149 |

**Schemas observed in the real job** (`node -e` over artifacts/exp-mw2g7mm5r76m, run this session):
- `dom.json`: `{pageId,url,total,sampled,elements,repeated,fixed,sticky,typography}`; element =
  `{i,tag,role,ariaName,id,dataClonerTrigger,href,src,cls,text,parent,children,rect{x,y,w,h},layout{display,position,flexDirection,gridTemplateColumns,justifyContent,alignItems,gap},style{padding,margin,backgroundColor,color,backgroundImage,fontFamily,fontSize,fontWeight,lineHeight,border,borderRadius,opacity,overflow,zIndex,transform}}`; page-001 total=639 sampled=437.
- `styles.json`: `{pageId,typography,bodyStyle,htmlStyle,elements:[{i,tag,cls,style}]}` (style map is a duplicate of dom.json styles; bodyStyle/htmlStyle are the G4.1 additions).
- `geometry.json`: `{pageId,containers(first 60 elements:{i,tag,cls,rect,layout}),fixed,sticky,repeated}` — strict subset of dom.json.
- `network.json`: `{pageId,url,entries:[{ts,phase,method,url,resourceType,headersSize,...}]}` (redacted).
- `websocket.json`: `{schemaVersion,generator,redacted,keepNumbers,channelCount,channels,dropped,events}`. `application-state.json`: `{schemaVersion,generator,errors,dropped,stateCount,states}`.
- `graph/states.json`: `{nodes,edges,stats}`; node `{id,url,parentStateId,fingerprint,interaction,viewport,screenshotRef,domRef,domSig,timestamp,status}`; edge `{id,fromStateId,toStateId,trigger,action,expected,actual,success,evidence}`.
- `exploration.json`: `{generatedAt,statesDir,behaviors:[{trigger{id,label},opens{kind,x,y,w,h},childPanels,screenshot}]}`.
- `understanding.json` page model: `{pageId,url,pageMetrics{width,height,elements},components,regions,relationships{parentChild,repeatedGroups},interactions{triggers,networkEndpoints,networkEntries,imageCount},vision{attempted,screenshotFound,candidates,classifications,used,provider},warnings}`; component `{id:"u-N",kind,elementIndex,tag,cls,role,ariaName,rect,confidence,evidence[{source,ref,note,weight}],provenance{tag,cls,id,role,ariaName,text,href,src,rect,layout,style,childCount,repeated,dataClonerTrigger},parentId,childIds,depth,repeated,interaction{triggers,networkRefs},pattern?{patternId,instanceCount,pages,confidence}}`. Real page-001: 7205x4373 metrics; first component `u-1` navigation conf=0.615 from `dom-aria` (0.45) + `network` (0.3) evidence.

## 2. WHAT ACTUALLY WORKS

- **Executed check**: `node scripts/test-website-understanding.mjs` (offline fixture suite with a
  global fetch tripwire, run this session, <55s, exit 0): **79 passed, 0 failed**. It proves:
  deterministic classification of header/navigation/sidebar/toolbar/workspace/splitter/modal/table/
  chart with confidence ≥0.7 and named evidence sources; table rows/cells never become components;
  parent-child chains through unclassified panes; trigger context (t0-t2 with elementIndex);
  all-strong pages produce ZERO vision candidates; "ZERO NETWORK: no fetch attempted".
- **Real 12-page job** artifacts/exp-mw2g7mm5r76m contains every Phase-1 file plus understanding.json
  for all 12 pages, design-tokens.json (colors `[["#474747",2421],["#ffffff",630]]`,
  sourceEvidence `{stylesElements:4194,designTokens:true,pageRootStyle:true}`), integrity.json,
  and the generated project (styles/*, runtime/{interactions,streams,app-state}.js,
  reconstruction-report.json/md, welcome.html) — `find` output this session.
- **Evidence aggregation contract** verified by code path (component-evidence.js:52-118) + suite
  section [1]; deterministic (pure functions, no clocks/randomness, header comment :17).
- **artifact-loader missing/malformed honesty**: website-understanding degrades with warnings, never
  throws (normalizeElements :81-99; empty model :493-503); loader distinguishes
  missing vs empty vs malformed (:37-45).
- **Redaction** is real: artifact-store.js redact() :60-74 applied to network.json, manifest, reports.
- Not run (out of scope / network): a fresh live clone; the e2e Playwright suites.

## 3. WHAT IS BROKEN / INCOMPLETE / DISCONNECTED

1. **understanding.json is write-only for generation.** `grep -n understanding
   src/reconstruction/generation/project-generator.js` → zero hits. Generation re-derives the tree
   from raw dom.json: `buildComponentTree(lp.dom, lp.pageId)` (reconstruction-pipeline.js:230) and
   re-runs `analyzeLayout` per round (:233-235, :326-332). Only real consumers of the understanding
   model: workspace-analyzer (label corroboration only, workspace-analyzer.js:13,439) and
   skill-integration/style-spec.js:363 (doc string). Verification never reads it (grep verify.js → 0).
2. **No explicit traceability artifact.** The chain exists only implicitly: dom.json `elements[i]` →
   understanding component `u-{i}` (elementIndex, website-understanding.js:407-409) → generated
   element `class="cx-{i}"` (project-generator.js:101, `node._elementIndex ?? "x"`) → wiring attrs
   `data-cloner-trigger` (:121), `data-replay-id` (:130), `data-stream-target` (:135). Nothing
   records file placement, no artifact maps components to generated files, and verification.json
   stages carry no component/element references.
3. **Stale artifact names in job-diagnostics.js:23-26**: allowlists `components.json` and
   `interaction-records.json` — neither has any writer (grep: single hit each, in the allowlist
   itself). Meanwhile the platform can never list understanding.json, reports/*, graph/*,
   integrity.json — they are not in the whitelist (they are ignored by `listArtifacts`).
4. **interactions.json knowledge is reconstructed, not recorded**: `deriveInteractionRecords`
   (reconstruction-pipeline.js:48-104) re-parses exploration.json + states/*.html + dom.json at
   reconstruction time; it silently returns `[]` when exploration.json is absent (:51 catch) — e.g.
   when a caller passes a different outDir, since exploration.json lives wherever interactions.js
   was pointed (interactions.js:855 writes to its own outDir).
5. **geometry.json is a truncated duplicate** of dom.json (`elements.slice(0,60)`,
   exploration-pipeline.js:185) yet the loader treats a missing one as a gap (artifact-loader.js:33,38);
   understanding only uses it as a degraded fallback when dom.json is missing
   (website-understanding.js:90-96).
6. **responsive evidence is single-page and hardcoded**: only page-001 gets responsive.json
   (exploration-pipeline.js:192-199); reconstruction reads `buildResponsiveCss(artifactsDir,
   "page-001")` (reconstruction-pipeline.js:483).
7. **Two design-tokens.json schemas under one name** (v1 cloneUrl.js:272 tokensV2 vs v2
   reconstruction-pipeline.js:322 buildTokens) — verify.js HEX stage (:454, :518) reads the artifacts
   one; the v1 shape would break that stage if cross-read.
8. **Cross-page pattern registry is not persisted**: built and summarized into
   reconstruction-report.json (`report.componentPatterns`, reconstruction-pipeline.js:442) but the
   registry itself (patterns+unlinked+stats, component-evidence.js:372-384) is never written.
9. **blueprint.json does not exist at all** (no writer/reader/schema anywhere).
10. **Doc drift**: past phase reports speak of a "website understanding record" as the core
    contract; in fact the canonical record is per-page understanding.json written mid-reconstruction,
    absent for pages whose reconstruction is skipped (`lp.elements === undefined || lp.emptyEvidence`
    → continue at reconstruction-pipeline.js:225-227, no understanding written).

## 4. REUSABLE AS-IS

- `website-understanding.js` deterministic engine + `component-evidence.js` evidence model: pure,
  offline-testable, 79-test green — direct foundation for a canonical Understanding Record.
- `artifact-loader.js` manifest-gated tree contract + missing/empty/malformed taxonomy.
- `artifact-store.js` writeJson/writeBinary/writeText/writeManifest + recursive redaction.
- `dom.json` element schema (the observed-element anchor: index `i`, tag/role/aria, dataClonerTrigger,
  rect, layout, style) and `understanding.json` component schema (id `u-N`, evidence refs,
  provenance, interaction, pattern).
- `exploration.json` behaviors + `states/{pageId}/{tN|mN}.html` + `graph/transitions.json` edges:
  the recorded interaction-evidence base.
- `reports/coverage-report.json` + `manifest.coverage` block for the coverage record.
- `integrity.json` writeIntegrityManifest hook (exploration-pipeline.js:371-376) — extend for the
  canonical record set.

## 5. WHAT NEEDS MODIFICATION (file-level)

1. **Emit the missing canonical records** (writer: exploration-pipeline.js + reconstruction-pipeline.js):
   `pages.json` (from manifest.pages), `components.json` (merge per-page understanding.json + the
   registry from component-evidence.buildComponentRegistry — persist it, not just the summary),
   `interactions.json` (persist deriveInteractionRecords output at exploration time; keep the
   derivation as fallback), `exploration-coverage.json` (alias/upgrade of coverage-report.json),
   `responsive-layouts.json` (aggregate per-page responsive.json; remove the page-001 hardcode in
   reconstruction-pipeline.js:483 and single-page capture at exploration-pipeline.js:192),
   `screenshots/` (either a real directory convention or an explicit screenshots index recording
   each png + its state refs), and decide `blueprint.json` (build it from components.json +
   transitions + tokens, or remove the name from the architecture).
2. **Unify design-tokens.json** to one schema (recommend the buildTokens shape; migrate
   cloneUrl.js:272 writer and re-point verify.js:454/:518 consumers).
3. **Wire generation to the record**: reconstruction-pipeline.js:230/:233-235/:326-332 should
   consume understanding.json (or an in-memory shared model) instead of re-running
   buildComponentTree/analyzeLayout; keep raw-DOM path only as degraded fallback.
4. **Add a traceability map artifact** (e.g. components.json entries carrying
   `{elementIndex, understandingId, file, generatedClass:"cx-N", wiring:{dataClonerTrigger,
   data-replay-id, data-stream-target}, verification:{check,passed}}`), emitted by
   reconstruction-pipeline.js after generateProject (:372-381) and extended by verify.js stages.
5. **Fix job-diagnostics.js:23-26** whitelist to the real record names (manifest.json,
   understanding.json, graph/*, reports/*, design-tokens.json, integrity.json, exploration.json) and
   drop components.json/interaction-records.json or implement them.
6. **Resolve the geometry/styles duplication**: either document geometry.json as a bounded preview
   and stop loading it as a required page artifact (artifact-loader.js:33), or keep and stop
   re-deriving layout from dom.json.
7. **Write understanding.json for every page even when reconstruction skips it** (empty-evidence
   pages currently get none, reconstruction-pipeline.js:225-227) so the canonical record is complete
   per manifest page.

## 6. COMPLETION EVIDENCE (for the realigned area)

- `node scripts/test-website-understanding.mjs` → exit 0 (baseline now: 79 passed, 0 failed).
- `grep -rn "blueprint\|components.json\|interactions.json\|pages.json\|exploration-coverage\|responsive-layouts" src/`
  → every required name has a real writer+reader or is removed from contracts.
- After a clone + reconstruction: `find artifacts/<job> -maxdepth 2 -type f` shows the canonical
  set incl. pages.json, components.json, interactions.json, design-tokens.json (one schema),
  exploration-coverage.json, screenshots index; `node -e` schema spot-check per record.
- Traceability probe (node script): pick one component in components.json → resolve its
  understandingId → elementIndex → generated file + `cx-N` class present in the emitted HTML →
  `data-replay-id` present when interactions.json wires it → verification.json contains the linked
  check result. Chain resolves end-to-end for every wired component.
- `integrity.json` covers the full canonical record set (writeIntegrityManifest after last write).

## Key file map

| File | Role |
|---|---|
| src/reconstruction/website-understanding.js | Understanding engine; per-page unified model (:487) |
| src/reconstruction/component-evidence.js | Evidence type, confidence, kind election, pattern registry (:39,:52,:97,:255) |
| src/reconstruction/artifact-loader.js | Phase-1 artifact loader/validator (:7-64) |
| src/pipeline/exploration-pipeline.js | Phase-1 capture: writes the artifact tree (:170-376) |
| src/storage/artifact-store.js | Store primitives + redaction (:20-74) |
| src/interactions.js:855 | exploration.json + exploration.md writer |
| src/reconstruction/reconstruction-pipeline.js | understanding.json (:245,:446), design-tokens.json (:322), reports (:511-514), interaction re-derivation (:48-104) |
| src/reconstruction/generation/project-generator.js | Generated HTML carries cx-N/data-cloner-trigger/data-replay-id/data-stream-target (:98-135) |
| src/cloneUrl.js | v1 flow: design-tokens.json (:272), clone.json (:273), cloner-runtime.js (:294) |
| src/platform/verify.js | Required-artifact contracts (:251-263), HEX token stage (:454,:518) |
| src/platform/job-diagnostics.js:23-26 | Stale allowlist (components.json, interaction-records.json) |
| artifacts/exp-mw2g7mm5r76m | Real 12-page job: full Phase-1 tree + understanding.json ×12 + generated project |
| output/bench-tv, platform-data/tmvv9vf2xhatx | v1-flow outputs (index.html, clone.json, design-tokens.json, cloner-runtime.js) |
| scripts/test-website-understanding.mjs | Offline 79-check suite for this area (executed, green) |
