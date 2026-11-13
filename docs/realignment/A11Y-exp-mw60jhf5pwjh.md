# A11y Audit — exp-mw60jhf5pwjh (Tradovate clone, 6 pages)

**Auditor**: a11y-auditor subagent · **Date**: 2026-11-07 · **Mode**: headless, file:// only, zero interactions
**Scanner**: the engine's own `checkA11y` from `src/reconstruction/verify-a11y.js` (rules: `accessible-name` medium / `image-alt` low; scan cap 300 elements/page — verify-a11y.js:34)

## Method (exactly what was run)

1. Runner: `node /tmp/a11y-audit-mw60jhf5pwjh/run-a11y.mjs` (kept outside the repo; imports engine modules by absolute `file://` URL). It mirrors engine conventions — `launchBrowser({headless:true})` (src/browser.js:64), `goto(file://…, {waitUntil:"load", timeout:20000})` + 400 ms settle (src/reconstruction/verify-flows.js:150-151), then `checkA11y(p, { file })` (verify-flows.js:237). No clicks, no fills, no network: pure load + in-page scan, so the destructive-guard regex never had a match surface.
2. Raw per-element results: `artifacts/exp-mw60jhf5pwjh/a11y-audit-results.json` (written by the run).
3. Load proof screenshots (headless 1440×900): `artifacts/exp-mw60jhf5pwjh/a11y-shots/{index,page-001-state-0{1..5}}.png`.
4. Flow-matrix comparison input: `artifacts/exp-mw60jhf5pwjh/reports/flow-matrix.json`.

## Per-page results (real scan output)

| page | load | violations | accessible-name | image-alt |
|---|---|---|---|---|
| index.html | ok | 14 | 13 | 1 |
| page-001-state-01.html | ok | 18 | 16 | 2 |
| page-001-state-02.html | ok | **22** | 19 | 3 |
| page-001-state-03.html | ok | **22** | 18 | 4 |
| page-001-state-04.html | ok | 18 | 16 | 2 |
| page-001-state-05.html | ok | 18 | 16 | 2 |

Runner stdout (verbatim tail):

```
[page] index.html: load=true violations=14
[page] page-001-state-01.html: load=true violations=18
[page] page-001-state-02.html: load=true violations=22
[page] page-001-state-03.html: load=true violations=22
[page] page-001-state-04.html: load=true violations=18
[page] page-001-state-05.html: load=true violations=18
[scan] totals: {"violations":112,"accessible-name":98,"image-alt":14}
```

## Aggregates

