#!/usr/bin/env node
// WebSocket authentication + task-scoping e2e (spec §6/§9).
// Boots the platform on an EPHEMERAL port, registers two users via /api/auth/*,
// creates one DB-owned task per user (task-repository), then connects three WS
// clients from loopback: A (token via ?token=), B (token via cookie) and
// C (unauthenticated — the legacy dashboard posture). Asserts:
//   • A receives A's task events and NOT B's (and the reverse for B)
//   • C is refused nothing on loopback and still receives every broadcast
//     (the legacy room keeps the dashboard working)
//   • tasks with no DB owner fan out to the legacy room only
//   • v2 exploration-registry jobs are public to authenticated users
//   • client "join" subscriptions keep working (own task for A, any task for C)
//   • an unauthenticated upgrade from a non-loopback address is refused 401
//     during the handshake while an authenticated one succeeds
//   • with PostgreSQL unreachable, an upgrade resolves to unauthenticated
//     without crashing (child-process unit check)
// Prints PASS/FAIL lines, exits nonzero on any failure, closes everything it
// opened. Runtime-generated throwaway passwords/tokens only — nothing hardcoded.
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { execFile } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { WebSocket } from "ws";

const PROJECT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
process.chdir(PROJECT); // platform-data + cloner.config.json + artifacts/ are cwd-relative
// the registry-injection probe targets a closed loopback port — the SSRF guard
// would (correctly) reject it; this test explicitly opts in
process.env.CLONER_ALLOW_PRIVATE_TARGETS = "1";
// dynamic imports AFTER chdir — tasks.js pins ROOT to process.cwd() at module load
const { migrate, query, closePool } = await import("../src/database/client.js");
const taskRepo = await import("../src/database/task-repository.js");
const { startPlatform } = await import("../src/platform/server.js");

const results = [];
const check = (name, ok, detail = "") => {
  results.push(ok);
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
};
const skip = (name, detail) => console.log(`SKIP  ${name}${detail ? ` — ${detail}` : ""}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (fn, timeoutMs = 2500, stepMs = 25) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) { if (fn()) return true; await sleep(stepMs); }
  return fn();
};

async function api(port, method, p, body) {
  const res = await fetch(`http://127.0.0.1:${port}${p}`, {
    method,
    headers: body ? { "content-type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}
  return { status: res.status, json, text };
}

function connectWs(url, opts = {}, label) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, opts);
    const rec = { ws, messages: [], open: false, name: label };
    const t = setTimeout(() => { ws.terminate(); reject(new Error("connect timeout: " + url)); }, 6000);
    ws.on("open", () => { rec.open = true; clearTimeout(t); resolve(rec); });
    ws.on("error", (e) => { clearTimeout(t); reject(new Error(String(e?.message || e))); });
    ws.on("message", (raw) => { try { rec.messages.push(JSON.parse(raw.toString())); } catch {} });
  });
}
const saw = (rec, marker) => rec.messages.some((m) => JSON.stringify(m).includes(marker));
const find = (rec, marker) => rec.messages.find((m) => JSON.stringify(m).includes(marker));

// emit through the production scoped-broadcast path, then check delivery
async function expectDelivery(broadcast, task, marker, { yes = [], no = [] }) {
  await broadcast({ type: "task:done", task, data: { verification: { passed: true }, marker } });
  for (const rec of yes) {
    const ok = await waitFor(() => saw(rec, marker));
    check(`scope ${marker}: ${rec.name} receives`, ok && find(rec, marker)?.task === task, ok ? "" : "NOT received");
  }
  await sleep(800); // settle window for the absence assertions
  for (const rec of no) {
    check(`scope ${marker}: ${rec.name} does NOT receive`, !saw(rec, marker), saw(rec, marker) ? "received foreign event" : "");
  }
}

function nonLoopbackIPv4() {
  for (const addrs of Object.values(os.networkInterfaces())) {
    for (const a of addrs || []) if (a.family === "IPv4" && !a.internal) return a.address;
  }
  return null;
}
function expectRejected(url) { // resolve with the client-side error text
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const t = setTimeout(() => { ws.terminate(); reject(new Error("timeout waiting for rejection")); }, 8000);
    ws.on("open", () => { clearTimeout(t); ws.close(); reject(new Error("upgrade unexpectedly succeeded")); });
    ws.on("error", (e) => { clearTimeout(t); resolve(String(e?.message || e)); });
  });
}
function expectAccepted(url, opts = {}) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, opts);
    const t = setTimeout(() => { ws.terminate(); reject(new Error("timeout waiting for open")); }, 8000);
    ws.on("open", () => { clearTimeout(t); resolve({ ws, open: true }); ws.close(); });
    ws.on("error", (e) => { clearTimeout(t); reject(new Error(String(e?.message || e))); });
  });
}

