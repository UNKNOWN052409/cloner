#!/usr/bin/env node
// Task 4.1.2 e2e — product dashboard: aggregated task-history API.
//
// Seeds tasks through the REAL stores (v1 file store via tasks.js createTask +
// DB mirror via task-repository.js), then boots a real express app with the
// dashboard router mounted exactly as server.js mounts it, and asserts:
//   • GET /api/dashboard aggregates the CALLER's tasks only (ownership
//     isolation — user A never sees user B's rows)
//   • summary buckets (running/done/errors/pending) + per-status counts are
//     mathematically consistent with the seeded data
//   • pagination + status/date filters on the history endpoint
//   • duration + artifact-link fields are present per row
//   • anonymous loopback keeps the legacy posture (ownerless entries only)
//   • quota snapshot: identified callers get usage; anonymous gets
//     {available:false}
//
// Requires PostgreSQL (compose). SKIP loudly when unreachable.
process.env.PGCONNECT_TIMEOUT = process.env.PGCONNECT_TIMEOUT || "4";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const PROJECT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
process.chdir(PROJECT); // tasks.js pins ROOT to cwd at import

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
  console.log("SKIP  dashboard — PostgreSQL unreachable (`docker compose up -d postgres`) — loud SKIP per test convention.");
  process.exit(0);
}
const { query, closePool } = db;

const fs = await import("node:fs");
async function applyOwnMigrations() {
  await query(`CREATE TABLE IF NOT EXISTS _migrations (id TEXT PRIMARY KEY, applied_at TIMESTAMPTZ DEFAULT now())`);
  const dir = path.join(PROJECT, "src", "database", "migrations");
  for (const file of ["001-initial.sql", "012-quotas.sql", "018-product-platform.sql"]) {
    const applied = await query("SELECT 1 FROM _migrations WHERE id = $1", [file]);
    if (applied.rows.length) continue;
    await query(fs.readFileSync(path.join(dir, file), "utf8"));
    await query("INSERT INTO _migrations (id) VALUES ($1) ON CONFLICT (id) DO NOTHING", [file]);
    console.log(`[db] applied: ${file}`);
  }
}
await applyOwnMigrations();

const auth = await import("../src/auth/auth-service.js");
const tasks = await import("../src/platform/tasks.js");
const taskRepo = await import("../src/database/task-repository.js");
const express = (await import("express")).default;
const { dashboardRouter } = await import("../src/platform/dashboard-routes.js");

const rand = () => crypto.randomBytes(6).toString("hex");

async function makeUser(prefix) {
  const email = `${prefix}-${rand()}@test.local`;
  const password = `pw-${rand()}-${rand()}!A1`;
  const user = await auth.registerUser(email, password);
  const { token } = await auth.loginUser(email, password);
  return { ...user, token };
}

