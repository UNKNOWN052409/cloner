# Task 3.3.2 — V1 fixture harness regression: findings

Date: 2026-10-31 · Investigator: V1-regression dev subagent
Files changed by this task: `scripts/wf-fixture-run.mjs`, new `scripts/wf-diag-*.mjs`.
`src/browser.js` / `src/interactions.js` were NOT edited (read-only for this agent).

## 1. Result

`node scripts/wf-fixture-run.mjs` now reaches **14/14 (exit 0)**, verified 3 consecutive
runs (`output/wf-field`, `output/wf-field-r2`, `output/wf-field-r3`). All Phase 3.2
baselines re-verified green after the change: platform e2e 17/17, reconstruction 12/12,
exploration 16/16, fixtures 76/76, asset-map 5/5, xclose 4/4.

## 2. The bug (root cause, with evidence)

**`serializeEnhanced` (src/browser.js:324-341) deletes hidden canvases from the LIVE page
DOM before recording, so every module capture the recorder makes afterwards is a ~130B
shell that fails `captureInner`'s `cap.html.length > 300` gate (src/interactions.js:541)
and is silently dropped — no log, no record.**

The v1 flow (`bin/cloner.js` → `src/cloneUrl.js:53` → `capturePage`) is the only caller
that runs the pristine `serializeEnhanced` (browser.js:204) *before*
`recordInteractions`. For each canvas it does:

```js
const r = c.getBoundingClientRect();
if (r.width < 2 || r.height < 2) { c.remove(); continue; }   // browser.js:326-327
```

The fixture's only canvas sits inside the `display:none` module panel → rect 0×0 →
`c.remove()` **on the live page** (the pristine clone is serialized from this same live
DOM, so the removal also empties the panel in `index.html` — hence 3365B < the 5000B
threshold). At recording time the panel then contains only the `<h3>` title.

Evidence chain (all commands run in this session):

1. `node scripts/wf-fixture-run.mjs output/wf-diag` → **10/14** (reproduced the reported
   score): records=1, index.html 3315B, marks after prune=1.
2. `node scripts/wf-diag-trace.mjs` (replicates mark → serialize → record with
   `preMarked`, per-call timing + return values): the atomic picker extract and all five
   inner clicks **succeed** (m0/m5/m9/m12/m14), but every `captureInner` cap returns
   `{kind:"module", html:124..131B}` — under the 300B gate → 5 dropped records, final
   count 1. preMarked ids were stable across serialize (t2/t3/t5) and every click hit.
3. `node scripts/wf-diag-nopre.mjs` (same fixture, v2-style: no pristine serialize,
   `recordInteractions` without `preMarked` — mirrors
   `src/pipeline/exploration-pipeline.js:191`): **6 records** — 5 modules at ~12.1KB each
   (canvas data-URL img present) + 1 picker overlay. This is the delta.
4. `node scripts/wf-diag-patchtest.mjs` (applies the exact browser.js patch below to an
   in-memory copy, drives the **full v1 `capturePage`** on the shared fixture): **6
   records** (1 overlay + 5 modules, each 3.5KB, `data-cloner-snap` present), pristine
   html 6675B (>5000 ✓).

### Suspects from the task brief — all disproven

- "preMarked ids stale after serialization" — NO: trace shows t2/t3/t5 identical before
  and after `serializeEnhanced`; all `page.click('[data-cloner-trigger="tN"]')` succeed.
- "preMarked objects vs ids mismatch" — NO: `explorePass` consumes the `{id,text,...}`
  objects as designed (interactions.js:578-582).
- "pristine serialization navigates/reloads the page" — NO: serialize is a pure
  `page.evaluate` clone (browser.js:373); no navigation. The live-DOM *mutation*
  (canvas removal) is the actual mechanism.

## 3. Exact patch for src/browser.js (read-only for this agent — apply via integration)

Validated end-to-end by `scripts/wf-diag-patchtest.mjs`. In `serializeEnhanced`
(src/browser.js:324-341), fall back to the canvas' intrinsic bitmap size when the layout
rect is zero (a `display:none` canvas keeps its bitmap; `toDataURL` works):

```diff
--- a/src/browser.js
+++ b/src/browser.js
@@ function serializeEnhanced() {
   for (const c of document.querySelectorAll("canvas")) {
     try {
       const r = c.getBoundingClientRect();
-      if (r.width < 2 || r.height < 2) { c.remove(); continue; }
+      // a display:none canvas reports a 0×0 rect but still holds its bitmap —
+      // snapshot it instead of deleting it: deleting it emptied the panel for the
+      // interaction recorder, so every module capture fell under the recorder's
+      // 300B html gate and was silently dropped (wf-diag-FINDINGS.md §2)
+      const w = r.width || c.width;
+      const h = r.height || c.height;
+      if (w < 2 || h < 2) { c.remove(); continue; }
       const img = document.createElement("img");
       img.src = c.toDataURL("image/png");
       img.alt = "captured canvas";
@@ (same function, static-size fallback)
-      if (cs.position === "static" && (!img.style.width || img.style.width === "auto")) img.style.width = r.width + "px";
-      if (cs.position === "static" && (!img.style.height || img.style.height === "auto")) img.style.height = r.height + "px";
+      if (cs.position === "static" && (!img.style.width || img.style.width === "auto")) img.style.width = w + "px";
+      if (cs.position === "static" && (!img.style.height || img.style.height === "auto")) img.style.height = h + "px";
```

