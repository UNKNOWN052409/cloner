#!/usr/bin/env node
// Task 4.1.4 e2e — plans, entitlements and feature access.
//
// Exercises plan-service.js against the REAL database (plans/user_plans/
// org_plans, migrations 018 + 010 for orgs) through BOTH the service layer
// and a real express app with the router mounted as the integrator will:
//   • seeded catalog lists free/pro/team with entitlements
//   • plan change FLIPS entitlements (the plan doc's core requirement)
//   • org-plan-wins: an org member resolves the ORG's plan over their own
//   • unknown feature → deny by default (featureAllowed + HTTP check route)
//   • unknown plan id → 400; plan mutations admin-only → 403 for users
//
// SKIP loudly when PostgreSQL is unreachable.
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
  console.log("SKIP  plans — PostgreSQL unreachable (`docker compose up -d postgres`) — loud SKIP per test convention.");
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

const auth = await import("../src/auth/auth-service.js");
const tenants = await import("../src/database/tenant-repository.js");
const express = (await import("express")).default;
const P = await import("../src/platform/plan-service.js");
const { resolveTenantScope } = await import("../src/platform/tenant-scope.js");

const rand = () => crypto.randomBytes(6).toString("hex");

async function makeUser(prefix) {
  const email = `${prefix}-${rand()}@test.local`;
  const password = `pw-${rand()}-${rand()}!A1`;
  const user = await auth.registerUser(email, password);
  const { token } = await auth.loginUser(email, password);
  return { ...user, token };
}

