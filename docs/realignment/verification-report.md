# Verification Report — docs/realignment/IMPLEMENTATION-SPEC.md

- **Verifier:** Independent QA gate (fresh read; spec author and underlying audits not consulted)
- **Date:** 2026-11-05
- **Repository:** `D:/project 2/cloner`, branch `master`, HEAD `4327ac8` (verified via `git log --oneline -3` / `git rev-parse --abbrev-ref HEAD`)
- **Input:** `docs/realignment/IMPLEMENTATION-SPEC.md` (1035 lines, read in full)
- **Guardrails honored:** read-only except this report; no installs, no git writes, no servers, no external browsing. All commands were run in this session; none substituted.

## Verdict

**pass = true.** No BLOCKING issue remains. 7 ADVISORY issues are listed at the end.

---

## Check 1 — STRUCTURE

**Command:** `grep -nE "^## [0-9]+\." docs/realignment/IMPLEMENTATION-SPEC.md`

**Result: PASS.** All ten numbered sections present, in order, with the exact required headings:

| # | Heading | Line |
|---|---|---|
| 1 | `## 1. Actual existing frontend routes and their responsibilities` | 124 |
| 2 | `## 2. Actual backend modules and their responsibilities` | 210 |
| 3 | `## 3. Missing or disconnected components` | 328 |
| 4 | `## 4. Required architecture changes` | 444 |
| 5 | `## 5. Database and artifact contracts` | 610 |
| 6 | `## 6. Parallel agent task assignments` | 715 |
| 7 | `## 7. File ownership and dependency mapping` | 813 |
| 8 | `## 8. End-to-end acceptance tests` | 857 |
| 9 | `## 9. Execution order and integration gates` | 968 |
| 10 | `## 10. Evidence-based completion assessment` | 989 |

Count = 10 (`grep -cE "^## [0-9]+\."` → 10). No renamed or missing section.

## Check 2 — PATH REALITY

**Command:** `grep -oE "([A-Za-z0-9_.\-]+/)+[A-Za-z0-9_.\-*{}][A-Za-z0-9_.\-*{}]*" docs/realignment/IMPLEMENTATION-SPEC.md | sed "s/[.,;)]*$//" | sort -u` — then existence testing with a `test -e` loop over every repository path (129 distinct repo paths after excluding API paths, route paths, runtime artifact-tree paths, and score fractions).

**Result: PASS.** 127 of 129 paths exist. Dead-path percentage = **2/129 = 1.55%** (threshold 10%).

Dead paths (as written in the spec):

1. `vite.config-admin.mjs` — referenced as a root-level file (§3 item 10, §6 A8, §7 A8). The file actually lives at `scripts/vite.config-admin.mjs` (`find . -name "vite.config-admin.mjs" -not -path "./node_modules/*"` → `./scripts/vite.config-admin.mjs`). File exists; path location wrong.
2. `outputs/*` (§1.1: "Inline fs scan of `outputs/*/clone.json`"). The repo root has `output/`, not `outputs/`; `src/cli.js:99` sets `outputsRoot = path.join(process.cwd(), "output")` and `src/server.js:34-35` scans that root for `<dir>/clone.json`. Mechanism real; directory name in the spec wrong.

Correctly-absent paths (spec itself marks them NEW / not existing today — not dead references): `src/intake/`, `src/blueprint/`, `web/`, `.nvmrc`, `src/platform/session-pause-routes.js`, `platform-ui/` (deleted at HEAD; verified `git ls-tree HEAD platform-ui` → empty, restorable from `cdffb15`). Both audit-cited artifact trees exist on disk with exactly the structure §5.2 describes (`artifacts/exp-mw2g7mm5r76m`: `manifest.json`, `graph/{routes,states,transitions}.json`, `reports/{exploration-summary,coverage-report,failures}.json`, `states/`, `assets/`, `pages/`, `integrity.json`, `exploration.json|md`, `design-tokens.json`, `_reference/{verification.json,comparison.txt,diff.png,clone-verify.png}`; `artifacts/bench-documentation-mvwxrhct` also exists).

