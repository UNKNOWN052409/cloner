# Frontend audit — 8-page platform-ui vs Stitch design spec
Auditor: frontend-auditor · 2026-11-07 · spec: `docs/realignment/DESIGN-STITCH-UI.md` ·
live reference: `artifacts/stitch-live-test/index.html` (SYNTH_CLONER)

## 1. Live gate (ran this session)

```
$ node scripts/test-platform-ui-live.mjs
== boot: bin/platform.js (memory queue, PG 127.0.0.1:5433) ==
PASS  /healthz answered
PASS  POST /api/auth/register 2xx   PASS  POST /api/auth/login 2xx   PASS  GET /api/auth/me with Bearer
PASS  01-dashboard … 09-progress (all 9 pages: loaded + no JS console errors)
RESULT: PASS=26 FAIL=0  screenshots: 9 in artifacts/platform-ui-gate/
```
Exit 0; all 9 PNGs freshly written 12:39:55–12:40:09 (verified via `ls -l --time-style=full-iso`).

## 2. Greps (ran this session)

- **Raw hex in `platform-ui/pages/` (all 16 files)** — one match only, and it is a
  CSS **ID selector**, not a color: `blueprint.js:92: $("#acc-body").innerHTML = …`.
  → **Zero raw hex colors.** Pages 5–8 re-skin verified clean.
- **Semantic var usage** — 429 `var(--*)` occurrences across pages
  (blueprint.html 116, comparison.html 102, final.html 110, reconstruction.html 86,
  + 15 in page JS). `var(--p-*)` primitives in pages: **0** — pages consume the
  semantic layer only, per the token contract's discipline.
- **Dot-grid** — `body::before` + `radial-gradient(… 1px, transparent 1px)` at 24px
  present in pages 5–8 only: blueprint.html:25, final.html:27, comparison.html:27,
  reconstruction.html:28. **Shell (`platform-ui/style.css`) has no dot-grid** → pages
  1–4 render flat (confirmed visually).
- **Glow** — `linear-gradient|glow|box-shadow` across pages/ + style.css: **0 matches**.
  The ONE sanctioned prompt-box glow border (spec lines 21–22, 50–52) is absent everywhere.

## 3. Per-page compliance (screenshots read this session: 01, 02, 05, 06 of 9)

| Page | Screenshot | Stitch compliance |
|---|---|---|
| 1 Projects | 01-dashboard.png | **Non-compliant.** Top nav bar, not ~300px left sidebar (style.css `.topnav`); no dot-grid; h1 weight 700 19px (style.css:87) vs 64–72px w300–400; boxy 4px buttons (style.css:106–115), no pills; no central prompt card; green accent (#57b577) vs Stitch blue #8ab4f8. Dense table reads admin-tool, not Stitch home. |
| 2 New Clone | 02-new-clone-queued.png | **Partial.** Form functional (URL/credentials/scope/framework/instructions per spec mapping), queued-state chips fine — but no prompt-box hero styling, no glow border, no pill CTA (green filled rect). |
| 3 Exploration | 03-exploration.png | Gate-passed (loaded, bound to task, 0 console errors). Shell look as page 1: flat, top nav, boxy. Not visually re-read. |
| 4 Intelligence | 04-intelligence.png | Gate-passed same convention; shell look as page 1. Not visually re-read. |
| 5 Blueprint | 05-blueprint.png | **Mostly compliant.** Dot-grid visible ✓, light h1 weight 300 (blueprint.html:29) ✓, calm dark ✓, zero raw hex ✓. Missing: glow border on the blueprint card (dashed error-state card instead), pill buttons, sidebar. |
| 6 Reconstruction | 06-reconstruction.png | **Mostly compliant.** Dot-grid ✓, h1 w300 (reconstruction.html:31) ✓, stage pills exist (`.pill` reconstruction.html:44–51) but radius is `var(--radius)`=4px, not rounded-full; swarm viewer embedded in-shell ✓ (spec's "exact same shell while working"). The embedded /progress iframe interior shows a steel-blue tinted panel — non-tokenized surface from public/progress/ styling. |
| 7 Comparison | 07-comparison.png | Grep-verified: dot-grid (comparison.html:27), h1 w300 (:31), 102 semantic vars, zero hex. Not visually re-read. |
| 8 Final | 08-final.png | Grep-verified: dot-grid (final.html:27), h1 w300 (:31), 110 semantic vars, zero hex. Not visually re-read. |

## 4. Root cause — design-tokens.css vs spec token contract

`platform-ui/design-tokens.css` (read in full) contradicts the spec's contract on
three axes: accent is the house green family (`--p-green-1 #57b577`, line 37) not
Stitch blue `#8ab4f8`; `--p-radius: 4px` (line 72) with no `--radius-pill` and no
28px card radius; header comment (lines 7–15) codifies "no gradients at all" and
"small radii only (4px)" — rules that make the spec's sanctioned prompt-glow and
pill buttons unexpressable. Pages 5–8 were correctly re-skinned onto semantic vars,
but the token layer itself was never moved to the Stitch contract.

## 5. Top 3 recommendations

1. **Token realignment first** (`design-tokens.css`): add `--radius-pill: 999px`,
   a card radius (~28px or an intermediate), the Stitch blue accent family
   (`#8ab4f8`/`#c58af9`), and reconcile the "no gradients" rule with the ONE
   sanctioned prompt-box glow — one edit propagates to all 8 pages.
2. **Unify the shell with pages 5–8**: move the dot-grid `body::before` into
   `platform-ui/style.css` (spec line 50 mandates one overlay, not per-page CSS)
   and restyle `.btn` (style.css:106) to pill radius with 1px transparent
   border + 1px `--border-strong`, per the spec's pill-button anatomy.
3. **Page-1 hero + heading scale**: give dashboard the central prompt box
   ("What website shall we clone?" + Web toggle, glow border) and raise headings
   to light weight 300–400 at display scale; current h1 is 700 at 19px
   (style.css:87) — the single biggest "not Stitch" signal in screenshots.

## 6. Not done / limits

- 4 of 9 screenshots visually read (01, 02, 05, 06); pages 3, 4, 7, 8 judged on
  the gate's programmatic pass + greps, not on pixels.
- The destructive-guard regex blocked no needed interaction: the gate script's own
  form fills (URL, "gate fixture task") are its fixture flow, run by the script.
- No commits, no installs; report written to the requested path.
