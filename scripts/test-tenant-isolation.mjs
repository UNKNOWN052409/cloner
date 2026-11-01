#!/usr/bin/env node
// Tenant isolation e2e (task 4.0.1).
//
// Seeds two unrelated organizations A and B (each with an owner, org A also
// gets a plain member and an outside user exists with no org), then asserts
// cross-tenant denial at BOTH levels the ask requires:
//   • repository level — tenant-repository.js filters every org-scoped query
//     by the resolved tenant context; hand-crafted contexts (what a malicious
//     caller/worker could construct) still cannot cross orgs
//   • middleware level — tenant-scope.js mounted on a real express app over
//     HTTP denies cross-org ids arriving via header/query/body with 403 and
//     out-of-scope task ids with 404, writes denial audit rows and gates
//     admin actions by org role (member < admin < owner)
//
// Scope note: server.js / ws-auth.js are integrator-owned, so the middleware
// is exercised exactly as the integrator will mount it (authRequired →
// resolveTenantScope → [requireOrgRole] → loadTaskScope) on an ephemeral port.
//
// Requires the compose PostgreSQL: `docker compose up -d postgres`. If docker
// or PostgreSQL is unreachable the test prints a loud SKIP line and exits 0
// (same convention as test-worker-queue.mjs). Runtime-generated throwaway
// passwords/emails only — nothing hardcoded. Cleans up everything it created.
process.env.PGCONNECT_TIMEOUT = process.env.PGCONNECT_TIMEOUT || "4";
import path from "node:path";
import fs from "node:fs";
import crypto from "node:crypto";
import { execFile } from "node:child_process";
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
  catch (e) { try { await closePool(); } catch {} return { ok: false, error: e }; }
}

async function waitForPg(attempts = 30, stepMs = 1000) {
  for (let i = 0; i < attempts; i++) {
    if ((await pgReachable()).ok) return true;
    await new Promise((r) => setTimeout(r, stepMs));
  }
  return false;
}

let db = await pgReachable();
if (!db.ok) {
  // Not running → bring up the compose instance (ask: "docker compose up -d
  // postgres if needed").
  let upErr = "";
  try {
    await new Promise((resolve, reject) => {
      execFile("docker", ["compose", "up", "-d", "postgres"], { cwd: PROJECT, timeout: 90_000 }, (e, _so, se) => {
        if (e) { upErr = `${e.message}${se ? ` :: ${String(se).slice(0, 300)}` : ""}`; reject(e); } else resolve();
      });
    });
  } catch { /* fall through to the SKIP check */ }
  if (!(await waitForPg())) {
    console.log("=".repeat(78));
    console.log("SKIP  tenant-isolation — PostgreSQL unreachable (loud SKIP per task 4.0.1).");
    console.log(`SKIP  tried: docker compose up -d postgres (cwd: ${PROJECT})${upErr ? ` — ${upErr}` : ""}`);
    console.log("SKIP  start the compose instance (`docker compose up -d postgres`) and re-run.");
    console.log("=".repeat(78));
    process.exit(0);
  }
  db = await pgReachable();
}
const { query, closePool } = db;

// Apply ONLY the pre-existing baseline (001) and this task's migration (010) —
// the full ordered run of every migration file is the integrator's job.
const { migrate } = await import("../src/database/client.js"); // eslint-disable-line no-unused-vars
async function applyOwnMigrations() {
  await query(`CREATE TABLE IF NOT EXISTS _migrations (id TEXT PRIMARY KEY, applied_at TIMESTAMPTZ DEFAULT now())`);
  const dir = path.join(PROJECT, "src", "database", "migrations");
  for (const file of ["001-initial.sql", "010-tenants.sql"]) {
    const applied = await query("SELECT 1 FROM _migrations WHERE id = $1", [file]);
    if (applied.rows.length) continue;
    await query(fs.readFileSync(path.join(dir, file), "utf8"));
    await query("INSERT INTO _migrations (id) VALUES ($1) ON CONFLICT DO NOTHING", [file]);
    console.log(`[db] applied: ${file}`);
  }
}
await applyOwnMigrations();

const { authRequired } = await import("../src/auth/auth-middleware.js");
const auth = await import("../src/auth/auth-service.js");
const taskRepo = await import("../src/database/task-repository.js");
const tenants = await import("../src/database/tenant-repository.js");
const scope = await import("../src/platform/tenant-scope.js");
const express = (await import("express")).default;