## Check 3 — CLAIM SPOT-CHECK

**Method:** opened the cited files and ran targeted `grep`/`sed`/`wc -l` per claim. ~50 claims checked; the sample below is the verified set. Line anchors marked ✓ matched exactly.

**Module responsibilities / engine mappings**

| Claim (spec) | Command / evidence | Result |
|---|---|---|
| `pipeline-job.js` runPipelineJob = exploration → reconstruct → verify at :69/:89/:102 | `grep -n` → `runPipelineJob` :39, `runExplorationJob(` :69, `reconstructFromArtifacts(` :89, `verifyTask(` :102 | ✓ exact |
| Platform server deliberately headless (G7.1), no static mounts, /preview only | `sed -n '270,275p' src/platform/server.js` → "headless backend (G7.1…) NO static mounts… terminal 404"; `/preview/:id` :789, `/preview/:id/*` :790 | ✓ exact |
| `githubPublishRouter` mounted at server.js:592 | grep → `592: app.use("/api/github", githubPublishRouter(...))` | ✓ exact |
| POST /api/export/:id :899, download :938 | grep → :899, :938 | ✓ exact |
| Route table anchors: tasks :418/:594/:691/:720, jobs :613/:652/:658/:669, chat :835, sessions :971, providers :973, WS :1005 | grep of `src/platform/server.js` | ✓ all exact |
| Intake: TASK_FIELD_LIMITS :350, field checks :398-403, URL guard :437, pipeline validation :435, v1 default when absent (~:439) | sed 348-352 / 396-404 / 433-441 — `TASK_FIELD_LIMITS` at 350; comment "v1 or absent → legacy cloneUrl flow" | ✓ |
| Inline auth register at :224 | `sed -n '224,228p'` → `app.post('/api/auth/register', ...)` | ✓ exact |
| `verify.js`: MAX_ROUNDS=3 :22, OPEN_GATE 0.6 :23, autoRemediate :512, verifyTask :626, verification.json :700, 1440×900 | grep/sed | ✓ all exact |
| Fake instruction check at verify.js:394-395 | :395 `checks.push({ name: "task instructions carried", ok: true, ... })` — unconditional `ok:true` | ✓ exact |
| Blueprint MISSING: `grep -rni "blueprint" src/ bin/` → 0 | ran it → `0` | ✓ exact |
| Orchestrator dead: 95 L, zero callers, `require("fs")` :80, artifact_validation stage, v1 exportTask, mentioned only in clone-worker.js:54 comment | `wc -l` = 95; repo-wide grep finds only its own definition + the clone-worker.js:54 comment; `require("fs").existsSync('artifacts/${taskId}/.${s}.in_progress')` at :80; `STAGES` includes `artifact_validation`; `exportTask` imported :8, called :62-63 | ✓ (exportTask spec L60, actual L62 — 2-line drift) |
| `clone-worker.js`: defaultExecutor :292 → runPipelineJob :310, CANONICAL_STAGE ~:57, standalone needs REDIS_URL :322-326, MAX_CONCURRENT default 2 | grep/sed | ✓ :292/:310/:322-326 exact; CANONICAL_STAGE map :54-58 ✓; MAX_CONCURRENT `|| 2` found at :47 (spec :38 — drift, substance ✓) |
| `exploration-runner.js` payload omits `instructions` | :27 signature destructures url/username/password/cookies/storage/policy/…; :43 payload line has no `instructions` | ✓ exact |
| `exploration-pipeline.js`: per-job `launchBrowser` :72, dead `onProgress` :33, geometry `slice(0,60)` :185, responsive page-001 hardcode :192-199, graph writers :303-305, reports :347/:351/:361, writeManifest :346 | grep/sed; `onProgress` occurs exactly once (declaration) | ✓ all exact |
| `exploration-policy.js`: 66 L, `DEFAULT_POLICY.risk` :20-26, `isSafeInteraction` dead (1 self-hit), stale non-hashing `stateFingerprint` :64-66 | `wc -l`=66; `grep -rn isSafeInteraction src/ scripts/` → only its own file; :64-66 returns `${url}::${domSig}` (no hash) | ✓ exact |
| `interactions.js:19` hardcoded DANGEROUS regex (omits pay\|purchase\|checkout, adds order\|send\|close); recordInteractions :804; exploration.json writer :855 | sed :17-21 → regex contains `order`,`send`,`close`, no `pay|purchase|checkout`; :804/:855 | ✓ exact |
| `task-repository.js:78` `completeStage` duration always 0 | :78 `const duration = Date.now() - Date.now();` | ✓ exact |
| `project-generator.js` (236 L) never reads understanding | `wc -l`=236; `grep -ci understanding` → 0 | ✓ exact |
| `exporter.js:19` hardcodes legacy `artifacts/<id>`; INSPECTION.md :59-68; `writeContextJson` never called by exporter | :19 `function v2TaskDir(id) { return path.join(process.cwd(), "artifacts", id); }`; INSPECTION write :60; `grep -rn writeContextJson src/ scripts/` → only export-context.js itself + `scripts/test-context-export.mjs` | ✓ |
| `version-service.js` unmounted (self-documents mount :21-23); `static-export.js` unmounted | sed :21-23 shows the INTEGRATOR MOUNT LINE comment; `grep -c "versionsRouter\|staticExportRouter" src/platform/server.js` → 0 | ✓ |
| `github-publish.js` (266 L) has `import express` at file bottom :266 | `sed -n '264,266p'` → `import express from "express";` at 266 | ✓ exact |
| `clone-queue.js` (651 L): redactCredentials :73-84, `{payload,jobId}` into Redis :214, `#memDispatch` :239-275, removeOnComplete :216-219, backend force :469-481, DLQ redaction :613-621 | grep/sed → :76/:214/:241/:218/:469-481/:618 | ✓ (plaintext `{username,password,cookies,storage}` confirmed inside the :214 payload — claim 28 substantiated) |
| `website-understanding.js` (717 L): vision provider default "none", zero network, :610; REGION_KINDS :46; buildUnderstandingPage :487 | sed :608-612 → `{ model: { provider: "none" } } // deterministic default: no provider, no fetch` | ✓ exact |
| `component-evidence.js` (447 L): makeEvidence :39, aggregateConfidence :52, electKind :97, `pat-`+sha256[:12] :218, registry :255, annotateUnderstanding :413 | grep/sed — all exact; :372-384 is the registry return (built, never persisted elsewhere) | ✓ exact |
| `artifact-loader.js` (64 L): manifest gate :17-21, geometry required :33, missing/empty/malformed :37-45 | sed | ✓ exact |
| repair-planner skips `missing-component` :134-135; repair-executor hard stop :233-236 | :134-135 `return { skip: "missing components need structural regeneration…" }`; :234-235 `stopped = "no-improvement"` | ✓ exact |
| `config-schema.js` (445 L) warns PURGE_CREDS_ON_DONE not default ~:275; has CLI entry | :272-278 production warning block; CLI entry `process.argv` :426-427 | ✓ |
| Migrations: 17 files, duplicate prefix 017 = `017-job-leases.sql` + `017-notification-delivery.sql` | `ls src/database/migrations/` → 17 files; both 017 names exact | ✓ exact |
| package.json: 7 deps, 62 scripts, no `engines`, no `.nvmrc` | `node -e` probe → deps 7, scripts 62; `grep '"engines"'` → nothing; `.nvmrc` absent | ✓ exact |
| `dashboard/` trio 77/228/380 L; app.js has zero "verification" references | `wc -l`; `grep -ci verification dashboard/app.js` → 0 | ✓ exact |
| `src/server.js` (181 L) serves dashboard at :27/:28, /api/runs :31; picker injected | sed :27-32 | ✓ exact (dir name `output` — see Check 2) |
| `src/cli.js:100` starts dashboard (`--serve-only` flag) | sed :96-103 → `startServer` at :100, `args.serveOnly` at :103 | ✓ exact |
| Session resume runs WITHOUT credentials (session-recovery.js:268-273) | sed :266-274 → "resume WITHOUT them", "(no session credentials — shredded at export)" | ✓ exact |
| `intelligence-routes.js` = 14 routes spanning :83-163 | `grep -c router.(get\|post\|…)` → 14; first :83, last :163 | ✓ exact |
| admin-routes :210-305, dashboard-routes :117/:181, email-real :573/:582, ui-config-routes :234-338 | sed each anchor → `/users` :210, `/workers` :305, `/` :117, `/history` :181, `/send` :573, `/receipts` :582, `/providers` :234, `/rotations` :338 | ✓ all exact |
| `cloneUrl.js:272` v1 tokensV2 design-tokens writer; isChallenge :334 | :272 `design-tokens.json … main.tokensV2`; :334 `function isChallenge(cap)` | ✓ exact |
| `events.js` (39 L) 500-event ring :5-27 | `wc -l`=39; `this.cap = 500` :15 | ✓ |
| `browser.js` loadCookies :20 | grep → :20 | ✓ |
| platform-ui deleted at HEAD; existed only at cdffb15 as 3 files / 817 lines (139/397/281); `platform-ui/src` never existed in git; deletion commit dated 2026-11-05 00:03 +0530 | `git ls-tree HEAD platform-ui` → empty; `git ls-tree cdffb15 platform-ui/` → app.js, index.html, style.css; `git show cdffb15:… \| wc -l` → 139/397/281; `git log --all -- platform-ui/src` → empty; `git log -1 --format=%ci 4327ac8` → `2026-11-05 00:03:06 +0530` | ✓ exact |
| ARCHITECTURE.md G7.1 at :47-65; :6 claims removal "entirely on 2026-11-03" | sed :6 and :47-50 | ✓ |
| README-PLATFORM.md still documents platform-ui (lines 23, 79-90, 108-145) | grep → hits at :23, :79, :83, :164 | ✓ (also :164) |
| `scripts/audit-completeness.mjs:41` PRODUCT_DIRS includes platform-ui | sed :38-43 → `const PRODUCT_DIRS = new Set(["src","bin","platform-ui","dashboard"])` at :41 | ✓ exact |
| Stale scripts reference platform-ui paths | `grep -l platform-ui scripts/test-ui-*.mjs scripts/vite.config-admin.mjs` → admin, dashboard, vite-config (onboarding = 0 hits); `views/Admin` + `.vue` found in test-ui-admin.mjs and vite.config-admin.mjs; `platform-ui/dist/admin` in vite.config-admin.mjs | ◐ partial — see ADVISORY 5 |
| `_reference/` outputs from compare-clone.mjs (comparison.txt + diff.png) | :79 writes diff.png into refDir; :149 writes comparison.txt | ✓ (spec cites :140-148 for the report block — writes at :79/:149, names ✓) |
| `job-diagnostics.js:23-26` allowlists `components.json`/`interaction-records.json` with no writers | sed :23-26 → both names allowlisted; `grep -rln "interaction-records.json" src/` → only job-diagnostics itself | ✓ exact |
| Tasks store credentials only as "provided" flag; private/cookies.json|storage.json at tasks.js:36-37; purgeCredentials :76 | sed :29-46 → `private/` mkdirs at :35-37, `credentials: … ? "provided" : null // never store the values` | ✓ |