const app = express();
app.use(express.json({ limit: "64kb" }));
app.use("/api/plans", P.planRouter());
// mirror server.js's tenant middleware for the org-aware effective route
app.use(resolveTenantScope);
const server = app.listen(0, "127.0.0.1");
await new Promise((r) => server.on("listening", r));
const port = server.address().port;
const api = async (method, p, body, token, headers = {}) => {
  const res = await fetch(`http://127.0.0.1:${port}/api/plans${p}`, {
    method,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...headers,
      ...(body ? { "content-type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => null);
  return { status: res.status, json };
};

const uA = await makeUser("plan-a");
const uB = await makeUser("plan-b");
const orgA = await tenants.createOrganization({ name: "Plan Org", slug: `plan-org-${rand()}`, ownerUserId: uA.id });

// ---- seeded catalog (unauthenticated → 401; the authenticated catalog is
// asserted at P10/P10b once tokens exist) ----
{
  const list = await api("GET", "/", null, null);
  check("P1  unauthenticated catalog request is refused (401), never a silent empty list",
    list.status === 401 && !Array.isArray(list.json?.plans) && /authentication required/i.test(list.json?.error || ""), `${list.status} ${JSON.stringify(list.json).slice(0, 80)}`);
  const pro = (list.json?.plans || []).find((p) => p.id === "pro");
  check("P2  unauthenticated response carries no plan data", !pro && (list.json?.plans === undefined), JSON.stringify(list.json).slice(0, 80));
}

// ---- plan change flips entitlements (service level) ----
{
  const before = await P.resolveEntitlements({ userId: uB.id });
  check("P3  default plan is free", before.planId === "free" && before.source === "default", JSON.stringify({ planId: before.planId, source: before.source }));
  await P.setPlanForUser(uB.id, "pro");
  const after = await P.resolveEntitlements({ userId: uB.id });
  check("P4  plan change flips entitlements (free→pro)",
    after.planId === "pro" && after.entitlements.max_concurrent_jobs === 4 && before.entitlements.max_concurrent_jobs === 1,
    `${before.planId}(${before.entitlements.max_concurrent_jobs}) → ${after.planId}(${after.entitlements.max_concurrent_jobs})`);

  await P.setPlanForUser(uB.id, "free");
  const reverted = await P.resolveEntitlements({ userId: uB.id });
  check("P5  plan change back flips again (pro→free)", reverted.planId === "free" && reverted.entitlements.max_concurrent_jobs === 1, reverted.planId);
}

// ---- org-plan-wins ----
{
  await P.setPlanForUser(uA.id, "free");
  await P.setPlanForOrg(orgA.id, "team");
  const personal = await P.resolveEntitlements({ userId: uA.id });
  check("P6  personal resolution uses the user's plan", personal.planId === "free" && personal.source === "user", JSON.stringify({ planId: personal.planId, source: personal.source }));
  const orgScoped = await P.resolveEntitlements({ userId: uA.id, orgId: orgA.id });
  check("P7  org-plan-wins: org member resolves the ORG plan", orgScoped.planId === "team" && orgScoped.source === "org" && orgScoped.entitlements.max_concurrent_jobs === 10, JSON.stringify({ planId: orgScoped.planId, source: orgScoped.source }));
}

// ---- unknown feature denies by default ----
{
  const eff = await P.resolveEntitlements({ userId: uA.id });
  const unknown = P.featureAllowed(eff.entitlements, "quantum_computing");
  check("P8  unknown feature → DENY by default (service)", unknown.allowed === false && /unknown feature/.test(unknown.reason || ""), JSON.stringify(unknown));

  // numeric entitlement enforces its limit: pro allows 4 concurrent jobs, a
  // request for 5 is refused (value gating is the numeric contract)
  await P.setPlanForUser(uA.id, "pro");
  const pro = await P.resolveEntitlements({ userId: uA.id });
  const within = P.featureAllowed(pro.entitlements, "max_concurrent_jobs", 4);
  const over = P.featureAllowed(pro.entitlements, "max_concurrent_jobs", 5);
  check("P9  numeric entitlement enforces the plan limit (4 ok, 5 refused)",
    within.allowed === true && over.allowed === false && over.limit === 4, `within=${within.allowed} over=${JSON.stringify(over)}`);
  await P.setPlanForUser(uA.id, "free");
}

// ---- HTTP surface ----
{
  const r = await api("GET", "/", null, uA.token);
  const ids = (r.json?.plans || []).map((p) => p.id);
  check("P10 GET /plans lists the catalog with all three plans (authed)",
    r.status === 200 && ["free", "pro", "team"].every((x) => ids.includes(x)), `${r.status} ${ids.join(",")}`);
  const pro = (r.json?.plans || []).find((p) => p.id === "pro");
  check("P10b pro carries its documented entitlements", pro?.entitlements?.max_concurrent_jobs === 4 && pro?.entitlements?.github_publish === true, JSON.stringify(pro?.entitlements));

  const unauth = await api("GET", "/", null, null);
  check("P11 unauthenticated catalog → 401", unauth.status === 401, String(unauth.status));

  const eff = await api("GET", "/effective", null, uB.token);
  check("P12 effective route resolves the caller's plan", eff.status === 200 && eff.json?.effective?.planId === "free", JSON.stringify(eff.json?.effective?.planId));

  const orgEff = await api("GET", `/effective?orgId=${orgA.id}`, null, uA.token);
  check("P13 effective with org context resolves org-plan-wins", orgEff.status === 200 && orgEff.json?.effective?.planId === "team" && orgEff.json?.effective?.source === "org", JSON.stringify(orgEff.json?.effective));

  const denied = await api("GET", `/check?feature=quantum_computing`, null, uB.token);
  check("P14 check route denies unknown features (HTTP)", denied.status === 200 && denied.json?.allowed === false, JSON.stringify(denied.json));

  const allowed = await api("GET", `/check?feature=github_publish`, null, uB.token);
  check("P15 check route allows defined features", allowed.status === 200 && allowed.json?.allowed === true, JSON.stringify(allowed.json));

  const badSet = await api("POST", `/users/${uB.id}`, { plan: "gold" }, uA.token);
  // service-level validation of the plan id (the admin guard answers 403
  // first over HTTP for a non-admin — the 400 for unknown ids is exercised
  // through the service contract)
  let svcErr = null;
  try { await P.setPlanForUser(uB.id, "gold"); } catch (e) { svcErr = e; }
  check("P16 unknown plan id → 400 (service validation)", badSet.status === 403 && !!svcErr && svcErr.status === 400, `http=${badSet.status} svc=${svcErr?.status}`);

  const forbidden = await api("POST", `/users/${uB.id}`, { plan: "pro" }, uB.token);
  check("P17 plan mutation by non-admin → 403", forbidden.status === 403, String(forbidden.status));

  const asAdmin = await api("POST", `/users/${uB.id}`, { plan: "pro" }, uA.token);
  // uA is a fresh user (role=user): platform-admin role is required — this
  // asserts the guard holds for regular users (the admin surface covers the
  // happy path in test-admin-surfaces.mjs)
  check("P18 regular user cannot grant plans (403 — the commercial gate is server-side)", asAdmin.status === 403, String(asAdmin.status));
}

// ---- cleanup ----
server.close();
await query("DELETE FROM org_plans WHERE org_id = $1", [orgA.id]);
await query("DELETE FROM user_plans WHERE user_id = ANY($1::uuid[])", [[uA.id, uB.id]]);
await query("DELETE FROM organizations WHERE id = $1", [orgA.id]);
await query("DELETE FROM users WHERE id = ANY($1::uuid[])", [[uA.id, uB.id]]);
await closePool();

const pass = results.filter(Boolean).length;
const fail = results.length - pass;
console.log(`\nRESULT: ${fail ? "FAIL" : "PASS"}  (${pass}/${results.length})`);
process.exit(fail ? 1 : 0);
