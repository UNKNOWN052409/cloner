# B — Frontend pages & navigation vs the 8 required product pages

Auditor: Frontend auditor · Date: 2026-11-05 · Method: read-only; every claim cites a file/line or a command run this session.

## 1. WHAT EXISTS

Two disconnected frontend surfaces plus one deleted one:

- **`dashboard/` (3 files, 685 lines)** — the legacy one-run live view, served only by the CLI engine server: `src/server.js:27-28` mounts `/` → `dashboard/index.html` and `/static` → `dashboard/`. Tabs: Clone iframe / Original screenshots / Side-by-side; pipeline step list + log; element-picker edit chat (`dashboard/app.js:1-228`). No routing, no page navigation — it is one screen.
- **`platform-ui/` (REMOVED at HEAD)** — existed only in commit `cdffb15` (index.html 139 lines, app.js 397 lines, style.css 281). A single-page 5-tab workspace: Clone preview iframe, Original screenshot, Compare (diff heatmap + draggable A|B slider), Exploration (behaviors table), Verification (3-stage cards), plus task sidebar with status dots, chat bar (URL → new task), element inspector, export button, WS activity log. Deleted by the latest commit `4327ac8` (`git log --all --diff-filter=D -- platform-ui` → 4327ac8).
- **`src/platform/server.js` is deliberately headless** — comment block at `src/platform/server.js:271-273`: "headless backend (G7.1: the platform's own UI was removed) … There are NO static mounts: '/' and every non-API path fall through to the terminal 404." Only clones are served, under `/preview/:id/*` (`server.js:789-790`).

Backend surfaces a frontend could consume (all verified present): auth `/api/auth/{register,login,logout,me}` (`server.js:224-267`), tasks `POST/GET /api/tasks`, `GET/DELETE /api/tasks/:id`, `POST /api/tasks/:id/chat` (`server.js:418,594,691,720,835`), v2 jobs `POST /api/jobs/explore`, `GET /api/jobs`, `GET /api/jobs/:jobId`, `GET /api/jobs/:jobId/artifacts/*` (`server.js:613-669`), export `POST /api/export/:id`, `GET /api/export/:id/download` (`server.js:899,938`), GitHub publish `/api/github/{status,me,publish}` (`src/platform/github-publish.js:240-253`), sessions `/api/sessions` (`server.js:971`), operator summary `/api/dashboard{,/history}` (`dashboard-routes.js:117,181`), UI config `/api/config/{providers,rotations,…}` (`ui-config-routes.js:234-338`), `/api/intelligence/*` (14 routes, `intelligence-routes.js:83-163`), `/api/orgs`, `/api/keys`, `/api/admin`, `/api/quota/*`, health `/healthz /readyz /metrics`.

`/ws` event stream (`server.js:1000-1123`): on connect a `catchup` replay (500-event ring, `src/events.js:5-27`); client may send `{type:"join",task}`; server forwards exactly `step, log, tabs:found, assets:progress, assets:done, page:goto, run:done, run:error, polish:round` (whitelist `server.js:1087`), plus `preview:reload` (`:891`), `job:status` (queue status bridge, `:1123`), `task:done` (`:1159`).

## 2. WHAT ACTUALLY WORKS

- The **platform API + WS layer is real and complete enough to drive all 8 pages**. Verified end-to-end in the artifact tree: a real v2 job produced `artifacts/bench-documentation-mvwxrhct/` containing `manifest.json`, `design-tokens.json`, `graph/{routes,states,transitions}.json`, `states/index.json`, `assets/manifest.json`, `pages/<id>/{dom,geometry,styles,responsive,network,websocket,application-state}.json`, `reports/{exploration-summary,coverage-report,failures}.json`, and `_reference/` (page-1.png, clone-verify.png, diff.png, verification.json). Writers confirmed in code: `src/pipeline/exploration-pipeline.js:184-361`, `src/reconstruction/reconstruction-pipeline.js:245,322,511-514`, `src/platform/verify.js:700`.
- The deleted platform-ui logic **worked against today's still-mounted routes**: it polls `GET /api/tasks` (still present), creates tasks via chat URL (still present), renders exploration.json (artifacts contract unchanged), exports via `POST /api/export/:id` (present). Its WS handler covers all 13 event types the server can emit (history `platform-ui/app.js:330-355`).
- The picker contract still works: `src/picker.js` is injected into every preview (`server.js:280`), posts `cloner:pick`/`cloner:arm` postMessages; both surviving UIs implement it (`dashboard/app.js:171-189`, history `platform-ui/app.js:229-247`).
- WS fan-out is owner-scoped (loopback anonymous legacy room vs authenticated user rooms, `server.js:1009-1097`), so a restored UI inherits working auth-scoped live updates.

## 3. WHAT IS BROKEN / INCOMPLETE / DISCONNECTED