const uuid = () => crypto.randomUUID();
const rand = () => crypto.randomBytes(6).toString("hex");

// ---- seed: two unrelated orgs + users ---------------------------------------
async function makeUser(prefix) {
  const email = `${prefix}-${rand()}@test.local`;
  const password = `pw-${rand()}-${rand()}!A1`; // throwaway, never hardcoded
  const user = await auth.registerUser(email, password);
  const { token } = await auth.loginUser(email, password);
  return { ...user, token };
}
const users = { A: await makeUser("tenant-a"), B: await makeUser("tenant-b"), C: await makeUser("tenant-c"), D: await makeUser("tenant-d") };

const orgA = await tenants.createOrganization({ name: "Org A", slug: `org-a-${rand()}`, ownerUserId: users.A.id });
const orgB = await tenants.createOrganization({ name: "Org B", slug: `org-b-${rand()}`, ownerUserId: users.B.id });
await tenants.addOrgMember(orgA.id, users.C.id, "member");

const ctxA = await tenants.resolveTenantContext(users.A.id, orgA.id);
const ctxB = await tenants.resolveTenantContext(users.B.id, orgB.id);
const ctxC = await tenants.resolveTenantContext(users.C.id, orgA.id);
const personalA = await tenants.resolveTenantContext(users.A.id, null);

const tA = await tenants.createOrgTask({ ctx: ctxA, url: "https://org-a.example/site", options: { depth: 1 } });
const tB = await tenants.createOrgTask({ ctx: ctxB, url: "https://org-b.example/site", options: { depth: 1 } });
const pA = await taskRepo.createTask({ userId: users.A.id, url: "https://personal.example/site" });
const pB = await taskRepo.createTask({ userId: users.B.id, url: "https://personal-b.example/site" });
await query(
  `INSERT INTO artifacts (task_id, stage, artifact_type, storage_key) VALUES ($1, 'reconstruction', 'zip', 'seed/key.zip')`,
  [tB.id]
);

// Hand-built contexts: what a compromised caller/worker could construct without
// going through the middleware. The repository must still deny them.
const forgedAinB = { userId: users.A.id, orgId: orgB.id, role: "owner", personal: false };
const forgedBinA = { userId: users.B.id, orgId: orgA.id, role: "owner", personal: false };

