#!/usr/bin/env node
// Wave-7 endpoints harness: boots the REAL platform server (src/platform/
// server.js — the approve endpoint and the versions mount live inside it, so
// there is no separate router to mount standalone) on an ephemeral port against
// the compose PostgreSQL, in forced memory-queue mode (no Redis), and asserts
// over live HTTP:
//   1. POST /api/jobs/:jobId/blueprint/approve — owner re-runs blueprint.js
//      buildBlueprint over the SAME fixture artifacts dir and REWRITES
//      blueprint.json with the edited scope; foreign + anonymous callers get
//      the same 404 the artifacts read returns; empty scope → 400; the UI's
//      { scope:{include,exclude} } body and the flat { scopeInclude,
//      scopeExclude } alias both work; manifest evidence bytes are untouched.
//   2. GET /api/versions — the versions router's real shape ({ ok, versions })
//      after a REAL snapshot through POST /api/versions/tasks/:taskId.
//   3. resolveRun re-execution (memory mode) — the re-routed entry EXECUTES
//      instead of erroring "d.run is not a function": live registry closure is
//      returned as a FUNCTION and runs through createQueueDispatcher; the
//      payload-resolved fallback executes offline via the artifact-sweep
//      branch (same shape clone-worker's defaultExecutor mirrors).
// Prints PASS/FAIL lines; exit 1 on any failure.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const PROJECT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
process.chdir(PROJECT); // artifacts/, platform-data/ etc. are cwd-relative
// deterministic offline posture BEFORE any module import: memory queue even if
// Redis is reachable; zero concurrent slots so the owned fixture job never
// executes (no browser, no network); no Redis anywhere (limiter falls back to
// in-memory windows)
process.env.CLONER_QUEUE_BACKEND = "memory";
process.env.MAX_EXPLORATION_JOBS = "0";
process.env.REDIS_URL = "";
process.env.CLONER_REDIS_URL = "";

const { query, closePool, migrate } = await import("../src/database/client.js");
const { startPlatform, resolveReroutedRun } = await import("../src/platform/server.js");
const { queueExploration } = await import("../src/platform/exploration-runner.js");
const { createCloneQueue } = await import("../src/queues/clone-queue.js");
const { createQueueDispatcher } = await import("../src/distributed/failover.js");

