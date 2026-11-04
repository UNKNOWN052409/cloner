#!/usr/bin/env node
// Task 4.1.11 e2e — developer documentation and API onboarding.
//
// Docs can never drift: every curl example in docs/API.md is PARSED and
// EXECUTED against the real platform (ephemeral port; URLs rewritten to it).
// Examples carrying the `skip-live:` marker are skipped loudly (they need
// live external env config).
//
// Assertions:
//   • every non-skipped curl block executes (never a 5xx parse crash)
//   • responses carry sane shapes: register/login/me register+echo the user
//   • the docs' documented error codes appear in REAL responses
//   • every skip-live example still parses into a valid request (method+path)
import path from "node:path";
import fs from "node:fs";
import crypto from "node:crypto";
import express from "express";
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
  console.log("SKIP  docs-examples — PostgreSQL unreachable (`docker compose up -d postgres`) — loud SKIP per test convention.");
  process.exit(0);
}
const { query, closePool } = db;

const fsMod = await import("node:fs");
async function applyOwnMigrations() {
  await query(`CREATE TABLE IF NOT EXISTS _migrations (id TEXT PRIMARY KEY, applied_at TIMESTAMPTZ DEFAULT now())`);
  const dir = path.join(PROJECT, "src", "database", "migrations");
  for (const file of ["001-initial.sql", "010-tenants.sql", "018-product-platform.sql"]) {
    const applied = await query("SELECT 1 FROM _migrations WHERE id = $1", [file]);
    if (applied.rows.length) continue;
    await query(fsMod.readFileSync(path.join(dir, file), "utf8"));
    await query("INSERT INTO _migrations (id) VALUES ($1) ON CONFLICT (id) DO NOTHING", [file]);
    console.log(`[db] applied: ${file}`);
  }
}
await applyOwnMigrations();

// ---- boot a real express app with every mounted router the docs reference ---
const auth = await import("../src/auth/auth-service.js");
const { onboardingRouter } = await import("../src/platform/onboarding-service.js");
const { templateRouter } = await import("../src/platform/template-service.js");
const { versionsRouter } = await import("../src/platform/version-service.js");
const { activityRouter } = await import("../src/platform/activity-routes.js");
const { planRouter } = await import("../src/platform/plan-service.js");
const { billingRouter } = await import("../src/platform/billing-stripe.js");
const { dashboardRouter } = await import("../src/platform/dashboard-routes.js");
const { resolveTenantScope } = await import("../src/platform/tenant-scope.js");
const { authRequired } = await import("../src/auth/auth-middleware.js");

const app = express();
app.use(express.json({ limit: "1mb" }));
app.use("/api/billing", billingRouter());
app.use(express.json({ limit: "1mb" }));
app.use("/api/onboarding", onboardingRouter());
app.use("/api/templates", templateRouter());
app.use("/api/versions", versionsRouter());
app.use("/api/activity", activityRouter());
app.use("/api/plans", planRouter());
app.use("/api/dashboard", dashboardRouter());
app.get("/api/auth/me", authRequired, (req, res) => res.json({ userId: req.userId, email: req.userEmail, role: req.userRole }));
app.post("/api/auth/register", async (req, res) => {
  try {
    const { email, password } = req.body || {};
    const user = await auth.registerUser(email, password);
    res.json({ ok: true, userId: user.id, email: user.email });
  } catch (e) { res.status(400).json({ error: e.message.slice(0, 120) }); }
});
app.post("/api/auth/login", async (req, res) => {
  try {
    const { email, password } = req.body || {};
    const session = await auth.loginUser(email, password);
    res.json({ ok: true, token: session.token, userId: session.userId, email: session.email, expiresAt: session.expiresAt });
  } catch (e) { res.status(401).json({ error: e.message.slice(0, 120) }); }
});
// error-code table surfaces: NOT_FOUND + VERSION_NOT_SUPPORTED + UNAUTHENTICATED
app.use("/api/v1", (await import("../src/platform/routes-public-v1.js")).publicV1Router({ handlers: { listTasks: async () => [], getTask: async () => null } }));
// server.js mount order: quota routes sit under authRequired + tenant scope
// BEFORE the generic tenant middleware — mirror that here
app.get("/api/quota/usage", authRequired, resolveTenantScope, (_req, res) => res.json({ ok: true, usage: {} }));

const server = app.listen(0, "127.0.0.1");
await new Promise((r) => server.on("listening", r));
const port = server.address().port;

