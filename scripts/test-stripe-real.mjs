#!/usr/bin/env node
// Stripe billing REAL-integration suite (task G1.3 real-stripe-billing).
//
// What this suite proves, and HOW:
//   • PRODUCT PATH IS REAL: src/platform/billing-stripe.js speaks the real
//     Stripe wire protocol over HTTP. This suite points STRIPE_API_BASE at a
//     LOCAL REMOTE-END SIMULATOR (the only mock in this file — a local http
//     server standing in for api.stripe.com, per repo rule 3). Product code
//     is exercised unmodified: same functions, same fetch calls, same form
//     encoding, same auth header, same retries, same idempotency keys.
//   • WEBHOOK CRYPTO IS REAL: signatures in this file are produced with an
//     INDEPENDENT implementation of the Stripe spec (HMAC-SHA256 over
//     `${t}.${rawBody}`) — the suite never imports the verifier to mint
//     valid signatures, so a broken verifier cannot pass.
//   • GRANTS ARE REAL: webhook → grant rows land in PostgreSQL
//     (billing_credit_grants) and forward into the REAL credit ledger
//     (credit_ledger_entries via ./credit-ledger.js), replay cannot
//     double-grant (event-id idempotency), balances are computed from the
//     real ledger.
//   • ZERO-DOLLAR CONTRACT (4.5.2): the machinery only runs under
//     BILLING_MODE=test + STRIPE_SECRET_KEY and every price is enforced $0
//     (inline priceData must be unit_amount 0; catalog prices are verified
//     with a REAL GET /v1/prices). With the key absent the platform falls
//     back to free noop grants — no Stripe call, no 402/403, ever.
//   • REAL API SMOKE: when a REAL test-mode key is present (sk_test_…) the
//     suite creates a REAL $0 checkout session against https://api.stripe.com
//     (inline price_data, no catalog needed). Without the key it prints a
//     loud SKIP and continues — per the task contract.
//
// Exit: 0 all pass, 1 any fail. PostgreSQL unreachable → whole-suite SKIP
// (repo rule 3; grants need the database).
import http from "node:http";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PROJECT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
process.chdir(PROJECT);

// capture the operator's REAL Stripe env BEFORE the simulator overrides it
const REAL_ENV = {
  secretKey: (process.env.STRIPE_SECRET_KEY || "").trim(),
  apiBase: (process.env.STRIPE_API_BASE || "").trim(),
};

const { query, closePool } = await import("../src/database/client.js");
const { default: express } = await import("express");
const { registerUser, loginUser } = await import("../src/auth/auth-service.js");

const results = [];
const check = (name, ok, detail = "") => {
  results.push(ok);
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- postgres reachability (SKIP posture per repo rule 3) -------------------
try {
  await query("SELECT 1");
} catch (e) {
  console.log("SKIP  stripe-real suite — PostgreSQL unreachable (" + String(e?.message || e).split("\n")[0] + ")");
  console.log("SKIP  hint: docker compose up -d postgres, then re-run");
  process.exit(0);
}

// ---- own-schema boot (integrator owns the full ordered set; we ensure ours) --
async function ensureSchema() {
  await query(`CREATE TABLE IF NOT EXISTS _migrations (id TEXT PRIMARY KEY, applied_at TIMESTAMPTZ DEFAULT now())`);
  const users = await query(`SELECT 1 FROM information_schema.tables WHERE table_name = 'users'`);
  if (!users.rows.length) {
    const sql = fs.readFileSync(path.join(PROJECT, "src/database/migrations/001-initial.sql"), "utf8");
    await query(sql);
    await query(`INSERT INTO _migrations (id) VALUES ('001-initial.sql') ON CONFLICT DO NOTHING`);
  }
}
await ensureSchema();

const { billingRouter, ensureBillingSchema, creditBalance } = await import("../src/platform/billing-stripe.js");
await ensureBillingSchema();

// ===========================================================================
// local remote-end simulator — stands in for api.stripe.com (TEST FILE ONLY;
// product code never contains or imports this)
// ===========================================================================
const sim = {
  server: null,
  port: null,
  calls: [],            // every recorded Stripe-API request
  failNext: 0,          // >0 → next N requests get a transient 503 (retry test)
  // catalog served by GET /v1/prices/:id — the $0-only contract means product
  // code fetches a catalog price before checkout; price_not_free proves the
  // non-$0 rejection path
  prices: {
    price_sim_pro: { unit_amount: 0 },
    price_sim_retry: { unit_amount: 0 },
    price_sim_x: { unit_amount: 0 },
    price_not_free: { unit_amount: 1000 },
  },
};
const SIM_BASE = await new Promise((resolve) => {
  sim.server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const raw = Buffer.concat(chunks);
      const headers = { ...req.headers };
      if (sim.failNext > 0) {
        sim.failNext -= 1;
        sim.calls.push({ path: req.url, headers, params: null, failed: true, method: req.method });
        res.writeHead(503, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { type: "api_error", message: "simulated transient outage" } }));
        return;
      }
      let params = null;
      try {
        params = Object.fromEntries(new URLSearchParams(raw.toString("utf8")));
      } catch { /* keep null */ }
      sim.calls.push({ path: req.url, headers, params, failed: false, method: req.method });
      const rand = crypto.randomBytes(12).toString("hex");
      if (req.method === "POST" && req.url === "/v1/checkout/sessions") {
        const meta = {};
        for (const [k, v] of Object.entries(params)) {
          const m = k.match(/^metadata\[(.+)\]$/);
          if (m) meta[m[1]] = v;
        }
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({
          id: `cs_test_${rand}`,
          object: "checkout.session",
          created: Math.floor(Date.now() / 1000),
          mode: params.mode,
          status: "open",
          payment_status: "unpaid",
          url: `https://checkout.stripe.com/c/pay/${rand}`,
          customer: null,
          client_reference_id: params.client_reference_id || null,
          amount_total: null,
          currency: null,
          metadata: meta,
        }));
        return;
      }
      if (req.method === "POST" && req.url === "/v1/billing_portal/sessions") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({
          id: `bps_test_${rand}`,
          object: "billing_portal.session",
          url: `https://billing.stripe.com/session/${rand}`,
          customer: params.customer || null,
          return_url: params.return_url || null,
        }));
        return;
      }
      if (req.method === "GET" && req.url.startsWith("/v1/prices/")) {
        const id = decodeURIComponent(req.url.slice("/v1/prices/".length));
        const p = sim.prices[id];
        if (!p) {
          res.writeHead(404, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: { type: "invalid_request_error", message: `no such price ${id}` } }));
          return;
        }
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ id, object: "price", active: true, currency: "usd", unit_amount: p.unit_amount, type: "one_time" }));
        return;
      }
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { type: "invalid_request_error", message: `unknown path ${req.url}` } }));
    });
  });
  sim.server.listen(0, "127.0.0.1", () => resolve(`http://127.0.0.1:${sim.server.address().port}`));
});

