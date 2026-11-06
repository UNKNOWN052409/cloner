# Audit C — Browser Session Management & Authentication

Repo: `D:/project 2/cloner` · Read-only audit · All claims grounded in files read or commands run this session.

## 1. WHAT EXISTS

Browser lifecycle:

- `src/browser.js` (655 lines) — the Playwright engine. Cookie import from JSON
  (EditThisCookie/devtools) and Netscape format (`loadCookies`, src/browser.js:20-53);
  `normSameSite` at :54-60. Launch fallback chain bundled chromium → msedge → chrome
  (`launchBrowser`, :64-81); headless default true, caller can pass `headless:false`
  (headful is honored, `const headless = opts.headless !== false`, :66).
  `newContext` (:83-109) creates a context with `ignoreHTTPSErrors`, attaches the SSRF
  request guard (`attachRequestGuard`, src/security/request-guard.js), injects cookies,
  replays localStorage/sessionStorage via `addInitScript` (:88-93), and forces WebGL
  `preserveDrawingBuffer` (:96-107). Per-page capture (`capturePage`, :185-315) detects
  a login form by presence of `input[type="password"]` (:292-296) and returns it as
  `passwordForm` — detection only, never filled here. MHTML CDP snapshot (:321-338).
- `src/browser/browser-pool.js` (594 lines) — per-worker browser pool (task 4.2.6):
  `poolDefaults` env-tunable (:51-71, incl. `CLONER_POOL_HEADED=1` for headful,
  `--disable-blink-features=AutomationControlled` launch arg at :70), warm-context
  reuse keyed on a config signature (cookies+viewport+storage, `configSignature`
  :170-178), navigation-budget recycle (:421-425), real OS-RSS memory ceiling via CDP
  process list + PowerShell/ps (:79-156), sweeper (:482-499), `verifyNoLeaks`
  fail-closed accounting (:528-545), per-worker registry (`createWorkerPool`
  :552-575), `withLease` helper with dirty-context marking (:581-591, comment names
  "login flows" as a dirty trigger).
- Headful retry exists ONLY in the v1 engine: `src/cloneUrl.js:20-32` (`let headless =
  opts.headless !== false`) and the Cloudflare-challenge retry at :55-63 — on
  `isChallenge()` (:334-336, "just a moment" / "verify you are human" / cf-challenge)
  it re-opens the session with `headless = false` and re-captures.

Login / credential flow end-to-end:

- Entry (API): `POST /api/tasks` in `src/platform/server.js:423` destructures
  `{ url, username, password, cookies, storage, instructions, mode, pipeline }` from
  `req.body`; per-field caps `TASK_FIELD_LIMITS` (server.js:350; username/password 500
  chars, cookies/storage ~1.5MB; check at :398-403).
- Task/queue: v2 → `exploration.queueExploration({...})` (server.js:443-447) →
  `src/platform/exploration-runner.js:27-62` puts `username/password/cookies/storage`
  into the queue payload (:39) → `runPipelineJob`
  (`src/queues/pipeline-job.js:46,69-76`) passes them to `runExplorationJob`
  (`src/pipeline/exploration-pipeline.js:33`); payload serialized into Redis on the
  BullMQ path (`src/queues/clone-queue.js:214`). v1 → `tasks.createTask`
  (server.js:503; `src/platform/tasks.js:31-55`) writes session files to
  `platform-data/<id>/private/cookies.json|storage.json` (:36-37) and records only
  `credentials: "provided"` in task.json (:46); v1 runner reloads them
  (server.js:1142-1149) into `cloneUrl` options.
- Login execution: `src/pipeline/exploration-pipeline.js:110-135`. Detects
  `input[type="password"]` (:110-115); if credentials supplied, fills username
  (`input[type="text"], input[type="email"], input[name*="user" i], input[name*="email" i]`,
  :119) and password (:121), submits exactly once — click submit/Login/Sign-in button,
  Enter as fallback (:126-127) — waits 6s (:128), then verifies by re-probing
  `input[type="password"]` presence (:130-131): still present → error
  "authentication may have failed"; gone → "login submitted". Manifest records
  `auth: { loginRequired, credentialsUsed }` (:343).
