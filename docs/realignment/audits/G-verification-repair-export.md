# Audit G — Verification, Autonomous Repair, Export/Delivery

Repo: `D:/project 2/cloner` (read-only audit). All line cites verified this session.
Checks actually run: `node --check` on 16 files (all OK); `node scripts/test-visual-fidelity.mjs`
→ **35 passed, 0 failed** (live headless-Chromium run, offline local fixture).
Prior-run artifacts read but NOT re-run by me: `artifacts/test-autonomous-repair-result.json`
(30/30), `artifacts/test-responsive-reconstruction-result.json` (56/56). Not run: `scripts/test-context-export.mjs`,
`scripts/test-github-publish.mjs`, `scripts/test-static-export.mjs`, `scripts/test-project-versions.mjs`.

## 1. WHAT EXISTS

**Verification (original-vs-clone, classified defects).**
- `src/reconstruction/visual-fidelity-analyzer.js` (779 L): `analyzeFidelity` (L566) — pixel diff
  on a 12×8 grid (L299, threshold 30, parity with `scripts/compare-clone.mjs`), element pairing
  (`pairElements` L111, index-then-signature), per-axis measurements: `typographyMismatches` L186,
  `colorMismatches` L205 (transparent-RGBA guard, `normalizeColor` L67 never maps alpha-0 → black),
  `stackingMismatches` L223, `geometryDeltas` L244 (tolerance 2px), missing/extra elements L674-681,
  complex-visual region classification `findVisualRegions`/`classifyVisualRegion` L509/L431
  (chart/canvas/svg/map/custom-widget, L350), plus `refineTypography` L721 (token-CSS overrides).
- `src/reconstruction/visual-diff-classifier.js` (294 L): `classifyDefects` L103 → CLASSIFIED
  defect list: `DEFECT_KINDS` = geometry/typography/color/missing-asset/missing-component/stacking
  (L45) + `visual-region` (L56); each defect carries severity (area-weighted, `severityFor` L83),
  salience, confidence, refs, region, original/clone values and a repair `action`. Sorted large-area
  first (L286-292).
- `src/reconstruction/component-evidence.js` (447 L): evidence records + noisy-OR
  `aggregateConfidence` L52; cross-page pattern registry L255 — understanding-side semantics, not
  clone verification.
- `src/reconstruction/responsive-analyzer.js` (820 L): `inferResponsiveRules`,
  `capturePerViewportEvidence`, `augmentProjectWithResponsive` — reconstruction-time only
  (wired at `src/reconstruction/reconstruction-pipeline.js:16,489`).
- `src/platform/verify.js` (702 L): `verifyTask` L626 — 3-stage loop, `MAX_ROUNDS=3` (L22),
  wall-clock budget `CLONER_VERIFY_BUDGET_MS` default 8 min (L640): stage1 functional L88, stage2
  optimization/completeness (~L330-403), stage3 visual L406 (drives `scripts/compare-clone.mjs`,
  writes `_reference/comparison.txt` + `diff.png`, compare-clone.mjs:140-148) + EXACT-HEX token
  comparison `hexTokenComparison` L452. Output `_reference/verification.json` (L700).
- Other comparison engines: `scripts/compare-clone.mjs` (151 L, the stage-3 subprocess);
  `scripts/verify.mjs`, `scripts/verify-mhtml.mjs` (v1-era); `src/reconstruction/intelligence/visual-optimizer.js`
  (importable optimizer, referenced only by tests/intelligence index comment, intelligence/index.js:18-19).

**Repair.**
- `src/reconstruction/repair-planner.js` (242 L): `planRepairs` L165; `REPAIR_KINDS` =
  css-override/token-fix/asset-remap/interaction-rewire/geometry-fix (L43); confidence threshold
  0.6 (L52); grouping + deterministic priority (L191-234).
- `src/reconstruction/repair-executor.js` (287 L): `executeRepairs` L146 — per-action round:
  snapshot → measure relevant check (`DEFAULT_KIND_CHECK` L40: css/geometry/asset→fidelity,
  interaction-rewire→functional) → apply (`applyAction` L125) → re-measure → keep if improved else
  byte-identical rollback (L221); hard stop on first non-improving round (L233-236); unverifiable
  actions never applied (L159-163). `runRepairLoop` L277 one-call hook.
- `src/reconstruction/repair-history.js` (111 L): JSONL history `appendHistory` L95 +
  `snapshotProject`/`restoreSnapshot` L27/L66 (index.html + styles/ + clone-fixes.css surface).