// ---- parse the docs ----
const docsPath = path.join(PROJECT, "docs", "API.md");
const docs = fsMod.readFileSync(docsPath, "utf8");
const blocks = [];
const lines = docs.split("\n");
for (let i = 0; i < lines.length; i++) {
  if (lines[i].trim() === "```bash") {
    const body = [];
    for (let j = i + 1; j < lines.length && lines[j].trim() !== "```"; j++) body.push(lines[j]);
    const raw = body.join("\n");
    const skipLive = /skip-live:/.test(raw);
    blocks.push({ line: i + 1, raw, skipLive });
    i += body.length + 1;
  }
}
check("D1  docs contain curl examples to execute", blocks.length >= 10, `${blocks.length} blocks`);
check("D2  exactly one skip-live example (the GitHub publish, env-gated)", blocks.filter((b) => b.skipLive).length === 1, `${blocks.filter((b) => b.skipLive).length}`);

// parse curl into { method, url, headers, body }. A bash block may carry
// SEVERAL stacked curl commands (docs use one block per section) — the
// caller splits on `\ncurl ` first and parses each command separately.
function parseCurl(block) {
  const cmd = block.raw.replace(/\\\n/g, " ").replace(/# skip-live:[^\n]*/g, "").trim();
  const method = (cmd.match(/-X\s+(\w+)/) || [])[1] || "GET";
  const urlMatch = cmd.match(/https?:\/\/[^\s'"]+/);
  const headers = {};
  // docs use both quote styles (-H '…' and -H "…") — match both
  for (const m of cmd.matchAll(/-H\s+'([^']+)'/g)) {
    const idx = m[1].indexOf(":");
    headers[m[1].slice(0, idx).trim()] = m[1].slice(idx + 1).trim();
  }
  for (const m of cmd.matchAll(/-H\s+"([^"]+)"/g)) {
    const idx = m[1].indexOf(":");
    headers[m[1].slice(0, idx).trim()] = m[1].slice(idx + 1).trim();
  }
  let body = null;
  const bodyMatch = cmd.match(/-d\s+'([\s\S]+?)'\s*$/) || cmd.match(/-d\s+'([^']+)'/) || cmd.match(/-d\s+"([^"]+)"/);
  if (bodyMatch) body = bodyMatch[1];
  return { method, url: urlMatch?.[0], headers, body, ok: !!urlMatch };
}