console.log("\n— repository level (tenant-repository.js) —");
check("R1  owner resolves with role 'owner'", ctxA?.role === "owner" && ctxA.orgId === orgA.id && ctxA.personal === false, JSON.stringify(ctxA));
check("R2  non-member resolves to null (org B for A)", (await tenants.resolveTenantContext(users.A.id, orgB.id)) === null);
check("R3  outsider resolves to null (org A for D)", (await tenants.resolveTenantContext(users.D.id, orgA.id)) === null);
check("R4  member resolves with role 'member'", ctxC?.role === "member");
check("R5  getOrgTask denies forged cross-org context (A→B)", (await tenants.getOrgTask(tB.id, forgedAinB)) === null);
check("R6  getOrgTask denies forged cross-org context (B→A)", (await tenants.getOrgTask(tA.id, forgedBinA)) === null);
check("R7  getOrgTask allows legit owner", (await tenants.getOrgTask(tA.id, ctxA))?.id === tA.id);
check("R8  getOrgTask denies outsider user entirely", (await tenants.getOrgTask(tA.id, { userId: users.D.id, orgId: orgA.id })) === null);
const listB = await tenants.listOrgTasks(ctxB);
check("R9  listOrgTasks(B) returns only B's task", listB.length === 1 && listB[0].id === tB.id, `got ${listB.length}`);
check("R10 updateOrgTask denies cross-org forged ctx", (await tenants.updateOrgTask(tB.id, forgedAinB, { status: "cancelled" })) === null);
check("R11 task unchanged after denied update", (await tenants.getOrgTask(tB.id, ctxB)).status === "created");
check("R12 deleteOrgTask denies cross-org forged ctx", (await tenants.deleteOrgTask(tB.id, forgedAinB)) === false && !!(await tenants.getOrgTask(tB.id, ctxB)));
check("R13 guessed task uuid → null (no existence leak)", (await tenants.getOrgTask(uuid(), ctxA)) === null);
check("R14 malformed task id → null, no throw", (await tenants.getOrgTask("not-a-uuid'; DROP TABLE tasks;--", ctxA)) === null);
check("R15 guessed org uuid for outsider → null context", (await tenants.resolveTenantContext(users.D.id, uuid())) === null);
const orgListA = await tenants.listOrgTasks(ctxA);
check("R16 listOrgTasks(A) excludes org B and personal tasks", orgListA.length === 1 && orgListA[0].id === tA.id, `got ${orgListA.length}`);
check("R17 personal scope hides org task even for its creator", (await tenants.getScopedTask(tA.id, personalA)) === null);
check("R18 personal scope returns own personal task", (await tenants.getScopedTask(pA.id, personalA))?.id === pA.id);
check("R19 personal scope never returns another user's task", (await tenants.getScopedTask(pB.id, personalA)) === null);
check("R20 org ctx never returns a personal task", (await tenants.getScopedTask(pA.id, forgedAinB)) === null && (await tenants.getScopedTask(pA.id, ctxA)) === null);
let threw = null;
try { await tenants.listOrgTasks(personalA); } catch (e) { threw = e; }
check("R21 org-scoped list with personal context throws", threw?.name === "TenantError", threw?.name || "no throw");
const artB = await tenants.getOrgTaskWithArtifacts(tB.id, ctxB);
check("R22 artifacts scoped with task (B sees own)", artB?.artifacts?.length === 1);
check("R23 artifacts denied cross-org (A→B)", (await tenants.getOrgTaskWithArtifacts(tB.id, forgedAinB)) === null);
check("R24 getTaskForJob honors trusted ownership triple (ok)", (await tenants.getTaskForJob(tA.id, { userId: users.A.id, orgId: orgA.id }))?.id === tA.id);
check("R25 getTaskForJob denies wrong org", (await tenants.getTaskForJob(tA.id, { userId: users.A.id, orgId: orgB.id })) === null);
check("R26 getTaskForJob denies wrong user", (await tenants.getTaskForJob(tA.id, { userId: users.B.id, orgId: orgA.id })) === null);
check("R27 roleAtLeast ordering owner>admin>member", tenants.roleAtLeast("owner", "admin") && tenants.roleAtLeast("admin", "admin") && !tenants.roleAtLeast("member", "admin"));

// ---- middleware level (express app on an ephemeral port) --------------------
const app = express();
app.use(express.json());
// mount exactly as the integrator will: authRequired → resolveTenantScope → [requireOrgRole] → loadTaskScope
const authed = [authRequired, scope.resolveTenantScope];
app.get("/whoami", ...authed, (req, res) => res.json(req.tenantScope));
app.get("/tasks", ...authed, async (req, res) => {
  try {
    // personal workspace → legacy owner API (unchanged); org context → scoped query
    res.json(req.tenantScope.personal
      ? await taskRepo.listTasks(req.userId)
      : await tenants.listOrgTasks(req.tenantScope));
  } catch (e) { scope.sendTenantError(res, e); }
});
app.post("/tasks", ...authed, async (req, res) => {
  try {
    const task = await tenants.createOrgTask({ ctx: req.tenantScope, url: req.body?.url || "https://created.example/" });
    createdViaApi.push(task.id);
    res.status(201).json({ id: task.id, orgId: task.org_id });
  } catch (e) { scope.sendTenantError(res, e); }
});
app.get("/tasks/:id", ...authed, scope.loadTaskScope(), (req, res) => res.json({ task: req.task, artifacts: req.artifacts }));
app.post("/tasks/:id/cancel", ...authed, scope.loadTaskScope(), async (req, res) => {
  const updated = req.tenantScope.personal
    ? await taskRepo.updateTask(req.params.id, req.userId, { status: "cancelled" }) // personal scope → legacy owner API
    : await tenants.updateOrgTask(req.params.id, req.tenantScope, { status: "cancelled" });
  if (!updated) return res.status(404).json({ error: "task not found" });
  res.json({ id: updated.id, status: updated.status });
});
app.post("/tasks/:id/retry", ...authed, scope.requireOrgRole("admin"), scope.loadTaskScope(), async (req, res) => {
  const updated = await tenants.updateOrgTask(req.params.id, req.tenantScope, { status: "queued" });
  if (!updated) return res.status(404).json({ error: "task not found" });
  res.json({ id: updated.id, status: updated.status });
});

