# G6.7 — ai-website-cloner-claudeskill → engine integration mapping

Task: study https://github.com/nelakay/ai-website-cloner-claudeskill (README + `.claude/skills/clone-website/SKILL.md`),
map its three core techniques against OUR engine, implement what is GENUINELY missing as evidence-gated modules,
and document the mapping. Honest verdict allowed ("nothing new") — WITH the mapping table as evidence.

**Verdict: two of the three techniques had real gaps; all three now have engine modules.** The skill's loop
is *spec → parallel build → visual-diff gate with spec correlation*; our engine had the measurement half of
technique 3 and none of the spec/plumbing of techniques 1–2. Details per technique below, then the file map,
then the evidence (commands + results run in this session).

---

## 1. The skill's techniques (source: SKILL.md, fetched this session)

| # | Technique (as the skill specifies it) | Key rules from SKILL.md |
|---|---|---|
| 1 | **Inline computed-style specs** — per-section spec files with exact values | Per-component JS walks the DOM (depth 4, ≤20 children) pulling `getComputedStyle()` values (font metrics, padding/margin, grid/flex, borders, **shadows, transforms, filters**, overflow); multi-state extraction (trigger + before/after + transition); verbatim text; assets; "Every CSS value in the spec is from `getComputedStyle()`, not estimated"; specs live at `docs/research/components/<name>.spec.md` |
| 2 | **Per-section PARALLEL builders with merge** | One builder agent per section, dispatched in parallel worktrees; **~150-line budget** per builder prompt — over-budget sections split into sub-component builders + a wrapper, **sub-components first** (the wrapper imports them); builders receive the full spec inline; each merge is build-verified |
| 3 | **Visual-diff-as-final-gate** | The clone is NOT complete after assembly: compare original vs clone side-by-side **per section** at **1440px and 390px**; every discrepancy is checked against the spec file — "re-extract if the spec was wrong, fix the component if the builder deviated" |

## 2. What OUR engine already had (pre-G6.7, evidence = files read this session)

| Skill need | Engine state before | Where |
|---|---|---|
| Per-element computed styles | ✅ 21 computed props per element captured into `dom.json` (bounded 1200-element sample) | `src/intelligence/dom-extractor.js:5-77` |
| Section classification | ✅ deterministic region classification with evidence records (`header/navigation/sidebar/card-grid/table/...`) written to `understanding.json` | `src/reconstruction/website-understanding.js` (`makeComponent`, `REGION_KINDS:46`) |
| Interaction states | ✅ recorded trigger states (`exploration.json` behaviors + `states/<pageId>/<tN>.html`), replayed in the clone | `src/reconstruction/reconstruction-pipeline.js` `deriveInteractionRecords` |
| Per-element CSS generation | ✅ `buildComponentCss` (one rule per element, `.cx-N`) | `src/reconstruction/generation/project-generator.js:25-65` |
| Visual measurement | ✅ `analyzeFidelity` (12×8 grid, threshold 30, geometry/typography/color/stacking/missing) + `classifyDefects` (area-weighted severity, ranked) | `src/reconstruction/visual-fidelity-analyzer.js:566`, `src/reconstruction/visual-diff-classifier.js:103` |
| Page-level final gate | ✅ verification stage 3: pixel-diff < 60%, token gates, exact-HEX comparison, heatmap | `src/platform/verify.js:399` (`stage3Visual`) |
| Responsive reconstruction | ✅ per-viewport evidence → inferred media queries | `src/reconstruction/responsive-analyzer.js` |

## 3. The genuine gaps → what G6.7 added

### Gap 1 — no per-section spec artifacts, and the capture vocabulary misses the skill's exact values
The computed styles existed only as a flat global element list; nothing grouped them **by section**, and the
extractor never recorded `letterSpacing`, `textTransform`, `boxShadow`, `transform`, `filter`, `transition`,
flex grow/shrink/basis, min/max sizes, `backgroundImage`, per-side borders. Notably `letterSpacing` is compared
by the 3.4.3 defect classifier (`visual-diff-classifier.js:92-98` TYPO_FIELD_WEIGHTS) but was **never captured**
— a permanently-inert defect dimension (the analyzer's own comment at `visual-fidelity-analyzer.js:224-226`
says exactly this).

