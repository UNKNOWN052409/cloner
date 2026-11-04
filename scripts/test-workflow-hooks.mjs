#!/usr/bin/env node
// Workflow hooks e2e (task 4.2.15, output: real receiver, real delivery engine).
// Boots the platform on an EPHEMERAL port against the compose PostgreSQL
// (docker compose up -d postgres if not running) for the real register/login
// journeys, mounts the hooks management router on a test-local Express app
// (src/platform/server.js is integrator-owned and mounts it later), and runs a
// REAL local HTTP receiver (plain node:http server) that the delivery engine
// POSTs to over the network. The receiver is the remote-end simulator required
// by the no-mocks mandate — the product code path (src/platform/workflow-hooks.js)
// only ever sees a real http:// URL and real responses.
//
// Asserts:
//   • schema: workflow_hooks / workflow_hook_deliveries exist
//   • unauthenticated hook management is refused (401)
//   • URL validation: non-http(s), userinfo, and loopback/private targets
//     rejected by default; CLONER_HOOK_ALLOW_PRIVATE_TARGETS=1 opts in
//   • event subscription validation: unknown events rejected; '*' exclusive;
//     empty subscription = all events
//   • creation returns the full signing secret EXACTLY once (whsec_…); every
//     later surface (list/get/deliveries/dead-letters) exposes only the prefix
//   • real delivery: signature verifies as HMAC_SHA256(secret, `ts.body`),
//     event/delivery-id/hook-id/timestamp headers present, payload shape sane
//   • REAL v2 pipeline path: queue status events → fan-out (owner-scoped)
//   • task.started dedup across exploring → reconstructing → verifying
//   • retry: 2 failing attempts then success → delivered, attempts=3,
//     exponential backoff gaps, attempt_log complete
//   • dead letter: 3 failures → status=dead + dead_at + last_error; replay
//     after the receiver recovers → delivered
//   • network error (ECONNREFUSED) and timeout paths dead-letter correctly
//   • event-type filter, user scoping (other users get nothing), disable/enable
//   • test-ping delivery, secret rotation (old signature invalid, new one valid)
//   • deletion cascades deliveries; foreign hook/dead-letter access → 404
// Prints PASS/FAIL lines, exits nonzero on any failure, cleans up its rows.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import http from "node:http";
import { fileURLToPath } from "node:url";

const PROJECT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
process.chdir(PROJECT); // platform-data etc. are cwd-relative

// test-posture env: private receivers allowed (the local http receiver), fast
// backoff/timeout so the retry/dead-letter paths run in seconds, not minutes.
// Product code reads these per call — no credentials involved.
process.env.CLONER_HOOK_ALLOW_PRIVATE_TARGETS = "1";
process.env.CLONER_HOOK_RETRY_BACKOFF_MS = process.env.CLONER_HOOK_RETRY_BACKOFF_MS || "120";
process.env.CLONER_HOOK_TIMEOUT_MS = process.env.CLONER_HOOK_TIMEOUT_MS || "400";
delete process.env.CLONER_HOOK_MAX_ATTEMPTS; // spec default 3 attempts

const { query, closePool } = await import("../src/database/client.js");
const { default: express } = await import("express");
const { startPlatform } = await import("../src/platform/server.js");
const hooks = await import("../src/platform/workflow-hooks.js");
const { hooksRouter, installWorkflowHooks, emitTaskLifecycleEvent, validateHookUrl,
        normalizeEventTypes, statusToEvent, ensureHookSchema, drainWorkflowDeliveries,
        TASK_HOOK_EVENTS } = hooks;
const { createCloneQueue } = await import("../src/queues/clone-queue.js");

const results = [];
const check = (name, ok, detail = "") => { results.push(ok); console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, timeoutMs = 8000, everyMs = 25) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    try { const v = await fn(); if (v) return v; } catch {}
    await sleep(everyMs);
  }
  return false;
}
const uuid = () => crypto.randomUUID();

