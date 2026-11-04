#!/usr/bin/env node
// Task 4.1.10 e2e — public API versioning and compatibility layer.
//
// Boots the REAL platform (startPlatform, ephemeral port) with the public v1
// router mounted, and asserts:
//   • /api/v1/tasks requires auth (401 with the stable error envelope)
//   • authenticated GET /api/v1/tasks returns the v1 envelope { ok, data, meta }
//     with legacy-shape compatibility (same ids the legacy /api/tasks returns)
//   • single-task fetch is owner-gated (404 for another user's task)
//   • version negotiation: the vnd media type pins v1; an explicit unknown
//     version → 406 with the supported list; missing Accept defaults to v1
//   • deprecation headers on every v1 response
//   • version discovery endpoint
//
// Requires PostgreSQL (compose) for real auth sessions. SKIP loudly when
// unreachable.
process.env.PGCONNECT_TIMEOUT = process.env.PGCONNECT_TIMEOUT || "4";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const PROJECT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
process.chdir(PROJECT);

const results = [];
const check = (name, ok, detail = "") => {
  results.push(ok);
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
};

async function pgReachable() {
  const { query, closePool } = await import("../src/database/client.js");
  try { await query("SELECT 1"); return { ok: true, query, closePool }; }
  catch { try { await closePool(); } catch {} return { ok: false }; }
}
const db = await pgReachable();
if (!db.ok) {
  console.log("SKIP  public-api — PostgreSQL unreachable (`docker compose up -d postgres`) — loud SKIP per test convention.");
  process.exit(0);
}
const { query, closePool } = db;

const fs = await import("node:fs");
async function applyOwnMigrations() {
  await query(`CREATE TABLE IF NOT EXISTS _migrations (id TEXT PRIMARY KEY, applied_at TIMESTAMPTZ DEFAULT now())`);
  const dir = path.join(PROJECT, "src", "database", "migrations");
  for (const file of ["001-initial.sql", "010-tenants.sql", "018-product-platform.sql"]) {
    const applied = await query("SELECT 1 FROM _migrations WHERE id = $1", [file]);
    if (applied.rows.length) continue;
    await query(fs.readFileSync(path.join(dir, file), "utf8"));
    await query("INSERT INTO _migrations (id) VALUES ($1) ON CONFLICT (id) DO NOTHING", [file]);
    console.log(`[db] applied: ${file}`);
  }
}
await applyOwnMigrations();

const express = (await import("express")).default;
const auth = await import("../src/auth/auth-service.js");
const tasks = await import("../src/platform/tasks.js");
const exploration = await import("../src/platform/exploration-runner.js");
const V = await import("../src/platform/routes-public-v1.js");
const rand = () => crypto.randomBytes(6).toString("hex");

// the platform fixture site — the v1 router exercises the REAL stores through
// injected handlers exactly as server.js will wire them
const handlers = {
  async listTasks({ userId, role }) {
    const all = tasks.listTasks();
    const legacy = role === "admin" ? all : all.filter((t) => t.userId === userId);
    const jobs = await exploration.listJobsFor({ userId, role });
    return [...legacy, ...jobs];
  },
  async getTask({ userId, role, id }) {
    const meta = tasks.loadTask(id);
    if (meta) return meta.userId === userId || role === "admin" ? meta : null;
    const job = exploration.getExplorationJob(id);
    if (job) {
      const ok = userId ? await exploration.identityCanAccessJob(id, { userId, role }) : !job.owner;
      return ok ? job : null;
    }
    return null;
  },
};

const app = express();
app.use(express.json({ limit: "1mb" }));
app.use("/api/v1", V.publicV1Router({ handlers }));
app.use("/api/legacy", (req, res) => res.json(handlers.listTasks({ userId: req.userId, role: req.userRole })));
const server = app.listen(0, "127.0.0.1");
await new Promise((r) => server.on("listening", r));
const port = server.address().port;

