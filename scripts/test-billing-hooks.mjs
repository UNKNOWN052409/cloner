#!/usr/bin/env node
// Task 4.1.6 e2e — billing provider abstraction and billing hooks.
//
// Exercises billing-hooks.js: the provider CONTRACT (createCheckout /
// handleWebhook / verifySignature), the mock provider (the documented
// TEST-ONLY remote-end simulator — real HMAC signing), and the webhook →
// credit-grant flow through the INJECTED ledger (the real credit-ledger.js
// against the live PostgreSQL):
//   • contract validation: a provider missing a method is rejected
//   • webhook with a VALID signature → grant lands in the real ledger
//   • webhook with a BAD signature → rejected, nothing granted
//   • REPLAY of the same provider eventId → duplicate:true, never double-grant
//   • unhandled event type → refused cleanly
//   • no provider configured → 503 BILLING_PROVIDER_NOT_CONFIGURED (product default)
//   • ledger not wired → 503 (injected dependency missing)
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
  console.log("SKIP  billing-hooks — PostgreSQL unreachable (`docker compose up -d postgres`) — loud SKIP per test convention.");
  process.exit(0);
}
const { query, closePool } = db;

const H = await import("../src/platform/billing-hooks.js");
const ledger = await import("../src/platform/credit-ledger.js");
const express = (await import("express")).default;
const auth = await import("../src/auth/auth-service.js");
const rand = () => crypto.randomBytes(6).toString("hex");

const email = `bhooks-${rand()}@test.local`;
const password = `pw-${rand()}-${rand()}!A1`;
const user = await auth.registerUser(email, password);

const app = express();
app.use("/api/billing-hooks", H.billingHooksRouter({ ledger }));
const server = app.listen(0, "127.0.0.1");
await new Promise((r) => server.on("listening", r));
const port = server.address().port;
const post = async (rawBody, sig) => {
  const res = await fetch(`http://127.0.0.1:${port}/api/billing-hooks/webhook`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(sig ? { "x-billing-signature": sig } : {}) },
    body: rawBody,
  });
  return { status: res.status, json: await res.json().catch(() => null) };
};

const bal0 = await ledger.ledgerBalance({ userId: user.id });

// ---- contract validation ----
{
  let err = null;
  try { H.createBillingProviderContract({ createCheckout: () => {} }); } catch (e) { err = e; }
  check("B1  provider missing methods rejected by the contract check", !!err && /missing required methods/.test(err.message) && /handleWebhook/.test(err.message), err?.message?.slice(0, 80));

  check("B2  product default: NO provider configured", H.activeBillingProvider() === null, String(H.activeBillingProvider()));
  const none = await H.handleBillingWebhook({ rawBody: Buffer.from("{}"), signatureHeader: "v1=x", ledger });
  check("B3  webhook without a provider → 503 BILLING_PROVIDER_NOT_CONFIGURED", none.status === 503 && none.error === "BILLING_PROVIDER_NOT_CONFIGURED", JSON.stringify({ status: none.status, error: none.error }));
}

// ---- mock provider (test-only remote-end) + real flow ----
const mock = new H.MockBillingProvider({});
H.registerBillingProvider(mock);
{
  // the provider event carries the grant subject (the Stripe `metadata`
  // equivalent: { userId } rides the signed payload — a real provider would
  // put the customer→user mapping there)
  const evt = mock.enqueueProviderEvent({ type: "credits.granted", credits: 200, userId: user.id });
  const r = await post(evt.body, evt.signature);
  check("B4  valid signature → handled + granted", r.status === 200 && r.json?.handled === true && r.json?.granted === 200, JSON.stringify(r.json));
  const bal = await ledger.ledgerBalance({ userId: user.id });
  check("B5  grant landed in the REAL ledger", bal === bal0 + 200, `${bal0} → ${bal}`);

  // bad signature
  const evt2 = mock.enqueueProviderEvent({ type: "credits.granted", credits: 999, signatureGood: false });
  const r2 = await post(evt2.body, evt2.signature);
  check("B6  forged signature → rejected (400), nothing granted", r2.status === 400 && r2.json?.granted === 0 && /signature/.test(r2.json?.error || ""), JSON.stringify(r2.json));
  check("B7  ledger untouched by the forgery", (await ledger.ledgerBalance({ userId: user.id })) === bal0 + 200, String(await ledger.ledgerBalance({ userId: user.id })));

  // replay: same eventId again
  const evt3 = mock.enqueueProviderEvent({ type: "credits.granted", credits: 200, eventId: JSON.parse(evt.body).id, userId: user.id });
  const r3 = await post(evt3.body, evt3.signature);
  check("B8  replayed eventId → duplicate:true (idempotent)", r3.status === 200 && r3.json?.duplicate === true && r3.json?.granted === 0, JSON.stringify(r3.json));
  check("B9  replay never double-grants", (await ledger.ledgerBalance({ userId: user.id })) === bal0 + 200, String(await ledger.ledgerBalance({ userId: user.id })));

  // unhandled event type
  const evt4 = mock.enqueueProviderEvent({ type: "invoice.paid", credits: 10 });
  const r4 = await post(evt4.body, evt4.signature);
  check("B10 unhandled event type refused cleanly", r4.status === 400 && /unhandled event type/.test(r4.json?.error || ""), JSON.stringify(r4.json));

  // missing signature header
  const evt5 = mock.enqueueProviderEvent({ type: "credits.granted", credits: 5 });
  const r5 = await post(evt5.body, null);
  check("B11 missing signature header → rejected", r5.status === 400, String(r5.status));
}

// ---- ledger not wired ----
{
  const evt = mock.enqueueProviderEvent({ type: "credits.granted", credits: 50, userId: user.id });
  const r = await H.handleBillingWebhook({ rawBody: Buffer.from(evt.body), signatureHeader: evt.signature, ledger: null });
  check("B12 ledger not wired → 503 (injected dependency missing)", r.status === 503 && /ledger/.test(r.error || ""), JSON.stringify({ status: r.status, error: r.error }));
}

// ---- checkout path exists on the provider interface ----
{
  const co = await mock.createCheckout({ userId: user.id, credits: 10 });
  check("B13 createCheckout returns a real checkout record (interface exercised)", !!co?.url && co?.userId === user.id, co?.url);
}

// ---- cleanup ----
H.clearBillingProvider();
// Await the server close and drop the webhook POSTs' keep-alive sockets
// BEFORE process.exit: on Windows an exit while the handle is mid-close trips
// the libuv assertion in src\win\async.c (exit code 0xC0000409 / 3221226505)
// even though every check passed. closeIdleConnections() ends the fetch
// keep-alive sockets so closeAllConnections/close can finish deterministically.
await new Promise((resolve) => {
  server.closeIdleConnections?.();
  server.close(() => resolve());
  server.closeAllConnections?.();
  setTimeout(resolve, 2000).unref(); // never hang the suite on a stuck socket
});
await query("DELETE FROM credit_ledger_entries WHERE user_id = $1", [user.id]);
await query("DELETE FROM users WHERE id = $1", [user.id]);
await closePool();

const pass = results.filter(Boolean).length;
const fail = results.length - pass;
console.log(`\nRESULT: ${fail ? "FAIL" : "PASS"}  (${pass}/${results.length})`);
process.exit(fail ? 1 : 0);