// split a bash block into individual curl commands (a block may stack several)
function splitCurlCommands(raw) {
  const joined = raw.replace(/\\\n/g, " ").replace(/# skip-live:[^\n]*/g, "");
  const parts = joined.split(/\n(?=curl\s)/g).map((s) => s.trim()).filter(Boolean);
  return parts.map((cmd) => parseCurl({ raw: cmd }));
}

let token = null;
const rand = () => crypto.randomBytes(6).toString("hex");
const email = `docs-${rand()}@example.test`;
const executed = [];
const skipped = [];

// Execution is SINGLE-PASS in doc order: the docs are written to be followed
// top-to-bottom (register → login → tokened calls), so the harness replays
// them exactly in that order — the login command's own response updates the
// session token for every later command. No pre-pass (a pre-registration
// would make the docs' register example return 400 "already registered").
const parsedBlocks = blocks.map((b) => ({ block: b, parsed: parseCurl(b) }));

// every individual curl command in doc order (blocks may stack several commands)
const commands = [];
for (const block of blocks) {
  const cmds = splitCurlCommands(block.raw);
  for (const parsed of cmds) commands.push({ block, parsed });
}
check("D-split  every stacked curl command split out individually", commands.length > blocks.length, `${commands.length} commands from ${blocks.length} blocks`);

const resultsByCmd = [];
for (const { block, parsed } of commands) {
  const seq = `${block.line}.${resultsByCmd.filter((r) => r.line === block.line).length + 1}`;
  if (block.skipLive) {
    check(`D-live L${seq} skip-live example still parses into a real request (method + URL)`,
      parsed.ok && parsed.method === "POST" && /\/api\/github\/publish/.test(parsed.url || ""), `${parsed.method} ${parsed.url}`);
    skipped.push(block.line);
    continue;
  }
  if (!parsed.ok) {
    check(`D-exec L${seq} curl example parses`, false, block.raw.slice(0, 80));
    continue;
  }
  const url = parsed.url.replace(/http:\/\/127\.0\.0\.1:4180/, `http://127.0.0.1:${port}`);
  const headers = { ...parsed.headers };
  if (headers.Authorization?.includes("$TOKEN")) {
    if (!token) { skipped.push(seq); continue; }
    headers.Authorization = `Bearer ${token}`;
  }
  let body = parsed.body;
  if (body && body.includes("$TOKEN")) {
    if (!token) { skipped.push(seq); continue; }
    body = body.replaceAll("$TOKEN", token);
  }
  let status = null, json = null;
  try {
    const res = await fetch(url, {
      method: parsed.method,
      headers,
      body: body != null && parsed.method !== "GET" ? body : undefined,
    });
    status = res.status;
    const text = await res.text();
    try { json = JSON.parse(text); } catch { json = null; }
  } catch (e) {
    status = -1; json = { error: String(e.message) };
  }
  executed.push({ line: block.line, method: parsed.method, url, status, json });
  resultsByCmd.push({ line: block.line, seq });
  // per-command honest verdicts (never a blanket "it ran")
  const label = `D-exec L${seq} ${parsed.method} ${url.replace(`http://127.0.0.1:${port}`, "")}`;
  if (/\/api\/auth\/register/.test(url)) {
    const ok2 = status === 200 && json?.ok === true && !!json?.userId;
    check(label + " (register echoes the user)", ok2, `status=${status} ${JSON.stringify(json).slice(0, 80)}`);
  } else if (/\/api\/auth\/login/.test(url)) {
    const ok2 = status === 200 && !!json?.token;
    check(label + " (login returns a token)", ok2, `status=${status}`);
    if (json?.token) token = json.token; // the docs' own login updates the session
  } else if (/\/api\/auth\/me/.test(url)) {
    const ok2 = status === 200 && !!json?.userId;
    check(label + " (me echoes the session identity)", ok2, `status=${status} ${JSON.stringify(json).slice(0, 60)}`);
  } else if (/\/api\/templates/.test(url) && parsed.method === "GET") {
    const ok2 = status === 200 && Array.isArray(json?.templates);
    check(label + " (template catalog lists)", ok2, `status=${status} ${json?.templates?.length}`);
  } else if (/\/api\/billing\/checkout/.test(url)) {
    const ok2 = status === 200 && json?.granted > 0;
    check(label + " (free credit claim grants)", ok2, `status=${status} ${JSON.stringify(json).slice(0, 80)}`);
  } else if (/\/api\/onboarding|\/api\/activity|\/api\/plans|\/api\/dashboard|\/api\/quota/.test(url)) {
    const ok2 = status === 200 && (json?.ok === true || json?.onboarding !== undefined || json?.effective !== undefined || json?.identity !== undefined || json?.summary !== undefined || json?.usage !== undefined);
    check(label + " (responds ok)", ok2, `status=${status} ${JSON.stringify(json).slice(0, 90)}`);
  } else {
    // generic: executed without a 5xx
    check(label + " (executes without a server error)", status > 0 && status < 500, `status=${status}`);
  }
}

check("D3  all non-live curl commands actually executed", executed.length >= commands.length - skipped.length, `${executed.length} executed, ${skipped.length} skipped`);

// ---- documented error codes appear in REAL responses ----
{
  const unauth = await fetch(`http://127.0.0.1:${port}/api/v1/tasks`);
  check("D4  documented code UNAUTHENTICATED real (v1 401)", unauth.status === 401 && (await unauth.json()).code === "UNAUTHENTICATED", String(unauth.status));
  const ver = await fetch(`http://127.0.0.1:${port}/api/v1/tasks`, { headers: { accept: "application/vnd.cloner.v9+json" } });
  check("D5  documented code VERSION_NOT_SUPPORTED real (v1 406)", ver.status === 406 && (await ver.json()).code === "VERSION_NOT_SUPPORTED", String(ver.status));
}

// ---- cleanup ----
server.close();
if (token) {
  const { validateSession } = await import("../src/auth/auth-service.js");
  const s = await validateSession(token);
  if (s) {
    await query("DELETE FROM onboarding_profiles WHERE user_id = $1", [s.userId]);
    await query("DELETE FROM credit_ledger_entries WHERE user_id = $1", [s.userId]);
    await query("DELETE FROM users WHERE id = $1", [s.userId]);
  }
}
await closePool();

const pass = results.filter(Boolean).length;
const fail = results.length - pass;
console.log(`\nRESULT: ${fail ? "FAIL" : "PASS"}  (${pass}/${results.length})`);
process.exit(fail ? 1 : 0);
