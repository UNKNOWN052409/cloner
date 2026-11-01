#!/usr/bin/env node
// 4.0.12 quality-gate probe — tenant isolation (a): two orgs A/B, A's tasks
// invisible to B via API, WebSocket AND export. Boots the REAL platform
// (compose PostgreSQL) on an ephemeral port, creates two orgs + owners, a v2
// exploration job owned by org A, then tries every surface from B.
// Prints PASS/FAIL lines, exits nonzero on any failure.
process.env.PGCONNECT_TIMEOUT = process.env.PGCONNECT_TIMEOUT || "4";
import { fileURLToPath } from "node:url";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
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

const watchdog = setTimeout(() => { console.log("FAIL  global timeout (120s)"); process.exit(1); }, 120_000);
watchdog.unref();

const { migrate } = await import("../src/database/client.js");
await migrate();
const { startPlatform } = await import("../src/platform/server.js");
const platform = await startPlatform({ port: 0 });
const port = platform.server.address().port;
console.log(`platform on :${port}`);

// probe target: loopback 1x1 fixture — the SSRF guard would (correctly) reject
// it; this probe explicitly opts in, same convention as test-platform.mjs
process.env.CLONER_ALLOW_PRIVATE_TARGETS = "1";

const stamp = crypto.randomBytes(4).toString("hex");
const mkUser = async (letter) => {
  const email = `qg-${letter}-${stamp}@test.local`;
  const password = crypto.randomBytes(12).toString("base64url");
  const reg = await api(port, "POST", "/api/auth/register", { email, password });
  if (reg.status !== 200) throw new Error("register failed: " + reg.text.slice(0, 120));
  const login = await api(port, "POST", "/api/auth/login", { email, password });
  return { email, password, token: login.json?.token, userId: reg.json?.userId };
};
const A = await mkUser("a");
const B = await mkUser("b");

// orgs via the real API (201 — adjust expectation to the real contract)
const orgA = await api(port, "POST", "/api/orgs", { name: `QG-A-${stamp}` }, { authorization: `Bearer ${A.token}` });
const orgB = await api(port, "POST", "/api/orgs", { name: `QG-B-${stamp}` }, { authorization: `Bearer ${B.token}` });
check("setup: org A + org B created (201)", orgA.status === 201 && orgB.status === 201, `A:${orgA.status} B:${orgB.status} ${String(orgA.text).slice(0, 80)}`);
const orgAId = orgA.json?.org?.id || orgA.json?.id;

// A creates a v2 task under org A context
const create = await api(port, "POST", "/api/tasks", { url: "http://127.0.0.1:1/", pipeline: "v2" },
  { authorization: `Bearer ${A.token}`, "x-org-id": orgAId });
check("setup: A created v2 task under org A", create.status === 200, `status=${create.status} id=${create.json?.id}`);
const jobId = create.json?.id;

// ---- B's view ----
const listB = await api(port, "GET", "/api/tasks", null, { authorization: `Bearer ${B.token}` });
const listBLeak = Array.isArray(listB.json) && listB.json.some((j) => j.id === jobId || j.jobId === jobId);
check("(a) API: B's task list does NOT include A's org-A job", !listBLeak, `matches=${listBLeak}`);

const anonList = await api(port, "GET", "/api/tasks");
const anonLeak = Array.isArray(anonList.json) && anonList.json.some((j) => j.id === jobId || j.jobId === jobId);
check("(a) API: anonymous task list does NOT include A's job (or list is the legacy local posture)", !anonLeak, `matches=${anonLeak}`);

const getB = await api(port, "GET", `/api/tasks/${jobId}`, null, { authorization: `Bearer ${B.token}` });
check("(a) API: B cannot GET A's job by id (404/403 expected)", getB.status === 404 || getB.status === 403, `status=${getB.status}`);

