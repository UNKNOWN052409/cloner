# cloner platform — architecture, spec checklist, run-book

The platform is the **product shell** around the cloner engine. The engine
(`src/*.js`) does the reverse engineering; `src/platform/*` turns it into a
task-driven web app with persistent sessions, verification and secure export.
This doc states what is **DONE**, what is **PARTIAL** (what exists, what's
missing) and what is **DEFERRED** (planned, not built) — nothing deferred is
marked done.

> Provenance: every claim below was checked against the tree on 2026-10-30,
> after the concurrent hardening pass (tasks.js userId/PURGE_CREDS_ON_DONE,
> exporter fail-closed staging, verify.js strict stage 3, platform-UI rewrite).
> E2E evidence: task `tmvvaosy320yl` on port 4184 — structural ✓, visual ✓
> (0% diff, grade A), **functional ✗ (one trigger opens nothing — see §10)**,
> export 80,294 bytes, `private/` shredded.

---

## 1. Architecture

```
┌───────────────────────────────────────────────────────────────────────┐
│  platform-ui/  (index.html · app.js · style.css)                      │
│  chat bar · task sidebar + history · 5 view tabs · pick chip +        │
│  element inspector · verification cards · activity dock · settings    │
└──────────────┬───────────────────────────────────┬────────────────────┘
        REST  /api/*                    WebSocket  /ws  (progress feed)
┌──────────────▼───────────────────────────────────▼────────────────────┐
│  src/platform/server.js — Express + ws                                │
│  • POST/GET/DELETE /api/tasks        task CRUD + runner kick          │
│  • POST /api/tasks/:id/chat          vision edit of a selected element│
│  • POST /api/export/:id (+ /download) secure ZIP export               │
│  • GET  /preview/:id/*               clone preview, picker.js injected│
│  • GET  /api/sessions                session-pool stats               │
└───┬──────────────┬───────────────┬────────────────┬──────────────────┘
    │              │               │                │
┌───▼───────┐ ┌────▼────────┐ ┌────▼─────────┐ ┌────▼──────────┐
│ tasks.js  │ │ sessions.js │ │ exporter.js  │ │ verify.js     │
│ store,    │ │ browser pool│ │ fail-closed  │ │ structural →  │
│ history,  │ │ 30-min idle │ │ staging, ZIP,│ │ visual →      │
│ retention │ │ sweep       │ │ creds shredded│ │ functional   │
└─────┬─────┘ └────┬────────┘ └──────────────┘ └────┬──────────┘
      │            │ (pool exists but the task       │ reuses
      │            │  runner does NOT use it yet —   │ scripts/
      │            │  see §14)                       │ compare-clone.mjs
┌─────▼────────────▼────────────────────────────────────────────────────┐
│  ENGINE — one run per task, in-process (server.js runTask)            │
│  cloneUrl.js      pipeline orchestrator (tabs → capture → assets)     │
│  ├ browser.js         Playwright: launch fallback, DOM serialize,     │
│  │                    MHTML snapshot, design tokens, stack detection  │
│  ├ interactions.js    APP EXPLORER: clicks every safe control,        │
│  │                    captures overlays/modules, state screenshots    │
│  ├ assets.js          asset sniff + download + CSS/HTML rewrite       │
│  └ runtimeTemplate.js replay runtime for recorded overlays            │
│  polish.js + vision.js — opt-in vision polish (needs API key)         │
└───────────────────────────────────────────────────────────────────────┘
  events.js bus (500-event ring) ──► server broadcasts (WS) ──► UI log
  CLI twin: bin/cloner.js → src/cli.js (url/image/video + dashboard/, port 4173)
```

**Two servers, one engine.** `bin/platform.js` (port 4180) runs the task
platform. `bin/cloner.js` runs the one-shot CLI with its own live dashboard
(`src/server.js` + `dashboard/`, port 4173). Both drive the same `src/*` engine.