const server = app.listen(0, "127.0.0.1");
await new Promise((r) => server.once("listening", r));
const port = server.address().port;
const api = (method, p, { token, org, body, orgInQuery } = {}) => {
  const url = new URL(`http://127.0.0.1:${port}${p}`);
  if (orgInQuery) url.searchParams.set("orgId", orgInQuery);
  return fetch(url, {
    method,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(org ? { "x-org-id": org } : {}),
      ...(body ? { "content-type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  }).then(async (res) => ({ status: res.status, json: await res.json().catch(() => null) }));
};

const tok = (u) => users[u].token;
const O = () => ({ A: orgA.id, B: orgB.id });
const createdViaApi = []; // tasks created through the test API, cleaned up below

console.log("\n— middleware level (tenant-scope.js over HTTP) —");
const who = await api("GET", "/whoami", { token: tok("A"), org: O().A });
check("M1  owner scope resolved via header", who.status === 200 && who.json?.orgId === orgA.id && who.json?.role === "owner", JSON.stringify(who.json));
const listHttpA = await api("GET", "/tasks", { token: tok("A"), org: O().A });
check("M2  org A list contains only A's task", listHttpA.status === 200 && listHttpA.json?.length === 1 && listHttpA.json[0].id === tA.id);
const crossAB = await api("GET", "/tasks", { token: tok("A"), org: O().B });
check("M3  cross-org header denied 403 (A→B)", crossAB.status === 403 && crossAB.json?.error === "org access denied");
const crossBA = await api("GET", "/tasks", { token: tok("B"), org: O().A });
check("M4  cross-org header denied 403 (B→A)", crossBA.status === 403);
const guessedOrg = await api("GET", "/tasks", { token: tok("A"), org: uuid() });
check("M5  guessed org uuid denied 403 (no existence leak)", guessedOrg.status === 403);
const evilOrg = await api("GET", "/tasks", { token: tok("A"), org: `x'; DELETE FROM org_members;--` });
check("M6  malformed org id denied 403 (no SQL injection)", evilOrg.status === 403);
const viaQuery = await api("GET", "/tasks", { token: tok("A"), orgInQuery: O().B });
check("M7  cross-org via query param denied 403", viaQuery.status === 403);
const viaBody = await api("POST", "/tasks", { token: tok("A"), body: { orgId: O().B, url: "https://evil.example/" } });
check("M8  cross-org via body denied 403", viaBody.status === 403);
const viaBodyOverride = await api("POST", "/tasks", { token: tok("A"), org: O().A, body: { orgId: O().B, url: "https://created.example/" } });
check("M9  header takes precedence over spoofed body", viaBodyOverride.status === 201 && viaBodyOverride.json?.orgId === orgA.id, JSON.stringify(viaBodyOverride.json));
const getCross = await api("GET", `/tasks/${tA.id}`, { token: tok("B"), org: O().B });
check("M10 direct-id GET of foreign task → 404 within org scope", getCross.status === 404);
const getCrossA = await api("GET", `/tasks/${tB.id}`, { token: tok("A"), org: O().A });
check("M11 direct-id GET of foreign task (A→B) → 404", getCrossA.status === 404);
const getOwn = await api("GET", `/tasks/${tA.id}`, { token: tok("A"), org: O().A });
check("M12 owner direct-id GET of own org task → 200", getOwn.status === 200 && getOwn.json?.task?.id === tA.id);
const memberRead = await api("GET", `/tasks/${tA.id}`, { token: tok("C"), org: O().A });
check("M13 plain member can read own-org task", memberRead.status === 200);
const guessedTask = await api("GET", `/tasks/${uuid()}`, { token: tok("A"), org: O().A });
check("M14 guessed task uuid → 404", guessedTask.status === 404);
const cancelCross = await api("POST", `/tasks/${tA.id}/cancel`, { token: tok("B"), org: O().B });
check("M15 cross-org cancel denied 404", cancelCross.status === 404);
check("M16 task NOT cancelled after denial", (await tenants.getOrgTask(tA.id, ctxA)).status === "created");
const cancelOwn = await api("POST", `/tasks/${tA.id}/cancel`, { token: tok("A"), org: O().A });
check("M17 owner cancels own org task → 200", cancelOwn.status === 200 && cancelOwn.json?.status === "cancelled");
const retryMember = await api("POST", `/tasks/${tA.id}/retry`, { token: tok("C"), org: O().A });
check("M18 member role below admin → retry 403", retryMember.status === 403 && retryMember.json?.error === "insufficient org role");
const retryOwner = await api("POST", `/tasks/${tA.id}/retry`, { token: tok("A"), org: O().A });
check("M19 owner retries own org task → 200", retryOwner.status === 200 && retryOwner.json?.status === "queued");
const retryPersonal = await api("POST", `/tasks/${pA.id}/retry`, { token: tok("A") });
check("M20 retry on personal scope denied 403 (org role required)", retryPersonal.status === 403 && retryPersonal.json?.error === "org role required");
const personalList = await api("GET", "/tasks", { token: tok("A") });
// The legacy personal list returns everything the user owns (including the org
// task they created) — the isolation invariant is that NO other tenant's data
// leaks: every row must belong to user A, and org B's data must be absent.
const personalIds = new Set((personalList.json || []).map((t) => t.id));
check("M21 personal list contains only this user's tasks (no org B leak)",
  personalList.status === 200 && personalIds.has(pA.id) && !personalIds.has(tB.id) && !personalIds.has(pB.id),
  `ids=${[...personalIds].join(",")}`);
const personalGetOrgTask = await api("GET", `/tasks/${tA.id}`, { token: tok("A") });
check("M22 personal scope cannot fetch org task → 404", personalGetOrgTask.status === 404);
const noAuth = await api("GET", "/whoami", {});
check("M23 unauthenticated → 401", noAuth.status === 401);
const personalWho = await api("GET", "/whoami", { token: tok("A") });
check("M24 scoped request without org context resolves personal", personalWho.status === 200 && personalWho.json?.personal === true && personalWho.json?.orgId === null);

const denialsBefore = (await query(`SELECT count(*)::int AS n FROM tenant_denials`)).rows[0].n;
await api("GET", "/tasks", { token: tok("A"), org: O().B });
// the audit insert is fire-and-forget on the request path — poll briefly for it to land
let denialsAfter = denialsBefore;
for (let i = 0; i < 20 && denialsAfter <= denialsBefore; i++) {
  await new Promise((r) => setTimeout(r, 100));
  denialsAfter = (await query(`SELECT count(*)::int AS n FROM tenant_denials`)).rows[0].n;
}
const lastDenial = (await tenants.listTenantDenials({ orgId: orgB.id, limit: 1 }))[0];
check("M25 denial audit rows written", denialsAfter > denialsBefore && lastDenial?.userId === users.A.id && lastDenial?.action === "resolveTenantScope", `${denialsBefore} → ${denialsAfter}`);

// ---- backward compatibility -------------------------------------------------
console.log("\n— backward compatibility —");
check("B1  legacy task-repository API unchanged (owner reads own)", (await taskRepo.getTask(pA.id, users.A.id))?.id === pA.id);
check("B2  legacy task-repository still scopes other users out", (await taskRepo.getTask(pA.id, users.B.id)) === null);
check("B3  legacy createTask rows are user-owned (org_id NULL)", (await query(`SELECT org_id FROM tasks WHERE id = $1`, [pA.id])).rows[0].org_id === null);
check("B4  org task keeps creator user_id for audit", (await tenants.getOrgTask(tA.id, ctxA)).user_id === users.A.id);

// ---- cleanup ----------------------------------------------------------------
server.close();
for (const t of [tA, tB, pA, pB, ...createdViaApi]) await query(`DELETE FROM tasks WHERE id = $1`, [t.id]);
for (const u of Object.values(users)) await query(`DELETE FROM users WHERE id = $1`, [u.id]);
for (const o of [orgA, orgB]) await query(`DELETE FROM organizations WHERE id = $1`, [o.id]);
await query(`DELETE FROM tenant_denials WHERE user_id = ANY($1::uuid[])`, [Object.values(users).map((u) => u.id)]);
await closePool();

const pass = results.filter(Boolean).length;
const fail = results.length - pass;
console.log(`\n${pass}/${results.length} checks passed${fail ? `, ${fail} FAILED` : " — all green"}`);
process.exit(fail ? 1 : 0);