- Loop wiring: `verify.js:661-696` — `autoRemediate` (L512, token overrides + dead-trigger strip)
  first; 3.4.5 defect repairs only when autoRemediate produced nothing; retest = full 3-stage rerun
  next round; `report.repairLoop` stats recorded.

**Export/delivery.**
- `src/platform/exporter.js` (237 L): `exportV2Task` L21 (integrity fail-closed L30-37, staging
  filter L42-51, `verifyStagedTree` L118 fail-closed, docs/INSPECTION.md L59-68, `makeZip` L206
  PowerShell Compress-Archive with entry-name forward-slash rewrite L216-225); v1 `exportTask` L181
  (+ `purgeCredentials` L197, status exported L198). `isSensitiveName` L92 shared by all exporters.
- `src/platform/export-context.js` (359 L): `context.json` contract (pointers-only evidence L125-145,
  redacted env L109, partialState L155, resumePlan L178, canonical-JSON integrity L328) — designed
  to hook into `exportV2Task` (header L22-35) but see §3.
- GitHub publish: `github-publish-real.js` (499 L, mounted `server.js:48` → `/api/github` L592) and
  duplicate `github-publish.js` (266 L, task 4.1.8, used only by `scripts/test-github-publish.mjs`).
- Static targets: `static-export.js` (197 L, static/netlify/vercel + hash-asset rewriting + `verifyLinks`).
- Versions: `version-service.js` (immutable snapshots, rollback, verify).
- Routes (`src/platform/server.js`): POST `/api/export/:id` L899 (v1/v2 dispatch L927, owner-gated
  L904-923, audit + lifecycle event L929-931), GET `/api/export/:id/download` L938 (owner-gated,
  v2 zip in artifacts tree L962-963), GET `/preview/:id` redirect L789, `/preview/:id/*` L790
  (owner-gated L804-808), `makeV2Exporter` L1224 (exportV2Task + finalizeExportV2 L1229-1235).
- Exported ZIP contents: artifacts tree incl. `_reference/` (verification.json, comparison.txt,
  diff.png, clone-verify.png) + `project/` + docs/INSPECTION.md (exporter.js:42-53).

## 2. WHAT ACTUALLY WORKS

- Classified original-vs-clone comparison, proven live: `node scripts/test-visual-fidelity.mjs`
  → 35/35 — six defect kinds present, area-weighted ordering, typography/geometry/color/stacking/
  missing-asset/missing-component all detected and classified, transparent-RGBA never black,
  `refineTypography` cut typography mismatches 2→0 and meanDelta 2.31→1.21 (99.3%→99.87%).
  Determinism asserted across repeated runs (test L167-168).
- Functional comparison: stage 1 replays up to 120 `data-cloner-trigger` controls against runtime
  records (verify.js:98-120, OPEN_GATE 0.6 L23); dead-attribute detection (L380-388).
- EXACT-HEX token comparison works (verify.js:452-505) with absence-is-not-failure rule (L428-430).
- Repair loop: `artifacts/test-autonomous-repair-result.json` (prior run) shows kept repairs
  advancing fidelity 0→0.5→1, functional 0.5→1, plus bounded (`max-rounds`, pending=2),
  rollback-on-no-improvement, and plan stats (5 input, 3 planned, 2 skipped) — the loop is bounded
  and retests. `scripts/repair-audit-chain.mjs`, `scripts/repair-tradovate-clone.mjs` reuse it.
- Export ZIP: v2 path integrity-checked, credential-name filtered at every depth, post-zip
  non-empty-file validation, session shred after export (exporter.js:197-198); route owner-gated
  (server.js:939-954). Download route resolves v2 zips in the artifacts tree (server.js:962-963).
- `/api/github` mount + real REST tree-push flow exists; `test-github-publish.mjs` simulates only
  the remote side (module comment L9-12). Not run by me.
- Syntax: `node --check` passed on all 16 files listed in §1.

## 3. WHAT IS BROKEN / INCOMPLETE / DISCONNECTED

1. **No responsive comparison in verification.** `verify.js` contains zero responsive/breakpoint/
   per-viewport logic (grep for responsive|breakpoint|tablet|mobile over verify.js: empty). Fidelity
   is measured once, at 1440×900, against page-001 only (`measureFidelity`, verify.js:564-581).
   Responsive correctness is only asserted in reconstruction (`test-responsive-reconstruction.mjs`).
2. **Single-page verification.** Only `pages/page-001/screenshot-viewport.png` + `dom.json` feed
   verification (verify.js:564-568); pages 2+ of a multi-page clone are never visually verified.