**Data on disk** — `platform-data/<taskId>/`:

| Path | Contents | In export? |
|---|---|---|
| `task.json` | `userId` stub, status, history (≤200 events), verification, artifact map | n/a (excluded) |
| `out/` | `index.html`, `page-N.html`, `assets/`, `cloner-runtime.js`, `exploration.md/json`, `design-tokens.json`, `snapshot.mhtml`, `clone.json`, `_reference/` (page-1.png, diff.png, clone-verify.png, states/*.png, verification.json, comparison.txt) | ✔ (fail-closed staged copy) |
| `private/` | `cookies.json`, `storage.json` — the ONLY credential-bearing files | ✖ never (filtered + shredded on export) |
| `export.zip` | clean ZIP + generated `README.md` + `docs/INSPECTION.md` | is the export |

---

## 2. Spec checklist — 16 sections

### §1 Chat interface — PARTIAL
- **Works:** one chat bar doubles as task launcher (any text containing a URL → `POST /api/tasks`; URL intent wins even with an element picked) and element editor (`POST /api/tasks/:id/chat` → model returns a JSON patch → file rewritten, `chat-fixes.css` appended, `preview:reload` broadcast) — `platform-ui/app.js:188-220`, `src/platform/server.js:69-101`. Pick chip keeps the selection for follow-up instructions (`index.html:85-88`, `app.js:203-209`).
- **Missing:** the edit path hard-fails without a vision key (`server.js:74` → *"no vision model configured … phase 6"*); no persisted per-task conversation history.

### §2 Side-by-side workspace & task history — DONE
- Five view tabs: **Clone** (live preview iframe), **Original**, **Compare**, **Exploration**, **Verification** — `platform-ui/index.html:36-43`.
- Compare is genuinely side-by-side now: diff heatmap **or** an Original|Clone slider with a draggable divider (`index.html:54-72`, `app.js:166-185`).
- Task history: sidebar list with live status dots + relative times, refreshed every 4s (`app.js:28-43,395`); per-task status-event history pane (`index.html:30-31`, `app.js:45-51`, events stored in `task.json` — `tasks.js:37,73-74`); task switcher + status pill (`index.html:16,42`).
- Verification tab renders the 3 stages as cards with per-check rows and metrics (`app.js:135-157`).

### §3 Element selection (browser inspection + picker) — DONE
- `src/picker.js` is injected into every preview at serve time (`server.js:29,63`): hover outline, click-to-select, CSS-selector builder, reports tag/classes/text/outerHTML/computed styles (`picker.js:56-77`).
- Message contracts are aligned (the earlier `cloner-pick`/`cloner:pick` mismatch is fixed): the UI accepts both spellings (`app.js:231`) and arms via `cloner:arm` (`app.js:250` → `picker.js:83`).
- Inspector dock shows tag, selector, live-measured box (same-origin `getBoundingClientRect`), classes, color/background/font/padding/radius, text and HTML (`app.js:263-294`).
- Not implemented: inspecting the *live original* page (selection is clone-only). Verified by code inspection of both message sides this session, not by interactive browser clicking.

### §4 Settings & export UI — PARTIAL
- **Export:** DONE — button enabled on `done|exported` (`app.js:70`), calls `/api/export/:id`, opens the download, logs size + *"credentials shredded"* (`app.js:358-369`).
- **Settings:** a real modal exists — vision-model config snippet + live session-pool inspector (`index.html:114-134`, `app.js:379-390`) — but it only *displays* config; there is no server-side settings write. Provider management remains phase 6 (see §16).

### §5 Complete exploration (interactions.js app explorer) — DONE
- Two-pass explorer: pass 1 clicks every safe interactive control (priority-sorted: pickers/menus/add first), pass 2 re-marks and catches controls *revealed* by pass-1 clicks — `src/interactions.js:510-537`.
- Safety + bounds: dangerous-label regex blocks buy/sell/logout/delete-class controls (`interactions.js:19`), wrapper containers never marked (leaf-first ordering, `interactions.js:84-103`), overall `budgetMs` deadline + per-step hard deadlines (`interactions.js:177-183`), popup/toast dismissal (`interactions.js:43-73`).
- Output: `exploration.json` + human-readable `exploration.md` (trigger → what opens → discovered panels → state screenshot) + `_reference/states/*.png` (`interactions.js:539-560`). Verified on the fixture: 1 behavior + 5 picker entries documented, wired 1/1 (`verification.json` stage-1 check "documented behaviors wired").

### §6 Notifications, dialogs, menus — DONE (capture + replay)
- Overlay locator finds the largest visible modal/dropdown/menu/picker and counts its entries (`interactions.js:187-224`); inner entries are marked and each clicked once to capture child modules/panels (`interactions.js:310-386`), with re-open recovery when SPA re-renders close the picker (`interactions.js:424-436`).
- Replay: `runtimeTemplate.js` ships `cloner-runtime.js` — click any recorded trigger → the captured overlay/module reopens at its recorded position; Escape/outside-click closes; text-signature fallback survives SPA re-renders (`runtimeTemplate.js:12-118`). Wired into the clone's `index.html` by the pipeline (`cloneUrl.js:271-280`).

### §7 Screenshot capture + states + exact snapshot — DONE
- Full-page reference screenshot per run (`browser.js:183` → `_reference/page-1.png`); one screenshot per discovered UI state (`interactions.js:490-494`); clone screenshot during verification (`_reference/clone-verify.png`, used by the A|B slider — `app.js:81`).
- DevTools-grade exactness: CDP `Page.captureSnapshot` MHTML — the *rendered* page with resolved styles, self-contained (`browser.js:249-266`, `cloneUrl.js:243-246`); headers parse-checked in verification (`verify.js:39-59,97`).
- Canvas/WebGL → inline PNG so charts render in the clone; shadow roots → declarative templates; broken images → placeholders (`browser.js:295-356`). Pixel diff + heatmap written by `scripts/compare-clone.mjs` (`_reference/diff.png`, `comparison.txt`).

### §8 Image-to-code / vision polish — PARTIAL, **blocked on API key**
- **Engine exists:** `cloneImage.js` (screenshot → single-file HTML, Stitch-style) and `polish.js` (render clone → compare screenshots → targeted CSS fixes, N rounds) are complete; `design-tokens.json` gives the model the exact color/typography/spacing distribution (`browser.js:413-439`).
- **Blocked:** both require a configured vision key (`cloneImage.js:9-11`); **the platform runner explicitly disables polish today** (`server.js:160` — `cfg.polish = { enabled: false }`, opt-in per task later) and chat-edit needs the key at request time (`server.js:74`). With no key in this environment these paths degrade with warnings instead of failing the run.
- **Missing:** platform-side per-task polish toggle; key management UI (phase 6).

### §9 Stack preservation (scaffold) — PARTIAL
- **Exists:** stack detection at capture time — React/Vue/Next/Nuxt/Angular/Svelte/jQuery + build tool via fiber keys and globals (`browser.js:382-409`), recorded in `clone.json` and logged (`cloneUrl.js:249`).
- **Exists:** `scripts/gen-scaffold.mjs` generates a framework-matched scaffold (React→Vite etc.) with documented components and measured tokens, run manually against a run dir.
- **Missing:** the platform pipeline never invokes the generator — `server.js:168` only records `scaffold` as an artifact *if the directory already exists*, and the exporter advertises it when present (`exporter.js:88`). Wiring the generator into `runTask` is the outstanding step.

### §10 Three-step verification — DONE (and now strict; one live finding)
`src/platform/verify.js` (245 lines) writes `out/_reference/verification.json`:
- Stage 1 **structural** (`verify.js:61-108`): substantive DOM (>5KB), trigger marks present, **every documented exploration behavior wired to its trigger attr**, mark-count parity vs exploration size, **snapshot.mhtml header parse**, runtime records wired.
- Stage 2 **visual** (`verify.js:144-169`): pixel diff via `scripts/compare-clone.mjs` subprocess, pass requires parseable report ∧ <60% differing pixels ∧ ≥1 hot heatmap region ∧ all token-drift rows ≥50%; comparison.txt parsed into named 12×8 grid regions + structured token table (`verify.js:122-142`). Fixture result: 0% differing, grade A.
- Stage 3 **functional** (`verify.js:176-231`): clicks **every** trigger (budget 120, `verify.js:22-23`), asserts overlays open (60% gate), clicks the first inner entry of each opened overlay and asserts a module appears, and enforces **"no decorative buttons"** — every trigger must open something or sit in the empty-module whitelist (`verify.js:178,220-224`).
- **Current finding (honest):** on the fixture task the hardened stage 3 **fails** — trigger `t5` opens nothing and is not whitelisted (2/3 opened, 2/2 inner entries OK). Structural and visual pass. The task still lands `done` and exports fine. This is a real explorer/verifier disagreement to resolve, documented here rather than hidden.
- Honesty note: the runner sets status `"done"` regardless of the verdict (`server.js:170` ternary is `"done"` on both branches) — pass/fail lives in `verification.passed` and in the Verification tab banner, not the status badge.

### §11 Attachments — image & video modes — PARTIAL (CLI only)
- **Works via the CLI engine:** `cloner image <file.png>` (vision → HTML) and `cloner video <file.mp4>` (ffmpeg keyframes → optional Whisper transcript → vision watch → clone + `brief.md`) — `src/cli.js:18-19,138-141`, `cloneImage.js`, `cloneVideo.js`. Full modes with their own prompts and progress events.
- **Missing on the platform:** `POST /api/tasks` accepts and stores a `mode` field (`tasks.js:28`) but the runner ignores it — `runTask` always calls `cloneUrl` (`server.js:161`). Image/video inputs are not accepted through the platform API yet.

### §12 URL / YouTube / Instagram support — DONE (URL mode, with auth-wall caveat)
- URL mode is universal for any `http(s)` target (`server.js:34` validates the scheme): tab discovery across the same registrable domain (`browser.js:443-482`), bot-challenge retry headful (`cloneUrl.js:49-56`), asset sniffer incl. the JSON data layer (`browser.js:109-124`).
- **YouTube/Instagram caveat:** they are plain URL targets, but logged-in/personalized surfaces sit behind auth walls. Clone what an anonymous session sees, or supply cookies/storage (§13) for the authenticated view — consent walls and lazy media may still degrade fidelity. No dedicated YouTube/Instagram adapters exist.

### §13 Credentials & cookies handling — DONE
- Cookie formats: JSON (EditThisCookie/DevTools) and Netscape `.txt` (`browser.js:15-48`); SPA auth via `localStorage`/`sessionStorage` injection (`browser.js:78-87`).
- Storage discipline: raw values are **never persisted** — `task.json` records only `"credentials": "provided"` / `hasCookies` / `hasStorage` flags (`tasks.js:32-34`); session files live in `<task>/private/` during the task.
- **Purge paths:** (a) always on export — `private/` is shredded the moment the ZIP exists (`exporter.js:113`, `purgeCredentials` in `tasks.js:51-56`); (b) opt-in at task end — `PURGE_CREDS_ON_DONE=1` purges on the `done|error` transition (`tasks.js:63-72`). Confirmed today after both fixture exports: `platform-data/<id>/private` gone.
- Login-form detection warns when cookies may be stale (`cloneUrl.js:63`, `browser.js:220-224`).

### §14 Backend architecture — server, sessions, WebSockets, queues, multi-user — mixed
- **Server + API — DONE:** Express with 20MB JSON limit, path-traversal guard on preview (`server.js:56-59`), static UI, task runner wired to the engine with per-task artifact map (`server.js:149-171`).
- **WebSockets — DONE:** `/ws` with catch-up replay of the last 500 bus events on connect (`server.js:127`, ring buffer `events.js:8-24`), join-by-task rooms (`server.js:132`), whitelisted engine events broadcast with the running task tag (`server.js:143-145`); UI auto-reconnects and replays the gap (`app.js:351-355`).
- **Persistent sessions + 30-min idle — PARTIAL:** the pool is real — one long-lived headless browser per session id, released on finish or after 30 minutes of inactivity, swept every minute, closed on process exit (`sessions.js:9,46-56`), stats at `/api/sessions` (surfaced in the Settings modal, `app.js:384-389`). **But `sessions.acquire()` has no caller** — the task runner launches its own throwaway browser per run through `cloneUrl` (`server.js:161` → `cloneUrl.js:29-37`). Wiring acquire/release into the runner so inspection + edit reuse one browser is the pending step.
- **Task queues — PARTIAL:** execution is an in-process async runner kicked directly from the POST handler (`server.js:37`) with a single module-level `currentTaskId` tag (`server.js:146,152`) — concurrent tasks run but their WS events can interleave. **Upgrade path:** a real worker queue (BullMQ/Redis or DB-backed), per-task run contexts instead of the module-level id, N workers behind the API.
- **Multi-user isolation — STUB (as of the concurrent hardening pass):** `createTask` accepts and stores a `userId` (default `"local"`, capped 64 chars — `tasks.js:17,26`, comment: *"stored for the auth phase, not used for isolation yet"*). The server does not pass it and no route (list/preview/export/delete) scopes by it. **For thousands of users this needs:** auth + `userId` scoping on every route, container-per-session or per-user browser pools, a distributed task queue with worker autoscaling, per-user storage quotas, and rate limiting on model endpoints (§8).
- **Retention — DONE:** default 15 days via `RETENTION_DAYS`, guarded against garbage/zero/negative values (`tasks.js:93-98`); sweep at boot + hourly (`server.js:174-176`).

### §15 Export ZIP + credential cleanup — DONE
- Staged clean copy of `out/` with a **recursive, name-based credential filter**: any `private`/staging dir, anything named `*cookie*`, `.env*`, and storage/session/credential/secret naming on data files — while exempting site source like `storage.js` (`exporter.js:24-31`, applied at copy time `exporter.js:53`).
- **Fail-closed:** the staged tree is re-walked before zipping; any offender **aborts the export** (`exporter.js:34-45,93`).
- Ships `docs/INSPECTION.md` (quickstart + the exploration report embedded) and a generated `README.md` manifest (`exporter.js:61-77,80-92`).
- ZIP via PowerShell `Compress-Archive` with entry names rewritten to forward slashes for portability; `zip` fallback; one clear error on failure; zero-size guard (`exporter.js:111,122-152`).
- Verified today: `POST /api/export/tmvvaosy320yl` → `{"ok":true,"size":80294}`, download `200`, `private/` gone, no credentials in the archive.

### §16 API configuration router & UI design direction — DEFERRED (phase 6, planned — not built)
- **OAuth** — no auth on the platform API today; planned: OAuth login + `userId` scoping (the storage stub is in place, §14).
- **Model management** — planned: per-user model settings stored server-side. Today: read-only Settings modal pointing at file config (`cloner.config.json` via `config.js`; presets anthropic/openai/custom/none, `auto` picks the first env key, `config.js:27-72`).
- **Multi-provider API router** — planned: quota-aware routing across multiple keys/endpoints. Today: one provider per process, single 5xx retry in `vision.js:72-76`.
- **GitHub publish** — not built; export is local ZIP only today.
- **UI design direction** — implemented as a near-monochrome black/white foundation with one violet accent (`#8b7cf7`), 4px spacing grid, 1px hairlines, inset top highlight on raised surfaces ("Zed-grade restraint" — `platform-ui/style.css:1-15`), status colors for ok/warn/err/info (`style.css:12-15`). The layout contract — topbar / sidebar+history / tabbed workspace + chatbar / right dock / settings modal — is the stable part field agents restyle within.

---

## 3. Run-book

### Start
```bash
node bin/platform.js            # http://localhost:4180  (default)
node bin/platform.js --port 4182
PORT=4182 node bin/platform.js  # --port wins over PORT (bin/platform.js:5)
```
Ctrl+C stops the platform and closes all sessions. **Testing convention: use
ports 4181-4189** to avoid colliding with other instances.

### Create a task
```bash
curl -X POST http://127.0.0.1:4180/api/tasks \
  -H "content-type: application/json" \
  -d '{"url":"https://example.com","instructions":"clone the toolbar"}'
# optional: "cookies":[...]|cookies-json-string, "storage":{"ls":{},"ss":{}},
#           "username"/"password" (recorded as provided, never stored)
```
or paste a URL into the chat bar and press Enter. Status flow:
`queued → running → verifying → done` (+ `error`), then `exported`.

### Inspect
- **UI:** select the task in the sidebar → tabs Clone / Original / Compare (heatmap or A|B slider) / Exploration / Verification; the dock shows the element inspector and the live activity log; the sidebar History pane lists status events.
- **API:** `GET /api/tasks/:id` (full meta incl. `verification`), `GET /api/sessions` (pool stats).
- **Disk:** `platform-data/<id>/out/` — `exploration.md`, `design-tokens.json`, `snapshot.mhtml` (open in Chrome/Edge for the pixel-exact original), `_reference/states/*.png`, `_reference/verification.json`.

### Verify & export
```bash
curl -X POST http://127.0.0.1:4180/api/export/<taskId>   # {"ok":true,"size":...}
curl -OJ http://127.0.0.1:4180/api/export/<taskId>/download
```
Export = fail-closed ZIP of `out/` + `README.md` + `docs/INSPECTION.md`,
**no credentials ever**; `private/` is shredded on success (and at task end with
`PURGE_CREDS_ON_DONE=1`). `DELETE /api/tasks/:id` removes the task and its
session immediately.

### E2E fixture (repeatable)
```bash
node scripts/serve-fixture.mjs 8123
curl -X POST http://127.0.0.1:4184/api/tasks -H "content-type: application/json" \
  -d '{"url":"http://127.0.0.1:8123/fixture-toolbar.html"}'
# poll GET /api/tasks/<id> until status=done (~30s on this fixture), then export
```
Ran end-to-end on 2026-10-30 (port 4184, current tree): structural ✓ (6 checks),
visual ✓ (0% diff, grade A), **functional ✗** (trigger `t5` opens nothing —
§10), export 80,294 bytes + download 200, `private/` shredded. An earlier run
against the pre-hardening verifier had all three stages pass.

### Tests
`npm test` (vision + integration suites) and `npm run test:platform`
(`scripts/test-platform.mjs`) both exist in `package.json`; neither was run in
this documentation pass — the e2e above is the exercised path.

### Environment
See `.env.example` — `PORT` (server port), `RETENTION_DAYS` (task TTL, default
15, guarded), `PURGE_CREDS_ON_DONE` (purge `private/` at task end; export purge
is unconditional), vision model keys (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`,
`CUSTOM_*`).

### Known gaps (current tree)
- Functional verification vs the fixture explorer: `t5` opens nothing and is not whitelisted (§10).
- `sessions.acquire()` is never called by the task runner (§14) — inspection/edit do not reuse the pooled browser yet.
- Scaffold generator is not wired into the platform pipeline (§9).
- Element picking in the platform UI was verified by code inspection of both message sides, not interactively in a browser this session.
- `mode` is stored on tasks but ignored by the runner — image/video inputs only via the CLI engine (§11).
- Concurrent task progress can interleave on WS (single `currentTaskId` tag, §14).