const api = async (method, p, { token, accept, body } = {}) => {
  const res = await fetch(`http://127.0.0.1:${port}/api/v1${p}`, {
    method,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(accept ? { accept } : {}),
      ...(body ? { "content-type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}
  return { status: res.status, json, headers: res.headers };
};

const uA = await makeUser(rand() ? "api-a" : "api-a");
const uB = await makeUser("api-b");
async function makeUser(prefix) {
  const email = `${prefix}-${rand()}@test.local`;
  const password = `pw-${rand()}-${rand()}!A1`;
  const user = await auth.registerUser(email, password);
  const { token } = await auth.loginUser(email, password);
  return { ...user, token };
}

// seed: two tasks for A, one for B (real store)
function seed(userId, url) {
  const meta = tasks.createTask({ url, userId });
  tasks.updateTask(meta.id, { status: "done", verification: { passed: true } });
  return meta;
}
const tA1 = seed(uA.id, `https://seed1-${rand()}.example.com`);
const tA2 = seed(uA.id, `https://seed2-${rand()}.example.com`);
const tB1 = seed(uB.id, `https://seedb-${rand()}.example.com`);

// ---- auth gate ----
{
  const r = await api("GET", "/tasks", {});
  check("V1  unauthenticated → 401 with the stable error envelope",
    r.status === 401 && r.json?.ok === false && r.json?.code === "UNAUTHENTICATED" && typeof r.json?.error === "string", JSON.stringify(r.json));
}

// ---- v1 envelope + legacy-shape compatibility ----
{
  const r = await api("GET", "/tasks", { token: uA.token });
  const data = r.json?.data || [];
  check("V2  authenticated list → 200 with the v1 envelope", r.status === 200 && r.json?.ok === true && Array.isArray(data) && r.json?.meta?.version === "v1", `${r.status} ${data.length} rows`);
  const ids = new Set(data.map((t) => t.id));
  check("V3  legacy-shape compatibility: same ids as the legacy /api/tasks store", ids.has(tA1.id) && ids.has(tA2.id) && !ids.has(tB1.id), `${ids.size} ids`);
  const shape = data[0];
  check("V4  v1 task shape carries the documented fields",
    ["id", "url", "status", "pipeline", "createdAt", "verificationPassed"].every((k) => k in shape), JSON.stringify(Object.keys(shape)));
  check("V5  ownership isolation: A sees only A's tasks", data.every((t) => !String(t.url).includes("seedb")), "no cross-user rows");
}

// ---- single task + owner gate ----
{
  const own = await api("GET", `/tasks/${tA1.id}`, { token: uA.token });
  check("V6  own task fetch → 200 with the v1 envelope", own.status === 200 && own.json?.data?.id === tA1.id, String(own.status));
  const foreign = await api("GET", `/tasks/${tB1.id}`, { token: uA.token });
  check("V7  another user's task → 404 (no existence leak)", foreign.status === 404 && foreign.json?.code === "NOT_FOUND", `${foreign.status}`);
  const missing = await api("GET", "/tasks/t-does-not-exist", { token: uA.token });
  check("V8  unknown task → 404", missing.status === 404, String(missing.status));
}

// ---- version negotiation ----
{
  const pinned = await api("GET", "/tasks", { token: uA.token, accept: "application/vnd.cloner.v1+json" });
  check("V9  vnd media type pins v1 (200)", pinned.status === 200, String(pinned.status));
  const unknown = await api("GET", "/tasks", { token: uA.token, accept: "application/vnd.cloner.v9+json" });
  check("V10 explicitly unsupported version → 406 with the supported list",
    unknown.status === 406 && unknown.json?.code === "VERSION_NOT_SUPPORTED" && /v1/.test(unknown.json?.error || ""), `${unknown.status} ${unknown.json?.error}`);
  const plain = await api("GET", "/tasks", { token: uA.token, accept: "application/json" });
  check("V11 plain application/json defaults to v1", plain.status === 200, String(plain.status));
  const none = await api("GET", "/tasks", { token: uA.token, accept: undefined });
  check("V12 missing Accept defaults to v1", none.status === 200, String(none.status));
}

// ---- deprecation headers + discovery ----
{
  const r = await api("GET", "/tasks", { token: uA.token });
  check("V13 Deprecation header present on v1 responses", !!r.headers.get("deprecation"), r.headers.get("deprecation"));
  check("V14 X-Cloner-API-Version header names v1", r.headers.get("x-cloner-api-version") === "v1", r.headers.get("x-cloner-api-version"));
  const root = await api("GET", "/", { token: uA.token });
  check("V15 version discovery lists v1 as current", root.status === 200 && root.json?.data?.current === "v1" && root.json?.data?.versions.includes("v1"), JSON.stringify(root.json?.data));
}

// ---- cleanup ----
server.close();
for (const t of [tA1, tA2, tB1]) tasks.deleteTask(t.id);
await query("DELETE FROM tasks WHERE user_id = ANY($1::uuid[])", [[uA.id, uB.id]]);
await query("DELETE FROM users WHERE id = ANY($1::uuid[])", [[uA.id, uB.id]]);
await closePool();

const pass = results.filter(Boolean).length;
const fail = results.length - pass;
console.log(`\nRESULT: ${fail ? "FAIL" : "PASS"}  (${pass}/${results.length})`);
process.exit(fail ? 1 : 0);
