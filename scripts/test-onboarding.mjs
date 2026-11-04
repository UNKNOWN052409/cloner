#!/usr/bin/env node
// Task 4.1.1 e2e — product onboarding and account activation.
//
// Boots a real express app with the onboarding router mounted exactly as the
// integrator will (authRequired inside the router), over the REAL PostgreSQL
// (compose instance). Asserts the plan contract:
//   • new user → activation state starts 'pending' with nextStep='profile'
//   • each saved step advances stepsDone and nextStep honestly
//   • workspace step writes workspaceDefaults
//   • complete → 'complete' + activatedAt, idempotent on re-complete
//   • re-activation (saving steps after completion) never regresses state
//   • unknown step → 400; unauthenticated → 401; other user's state invisible
//
// SKIP loudly (exit 0) when PostgreSQL is unreachable — same convention as
// test-tenant-isolation.mjs. Runtime throwaway credentials only.
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
  console.log("SKIP  onboarding — PostgreSQL unreachable (`docker compose up -d postgres`) — loud SKIP per test convention.");
  process.exit(0);
}
const { query, closePool } = db;

// apply only 001 (baseline) + 018 (this task's migration) — the ordered run
// of every migration file is the integrator's boot job
const fs = await import("node:fs");
async function applyOwnMigrations() {
  await query(`CREATE TABLE IF NOT EXISTS _migrations (id TEXT PRIMARY KEY, applied_at TIMESTAMPTZ DEFAULT now())`);
  const dir = path.join(PROJECT, "src", "database", "migrations");
  for (const file of ["001-initial.sql", "018-product-platform.sql"]) {
    const applied = await query("SELECT 1 FROM _migrations WHERE id = $1", [file]);
    if (applied.rows.length) continue;
    await query(fs.readFileSync(path.join(dir, file), "utf8"));
    await query("INSERT INTO _migrations (id) VALUES ($1) ON CONFLICT (id) DO NOTHING", [file]);
    console.log(`[db] applied: ${file}`);
  }
}
await applyOwnMigrations();

const auth = await import("../src/auth/auth-service.js");
const express = (await import("express")).default;
const { onboardingRouter } = await import("../src/platform/onboarding-service.js");

const rand = () => crypto.randomBytes(6).toString("hex");

async function makeUser(prefix) {
  const email = `${prefix}-${rand()}@test.local`;
  const password = `pw-${rand()}-${rand()}!A1`;
  const user = await auth.registerUser(email, password);
  const { token } = await auth.loginUser(email, password);
  return { ...user, token };
}

const app = express();
app.use(express.json({ limit: "32kb" }));
app.use("/api/onboarding", onboardingRouter());
app.use((err, _req, res, _next) => res.status(500).json({ error: String(err?.message || err) }));

const server = app.listen(0, "127.0.0.1");
await new Promise((r) => server.on("listening", r));
const port = server.address().port;
const api = async (method, p, body, token) => {
  const res = await fetch(`http://127.0.0.1:${port}/api/onboarding${p}`, {
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

const uA = await makeUser("onb-a");
const uB = await makeUser("onb-b");

// ---- new user starts pending ----
{
  const r = await api("GET", "/", null, uA.token);
  const ob = r.json?.onboarding;
  check("N1  new user starts activation_status=pending", r.status === 200 && ob?.activationStatus === "pending", JSON.stringify(ob));
  check("N2  nextStep is the first guided step", ob?.nextStep === "profile", ob?.nextStep);
  check("N3  not complete", ob?.complete === false);
}

// ---- unauthenticated ----
{
  const r = await api("GET", "/", null, null);
  check("N4  unauthenticated GET → 401", r.status === 401, String(r.status));
}

// ---- step flow ----
{
  const bad = await api("POST", "/steps/bogus", { payload: {} }, uA.token);
  check("N5  unknown step → 400", bad.status === 400, String(bad.status));

  const p1 = await api("POST", "/steps/profile", { payload: { fullName: "QA User", role: "eng" } }, uA.token);
  const ob1 = p1.json?.onboarding;
  check("N6  profile step saves + advances", p1.status === 200 && ob1?.stepsDone?.includes("profile") && ob1?.nextStep === "workspace", JSON.stringify(ob1?.stepsDone));
  check("N7  activation in_progress after a step", ob1?.activationStatus === "in_progress");

  const w1 = await api("POST", "/steps/workspace", { payload: { theme: "dark", defaultView: "tasks" } }, uA.token);
  const ob2 = w1.json?.onboarding;
  check("N8  workspace defaults persisted", w1.status === 200 && ob2?.workspaceDefaults?.theme === "dark" && ob2?.workspaceDefaults?.defaultView === "tasks", JSON.stringify(ob2?.workspaceDefaults));

  const skip = await api("POST", "/steps/connect", { skip: true }, uA.token);
  check("N9  skip records stepsSkipped + advances", skip.status === 200 && skip.json?.onboarding?.stepsSkipped?.includes("connect"), JSON.stringify(skip.json?.onboarding?.stepsSkipped));

  const done = await api("POST", "/complete", {}, uA.token);
  const ob3 = done.json?.onboarding;
  check("N10 complete → activation_status=complete + activatedAt", done.status === 200 && ob3?.complete === true && !!ob3?.activatedAt, ob3?.activatedAt);
  check("N11 nextStep null after completion", ob3?.nextStep === null);

  // idempotent re-complete
  const again = await api("POST", "/complete", {}, uA.token);
  const ob4 = again.json?.onboarding;
  check("N12 re-activation idempotent (same activatedAt, still complete)",
    again.status === 200 && ob4?.complete === true && ob4?.activatedAt === ob3?.activatedAt, `${ob3?.activatedAt} vs ${ob4?.activatedAt}`);

  // re-save after completion never regresses
  const reSave = await api("POST", "/steps/profile", { payload: { fullName: "Changed Later" } }, uA.token);
  const ob5 = reSave.json?.onboarding;
  check("N13 re-save after completion never regresses state", reSave.status === 200 && ob5?.complete === true && ob5?.activationStatus === "complete", ob5?.activationStatus);
}

// ---- per-user isolation ----
{
  const rA = await api("GET", "/", null, uA.token);
  const rB = await api("GET", "/", null, uB.token);
  const obA = rA.json?.onboarding;
  const obB = rB.json?.onboarding;
  check("N14 B's fresh state untouched by A's flow", obB?.activationStatus === "pending" && (obB?.stepsDone?.length || 0) === 0, JSON.stringify(obB?.stepsDone));
  check("N15 A keeps its own completed state", obA?.complete === true);
  const bSave = await api("POST", "/steps/profile", { payload: { fullName: "User B" } }, uB.token);
  const rA2 = await api("GET", "/", null, uA.token);
  check("N16 B's writes never leak into A's profile",
    bSave.status === 200 && rA2.json?.onboarding?.profile?.fullName !== "User B", JSON.stringify(rA2.json?.onboarding?.profile));
}

// ---- cleanup ----
server.close();
await query("DELETE FROM onboarding_profiles WHERE user_id = ANY($1::uuid[])", [[uA.id, uB.id]]);
await query("DELETE FROM users WHERE id = ANY($1::uuid[])", [[uA.id, uB.id]]);
await closePool();

const pass = results.filter(Boolean).length;
const fail = results.length - pass;
console.log(`\nRESULT: ${fail ? "FAIL" : "PASS"}  (${pass}/${results.length})`);
process.exit(fail ? 1 : 0);
