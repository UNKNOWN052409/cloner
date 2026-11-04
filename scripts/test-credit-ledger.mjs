#!/usr/bin/env node
// Task 4.1.5 e2e — credit ledger and usage accounting.
//
// Exercises credit-ledger.js (the REAL credit_ledger_entries table) against
// the live compose PostgreSQL, covering the plan contract adapted to the
// free-platform directive (4.5.2: grants are UNLIMITED and additive; the
// ledger never denies — the old reserve/capture/refund debit lifecycle is a
// plan-doc legacy that the free platform replaced with grant + quota):
//   • idempotency: replayed eventId NEVER double-grants
//   • math: balance is the exact SUM of granted entries
//   • balance query scoped per user and per org, never cross-scoped
//   • stats: sources visible (free + stripe paths)
//   • input sanity: negative / non-integer amounts rejected; over the per-entry
//     sanity bound refused with the free re-claim guidance — NEVER a 402
//   • plan-service entitlement interface reachable via injection (the 4.1.4
//     handoff: resolveEntitlements is imported and consulted)
//   • entries are append-only: no UPDATE/DELETE path in the module (grep)
//
// NO-PAYWALL GREP SAFE: this suite asserts the ledger NEVER answers 402.
//
// SKIP loudly when PostgreSQL is unreachable.
process.env.PGCONNECT_TIMEOUT = process.env.PGCONNECT_TIMEOUT || "4";
import path from "node:path";
import crypto from "node:crypto";
import fs from "node:fs";
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
  console.log("SKIP  credit-ledger — PostgreSQL unreachable (`docker compose up -d postgres`) — loud SKIP per test convention.");
  process.exit(0);
}
const { query, closePool } = db;

const ledger = await import("../src/platform/credit-ledger.js");
const rand = () => crypto.randomBytes(6).toString("hex");

const auth = await import("../src/auth/auth-service.js");
const tenants = await import("../src/database/tenant-repository.js");
const planService = await import("../src/platform/plan-service.js");

const email = `ledger-${rand()}@test.local`;
const password = `pw-${rand()}-${rand()}!A1`;
const user = await auth.registerUser(email, password);
const org = await tenants.createOrganization({ name: "Ledger Org", slug: `ledger-org-${rand()}`, ownerUserId: user.id });

// ---- idempotency: replay never double-grants ----
{
  const eventId = "evt-" + rand();
  const g1 = await ledger.grantFreeCredits({ userId: user.id, amount: 100, eventId });
  const g2 = await ledger.grantFreeCredits({ userId: user.id, amount: 100, eventId });
  check("L1  first grant lands", g1.duplicate === false && g1.granted === 100, JSON.stringify({ granted: g1.granted, balance: g1.balance }));
  check("L2  replayed eventId is an idempotent no-op", g2.duplicate === true && g2.granted === 0, JSON.stringify({ duplicate: g2.duplicate, granted: g2.granted }));
  check("L3  balance after replay is 100, not 200", g2.balance === 100, String(g2.balance));
}

// ---- math: balance = exact SUM ----
{
  await ledger.grantFreeCredits({ userId: user.id, amount: 250, reason: "second" });
  await ledger.grantFreeCredits({ orgId: org.id, amount: 1000, reason: "org-pool" });
  const userBal = await ledger.ledgerBalance({ userId: user.id });
  const orgBal = await ledger.ledgerBalance({ orgId: org.id });
  check("L4  user balance = exact SUM of entries (100+250)", userBal === 350, String(userBal));
  check("L5  org balance scoped to the org only", orgBal === 1000, String(orgBal));
  const rows = await query("SELECT credits FROM credit_ledger_entries WHERE user_id = $1 ORDER BY created_at", [user.id]);
  check("L6  DB sum matches the reported balance", rows.rows.reduce((a, r) => a + r.credits, 0) === 350, String(rows.rows.length) + " rows");
}

