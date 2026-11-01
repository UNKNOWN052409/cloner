#!/usr/bin/env node
// Organization & membership lifecycle test (phase 4.0.2).
// Covers: org create/list/update/delete, membership lifecycle, invitations
// (issue → accept, expiry, revocation, duplicate, wrong account), role
// enforcement (member cannot invite, admin cannot touch the owner, no
// unauthorized ownership transfer), ownership transfer, member removal and
// the 4.0.1 tenant-scope contract via an injected mock middleware.
//
// Runs against the compose PostgreSQL instance (PG* env or 127.0.0.1:5433).
// Prints "SKIP: ..." and exits 0 when the database is unreachable.
// Applies ONLY migration 011 (its own migration); bootstraps 001 only if the
// users table is missing. The full ordered migration run is the integrator's job.
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import express from "express";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const PROJECT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
process.chdir(PROJECT);

const { query, closePool } = await import("../src/database/client.js");
const { createOrgRouter } = await import("../src/platform/org-routes.js");
const { authRequired } = await import("../src/auth/auth-middleware.js");
const orgService = await import("../src/platform/org-service.js");

const MIGRATIONS = path.join(PROJECT, "src", "database", "migrations");
const results = [];
const check = (name, ok, detail = "") => {
  results.push(ok);
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
};

// ---- tiny HTTP helper ----
function api(port, method, p, body, headers = {}) {
  return fetch(`http://127.0.0.1:${port}${p}`, {
    method,
    headers: { ...(body ? { "content-type": "application/json" } : {}), ...headers },
    body: body ? JSON.stringify(body) : undefined,
  }).then(async (res) => {
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch {}
    return { status: res.status, json, text };
  });
}

// ---- database bootstrap: reachability, then ONLY migration 011 ----
async function reachable() {
  try {
    await Promise.race([
      query("SELECT 1"),
      new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), 8000)),
    ]);
    return true;
  } catch {
    return false;
  }
}

async function applyMigrationFile(file, id) {
  await query(`CREATE TABLE IF NOT EXISTS _migrations (id TEXT PRIMARY KEY, applied_at TIMESTAMPTZ DEFAULT now())`);
  const applied = await query("SELECT 1 FROM _migrations WHERE id = $1", [id]);
  const sql = fs.readFileSync(path.join(MIGRATIONS, file), "utf8");
  if (applied.rows.length) {
    // already recorded (e.g. by a parallel full ordered run): re-execute the
    // file — 011 is written fully idempotent, so this only catches the shared
    // dev database up with additive statements from parallel migrations
    await query(sql);
    return "already-recorded";
  }
  await query(sql);
  await query("INSERT INTO _migrations (id) VALUES ($1)", [id]);
  return "applied";
}

const RUN = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const EMAIL = (n) => `org-t-${RUN}-${n}@test.local`;
const SLUG_PREFIX = "org-test-";
let server = null;
let serverDefault = null;

async function registerUser(n) {
  const email = EMAIL(n);
  const { registerUser, loginUser } = await import("../src/auth/auth-service.js");
  await registerUser(email, "password-123456");
  const session = await loginUser(email, "password-123456");
  return { email, token: session.token, userId: session.userId };
}
const auth = (u, extra = {}) => ({ authorization: `Bearer ${u.token}`, ...extra });

// ---- cleanup helpers (rerun-safe) ----
async function cleanup() {
  await query(`DELETE FROM organizations WHERE slug LIKE '${SLUG_PREFIX}%'`); // cascades members+invitations
  await query("DELETE FROM users WHERE email LIKE 'org-t-%@test.local'");
}