- Destructive-action policy: `src/exploration/exploration-policy.js` —
  `DEFAULT_POLICY.risk` (:20-26: forbiddenText buy/sell/flatten/reverse/place/submit/
  confirm/pay/purchase/checkout/withdraw/deposit/transfer/logout/delete/remove/
  cancel-order/exit/cxl; forbiddenTypes ["submit"]; forbiddenContainers
  "[role='dialog'] form"; allowedAnchorHref `#`/`javascript:` only),
  `isSafeInteraction` (:46-61), `resolvePolicy` (:35-43).
  The ACTUAL product-path gate is separate: `src/interactions.js:19` hardcodes
  `DANGEROUS` regex (buy|sell|flatten|reverse|order|submit|confirm|logout|close|
  remove|delete|cancel|deposit|withdraw|transfer|place|send|exit|cxl), injected into
  the page-side classifier at :206 (`dangerousSrc`); classifier rejects elements in
  any `form` (`el.closest("form")`, :172-174), anchors with real hrefs (:170-171),
  elements inside modal/dialog (:179-180).
- Session-state capture during exploration: `src/exploration/application-state-capture.js`
  (storage keys + URL state per route; credential-named keys redacted, `CRED_KEY_RE`
  :42/:82) and `src/exploration/websocket-session-capture.js` (payload shapes only,
  credential keys → `{t:"redacted-credential"}`, :41/:80).
- Credential security plumbing: `redact`/`redactText` in
  `src/storage/artifact-store.js:55-76` (JWT regex, secret query-param regex, key-name
  regex); logger scrubs every line (`src/observability/logger.js:29-32`); trace
  attributes drop credential keys (`src/observability/trace-context.js:101-113`);
  `purgeCredentials` + `PURGE_CREDS_ON_DONE` (`src/platform/tasks.js:76-97`;
  `src/config-schema.js:156-163`); exporter excludes `private/` and shreds session
  files at export (`src/platform/exporter.js:44,88-103,197-198`); DLQ copy strips
  credentials (`src/queues/clone-queue.js:73-84,613-621`); DB mirror rows carry only
  `{pipeline, jobId}` options (server.js:460-464, :506-510), no credential values.
- Platform auth (the product's own login, not the target site's): header-only bearer
  sessions (`src/auth/auth-middleware.js:9-27`, token fingerprint :43-53), bcrypt +
  DB-backed sessions (`src/auth/auth-service.js`).

## 2. WHAT ACTUALLY WORKS

- Browser launch chain + contexts: `launchBrowser`/`newContext` are exercised by the
  pool test I ran: `timeout 100 node scripts/test-browser-pool.mjs` → exit 0, final
  line "RESULT: PASS (58/58 checks passed)" — real chromium end to end against a
  local fixture server (warm-context reuse, recycle after navigations, RSS ceiling,
  crash recovery H1-H6, per-worker pools J1-J7, withLease K1-K5, no-leak close).
- Cookie/session injection: code path verified by reading — cookies load
  (src/browser.js:20-53), `addCookies` + storage `addInitScript`
  (src/browser.js:86-93); v1 runner reads back `private/cookies.json`
  (src/platform/server.js:1142-1149). NOT executed end-to-end this session (no
  external site per guardrails).
- Login fill/submit: code path read (exploration-pipeline.js:117-132); not executed
  against a live target. The `scripts/diag-login.mjs` / `scripts/tradovate-login.mjs`
  diagnostics show the same fill-click pattern was run manually against Tradovate in
  past phases (they take env TV_USER/TV_PASS), but I did not run them.
- Exploration is single-context: one page is reused for all routes
  (exploration-pipeline.js:80,153), so post-login cookies/localStorage persist across
  the whole job — verified by reading; same-context reuse across routes has no
  re-login step.
- Redaction: `redact()` read at src/storage/artifact-store.js:55-76; logger line
  scrub at src/observability/logger.js:29-32; WS/app-state credential-key collapse at
  websocket-session-capture.js:78-80 and application-state-capture.js:82.
- Worker pool wiring: `src/workers/worker-pool-manager.js:49-58` spawns real
  clone-worker processes via BullMQ when REDIS_URL is set; the clone-worker executes
  the shared pipeline (src/workers/clone-worker.js:292-310).

## 3. WHAT IS BROKEN / INCOMPLETE / DISCONNECTED

- `isSafeInteraction` is DEAD CODE in the product path: grep for consumers of
  `isSafeInteraction|forbiddenText|risk\.` across src/ returns only an unrelated
  comment (visual-diff-classifier.js:61); `resolvePolicy` is called only in
  exploration-pipeline.js:36 and `policy.risk` is never passed to
  `recordInteractions`. The real gate is interactions.js's separate hardcoded
  DANGEROUS regex (:19) — it omits `pay|purchase|checkout` (present in
  exploration-policy.js:22) and adds `order|send|close` — so the configurable risk
  layer (spec §7/§13) never reaches the explorer.