const app = express();
app.use(express.json({ limit: "1mb" }));
app.use("/api/dashboard", dashboardRouter());
const server = app.listen(0, "127.0.0.1");
await new Promise((r) => server.on("listening", r));
const port = server.address().port;
const api = async (method, p, body, token) => {
  const res = await fetch(`http://127.0.0.1:${port}/api/dashboard${p}`, {
    method,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(body ? { "content-type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => null);
  return { status: res.status, json };
};

const uA = await makeUser("dash-a");
const uB = await makeUser("dash-b");

// ---- seed through the REAL v1 store + DB mirror -----------------------------
function seedTask(userId, status, url) {
  const meta = tasks.createTask({ url, userId });
  tasks.updateTask(meta.id, {
    status,
    createdAt: new Date(Date.now() - Math.floor(Math.random() * 5 * 864e5)).toISOString(),
    finishedAt: status === "done" || status === "error" ? new Date().toISOString() : null,
    verification: status === "done" ? { passed: true } : null,
    artifacts: status === "done" ? { "index.html": { size: 1024 } } : {},
  });
  return meta;
}

const seeded = { A: [], B: [] };
for (const st of ["done", "done", "error", "running"]) seeded.A.push(seedTask(uA.id, st, `https://seed-a-${rand()}.example.com`));
for (const st of ["done", "error"]) seeded.B.push(seedTask(uB.id, st, `https://seed-b-${rand()}.example.com`));

const rowsA = (await query("SELECT count(*)::int AS n FROM tasks WHERE user_id = $1", [uA.id])).rows[0].n;
const rowsB = (await query("SELECT count(*)::int AS n FROM tasks WHERE user_id = $1", [uB.id])).rows[0].n;

// ---- assertions ----
{
  const r = await api("GET", "/", null, uA.token);
  const j = r.json;
  check("D1  dashboard responds 200 ok", r.status === 200 && j?.ok === true, String(r.status));
  check("D2  identity echoes the caller", j?.identity?.authenticated === true && j?.identity?.userId === uA.id, JSON.stringify(j?.identity));

  const s = j?.summary || {};
  check("D3  total matches the caller's own seeded tasks", s.total === seeded.A.length, `total=${s.total} seeded=${seeded.A.length}`);
  check("D4  done bucket = seeded done count", s.done === 2, `done=${s.done}`);
  check("D5  errors bucket = seeded error count", s.errors === 1, `errors=${s.errors}`);
  check("D6  running bucket = seeded running count", s.running === 1, `running=${s.running}`);
  check("D7  buckets are consistent (running+done+errors+pending=total)",
    s.running + s.done + s.errors + s.pending === s.total, JSON.stringify(s));

  const recent = s.recentErrors || [];
  check("D8  recentErrors carry the failed seed's url", recent.length >= 1 && recent.some((e) => String(e.url || "").includes("seed-a")), JSON.stringify(recent.map((e) => e.url)));
}

{
  // ownership isolation: B's dashboard never contains A's urls
  const rB = await api("GET", "/", null, uB.token);
  const urlsB = JSON.stringify(rB.json?.summary?.recentErrors || []) + JSON.stringify(rB.json?.summary?.byStatus || {});
  check("D9  user B's summary counts only B's seeds", rB.json?.summary?.total === seeded.B.length, `total=${rB.json?.summary?.total}`);
  check("D10 B's response never leaks A's urls", !urlsB.includes("seed-a"), "no cross-user leak");
}

{
  // anonymous loopback legacy posture
  const rAnon = await api("GET", "/", null, null);
  check("D11 anonymous loopback keeps legacy posture (ok:true, quota unavailable)",
    rAnon.status === 200 && rAnon.json?.ok === true && rAnon.json?.quota?.available === false, JSON.stringify(rAnon.json?.quota));
}

// ---- history endpoint: pagination + filters (additively mounted route) ----
// The dashboard aggregate ships its history at /history (same router) —
// per-task rows with duration + artifact links, paginated + filterable.
{
  const all = await api("GET", "/history?limit=100", null, uA.token);
  const rows = all.json?.rows || [];
  check("H1  history lists exactly the caller's seeded tasks", all.status === 200 && rows.length === seeded.A.length, `rows=${rows.length}`);
  const ids = new Set(rows.map((r) => r.id));
  check("H2  every seeded id present, none missing", seeded.A.every((t) => ids.has(t.id)), `ids=${[...ids].join(",")}`);

  const done = await api("GET", "/history?status=done&limit=100", null, uA.token);
  const doneRows = done.json?.rows || [];
  check("H3  status=done filter returns only done rows", doneRows.length === 2 && doneRows.every((r) => r.status === "done"), `n=${doneRows.length}`);

  const p1 = await api("GET", "/history?limit=2&offset=0", null, uA.token);
  const p2 = await api("GET", "/history?limit=2&offset=2", null, uA.token);
  const r1 = p1.json?.rows || [], r2 = p2.json?.rows || [];
  check("H4  pagination: page sizes + disjoint pages", r1.length === 2 && r2.length === 2 && !r1.some((x) => r2.some((y) => y.id === x.id)), `p1=${r1.length} p2=${r2.length}`);

  const withDur = rows.find((r) => r.finishedAt && r.createdAt);
  check("H5  duration fields present per row (durationMs computed server-side)", !!withDur && typeof withDur.durationMs === "number", JSON.stringify(withDur && { durationMs: withDur.durationMs }));
  const doneRow = rows.find((r) => r.status === "done");
  check("H6  artifact links present on done rows", !!doneRow && Array.isArray(doneRow.artifactLinks) && doneRow.artifactLinks.length >= 1, JSON.stringify(doneRow?.artifactLinks));
}

// ---- cleanup ----
server.close();
for (const list of [seeded.A, seeded.B]) for (const t of list) tasks.deleteTask(t.id);
await query("DELETE FROM tasks WHERE user_id = ANY($1::uuid[])", [[uA.id, uB.id]]);
await query("DELETE FROM onboarding_profiles WHERE user_id = ANY($1::uuid[])", [[uA.id, uB.id]]);
await query("DELETE FROM users WHERE id = ANY($1::uuid[])", [[uA.id, uB.id]]);
await closePool();

const pass = results.filter(Boolean).length;
const fail = results.length - pass;
console.log(`\nRESULT: ${fail ? "FAIL" : "PASS"}  (${pass}/${results.length})`);
process.exit(fail ? 1 : 0);