- **Total: 112 violations** — `accessible-name` 98 (87.5%), `image-alt` 14 (12.5%).
- **Worst pages**: page-001-state-02.html and page-001-state-03.html (22 each; they add the settings dialog's unnamed MUI tab buttons, select controls, and theme icon images on top of the shared shell).
- **Offender families** (rule | tag.first-class → count across pages): `<a .btn>` ~52 (6 recurring icon-button anchors ×6 pages), `<a .account>` 11, `<button .MuiButtonBase-root>` 15 (3 unnamed tabs ×3 pages + 3 unnamed buttons ×2 pages + 1 role=button div per state-02/03), `<select .form-control>` 2 (state-02), `<img>` 14 (logo cx-1 ×5, hash-named png cx-84 ×5+1, theme icons cx-572/573/576 in state-02/03).
- **Engine fixability**: 14/112 carry a `fix` payload (all image-alt); **98 are unfixed-by-contract** — the offending controls have no text at all, and verify-a11y.js:117-119 refuses invented labels (`nameFix` returns null on empty text). Honest residue, not a scanner gap.

## What the offenders actually are (grounded in DOM)

- The dominant family is icon-only navigation: `<a class="cx-5 btn" href="#" data-cloner-unexplored="true"><div class="cx-6 icon"></div></a>` (index.html, verbatim slice) — empty anchors wrapping empty icon divs, 6 of them per page plus account-menu items. No text anywhere in the subtree, hence `fix: NONE`.
- The unnamed MUI `button role="tab"` / `button` / `div role=button` elements mirror the source: in `pages/page-001-state-02/dom.json` the MUI tab buttons have `ariaName: null` too — only the two icon buttons with `ariaName:"close"` had names, and **those were faithfully preserved** (`<button class="cx-481 MuiButtonBase-root" aria-label="close">` in the clone). So most of this debt is inherited from the source site, not fabricated by the cloner — except the dropped source `id` attributes (`settings-tab-*` exist in dom.json, absent in the clone), which cost the clone its only honest naming anchor.
- Two auto-derivation quality bugs found inside the engine's own `altFix` (verify-a11y.js:130-160): for `025746604c66ff01e8ba.png` it emitted alt `"025746604c66ff01e8ba"` (hex-hash filenames pass the "descriptive words" test because only all-numeric stems are rejected at line 151), and for the base64 data-URI logo (img cx-1) it emitted alt `"+TdBXyAAAABklEQVQDAKT0j+GtsGha"` — garbage in both cases; both should have been classified non-descriptive → `alt=""`.

## Consistency with the flow-matrix

`artifacts/exp-mw60jhf5pwjh/reports/flow-matrix.json` is `{"flows":[],"bugs":[]}` — **empty**. Verified why, with the engine's own gate (src/reconstruction/verify-flows.js:79-80 requires `el.dataClonerTrigger` to also appear in runtime-record ids or exploration behaviors):

- source evidence trigger ids: 27 distinct, `t0…t26` (`pages/*/dom.json`)
- runtime record ids: 30, `m0…m298` (`runtime/interactions.js` → `window.__CLONER_INTERACTIONS`)
- intersection: **0** (ran the exact set-intersection: `trigger ids ALSO in runtime recordIds (replayable): 0`)
- fallback path (verify-flows.js:85-88, needs `data-cloner-trigger` attrs in the clone): clone index.html carries 0 such attrs; state pages have `manifest.records: 0`
- `exploration.json` behaviors: `[]`

So the matrix's `a11y-name-alt` E-case (verify-flows.js:133) never executed for this clone — the 112 violations were never surfaced by the standard pipeline. **Verdict: not contradictory — silently blind.** The empty matrix neither confirms nor denies a11y health; this audit's 112 findings are the first measurement. The `note` field that would explain the emptiness ("no replayable recorded interaction clusters", verify-flows.js:297-298) is set in-memory but `finish()` (verify-flows.js:343) writes only `{flows, bugs}`, so the on-disk file doesn't even carry the explanation.

## Recommendations (3 highest-impact)

1. **Bridge the trigger-id namespaces so the flow-matrix actually runs** (t* in dom.json vs m* in `runtime/interactions.js` — zero overlap). One fix re-enables every flow-matrix E-case on this clone family, including the `a11y-name-alt` case that would have caught all 112 violations automatically. Persist explorer trigger ids on the runtime records (or a t*↔m* map in the manifest) — verify-flows.js:79-80 then passes and `buildMatrix` emits flows.
2. **Name the icon-only interactive family at generation time.** ~90 of 112 violations are `<a class="…btn/account" data-cloner-unexplored>` wrappers around icon divs/images with no text. The honest fix source exists upstream: the blueprint/dom capture knows each wrapper's section and wrapped-image identity. Extend the generator to set `aria-label` from the wrapped `<img>`'s (real) alt/asset identity, and preserve source `id` attributes (`settings-tab-*` etc.) so `<label for>`/`aria-labelledby` association survives. This converts most `fix: NONE` residues into engine-fixable ones.
3. **Tighten `altFix`'s "descriptive filename" test (verify-a11y.js:151)** — reject hex-hash stems and `data:` URIs (route both to `alt=""` decorative) instead of emitting `alt="025746604c66ff01e8ba"` / `alt="+TdBXyAAAABklEQVQDAKT0j+GtsGha"`. 10 of 14 image-alt fixes currently attach dishonest values that a repair loop would happily write into the clone.

## Evidence index

- Scan JSON: `artifacts/exp-mw60jhf5pwjh/a11y-audit-results.json`
- Screenshots: `artifacts/exp-mw60jhf5pwjh/a11y-shots/` (6 files, all non-empty)
- Runner: `/tmp/a11y-audit-mw60jhf5pwjh/run-a11y.mjs` (kept out of the repo deliberately)
- Engine scanner: `src/reconstruction/verify-a11y.js`; flow gate: `src/reconstruction/verify-flows.js:79-88, 120-136, 296-299, 343`