- Browser-pool is disconnected from the exploration pipeline:
  exploration-pipeline.js:72 still does `launchBrowser({ headless: true })` per job
  (exactly the per-job churn browser-pool.js:1-26 was written to remove). Only the
  worker-pool-manager spawns workers; no product path calls
  `createWorkerPool`/`withLease` outside browser-pool.js itself (grep).
- MFA/CAPTCHA: NO pause-and-request-human behavior anywhere. Grep
  `mfa|captcha|otp|2fa|totp` across src/ matches only cloneUrl.js:336 (Cloudflare
  title detection, which triggers an automated headful retry, not a human pause).
  An MFA-gated login would take the 6s wait, see the password field still present,
  record the error "authentication may have failed" (exploration-pipeline.js:130-131)
  and explore the public state only.
- Auth verification is one weak signal: only "is a password field still on the
  page" (:130-131). No URL-redirect check, no authenticated-UI probe (avatar/
  account menu), no re-probe of a protected route. A soft-failed login (same page
  with inline error, field present) is correctly caught; a login that lands on a
  "session expired" shell with no password input would pass as "login submitted".
- No mid-exploration session re-auth or expiry handling: login happens once at
  pipeline start (:117); routes navigated later (`exploreRoute` :149-275) never
  re-check auth state; an expired session mid-job silently downgrades remaining
  pages to public state.
- Session is NOT preserved after the job: no `ctx.storageState()`/export anywhere in
  src/ (grep storageState → only exporter comments); post-login tokens are actively
  redacted from application-state.json (application-state-capture.js:82). A re-run
  must re-enter credentials; resume explicitly runs WITHOUT session
  (session-recovery.js:268-273).
- Plaintext credential exposure windows: BullMQ path serializes
  `{username, password, cookies, storage}` into Redis job data
  (clone-queue.js:214, payload built exploration-runner.js:39); removal is only
  `removeOnComplete:{count:1000} / removeOnFail:{count:5000}` (:216-219), so
  completed/failed payloads (with raw credentials) sit in Redis until rolled off.
  The DLQ copy is redacted (:613-621) but the live queue copy is not.
  v1 writes `private/cookies.json|storage.json` plaintext on disk (tasks.js:36-37);
  purge only when `PURGE_CREDS_ON_DONE=1` (tasks.js:89-97; config-schema.js:275
  warns it is NOT the default).
- Database: `task-repository.js` does NOT store credentials — `createTask` persists
  `options` only (task-repository.js:5-13) and callers pass `{pipeline, jobId}`
  (server.js:460, :506). `job-diagnostics.js:96` comment "never credentials —
  createTask does not persist them" is accurate as of this code.
- Dead / cosmetic: `completeStage` computes `const duration = Date.now() - Date.now()`
  (task-repository.js:78) — always 0, unused.

## 4. WHAT IS REUSABLE AS-IS

- `src/browser.js` launch fallback, cookie loading (JSON + Netscape), storage
  replay, SSRF-guarded contexts — Step B "establish session" primitive, unchanged.
- `src/browser/browser-pool.js` in full — 58/58 offline checks pass; warm-context
  reuse keyed by cookie signature is exactly what a logged-in exploration needs.
- The login fill/submit core (exploration-pipeline.js:117-129) — correct single-
  submit semantics (comment: racing both double-submits real login forms).
- Redaction stack (artifact-store.redact, logger scrub, WS/app-state CRED_KEY_RE,
  audit SENSITIVE_KEY) — reusable unchanged.
- Credential lifecycle: `private/` dir convention, purgeCredentials,
  PURGE_CREDS_ON_DONE, exporter shred, DLQ redaction, task.json "provided" marker.
- v1 headful challenge retry pattern (cloneUrl.js:55-63) as the seed for a
  human-in-the-loop pause.

## 5. WHAT NEEDS MODIFICATION (file-level)

1. Wire `policy.risk`/`isSafeInteraction` into `src/interactions.js` (replace or
   merge with the hardcoded DANGEROUS at :19; accept a policy arg in
   `markTriggers`/`recordInteractions` and thread it from
   exploration-pipeline.js:36) so the configurable blocklist actually applies.
2. Rewire `src/pipeline/exploration-pipeline.js:72` to acquire from a worker
   BrowserPool (`withLease`, markDirty after login/interaction recording) instead
   of a per-job `launchBrowser`.