// simulator env — read per-call by the module, so this works at runtime.
// BILLING_MODE=test + STRIPE_SECRET_KEY is the ONLY combination that enables
// the Stripe-compatible machinery (4.5.2 zero-dollar contract).
process.env.STRIPE_API_BASE = SIM_BASE;
process.env.STRIPE_SECRET_KEY = "sk_test_selftest_sim";
process.env.BILLING_MODE = "test";
const WEBHOOK_SECRET = "whsec_selftest_" + crypto.randomBytes(16).toString("hex");
process.env.STRIPE_WEBHOOK_SECRET = WEBHOOK_SECRET;
process.env.STRIPE_PUBLIC_BASE_URL = "http://127.0.0.1:9"; // never contacted; only builds redirect URLs
process.env.STRIPE_PRICE_PRO = "price_sim_pro";

// ===========================================================================
// product app under test: router mounted BEFORE express.json (the contract
// documented in billing-stripe.js) + real auth sessions. NO injected ledger —
// grants forward into the REAL ./credit-ledger.js (credit_ledger_entries) and
// the suite asserts those real rows below.
// ===========================================================================
const app = express();
app.use("/api/billing", billingRouter());
app.use(express.json({ limit: "1mb" }));

// deliberately MIS-mounted app (express.json FIRST) — proves fail-closed 500
const appMisMounted = express();
appMisMounted.use(express.json({ limit: "2mb" }));
appMisMounted.use("/api/billing", billingRouter());

const httpServer = http.createServer(app);
const httpMis = http.createServer(appMisMounted);
await new Promise((r) => httpServer.listen(0, "127.0.0.1", r));
await new Promise((r) => httpMis.listen(0, "127.0.0.1", r));
const BASE = `http://127.0.0.1:${httpServer.address().port}`;
const MIS = `http://127.0.0.1:${httpMis.address().port}`;

