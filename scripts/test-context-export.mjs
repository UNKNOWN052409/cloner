#!/usr/bin/env node
// Context export → recovery tests (task 4.5.3). REAL pipeline, REAL HTTP, REAL zips.
//
//   [1] real exploration of a local fixture site (headless browser, artifacts tree)
//   [2] real reconstruction (editable project tree)
//   [3] one-click export carries context.json: formatVersion/exportedAt/task meta/
//       evidence POINTERS (sha256+paths, never blobs)/config env NAMES with values
//       REDACTED/partial-state markers/resume plan/canonical integrity digest
//   [4] credential-shred guarantee intact: private/ never in the ZIP nor in the
//       evidence pointers; finalizeExportV2 (the 4.0.5 server hook) shreds it;
//       the restored tree never contains the session marker
//   [5] export → WIPE artifacts → HTTP import (auth + tenant-scoped) → resume
//       → pipeline COMPLETES (verification re-runs to a terminal report)
//   [6] crash-after-exploration package: import → resume re-runs reconstruction
//       AND verification to completion (the one-click exporter refuses to ship
//       a project-less package by contract, exporter.js:25 — this package is
//       test-assembled from the real artifacts tree + a real buildContext()
//       snapshot taken at that pipeline point; importer/resumer are untouched)
//   [7] tamper enforcement: modified context.json, tampered evidence file,
//       missing evidence file, missing context.json, smuggled non-redacted
//       config value — every one rejected with nothing materialized
//   [8] auth + tenant scoping: anonymous 401, foreign user 404 (no existence
//       leak), org-scoped import lands under artifacts/<orgId>/<jobId>/
//   [9] grep-enforced zero secret VALUES in context.json (unique marker values
//       planted in env + a session cookie marker; grep for each — must be absent)
//
// Boots the compose PostgreSQL (docker compose up -d postgres) for the real
// register/login journeys. Cleans up everything it created.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import http from "node:http";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";

const PROJECT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
process.chdir(PROJECT); // artifacts/, platform-data/ are cwd-relative

process.env.CLONER_ALLOW_PRIVATE_TARGETS = "1"; // local fixture site is loopback
process.env.CLONER_POOL_HEADED = "0";

const results = [];
const check = (name, ok, detail = "") => {
  results.push(ok);
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
};

const watchdog = setTimeout(() => { console.log("FAIL  global timeout (600s)"); process.exit(1); }, 600_000);
watchdog.unref();

// unique secret markers planted for the grep enforcement — must NEVER appear in
// any context.json (or any restored artifact tree)
const SECRET_OPENAI = "sk-SUPERSECRET-openai-" + crypto.randomBytes(6).toString("hex");
const SECRET_ANTHROPIC = "sk-ant-SUPERSECRET-anthropic-" + crypto.randomBytes(6).toString("hex");
const SECRET_COOKIE = "CLONERTEST-SESSION-COOKIE-" + crypto.randomBytes(6).toString("hex");
const SECRETS = [SECRET_OPENAI, SECRET_ANTHROPIC, SECRET_COOKIE];
process.env.OPENAI_API_KEY = SECRET_OPENAI;
process.env.ANTHROPIC_API_KEY = SECRET_ANTHROPIC;

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "cloner-ctx-"));
const createdArtifacts = []; // cleaned up at exit
const createdShells = [];

const {
  buildContext, writeContextJson, verifyContextIntegrity, validateEvidenceHashes,
  validateContextStructure, canonicalJson, collectEvidence, ContextValidationError,
} = await import("../src/platform/export-context.js");
const { exportV2Task } = await import("../src/platform/exporter.js");
const { finalizeExportV2 } = await import("../src/storage/artifact-lifecycle.js");
const {
  importRecoveryPackage, resumeRecoveryJob, createRecoveryRouter,
  loadRecoveryShell, deleteRecoveryShell,
} = await import("../src/platform/session-recovery.js");
const { runExplorationJob } = await import("../src/pipeline/exploration-pipeline.js");
const { reconstructFromArtifacts } = await import("../src/reconstruction/reconstruction-pipeline.js");
const { statefulAppSite } = await import("./fixtures/stateful-app.mjs");
const { startFixtureServer } = await import("./fixtures/server.mjs");
const { default: express } = await import("express");
const { startPlatform } = await import("../src/platform/server.js");
const { authRequired } = await import("../src/auth/auth-middleware.js");
const { resolveTenantScope } = await import("../src/platform/tenant-scope.js");
const { closePool } = await import("../src/database/client.js");