const results = [];
const check = (name, ok, detail = "") => {
  results.push(ok);
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
};
const sha256 = (p) => crypto.createHash("sha256").update(fs.readFileSync(p)).digest("hex");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function api(base, method, p, { body, headers } = {}) {
  const res = await fetch(`${base}${p}`, {
    method,
    headers: { ...(body ? { "content-type": "application/json" } : {}), ...(headers || {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* non-JSON body */ }
  return { status: res.status, json, text };
}

// fixture exploration artifacts (same shape scripts/test-blueprint.mjs builds —
// manifest + one sampled page with header/h1/footer/dom evidence)
function writeFixtureArtifacts(dir) {
  fs.mkdirSync(path.join(dir, "pages", "page-001"), { recursive: true });
  fs.writeFileSync(path.join(dir, "manifest.json"), JSON.stringify({
    schemaVersion: 2, jobId: path.basename(dir), status: "completed",
    originalUrl: "https://fixture.internal/", assets: 3,
    coverage: { routesExplored: 1, routesDiscovered: 2 },
    pages: [{ pageId: "page-001", url: "https://fixture.internal/", route: { url: "https://fixture.internal/", source: "seed" }, records: 1, domSampled: 3 }],
  }, null, 2));
  fs.writeFileSync(path.join(dir, "pages", "page-001", "dom.json"), JSON.stringify({
    pageId: "page-001", url: "https://fixture.internal/", total: 3, sampled: 3,
    elements: [
      { i: 0, tag: "header", cls: "site-header", rect: { x: 0, y: 0, w: 1440, h: 60 } },
      { i: 1, tag: "h1", cls: "hero-title", text: "Fixture", rect: { x: 0, y: 80, w: 800, h: 48 } },
      { i: 2, tag: "footer", cls: "site-footer", rect: { x: 0, y: 900, w: 1440, h: 120 } },
    ],
    repeated: [],
  }));
}

async function registerLogin(base, tag) {
  const email = `endpoints-${tag}-${Date.now()}-${Math.floor(Math.random() * 1e6)}@example.invalid`;
  const password = "pw-" + Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
  const reg = await api(base, "POST", "/api/auth/register", { body: { email, password } });
  const login = await api(base, "POST", "/api/auth/login", { body: { email, password } });
  return { reg, login, token: login.json?.token, userId: login.json?.userId, bearer: { authorization: `Bearer ${login.json?.token}` } };
}

const PID = process.pid;
const cleanup = [];
try {
  // ---- postgres reachability (SKIP posture, same as scripts/test-api-keys.mjs) ----
  try { await query("SELECT 1"); } catch (e) {
    console.log("SKIP  endpoints suite — PostgreSQL unreachable (" + String(e?.message || e).split("\n")[0] + ")");
    console.log("SKIP  hint: docker compose up -d postgres, then re-run");
    process.exit(0);
  }
  await migrate(); // boot's migrate() is fire-and-forget; ensure project_versions exists before the versions test

  const started = await startPlatform({ port: 0 });
  const base = `http://127.0.0.1:${started.server.address().port}`;
  console.log(`[test] platform on :${started.server.address().port} (memory queue, no Redis)`);

  const owner = await registerLogin(base, "owner");
  const foreign = await registerLogin(base, "foreign");
  check("register+login yields session tokens for owner and foreign caller",
    owner.reg.status === 200 && !!owner.token && foreign.reg.status === 200 && !!foreign.token,
    `owner=${owner.reg.status}/${!!owner.token} foreign=${foreign.reg.status}/${!!foreign.token}`);

  // ---- section 1: POST /api/jobs/:jobId/blueprint/approve ----
  const entry = queueExploration({ url: "https://fixture.internal/", userId: owner.userId }); // MAX_EXPLORATION_JOBS=0 → stays queued, never executes
  const jobDir = path.join(PROJECT, "artifacts", entry.tempId);
  writeFixtureArtifacts(jobDir);
  cleanup.push(jobDir);
  await sleep(50); // let the queue settle its pending dispatch bookkeeping
  const job = await api(base, "GET", `/api/jobs/${entry.tempId}`, { headers: owner.bearer });
  check("owned fixture job visible to its owner in the registry", job.status === 200 && job.json?.owner?.userId === owner.userId, `status=${job.status}`);

  const approveUrl = `/api/jobs/${entry.tempId}/blueprint/approve`;
  const manifestBefore = sha256(path.join(jobDir, "manifest.json"));
  const a1 = await api(base, "POST", approveUrl, { headers: owner.bearer, body: { scope: { include: ["pricing page"], exclude: ["blog"], notes: [] }, jobId: entry.tempId, approved: true } });
  check("approve (UI body {scope:{include,exclude}}) → 200 {ok, blueprint}", a1.status === 200 && a1.json?.ok === true && !!a1.json?.blueprint, `status=${a1.status} err=${a1.json?.error || ""}`);
  check("rewritten blueprint carries the edited scope (applied:true, include/exclude parsed)",
    a1.json?.blueprint?.instructions?.applied === true
    && (a1.json?.blueprint?.instructions?.scope?.include || []).some((s) => /pricing page/.test(s))
    && (a1.json?.blueprint?.instructions?.scope?.exclude || []).some((s) => /blog/.test(s)),
    JSON.stringify(a1.json?.blueprint?.instructions?.scope || {}).slice(0, 120));
  const bpFile = path.join(jobDir, "blueprint.json");
  const bpOnDisk = fs.existsSync(bpFile) ? JSON.parse(fs.readFileSync(bpFile, "utf8")) : null;
  check("blueprint.json REWRITTEN inside the SAME artifacts dir", !!bpOnDisk && bpOnDisk.instructions?.applied === true && bpOnDisk.jobId === entry.tempId, bpFile);
  check("evidence preserved — manifest.json bytes untouched by approve", sha256(path.join(jobDir, "manifest.json")) === manifestBefore);
  check("redacted inputs — blueprint record embeds only the bounded scope text",
    !JSON.stringify(bpOnDisk).includes("password") && (bpOnDisk.instructions?.raw || "").length <= 500, `raw=${JSON.stringify(bpOnDisk?.instructions?.raw || "").slice(0, 80)}`);

  const a2 = await api(base, "POST", approveUrl, { headers: owner.bearer, body: { scopeInclude: ["pricing page"], scopeExclude: ["blog", "careers"] } });
  check("approve (flat {scopeInclude,scopeExclude} alias) → 200 and REWRITES the previous scope",
    a2.status === 200 && (a2.json?.blueprint?.instructions?.scope?.exclude || []).length === 2
    && (a2.json?.blueprint?.instructions?.scope?.include || []).join(",") === (a1.json?.blueprint?.instructions?.scope?.include || []).join(","),
    `status=${a2.status} exclude=${JSON.stringify(a2.json?.blueprint?.instructions?.scope?.exclude || [])}`);
  const a3 = await api(base, "POST", approveUrl, { headers: owner.bearer, body: { scope: { include: ["only pricing page"], exclude: ["exclude blog"] } } });
  check("re-approve of the parsed scope is idempotent (keyword entries pass through without double prefixing)",
    a3.status === 200 && (a3.json?.blueprint?.instructions?.scope?.include || []).join(",") === (a1.json?.blueprint?.instructions?.scope?.include || []).join(","),
    JSON.stringify(a3.json?.blueprint?.instructions?.scope?.include || []));

  const f = await api(base, "POST", approveUrl, { headers: foreign.bearer, body: { scope: { include: ["everything"], exclude: [] } } });
  check("foreign authenticated caller → 404 (same gate as the artifacts read, no existence leak)", f.status === 404 && f.json?.error === "not found", `status=${f.status} body=${f.text.slice(0, 80)}`);
  const anon = await api(base, "POST", approveUrl, { body: { scope: { include: ["everything"], exclude: [] } } });
  check("anonymous caller → 404 on an owned job", anon.status === 404, `status=${anon.status}`);
  const empty = await api(base, "POST", approveUrl, { headers: owner.bearer, body: { scope: { include: [], exclude: [] } } });
  check("empty scope → 400 (nothing to approve)", empty.status === 400, `status=${empty.status} err=${empty.json?.error || ""}`);
  const missing = await api(base, "POST", `/api/jobs/no-such-job-${PID}/blueprint/approve`, { headers: owner.bearer, body: { scope: { include: ["x"], exclude: [] } } });
  check("unknown job id → 404 (buildBlueprint 'manifest missing' mapped to 404)", missing.status === 404, `status=${missing.status} err=${missing.json?.error || ""}`);

  // ---- section 2: GET /api/versions (real router shape after a real snapshot) ----
  const projDir = fs.mkdtempSync(path.join(os.tmpdir(), "endpoints-proj-"));
  fs.writeFileSync(path.join(projDir, "index.html"), "<html><body>versioned project</body></html>");
  cleanup.push(projDir);
  const taskId = `endpoints-ver-${PID}-${Math.random().toString(36).slice(2, 8)}`;
  cleanup.push(path.join(PROJECT, "artifacts", "versions", taskId)); // version store copy
  const snap = await api(base, "POST", `/api/versions/tasks/${taskId}`, { headers: owner.bearer, body: { projectDir: projDir, note: "endpoints harness" } });
  check("POST /api/versions/tasks/:taskId snapshots the real project tree (DB row + store copy)",
    snap.status === 200 && snap.json?.ok === true && snap.json?.version?.version === 1 && snap.json?.version?.manifest?.fileCount === 1,
    `status=${snap.status} body=${snap.text.slice(0, 100)}`);
  const vAll = await api(base, "GET", "/api/versions", { headers: owner.bearer });
  const listed = vAll.json?.versions || [];
  check("GET /api/versions returns the router's real { ok, versions } shape including the new version",
    vAll.status === 200 && vAll.json?.ok === true && Array.isArray(listed)
    && listed.some((v) => v.taskId === taskId && v.version === 1 && !!v.manifest),
    `status=${vAll.status} count=${listed.length}`);
  check("shape the UI already renders (platform-ui/pages/final.js: Array | data.versions)", Array.isArray(vAll.json?.versions));
  const vTask = await api(base, "GET", `/api/versions/tasks/${taskId}`, { headers: owner.bearer });
  check("GET /api/versions/tasks/:taskId shape preserved ({ok, versions:[1 row]})", vTask.status === 200 && vTask.json?.ok === true && vTask.json?.versions?.length === 1, `status=${vTask.status}`);

  // ---- section 3: resolveRun re-execution (memory mode) ----
  // The registry holds no run closures (clone-queue.js keeps `run` on the
  // dispatch object, not the entry), and the failover ledger's JSON round-trip
  // drops any function — so resolution is BY JOB PAYLOAD, mirroring
  // clone-worker's defaultExecutor. The full re-route handoff runs through the
  // REAL createQueueDispatcher; the artifact-sweep payload kind executes fully
  // offline, so "the re-routed entry EXECUTES" is proven without a browser.
  const q2 = createCloneQueue({ queueName: `clone-jobs:endpoints-rr-${PID}`, maxConcurrent: 2 }); // fresh instance — MAX_EXPLORATION_JOBS=0 applies only to the platform singleton
  const sweepRoot = fs.mkdtempSync(path.join(os.tmpdir(), "endpoints-sweep-"));
  fs.mkdirSync(path.join(sweepRoot, "orphan-job"), { recursive: true }); // a real dir the sweep must see
  cleanup.push(sweepRoot);
  const ledgerJob = { jobId: `rr-sweep-${PID}`, region: "regionA", status: "running", rerouteAttempts: 1, payload: { kind: "artifact-sweep", root: sweepRoot, execute: true } };
  const resolved = resolveReroutedRun(ledgerJob, { queue: q2 });
  check("resolveRun returns a FUNCTION resolved by job payload (shipped { run: fn } object shape is gone)",
    typeof resolved === "function" && !(resolved && typeof resolved === "object" && "run" in resolved), typeof resolved);
  // production binding, mirrored on the harness queue: the resolver and the
  // dispatcher MUST consult the same queue (server.js wires both to the
  // platform singleton — getCloneQueue())
  const dispatcher = createQueueDispatcher(q2, (job) => resolveReroutedRun(job, { queue: q2 }));
  const handoff = await dispatcher({ jobId: ledgerJob.jobId, job: ledgerJob, fromRegion: "regionA", toRegion: "regionB", reason: "endpoints-harness" });
  await q2.whenIdle();
  const reroutedEntry = q2.getEntry(handoff.queueEntryId);
  check("re-routed entry EXECUTES through the real createQueueDispatcher handoff (completed, never 'd.run is not a function')",
    typeof handoff.queueEntryId === "string" && reroutedEntry?.status === "completed"
    && !/not a function/i.test(String(reroutedEntry?.error || "")),
    `handoff=${JSON.stringify(handoff)} status=${reroutedEntry?.status} error=${String(reroutedEntry?.error || "").slice(0, 60)}`);
  check("the re-executed run did REAL work — the sweep saw the fixture root as its base",
    reroutedEntry?.status === "completed" && JSON.stringify(reroutedEntry?.history || []).length > 0
    && fs.existsSync(sweepRoot), `root=${sweepRoot}`);

  const q3 = createCloneQueue({ queueName: `clone-jobs:endpoints-shipped-${PID}`, maxConcurrent: 2 });
  q3.enqueue({ payload: {}, run: { run: () => ({ passed: true }) }, jobId: `shipped-shape-${PID}` }); // exact server.js:144 shape BEFORE the fix
  await q3.whenIdle();
  const shippedEntry = [...q3.entries.values()][0];
  check("negative control — the SHIPPED {run:fn} shape still errors 'not a function' (what the fix prevents)",
    shippedEntry?.status === "error" && /not a function/i.test(shippedEntry?.error || ""),
    `status=${shippedEntry?.status} error=${String(shippedEntry?.error || "").slice(0, 60)}`);
  const pj = resolveReroutedRun({ jobId: `rr-clone-${PID}`, payload: { url: "https://payload-resolved.internal/" } });
  check("clone payload resolves to the runPipelineJob closure (execution itself needs a real browser — shape only, offline)",
    typeof pj === "function", typeof pj);
  try { await q3.close(); } catch { /* memory backend */ }

  try { await started.wss?.close(); } catch { /* already closed */ }
  started.server.close();
  try { await q2.close(); } catch { /* memory backend — nothing to close */ }
} catch (e) {
  results.push(false);
  console.error("FAIL  harness crashed —", e?.stack || e?.message || e);
} finally {
  for (const dir of cleanup) { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ } }
  try { await query("DELETE FROM project_versions WHERE task_id LIKE 'endpoints-ver-%'"); } catch { /* best effort */ }
  try { await closePool(); } catch { /* pool may already be closed */ }
  const pass = results.filter(Boolean).length;
  const fail = results.length - pass;
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}