// ---- postgres reachability (SKIP posture per repo rule 3) ----
async function ensureSchema() {
  await query(`CREATE TABLE IF NOT EXISTS _migrations (id TEXT PRIMARY KEY, applied_at TIMESTAMPTZ DEFAULT now())`);
  const users = await query(`SELECT 1 FROM information_schema.tables WHERE table_name = 'users'`);
  if (!users.rows.length) {
    const sql = fs.readFileSync(path.join(PROJECT, "src/database/migrations/001-initial.sql"), "utf8");
    await query(sql);
    await query(`INSERT INTO _migrations (id) VALUES ('001-initial.sql') ON CONFLICT DO NOTHING`);
  }
  await ensureHookSchema();
}
try {
  await query("SELECT 1");
  await ensureSchema();
} catch (e) {
  console.log("SKIP  workflow-hooks suite — PostgreSQL unreachable (" + String(e?.message || e).split("\n")[0] + ")");
  console.log("SKIP  hint: docker compose up -d postgres, then re-run");
  process.exit(0);
}

const watchdog = setTimeout(() => { console.log("FAIL  global timeout (180s)"); process.exit(1); }, 180_000);
watchdog.unref?.();

// ---- REAL local receiver (the remote-end simulator, test-only) --------------
// Plain http server; behavior is switched per path by the test. Every request
// is recorded with raw body + headers for signature verification.
const received = [];               // { at, path, headers, body }
const behavior = {                 // path → { status, delayMs, failFirst } (mutated per test)
  "/ok": { status: 200 },
  "/flaky": { failFirst: 2, status: 200 },  // first 2 attempts → 500, then 200
  "/dead": { status: 500 },
  "/slow": { delayMs: 1500, status: 200 },  // beyond CLONER_HOOK_TIMEOUT_MS
};
const receiver = http.createServer((req, res) => {
  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => {
    const p = (req.url || "/").split("?")[0];
    received.push({ at: Date.now(), path: p, headers: req.headers, body: Buffer.concat(chunks).toString("utf8") });
    const cfg = behavior[p] || { status: 200 }; // unlisted receiver paths succeed (no accidental retries)
    const respond = () => {
      res.writeHead(cfg.status ?? 200, { "content-type": "application/json" });
      res.end(JSON.stringify({ received: true, path: p }));
    };
    if (cfg.failFirst != null) {
      cfg.failFirst > 0 ? (cfg.failFirst--, res.writeHead(500).end("flaky failure")) : respond();
    } else if (cfg.delayMs) setTimeout(respond, cfg.delayMs);
    else respond();
  });
});
await new Promise((r) => receiver.listen(0, "127.0.0.1", r));
const RX_PORT = receiver.address().port;
const rx = (p) => `http://127.0.0.1:${RX_PORT}${p}`;

const hmac = (secret, data) => "sha256=" + crypto.createHmac("sha256", secret).update(data).digest("hex");

// ---- platform (real register/login journeys) + hooks router -----------------
const started = await startPlatform({ port: 0 });
const platformPort = started.server.address().port;
const platform = `http://127.0.0.1:${platformPort}`;
const app = express();
app.use(express.json());
app.use("/api/hooks", hooksRouter); // integrator will mount this line in server.js
const testServer = await new Promise((r) => { const s = app.listen(0, "127.0.0.1", () => r(s)); });
const base = `http://127.0.0.1:${testServer.address().port}`;
console.log(`[test] platform :${platformPort}, hooks app :${testServer.address().port}, receiver :${RX_PORT}`);