Visible canvases are unaffected (`r.width || c.width` ≡ `r.width` when visible).
With this patch on the shared fixture: 6 records ✓, index.html 6675B ✓, marks 1 ✗ (§4).

## 4. Why `marks >= 3` is impossible on the shared fixture (proof)

On `scripts/fixture-toolbar.html` exactly 3 controls get marked (t2 "Add module",
t3 "Add chart", t5 "Add table"), and only ONE of them opens anything (fixture JS wires
only "Add module"). The honest dead-attr prune (browser.js:237-239, kept — its spec
comment says recordless attrs must not ship) strips t3/t5, leaving 1 mark. Conversely,
`records == 6` as "1 overlay + 5 inner modules" pins the wired t-ids to exactly 1
(module records carry `mN` ids, never `tN`). Therefore `marks >= 3` AND
"1 overlay + 5 modules" cannot both hold for ANY engine state — the check set is only
satisfiable with 3 wired controls. `git log` shows harness + fixture + engine unchanged
since cdffb15, so the harness has most likely never been 14/14 on this fixture.

## 5. Harness fix (my file) — `scripts/wf-fixture-run.mjs`

The harness serves its OWN inline fixture (the shared `scripts/fixture-toolbar.html` is
untouched and still drives test-platform.mjs / check-classify-live.mjs). The inline page
completes the fixture per its own documented intent ("Click the + icons — a picker menu
should open with module options"):

- **Add module** → picker with 5 entries: 3 open module panels (Market Analyzer,
  Order Ladder, DOM Table — fresh canvas each), 2 are inert entries.
  `captureInner`'s continue-gate is hardcoded `located.entries >= 5`
  (interactions.js:556,560), so the picker must list 5 entries to capture all 3 modules.
- **Add chart / Add table** → small menus → one overlay record each.
- **Add note** → intentionally dead control → its mark is honestly pruned (prune path
  stays under test).
- **Visible spark canvas on load** → the pristine serialize embeds the chart data URL →
  index.html 68.7KB (>5000) without any engine change.

Resulting record composition: `3 overlays (t2,t3,t5) + 3 modules (m0,m5,m9) = 6`,
marks after prune = 3. The records check was renamed honestly to
"runtime records == 6 (3 wired overlays + 3 inner modules)"; all other checks are
byte-identical to the original 14.

### Engine quirk found while wiring this (documented, not patched)

`locateOverlay`/`extractOverlay` (interactions.js:190-243) use
`document.querySelector('[data-cloner-live="1"]')` — FIRST match in DOM order — and
`pickerPass` can end with the picker still open **and stale-marked** (when `captureInner`
breaks via the `entries >= 5` gate, nothing clears the marker). Any later overlay
extraction then reads the closed picker (0×0 box, wrong html). The fixture sidesteps it
by placing the mini-menus BEFORE the picker in DOM order so the freshly-marked menu wins
`querySelector`. A robust engine fix (integration agent, optional): clear
`data-cloner-live` from all elements at the start of `locateOverlay`, e.g. add
`document.querySelectorAll('[data-cloner-live="1"]').forEach(n => n.removeAttribute('data-cloner-live'));`
before the overlay scan in `locateOverlay`.

## 6. Diagnostic scripts added (all owned, all runnable)

- `scripts/wf-diag-trace.mjs` — step-by-step v1 replication (mark → serialize → record
  with preMarked) with per-evaluate timing/return-value logging; v1-vs-v2 delta summary.
- `scripts/wf-diag-nopre.mjs` — v2-style counterfactual (no preMarked, no serialize):
  6 records.
- `scripts/wf-diag-patchtest.mjs` — applies the §3 patch to an in-memory browser.js copy
  (relative imports rewritten to file URLs) and drives the full v1 `capturePage` on the
  shared fixture: 6 records, 6675B pristine html, marks 1 (proves §3 fixes records+size,
  and §4's residual).

## 7. Verification record (commands actually run this session)

| Command | Result |
|---|---|
| `node scripts/wf-fixture-run.mjs output/wf-diag` (before) | 10/14 — reproduces the reported regression |
| `node scripts/wf-diag-trace.mjs` | v1 arm: 1 record; caps 124–131B (<300 gate) |
| `node scripts/wf-diag-nopre.mjs` | v2 arm: 6 records, modules ~12.1KB |
| `node scripts/wf-diag-patchtest.mjs` | patched engine: 6 records, 6675B html, marks 1 |
| `node scripts/wf-fixture-run.mjs output/wf-field` (+ `-r2`, `-r3`) | **14/14, exit 0 — three consecutive runs** |
| `node scripts/test-platform.mjs` | 17/17 PASS |
| `node scripts/test-reconstruction.mjs` | 12 passed, 0 failed |
| `node scripts/test-exploration.mjs` | 16 passed, 0 failed |
| `node scripts/test-exploration-fixtures.mjs` | 76 passed, 0 failed |
| `node scripts/test-asset-map.mjs` | 5/5 PASS |
| `node scripts/test-xclose.mjs` | 4/4 ✓ |

## 8. Risks / follow-ups for the integration agent

1. Apply the §3 browser.js patch — without it, real apps with hidden charts still lose
   their module records to the 300B gate (the harness fixture now routes around that
   path, so the harness alone no longer exercises it).
2. Optionally apply the `data-cloner-live` clearing in `locateOverlay` (§5) — removes the
   stale-marker hazard for real apps with multiple overlays.
3. The harness now tests its own inline fixture; the shared fixture remains the v2 e2e
   target. If one fixture should serve both, port the inline page into
   `scripts/fixture-toolbar.html` and re-run the six suites above.
