#!/usr/bin/env node
// LANE 2 (4.0.12) targeted probe — tenant isolation on the REAL platform for
// the surfaces the org-scoped v2 probe (qa-probe-isolation.mjs) does not cover:
//   1. REAL bus-driven WebSocket events (the pipeline emit path, not a manual
//      platform.broadcast) — A's org-owned job events must not reach B, live
//      or via catchup replay. Runs FIRST (no v1 task yet → currentTaskId null,
//      the exact pre-fix fan-out-leak ordering), then again AFTER a v1 run.
//   2. the legacy v1 task store (POST /api/tasks without pipeline) — list,
//      detail, export POST + download for B (other org) and anonymous
//   3. a v2 org-owned job with a REAL completed manifest (stub run through the
//      queue adapter) — export POST + the advertised download URL
// Boots the REAL platform over compose PostgreSQL on an ephemeral port.
// Prints PASS/FAIL lines; exits nonzero when an isolation invariant fails.
process.env.PGCONNECT_TIMEOUT = process.env.PGCONNECT_TIMEOUT || "4";
process.env.CLONER_ALLOW_PRIVATE_TARGETS = "1";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { WebSocket } from "ws";

const PROJECT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
process.chdir(PROJECT);
const results = [];
const check = (name, ok, detail = "") => { results.push(ok); console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`); };

async function api(port, method, p, body, headers = {}) {
  const res = await fetch(`http://127.0.0.1:${port}${p}`, {
    method,
    headers: { ...(body ? { "content-type": "application/json" } : {}), ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null; try { json = JSON.parse(text); } catch {}
  return { status: res.status, json, text };
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const watchdog = setTimeout(() => { console.log("FAIL  global timeout (150s)"); process.exit(1); }, 150_000);
watchdog.unref();

const { migrate } = await import("../src/database/client.js");
await migrate();
const { startPlatform } = await import("../src/platform/server.js");
const platform = await startPlatform({ port: 0 });
const port = platform.server.address().port;
console.log(`platform on :${port}`);

const stamp = crypto.randomBytes(4).toString("hex");
const MARK = `QA-LANE2-MARK-${stamp}`;
const mkUser = async (letter) => {
  const email = `qg2-${letter}-${stamp}@test.local`;
  const password = crypto.randomBytes(12).toString("base64url");
  const reg = await api(port, "POST", "/api/auth/register", { email, password });
  if (reg.status !== 200) throw new Error("register failed: " + reg.text.slice(0, 120));
  const login = await api(port, "POST", "/api/auth/login", { email, password });
  return { email, token: login.json?.token, userId: reg.json?.userId };
};
const A = await mkUser("a"); // org A owner
const B = await mkUser("b"); // org B owner — the hostile tenant
const C = await mkUser("c"); // org A plain member (positive control)

const AH = { authorization: `Bearer ${A.token}` };
const BH = { authorization: `Bearer ${B.token}` };
const CH = { authorization: `Bearer ${C.token}` };

// ---- orgs via the real API + C invited into org A ----
const orgA = await api(port, "POST", "/api/orgs", { name: `QG2-A-${stamp}` }, AH);
const orgB = await api(port, "POST", "/api/orgs", { name: `QG2-B-${stamp}` }, BH);
check("setup: org A + org B created (201)", orgA.status === 201 && orgB.status === 201, `A:${orgA.status} B:${orgB.status}`);
const orgAId = orgA.json?.org?.id || orgA.json?.id;
const invite = await api(port, "POST", `/api/orgs/${orgAId}/invitations`, { email: C.email, role: "member" }, AH);
const accept = await api(port, "POST", "/api/orgs/invitations/accept", { token: invite.json?.invitation?.token ?? invite.json?.token }, CH);
check("setup: C accepted org A invitation", accept.status === 200 || accept.status === 201, `invite=${invite.status} accept=${accept.status}`);

// ---- WS sockets FIRST (before any v1 task runs → currentTaskId still null) --
const connectWs = (token) => new Promise((resolve, reject) => {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws${token ? `?token=${token}` : ""}`);
  const msgs = [];
  ws.on("message", (raw) => { try { msgs.push(JSON.parse(raw.toString())); } catch {} });
  ws.on("open", () => resolve({ ws, msgs }));
  ws.on("error", (e) => reject(new Error(String(e?.message || e))));
  setTimeout(() => reject(new Error("ws connect timeout")), 8000);
});
let recA = null, recB = null, recC = null;
try { recA = await connectWs(A.token); check("(a) WS: A connected", true); } catch (e) { check("(a) WS: A connected", false, e.message); }
try { recB = await connectWs(B.token); check("(a) WS: B connected", true); } catch (e) { check("(a) WS: B connected", false, e.message); }
try { recC = await connectWs(C.token); check("(a) WS: C connected (org A member)", true); } catch (e) { check("(a) WS: C connected", false, e.message); }
await sleep(500); // let catchups settle
for (const rec of [recA, recB, recC]) if (rec) rec.msgs.length = 0;

const q = (await import("../src/queues/clone-queue.js")).getCloneQueue();
const exploration = await import("../src/platform/exploration-runner.js");

// Run a REAL pipeline job owned by org A whose exploration emits bus events
// tagged with a unique URL marker (the same emit path a live clone uses).
// The pipeline fails fast on the closed loopback port — the registry entry is
// what matters, not the job outcome.
async function wsStubJob(mark) {
  const before = new Set(fs.readdirSync(path.join(PROJECT, "artifacts")));
  const entry = exploration.queueExploration({
    url: `http://127.0.0.1:1/?qa=${mark}`, // unique marker: appears in the pipeline's own log events
    userId: A.userId,
    orgId: orgAId,
  });
  await q.whenIdle();
  await sleep(100);
  const after = fs.readdirSync(path.join(PROJECT, "artifacts")).filter((d) => !before.has(d) && d.startsWith("exp-"));
  return { entry, artifactDirs: after };
}
const saw = (rec, mark) => rec && rec.msgs.some((m) => JSON.stringify(m).includes(mark));
const waitForSaw = async (rec, mark, ms = 6000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { if (saw(rec, mark)) return true; await sleep(100); }
  return saw(rec, mark);
};

const ws1 = await wsStubJob(`${MARK}-1`);
check("setup: WS stub org-A job #1 ran through the REAL pipeline", !["queued", "exploring", "reconstructing", "verifying"].includes(ws1.entry.status), `status=${ws1.entry.status}`);
await waitForSaw(recA, `${MARK}-1`);
check("(a) WS: org-A owner receives its own job's REAL pipeline events", saw(recA, `${MARK}-1`), saw(recA, `${MARK}-1`) ? "ok" : "not delivered");
check("(a) WS: other-org member C receives org-A job events (org membership)", saw(recC, `${MARK}-1`), saw(recC, `${MARK}-1`) ? "ok" : "not delivered");
check("(a) WS: B (other org) does NOT receive A's job events (REAL emit path)", !saw(recB, `${MARK}-1`), saw(recB, `${MARK}-1`) ? "LEAKED to other tenant" : "");

// catchup replay: a NEW B socket connecting afterwards must not see the mark
let recB2 = null;
try { recB2 = await connectWs(B.token); } catch {}
await sleep(300);
const sawCatchup = recB2 && recB2.msgs.some((m) => m.type === "catchup" && JSON.stringify(m).includes(`${MARK}-1`));
check("(a) WS: B's catchup replay does NOT contain A's job events", !sawCatchup, sawCatchup ? "LEAKED via catchup" : "");

// positive control: explicit task-tagged broadcast through the production path
for (const rec of [recA, recB, recC]) if (rec) rec.msgs.length = 0;
const ws1Id = ws1.entry.jobId || ws1.entry.tempId;
await platform.broadcast({ type: "task:done", task: ws1Id, data: { marker: `${MARK}-EXPLICIT` } });
await sleep(600);
check("(a) WS explicit broadcast: A receives, B does not",
  saw(recA, `${MARK}-EXPLICIT`) && !saw(recB, `${MARK}-EXPLICIT`),
  `A=${!!saw(recA, `${MARK}-EXPLICIT`)} B=${!!saw(recB, `${MARK}-EXPLICIT`)}`);

// ---- 1. legacy v1 task store (runs AFTER the WS section on purpose) ---------
const v1 = await api(port, "POST", "/api/tasks", { url: "http://127.0.0.1:1/" }, AH);
const v1Id = v1.json?.id;
check("setup: A created a v1 task (per-user store)", v1.status === 200 && !!v1Id, `status=${v1.status} id=${v1Id}`);
await sleep(300); // let the (failing) inline run settle; the task stays in the store

const v1GetB = await api(port, "GET", `/api/tasks/${v1Id}`, null, BH);
check("(a) API v1: B cannot GET A's v1 task", v1GetB.status === 404, `status=${v1GetB.status}`);
const v1ListB = await api(port, "GET", "/api/tasks", null, BH);
check("(a) API v1: B's task list does NOT include A's v1 task", Array.isArray(v1ListB.json) && !v1ListB.json.some((t) => t.id === v1Id));
const v1GetAnon = await api(port, "GET", `/api/tasks/${v1Id}`);
check("(a) API v1: anonymous cannot GET A's v1 task", v1GetAnon.status === 404, `status=${v1GetAnon.status}`);
const v1ListAnon = await api(port, "GET", "/api/tasks");
check("(a) API v1: anonymous list does NOT include A's v1 task", Array.isArray(v1ListAnon.json) && !v1ListAnon.json.some((t) => t.id === v1Id));

const v1ExpB = await api(port, "POST", `/api/export/${v1Id}`, {}, BH);
check("(a) EXPORT v1: B cannot export A's v1 task", [404, 403].includes(v1ExpB.status), `status=${v1ExpB.status}`);
const v1ExpAnon = await api(port, "POST", `/api/export/${v1Id}`, {});
check("(a) EXPORT v1: anonymous cannot export A's v1 task", [404, 403, 401].includes(v1ExpAnon.status), `status=${v1ExpAnon.status}`);
const v1DlB = await api(port, "GET", `/api/export/${v1Id}/download`, null, BH);
check("(a) EXPORT v1: B cannot download A's v1 export", [404, 403].includes(v1DlB.status), `status=${v1DlB.status}`);
const v1DlAnon = await api(port, "GET", `/api/export/${v1Id}/download`);
check("(a) EXPORT v1: anonymous cannot download A's v1 export", [404, 403, 401].includes(v1DlAnon.status), `status=${v1DlAnon.status}`);
// positive control: the OWNER can export + download
const v1ExpA = await api(port, "POST", `/api/export/${v1Id}`, {}, AH);
check("(a) EXPORT v1: owner CAN export own v1 task (positive control)", v1ExpA.status === 200, `status=${v1ExpA.status}`);
if (v1ExpA.status === 200) {
  const v1DlA = await fetch(`http://127.0.0.1:${port}/api/export/${v1Id}/download`, { headers: AH });
  check("(a) EXPORT v1: owner CAN download own export (positive control)", v1DlA.status === 200, `status=${v1DlA.status}`);
  try { await v1DlA.arrayBuffer(); } catch {}
}

// ---- 2. second REAL-bus emission AFTER the v1 run: attribution must not be
// hijacked by the stale v1 currentTaskId global (A/C still receive, B doesn't)
for (const rec of [recA, recB, recC]) if (rec) rec.msgs.length = 0;
const ws2 = await wsStubJob(`${MARK}-2`);
check("setup: WS stub org-A job #2 ran after a v1 task", !["queued", "exploring", "reconstructing", "verifying"].includes(ws2.entry.status), `status=${ws2.entry.status}`);
await waitForSaw(recA, `${MARK}-2`);
check("(a) WS after v1 run: A still receives own org-job events (no id hijack)", saw(recA, `${MARK}-2`), saw(recA, `${MARK}-2`) ? "ok" : "not delivered");
check("(a) WS after v1 run: B still excluded", !saw(recB, `${MARK}-2`), saw(recB, `${MARK}-2`) ? "LEAKED" : "");

// ---- 3. v2 org-owned job with a REAL completed manifest (stub through the adapter)
let stubTempId = null;
{
  const artifactsRoot = path.join(PROJECT, "artifacts");
  const entry = q.enqueue({
    payload: { url: "https://stub.invalid/qa-lane2" },
    owner: { userId: A.userId, orgId: orgAId },
    run: async ({ entry: e, report }) => {
      stubTempId = e.tempId;
      report("exploring");
      // emulate a completed v2 job: manifest + reconstructed project tree
      fs.mkdirSync(path.join(artifactsRoot, e.tempId), { recursive: true });
      fs.mkdirSync(path.join(artifactsRoot, e.tempId + "-project"), { recursive: true });
      fs.writeFileSync(path.join(artifactsRoot, e.tempId, "manifest.json"), JSON.stringify({ status: "complete", pages: [] }));
      fs.writeFileSync(path.join(artifactsRoot, e.tempId + "-project", "index.html"), "<html><body>stub</body></html>");
      e.status = "completed";
      report("completed");
    },
  });
  await q.whenIdle();
  check("setup: stub v2 org-A job completed through the adapter", entry.status === "completed" && !!stubTempId, `status=${entry.status} tempId=${stubTempId}`);
}
const jobB = await api(port, "GET", `/api/tasks/${stubTempId}`, null, BH);
check("(a) API v2: B cannot GET A's org job detail", jobB.status === 404, `status=${jobB.status}`);
const expB = await api(port, "POST", `/api/export/${stubTempId}`, {}, BH);
check("(a) EXPORT v2: B cannot export A's org job", [404, 403].includes(expB.status), `status=${expB.status}`);
const expAnon = await api(port, "POST", `/api/export/${stubTempId}`, {});
check("(a) EXPORT v2: anonymous cannot export A's org job", [404, 403, 401].includes(expAnon.status), `status=${expAnon.status}`);
const expA = await api(port, "POST", `/api/export/${stubTempId}`, {}, AH);
check("(a) EXPORT v2: owner CAN export own org job (positive control)", expA.status === 200, `status=${expA.status} ${String(expA.json?.error || expA.text).slice(0, 80)}`);
if (expA.status === 200) {
  // the export response advertises this exact URL — it must serve the v2 zip
  const dlA = await fetch(`http://127.0.0.1:${port}${expA.json?.download || `/api/export/${stubTempId}/download`}`, { headers: AH });
  check("(a) EXPORT v2: advertised download URL serves the v2 zip", dlA.status === 200,
    `status=${dlA.status} body=${(await dlA.text().catch(() => "")).slice(0, 60)}`);
}

// ---- cleanup ---------------------------------------------------------------
try { recA?.ws.close(); recB?.ws.close(); recC?.ws.close(); recB2?.ws.close(); } catch {}
for (const d of [...(ws1.artifactDirs || []), ...(ws2.artifactDirs || [])]) {
  try { fs.rmSync(path.join(PROJECT, "artifacts", d), { recursive: true, force: true }); } catch {}
  try { fs.rmSync(path.join(PROJECT, "artifacts", d + "-project"), { recursive: true, force: true }); } catch {}
}
for (const id of [v1Id, stubTempId]) {
  try { await api(port, "DELETE", `/api/tasks/${id}`, null, AH); } catch {}
  try { fs.rmSync(path.join(PROJECT, "platform-data", id), { recursive: true, force: true }); } catch {}
  try { fs.rmSync(path.join(PROJECT, "artifacts", id), { recursive: true, force: true }); } catch {}
  try { fs.rmSync(path.join(PROJECT, "artifacts", id + "-project"), { recursive: true, force: true }); } catch {}
}
try { platform.server.closeAllConnections?.(); } catch {}
try { await new Promise((r) => platform.server.close(r)); } catch {}
const { closePool } = await import("../src/database/client.js");
try { await closePool(); } catch {}

const failed = results.filter((r) => !r).length;
console.log(`\nRESULT: ${failed === 0 ? "PASS" : "FAIL"}  (${results.length - failed}/${results.length} checks passed)`);
process.exit(failed === 0 ? 0 : 1);