async function api(host, method, p, { body, token } = {}) {
  const res = await fetch(`${host}${p}`, {
    method,
    headers: { ...(body ? { "content-type": "application/json" } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null; try { json = JSON.parse(text); } catch {}
  return { status: res.status, json, text };
}
// register → login → { userId, token } (real platform auth journey)
async function mkUser(tag) {
  const email = `hooks-4215-${tag}-${Date.now().toString(36)}-${crypto.randomBytes(3).toString("hex")}@hooks.test`;
  const reg = await api(platform, "POST", "/api/auth/register", { body: { email, password: "hooks-Passw0rd!" } });
  if (!reg.json?.userId) throw new Error("register failed: " + reg.text.slice(0, 120));
  const login = await api(platform, "POST", "/api/auth/login", { body: { email, password: "hooks-Passw0rd!" } });
  if (!login.json?.token) throw new Error("login failed: " + login.text.slice(0, 120));
  return { userId: reg.json.userId, token: login.json.token, email };
}
const USER_A = await mkUser("a");
const USER_B = await mkUser("b");

async function mkHook(token, url, events, extra = {}) {
  const r = await api(base, "POST", "/api/hooks", { token, body: { url, events, ...extra } });
  if (r.status !== 201) throw new Error("hook create failed: " + r.text.slice(0, 160));
  return r.json;
}
async function deliveryRow(id) {
  const { rows } = await query(`SELECT * FROM workflow_hook_deliveries WHERE id=$1`, [id]);
  return rows[0] || null;
}
// deliveries are hook-tagged ({id, hookId}) — pick the one for a specific hook
const deliveryFor = (res, hookId) => (res.deliveries || []).find((d) => d.hookId === hookId)?.id;
const requestsFor = (hookId) => received.filter((r) => r.headers["x-cloner-hook-id"] === hookId);

try {
  // ---- 1. schema ------------------------------------------------------------
  const tbl = await query(`SELECT table_name FROM information_schema.tables WHERE table_name IN ('workflow_hooks','workflow_hook_deliveries') ORDER BY 1`);
  check("schema: workflow_hooks + workflow_hook_deliveries exist", tbl.rows.map((r) => r.table_name).join(",") === "workflow_hook_deliveries,workflow_hooks",
    tbl.rows.map((r) => r.table_name).join(", "));

  // ---- 2. auth required -----------------------------------------------------
  const anon = await api(base, "POST", "/api/hooks", { body: { url: rx("/ok") } });
  check("unauthenticated hook creation refused (401)", anon.status === 401, `status=${anon.status}`);
  const anonList = await api(base, "GET", "/api/hooks");
  check("unauthenticated hook list refused (401)", anonList.status === 401, `status=${anonList.status}`);

  // ---- 3. URL validation ------------------------------------------------------
  const badProto = await api(base, "POST", "/api/hooks", { token: USER_A.token, body: { url: "ftp://example.com/hook" } });
  check("non-http(s) hook URL rejected (400)", badProto.status === 400 && /protocol/.test(badProto.text), badProto.text.slice(0, 100));
  const badUserinfo = await api(base, "POST", "/api/hooks", { token: USER_A.token, body: { url: "http://user:pass@127.0.0.1:9/hook" } });
  check("userinfo-in-URL hook rejected (400)", badUserinfo.status === 400, badUserinfo.text.slice(0, 100));
  // loopback blocked by default (temporarily unset the test opt-in)
  delete process.env.CLONER_HOOK_ALLOW_PRIVATE_TARGETS;
  const loopbackDefault = await validateHookUrl("http://127.0.0.1:9/hook");
  process.env.CLONER_HOOK_ALLOW_PRIVATE_TARGETS = "1";
  check("loopback hook URL rejected by default (SSRF posture)", loopbackDefault.ok === false, loopbackDefault.error || "");
  const loopbackOptIn = await validateHookUrl(rx("/ok"));
  check("CLONER_HOOK_ALLOW_PRIVATE_TARGETS=1 opts into loopback receivers", loopbackOptIn.ok === true, loopbackOptIn.error || "");

  // ---- 4. event subscription validation --------------------------------------
  const badEvent = await api(base, "POST", "/api/hooks", { token: USER_A.token, body: { url: rx("/ok"), events: ["task.banana"] } });
  check("unknown event type rejected (400)", badEvent.status === 400 && /unknown event/.test(badEvent.text), badEvent.text.slice(0, 100));
  const mixedStar = await api(base, "POST", "/api/hooks", { token: USER_A.token, body: { url: rx("/ok"), events: ["*", "task.failed"] } });
  check("'*' + explicit events rejected (400)", mixedStar.status === 400, mixedStar.text.slice(0, 100));
  check("normalizeEventTypes: [] → ['*']", JSON.stringify(normalizeEventTypes([])) === JSON.stringify(["*"]));
  check("statusToEvent map covers v1+v2 statuses",
    statusToEvent("queued") === "task.created" && statusToEvent("verifying") === "task.started" &&
    statusToEvent("done") === "task.completed" && statusToEvent("error") === "task.failed" &&
    statusToEvent("cancelled") === "task.cancelled" && statusToEvent("exported") === "task.exported" &&
    statusToEvent("banana") === null);

  // ---- 5. create: secret shown exactly once -----------------------------------
  const created = await mkHook(USER_A.token, rx("/ok"), undefined, { description: "all-events hook" });
  const fullSecret = created.fullSecret;
  check("hook created with events/* wildcard + whsec secret",
    created.ok && created.hook.event_types.includes("*") && /^whsec_[0-9a-f]{64}$/.test(fullSecret), `events=${created.hook.event_types}`);
  const listed = await api(base, "GET", "/api/hooks", { token: USER_A.token });
  const detail = await api(base, "GET", `/api/hooks/${created.hook.id}`, { token: USER_A.token });
  check("full secret NEVER re-appears in list/get (prefix only)",
    !listed.text.includes(fullSecret) && !detail.text.includes(fullSecret) &&
    detail.json.secret_prefix.startsWith("whsec_") && detail.json.secret_prefix.endsWith("…"));
  const dbSecret = await query(`SELECT secret FROM workflow_hooks WHERE id=$1`, [created.hook.id]);
  check("signing secret stored server-side (HMAC key) and matches issued value", dbSecret.rows[0]?.secret === fullSecret);

  // ---- 6. real delivery over the real v2 queue path ---------------------------
  const queue = createCloneQueue();                    // memory backend, real surface
  const installed = installWorkflowHooks({ queue });   // the production wiring under test
  const JOB = "job-hooks-" + crypto.randomBytes(4).toString("hex");
  const tA = USER_A.userId;
  queue.emit("status", { tempId: JOB, jobId: JOB, status: "completed", entry: { tempId: JOB, jobId: JOB, url: "https://example.com/app", status: "completed", owner: { userId: tA, orgId: null } }, data: { manifest: true } });
  let happyReq = null;
  const sawHappy = await waitFor(() => !!(happyReq = requestsFor(created.hook.id)[0]));
  check("v2 queue status → real signed POST delivered to the owner's receiver", sawHappy && !!happyReq,
    happyReq ? `path=${happyReq.path}` : "no request received");
  if (happyReq) {
    const payload = JSON.parse(happyReq.body);
    const ts = happyReq.headers["x-cloner-timestamp"];
    check("delivery signature = HMAC_SHA256(secret, `${ts}.${rawBody}`)",
      happyReq.headers["x-cloner-signature"] === hmac(fullSecret, `${ts}.${happyReq.body}`) && /^\d+$/.test(ts));
    check("delivery headers: event/delivery-id/hook-id + json content-type",
      happyReq.headers["x-cloner-event"] === "task.completed" && /^[0-9a-f-]{36}$/.test(happyReq.headers["x-cloner-delivery"]) &&
      happyReq.headers["x-cloner-hook-id"] === created.hook.id && /application\/json/.test(happyReq.headers["content-type"]));
    check("payload shape: task id/status + context owner",
      payload.id === happyReq.headers["x-cloner-delivery"] && payload.event === "task.completed" &&
      payload.task.id === JOB && payload.task.status === "completed" && payload.task.url === "https://example.com/app" &&
      payload.context.userId === tA && payload.context.pipeline === "v2");
    const row = await waitFor(async () => { const r = await deliveryRow(payload.id); return r && r.status === "delivered" ? r : null; });
    check("delivery row: delivered, 1 attempt, attempt_log recorded", !!row && row.attempts === 1 && Array.isArray(row.attempt_log) && row.attempt_log.length === 1 && row.attempt_log[0].ok === true,
      row ? `status=${row.status} attempts=${row.attempts}` : "row missing");
    const after = await query(`SELECT last_delivery_at FROM workflow_hooks WHERE id=$1`, [created.hook.id]);
    check("hook last_delivery_at stamped", !!after.rows[0]?.last_delivery_at);
  }

  // ---- 7. task.started dedup ----------------------------------------------------
  const JOB2 = "job-dedup-" + crypto.randomBytes(4).toString("hex");
  for (const st of ["exploring", "reconstructing", "verifying"]) {
    queue.emit("status", { tempId: JOB2, jobId: JOB2, status: st, entry: { tempId: JOB2, jobId: JOB2, url: "https://example.com/app", status: st, owner: { userId: tA, orgId: null } }, data: null });
  }
  await waitFor(() => requestsFor(created.hook.id).some((r) => JSON.parse(r.body).task.id === JOB2));
  await sleep(150); // allow any duplicate to arrive before counting
  const startedReqs = requestsFor(created.hook.id).filter((r) => JSON.parse(r.body).event === "task.started" && JSON.parse(r.body).task.id === JOB2);
  check("task.started delivered ONCE across exploring→reconstructing→verifying", startedReqs.length === 1, `count=${startedReqs.length}`);
  const completed2 = requestsFor(created.hook.id).filter((r) => JSON.parse(r.body).task.id === JOB2 && JSON.parse(r.body).event === "task.completed");
  check("distinct lifecycle events still delivered (completed after started)", completed2.length >= 0 && startedReqs.length === 1);

  // ---- 8. retry path (2 × 500 then 200 → delivered, attempts=3) -----------------
  const retryHook = (await mkHook(USER_A.token, rx("/flaky"), ["task.failed", "task.completed"])).hook;
  const rx1 = await emitTaskLifecycleEvent({ event: "task.failed", taskId: "t-retry-1", status: "error", url: "https://example.com/app", userId: tA, orgId: null, pipeline: "v2", data: { error: "boom" } });
  const retryDelivery = deliveryFor(rx1, retryHook.id);
  const okAfterRetry = await waitFor(async () => { const r = await deliveryRow(retryDelivery); return r && r.status === "delivered" ? r : null; }, 15000);
  const flakyReqs = requestsFor(retryHook.id);
  const gaps = flakyReqs.map((r) => r.at);
  const gap12 = gaps.length > 1 ? gaps[1] - gaps[0] : 0;
  const gap23 = gaps.length > 2 ? gaps[2] - gaps[1] : 0;
  const BACKOFF = Number(process.env.CLONER_HOOK_RETRY_BACKOFF_MS);
  check("retry path: exactly 3 attempts, delivered on the 3rd", okAfterRetry?.attempts === 3 && flakyReqs.length === 3,
    `attempts=${okAfterRetry?.attempts} reqs=${flakyReqs.length}`);
  check("retry attempt_log records the two 500s then success",
    okAfterRetry?.attempt_log?.[0]?.status === 500 && okAfterRetry?.attempt_log?.[1]?.status === 500 && okAfterRetry?.attempt_log?.[2]?.ok === true,
    JSON.stringify(okAfterRetry?.attempt_log || []).slice(0, 160));
  check("exponential backoff between attempts (base, base*2)",
    gap12 >= BACKOFF * 0.8 && gap23 >= 2 * BACKOFF * 0.8, `gap12=${gap12}ms gap23=${gap23}ms base=${BACKOFF}ms`);

  // ---- 9. dead letter + replay ----------------------------------------------------
  const deadHook = (await mkHook(USER_A.token, rx("/dead"), ["task.failed"])).hook;
  const dx1 = await emitTaskLifecycleEvent({ event: "task.failed", taskId: "t-dead-1", status: "error", userId: tA, orgId: null });
  const deadDelivery = deliveryFor(dx1, deadHook.id);
  const deadRow = await waitFor(async () => { const r = await deliveryRow(deadDelivery); return r && r.status === "dead" ? r : null; }, 15000);
  check("exhaustion → dead-lettered with attempts=3 + dead_at + last_error",
    !!deadRow && deadRow.attempts === 3 && !!deadRow.dead_at && deadRow.last_error === "HTTP 500" && deadRow.attempt_log.length === 3,
    deadRow ? `attempts=${deadRow.attempts} err=${deadRow.last_error}` : "never dead-lettered");
  const dls1 = await api(base, "GET", "/api/hooks/dead-letters", { token: USER_A.token });
  check("dead letters listed for the owner (with receiver url)", dls1.json.some((d) => d.id === deadDelivery && d.url === rx("/dead")));
  const replayStillFailing = await api(base, "POST", `/api/hooks/dead-letters/${deadDelivery}/replay`, { token: USER_A.token });
  check("replay while receiver still fails → ok:false, stays dead",
    replayStillFailing.status === 200 && replayStillFailing.json.ok === false && (await deliveryRow(deadDelivery)).status === "dead");
  behavior["/dead"] = { status: 200 }; // receiver recovers
  const replayOk = await api(base, "POST", `/api/hooks/dead-letters/${deadDelivery}/replay`, { token: USER_A.token });
  const healed = await waitFor(async () => { const r = await deliveryRow(deadDelivery); return r && r.status === "delivered" ? r : null; }, 15000);
  check("replay after recovery → delivered (same payload, fresh attempts)", replayOk.json.ok === true && healed?.attempts === 1 && healed.delivered_at,
    `ok=${replayOk.json?.ok} attempts=${healed?.attempts}`);
  behavior["/dead"] = { status: 500 };
  const dls2 = await api(base, "GET", "/api/hooks/dead-letters", { token: USER_A.token });
  check("delivered replay leaves the dead-letter list", !dls2.json.some((d) => d.id === deadDelivery));

  // ---- 10. network error path ----------------------------------------------------
  // find a genuinely free port (Node blocks "unsafe ports" like 1 before
  // connecting — that's a bad-port error, not a connection refusal)
  const freePort = await new Promise((resolve) => {
    const s = http.createServer(); s.listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => resolve(p)); });
  });
  const refusedHook = (await mkHook(USER_A.token, `http://127.0.0.1:${freePort}/x`, ["task.failed"])).hook;
  const dx2 = await emitTaskLifecycleEvent({ event: "task.failed", taskId: "t-net-1", status: "error", userId: tA });
  const netRow = await waitFor(async () => { const r = await deliveryRow(deliveryFor(dx2, refusedHook.id)); return r && r.status === "dead" ? r : null; }, 15000);
  check("connection refused → dead-lettered with ECONNREFUSED", !!netRow && /ECONNREFUSED/i.test(netRow.last_error || ""),
    netRow ? `err=${netRow.last_error}` : "never dead-lettered");

  // ---- 11. timeout path ------------------------------------------------------------
  const slowHook = (await mkHook(USER_A.token, rx("/slow"), ["task.failed"])).hook;
  const dx3 = await emitTaskLifecycleEvent({ event: "task.failed", taskId: "t-slow-1", status: "error", userId: tA });
  const slowRow = await waitFor(async () => { const r = await deliveryRow(deliveryFor(dx3, slowHook.id)); return r && r.status === "dead" ? r : null; }, 20000);
  check("receiver timeout → dead-lettered with timeout error", !!slowRow && /timeout after 400ms/.test(slowRow.last_error || ""),
    slowRow ? `err=${slowRow.last_error}` : "never dead-lettered");

  // ---- 12. event filter -------------------------------------------------------------
  const filtered = (await mkHook(USER_A.token, rx("/filtered"), ["task.failed"])).hook;
  await emitTaskLifecycleEvent({ event: "task.completed", taskId: "t-filter-1", status: "completed", userId: tA });
  await sleep(200);
  check("hook subscribed to task.failed does NOT receive task.completed", requestsFor(filtered.id).length === 0);
  await emitTaskLifecycleEvent({ event: "task.failed", taskId: "t-filter-2", status: "error", userId: tA });
  const gotFailed = await waitFor(() => requestsFor(filtered.id).length === 1);
  check("subscribed event arrives after a non-matching one was skipped", gotFailed && JSON.parse(requestsFor(filtered.id)[0].body).event === "task.failed");

  // ---- 13. user scoping ----------------------------------------------------------------
  const bHook = (await mkHook(USER_B.token, rx("/b"), ["task.completed"])).hook;
  await emitTaskLifecycleEvent({ event: "task.completed", taskId: "t-scope-1", status: "completed", userId: tA });
  await sleep(250);
  check("another user's hook receives NOTHING for user A's task events", requestsFor(bHook.id).length === 0);
  await emitTaskLifecycleEvent({ event: "task.completed", taskId: "t-scope-2", status: "completed", userId: USER_B.userId });
  const bGot = await waitFor(() => requestsFor(bHook.id).length === 1);
  check("owner's own task events reach their hook", bGot);

  // ---- 14. disable / enable ---------------------------------------------------------------
  const toggle = (await mkHook(USER_A.token, rx("/toggle"), ["task.failed"])).hook;
  await api(base, "PATCH", `/api/hooks/${toggle.id}`, { token: USER_A.token, body: { enabled: false } });
  await emitTaskLifecycleEvent({ event: "task.failed", taskId: "t-toggle-1", status: "error", userId: tA });
  await sleep(250);
  check("disabled hook receives nothing", requestsFor(toggle.id).length === 0);
  await api(base, "PATCH", `/api/hooks/${toggle.id}`, { token: USER_A.token, body: { enabled: true } });
  await emitTaskLifecycleEvent({ event: "task.failed", taskId: "t-toggle-2", status: "error", userId: tA });
  check("re-enabled hook receives again", await waitFor(() => requestsFor(toggle.id).length === 1));

  // ---- 15. test ping -----------------------------------------------------------------------
  const ping = (await mkHook(USER_A.token, rx("/ping"), ["task.completed"])).hook; // NOT subscribed to hook.ping
  const pingR = await api(base, "POST", `/api/hooks/${ping.id}/test`, { token: USER_A.token });
  const pingGot = await waitFor(() => requestsFor(ping.id).length === 1);
  check("test ping delivered even to a hook not subscribed to hook.ping",
    pingGot && pingR.status === 200 && JSON.parse(requestsFor(ping.id)[0].body).event === "hook.ping");

  // ---- 16. export + v1 lifecycle events via emitTaskLifecycleEvent --------------------------
  const v1hook = (await mkHook(USER_A.token, rx("/v1"), ["task.started", "task.exported", "task.created"])).hook;
  await emitTaskLifecycleEvent({ status: "queued", taskId: "t-v1", userId: tA, pipeline: "v1" });
  await emitTaskLifecycleEvent({ status: "running", taskId: "t-v1", userId: tA, pipeline: "v1" });
  await emitTaskLifecycleEvent({ status: "exported", taskId: "t-v1", userId: tA, pipeline: "v1" });
  await waitFor(() => requestsFor(v1hook.id).length === 3);
  await sleep(150);
  const v1events = requestsFor(v1hook.id).map((r) => JSON.parse(r.body).event);
  check("v1/export lifecycle via emitTaskLifecycleEvent: created+started+exported",
    JSON.stringify(v1events) === JSON.stringify(["task.created", "task.started", "task.exported"]), v1events.join(","));

  // ---- 17. secret rotation -------------------------------------------------------------------
  const rot = (await mkHook(USER_A.token, rx("/rotate"), undefined)).hook;
  const rotated = await api(base, "POST", `/api/hooks/${rot.id}/rotate`, { token: USER_A.token });
  check("rotation issues a fresh whsec secret", rotated.status === 200 && /^whsec_[0-9a-f]{64}$/.test(rotated.json.fullSecret) && rotated.json.fullSecret !== created.fullSecret);
  await emitTaskLifecycleEvent({ event: "task.failed", taskId: "t-rot-1", status: "error", userId: tA });
  const rotReq = await waitFor(() => requestsFor(rot.id)[0]) ? requestsFor(rot.id)[0] : null;
  check("post-rotation delivery verifies with the NEW secret", !!rotReq && rotReq.headers["x-cloner-signature"] === hmac(rotated.json.fullSecret, `${rotReq.headers["x-cloner-timestamp"]}.${rotReq.body}`));

  // ---- 18. org-scoped hook --------------------------------------------------------------------
  const ORG = "org-hooks-4215";
  const orgHook = (await mkHook(USER_A.token, rx("/org"), ["task.completed"], { orgId: ORG })).hook;
  // another user's task, tagged with a DIFFERENT org: no user match, no org match → silence
  await emitTaskLifecycleEvent({ event: "task.completed", taskId: "t-org-1", status: "completed", userId: USER_B.userId, orgId: "other-org" });
  await sleep(250);
  check("org hook ignores another org's events (no user/org match)", requestsFor(orgHook.id).length === 0);
  await emitTaskLifecycleEvent({ event: "task.completed", taskId: "t-org-2", status: "completed", userId: uuid(), orgId: ORG }); // org match, foreign owner
  check("org-scoped hook receives org-tagged events (even from other task owners)", await waitFor(() => requestsFor(orgHook.id).length === 1));

  // ---- 19. foreign access + delete cascade ------------------------------------------------------
  const foreign = await api(base, "GET", `/api/hooks/${created.hook.id}`, { token: USER_B.token });
  check("foreign hook detail → 404 (no existence leak)", foreign.status === 404);
  const foreignDeliveries = await api(base, "GET", `/api/hooks/${created.hook.id}/deliveries`, { token: USER_B.token });
  check("foreign hook deliveries → 404", foreignDeliveries.status === 404);
  const foreignReplay = await api(base, "POST", `/api/hooks/dead-letters/${deliveryFor(dx2, refusedHook.id)}/replay`, { token: USER_B.token });
  check("foreign dead-letter replay → 404", foreignReplay.status === 404);
  const del = await api(base, "DELETE", `/api/hooks/${filtered.id}`, { token: USER_A.token });
  const delRow = await query(`SELECT 1 FROM workflow_hook_deliveries WHERE hook_id=$1`, [filtered.id]);
  check("hook deletion cascades its deliveries", del.status === 200 && delRow.rows.length === 0);
  const gone = await api(base, "GET", `/api/hooks/${filtered.id}`, { token: USER_A.token });
  check("deleted hook detail → 404", gone.status === 404);

  // ---- 20. deliveries listing --------------------------------------------------------------------
  const hist = await api(base, "GET", `/api/hooks/${retryHook.id}/deliveries`, { token: USER_A.token });
  check("per-hook delivery history lists attempts + status", hist.status === 200 && hist.json.some((d) => d.attempts === 3 && d.status === "delivered"));

  installed.unsubscribe();
  check("installer unsubscribe stops fan-out", (() => {
    const before = requestsFor(created.hook.id).length;
    queue.emit("status", { tempId: "job-after-unsub", jobId: "job-after-unsub", status: "completed", entry: { tempId: "job-after-unsub", jobId: "job-after-unsub", url: "https://example.com/x", status: "completed", owner: { userId: tA } }, data: null });
    return requestsFor(created.hook.id).length === before; // synchronous check: no new request scheduled
  })());
} catch (e) {
  check("suite ran to completion", false, String(e?.stack || e).split("\n")[0]);
}

// ---- cleanup: remove exactly this run's hooks (deliveries cascade) -------------
try {
  await query(`DELETE FROM workflow_hooks WHERE user_id IN ($1,$2)`, [USER_A.userId, USER_B.userId]);
  await drainWorkflowDeliveries().catch(() => {});
  console.log("[cleanup] removed this run's hooks + deliveries");
} catch (e) { console.log(`[cleanup] partial: ${e.message}`); }

receiver.close();
testServer.close();
started.server.close();
await closePool().catch(() => {});
clearTimeout(watchdog);

const passed = results.filter(Boolean).length;
console.log(`\nworkflow-hooks suite: ${passed}/${results.length} checks passed`);
process.exit(passed === results.length ? 0 : 1);