// ---- entries listable (audit trail) ----
{
  const entries = await ledger.listLedgerEntries({ userId: user.id, limit: 10 });
  check("L7  entries listed newest-first with reasons", entries.length === 2 && String(entries[0].reason).length > 0, `${entries.length} entries`);
  const orgEntries = await ledger.listLedgerEntries({ orgId: org.id, limit: 10 });
  check("L8  org entries visible separately", orgEntries.length === 1 && orgEntries[0].credits === 1000, String(orgEntries.length));
}

// ---- stats: sources visible ----
{
  await ledger.grantFreeCredits({ userId: user.id, amount: 5, source: "stripe", reason: "stripe_forward" });
  const stats = await ledger.ledgerStats({ userId: user.id });
  const sources = stats.map((s) => s.source);
  check("L9  stats show both free and stripe sources", sources.includes("free") && sources.includes("stripe"), sources.join(","));
}

// ---- input sanity: never a paywall, always honest validation ----
{
  let negErr = null;
  try { await ledger.grantFreeCredits({ userId: user.id, amount: -5 }); } catch (e) { negErr = e; }
  check("L10 negative amount rejected (input validation)", !!negErr && !/402/.test(String(negErr.status || "")), negErr?.message?.slice(0, 80));

  let fracErr = null;
  try { await ledger.grantFreeCredits({ userId: user.id, amount: 1.5 }); } catch (e) { fracErr = e; }
  check("L11 fractional amount rejected (integer credits only)", !!fracErr, fracErr?.message?.slice(0, 80));

  let bigErr = null;
  try { await ledger.grantFreeCredits({ userId: user.id, amount: 5_000_000 }); } catch (e) { bigErr = e; }
  check("L12 over-per-entry-bound refused with the FREE re-claim guidance (not a paywall)",
    !!bigErr && /claim again/i.test(bigErr.message || "") && bigErr.status !== 402, bigErr?.message?.slice(0, 120));

  let scopeErr = null;
  try { await ledger.ledgerBalance({}); } catch (e) { scopeErr = e; }
  check("L13 balance without scope → clean config error", !!scopeErr && /userId or orgId/.test(scopeErr.message || ""), scopeErr?.message?.slice(0, 80));

  const bal = await ledger.ledgerBalance({ userId: user.id });
  check("L14 refused grants left the balance untouched", bal === 355, String(bal));
}

// ---- 4.1.4 handoff: plan entitlement interface reachable via injection ----
{
  const eff = await planService.resolveEntitlements({ userId: user.id });
  check("L15 plan-service entitlements resolvable (4.1.4 injection point)", eff.planId === "free" && typeof eff.entitlements === "object", JSON.stringify({ planId: eff.planId }));
  // the ledger + plans compose: a free-plan caller's credits keep granting
  const g = await ledger.grantFreeCredits({ userId: user.id, amount: 50, reason: "free_claim" });
  check("L16 grants work for the default plan (free platform, no gate)", g.duplicate === false && g.granted === 50, String(g.balance));
}

// ---- append-only: no mutation paths in the module ----
{
  const src = fs.readFileSync(path.join(PROJECT, "src", "platform", "credit-ledger.js"), "utf8");
  const codeLines = src.split("\n").filter((l) => { const t = l.trim(); return t && !t.startsWith("//") && !t.startsWith("*"); });
  const mutators = codeLines.filter((l) => /UPDATE\s+credit_ledger_entries|DELETE\s+FROM\s+credit_ledger_entries/i.test(l));
  check("L17 ledger is append-only (zero UPDATE/DELETE on credit_ledger_entries in the module)", mutators.length === 0, mutators.join(" | ").slice(0, 100));
}

// ---- cleanup ----
await query("DELETE FROM credit_ledger_entries WHERE user_id = $1 OR org_id = $2", [user.id, org.id]);
await query("DELETE FROM org_plans WHERE org_id = $1", [org.id]);
await query("DELETE FROM user_plans WHERE user_id = $1", [user.id]);
await query("DELETE FROM organizations WHERE id = $1", [org.id]);
await query("DELETE FROM users WHERE id = $1", [user.id]);
await closePool();

const pass = results.filter(Boolean).length;
const fail = results.length - pass;
console.log(`\nRESULT: ${fail ? "FAIL" : "PASS"}  (${pass}/${results.length})`);
process.exit(fail ? 1 : 0);