// ---------- helpers ----------
const walkFiles = (dir, out = []) => {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walkFiles(p, out);
    else out.push(p);
  }
  return out;
};
const treeContains = (dir, needle) => walkFiles(dir).some((f) => {
  try { return fs.readFileSync(f).includes(needle); } catch { return false; }
});

const q = (s) => s.replace(/'/g, "''");
async function zipDir(srcDir, zipPath) {
  fs.rmSync(zipPath, { force: true });
  await new Promise((resolve, reject) => execFile("powershell", ["-NoProfile", "-NonInteractive", "-Command",
    `Compress-Archive -Path '${q(srcDir)}\\*' -DestinationPath '${q(zipPath)}' -Force`], { windowsHide: true, timeout: 120000 },
    (e, _o, err) => (e ? reject(new Error(String(e.message || e) + " " + String(err || ""))) : resolve())));
}
async function unzipDir(zipPath, destDir) {
  fs.rmSync(destDir, { recursive: true, force: true }); fs.mkdirSync(destDir, { recursive: true });
  await new Promise((resolve, reject) => execFile("powershell", ["-NoProfile", "-NonInteractive", "-Command",
    `Expand-Archive -Path '${q(zipPath)}' -DestinationPath '${q(destDir)}' -Force`], { windowsHide: true, timeout: 120000 },
    (e, _o, err) => (e ? reject(new Error(String(e.message || e) + " " + String(err || ""))) : resolve())));
}

// ---------- platform + router (the integrator mount, exercised for real) ----------
const started = await startPlatform({ port: 0 });
const platformPort = started.server.address().port;
const platform = `http://127.0.0.1:${platformPort}`;

const app = express();
app.use(express.json());
// EXACT integrator mount line (documented in src/platform/session-recovery.js header):
app.use("/api/recovery", createRecoveryRouter({ authRequired, tenantScope: resolveTenantScope }));
const testServer = await new Promise((r) => { const s = app.listen(0, "127.0.0.1", () => r(s)); });
const base = `http://127.0.0.1:${testServer.address().port}`;

async function api(host, method, p, { body, token, raw, contentType } = {}) {
  const res = await fetch(`${host}${p}`, {
    method,
    headers: {
      ...(raw ? { "content-type": contentType || "application/zip" } : body ? { "content-type": "application/json" } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: raw ? raw : body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null; try { json = JSON.parse(text); } catch {}
  return { status: res.status, json, text };
}
async function mkUser(tag) {
  const email = `ctx-453-${tag}-${Date.now().toString(36)}-${crypto.randomBytes(3).toString("hex")}@ctx.test`;
  const reg = await api(platform, "POST", "/api/auth/register", { body: { email, password: "ctx-Passw0rd!" } });
  if (!reg.json?.userId) throw new Error("register failed: " + reg.text.slice(0, 140));
  const login = await api(platform, "POST", "/api/auth/login", { body: { email, password: "ctx-Passw0rd!" } });
  if (!login.json?.token) throw new Error("login failed: " + login.text.slice(0, 140));
  return { userId: reg.json.userId, token: login.json.token, email };
}
const USER_A = await mkUser("a");
const USER_B = await mkUser("b");
// A owns an org → org-scoped import lands under artifacts/<orgId>/<jobId>/
const orgRes = await api(platform, "POST", "/api/orgs", { token: USER_A.token, body: { name: "ctx-453-org", slug: "ctx-453-" + crypto.randomBytes(3).toString("hex") } });
if (orgRes.status !== 201 || !orgRes.json?.org?.id) throw new Error("org create failed: " + orgRes.text.slice(0, 140));
const ORG_ID = orgRes.json.org.id;

try {
  // ============ [1] real exploration ============
  console.log("\n[1] real exploration of the stateful fixture (headless browser)");
  const site = await startFixtureServer(statefulAppSite);
  const { jobId: EXP_ID, artifactsDir, manifest } = await runExplorationJob({
    url: site.base + "/",
    artifactsRoot: path.join(PROJECT, "artifacts"),
    config: { policy: { budgets: { maxRoutes: 1, maxStatesPerPage: 4, maxInteractionsPerState: 8, maxTotalTimeMs: 120000 } } },
  });
  createdArtifacts.push(artifactsDir);
  const projectDir = artifactsDir + "-project";
  createdArtifacts.push(projectDir);
  check("exploration completed", manifest.status === "completed", `${manifest.status}, pages=${manifest.pages?.length}`);
  check("manifest.json + evidence tree exist", fs.existsSync(path.join(artifactsDir, "manifest.json")) && fs.existsSync(path.join(artifactsDir, "pages")));

  // ============ [2] real reconstruction ============
  console.log("\n[2] real reconstruction (editable project)");
  const rec = await reconstructFromArtifacts(artifactsDir, { outDir: projectDir, interactionRecords: [] });
  check("reconstruction produced the project", rec.ok !== false && fs.existsSync(path.join(projectDir, "index.html")), path.basename(projectDir));

  // session files a credentialed exploration would carry (shred-guarantee fixture)
  fs.mkdirSync(path.join(artifactsDir, "private"), { recursive: true });
  fs.writeFileSync(path.join(artifactsDir, "private", "cookies.json"), JSON.stringify({ session: SECRET_COOKIE }));
  createdArtifacts.push(path.join(artifactsDir, "private")); // removed below with the tree

  // ============ [3] one-click export carries context.json ============
  console.log("\n[3] export (one-click, real exporter + context.json)");
  // PGPASSWORD pool is already cached — plant the marker AFTER boot so only the
  // context builder sees it, then unset (the grep window below)
  const PREV_PGPASSWORD = process.env.PGPASSWORD;
  process.env.PGPASSWORD = SECRET_OPENAI.replace("openai", "pgpass");
  // staging = artifactsDir → context.json lands in the tree; the module re-records
  // the G5.4 integrity manifest (exportV2Task refuses EXTRA files — exporter.js:27-38)
  const staged = writeContextJson({ artifactsDir, projectDir, staging: artifactsDir }); // exporter.js:53 hook equivalent pre-hook
  const context = staged.context;
  delete process.env.PGPASSWORD;
  if (PREV_PGPASSWORD !== undefined) process.env.PGPASSWORD = PREV_PGPASSWORD;
  const ctxText = fs.readFileSync(staged.file, "utf8");

  check("context.json written and well-formed", context.formatVersion === "1.0.0" && context.kind === "cloner-context-export" && typeof context.exportedAt === "string" && context.task.jobId === EXP_ID, `formatVersion=${context.formatVersion}`);
  check("context integrity digest verifies", verifyContextIntegrity(context).ok === true, context.integrity.contextSha256.slice(0, 16) + "…");
  const pointers = context.evidence.pointers;
  // disk self-check: mirror the ZIP layout — "project/*" lives in the SIBLING
  // <job>-project/ dir on disk, everything else inside the artifacts dir
  const resolveSource = (rel) => rel.startsWith("project/") ? path.join(projectDir, rel.slice("project/".length)) : path.join(artifactsDir, rel);
  check("evidence pointers exist and hash-validate against disk", pointers.length > 5 && validateEvidenceHashes(context, resolveSource).validated === pointers.length, `${pointers.length} pointers`);
  check("evidence carries POINTERS (path+sha256+bytes), never blobs", pointers.every((p) => /^[0-9a-f]{64}$/.test(p.sha256) && Number.isInteger(p.bytes)) && !/\{.*"pointers":.*"content"/s.test(ctxText), `${pointers.length}× {path,sha256,bytes}`);
  check("evidence excludes private/, export plumbing and sensitive names",
    !pointers.some((p) => p.path.startsWith("private/") || p.path === "context.json" || p.path === "export.zip" || /cookie|storage\.json|secret|credential/i.test(p.path)),
    "0 sensitive pointers");

  const envCfg = context.config.env;
  // this loopback test process genuinely runs with no PORT in its env (compose
  // boots set it; this one does not) — assert set+REDACTED on a var that IS set
  // here, unset+null on one that is not, and REDACTED-or-null everywhere
  check("config is env NAMES with values REDACTED",
    envCfg.ANTHROPIC_API_KEY?.set === true && envCfg.ANTHROPIC_API_KEY?.value === "[REDACTED]" &&
    envCfg.STRIPE_SECRET_KEY?.set === false && envCfg.STRIPE_SECRET_KEY?.value === null &&
    Object.values(envCfg).every((e) => e.value === null || e.value === "[REDACTED]"),
    `${Object.keys(envCfg).length} names`);
  check("partial-state markers match disk (exploration+reconstruction done, verification pending)",
    context.partialState.exploration.completed === true && context.partialState.reconstruction.completed === true &&
    context.partialState.verification.completed === false && context.partialState.nextStage === "verification",
    JSON.stringify(context.partialState));
  check("resume plan targets the remaining stage only",
    context.resumePlan.steps.length === 1 && context.resumePlan.steps[0].stage === "verification" && context.resumePlan.steps[0].runnable === true &&
    /shredded/.test(context.resumePlan.credentialsNote),
    context.resumePlan.steps.map((s) => s.stage).join(","));

  // ---- grep-enforced zero secret VALUES in the file ----
  console.log("\n[4] grep-enforced zero secret VALUES in context.json");
  for (const secret of [SECRET_OPENAI, SECRET_ANTHROPIC]) {
    check(`grep context.json for planted secret (${secret.slice(0, 18)}…) → absent`, !ctxText.includes(secret), "grep -F");
  }
  check("grep context.json for session-cookie marker → absent", !ctxText.includes(SECRET_COOKIE), "grep -F");
  check("grep context.json for secret NAMES → present as redacted entries", ctxText.includes('"ANTHROPIC_API_KEY"') && ctxText.includes('"value": "[REDACTED]"'), "names present, values redacted");

  // real one-click export (read-only exporter) + the 4.0.5 finalize hook
  const exportA = await exportV2Task(EXP_ID);
  check("export.zip produced", fs.existsSync(exportA.zipPath) && exportA.size > 0, `${exportA.size} bytes`);
  const finalize = finalizeExportV2({ jobDir: artifactsDir, zipPath: exportA.zipPath }); // server.js makeV2Exporter hook semantics
  check("finalize verified ZIP integrity + recorded digest", finalize.integrity.ok === true && /^[0-9a-f]{64}$/.test(finalize.integrity.sha256), finalize.integrity.sha256.slice(0, 16) + "…");
  check("credential-shred guarantee intact: private/ shredded after export", finalize.shred.shredded === true && !fs.existsSync(path.join(artifactsDir, "private")), (finalize.shred.removed || []).join(",") || "private/");

  const zipAPath = path.join(TMP, "export-A.zip");
  fs.copyFileSync(exportA.zipPath, zipAPath);
  const zipA = fs.readFileSync(zipAPath);

  // the ZIP itself must not carry the session marker anywhere
  const zipAExtract = path.join(TMP, "zipA-extract");
  await unzipDir(zipAPath, zipAExtract);
  check("ZIP root carries context.json", fs.existsSync(path.join(zipAExtract, "context.json")), "context.json");
  check("ZIP carries the evidence + project trees", fs.existsSync(path.join(zipAExtract, "pages")) && fs.existsSync(path.join(zipAExtract, "project", "index.html")), "pages/ + project/");
  check("ZIP carries NO session/credential files", !treeContains(zipAExtract, SECRET_COOKIE) && !walkFiles(zipAExtract).some((f) => /cookie|private/i.test(path.basename(f))), "grep + name scan");
  const zipCtx = JSON.parse(fs.readFileSync(path.join(zipAExtract, "context.json"), "utf8"));
  check("ZIP context.json is byte-consistent with the staged one (integrity verifies inside the package)", verifyContextIntegrity(zipCtx).ok === true, "");

  // ============ [5] export B — crash-after-exploration package ============
  console.log("\n[5] crash-after-exploration package (reconstruction incomplete)");
  fs.rmSync(projectDir, { recursive: true, force: true });
  // writeContextJson re-records the integrity manifest after the project tree is
  // gone (a legitimate tree change) — keeps the G5.4 export check satisfiable
  const stagedB = writeContextJson({ artifactsDir, projectDir: null, staging: artifactsDir });
  const contextB = stagedB.context;
  check("partial-state markers: reconstruction incomplete, resume plan = reconstruction+verification",
    contextB.partialState.reconstruction.completed === false && contextB.partialState.nextStage === "reconstruction" &&
    contextB.resumePlan.steps.map((s) => s.stage).join(",") === "reconstruction,verification",
    JSON.stringify(contextB.partialState));
  const zipBPath = path.join(TMP, "export-B.zip");
  await zipDir(artifactsDir, zipBPath); // test-assembled package (real files, real context, real zip tool)
  const zipB = fs.readFileSync(zipBPath);

  // ============ [6] WIPE artifacts ============
  console.log("\n[6] wipe artifacts (the recovery journey: everything gone)");
  fs.rmSync(artifactsDir, { recursive: true, force: true });
  fs.rmSync(projectDir, { recursive: true, force: true });
  check("artifacts wiped", !fs.existsSync(artifactsDir) && !fs.existsSync(projectDir), artifactsDir);

  // ============ [7] HTTP import (auth + org-scoped) + resume → COMPLETES ============
  console.log("\n[7] import (auth+tenant-scoped) → resume → pipeline completes");
  const impA = await api(base, "POST", `/api/recovery/import?orgId=${encodeURIComponent(ORG_ID)}`, { token: USER_A.token, raw: zipA });
  check("org-scoped import accepted (201)", impA.status === 201 && /^rec-/.test(impA.json?.jobId || ""), impA.status === 201 ? impA.json.jobId : impA.text.slice(0, 140));
  const REC1 = impA.json?.jobId;
  createdShells.push(REC1);
  check("import validated every evidence pointer hash-for-hash", impA.json?.evidence?.validated === impA.json?.evidence?.total && impA.json.evidence.total >= pointers.length, `${impA.json?.evidence?.validated}/${impA.json?.evidence?.total}`);
  const rec1Dir = path.join(PROJECT, "artifacts", ORG_ID, REC1);
  createdArtifacts.push(path.join(PROJECT, "artifacts", ORG_ID, REC1), rec1Dir + "-project");
  check("shell materialized under the caller's tenant scope", fs.existsSync(rec1Dir) && fs.existsSync(path.join(rec1Dir, "manifest.json")), rec1Dir);
  const rec1Manifest = JSON.parse(fs.readFileSync(path.join(rec1Dir, "manifest.json"), "utf8"));
  check("manifest re-keyed to the new job id with a recovery lifecycle header",
    rec1Manifest.jobId === REC1 && rec1Manifest.lifecycle?.recoveredFrom === EXP_ID && rec1Manifest.lifecycle?.orgId === ORG_ID && rec1Manifest.lifecycle?.lifecycleState === "active",
    `recoveredFrom=${rec1Manifest.lifecycle?.recoveredFrom}`);
  check("project tree restored (reconstruction was complete at export)", impA.json?.projectRestored === true && fs.existsSync(path.join(rec1Dir + "-project", "index.html")), "project/index.html");
  check("restored tree contains NO session marker (shred guarantee survives import)", !treeContains(rec1Dir, SECRET_COOKIE) && !treeContains(rec1Dir + "-project", SECRET_COOKIE), "grep -r");
  check("shell registry entry recorded (owner org-scoped)", loadRecoveryShell(REC1)?.owner?.orgId === ORG_ID && loadRecoveryShell(REC1)?.status === "recoverable", "platform-data/recovery/" + REC1 + ".json");

  const resA = await api(base, "POST", `/api/recovery/${REC1}/resume`, { token: USER_A.token });
  check("resume re-ran the remaining stage (verification) to completion", resA.status === 200 && ["completed", "completed_with_limitations"].includes(resA.json?.status) && resA.json?.ranStages?.join(",") === "verification", `status=${resA.json?.status} ran=${resA.json?.ranStages?.join(",")}`);
  const verif1 = (() => { try { return JSON.parse(fs.readFileSync(path.join(rec1Dir, "_reference", "verification.json"), "utf8")); } catch { return null; } })();
  check("verification report written by the resumed pipeline (terminal stage ran)", !!verif1 && Array.isArray(verif1.stages) && verif1.stages.length === 3, `passed=${verif1?.passed}`);
  check("shell terminal state recorded", loadRecoveryShell(REC1)?.status === resA.json?.status && !!loadRecoveryShell(REC1)?.finishedAt, loadRecoveryShell(REC1)?.status);

  const again = await api(base, "POST", `/api/recovery/${REC1}/resume`, { token: USER_A.token });
  check("resume of an already-finished shell refused (409)", again.status === 409, `status=${again.status}`);

  // ============ [8] crash package: resume re-runs reconstruction AND verification ============
  console.log("\n[8] crash-package import (personal scope) → resume reconstruction+verification");
  const impB = await api(base, "POST", "/api/recovery/import", { token: USER_A.token, raw: zipB });
  check("personal-scope import accepted (201)", impB.status === 201 && impB.json?.projectRestored === false, impB.status === 201 ? `${impB.json.jobId} projectRestored=${impB.json.projectRestored}` : impB.text.slice(0, 140));
  const REC2 = impB.json?.jobId;
  createdShells.push(REC2);
  const rec2Dir = path.join(PROJECT, "artifacts", REC2);
  createdArtifacts.push(rec2Dir, rec2Dir + "-project");
  check("legacy-root shell materialized (no org)", fs.existsSync(rec2Dir) && loadRecoveryShell(REC2)?.owner?.userId === USER_A.userId && loadRecoveryShell(REC2)?.owner?.orgId === null, rec2Dir);
  const resB = await api(base, "POST", `/api/recovery/${REC2}/resume`, { token: USER_A.token });
  check("resume re-ran reconstruction + verification to completion", resB.status === 200 && ["completed", "completed_with_limitations"].includes(resB.json?.status) && resB.json?.ranStages?.join(",") === "reconstruction,verification", `status=${resB.json?.status} ran=${resB.json?.ranStages?.join(",")}`);
  check("reconstruction re-ran for real (project exists after resume)", fs.existsSync(path.join(rec2Dir + "-project", "index.html")), "project/index.html");
  const verif2 = (() => { try { return JSON.parse(fs.readFileSync(path.join(rec2Dir, "_reference", "verification.json"), "utf8")); } catch { return null; } })();
  check("verification ran on the reconstructed crash package", !!verif2 && Array.isArray(verif2.stages), `passed=${verif2?.passed}`);

  // ============ [9] tamper enforcement ============
  console.log("\n[9] tampered packages rejected (fail-closed, nothing materialized)");
  const shellsBefore = fs.readdirSync(path.join(PROJECT, "platform-data", "recovery")).length;

  // (a) modified context.json (field tamper) → canonical digest mismatch
  const t1 = path.join(TMP, "tamper-ctx");
  await unzipDir(zipAPath, t1);
  const tamperedCtx = JSON.parse(fs.readFileSync(path.join(t1, "context.json"), "utf8"));
  tamperedCtx.task.originalUrl = "https://evil.example/";
  fs.writeFileSync(path.join(t1, "context.json"), JSON.stringify(tamperedCtx, null, 2));
  const t1zip = path.join(TMP, "tamper-ctx.zip");
  await zipDir(t1, t1zip);
  const tam1 = await api(base, "POST", "/api/recovery/import", { token: USER_A.token, raw: fs.readFileSync(t1zip) });
  check("modified context.json rejected (integrity digest mismatch)", tam1.status === 400 && /integrity mismatch/.test(tam1.text), tam1.text.slice(0, 110));

  // (b) tampered evidence file → sha256 mismatch (same byte length — flips one
  // byte so the BYTES pre-check passes and the hash check itself must catch it)
  const t2 = path.join(TMP, "tamper-evidence");
  await unzipDir(zipAPath, t2);
  const firstPtr = zipCtx.evidence.pointers.find((p) => !p.path.startsWith("project/"));
  const tamperBuf = fs.readFileSync(path.join(t2, firstPtr.path));
  tamperBuf[tamperBuf.length - 1] = tamperBuf[tamperBuf.length - 1] ^ 0x20;
  fs.writeFileSync(path.join(t2, firstPtr.path), tamperBuf);
  const t2zip = path.join(TMP, "tamper-evidence.zip");
  await zipDir(t2, t2zip);
  const tam2 = await api(base, "POST", "/api/recovery/import", { token: USER_A.token, raw: fs.readFileSync(t2zip) });
  check("tampered evidence file rejected (sha256 mismatch, fail-closed)", tam2.status === 400 && /evidence validation failed/.test(tam2.text) && /sha256 mismatch/.test(tam2.text), tam2.text.slice(0, 130));

  // (c) missing evidence file → missing pointer
  const t3 = path.join(TMP, "tamper-missing");
  await unzipDir(zipAPath, t3);
  fs.rmSync(path.join(t3, firstPtr.path), { force: true });
  const t3zip = path.join(TMP, "tamper-missing.zip");
  await zipDir(t3, t3zip);
  const tam3 = await api(base, "POST", "/api/recovery/import", { token: USER_A.token, raw: fs.readFileSync(t3zip) });
  check("missing evidence file rejected", tam3.status === 400 && /missing:/.test(tam3.text), tam3.text.slice(0, 130));

  // (d) package without context.json
  const t4 = path.join(TMP, "tamper-noctx");
  await unzipDir(zipAPath, t4);
  fs.rmSync(path.join(t4, "context.json"), { force: true });
  const t4zip = path.join(TMP, "tamper-noctx.zip");
  await zipDir(t4, t4zip);
  const tam4 = await api(base, "POST", "/api/recovery/import", { token: USER_A.token, raw: fs.readFileSync(t4zip) });
  check("package without context.json rejected", tam4.status === 400 && /no context\.json/.test(tam4.text), tam4.text.slice(0, 110));

  // (e) secret value smuggled into config.env → structural rejection
  try {
    validateContextStructure({ ...zipCtx, config: { note: "x", env: { OPENAI_API_KEY: { set: true, value: SECRET_OPENAI } } } });
    check("non-redacted config value rejected", false, "no error thrown");
  } catch (e) {
    check("non-redacted config value rejected", e instanceof ContextValidationError && /non-redacted/.test(e.message), e.message.slice(0, 110));
  }
  check("tampered imports materialized NOTHING", fs.readdirSync(path.join(PROJECT, "platform-data", "recovery")).length === shellsBefore, `${shellsBefore} shells before/after`);

  // ============ [10] auth + tenant scoping ============
  console.log("\n[10] auth + tenant scoping");
  const anonImp = await api(base, "POST", "/api/recovery/import", { raw: zipA });
  check("unauthenticated import refused (401)", anonImp.status === 401, `status=${anonImp.status}`);
  const anonList = await api(base, "GET", "/api/recovery");
  check("unauthenticated list refused (401)", anonList.status === 401, `status=${anonList.status}`);
  const anonRes = await api(base, "POST", `/api/recovery/${REC1}/resume`, {});
  check("unauthenticated resume refused (401)", anonRes.status === 401, `status=${anonRes.status}`);
  const foreignGet = await api(base, "GET", `/api/recovery/${REC1}`, { token: USER_B.token });
  check("foreign user cannot see the shell (404, no existence leak)", foreignGet.status === 404, `status=${foreignGet.status}`);
  const foreignResume = await api(base, "POST", `/api/recovery/${REC1}/resume`, { token: USER_B.token });
  check("foreign user cannot resume (404)", foreignResume.status === 404, `status=${foreignResume.status}`);
  const foreignOrgImport = await api(base, "POST", `/api/recovery/import?orgId=${encodeURIComponent(ORG_ID)}`, { token: USER_B.token, raw: zipA });
  check("non-member org-scoped import denied (403)", foreignOrgImport.status === 403, `status=${foreignOrgImport.status}`);
  const bList = await api(base, "GET", "/api/recovery", { token: USER_B.token });
  check("foreign user's list is empty", bList.status === 200 && Array.isArray(bList.json) && bList.json.length === 0, `${bList.json?.length ?? "?"} shells`);
  const aList = await api(base, "GET", "/api/recovery", { token: USER_A.token });
  check("owner sees both shells", aList.status === 200 && [REC1, REC2].every((id) => aList.json.some((s) => s.jobId === id)), aList.json?.map((s) => s.jobId).join(", "));
  const badOrg = await api(base, "POST", "/api/recovery/import?orgId=../escape", { token: USER_A.token, raw: zipA });
  check("org id traversal rejected (400)", badOrg.status === 400, `status=${badOrg.status}`);

  // ============ cleanup ============
  console.log("\n[cleanup]");
  for (const id of createdShells) deleteRecoveryShell(id);
  for (const dir of [...createdArtifacts].reverse()) { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} }
  try { fs.rmSync(path.join(PROJECT, "artifacts", ORG_ID), { recursive: true, force: true }); } catch {}
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
  console.log("removed test artifacts + shells");
} finally {
  testServer.close();
  started.server.close();
  started.wss?.close?.();
  await closePool().catch(() => {});
}

const failed = results.filter((r) => !r).length;
console.log(`\n${results.length - failed}/${results.length} checks passed${failed ? ` — ${failed} FAILED` : ""}`);
process.exit(failed ? 1 : 0);