const watchdog = setTimeout(() => { console.log("FAIL  global timeout (180s)"); process.exit(1); }, 180_000);
watchdog.unref();

let platform = null;
const recs = [];
try {
  // ---------- setup: DB schema first (idempotent), then the platform ----------
  await migrate(); // awaited so /api/auth/* works immediately after boot
  platform = await startPlatform({ port: 0 }); // { server, wss, port, broadcast }
  const port = platform.server.address().port;
  const broadcast = platform.broadcast;
  console.log(`platform on :${port}`);

  // ---------- users A + B (runtime-generated throwaway secrets) ----------
  const stamp = Date.now().toString(36) + crypto.randomBytes(3).toString("hex");
  const mkUser = async (letter) => {
    const email = `ws-auth-${letter}-${stamp}@test.local`;
    const password = crypto.randomBytes(12).toString("base64url"); // never logged, never stored in this file
    const reg = await api(port, "POST", "/api/auth/register", { email, password });
    if (reg.status !== 200) throw new Error("register failed: " + reg.text.slice(0, 120));
    const login = await api(port, "POST", "/api/auth/login", { email, password });
    if (login.status !== 200 || !login.json?.token) throw new Error("login failed: " + login.text.slice(0, 120));
    return { userId: reg.json.userId, token: login.json.token, email };
  };
  const userA = await mkUser("a");
  const userB = await mkUser("b");
  check("auth: two users registered + logged in", !!userA.token && !!userB.token && userA.userId !== userB.userId);

  // ---------- one DB-owned task per user (ownership lives in task-repository) ----------
  const taskA = await taskRepo.createTask({ userId: userA.userId, url: "https://task-a.invalid/", options: {} });
  const taskB = await taskRepo.createTask({ userId: userB.userId, url: "https://task-b.invalid/", options: {} });
  check("tasks: DB-backed tasks created with per-user ownership", !!taskA?.id && !!taskB?.id && taskA.user_id === userA.userId && taskB.user_id === userB.userId);

  // ---------- three WS clients from loopback ----------
  recs.push(await connectWs(`ws://127.0.0.1:${port}/ws?token=${userA.token}`, {}, "A (token via ?token=)"));
  recs.push(await connectWs(`ws://127.0.0.1:${port}/ws`, { headers: { cookie: `cloner_session=${userB.token}` } }, "B (token via cookie)"));
  recs.push(await connectWs(`ws://127.0.0.1:${port}/ws`, {}, "C (unauthenticated loopback)"));
  const [recA, recB, recC] = recs;
  let allCatchup = true;
  for (const rec of recs) allCatchup = allCatchup && (await waitFor(() => rec.messages.some((m) => m.type === "catchup"), 3000));
  check("connect: all three upgrades accepted on loopback + catchup delivered", allCatchup && recC.open, recs.map((r) => `${r.name}:${r.open ? "open" : "closed"}`).join(" · "));
  await sleep(400);
  for (const rec of recs) rec.messages.length = 0; // drop replay noise before the emit phase

  // ---------- task scoping ----------
  await expectDelivery(broadcast, taskA.id, "MARK-A-1", { yes: [recA, recC], no: [recB] });
  await expectDelivery(broadcast, taskB.id, "MARK-B-1", { yes: [recB, recC], no: [recA] });

  // global event (no task id) → everyone, exactly as before
  await broadcast({ type: "log", data: { level: "info", msg: "MARK-GLOBAL-1" } });
  let globalOk = true;
  for (const rec of recs) globalOk = globalOk && (await waitFor(() => saw(rec, "MARK-GLOBAL-1")));
  check("scope MARK-GLOBAL-1: untagged event reaches all three clients", globalOk);

  // task with no DB owner → legacy room only (fail closed for authenticated fan-out)
  const unownedId = crypto.randomUUID();
  await expectDelivery(broadcast, unownedId, "MARK-UNOWNED-1", { yes: [recC], no: [recA, recB] });

  // ---------- v2 exploration registry → public to authenticated users ----------
  const explore = await api(port, "POST", "/api/jobs/explore", { url: "http://127.0.0.1:1/" }); // closed port → fails fast in background
  check("v2: exploration job accepted into the registry", explore.status === 200 && !!explore.json?.jobId,
    explore.status === 200 ? `jobId=${explore.json?.jobId}` : (explore.json?.error || explore.text).slice(0, 120));
  if (explore.json?.jobId) await expectDelivery(broadcast, explore.json.jobId, "MARK-V2-1", { yes: [recA, recB, recC], no: [] });

  // ---------- client "join" subscriptions keep working ----------
  recA.ws.send(JSON.stringify({ type: "join", task: taskA.id })); // own task → accepted
  await sleep(200);
  await expectDelivery(broadcast, taskA.id, "MARK-A-2", { yes: [recA, recC], no: [recB] });
  recC.ws.send(JSON.stringify({ type: "join", task: taskB.id })); // legacy client → unchanged
  await sleep(200);
  await expectDelivery(broadcast, taskB.id, "MARK-B-2", { yes: [recB, recC], no: [recA] });

  // ---------- handshake enforcement from a non-loopback address ----------
  const lanIp = nonLoopbackIPv4();
  if (lanIp) {
    const err = await expectRejected(`ws://${lanIp}:${port}/ws`);
    check("handshake: unauthenticated non-loopback upgrade refused with 401", /401/.test(err), err);
    const ok = await expectAccepted(`ws://${lanIp}:${port}/ws?token=${userA.token}`);
    check("handshake: authenticated non-loopback upgrade succeeds", ok.open);
  } else {
    skip("handshake: non-loopback checks — no non-internal IPv4 interface on this machine");
  }

  // ---------- PostgreSQL unreachable → unauthenticated, no crash ----------
  const childDir = fs.mkdtempSync(path.join(os.tmpdir(), "ws-auth-child-"));
  const childPath = path.join(childDir, "db-down.mjs");
  fs.writeFileSync(childPath, `
process.env.PGHOST = "127.0.0.1";
process.env.PGPORT = "1"; // closed loopback port → PostgreSQL unreachable
const mod = await import(process.argv[2]); // src/platform/ws-auth.js
const viaQuery = await mod.authenticateUpgrade({ url: "/ws?token=not-a-valid-token", headers: {} });
const viaCookie = await mod.authenticateUpgrade({ url: "/ws", headers: { cookie: "cloner_session=also-invalid" } });
if (viaQuery !== null || viaCookie !== null) {
  console.log("CHILD-FAIL expected null identities, got " + JSON.stringify(viaQuery) + " / " + JSON.stringify(viaCookie));
  process.exit(1);
}
console.log("CHILD-OK");
process.exit(0);
`);
  const child = await new Promise((resolve) => {
    execFile(process.execPath, [childPath, pathToFileURL(path.join(PROJECT, "src", "platform", "ws-auth.js")).href],
      { timeout: 30_000, windowsHide: true, env: { ...process.env, PGHOST: "127.0.0.1", PGPORT: "1" } },
      (err, stdout) => resolve({ err, stdout: String(stdout || "") }));
  });
  check("db-down: upgrade auth resolves to unauthenticated without crashing", !child.err && child.stdout.includes("CHILD-OK"),
    (child.err ? String(child.err.message || child.err).split("\n")[0] : child.stdout.trim().split("\n").pop() || ""));
  try { fs.rmSync(childDir, { recursive: true, force: true }); } catch {}
} catch (e) {
  check("no unexpected crash", false, String(e?.stack || e).split("\n")[0]);
} finally {
  // ---------- close everything we opened ----------
  for (const rec of recs) { try { rec.ws.close(); } catch {} }
  await sleep(200);
  try { // remove the two test users (cascades their sessions + tasks)
    const { rows } = await query("SELECT email FROM users WHERE email LIKE 'ws-auth-%@test.local'");
    if (rows.length) await query("DELETE FROM users WHERE email LIKE 'ws-auth-%@test.local'");
  } catch {}
  if (platform) {
    try { platform.server.closeAllConnections?.(); await new Promise((r) => platform.server.close(r)); } catch {}
  }
  try { await closePool(); } catch {}
}

const fails = results.filter((r) => !r).length;
console.log(`\n${fails ? "RESULT: FAIL" : "RESULT: PASS"}  (${results.length - fails}/${results.length} checks passed)`);
process.exit(fails ? 1 : 0);