- **No frontend exists at all for the platform.** Every non-API path 404s (`server.js:271-273`); there is no navigation, no routing, no login screen, none of the 8 pages. The only "UI" is the legacy single-run `dashboard/` on a different server (port 4173) that does not talk to the v2 pipeline.
- **`README-PLATFORM.md` is stale**: it still documents platform-ui as a live component (lines 23, 79-90, 108-145 cite `platform-ui/app.js`, five view tabs, picker wiring) — those files no longer exist at HEAD.
- **`/api/versions` is an orphan**: `src/platform/version-service.js:21-23` documents the mount line `app.use("/api/versions", versionsRouter({ localOrAuthed }))`, and the router is implemented there, but `grep -rn versionsRouter src/platform/server.js` returns nothing — page 8's version history has no API to call until the router is mounted.
- **New-Clone form gaps (page 2)**: `POST /api/tasks` accepts only `url, username, password, cookies, storage, instructions, mode, pipeline` (`server.js:424`). There is no "pages/sections scope" contract (the raw `policy` body field maps to `maxRoutes/maxStatesPerPage` risk knobs, `src/exploration/exploration-policy.js:5-8` — not a page/section picker) and **no output-framework-preference field anywhere** (stack is only detected, never requested — README-PLATFORM.md:118).
- **Live Exploration Workspace gaps (page 3)**: there is no live original-site browser view. The engine captures but does not stream: screenshots land in `pages/<id>/` and `_reference/`, and `page:goto` is a one-line WS event. `POST /api/jobs/explore` starts a job but there is no interactive "browse the original now" relay. Session status exists (`/api/sessions`) but as a bare stats object.
- **Website Intelligence (page 4)**: complete data layer (`graph/*`, `pages/<id>/*`, `design-tokens.json`, `reports/*`), zero UI. Only the deleted exploration behaviors table ever rendered any of it. No combined index endpoint exists — the client must read ~10 artifact files via `GET /api/jobs/:jobId/artifacts/*`.
- **Clone Blueprint (page 5)**: no blueprint artifact of any kind (`grep -rln blueprint src/` → empty). Closest existing material: `pages/<id>/understanding.json` (per-page), `reconstruction-report.json` (output-side).
- **WS visibility for v2 jobs from remote clients**: the whitelist forwards only the 9 legacy bus types; v2 pipeline progress reaches clients almost solely as coarse `job:status` values (`exploring/reconstructing/verifying/...` from `src/queues/pipeline-job.js:66,88,101`). Fine-grained per-stage logs land in `artifacts/<job>/logs/` and `_recon-logs/`, not on the wire.
- **`/api/jobs/:jobId/artifacts/*` serves files but has no directory listing** (`server.js:669`), so a client cannot discover which pages exist without fetching `manifest.json` first.

## 4. WHAT IS REUSABLE AS-IS

- **`platform-ui/app.js` + `index.html` from git history (`cdffb15`)**: the whole interaction skeleton — WS connect/reconnect + catchup replay, task list/switcher, tab view switching, compare A|B divider, exploration table renderer, verification stage cards, picker/inspector postMessage protocol, chat-bar task creation, export flow. All still contracts-compatible with the mounted API. Restore as logic, restyle as pages.
- **`src/picker.js`** and its injection point — unchanged, works for any preview iframe.
- **`dashboard/app.js`**: the desktop-fit preview scaler (`app.js:135-160`) and step/log rendering are directly reusable.
- **Auth + WS room model**: cookies (`cloner_session`, `server.js:264`) + loopback legacy posture mean a same-origin static mount needs no CORS changes.
- **Artifact JSON contracts** (list in §2) — stable, digestible by a new frontend as-is; `GET /api/jobs/:jobId/artifacts/*` is the read path.
- **`/api/dashboard` operator summary** (`dashboard-routes.js:117-181`) already aggregates per-task rows for a dashboard/index page.

## 5. WHAT NEEDS MODIFICATION