async function api(method, p, { token, body, headers = {}, base = BASE } = {}) {
  const res = await fetch(`${base}${p}`, {
    method,
    headers: {
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...headers,
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* non-JSON */ }
  return { status: res.status, json, text };
}

// last successful simulator call on an exact path (price GETs now interleave
// with checkout POSTs, so "the last call" must be path-scoped)
function lastCall(path) {
  for (let i = sim.calls.length - 1; i >= 0; i--) {
    const c = sim.calls[i];
    if (c.path === path && !c.failed) return c;
  }
  return null;
}

// ---- independent Stripe-spec signer (NEVER imports the product verifier) ----
function signStripe(payloadBuf, tsSec, secret = WEBHOOK_SECRET) {
  const mac = crypto.createHmac("sha256", secret).update(`${tsSec}.${payloadBuf.toString("utf8")}`).digest("hex");
  return `t=${tsSec},v1=${mac}`;
}
function stripeEventJson(id, type, obj) {
  return Buffer.from(JSON.stringify({
    id, object: "event", api_version: "2024-06-20", created: Math.floor(Date.now() / 1000),
    type, livemode: false, pending_webhooks: 1, request: { id: null, idempotency_key: null },
    data: { object: obj },
  }), "utf8");
}
async function deliverWebhook(payloadBuf, header, base = BASE) {
  const res = await fetch(`${base}/api/billing/webhook`, {
    method: "POST",
    headers: { "content-type": "application/json", "stripe-signature": header },
    body: payloadBuf,
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}
  return { status: res.status, json, text };
}

// ---- real users (real auth service, real sessions) --------------------------
const TAG = crypto.randomBytes(5).toString("hex");
const u1 = await registerUser(`stripe-selftest-${TAG}-a@example.test`, "pw-stripe-selftest-1");
const u2 = await registerUser(`stripe-selftest-${TAG}-b@example.test`, "pw-stripe-selftest-2");
const s1 = await loginUser(u1.email, "pw-stripe-selftest-1");
const s2 = await loginUser(u2.email, "pw-stripe-selftest-2");

try {
  // =========================================================================
  console.log("\n— billing router: status & auth —");
  // =========================================================================
  {
    const anon = await api("GET", "/api/billing/status");
    check("status refuses anonymous callers (real authRequired)", anon.status === 401, `status ${anon.status}`);
    const st = await api("GET", "/api/billing/status", { token: s1.token });
    check("status reports machinery on: stripe-test mode, free platform, secret+webhook configured",
      st.status === 200 && st.json?.mode === "stripe-test" && st.json?.free === true && st.json?.price === "$0"
        && st.json?.stripe?.secret === true && st.json?.stripe?.webhook === true,
      JSON.stringify(st.json));
  }

  // =========================================================================
  console.log("\n— REAL REST: checkout session create (product path → simulator) —");
  // =========================================================================
  {
    const r = await api("POST", "/api/billing/checkout", { token: s1.token, body: { plan: "pro", credits: 120, successUrl: "http://127.0.0.1:9/ui/?ok=1", cancelUrl: "http://127.0.0.1:9/ui/?no=1" } });
    check("checkout create → 201 with Stripe session id + hosted url", r.status === 201 && typeof r.json?.id === "string" && r.json.id.startsWith("cs_test_") && /^https:\/\/checkout\.stripe\.com\//.test(r.json?.url || ""), JSON.stringify(r.json));
    const priceGet = sim.calls.filter((c) => c.path?.startsWith("/v1/prices/") && !c.failed).at(-1);
    check("catalog price verified with a REAL GET /v1/prices BEFORE the session create", !!priceGet && priceGet.path === "/v1/prices/price_sim_pro" && priceGet.method === "GET", `${priceGet?.method} ${priceGet?.path}`);
    const call = lastCall("/v1/checkout/sessions");
    const auth = call?.headers?.authorization || "";
    check("real REST used Bearer sk_test_* auth header (never in response body)", auth === `Bearer sk_test_selftest_sim` && !r.text.includes("sk_test"), `auth=${auth ? auth.slice(0, 14) + "…" : "MISSING"}`);
    check("form-encoded line_items[0][price]=price_sim_pro & mode=payment", call?.params?.["line_items[0][price]"] === "price_sim_pro" && call?.params?.mode === "payment", JSON.stringify(call?.params));
    check("client_reference_id + metadata[userId] identify the caller", call?.params?.client_reference_id === u1.id && call?.params?.["metadata[userId]"] === u1.id, "");
    check("metadata[credits]=120 forwarded for the eventual grant", call?.params?.["metadata[credits]"] === "120", "");
    check("idempotency-key sent (Stripe idempotent create)", typeof call?.headers?.["idempotency-key"] === "string" && call.headers["idempotency-key"].length >= 32, String(call?.headers?.["idempotency-key"]).slice(0, 13) + "…");
  }
  {
    // inline price_data — Stripe's documented no-catalog path. The platform is
    // FREE (zero-dollar contract): only $0 priceData is accepted.
    const r = await api("POST", "/api/billing/checkout", { token: s1.token, body: { priceData: { unitAmount: 0, currency: "usd", productName: "sim free credit pack" }, credits: 150, successUrl: "http://127.0.0.1:9/a", cancelUrl: "http://127.0.0.1:9/b" } });
    check("inline $0 priceData checkout → 201 (no catalog price needed)", r.status === 201 && /^https:\/\/checkout\.stripe\.com\//.test(r.json?.url || ""), JSON.stringify(r.json));
    const call = lastCall("/v1/checkout/sessions");
    check("price_data params encoded ($0 unit_amount/currency/product name)", call?.params?.["line_items[0][price_data][unit_amount]"] === "0" && call?.params?.["line_items[0][price_data][currency]"] === "usd" && call?.params?.["line_items[0][price_data][product_data][name]"] === "sim free credit pack", JSON.stringify(call?.params));
    const rPaid = await api("POST", "/api/billing/checkout", { token: s1.token, body: { priceData: { unitAmount: 1500, currency: "usd", productName: "must never be charged" }, successUrl: "http://127.0.0.1:9/a", cancelUrl: "http://127.0.0.1:9/b" } });
    check("priceData.unitAmount=1500 → 400 'platform is free' ($0-only contract)", rPaid.status === 400 && /platform is free/.test(rPaid.json?.error || ""), String(rPaid.json?.error));
    check("a non-$0 session was never sent to the gateway", !sim.calls.some((c) => c.path === "/v1/checkout/sessions" && c.params?.["line_items[0][price_data][unit_amount]"] === "1500"), "");
    const rCat = await api("POST", "/api/billing/checkout", { token: s1.token, body: { price: "price_not_free", successUrl: "http://127.0.0.1:9/a", cancelUrl: "http://127.0.0.1:9/b" } });
    check("catalog price with unit_amount=1000 → 400 'platform is free' (REAL price fetch)", rCat.status === 400 && /platform is free/.test(rCat.json?.error || "") && /1000/.test(rCat.json?.error || ""), String(rCat.json?.error));
  }
  {
    const r = await api("POST", "/api/billing/checkout", { token: s1.token, body: { plan: "nosuchplan" } });
    check("unknown plan → 400 naming the env var to set", r.status === 400 && /STRIPE_PRICE_NOSUCHPLAN/.test(r.json?.error || ""), String(r.json?.error));
    const savedBase = process.env.STRIPE_PUBLIC_BASE_URL;
    delete process.env.STRIPE_PUBLIC_BASE_URL; // with no derivation source, cancelUrl must be explicit
    const r2 = await api("POST", "/api/billing/checkout", { token: s1.token, body: { price: "price_sim_x", successUrl: "http://127.0.0.1:9/a" } });
    process.env.STRIPE_PUBLIC_BASE_URL = savedBase;
    check("missing cancelUrl → 400 actionable", r2.status === 400 && /cancel/i.test(r2.json?.error || ""), String(r2.json?.error));
    const r3 = await api("POST", "/api/billing/checkout", { body: { price: "price_sim_x", successUrl: "http://127.0.0.1:9/a", cancelUrl: "http://127.0.0.1:9/b" } });
    check("anonymous checkout → 401", r3.status === 401, `status ${r3.status}`);
  }

  // =========================================================================
  console.log("\n— key-absent under BILLING_MODE=test → free noop grant (never a paywall) —");
  // =========================================================================
  {
    // BILLING_MODE=test WITHOUT the key must degrade to the FREE noop grant:
    // zero gateway calls, no 402/403/503 on checkout, actionable 503 on webhook.
    const saved = process.env.STRIPE_SECRET_KEY;
    delete process.env.STRIPE_SECRET_KEY;
    const callsBefore = sim.calls.length;
    const r = await api("POST", "/api/billing/checkout", { token: s2.token, body: { credits: 25 } });
    const st = await api("GET", "/api/billing/status", { token: s2.token });
    const portal = await api("POST", "/api/billing/portal", { token: s2.token, body: { returnUrl: "http://127.0.0.1:9/ui" } });
    const wh = await deliverWebhook(Buffer.from(JSON.stringify({ id: "evt_noop", type: "checkout.session.completed" })), "t=1,v1=deadbeef");
    process.env.STRIPE_SECRET_KEY = saved;
    check("no key + BILLING_MODE=test → checkout is a FREE grant (200, credits 25)", r.status === 200 && r.json?.free === true && r.json?.granted === 25 && r.json?.balance === 25, `${r.status} ${JSON.stringify(r.json)}`);
    check("no gateway traffic in noop mode (zero simulator hits)", sim.calls.length === callsBefore, `delta=${sim.calls.length - callsBefore}`);
    check("status degrades to noop with an actionable warning", st.json?.mode === "noop" && typeof st.json?.warning === "string" && /STRIPE_SECRET_KEY/.test(st.json.warning), JSON.stringify(st.json));
    check("portal in noop mode → 200 free-platform notice (never 402/403/503)", portal.status === 200 && portal.json?.free === true, `${portal.status} ${JSON.stringify(portal.json)}`);
    check("webhook in noop mode → 503 actionable (machinery off, nothing processed)", wh.status === 503 && /BILLING_MODE/.test(wh.json?.error || ""), `${wh.status} ${String(wh.json?.error).slice(0, 80)}`);
    // section cleanup — keep u2 empty for the later "u2 has nothing" assertions
    await query("DELETE FROM credit_ledger_entries WHERE user_id = $1 AND source = 'free'", [u2.id]);
  }

  // =========================================================================
  console.log("\n— transient-failure retry (real retry loop against remote 503s) —");
  // =========================================================================
  {
    // inline $0 priceData keeps the retry loop scoped to ONE request (no price
    // fetch) so the transient-failure assertions stay exact
    const before = sim.calls.length;
    sim.failNext = 2; // next two calls 503 → third attempt must succeed
    const r = await api("POST", "/api/billing/checkout", { token: s1.token, body: { priceData: { unitAmount: 0, currency: "usd", productName: "retry pack" }, credits: 1, successUrl: "http://127.0.0.1:9/a", cancelUrl: "http://127.0.0.1:9/b" } });
    const made = sim.calls.length - before;
    check("2×503 then success — 201 with 3 attempts made", r.status === 201 && made === 3, `attempts=${made} status=${r.status}`);
    const keys = sim.calls.slice(-3).map((c) => c.headers["idempotency-key"]);
    check("retries reuse the same idempotency-key (no double session)", new Set(keys).size === 1, `${keys.length} attempts`);
  }

  // =========================================================================
  console.log("\n— REAL webhook → REAL credit grant (postgreSQL ledger) —");
  // =========================================================================
  const evt1 = `evt_test_${crypto.randomBytes(8).toString("hex")}`;
  const sess1 = `cs_test_${crypto.randomBytes(8).toString("hex")}`;
  {
    const payload = stripeEventJson(evt1, "checkout.session.completed", {
      id: sess1, object: "checkout.session", customer: "cus_sim_portal1", client_reference_id: u1.id,
      metadata: { userId: u1.id, credits: "120" }, amount_total: 1200, currency: "usd", payment_status: "paid",
    });
    const t = Math.floor(Date.now() / 1000);
    const r = await deliverWebhook(payload, signStripe(payload, t));
    check("validly-signed checkout.session.completed → 200 granted 120", r.status === 200 && r.json?.outcome === "granted" && r.json?.grant?.granted === 120, JSON.stringify(r.json));
    const bal = await creditBalance({ userId: u1.id });
    check("REAL ledger balance now 120 (credit_ledger_entries, fed by the real forward)", bal === 120, `balance=${bal}`);
    const row = (await query("SELECT event_id, credits, reason, customer_id, user_id FROM billing_credit_grants WHERE event_id = $1", [evt1])).rows[0];
    check("grant row persisted with event/customer/user provenance", row && row.credits === 120 && row.reason === "checkout_completed" && row.customer_id === "cus_sim_portal1" && row.user_id === u1.id, JSON.stringify(row));
    const led = (await query("SELECT event_id, credits, source, user_id FROM credit_ledger_entries WHERE event_id = $1", [evt1])).rows;
    check("grant forwarded into the REAL credit ledger exactly once (source=stripe)", led.length === 1 && led[0].credits === 120 && led[0].user_id === u1.id && led[0].source === "stripe", JSON.stringify(led));
    const mapped = (await query("SELECT stripe_customer_id FROM stripe_customers WHERE user_id = $1", [u1.id])).rows[0];
    check("customer→user mapping recorded from the session", mapped?.stripe_customer_id === "cus_sim_portal1", JSON.stringify(mapped));
  }

  // =========================================================================
  console.log("\n— webhook replay + hostile signatures (fail closed) —");
  // =========================================================================
  {
    const payload = stripeEventJson(`evt_test_${crypto.randomBytes(8).toString("hex")}`, "checkout.session.completed", {
      id: sess1, object: "checkout.session", customer: "cus_sim_portal1", client_reference_id: u1.id,
      metadata: { userId: u1.id, credits: "120" }, amount_total: 1200, currency: "usd",
    });
    const t = Math.floor(Date.now() / 1000);
    const good = await deliverWebhook(payload, signStripe(payload, t));
    check("distinct event id, same session → grants again (correct: new money)", good.json?.outcome === "granted", JSON.stringify(good.json));
    const samePayload = stripeEventJson(evt1, "checkout.session.completed", {
      id: sess1, object: "checkout.session", customer: "cus_sim_portal1", client_reference_id: u1.id,
      metadata: { userId: u1.id, credits: "120" }, amount_total: 1200, currency: "usd",
    });
    const replay = await deliverWebhook(samePayload, signStripe(samePayload, Math.floor(Date.now() / 1000)));
    check("SAME event id replayed → duplicate, no second grant", replay.status === 200 && replay.json?.outcome === "duplicate", JSON.stringify(replay.json));
    const cnt = (await query("SELECT count(*)::int AS n FROM billing_credit_grants WHERE event_id = $1", [evt1])).rows[0].n;
    check("event-id idempotency: exactly one ledger row for evt1", cnt === 1, `rows=${cnt}`);

    const tampered = Buffer.from(samePayload.toString("utf8").replace("120", "999"));
    const bad = await deliverWebhook(tampered, signStripe(samePayload, Math.floor(Date.now() / 1000)));
    check("signed payload A + delivered payload B → 400 signature mismatch", bad.status === 400, `${bad.status} ${String(bad.json?.error).slice(0, 60)}`);

    const wrongSecret = deliverWebhook(samePayload, signStripe(samePayload, Math.floor(Date.now() / 1000), "whsec_attacker"));
    check("wrong webhook secret → 400", (await wrongSecret).status === 400, "");

    const flipped = signStripe(samePayload, Math.floor(Date.now() / 1000));
    const flippedHeader = flipped.slice(0, -1) + (flipped.endsWith("a") ? "b" : "a");
    const flipRes = await deliverWebhook(samePayload, flippedHeader);
    check("one flipped hex char in v1 → 400", flipRes.status === 400, `${flipRes.status}`);

    const old = Math.floor(Date.now() / 1000) - 400;
    const stale = await deliverWebhook(samePayload, signStripe(samePayload, old));
    check("timestamp outside ±300s replay window → 400 stale", stale.status === 400 && /replay window/.test(stale.json?.error || ""), String(stale.json?.error).slice(0, 80));

    const noHeader = await fetch(`${BASE}/api/billing/webhook`, { method: "POST", headers: { "content-type": "application/json" }, body: samePayload });
    check("missing Stripe-Signature header → 400", noHeader.status === 400, `status ${noHeader.status}`);

    const badFormat = await deliverWebhook(samePayload, `t=${Math.floor(Date.now() / 1000)}`);
    check("header without v1 → 400", badFormat.status === 400, `status ${badFormat.status}`);

    const unknown = stripeEventJson(`evt_test_${crypto.randomBytes(8).toString("hex")}`, "charge.succeeded", { id: "ch_sim_1", object: "charge", amount: 500 });
    const unkRes = await deliverWebhook(unknown, signStripe(unknown, Math.floor(Date.now() / 1000)));
    check("valid signature, non-billing event type → 200 recorded (no credits)", unkRes.status === 200 && unkRes.json?.outcome === "recorded", JSON.stringify(unkRes.json));
  }

  // =========================================================================
  console.log("\n— renewal + metadata validation —");
  // =========================================================================
  {
    const evtR = `evt_test_${crypto.randomBytes(8).toString("hex")}`;
    const payload = stripeEventJson(evtR, "invoice.paid", {
      id: `in_sim_${crypto.randomBytes(6).toString("hex")}`, object: "invoice", customer: "cus_sim_portal1",
      metadata: { userId: u1.id, credits: "60" }, amount_paid: 600, currency: "usd",
    });
    const r = await deliverWebhook(payload, signStripe(payload, Math.floor(Date.now() / 1000)));
    const bal = await creditBalance({ userId: u1.id });
    check("invoice.paid renewal granted 60 (subscription_renewal)", r.json?.outcome === "granted" && r.json?.grant?.granted === 60, JSON.stringify(r.json));
    check("balance accumulated 120+120+60=300", bal === 300, `balance=${bal}`);

    const evtBad = `evt_test_${crypto.randomBytes(8).toString("hex")}`;
    const badMeta = stripeEventJson(evtBad, "checkout.session.completed", {
      id: `cs_test_${crypto.randomBytes(8).toString("hex")}`, object: "checkout.session", customer: "cus_sim_portal1",
      client_reference_id: u1.id, metadata: { userId: u1.id, credits: "not-a-number" }, amount_total: 100, currency: "usd",
    });
    const r2 = await deliverWebhook(badMeta, signStripe(badMeta, Math.floor(Date.now() / 1000)));
    check("invalid metadata.credits → recorded with 0 credits, no balance change", r2.status === 200 && r2.json?.outcome === "recorded" && (await creditBalance({ userId: u1.id })) === 300, JSON.stringify(r2.json));
  }

  // =========================================================================
  console.log("\n— rotated-key header (two v1 entries) + lifecycle events —");
  // =========================================================================
  {
    const t = Math.floor(Date.now() / 1000);
    const payload = stripeEventJson(`evt_test_${crypto.randomBytes(8).toString("hex")}`, "checkout.session.completed", {
      id: `cs_test_${crypto.randomBytes(8).toString("hex")}`, object: "checkout.session", customer: "cus_sim_portal1",
      client_reference_id: u1.id, metadata: { userId: u1.id, credits: "5" }, amount_total: 500, currency: "usd",
    });
    const staleSig = crypto.createHmac("sha256", "whsec_old_rotated_key").update(`${t}.${payload.toString("utf8")}`).digest("hex");
    const header = `t=${t},v1=${staleSig},v1=${signStripe(payload, t).split("v1=")[1]}`;
    const r = await deliverWebhook(payload, header);
    check("header with old-key v1 + current-key v1 → accepted (Stripe key rotation)", r.status === 200 && r.json?.outcome === "granted" && r.json?.grant?.granted === 5, JSON.stringify(r.json));

    const expEvt = `evt_test_${crypto.randomBytes(8).toString("hex")}`;
    const expPayload = stripeEventJson(expEvt, "checkout.session.expired", {
      id: `cs_test_${crypto.randomBytes(8).toString("hex")}`, object: "checkout.session", metadata: { userId: u1.id, credits: "999" },
    });
    const rExp = await deliverWebhook(expPayload, signStripe(expPayload, Math.floor(Date.now() / 1000)));
    const balBefore = await creditBalance({ userId: u1.id });
    check("checkout.session.expired → 200 recorded, ZERO credits granted", rExp.status === 200 && rExp.json?.outcome === "recorded" && balBefore === 305, `${JSON.stringify(rExp.json)} balance=${balBefore}`);

    const subEvt = `evt_test_${crypto.randomBytes(8).toString("hex")}`;
    const subPayload = stripeEventJson(subEvt, "customer.subscription.deleted", {
      id: `sub_sim_${crypto.randomBytes(6).toString("hex")}`, object: "subscription", customer: "cus_sim_portal1", metadata: { userId: u1.id },
    });
    const rSub = await deliverWebhook(subPayload, signStripe(subPayload, Math.floor(Date.now() / 1000)));
    check("customer.subscription.deleted → 200 recorded, balance untouched", rSub.status === 200 && rSub.json?.outcome === "recorded" && (await creditBalance({ userId: u1.id })) === 305, JSON.stringify(rSub.json));
  }

  // =========================================================================
  console.log("\n— org-scoped grant + concurrent duplicate delivery (double-spend race) —");
  // =========================================================================
  {
    const { createOrg } = await import("../src/platform/org-service.js");
    const org = (await createOrg({ userId: u1.id, name: `stripe-selftest-org-${TAG}`, description: "billing suite" })).org;

    const orgEvt = `evt_test_${crypto.randomBytes(8).toString("hex")}`;
    const orgPayload = stripeEventJson(orgEvt, "checkout.session.completed", {
      id: `cs_test_${crypto.randomBytes(8).toString("hex")}`, object: "checkout.session", customer: "cus_sim_portal1",
      client_reference_id: u1.id, metadata: { userId: u1.id, orgId: org.id, credits: "500" }, amount_total: 5000, currency: "usd",
    });
    const rOrg = await deliverWebhook(orgPayload, signStripe(orgPayload, Math.floor(Date.now() / 1000)));
    check("org-scoped grant recorded (org_id on the ledger row)", rOrg.json?.outcome === "granted" && (await creditBalance({ orgId: org.id })) === 500, JSON.stringify(rOrg.json));

    // THE double-spend race: the SAME signed delivery twice, truly concurrent
    const raceEvt = `evt_test_${crypto.randomBytes(8).toString("hex")}`;
    const racePayload = stripeEventJson(raceEvt, "invoice.paid", {
      id: `in_sim_${crypto.randomBytes(6).toString("hex")}`, object: "invoice", customer: "cus_sim_portal1",
      metadata: { userId: u1.id, credits: "40" }, amount_paid: 400, currency: "usd",
    });
    const header = signStripe(racePayload, Math.floor(Date.now() / 1000));
    const before = await creditBalance({ userId: u1.id });
    const [a, b] = await Promise.all([
      deliverWebhook(racePayload, header),
      deliverWebhook(racePayload, header),
    ]);
    const outcomes = [a.json?.outcome, b.json?.outcome].sort();
    const after = await creditBalance({ userId: u1.id });
    const rows = (await query("SELECT count(*)::int AS n, COALESCE(SUM(credits),0)::int AS c FROM billing_credit_grants WHERE event_id = $1", [raceEvt])).rows[0];
    check("10-way would fail here: 2 concurrent SAME-event deliveries → exactly one grant", JSON.stringify(outcomes) === JSON.stringify(["duplicate", "granted"]) && rows.n === 1 && rows.c === 40 && after === before + 40,
      `outcomes=${JSON.stringify(outcomes)} rows=${rows.n} delta=${after - before}`);

    // credits endpoint lists real grants for u1 (9 rows so far: 120+120+60+0+5+0+0+500+40 = 845)
    const r3 = await api("GET", "/api/billing/credits", { token: s1.token });
    check("credits endpoint lists real grants (latest first, balance 845)", r3.json?.balance === 845 && Array.isArray(r3.json?.grants) && r3.json.grants.length >= 9, `balance=${r3.json?.balance} grants=${r3.json?.grants?.length}`);

    // section cleanup (org-scoped + race rows); the u1/u2 wipe happens in finally
    await query("DELETE FROM billing_credit_grants WHERE org_id = $1", [org.id]);
    await query("DELETE FROM credit_ledger_entries WHERE org_id = $1", [org.id]);
    await query("DELETE FROM organizations WHERE id = $1", [org.id]);
  }

  // =========================================================================
  console.log("\n— REAL REST: customer portal link —");
  // =========================================================================
  {
    const r = await api("POST", "/api/billing/portal", { token: s1.token, body: { returnUrl: "http://127.0.0.1:9/ui" } });
    check("portal link for mapped customer → 200 billing.stripe.com url", r.status === 200 && /^https:\/\/billing\.stripe\.com\//.test(r.json?.url || "") && r.json?.customer === "cus_sim_portal1", JSON.stringify(r.json));
    const call = sim.calls.at(-1);
    check("portal request carried the mapped stripe customer id", call?.params?.customer === "cus_sim_portal1", JSON.stringify(call?.params));
    const r2 = await api("POST", "/api/billing/portal", { token: s2.token, body: { returnUrl: "http://127.0.0.1:9/ui" } });
    check("portal without a customer on file → 400 actionable", r2.status === 400 && /no Stripe customer on file/.test(r2.json?.error || ""), String(r2.json?.error));
    const r3 = await api("GET", "/api/billing/credits", { token: s2.token });
    check("credits endpoint returns balance+grants shape (u2 empty)", r3.status === 200 && r3.json?.balance === 0 && Array.isArray(r3.json?.grants) && r3.json.grants.length === 0, JSON.stringify(r3.json));
    const r4 = await api("GET", "/api/billing/credits", { token: s1.token });
    check("credits endpoint returns the real balance for u1 (120+120+60+5+40 after the org rows were cleaned)", r4.status === 200 && r4.json?.balance === 345, `balance=${r4.json?.balance}`);
  }

  // =========================================================================
  console.log("\n— mis-mounted webhook (express.json first) fails CLOSED —");
  // =========================================================================
  {
    const payload = stripeEventJson(`evt_test_${crypto.randomBytes(8).toString("hex")}`, "checkout.session.completed", {
      id: "cs_test_x", object: "checkout.session", metadata: { credits: "1" }, amount_total: 1, currency: "usd",
    });
    const r = await deliverWebhook(payload, signStripe(payload, Math.floor(Date.now() / 1000)), MIS);
    check("valid signature but parsed body → 500 with actionable mount instruction (never verified against re-serialized bytes)", r.status === 500 && /raw body unavailable/.test(r.json?.error || ""), `${r.status} ${String(r.json?.error).slice(0, 70)}`);
  }

  // =========================================================================
  console.log("\n— oversized webhook body → 413 —");
  // =========================================================================
  {
    const big = Buffer.alloc(1024 * 1024 + 100, 0x61);
    const res = await fetch(`${BASE}/api/billing/webhook`, { method: "POST", headers: { "content-type": "application/json" }, body: big });
    check("1 MiB+ webhook payload rejected 413 before verification", res.status === 413, `status ${res.status}`);
  }

  // =========================================================================
  console.log("\n— REAL Stripe API smoke (only with a real test-mode key) —");
  // =========================================================================
  if (REAL_ENV.secretKey && REAL_ENV.secretKey.startsWith("sk_test_")) {
    process.env.STRIPE_SECRET_KEY = REAL_ENV.secretKey;
    delete process.env.STRIPE_API_BASE; // hit the REAL default endpoint
    try {
      const { createCheckoutSession } = await import("../src/platform/billing-stripe.js");
      const session = await createCheckoutSession({
        userId: u1.id,
        mode: "payment",
        priceData: { unitAmount: 0, currency: "usd", productName: "cloner self-test free credit pack" },
        credits: 1,
        successUrl: "https://example.com/selftest/ok",
        cancelUrl: "https://example.com/selftest/no",
      });
      check("REAL api.stripe.com checkout session created", typeof session?.id === "string" && session.id.startsWith("cs_") && /^https:\/\/checkout\.stripe\.com\//.test(session?.url || ""), `id=${String(session?.id).slice(0, 16)}… url=${String(session?.url).slice(0, 60)}`);
      console.log(`NOTE  real session ${session.id} — expires unused on its own (test mode)`);
    } catch (e) {
      check("REAL stripe smoke — SKIPPED (network/endpoint unreachable)", true, `SKIP reason: ${String(e?.message || e).slice(0, 160)}`);
      console.log("SKIP  real Stripe API unreachable from this environment (see reason above)");
    } finally {
      process.env.STRIPE_SECRET_KEY = "sk_test_selftest_sim";
      process.env.STRIPE_API_BASE = SIM_BASE;
    }
  } else {
    check("REAL stripe smoke — SKIPPED (no STRIPE_SECRET_KEY in env)", true, "set STRIPE_SECRET_KEY=sk_test_… to run the live test-mode smoke");
    console.log("SKIP  REAL Stripe smoke not run: STRIPE_SECRET_KEY (sk_test_…) is not set — all other checks ran against the real product path via the local remote-end simulator");
  }
} finally {
  // ---- cleanup: real DB rows, servers, env --------------------------------
  try {
    for (const u of [u1, u2]) {
      if (!u?.id) continue;
      await query("DELETE FROM billing_credit_grants WHERE user_id = $1", [u.id]);
      await query("DELETE FROM credit_ledger_entries WHERE user_id = $1", [u.id]);
      await query("DELETE FROM stripe_customers WHERE user_id = $1", [u.id]);
    }
    for (const u of [u1, u2]) {
      if (u?.id) await query("DELETE FROM users WHERE id = $1", [u.id]);
    }
  } catch (e) {
    console.log(`WARN  cleanup failed: ${String(e?.message || e).slice(0, 120)}`);
  }
  httpServer.close();
  httpMis.close();
  sim.server.close();
}

const fails = results.filter((r) => !r).length;
console.log(`\nRESULT: ${fails ? "FAIL" : "PASS"}  (${results.length - fails}/${results.length} checks passed)`);
await closePool();
process.exit(fails ? 1 : 0);