**Line-count claims (49 files checked with `wc -l`):** 45 exact matches. 4 files are each exactly 1 line over the spec's count, and all four end with `\n` (checked via `tail -c 1 | od`), so `wc -l` is authoritative: `src/platform/server.js` 1239 (spec 1240), `src/browser.js` 654 (spec 655), `src/browser/browser-pool.js` 593 (spec 594), `src/exploration/state-discovery.js` 286 (spec 287). Cosmetic only.

**Result: PASS.** Zero substance contradictions found; every module, endpoint, artifact name and engine mapping in the sample exists and behaves as the spec states.

## Check 4 — OWNERSHIP

**Method:** cross-checked every per-agent "Files:" list in §6 against the §7 ownership table, then searched the union for duplicates; mapped every P0 task (R-P0.1–R-P0.19) to its assigned agent.

**Result: PASS with advisories.**

- **No file is owned by two agents.** The §6 lists and §7 table are identical, and a pairwise scan of the eight lists finds zero overlap — including the NEW/deleted entries (`src/intake/**`, `web/**`, `src/blueprint/**`, `.nvmrc`, `session-pause-routes.js` NEW; `src/orchestration/**`, `github-publish.js`, `exhaustive-test.js` delete/remove). A6's glob `src/reconstruction/generation/**` does cover the real location (`src/reconstruction/generation/project-generator.js` verified present).
- **Every P0 task has an owner:** R-P0.1/2/3/5/6→A1; R-P0.4→A1 (carry) + A7 (verify-side check); R-P0.7→A3 (API) + A4 (call-site); R-P0.8→A8 (A3 requests); R-P0.9/10/11/12→A4 (+A1 whitelist wiring); R-P0.13→A3; R-P0.14→A5+A4; R-P0.15→A5 (+A6 cloneUrl migration); R-P0.16→A5 spec / A6 implement (explicit); R-P0.17/18/19→A5.
- **Advisory cross-boundary ambiguities** (task assigned to one agent but a required edit site sits in another agent's exclusive file, without the explicit handoff note the spec uses elsewhere): see ADVISORY 6.

## Check 5 — ACCEPTANCE TESTS

**Method:** every command in §8 (J1-J7, setup, §8.2 table, §8.3 gates, §8.4) checked against `package.json` scripts and the `scripts/` tree. Suites were NOT executed (QA gate is read-only; several need browsers/PG/Redis) — this check verifies command reality, not suite greenness.

**Result: PASS.** Every acceptance command is real:

- All 15 referenced npm scripts exist in `package.json` (verified via `node -e` over the script map, each printed with its command): `platform` (:12), `worker` (:13), `test:exploration-efficiency`, `test:coverage` (→ `scripts/test-website-coverage.mjs`), `test:reconstruction` (runs test-reconstruction + test-website-understanding + test-workspace-reconstruction — consistent with §8.2's "incl. test-website-understanding.mjs"), `test:visual-fidelity` (runs test-visual-fidelity + test-autonomous-repair — consistent with §8.2's repair component), `test:platform`, `test:browser-pool`, `test:tenant-isolation`, `test:phase40` (:40, 12 chained suites), `test:context-export`, `test:grand-final` (:72 = phase40+phase42+phase45), `test:worker-queue`, `test:phase42`, `test:phase45`.
- All referenced script files exist: `scripts/serve-fixture.mjs`, `scripts/fixtures/lazy-scroll.mjs`, `scripts/check-runtime-records.mjs`, `scripts/compare-clone.mjs`, `scripts/gen-scaffold.mjs`.
- `node src/config-schema.js api` is runnable — `src/config-schema.js:426-427` has the CLI entry.
- `git show cdffb15:platform-ui/app.js` works (verified via `git show` during the platform-ui checks).
- `ls src/database/migrations/*.sql | sed 's/-.*//' | sort | uniq -d` is a real gate against the verified duplicate (currently returns `017` — i.e., the gate fails today, which is the spec's point).
- Endpoint-based curls target verified mounted routes: `/api/auth/register` (:224), `/api/tasks` (:418), `/api/jobs/:jobId/artifacts/*` (:669), `/api/export/:id` (:899), `/preview/:id/*` (:790), `/healthz` (health-routes mounted per §1.2). `/api/versions/<taskId>` and `/app/projects` do NOT exist today — correct, both are deliverables of the plan (R-P1.4/R-P2.1), not fabricated claims about the present.
- Not executed (stated plainly): any `npm run test:*` suite, docker compose, or server startup — outside this gate's read-only/no-server guardrails.

## Check 6 — FABRICATION

**Method:** union of Check 2 (path existence) and Check 3 (endpoint/module existence at cited lines).

**Result: PASS.** No fabricated module, endpoint, or artifact found. Every backend module the spec names exists at the stated path; every §1.2 route table entry spot-checked matches the mount line; both cited artifact trees exist on disk; `src/intake/`, `src/blueprint/`, `web/`, `.nvmrc`, `session-pause-routes.js` and `blueprint.json` are all explicitly labeled MISSING/NEW by the spec itself and are indeed absent. The unmounted/unused/dead labels (static-export, version-service, activity-routes, routes-public-v1, billing-hooks, onboarding-service, job-diagnostics allowlist, pipeline-orchestrator) were each confirmed by grep rather than taken from prose.

## Check 7 — DECISION CLARITY

**Result: PASS.** The spec contains a dedicated section "Decision: Headless platform (G7.1) vs the 8-page product workflow" (lines 81-120) that states the relation explicitly: **"Recommendation (one option): Supersede G7.1."** with label `DECISION-CONFIRMED-BY-OWNER-DIRECTIVE`, directing the 8-page SPA under a new `web/` tree served by the platform server at `/app` + SPA fallback replacing the terminal-404 comment, with the legacy `dashboard/` trio kept untouched as the CLI operator console. This is carried consistently through the body: R-P2.1 builds the SPA, A1 owns the `/app` mount + the `docs/ARCHITECTURE.md` G7.1 supersession note, A2 builds `web/**`, and gate G5 blocks on the SPA serving. The relation is unambiguous: **supersede**. The only nit is the hedged wording "Recommendation (one option)" on an otherwise decision-labeled section (ADVISORY 7).

---

## Issues list

No BLOCKING issues.

- **ADVISORY (Check 2):** `vite.config-admin.mjs` is referenced as a root-level file (§3, §6, §7) but the file lives at `scripts/vite.config-admin.mjs`; the path as written is dead (1 of 2 dead paths).
- **ADVISORY (Check 2 / §1.1):** the spec says `GET /api/runs` scans `outputs/*/clone.json`; the actual directory is `output/` (`src/cli.js:99`), and no `outputs/` directory exists (2 of 2 dead paths).
- **ADVISORY (Check 3):** four line-count claims are each 1 high vs `wc -l` on newline-terminated files: platform server.js 1239 (spec 1240), browser.js 654 (655), browser-pool.js 593 (594), state-discovery.js 286 (287).
- **ADVISORY (Check 3):** four line-anchor drifts where the substance is confirmed but the cited line is off: MAX_CONCURRENT default-2 cited :38, actual :47; orchestrator v1 exportTask cited L60, actual :62; WS event whitelist cited server.js:1087, actual :1093 (9 listed event types verified verbatim); compare-clone _reference writes cited :140-148, actual :79/:149.
- **ADVISORY (Check 3):** §3 item 10 slightly overstates: `scripts/test-ui-onboarding.mjs` contains zero platform-ui references, and the `platform-ui/src/views/*.vue` pattern was found only in `scripts/test-ui-admin.mjs` and `scripts/vite.config-admin.mjs` (dashboard references platform-ui without a .vue path). The stale-file conclusion still holds for admin/dashboard/vite-config; it does not apply to onboarding.
- **ADVISORY (Check 4):** four P0 assignments require edits in another agent's exclusive file without the explicit handoff the spec uses elsewhere (e.g. R-P0.16 "spec by A5, implemented by A6"): (a) R-P0.13 (A3) needs `authVerified` in the manifest + login-verify hardening inside A4-owned `exploration-pipeline.js` (:110-135, manifest write :343); (b) R-P0.14/R-P0.18 components.json + traceability writes land in A6-owned `reconstruction-pipeline.js` (:245/:442/:372-381 region) while assigned to A5; (c) R-P0.15's "re-point verify.js:454/:518" targets A7-owned `verify.js` while assigned to A5; (d) R-P0.6's worker-side credential re-supply touches A8-owned `clone-worker.js` while assigned to A1. No file has two owners; each needs a one-line ownership handoff.
- **ADVISORY (Check 7):** the Decision section hedges with "Recommendation (one option)" while carrying a DECISION-CONFIRMED label; wording only, supersession is unambiguous everywhere else in the spec.

**Dead-path percentage: 1.55% (2/129) — under the 10% BLOCKING threshold.**