**Added — `src/reconstruction/skill-integration/style-spec.js`:**
- `buildSectionSpecs({ elements, understanding, interactions, pageId })` — one spec per classified section;
  members carry the **verbatim** captured computed-style objects (byte-exact against `dom.json` — asserted in
  the test), structural paths (`tag.firstClass:nth-of-type(k)` — the replay runtime's scheme, resolvable on the
  original page AND the clone), verbatim text, assets, and linked trigger records. Evidence-gated: no
  understanding components → `ok:false` with the reason; elements outside every section are counted
  `uncovered` — never folded into a fabricated section.
- `EXTENDED_STYLE_PROPS` (23 props) + `captureExtendedStyles(page, paths)` — supplementary in-page
  `getComputedStyle` capture for elements resolved by structural path (bounded: 6 depth / 200 children /
  16 targets per call). Uncaptured props stay absent — a spec value is always a measured value.
- `writeSectionSpecs` / `loadSectionSpecs` — `specs/sec-NNN-<kind>.spec.json` + `specs/index.json` next to the
  artifacts (same side-of-artifacts contract as `design-tokens.json`).

### Gap 2 — generation is one global pass; no per-section independent build, no budget, no merge
**Added — `src/reconstruction/skill-integration/parallel-builders.js`:**
- `planSectionBuilders(specs, { parentOf, budget })` — one builder per section; the skill's **150-line budget**
  (`SPEC_COMPLEXITY_BUDGET = 150`); over-budget sections split into sub-component builders + a wrapper with
  **sub-components dispatched first**; nested sections (member set ⊆ another section's) excluded and recorded;
  every builder carries its input spec **inline** (`inlineSpecFor`, bounded 200 lines).
- `buildSectionFragment(builder, ctx)` — a builder renders ONLY its own subtree, mirroring the production
  renderer's conventions exactly (cited against `project-generator.js renderNode`) and reusing the production
  rule builder `buildComponentCss` so fragment CSS is identical per element to the monolithic path. Optional
  `ctx.extendedByIndex` folds the extended captured values into the built CSS (the skill's "spec drives the
  build" — see B7b below). `buildLeadFragments` renders whatever no section covers (the skill's "lead").
- `mergeSectionFragments({ fragments, plan, leadFragments, parentOf })` — deterministic merge: wrapper markers
  filled with sub-component output, top-level items in document order, sections nested inside lead subtrees
  kept out of top-level placement (recorded in `nestedInLead`), duplicate-selector conflicts resolved
  fail-closed (first in dispatch order wins, every conflict recorded). `writeBuildPlan` → `specs/build-plan.json`.
- Nothing here writes into the production clone; the merge output is a parallel artifact the pipeline MAY adopt.

### Gap 3 — the final gate is page-level at one viewport; no per-section attribution, no spec correlation, no second viewport
**Added — `src/reconstruction/skill-integration/section-gate.js`** (composed ON TOP of the existing
`analyzeFidelity` + `classifyDefects` — same grid, same thresholds, no parallel measurement path):
- `attributeDefectsToSections` — element-ref defects → owning section; region-only (pixel) defects → the
  **smallest** section rect covering the defect's grid cell (deterministic area → sectionId tiebreak).
- `correlateDefectWithSpec` — the skill's "check the spec file" made deterministic:
  `clone-drift` (spec ≈ original, clone deviated → repair against spec) / `spec-drift` (spec ≉ original →
  re-extract) / `uncaptured-property` (field outside the capture vocabulary → capture gap) / `unattributed` /
  `structural`. `repairRoute` per section: `repair-against-spec` or `re-extract`.
- `sectionGate` — per-section pass/warn/fail at documented severities (FAIL 0.4, WARN 0.2); page-level
  fallback mode when no specs exist (honest degradation, never a fabricated per-section pass).
- `dualViewportGate` + `runSectionVisualGate` — the skill's 1440 + 390 legs; the mobile leg decides only when
  real original evidence for it is supplied (`originalByViewport`); absent evidence → the leg is recorded
  `skipped` with the reason, never zeroed. Real browser, real screenshots, real fidelity math; report
  persisted to `specs/section-gate.json`.

## 4. Technique-by-technique mapping table

| Skill technique | Engine before G6.7 | G6.7 module | Status |
|---|---|---|---|
| 1. Per-section computed-style specs | Computed styles captured per element but flat (`dom.json`); no section grouping; vocabulary missing shadows/transforms/filters/letter-spacing; trigger states recorded but not linked to sections | `style-spec.js`: `buildSectionSpecs` + `specs/*.spec.json` + `captureExtendedStyles` (23-prop extended vocabulary, path-resolved) | **Genuine gap — implemented** |
| 2. Per-section parallel builders + merge | Single global generation pass; no decomposition, no budget, no merge step | `parallel-builders.js`: `planSectionBuilders` (150-line budget, subs-first, nested exclusion) + `buildSectionFragment` + `buildLeadFragments` + `mergeSectionFragments` (fail-closed conflicts) | **Genuine gap — implemented** |
| 3. Visual-diff-as-final-gate | Page-level gate at one viewport (`verify.js` stage3Visual) + element-level defects (3.4.3) — measurement existed, but no per-section attribution, no spec correlation, no second viewport | `section-gate.js`: `attributeDefectsToSections` + `correlateDefectWithSpec` + `sectionGate` + `runSectionVisualGate` (1440+390) | **Partial gap — measurement reused, section layer + correlation + dual viewport implemented** |

Determinism / generalization discipline: all three modules are pure functions of captured evidence — no target
names, no fixture vocabularies, no hardcoded selectors (the test fixture itself uses an obfuscated class
vocabulary for the same reason `scripts/test-generalization.mjs` does). Fallbacks are deterministic and honest
(`ok:false` + reason; `uncovered` counts; `skipped` viewport legs).

## 4b. Pre-existing engine limitations DISCOVERED by this work (evidence, not fixed here — the files are integrator-owned)

The new gate turned out to be a diagnostic instrument: driving it with a real fixture surfaced three
pre-existing engine limitations, each reproduced and cited:

1. **`display` is lost for non-flex/grid leaves.** `buildComponentCss`
   (`src/reconstruction/generation/project-generator.js:35-43`) emits `display` only from an
   `analyzeLayout` entry or `style.display` — but the extractor records display in `layout.display`
   (`src/intelligence/dom-extractor.js:36`) and leaves `style.display` unset, and `analyzeLayout` produces no
   entry for plain leaves. A captured `display:block` span therefore renders INLINE in the clone (measured:
   title width 1416px → 597px, and the next sibling shifted −12px because the block margin collapsed).
   The section gate flags exactly this as a header-section FAIL. One-line fix location for the integrator:
   emit `lay?.display ?? el.layout?.display ?? st.display` in `buildComponentCss`.
2. **Captured border-box rects are emitted as content-box widths.** Element rects come from
   `getBoundingClientRect` (border-box); the generated CSS emits them as `width/height`, which the browser
   reads content-box — every padded element renders larger than captured (measured: header 1440→1488px,
   hero 263→311px on a padded fixture). G6.7 fixes this GENERALLY for the per-section build:
   `BORDER_BOX_CORRECTION` (`parallel-builders.js`) prepends `* { box-sizing: border-box }` when the merge
   opts in — generic, derived from the capture model, not from any target. The production generator can adopt
   the same one-liner.
3. **The renderer truncates at 60 children per node** (`src/reconstruction/analysis/component-tree-builder.js:98`,
   `children.map(...).slice(0, 60)`): a 78-child repeated group lost its last 17 elements in the monolithic
   clone while the per-section merge rendered all of them. The test fixture stays at 50 so the equivalence
   comparison compares like with like; the bound itself is the integrator's call.

Each of these was first OBSERVED as a gate failure, then root-caused with in-page measurements — the gate
does its job as a final gate should.

## 5. Files

| File | Role |
|---|---|
| `src/reconstruction/skill-integration/style-spec.js` | Technique 1 — per-section spec files + extended computed-style capture |
| `src/reconstruction/skill-integration/parallel-builders.js` | Technique 2 — builder plan, per-section fragments, deterministic merge |
| `src/reconstruction/skill-integration/section-gate.js` | Technique 3 — section attribution, spec correlation, dual-viewport final gate |
| `scripts/test-skill-integration.mjs` | Suite: Phase A pure unit checks + Phase B real-browser end-to-end |
| `docs/AI-CLONER-SKILL-INTEGRATION.md` | This mapping document |

Pipeline wiring is intentionally NOT changed: `reconstruction-pipeline.js` / `verify.js` are shared files the
integrator owns. The modules are additive and exported with documented hooks (a future integration task can
call `runSectionVisualGate` as an extra verification stage and adopt `mergeSectionFragments` output for the
clone build).

## 6. Evidence (all commands run this session; see also `artifacts/test-skill-integration-result.json`)

- Baseline generalization gate (must stay green):
  `CLONER_ALLOW_PRIVATE_TARGETS=1 node scripts/test-generalization.mjs` → **exit 0, 128 passed, 0 failed, 59.4s**
  (before any G6.7 change) and again AFTER all G6.7 changes → **exit 0, 128 passed, 0 failed, 60.2s**.
  (First run WITHOUT the env opt-in failed with `net::ERR_BLOCKED_BY_CLIENT` on every localhost fixture — the
  engine's private-target guard, `src/security/url-guard.js:111-134`; the opt-in is the documented mechanism.)
- Skill-integration suite: `node scripts/test-skill-integration.mjs` → **69 passed, 0 failed, 11.7s** (final run).
  Highlights, all measured against a real browser and a real local fixture server:
  - B3: 51/51 spec member computed styles **byte-identical** against `dom.json`; 96 structural paths recorded;
    spec files written and read back losslessly.
  - B4: live extended capture resolves 67 paths with 0 unresolved; measured `letter-spacing: 1px` (card
    headings), `letter-spacing: 2px` (hero title), `transform: matrix(1, 0, 0, 1, 0, -4)` (hero ticks) and
    `box-shadow` (cards) — the exact values the stock extractor never records; 85 spec members enriched.
  - B6: the merged per-section output is **render-equivalent to the monolithic generator at maxDelta 0.00px**
    (78/78 elements measured in-page at 1440×900, tolerance 2px), with zero merge conflicts, sub-component
    splitting under a forced 40-line budget, and the nested-in-lead section recorded and not double-emitted.
  - B7: the section gate on the pipeline's own clone — all 9 sections pass (worst severity 0.0833 < 0.4).
  - B7b: the spec-faithful build (extended captured values folded into the built CSS + border-box correction)
    passes the gate without regressing the gate metric, at 63.66% pixel similarity vs the pipeline's 63.22%.
  - B8: a deliberately drifted clone (grid background + heading font-size) FAILS the gate, the **drifted
    section alone** fails with `clone-drift` verdicts (`color#59 rgb(247, 248, 250)→rgb(255, 0, 0)`,
    `typography#62 18px→28px`) and route `repair-against-spec`, and all 8 untouched sections still pass.
  - B9: the mobile (390×844) leg is measured against a real 390px original capture — `dual-gating` mode,
    per-section attribution active on both legs (the mobile leg's honest fail — the pipeline clone carries no
    reproduced media queries for this fixture — is recorded, not masked).
