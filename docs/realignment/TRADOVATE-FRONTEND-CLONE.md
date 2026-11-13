# Tradovate frontend clone — live capture + React rebuild

- **Date:** 2026-11-08
- **Ask:** log into Tradovate in a controlled browser, explore every option/tab, then clone the complete frontend in the same stack as the original (React), working, not static HTML/CSS.
- **Deliverable:** `artifacts/tradovate-frontend-clone/` — React 18 + Vite application, running at `http://127.0.0.1:5199`.
- **Evidence:** `artifacts/tradovate-live-capture/` (live captures) and `artifacts/tradovate-live-capture/clone-verify/` (clone click-through).

## 1. Live capture (controlled browser, authenticated)

Logged into `https://trader.tradovate.com` with the owner-provided credentials from `.env`
(`TV_USER`/`TV_PASS`, never printed to logs), selected **Simulation** on the trading-mode gate,
and walked the live workspace in a visible Chromium window driven by Playwright.

Script: `scripts/tv-capture.mjs` (headed Chrome). It captured:

| Evidence | File |
|---|---|
| 20 module tiles opened one-by-one on a reset workspace | `shots/palette.png`, `shots/module-*.png` |
| Right-rail / top-bar menu attempts | `shots/rail-*.png`, `shots/menu-*.png` |
| Module list + per-module text (column headers, tabs, content) | `evidence/palette.json`, `evidence/modules-summary.txt`, `evidence/modules.json` |
| Full live DOM + stylesheet/script URLs | `evidence/workspace-final.html`, `evidence/workspace.html`, capture output |
| Session exported for reuse (no repeated logins — concurrent-session protection) | `evidence/live-session.json`, `evidence/live-session-storage.json`, `output/tradovate-{cookies,storage}.json` |

Captured module set (exact live order): Market Analyzer, Chart, Stocks Hot List *(New)*, SuperDOM,
Orders, Calendar *(New)*, Positions, Order Ticket, T&S, Trade Performance, Pulse, Spread Matrix,
Options Chain, Code Editor, Log, Reports, Chat, Accounts, News, Legacy Chart.

Design tokens were sampled from the live pixels (region histograms, 1440×900):

- root/workspace `#000000`, module chrome `#202228`, panel `#121212`
- buy/up green `#35a24a` (bright `#1edb27`), sell/down red `#e52545`
- accent blue `#0059d5` / `#056dff`, border `#2a2d35`, text `#ffffff`, muted `#7e838c`
- typography: Roboto, dense 11–12px table text

## 2. The clone

`artifacts/tradovate-frontend-clone/` — React 18 + Vite, zero runtime dependencies beyond React,
no backend, no network calls.

```
src/state/store.jsx     instruments + live quote simulation, orders/fills/positions/accounts,
                        workspace model (columns → groups → module tabs), all actions
src/components/         TopBar, Workspace (resizable), ModuleFrame (tab strips + actions),
                        ModulePalette (20 tiles + workspace templates), RightRail, SidePanel, ui
src/modules/            20 module components, one per Tradovate module
src/styles/             tokens.css (sampled palette), ui.css, app.css, charts.css, modules-a/b.css
```

Behaviour implemented (all interactive):

- **Module palette** with all 20 tiles (click to add, drag-and-drop onto a column), workspace
  templates (`Chart + DOM + Accounts`, `Default`, save-your-own), reset default workspace.
- **Module tab strips** per group with multiple instances (Accounts/Accounts/Accounts as in the live UI),
  add tab, module settings, close, and resizable column/row splitters.
- **Chart module** — canvas candlesticks + EMA/SMA, price/time axes, last-price line, hover
  crosshair with OHLC, symbol/timeframe pickers, Buy Mkt / Buy Bid / Sell Mkt / Sell Ask.
- **SuperDOM** — bid/ask ladder with sizes, current-price highlight, click-to-select price,
  per-row BID/ASK limit orders, position/quantity, Exit at Mkt & Cxl, TP/SL + TIF.
- **Trading flow** — orders reach a shared store, fill in simulation, update Orders / Positions /
  Accounts / Trade Performance; cancel single/all, flatten positions.
- **Right rail panels** — Tradovate Assistant chat (interactive), market watch, alerts (create/delete),
  working orders, Client Services, help, AI assistant, risk settings.
- **Top bar** — account menu, equity/open-P&L tooltip, margin meters, notifications, symbol search,
  live CST clock, workspace prev/next, layout settings.
- **Themes** — sampled dark theme (default) and light theme.