3. **context.json hook never landed.** `export-context.js:22-35` documents the one-line hook at
   exporter.js:53-54; grep shows `writeContextJson` called only from `scripts/test-context-export.mjs`.
   Exported ZIPs carry no machine-readable recovery record — the whole pointer/integrity/resume
   machinery is library-only.
4. **static-export.js unmounted.** No `staticExportRouter` in server.js → netlify/vercel delivery
   targets unreachable from the product.
5. **version-service.js unmounted.** No `versionsRouter` mount; product code never calls
   `snapshotProject` (only `scripts/test-project-versions.mjs:80`) → Pages 7-8 "version history"
   has no product surface.
6. **Duplicate dead GitHub module.** `github-publish.js` is imported only by its test; server mounts
   `github-publish-real.js` (server.js:48,592). Also `import express` sits at file bottom
   (github-publish.js:266) after usage.
7. **No verification surface in any UI.** `dashboard/app.js`/`dashboard/index.html` have zero
   mentions of "verification"; no consumer of `_reference/verification.json`, `comparison.txt` or
   `diff.png`. The side-by-side data exists on disk but nothing renders it.
8. **INSPECTION.md omits verification.** exporter.js:59-68 embeds only `exploration.md`; the
   delivered build report never mentions verification results, defect counts or known limitations.
9. **Repair-loop gate quirk.** verify.js:661-668: 3.4.5 defect repairs run ONLY when
   `autoRemediate` returned no fixes — rounds where token overrides fired never reach fidelity
   repairs.
10. **Hard-stop conservatism.** repair-executor.js:233-236 stops the whole plan on the first
    non-improving action even though later independent actions target different checks.
11. **Missing components are never repaired** — planner always skips `missing-component`
    ("structural regeneration", repair-planner.js:134-135); the clone ships without them.
12. **No verification gate on export.** `exportV2Task` checks manifest + index.html + integrity
    (exporter.js:25-37), never `verification.json` — failed-verification clones deliver silently
    (limits data lands in the ZIP only incidentally via `_reference/`).
13. **Dead orchestrator.** `src/orchestration/pipeline-orchestrator.js` has no importers (grep);
    its Stage 5 calls the v1 `exportTask(taskId)` (L60) — wrong for a v2 pipeline if revived. The
    real path is `src/queues/pipeline-job.js` (stops at verification; export happens via the route).
14. **Org-scope path mismatch.** `makeV2Exporter` resolves an org-scoped dir (server.js:1228-1230)
    but `exportV2Task` hardcodes legacy `artifacts/<id>` (exporter.js:19). Works today only because
    jobs are still written at the legacy root (artifact-lifecycle.js comment at `resolveArtifactPath`);
    the documented `v2TaskDir → exportV2Dir` hook was never applied.
15. Prior-phase prose (e.g. `docs/COMPLETENESS-AUDIT.md`) claiming export context.json and
    versions are product features overstates reality — they are mounted-library-only.

## 4. WHAT IS REUSABLE AS-IS

- The analyzer+classifier pair: pure, deterministic, grid-geometry parity with compare-clone.mjs,
  proven by my 35/35 run — drop-in for the new defect-classification schema.
- Repair trio (planner/executor/history): bounded, measured, snapshot/rollback, JSONL provenance —
  keep as the repair kernel; only its trigger policy needs work (§3.9-3.11).
- `verify.js` 3-stage skeleton incl. wall-clock budget and honest completed_with_limitations.
- Exporter core: `isSensitiveName` vocabulary, staged-tree fail-closed check, integrity refusal,
  Compress-Archive portability, `purgeCredentials` semantics.
- `export-context.js` in full (build/validate/verify functions) — only the hook call is missing.
- `github-publish-real.js` REST flow + guard (mounted, safety-gated before any network call).
- `_reference/` artifact set (verification.json/comparison.txt/diff.png/clone-verify.png) as the
  side-by-side viewer data source; `verify.js:47-51 regionForCell` for human-readable regions.
- `responsive-analyzer.capturePerViewportEvidence` (L75+) as the missing per-viewport verification
  input — already written for exactly this shape.

## 5. WHAT NEEDS MODIFICATION

- `src/platform/exporter.js`: (a) insert `writeContextJson({ artifactsDir: v2Dir, projectDir,
  staging })` between project copy (L53) and `verifyStagedTree` (L54); (b) switch `v2TaskDir`
  (L19) to `exportV2Dir` from artifact-lifecycle.js for org-scoped exports; (c) extend INSPECTION.md
  (L59-68) with `_reference/verification.json` summary (passed?, stage failures, defect-kind
  counts, repairLoop stats, limitations).