3. Harden verification at exploration-pipeline.js:130-135: probe a
   authenticated-state signal (URL change, absence of login UI, presence of an
   account/avatar control, or a protected-route re-fetch) and record a structured
   `authVerified` in the manifest (:343) instead of the single password-field probe.
4. Add MFA/CAPTCHA pause-and-human: on post-submit interstitial (password field
   persists / challenge titles per cloneUrl.js:334-336), suspend the page with a
   bounded grace timer, expose job status `awaiting_human`, and let the API surface
   a take-over window — new state in exploration-runner entry + a route in
   src/platform/server.js.
5. Redact the BullMQ queue payload: apply `redactCredentials`
   (clone-queue.js:76-84) to the LIVE enqueue (:214) and re-supply credentials
   worker-side from `private/` (v1-style), or encrypt at enqueue; keep DLQ as-is.
6. Default `PURGE_CREDS_ON_DONE=1` in production config validation
   (config-schema.js:275 already warns; make it an error in production mode).
7. Persist a post-login session snapshot (opt-in, to `private/session-state.json`
   via `ctx.storageState()` with credential-value scrubbing) so Step B can rehydrate
   a session for later exploration passes without re-typing credentials; shred with
   the same purge path (tasks.js:76-81).
8. Optional hardening: per-site login heuristics (email+password split forms,
   OAuth buttons) — current selector list (exploration-pipeline.js:113,119,126)
   handles simple username/password forms only.

## 6. COMPLETION EVIDENCE (what proves the realigned area is done)

- `timeout 100 node scripts/test-browser-pool.mjs` → all checks PASS (baseline
  58/58 recorded this session).
- New offline suite: fixture login page served locally (like the
  test-browser-pool.mjs fixture server) asserting fill→submit→verify→
  session-persist across 2 or more routes, plus a fixture MFA page asserting the
  awaiting-human pause and resume.
- `grep -rn "isSafeInteraction" src/interactions.js` returns a call site;
  `grep -n "launchBrowser" src/pipeline/exploration-pipeline.js` returns no
  per-job launch.
- Artifact proof: `artifacts/<jobId>/manifest.json` contains
  `auth: {loginRequired, credentialsUsed, authVerified:true}`; `logs/job.log`
  contains no credential values (logger scrub holds).
- Redis proof: after enqueue, the clone queue job data shows no password/cookie
  values (only markers); the DLQ copy keeps `credentialsRedacted:true`.
- Export proof: exported ZIP contains no `private/` member and no credential
  values; `task.json` keeps `credentials: "provided"` only.

## Key file map

| Area | File:lines |
|---|---|
| Browser engine / launch / cookies / storage | src/browser.js:20-53, 64-109 |
| Login detection (passive) | src/browser.js:292-296; src/cloneUrl.js:68-70 |
| Headful challenge retry (v1) | src/cloneUrl.js:20-32, 55-63, 334-336 |
| Browser pool | src/browser/browser-pool.js:51-71, 170-178, 386-437, 552-591 |
| Pool to worker wiring | src/workers/worker-pool-manager.js:49-58; src/workers/clone-worker.js:292-310 |
| Credential entry (API) | src/platform/server.js:350, 398-403, 423-447, 503-510 |
| Queue payload (plaintext risk) | src/platform/exploration-runner.js:27-62; src/queues/clone-queue.js:76-84, 214-219, 613-621 |
| Login fill/submit/verify | src/pipeline/exploration-pipeline.js:110-135, 343 |
| Session reuse in job | src/pipeline/exploration-pipeline.js:75-80, 149-160 |
| Destructive-action policy (dead) | src/exploration/exploration-policy.js:20-26, 46-61 |
| Actual click gate | src/interactions.js:19, 172-180, 206 |
| Session-state capture (redacted) | src/exploration/application-state-capture.js:42, 82; src/exploration/websocket-session-capture.js:41, 78-80 |
| Credential storage / purge | src/platform/tasks.js:31-55, 76-97; src/database/task-repository.js:5-13 |
| Logging redaction | src/observability/logger.js:29-32; src/storage/artifact-store.js:55-76; src/observability/trace-context.js:101-113 |
| Export shred | src/platform/exporter.js:44, 88-103, 197-198 |
| Resume without session | src/platform/session-recovery.js:268-296 |
| Platform auth (own users) | src/auth/auth-middleware.js:9-53; src/auth/auth-service.js |