try {
  // ---- pre-flight ----
  let ok = await reachable();
  if (!ok) {
    console.log("postgres unreachable — attempting: docker compose up -d postgres");
    spawnSync("docker", ["compose", "up", "-d", "postgres"], { cwd: PROJECT, stdio: "ignore", shell: true });
    await new Promise((r) => setTimeout(r, 3000));
    ok = await reachable();
  }
  if (!ok) {
    console.log("SKIP: PostgreSQL unreachable — start it with: docker compose up -d postgres");
    process.exit(0);
  }
  check("preflight: postgres reachable", true);

  const usersTable = (await query("SELECT to_regclass('public.users') AS t")).rows[0].t;
  if (!usersTable) {
    await applyMigrationFile("001-initial.sql", "001-initial.sql"); // dependency bootstrap only
    console.log("note: users table was missing — bootstrapped 001-initial.sql (integrator owns the ordered run)");
  }
  const applied = await applyMigrationFile("011-org-members.sql", "011-org-members.sql");
  check("migration: 011-org-members.sql applied (or already present)", true, applied);

  await cleanup(); // rerun-safe: after migrations exist

  // ---- app under test: production authRequired + MOCK tenant scope (4.0.1 not landed yet) ----
  // The mock honours x-mock-tenant-org: when set, req.tenant.orgId is forced to
  // that id, exercising the cross-tenant denial path of the contract.
  const mockTenantScope = (req, res, next) => {
    req.tenant = { type: "user", userId: req.userId, orgId: req.headers["x-mock-tenant-org"] || null };
    if (req.params?.orgId && req.tenant.orgId && req.tenant.orgId !== req.params.orgId) {
      return res.status(403).json({ error: "cross-tenant access denied" });
    }
    next();
  };
  const app = express();
  app.use(express.json());
  app.use("/api/orgs", createOrgRouter({ authRequired, tenantScope: mockTenantScope }));
  // second mount with the DEFAULT fallbacks (integrator without 4.0.1 middleware)
  const appDefault = express();
  appDefault.use(express.json());
  appDefault.use("/api/orgs", createOrgRouter());

  await new Promise((r) => { server = http.createServer(app); server.listen(0, "127.0.0.1", r); });
  await new Promise((r) => { serverDefault = http.createServer(appDefault); serverDefault.listen(0, "127.0.0.1", r); });
  const P = server.address().port;
  const PD = serverDefault.address().port;

  // ---- users ----
  const alice = await registerUser("alice");   // owner
  const bob = await registerUser("bob");       // admin (later owner via transfer)
  const carol = await registerUser("carol");   // member
  const dave = await registerUser("dave");     // viewer
  const eve = await registerUser("eve");       // outsider
  const frank = await registerUser("frank");   // expired-invite target
  const gina = await registerUser("gina");     // revoked-invite target
  check("setup: 7 users registered", true);

  const O = "/api/orgs";

  // ---- org creation & visibility ----
  let r = await api(P, "POST", O, { name: `Org Test ${RUN}`, description: "lifecycle test" }, auth(alice));
  const orgId = r.json?.org?.id;
  check("create org → 201 with owner role", r.status === 201 && orgId && r.json?.role === "owner", `status ${r.status}`);
  check("org slug derived from name", r.json?.org?.slug === `org-test-${RUN}`, r.json?.org?.slug);

  r = await api(P, "GET", O, null, auth(alice));
  check("owner lists orgs → contains new org", r.status === 200 && r.json?.some((o) => o.id === orgId));
  r = await api(P, "GET", O, null, auth(carol));
  check("non-member lists orgs → empty", r.status === 200 && r.json?.length === 0);

  r = await api(P, "GET", `${O}/${orgId}`, null, auth(eve));
  check("outsider GET org → 404 (existence not leaked)", r.status === 404);
  r = await api(P, "PATCH", `${O}/${orgId}`, { name: "hijack" }, auth(eve));
  check("outsider PATCH org → 404", r.status === 404);
  r = await api(P, "DELETE", `${O}/${orgId}`, null, auth(eve));
  check("outsider DELETE org → 404", r.status === 404);

  // unauthenticated
  r = await api(P, "GET", O, null, {});
  check("unauthenticated list → 401", r.status === 401);

  // ---- invitations: issue ----
  r = await api(P, "POST", `${O}/${orgId}/invitations`, { email: carol.email, role: "member" }, auth(alice));
  check("owner invites member carol → 201 + token", r.status === 201 && !!r.json?.token, `status ${r.status}`);
  const carolInvite = r.json;
  r = await api(P, "POST", `${O}/${orgId}/invitations`, { email: bob.email, role: "admin" }, auth(alice));
  check("owner invites admin bob → 201", r.status === 201 && r.json?.invitation?.role === "admin");
  const bobInvite = r.json;
  r = await api(P, "POST", `${O}/${orgId}/invitations`, { email: dave.email, role: "viewer" }, auth(alice));
  check("owner invites viewer dave → 201", r.status === 201);
  const daveInvite = r.json;
  r = await api(P, "POST", `${O}/${orgId}/invitations`, { email: frank.email, role: "member", ttlHours: 0 }, auth(alice));
  check("owner invites frank with ttlHours:0 → 201 (already expired)", r.status === 201);
  const frankInvite = r.json;
  r = await api(P, "POST", `${O}/${orgId}/invitations`, { email: gina.email, role: "member" }, auth(alice));
  check("owner invites gina → 201", r.status === 201);
  const ginaInvite = r.json;

  r = await api(P, "POST", `${O}/${orgId}/invitations`, { email: carol.email, role: "viewer" }, auth(alice));
  check("duplicate pending invitation → 409", r.status === 409);
  r = await api(P, "POST", `${O}/${orgId}/invitations`, { email: EMAIL("x@test.local"), role: "owner" }, auth(alice));
  check("inviting to role owner → 400 (transfer is the only path)", r.status === 400);

  // ---- invitations: accept / expiry / revocation / wrong account ----
  r = await api(P, "POST", `${O}/invitations/accept`, { token: "no-such-token" }, auth(carol));
  check("accept with invalid token → 404", r.status === 404);
  r = await api(P, "POST", `${O}/invitations/accept`, {}, auth(carol));
  check("accept without token → 400", r.status === 400);
  r = await api(P, "POST", `${O}/invitations/accept`, { token: carolInvite.token }, auth(carol));
  check("carol accepts invite → member of org", r.status === 200 && r.json?.role === "member" && r.json?.orgId === orgId, `status ${r.status}`);
  r = await api(P, "POST", `${O}/invitations/accept`, { token: carolInvite.token }, auth(carol));
  check("re-accepting a used token → 409", r.status === 409);
  r = await api(P, "POST", `${O}/invitations/accept`, { token: frankInvite.token }, auth(frank));
  check("expired invitation → 410", r.status === 410, `status ${r.status}`);
  r = await api(P, "POST", `${O}/invitations/accept`, { token: bobInvite.token }, auth(bob));
  check("bob accepts → admin", r.status === 200 && r.json?.role === "admin");
  r = await api(P, "POST", `${O}/invitations/accept`, { token: daveInvite.token }, auth(dave));
  check("dave accepts → viewer", r.status === 200 && r.json?.role === "viewer", `status ${r.status}`);
  r = await api(P, "POST", `${O}/invitations/accept`, { token: ginaInvite.token }, auth(eve));
  check("accepting someone else's invitation → 403 (per-email)", r.status === 403, `status ${r.status}`);

  r = await api(P, "GET", `${O}/${orgId}/invitations`, null, auth(alice));
  const invites = r.json || [];
  const ginaRow = invites.find((i) => i.email === gina.email);
  check("invitation list hides token hashes", r.status === 200 && invites.length >= 5 && !("token_hash" in (invites[0] || {})));
  r = await api(P, "POST", `${O}/${orgId}/invitations/${ginaRow.id}/revoke`, null, auth(alice));
  check("owner revokes pending invitation → ok", r.status === 200);
  r = await api(P, "POST", `${O}/invitations/accept`, { token: ginaInvite.token }, auth(gina));
  check("revoked invitation → 409", r.status === 409, `status ${r.status}`);
  r = await api(P, "POST", `${O}/${orgId}/invitations`, { email: gina.email, role: "member" }, auth(alice));
  check("re-invite after revocation allowed → 201", r.status === 201);
  const ginaReInvite = r.json;

  r = await api(P, "POST", `${O}/invitations/accept`, { token: ginaReInvite.token }, auth(gina));
  check("gina accepts re-invite → member", r.status === 200 && r.json?.role === "member");

  // ---- role enforcement: member cannot invite / mutate ----
  r = await api(P, "POST", `${O}/${orgId}/invitations`, { email: eve.email, role: "member" }, auth(carol));
  check("MEMBER cannot invite → 403", r.status === 403, `status ${r.status}`);
  r = await api(P, "PATCH", `${O}/${orgId}`, { name: "carol-corp" }, auth(carol));
  check("member cannot update org → 403", r.status === 403);
  r = await api(P, "PATCH", `${O}/${orgId}/members/${dave.userId}`, { role: "admin" }, auth(carol));
  check("member cannot change roles → 403", r.status === 403);
  r = await api(P, "DELETE", `${O}/${orgId}/members/${dave.userId}`, null, auth(carol));
  check("member cannot remove members → 403", r.status === 403);
  r = await api(P, "GET", `${O}/${orgId}/members`, null, auth(carol));
  check("member can list members → 200", r.status === 200 && r.json?.length === 5, `count ${r.json?.length}`);
  r = await api(P, "GET", `${O}/${orgId}/invitations`, null, auth(carol));
  check("member cannot list invitations → 403", r.status === 403);
  r = await api(P, "DELETE", `${O}/${orgId}`, null, auth(carol));
  check("member cannot delete org → 403", r.status === 403);

  // viewer can read, nothing else
  r = await api(P, "GET", `${O}/${orgId}/members`, null, auth(dave));
  check("viewer can list members → 200", r.status === 200);
  r = await api(P, "PATCH", `${O}/${orgId}`, { name: "viewer-corp" }, auth(dave));
  check("viewer cannot update org → 403", r.status === 403);

  // ---- admin powers and their limits ----
  r = await api(P, "PATCH", `${O}/${orgId}`, { name: `Renamed Org ${RUN}` }, auth(bob));
  check("admin updates org → 200", r.status === 200 && r.json?.name === `Renamed Org ${RUN}`);
  r = await api(P, "POST", `${O}/${orgId}/invitations`, { email: eve.email, role: "member" }, auth(bob));
  check("admin invites member → 201", r.status === 201);
  const eveInvite = r.json;
  r = await api(P, "POST", `${O}/${orgId}/invitations`, { email: EMAIL("admin2@test.local"), role: "admin" }, auth(bob));
  check("admin cannot invite admin role → 403 (owner-only)", r.status === 403, `status ${r.status}`);
  r = await api(P, "POST", `${O}/invitations/accept`, { token: eveInvite.token }, auth(eve));
  check("eve accepts admin invite → member", r.status === 200 && r.json?.role === "member");

  r = await api(P, "PATCH", `${O}/${orgId}/members/${eve.userId}`, { role: "viewer" }, auth(bob));
  check("admin changes member→viewer → 200", r.status === 200 && r.json?.role === "viewer");
  r = await api(P, "PATCH", `${O}/${orgId}/members/${alice.userId}`, { role: "member" }, auth(bob));
  check("admin cannot change the owner's role → 403", r.status === 403, `status ${r.status}`);
  r = await api(P, "PATCH", `${O}/${orgId}/members/${eve.userId}`, { role: "owner" }, auth(bob));
  check("admin cannot grant owner → 403", r.status === 403, `status ${r.status}`);
  r = await api(P, "PATCH", `${O}/${orgId}/members/${bob.userId}`, { role: "member" }, auth(bob));
  check("self role change → 400", r.status === 400);
  r = await api(P, "DELETE", `${O}/${orgId}/members/${eve.userId}`, null, auth(bob));
  check("admin removes member → 200", r.status === 200);
  r = await api(P, "GET", `${O}/${orgId}`, null, auth(eve));
  check("removed member loses access → 404", r.status === 404);

  // ---- owner powers ----
  r = await api(P, "PATCH", `${O}/${orgId}/members/${dave.userId}`, { role: "admin" }, auth(alice));
  check("owner promotes viewer→admin → 200", r.status === 200 && r.json?.role === "admin");
  r = await api(P, "DELETE", `${O}/${orgId}/members/${dave.userId}`, null, auth(bob));
  check("admin cannot remove another admin → 403 (owner-only)", r.status === 403, `status ${r.status}`);
  r = await api(P, "DELETE", `${O}/${orgId}/members/${dave.userId}`, null, auth(alice));
  check("owner removes admin → 200", r.status === 200);
  r = await api(P, "DELETE", `${O}/${orgId}/members/${alice.userId}`, null, auth(alice));
  check("owner self-removal → 400", r.status === 400);

  // ---- ownership transfer ----
  r = await api(P, "PATCH", `${O}/${orgId}/members/${carol.userId}`, { role: "owner" }, auth(bob));
  check("non-owner attempting transfer → 403", r.status === 403, `status ${r.status}`);
  r = await api(P, "PATCH", `${O}/${orgId}/members/${bob.userId}`, { role: "owner" }, auth(alice));
  check("owner transfers ownership to bob → previous owner demoted to admin", r.status === 200 && r.json?.role === "owner" && r.json?.previousOwnerRole === "admin", `status ${r.status}`);
  const members = (await api(P, "GET", `${O}/${orgId}/members`, null, auth(bob))).json || [];
  check("membership shows exactly one owner", members.filter((m) => m.role === "owner").length === 1 && members.find((m) => m.role === "owner")?.user_id === bob.userId);
  r = await api(P, "DELETE", `${O}/${orgId}`, null, auth(alice));
  check("former owner (now admin) cannot delete org → 403", r.status === 403, `status ${r.status}`);
  r = await api(P, "PATCH", `${O}/${orgId}/members/${bob.userId}`, { role: "member" }, auth(alice));
  check("admin cannot change the new owner's role → 403", r.status === 403);
  r = await api(P, "POST", `${O}/${orgId}/invitations`, { email: EMAIL("owner-invite"), role: "admin" }, auth(bob));
  check("new owner can invite admins → 201", r.status === 201, `status ${r.status} ${r.json?.error || ""}`);

  // ---- tenant-scope contract (injected mock, 4.0.1 contract) ----
  const otherOrg = await orgService.createOrg({ userId: eve.userId, name: `Other Org ${RUN}`, slug: `${SLUG_PREFIX}other-${RUN}` });
  r = await api(P, "GET", `${O}/${orgId}`, null, { ...auth(bob), "x-mock-tenant-org": otherOrg.org.id });
  check("tenant scope mismatch → 403 cross-tenant denial", r.status === 403 && /cross-tenant/.test(r.json?.error || ""), `status ${r.status}`);
  r = await api(P, "PATCH", `${O}/${orgId}`, { name: "evil" }, auth(bob, { "x-mock-tenant-org": otherOrg.org.id }));
  check("tenant scope mismatch on mutation → 403", r.status === 403);
  r = await api(P, "GET", `${O}/${orgId}`, null, auth(bob));
  check("tenant scope match (null orgId) → 200", r.status === 200);

  // ---- default fallback mount (no injected tenant middleware) ----
  r = await api(PD, "GET", `${O}/${orgId}`, null, auth(bob));
  check("default fallback middleware → org readable", r.status === 200, `status ${r.status}`);

  // ---- service-level: slug collision handling ----
  const a = await orgService.createOrg({ userId: alice.userId, name: "Dup Name", slug: `${SLUG_PREFIX}dup-${RUN}` });
  const b2 = await orgService.createOrg({ userId: bob.userId, name: "Dup Name", slug: `${SLUG_PREFIX}dup-${RUN}` });
  check("slug collision resolved with distinct slugs", a.org.slug !== b2.org.slug, `${a.org.slug} vs ${b2.org.slug}`);

  // ---- deletion & cascade ----
  r = await api(P, "DELETE", `${O}/${orgId}`, null, auth(bob));
  check("owner deletes org → 200", r.status === 200);
  r = await api(P, "GET", `${O}/${orgId}`, null, auth(bob));
  check("deleted org → 404", r.status === 404);
  const leftoverMembers = (await query("SELECT count(*)::int AS c FROM org_members WHERE org_id = $1", [orgId])).rows[0].c;
  const leftoverInvites = (await query("SELECT count(*)::int AS c FROM org_invitations WHERE org_id = $1", [orgId])).rows[0].c;
  check("membership + invitations cascaded on delete", leftoverMembers === 0 && leftoverInvites === 0, `members ${leftoverMembers}, invites ${leftoverInvites}`);
  r = await api(P, "GET", O, null, auth(bob));
  check("org list no longer contains deleted org", r.status === 200 && !r.json?.some((o) => o.id === orgId));
} catch (e) {
  check("no unexpected crash", false, String(e?.stack || e).split("\n")[0]);
} finally {
  try { await cleanup(); } catch {}
  if (server) { server.closeAllConnections?.(); await new Promise((r) => server.close(r)); }
  if (serverDefault) { serverDefault.closeAllConnections?.(); await new Promise((r) => serverDefault.close(r)); }
  await closePool();
}

const fails = results.filter((x) => !x).length;
console.log(`\n${fails ? "RESULT: FAIL" : "RESULT: PASS"}  (${results.length - fails}/${results.length} checks passed)`);
process.exit(fails ? 1 : 0);