## 3. Verification (evidence)

Build: `vite build` → exit 0, 65 modules transformed, `324 KB` JS / `68 KB` CSS.

Click-through suite (`scripts/tv-verify-clone.mjs`, visible Chrome): **20/20 checks pass, 0 page errors**,
screenshots in `clone-verify/`:

```
PASS shell renders (topbar/rail/modules)
PASS palette opens with 20 module tiles
PASS all 20 palette modules mount with content
PASS rail panel: assistant / market / alerts / orders / people / help / ai / risk
PASS assistant chat replies
PASS top menu: account / notifications / clock / search
PASS placing a market order works
PASS light theme switch
PASS module tab switching
PASS drag & drop module onto a column
```

Module-by-module screenshots: `clone-verify/02-module-<n>-<name>.png` (20 files).
Side-by-side live vs clone: `comparison-live-vs-clone.png`.
Report JSON: `clone-verify/report.json` (`passed: 20, failed: 0, pageErrors: []`).

## 4. Honest limitations

- Market data is a **deterministic simulation** shaped after the captured quotes; order execution and
  fills are simulated locally. The clone never talks to Tradovate's API.
- The assistant answers from local canned/derived logic (the live panel is Ada-backed).
- Some list content (news headlines, calendar rows, option chain) is reconstructed from the capture
  where available and filled with plausible values elsewhere; the structure/columns match.
- The live workspace is a persisted per-user layout; the clone ships the captured
  `Chart + DOM + Accounts` default plus the module palette to rebuild any other layout.

## 5. Reproduce

```bash
cd artifacts/tradovate-frontend-clone
npm run dev          # http://127.0.0.1:5199
node ../../scripts/tv-verify-clone.mjs   # click-through, writes clone-verify/
node ../../scripts/tv-capture.mjs        # re-capture the live app (needs .env creds + network)
```

## 6. Round 2 � reported click bugs + pair coverage

Owner-reported issues: `+` sometimes doing nothing, duplicated panes/tabs in Accounts and for
symbol tabs, and the question whether every pair from the live list is present.

Root causes found (browser reproduction, not guesses):

1. **`+` / palette**: the overlay's close affordance sat on the `+` hotspot and the backdrop was
   click-through, so `+` behaved as a hidden toggle and clicking outside never closed the palette.
   Fixed: `+` is a real open/close toggle, backdrop closes the palette, Escape closes it, and
   drag-and-drop from the palette still works (overlay becomes pointer-transparent mid-drag).
2. **Duplicate panes**: adding a module whose type already existed (Accounts, Orders, �) inserted a
   second pane with the same content. Fixed: it now appends a **tab** to the existing group.
3. **Duplicate symbols**: the module-tab `+` cloned the current symbol tab. Fixed: `+` opens a
   searchable **symbol picker**; choosing a symbol adds a tab for that different pair.