const anonGet = await api(port, "GET", `/api/tasks/${jobId}`);
check("(a) API: anonymous cannot GET A's job by id (404/403 expected)", anonGet.status === 404 || anonGet.status === 403, `status=${anonGet.status}`);

const artifactsB = await api(port, "GET", `/api/jobs/${jobId}/artifacts/manifest.json`, null, { authorization: `Bearer ${B.token}` });
check("(a) API: B cannot read A's job artifacts (404/403 expected)", artifactsB.status === 404 || artifactsB.status === 403, `status=${artifactsB.status}`);

const artifactsAnon = await api(port, "GET", `/api/jobs/${jobId}/artifacts/manifest.json`);
check("(a) API: anonymous cannot read A's job artifacts (404/403 expected)", artifactsAnon.status === 404 || artifactsAnon.status === 403, `status=${artifactsAnon.status}`);

// export of A's job by B and anonymous
const expB = await api(port, "POST", `/api/export/${jobId}`, {}, { authorization: `Bearer ${B.token}` });
const expAnon = await api(port, "POST", `/api/export/${jobId}`, {});
check("(a) EXPORT: B cannot export A's job (404/403 expected)", [404, 403].includes(expB.status), `status=${expB.status} ${String(expB.json?.error || "").slice(0, 80)}`);
check("(a) EXPORT: anonymous cannot export A's job (404/403 expected)", [404, 403].includes(expAnon.status), `status=${expAnon.status} ${String(expAnon.json?.error || "").slice(0, 80)}`);

// ---- WebSocket: A's job events must not reach B ----
const connectWs = (token) => new Promise((resolve, reject) => {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws${token ? `?token=${token}` : ""}`);
  const msgs = [];
  ws.on("message", (raw) => { try { msgs.push(JSON.parse(raw.toString())); } catch {} });
  ws.on("open", () => resolve({ ws, msgs }));
  ws.on("error", (e) => reject(new Error(String(e?.message || e))));
  setTimeout(() => reject(new Error("ws connect timeout")), 8000);
});
let recA = null, recB = null, recAnon = null;
try { recA = await connectWs(A.token); check("(a) WS: A connected (authenticated)", true); } catch (e) { check("(a) WS: A connected (authenticated)", false, e.message); }
try { recB = await connectWs(B.token); check("(a) WS: B connected (authenticated)", true); } catch (e) { check("(a) WS: B connected (authenticated)", false, e.message); }
try { recAnon = await connectWs(null); check("(a) WS: loopback anonymous connected (legacy dashboard)", true); } catch (e) { check("(a) WS: loopback anonymous connected (legacy dashboard)", false, e.message); }

// drive a broadcast through the production emit path for A's job
await new Promise((r) => setTimeout(r, 500));
for (const rec of [recA, recB, recAnon]) if (rec) rec.msgs.length = 0;
platform.broadcast({ type: "log", task: jobId, data: { level: "info", msg: `QG-MARK-${stamp}` } });
await new Promise((r) => setTimeout(r, 700));
const saw = (rec) => rec && rec.msgs.some((m) => JSON.stringify(m).includes(`QG-MARK-${stamp}`));
check("(a) WS: A receives events for its own org-A job", saw(recA));
check("(a) WS: B does NOT receive events for A's org-A job", !saw(recB), saw(recB) ? "LEAKED" : "");
check("(a) WS: loopback legacy room still receives (local dashboard posture)", saw(recAnon));

// cleanup
try { recA?.ws.close(); recB?.ws.close(); recAnon?.ws.close(); } catch {}
try { await api(port, "DELETE", `/api/tasks/${jobId}`, null, { authorization: `Bearer ${A.token}` }); } catch {}
platform.server.close();

const failed = results.filter((r) => !r).length;
console.log(`\nRESULT: ${failed === 0 ? "PASS" : "FAIL"}  (${results.length - failed}/${results.length} checks passed)`);
process.exit(failed === 0 ? 0 : 1);