- **Serving decision (recommendation): separate SPA source tree, statically mounted by the platform.** Rationale: platform-ui was deliberately removed (G7.1) because a 397-line vanilla file cannot carry 8 product pages; but the headless choice must be reversed for the new product, and one sanctioned static mount + SPA history-fallback (same-origin `/api`, `/ws`, cookies, `/preview` iframes) is the cheapest correct option — no second server, no CORS, auth posture unchanged. Concretely: `app.use("/app", express.static(<dist>))` + fallback to the SPA index for non-`/api`/non-`/preview` GETs, replacing the "terminal 404" comment at `src/platform/server.js:271-273`. Restoring platform-ui verbatim is the fallback option only.
- Per-page verdicts (route names = new SPA routes):
  1. **Projects Dashboard `/projects` — RESTORE-FROM-HISTORY**: platform-ui task sidebar + status dots + `GET /api/tasks`; enrich with `/api/dashboard`.
  2. **New Clone `/projects/new` — REBUILD**: new form page; extend `POST /api/tasks` with `scope` (pages/sections → policy mapping) and `framework` (output preference) fields; backend change required, not just UI.
  3. **Live Exploration `/projects/:id/exploration` — REBUILD** on real data: timeline from `step/log/page:goto/job:status` WS + catchup; screenshots/DOM from `pages/<id>/*`; auth/session from `/api/sessions`. Live original *view* is a new capability (needs a screenshot-polling or CDP-relay endpoint — backend work).
  4. **Website Intelligence `/projects/:id/intelligence` — REBUILD**: pure frontend over existing artifacts (routes/states/transitions, dom.json, assets/manifest.json, design-tokens.json, responsive.json, coverage-report.json, failures.json); add one aggregate index endpoint to avoid ~10 fetches.
  5. **Clone Blueprint `/projects/:id/blueprint` — NEW**: no artifact exists; must be defined (compose from understanding.json + reconstruction-report.json) and emitted by the reconstruction pipeline.
  6. **Reconstruction Workspace `/projects/:id/build` — REBUILD**: parallel tasks/status from `GET /api/jobs(/:id)` + `job:status`; build logs from `artifacts/<job>/logs/` (needs an artifact-listing endpoint); errors/auto-repairs from `reconstruction-report.json` + `verification.json` `fixes`/`repairLoop` (`verify.js:652-667`).
  7. **Comparison & QA `/projects/:id/qa` — RESTORE-FROM-HISTORY + EXTEND**: platform-ui Compare tab (diff.png heatmap + A|B slider) + verification cards cover side-by-side, pixel diffs, defect classes, repair rounds; responsive comparison needs rendering of `pages/<id>/responsive.json`; retest needs a "re-run verification" trigger (exists only implicitly via repair rounds).
  8. **Final Project `/projects/:id/final` — RESTORE-FROM-HISTORY + FIX**: preview iframe `/preview/:id/`, ZIP via `POST /api/export/:id` + `/download`, GitHub via `/api/github/publish`, build report + limitations from `reconstruction-report.json`/`verification.json`; **mount `versionsRouter`** for version history.
- Global nav: one shared shell (top bar with project switcher → 8 routes) is new; platform-ui's 5-tab bar is its embryo.
- Update README-PLATFORM.md to match the realigned UI (currently documents a deleted tree).

## 6. COMPLETION EVIDENCE

The realigned area is done when all of the following hold (commands runnable offline):

1. `curl -s localhost:4180/app/projects | grep -qi "<div id=\"root\"" ` — the SPA is actually mounted (today: 404, per `server.js:271-273`).
2. `node scripts/test-platform.mjs` still passes and its UI-contract assertions (task list, task create, export path) are extended to assert the 8 SPA routes resolve and `/api/versions/:taskId` returns JSON (proving the router mount).
3. A fresh clone run (`POST /api/tasks {url, pipeline:"v2"}`) watched from the SPA shows, per page: Intelligence renders ≥1 route from `graph/routes.json` and token counts from `design-tokens.json`; QA renders `verification.json` stages; Final Project's `POST /api/export/:id/download` returns a ZIP whose `unzip -l` lists `project/index.html` and `docs/INSPECTION.md`.
4. `git grep -n "platform-ui" README-PLATFORM.md` → empty (stale doc removed).
5. One screenshot per SPA page captured against the local fixture (`scripts/serve-fixture.mjs`, offline) showing non-empty content — proving each of the 8 pages is wired, not stubbed.

## Key file map

| Area | Path |
|---|---|
| Legacy single-run UI | `dashboard/index.html`, `dashboard/app.js` (served by `src/server.js:27-28`) |
| Deleted platform UI | `platform-ui/{index,app,style}` at commit `cdffb15` (deleted in `4327ac8`) |
| Headless platform server | `src/platform/server.js` (mounts at :72-201, headless comment :271-273, preview :789-822, chat :835, export :899-938, WS :1000-1123) |
| Tasks/jobs store | `src/platform/tasks.js`, `src/platform/exploration-runner.js`, `src/queues/pipeline-job.js` |
| Event bus | `src/events.js` (500-event ring), whitelist `server.js:1087` |
| Artifacts written per job | `src/pipeline/exploration-pipeline.js:184-361`, `src/reconstruction/reconstruction-pipeline.js:245-514`, `src/platform/verify.js:630-700` |
| Export / publish / versions | `src/platform/exporter.js`, `src/platform/github-publish.js:240-253`, `src/platform/version-service.js` (unmounted) |
| Operator/config APIs | `src/platform/dashboard-routes.js`, `ui-config-routes.js`, `src/platform/intelligence/intelligence-routes.js` |
| Picker | `src/picker.js` (injected at `server.js:280`) |
| Stale doc | `README-PLATFORM.md` (still describes platform-ui) |