4. **Default duplicates**: the default workspace shipped 3 identical Accounts tabs (copied from the
   owner's persisted live layout); reduced to 1. Duplicate scan over module tabs, selects and table
   rows now returns zero duplicates.

**Pair catalog** � captured `/v1/contract/rollcontracts` from the authenticated session plus the
picker's POPULAR INSTRUMENTS:

| source | pairs |
|---|---|
| live popular instruments (9) | ESZ6, MESZ6, NQZ6, MNQZ6, YMZ6, MYMZ6, MCLZ6, GCX6, MGCZ6 |
| live workspace tabs (2) | MBTX6, 6EZ6 |
| product families (standard specs, Dec-2026) | 6B/6J/6A/6C/6S/6M/6N + micro FX, RTY/M2K/NKD, energies, metals, rates, grains, crypto, equities |

Total: **57 instruments / 5 exchange groups**, one searchable picker everywhere.

Re-verified: **24/24 checks pass, 0 page errors** � including new checks for `+` toggle, tab-not-pane
dedupe, symbol-tab picker, and the pair catalog (`57 rows / 5 groups`, `euro` ? `6EZ6 Euro FX`).
Screenshots: `clone-verify/`, `artifacts/tradovate-live-capture/shots/fix-*.png`.
## 7. Round 3 � "check everything" QA

Harness: `tmp-qa/qa-everything.mjs` (visible Chrome) � for each of the 20 modules: add it via the
real palette, then click **every button / select / role=button** inside it (up to 40 per module),
screenshotted every popup, scanned every open menu for low-contrast text, and compared DOM before/
after each click to flag dead controls.

| Check | Result |
|---|---|
| JS / page errors across all modules + menus | **0** |
| Low-contrast text in any open popup/menu | **0** |
| Dead controls | none (only expected no-ops: active tab click, pin/search toggles) |
| Modules exercised | 20/20 (controls 8�102 each) |
| Multi-chart at once | **4 panes, 4 canvases, 4 independent symbols** |
| Dark-on-dark menus | verified dark `#202228` panel + light text (computed styles + pixel samples) |
| Native select options | forced theme colors (`select option`); light theme white/dark |

Fixes/additions from this pass:

1. Native `<select>` options were transparent/OS-default ? forced `select option` colors per theme,
   so dropdown lists can never go black-on-black.
2. Added the live app's **tab-right-click menu** (Close / Close others / Close all / Duplicate / Settings).
3. Added the live app's **SuperDOM right-click menu** � Exit at Mkt & Cxl, Reverse & Cxl, Cancel All,
   Cancel Offers, Cancel Bids (wired to the order store).
4. Palette `Chart` now always opens a new pane ? genuine multi-chart workspace; table modules still
   dedupe into tabs (Accounts/Orders never duplicate).
5. Chart price axis picks label density from the pane height, so 4�5 stacked chart panes stay readable.

Re-verified end-to-end: **25/25 checks pass, 0 page errors**, screenshots in `clone-verify/` and
`artifacts/tradovate-live-capture/qa-full/`.

Deliberately not implemented (UI clone scope): live Tradovate API/auth, real market data (feed is
simulated), and the Ada-backed assistant (local replies).
## 8. Round 4 � real-app limits vs clone (post-login)

Measured the authenticated live app in a single session (headless + headed; no login debugging):

- **Module palette**: 20 modules (same list captured earlier).
- **Right rail**: 9 icon slots at 44px; assistant is an Ada iframe that sits **off-screen when closed**
  (rect `y=900,h=1`) and can be dismissed; panel header has **End Chat / close**.
- **Charts at once**: no fixed cap. Live how-to docs say "repeat for however many panes you want,
  four is common" ([Tradovate multi-chart guide](https://pickmytrade.trade/how-to/tradovate-multi-chart-layout/)),
  and the in-app flow is palette drag **or** chart right-click ? *Add Chart*. Each new chart module
  opens **empty** and asks for a symbol first.
- **Chart linking**: colour dot per chart; same colour = symbol changes propagate.
- **Global Crosshair**: per-chart toggle.

Clone alignment shipped in this round:

1. Assistant panel **closed by default**; header **?** now actually closes it; **End Chat** clears the
   conversation and closes the panel (was: always open, ? did nothing).
2. Chart palette add opens an **empty pane** with �Pick a symbol� (matches live).
3. Chart **right-click menu**: Add Chart pane, Add Chart (pick symbol), **5 link colours** (symbol sync
   implemented), **Global crosshair** (synced vertical line across charts), Reset chart.
4. Link-colour dot shown in the chart symbol card.
5. Hook-order bug found by the verification suite while adding the empty-chart state � fixed
   (`usePositionQty` hoisted), 0 page errors.

Verification: **25/25 checks pass**, multi-chart check = `panes=4 canvases=4 symbols=ESZ6,GCX6,6EZ6,M2KZ6`.
## 9. Round 5 � pixel diff, content fidelity, studies/drawings, workspace save, stress

Per owner request the login / trading-mode workflow was **removed** again (clone boots into the workspace).

Shipped:

1. **Named workspace persistence** � workspaces saved to localStorage with save/load/delete, top-bar
   switch arrows, tab title; verified to restore a 32-module workspace after reload.
2. **Chart studies + drawings** � Volume, VWAP, Bollinger Bands, EMA9/SMA20/SMA50 toggles and
   horizontal-line drawings on the chart right-click menu.
3. **Content fidelity** � News gained the two extra captured headlines; Options Chain now opens in the
   captured empty-search state and loads the chain after an instrument is picked; Calendar already
   matched the capture.
4. **Assistant** � bigger local knowledge base, typing dots, quick replies, Client Services handoff.
5. **Pixel-diff verification** � clone vs `08-clean.png` at 1440�900: full frame 42.4%, top bar 26.9%,
   right rail 17.8%, assistant 37.6%, accounts 39.1%. Heatmap: `qa-full/pixel-diff-heatmap.png`.
   Residual difference is content (live candles/quotes/tab labels), not chrome.
6. **Stress / over-limit behaviour** � 22 modules ? 32 modules with 12 chart panes: 4.7k DOM nodes,
   36�38 MB heap, 0 errors, palette round-trip ~370 ms, workspace restored after reload. No hard caps.

Verification suite: **25/25 checks pass, 0 page errors** (`clone-verify/report.json`).
## 10. Round 6 � Market Replay + behavioural stress validation

**Market Replay implemented end-to-end.** Account menu ? *Go to Replay* opens a setup dialog
(instrument / interval / session date / speed 1x�30x). Playback advances one bar every `1000/speed` ms,
streams the bar into the shared quote feed (so charts, SuperDOM, quotes all follow), and the chart for
that symbol renders only the replay bars (with a `REPLAY` badge). Controls: Play/Pause, Step +1/+10,
speed, Stop. Playback clock and UI are real; the historical series comes from `buildReplayCandles()` in
`src/state/store.jsx` � swap that one function for an API fetch when real historical data is supplied.

Verified in the suite: `setup ? play (13/160 ? 33/160) ? pause holds ? step advances ? stop closes`.

**Behaviour under load** (32 modules, 12 chart panes, 44 MB heap, 0 JS errors): palette 561 ms,
tab switch 312 ms, chart context menu 340 ms, market order ? FILLED 3.3 s, 8 rail panels 2.7 s,
theme switch 1.6 s, workspace save+reload restores 32 modules in 2.7 s, multi-chart independent symbols.
Layout now enforces minimum pane sizes (so charts stay usable) and columns scroll when overfilled.

Suite extended to **26/26 checks pass** (`clone-verify/report.json`).
## 11. Debug session (investigate skill) — "closed everything → blank above only"

DEBUG REPORT
════════════════════════════════════════
Symptom:  Closing every module pane left a blank workspace — only the top bar rendered and nothing
          could be added back. Reported by the owner as "it just shows me above option nothing else".

Root cause (three defects, all reproduced deterministically):
  1. `src/state/store.jsx` `addModule()` — when the last column was closed, `cols[0]` was undefined and
     the function returned the columns unchanged (`if (!col) return columns;`). Adding a module became
     a silent no-op, so the workspace could never be rebuilt.
  2. `src/App.jsx` — the palette state existed twice: a local `useState` in `Shell` drove
     `<ModulePalette open={paletteOpen}>`, while `Workspace`/`ModuleFrame` called the STORE's
     `setPaletteOpen`. Two independent states meant "Add module" (empty state) and the non-symbol
     module "+" button silently did nothing. Fixed by making the store the single source of truth
     (`paletteOpen, setPaletteOpen` now come from `useTrading()`).
  3. No empty-state UI — with zero columns `Workspace` rendered an empty flex container, so the user
     saw only the top bar with no recovery path.

Fix:
  - `store.jsx`: `addModule()` now recreates a column when none exist (workspace is always rebuildable).
  - `App.jsx`: palette open/close uses the store's state (one source of truth).
  - `Workspace.jsx`: new empty state — "Workspace is empty / All modules were closed" with
    **＋ Add module** and **Reset to default workspace** actions.
  - `app.css`: `.tv-workspace--empty` styling.

Incidental fix (found while debugging): 5 source files (`App.jsx`, `modules/Chart.jsx`,
`modules/OptionsChain.jsx`, `state/store.jsx`, `styles/app.css`) had been re-encoded through CP1252 by
earlier PowerShell rewrites, producing invalid UTF-8 and mojibake (em dashes, ✕, ✓, ◔, ◎, …). All
mojibake was normalised back to correct UTF-8 — 0 files with invalid UTF-8 or mojibake remain.
This matters because the folder is now portable.

Evidence:
  - Repro before fix: closing all modules → `{modules:0, columns:0}`; palette click → nothing.
  - After fix: `{modules:0}` + empty state → click "Add module" → palette (20 tiles) → module mounts.
  - Regression test added to the verification suite:
    `closing all modules shows empty state + add-module recovery — emptyState=1 recoveredModules=1`
  - Full suite: **27 passed / 0 failed**, 0 page errors.

Portability:
  - Folder renamed `artifacts/tradovate-frontend-clone` → **`tradovate clone/`** (repo root).
  - Contents: `src/`, `index.html`, `package.json`, `vite.config.js`, `README.md`, `dist/`,
    `node_modules/` (vendored so it runs offline immediately).
  - README paths rewritten to `../artifacts/...`; `.gitignore` updated to ignore the folder.
  - Verified running from the new location: dev server 200 + full 27-check suite green.

Status: DONE
════════════════════════════════════════