- `src/platform/verify.js`: add a stage-4 responsive comparison (loop `capturePerViewportEvidence`
  over policy viewports + `inferResponsiveRules`-derived media queries, emit per-viewport diffs);
  loop over all `manifest.json` pages instead of page-001 only (L564); change L661-668 so 3.4.5
  repairs run in every failing round (autoRemediate fixes appended, not exclusive).
- `src/reconstruction/repair-executor.js`: replace hard stop (L233-236) with per-action quarantine
  (skip non-improving action, continue plan, stop after N consecutive failures) — or make the stop
  configurable and default it on for interaction-rewire-only plans.
- `src/platform/server.js`: mount `staticExportRouter` and `versionsRouter` (one line each) or
  delete those modules; add `snapshotProject` call in `makeV2Exporter` (L1224) after successful
  export to create version history automatically.
- `src/platform/github-publish.js`: delete or fold into `github-publish-real.js` (keep its
  `express.json` limit behavior).
- `dashboard/app.js`: add verification panel fetching `/preview/:id/_reference/verification.json`,
  `comparison.txt`, `diff.png` (all already owner-gated under `/preview`).
- `src/orchestration/pipeline-orchestrator.js`: delete or fix Stage 5 to call `exportV2Task`.
- `src/reconstruction/repair-planner.js`: add a bounded add-component action (re-emit the captured
  element subtree) instead of unconditional skip (L134-135).

## 6. COMPLETION EVIDENCE

Commands/artifacts that prove the realigned area done:
1. `node scripts/test-visual-fidelity.mjs` → 35/35 (regression baseline; must stay green).
2. `node scripts/test-autonomous-repair.mjs` → 30/30 incl. kept/rollback/max-rounds paths.
3. NEW: an e2e on a 2-page, 3-viewport capture producing per-page, per-viewport
   `_reference/verification.json` entries with responsive defect kinds.
4. `unzip -l artifacts/<id>/export.zip` lists `context.json` (validate: `validateContextStructure`
   + `verifyContextIntegrity` pass) and docs/INSPECTION.md containing a verification summary.
5. `GET /api/export/:id/download` 200 after export; `GET /api/versions/:task` returns ≥1 row
   post-export; `POST /api/static-export` emits a netlify dir passing `verifyLinks`.
6. Dashboard renders verification.json for a completed task (screenshot/manual check).
7. `grep -rn "github-publish.js\"" src/` → no product importers after dedupe.

## Key file map

| Area | File |
|---|---|
| Fidelity engine | src/reconstruction/visual-fidelity-analyzer.js (analyzeFidelity L566) |
| Defect classifier | src/reconstruction/visual-diff-classifier.js (classifyDefects L103) |
| Evidence semantics | src/reconstruction/component-evidence.js (aggregateConfidence L52) |
| Responsive (recon-only) | src/reconstruction/responsive-analyzer.js (L16 wiring: reconstruction-pipeline.js:489) |
| Verify loop | src/platform/verify.js (verifyTask L626, autoRemediate L512, measureFidelity L562) |
| Pixel/heatmap CLI | scripts/compare-clone.mjs (comparison.txt + diff.png L140-148) |
| Repair planner | src/reconstruction/repair-planner.js (planRepairs L165) |
| Repair executor | src/reconstruction/repair-executor.js (executeRepairs L146, runRepairLoop L277) |
| Repair history | src/reconstruction/repair-history.js (snapshot L27, restore L66, JSONL L95) |
| Exporter | src/platform/exporter.js (exportV2Task L21, isSensitiveName L92, makeZip L206) |
| Context export | src/platform/export-context.js (writeContextJson L270 — unhooked) |
| GitHub publish (live) | src/platform/github-publish-real.js (mounted server.js:592) |
| GitHub publish (dead) | src/platform/github-publish.js (test-only) |
| Static targets | src/platform/static-export.js (unmounted) |
| Version history | src/platform/version-service.js (unmounted) |
| Routes | src/platform/server.js (export POST L899, download L938, preview L789-790, makeV2Exporter L1224) |
| Dead pipeline | src/orchestration/pipeline-orchestrator.js (v1 export call L60, no importers) |
| Test evidence | scripts/test-visual-fidelity.mjs (run: 35/35), artifacts/test-autonomous-repair-result.json (30/30, prior run) |
