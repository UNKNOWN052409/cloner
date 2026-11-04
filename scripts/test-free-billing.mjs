#!/usr/bin/env node
// Zero-dollar billing suite (task 4.5.2 — src/platform/billing-stripe.js +
// src/platform/credit-ledger.js).
//
// OWNER DIRECTIVE under test: payment is $0 — the platform is FREE.
//
// What this suite proves, and HOW:
//   • NOOP DEFAULT: with BILLING_MODE unset (the shipped default) NO Stripe
//     call is ever made — the suite points STRIPE_API_BASE at a local sentinel
//     server that COUNTS every request, and asserts ZERO hits while credits
//     are claimed. Checkout IS the free-credit claim: unlimited, never denied.
//   • FREE CREDITS FLOW: real user journey — register → login → claim →
//     balance → ledger rows in PostgreSQL (credit_ledger_entries), idempotent
//     by eventId (replays cannot double-grant), org-scoped grants work.
//   • NO PAYWALL GREP: product src/ is scanned for 402/403 PAYMENT emitters
//     and paywall vocabulary on CODE lines (comments stripped). The ONLY file
//     allowed to emit a 402 is quota-middleware.js — the 4.0.4 fair-use QUOTA
//     status map (code QUOTA_EXCEEDED, asserted by scripts/test-quotas.mjs
//     F3/F7) — which is quota enforcement, NOT billing, and stays enforced.
//   • QUOTA DENIAL ≠ BILLING DENIAL (runtime): a REAL quotaGuard with a tight
//     daily cap denies the 3rd job (402, QUOTA_EXCEEDED) while the billing
//     surface keeps granting free credits through the same denial — the
//     quota subsystem never touches the credit ledger and the billing
//     subsystem never emits 402/403 anywhere in this suite.
//   • STRIPE-COMPATIBLE MACHINERY (BILLING_MODE=test + STRIPE_SECRET_KEY):
//     REAL REST against a local remote-end SIMULATOR (the only mock in this
//     file — a local http server standing in for api.stripe.com, per repo
//     rule 3). $0-only is enforced on the wire: inline priceData must be
//     unit_amount 0 and catalog prices are verified with a REAL GET
//     /v1/prices before a session is created.
//   • GATE MATRIX: test-without-key → free noop; unsupported modes ("live",
//     garbage) → fail-safe free noop; key-present-but-mode-unset → STILL
//     free noop (the noop default wins over key presence).
//
// Exit: 0 all pass, 1 any fail. PostgreSQL unreachable → whole-suite SKIP
// (repo rule 3; the ledger needs the database).
import http from "node:http";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PROJECT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
process.chdir(PROJECT);

const results = [];
const check = (name, ok, detail = "") => {
  results.push(ok);
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
};

// ---- postgres reachability (SKIP posture per repo rule 3) -------------------
let db;
try {
  db = await import("../src/database/client.js");
  await db.query("SELECT 1");
} catch (e) {
  console.log(`SKIP  free-billing suite — PostgreSQL unreachable (${String(e?.message || e).split("\n")[0]})`);
  console.log("SKIP  hint: docker compose up -d postgres, then re-run");
  process.exit(0);
}
const { query, closePool } = db;

// ---- own-schema boot (integrator owns the full ordered set; we ensure ours) --
async function ensureSchema() {
  await query(`CREATE TABLE IF NOT EXISTS _migrations (id TEXT PRIMARY KEY, applied_at TIMESTAMPTZ DEFAULT now())`);
  const users = await query(`SELECT 1 FROM information_schema.tables WHERE table_name = 'users'`);
  if (!users.rows.length) {
    const sql = fs.readFileSync(path.join(PROJECT, "src/database/migrations/001-initial.sql"), "utf8");
    await query(sql);
    await query(`INSERT INTO _migrations (id) VALUES ('001-initial.sql') ON CONFLICT DO NOTHING`);
  }
  // quota tables (4.0.4) — idempotent, same posture as scripts/test-quotas.mjs
  const quotaSql = fs.readFileSync(path.join(PROJECT, "src/database/migrations/012-quotas.sql"), "utf8");
  await query(quotaSql);
}
await ensureSchema();

const billing = await import("../src/platform/billing-stripe.js");
const ledger = await import("../src/platform/credit-ledger.js");
const { billingRouter, ensureBillingSchema } = billing;
await ensureBillingSchema();
const { default: express } = await import("express");
const { registerUser, loginUser } = await import("../src/auth/auth-service.js");
const Q = await import("../src/platform/quota-service.js");
const mw = await import("../src/platform/quota-middleware.js");
const { authRequired } = await import("../src/auth/auth-middleware.js");

// ===========================================================================
// local remote-end SIMULATOR + SENTINEL — one local http server standing in
// for api.stripe.com (TEST FILE ONLY; product code never contains this). It
// counts EVERY request: in noop sections the hit count must not move.
// ===========================================================================
const sim = {
  server: null,
  hits: [],   // every request (method, path) — the noop-mode tripwire
  prices: {
    price_free_ok: { unit_amount: 0 },
    price_not_free: { unit_amount: 2500 },
  },
};
const SIM_BASE = await new Promise((resolve) => {
  sim.server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      sim.hits.push({ method: req.method, path: req.url, auth: req.headers.authorization || null, idem: req.headers["idempotency-key"] || null });
      const rand = crypto.randomBytes(10).toString("hex");
      let params = {};
      try { params = Object.fromEntries(new URLSearchParams(raw)); } catch { /* GET */ }
      if (req.method === "POST" && req.url === "/v1/checkout/sessions") {
        const meta = {};
        for (const [k, v] of Object.entries(params)) {
          const m = k.match(/^metadata\[(.+)]$/);
          if (m) meta[m[1]] = v;
        }
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({
          id: `cs_test_${rand}`, object: "checkout.session", created: Math.floor(Date.now() / 1000),
          mode: params.mode, status: "open", payment_status: "unpaid",
          url: `https://checkout.stripe.com/c/pay/${rand}`, customer: null,
          client_reference_id: params.client_reference_id || null, amount_total: 0, currency: "usd", metadata: meta,
        }));
        return;
      }
      if (req.method === "POST" && req.url === "/v1/billing_portal/sessions") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ id: `bps_${rand}`, object: "billing_portal.session", url: `https://billing.stripe.com/session/${rand}`, customer: params.customer || null }));
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

// ===========================================================================
// product app under test: billingRouter mounted BEFORE express.json (the
// contract documented in billing-stripe.js) + a REAL quotaGuard route.
// NO injected ledger — stripe grants forward into the REAL ./credit-ledger.js.
// ===========================================================================
const app = express();
app.use("/api/billing", billingRouter());
app.use(express.json({ limit: "1mb" }));
app.post("/api/freeqa/jobs", authRequired, mw.quotaGuard(), (_req, res) => res.json({ ok: true, gotHere: true }));

const httpServer = http.createServer(app);
await new Promise((r) => httpServer.listen(0, "127.0.0.1", r));
const BASE = `http://127.0.0.1:${httpServer.address().port}`;

// every billing response is tallied — the suite asserts at the end that the
// billing surface NEVER answered 402/403 (no paywall anywhere)
const billingStatuses = [];

async function api(method, p, { token, body, headers = {} } = {}) {
  const res = await fetch(`${BASE}${p}`, {
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
  if (p.startsWith("/api/billing")) billingStatuses.push({ path: p, status: res.status });
  return { status: res.status, json, text };
}

// ---- independent Stripe-spec signer (NEVER imports the product verifier) ----
let WEBHOOK_SECRET = "";
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
async function deliverWebhook(payloadBuf, header) {
  const res = await fetch(`${BASE}/api/billing/webhook`, {
    method: "POST",
    headers: { "content-type": "application/json", "stripe-signature": header },
    body: payloadBuf,
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}
  billingStatuses.push({ path: "/api/billing/webhook", status: res.status });
  return { status: res.status, json, text };
}

// ---- env helpers (the module reads env per call, so runtime toggles work) ----
const ENV_KEYS = ["BILLING_MODE", "STRIPE_SECRET_KEY", "STRIPE_WEBHOOK_SECRET", "STRIPE_API_BASE", "STRIPE_PUBLIC_BASE_URL"];
const ENV_SAVED = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
function setEnv(patch) {
  for (const k of ENV_KEYS) {
    if (patch[k] === undefined) delete process.env[k];
    else process.env[k] = patch[k];
  }
}

// ---- real users -------------------------------------------------------------
const TAG = "freebilling" + crypto.randomBytes(4).toString("hex");
const uA = await registerUser(`${TAG}-a@example.test`, "pw-free-1"); // section A user
const uB = await registerUser(`${TAG}-b@example.test`, "pw-free-2"); // section B user
const uD = await registerUser(`${TAG}-d@example.test`, "pw-free-4"); // section D (quota) user
const uE = await registerUser(`${TAG}-e@example.test`, "pw-free-5"); // section E (machinery) user
const sA = await loginUser(uA.email, "pw-free-1");
const sB = await loginUser(uB.email, "pw-free-2");
const sD = await loginUser(uD.email, "pw-free-4");
const sE = await loginUser(uE.email, "pw-free-5");

// section D quota scaffolding (real 4.0.4 quota service)
const userScopeD = { scope_type: "user", scope_id: uD.id };
await Q.setQuotaLimit(userScopeD, "max_concurrent_jobs", 5);
await Q.setQuotaLimit(userScopeD, "max_queued_jobs", null);
await Q.setQuotaLimit(userScopeD, "max_jobs_per_day", 2);      // the tight cap
await Q.setQuotaLimit(userScopeD, "max_artifact_bytes", null);
await Q.setQuotaLimit(userScopeD, "max_exploration_minutes_per_day", null);

try {
  // =========================================================================
  console.log("\n— A. noop default: no BILLING_MODE, no key → free grants, ZERO gateway calls —");
  // =========================================================================
  {
    setEnv({}); // scrub everything billing-related: the shipped default posture
    const m = billing.billingMode();
    check("billingMode(): unset env → noop, machinery off", m.mode === "noop" && m.stripeActive === false && m.requested === null, JSON.stringify(m));

    const st = await api("GET", "/api/billing/status", { token: sA.token });
    check("status: free platform, $0, machinery off, secret unconfigured",
      st.status === 200 && st.json?.mode === "noop" && st.json?.free === true && st.json?.price === "$0" && st.json?.stripe?.secret === false && !st.json?.warning,
      JSON.stringify(st.json));

    const hitsBefore = sim.hits.length;
    const r1 = await api("POST", "/api/billing/checkout", { token: sA.token, body: { credits: 250 } });
    check("claim 250 credits → 200 FREE (granted, no Stripe session url)", r1.status === 200 && r1.json?.free === true && r1.json?.granted === 250 && r1.json?.balance === 250 && r1.json?.id === undefined, JSON.stringify(r1.json));
    check("ZERO gateway calls for the free claim (sentinel untouched)", sim.hits.length === hitsBefore, `hits=${sim.hits.length - hitsBefore}`);

    const r2 = await api("POST", "/api/billing/checkout", { token: sA.token, body: {} });
    check("claim with no amount → default free grant (100)", r2.status === 200 && r2.json?.granted === 100 && r2.json?.balance === 350, JSON.stringify(r2.json));

    let allOk = true;
    for (let i = 0; i < 5; i++) {
      const r = await api("POST", "/api/billing/checkout", { token: sA.token, body: { credits: 10 } });
      if (!(r.status === 200 && r.json?.granted === 10)) allOk = false;
    }
    check("UNLIMITED free grants: 5 more claims all succeed (never denied)", allOk && (await ledger.ledgerBalance({ userId: uA.id })) === 400, `balance=${await ledger.ledgerBalance({ userId: uA.id })}`);
    check("still ZERO gateway calls after 7 claims", sim.hits.length === hitsBefore, `hits=${sim.hits.length - hitsBefore}`);

    const cr = await api("GET", "/api/billing/credits", { token: sA.token });
    check("credits endpoint: real ledger balance + entries (all source=free)",
      cr.status === 200 && cr.json?.balance === 400 && Array.isArray(cr.json?.ledger) && cr.json.ledger.length === 7 && cr.json.ledger.every((e) => e.source === "free"),
      `balance=${cr.json?.balance} entries=${cr.json?.ledger?.length}`);

    const row = (await query("SELECT source, reason, credits FROM credit_ledger_entries WHERE user_id = $1 ORDER BY id LIMIT 1", [uA.id])).rows[0];
    check("ledger row persisted with free provenance", row?.source === "free" && row?.reason === "free_claim", JSON.stringify(row));

    const portal = await api("POST", "/api/billing/portal", { token: sA.token, body: { returnUrl: "http://127.0.0.1:9/ui" } });
    check("portal in free mode → 200 notice (never 402/403/503)", portal.status === 200 && portal.json?.free === true && /free/.test(portal.json?.message || ""), `${portal.status} ${JSON.stringify(portal.json)}`);

    const entriesBefore = (await query("SELECT count(*)::int AS n FROM credit_ledger_entries WHERE user_id = $1", [uA.id])).rows[0].n;
    const wh = await deliverWebhook(Buffer.from(JSON.stringify({ id: "evt_noop_probe", type: "checkout.session.completed", data: { object: { metadata: { credits: "999" } } } })), "t=1,v1=deadbeef");
    const entriesAfter = (await query("SELECT count(*)::int AS n FROM credit_ledger_entries WHERE user_id = $1", [uA.id])).rows[0].n;
    check("webhook in noop mode → 503 actionable, NOTHING processed (no grant, no row)", wh.status === 503 && /BILLING_MODE/.test(wh.json?.error || "") && entriesAfter === entriesBefore, `${wh.status} rows ${entriesBefore}→${entriesAfter}`);

    const huge = await api("POST", "/api/billing/checkout", { token: sA.token, body: { credits: 2_000_000 } });
    const balAfterHuge = await ledger.ledgerBalance({ userId: uA.id });
    check("per-entry sanity limit (2M) → 400 input validation naming the free re-claim path — never 402, balance untouched",
      huge.status === 400 && /platform is free|per-entry/i.test(huge.json?.error || "") && balAfterHuge === 400, `${huge.status} ${String(huge.json?.error).slice(0, 100)} balance=${balAfterHuge}`);
    check("still ZERO gateway calls across the whole noop section", sim.hits.length === hitsBefore, `hits=${sim.hits.length - hitsBefore}`);
  }

  // =========================================================================
  console.log("\n— B. free credits flow end-to-end (real user journey + idempotency) —");
  // =========================================================================
  {
    setEnv({});
    const st = await api("GET", "/api/billing/status", { token: sB.token });
    check("fresh user sees the free platform on status", st.status === 200 && st.json?.free === true, "");

    const r = await api("POST", "/api/billing/checkout", { token: sB.token, body: { credits: 500 } });
    check("journey: register → login → claim 500 → granted", r.status === 200 && r.json?.granted === 500 && r.json?.balance === 500, JSON.stringify(r.json));

    const cr = await api("GET", "/api/billing/credits", { token: sB.token });
    check("journey: GET /credits returns the balance from the real table", cr.status === 200 && cr.json?.balance === 500 && cr.json?.ledger?.length === 1, JSON.stringify({ balance: cr.json?.balance, n: cr.json?.ledger?.length }));

    // programmatic idempotency: the same eventId can never double-grant
    const g1 = await ledger.grantFreeCredits({ userId: uB.id, amount: 40, reason: "integration_test", eventId: `${TAG}-evt-fixed-1` });
    const g2 = await ledger.grantFreeCredits({ userId: uB.id, amount: 40, reason: "integration_test", eventId: `${TAG}-evt-fixed-1` });
    check("grantFreeCredits idempotent: replayed eventId → duplicate, no double grant", g1.duplicate === false && g1.granted === 40 && g2.duplicate === true && g2.granted === 0 && g2.balance === 540, `g1=${JSON.stringify(g1)} g2=${JSON.stringify(g2)}`);

    // the billing-stripe forward contract lands in the same ledger (org scope)
    const { createOrg } = await import("../src/platform/org-service.js");
    const org = (await createOrg({ userId: uB.id, name: `${TAG} org`, description: "free billing suite" })).org;
    const fwd = await ledger.grant({ orgId: org.id, credits: 300, reason: "checkout.session.completed:checkout_completed", eventId: `${TAG}-evt-org-1`, source: "stripe" });
    check("billing forward contract (grant()) lands in the ledger with org scope", fwd.duplicate === false && fwd.granted === 300 && (await ledger.ledgerBalance({ orgId: org.id })) === 300, JSON.stringify(fwd));

    const stats = await ledger.ledgerStats(); // global: org-scoped rows carry no user_id
    check("ledgerStats: free + stripe sources both visible", stats.some((s) => s.source === "free") && stats.some((s) => s.source === "stripe"), JSON.stringify(stats));

    await query("DELETE FROM credit_ledger_entries WHERE org_id = $1", [org.id]);
    await query("DELETE FROM organizations WHERE id = $1", [org.id]);
  }

  // =========================================================================
  console.log("\n— C. no-paywall grep: product src has no 402/403 credit gate —");
  // =========================================================================
  {
    const srcRoot = path.join(PROJECT, "src");
    const files = [];
    (function walk(dir) {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) walk(p);
        else if (e.name.endsWith(".js")) files.push(p);
      }
    })(srcRoot);

    // strip comment-only lines: comments can never deny a request
    const codeLines = (file) => fs.readFileSync(file, "utf8").split("\n")
      .filter((l) => { const t = l.trim(); return t !== "" && !t.startsWith("//") && !t.startsWith("*") && !t.startsWith("/*"); });

    const PAYWALL_WORDS = /(insufficient\s+credits?|out\s+of\s+credits?|buy\s+credits?|purchase\s+credits?|payment\s+required|upgrade\s+your\s+plan|credit\s+balance\s+too\s+low)/i;

    const code402 = [];   // [file, lineNo, text]
    const paywallHits = [];
    for (const f of files) {
      codeLines(f).forEach((l, i) => {
        if (/\b402\b/.test(l)) code402.push([path.relative(PROJECT, f), i + 1, l.trim().slice(0, 100)]);
        if (PAYWALL_WORDS.test(l)) paywallHits.push([path.relative(PROJECT, f), i + 1, l.trim().slice(0, 100)]);
      });
    }
    const rel = (f) => path.relative(PROJECT, f);
    const mine402 = code402.filter(([f]) => f === rel(path.join(srcRoot, "platform", "billing-stripe.js")) || f === rel(path.join(srcRoot, "platform", "credit-ledger.js")));
    check("billing-stripe.js + credit-ledger.js contain ZERO 402 code lines", mine402.length === 0, JSON.stringify(mine402));

    // the ONLY product file allowed to emit 402 is the 4.0.4 QUOTA status map —
    // quota enforcement stays, it is NOT billing (code QUOTA_EXCEEDED, and
    // scripts/test-quotas.mjs F3/F7 pin the mapping).
    const other402 = code402.filter(([f]) => f !== rel(path.join(srcRoot, "platform", "quota-middleware.js")));
    check("the ONLY 402-emitting product file is quota-middleware.js (fair-use QUOTA status, not billing)",
      other402.length === 0,
      other402.length ? `UNEXPECTED: ${JSON.stringify(other402)}` : `allowed: ${JSON.stringify(code402.filter(([f]) => f === rel(path.join(srcRoot, "platform", "quota-middleware.js"))))}`);

    check("zero paywall vocabulary on code lines anywhere in product src", paywallHits.length === 0, paywallHits.length ? JSON.stringify(paywallHits) : "clean");

    const qm = fs.readFileSync(path.join(srcRoot, "platform", "quota-middleware.js"), "utf8");
    check("quota 402 is the QUOTA subsystem (QUOTA_EXCEEDED code + reason field, no payment vocabulary)",
      /QUOTA_EXCEEDED/.test(qm) && /reason:\s*err\.reason/.test(qm) && !/credit|billing|subscription/i.test(qm), "");
  }

  // =========================================================================
  console.log("\n— D. quota denial ≠ billing denial (real quotaGuard, real billing) —");
  // =========================================================================
  {
    setEnv({}); // free mode while quotas are enforced
    const ledgerRowsBefore = (await query("SELECT count(*)::int AS n FROM credit_ledger_entries WHERE user_id = $1", [uD.id])).rows[0].n;

    const post = async () => api("POST", "/api/freeqa/jobs", { token: sD.token, body: {} });
    const r1 = await post();
    const r2 = await post();
    const r3 = await post();
    check("quota: 2 jobs pass the perDay=2 cap", r1.status === 200 && r2.status === 200, `${r1.status},${r2.status}`);
    check("quota: 3rd job DENIED by the real quotaGuard (402, QUOTA_EXCEEDED, daily_job_limit)",
      r3.status === 402 && r3.json?.code === "QUOTA_EXCEEDED" && r3.json?.reason === "daily_job_limit",
      `${r3.status} ${JSON.stringify(r3.json)}`);
    const bodyStr = JSON.stringify(r3.json);
    check("quota denial carries NO billing vocabulary (no credit/pay/billing fields)",
      !/credit|billing|"pay/i.test(bodyStr), bodyStr.slice(0, 140));
    const ledgerRowsAfterDenial = (await query("SELECT count(*)::int AS n FROM credit_ledger_entries WHERE user_id = $1", [uD.id])).rows[0].n;
    check("quota denial never touched the credit ledger", ledgerRowsAfterDenial === ledgerRowsBefore && ledgerRowsBefore === 0, `rows=${ledgerRowsAfterDenial}`);

    const claim = await api("POST", "/api/billing/checkout", { token: sD.token, body: { credits: 77 } });
    check("billing stays FREE through the quota denial: claim succeeds while quota-blocked",
      claim.status === 200 && claim.json?.granted === 77, `${claim.status} ${JSON.stringify(claim.json)}`);
    const usage = await Q.getUsage(userScopeD);
    check("quota enforcement intact after the billing call (jobsStartedToday=2, not 3)",
      usage.jobsStartedToday === 2, JSON.stringify({ started: usage.jobsStartedToday, limit: usage.limits?.max_jobs_per_day }));
  }

  // =========================================================================
  console.log("\n— E. BILLING_MODE=test + key → REAL Stripe-compatible REST, $0 enforced —");
  // =========================================================================
  {
    WEBHOOK_SECRET = "whsec_freebilling_" + crypto.randomBytes(16).toString("hex");
    setEnv({ BILLING_MODE: "test", STRIPE_SECRET_KEY: "sk_test_freebilling_sim", STRIPE_WEBHOOK_SECRET: WEBHOOK_SECRET, STRIPE_API_BASE: SIM_BASE, STRIPE_PUBLIC_BASE_URL: "http://127.0.0.1:9" });
    const m = billing.billingMode();
    check("billingMode(): test + key → machinery active", m.mode === "stripe-test" && m.stripeActive === true, JSON.stringify(m));
    const st = await api("GET", "/api/billing/status", { token: sE.token });
    check("status: stripe-test mode, still a free platform", st.json?.mode === "stripe-test" && st.json?.free === true && st.json?.price === "$0", JSON.stringify(st.json));

    const hitsBefore = sim.hits.length;
    const r = await api("POST", "/api/billing/checkout", { token: sE.token, body: { priceData: { unitAmount: 0, currency: "usd", productName: "free pack" }, credits: 75, successUrl: "http://127.0.0.1:9/ok", cancelUrl: "http://127.0.0.1:9/no" } });
    check("$0 inline checkout → 201 real gateway session", r.status === 201 && /^cs_test_/.test(r.json?.id || "") && /^https:\/\/checkout\.stripe\.com\//.test(r.json?.url || ""), JSON.stringify(r.json));
    const post = sim.hits.filter((h) => h.path === "/v1/checkout/sessions").at(-1);
    check("REAL REST hit the gateway with Bearer auth + idempotency-key + unit_amount 0",
      post?.auth === "Bearer sk_test_freebilling_sim" && typeof post?.idem === "string" && post.idem.length >= 32,
      JSON.stringify({ auth: post?.auth?.slice(0, 14) + "…", idem: !!post?.idem }));

    const rPaid = await api("POST", "/api/billing/checkout", { token: sE.token, body: { priceData: { unitAmount: 999, currency: "usd", productName: "never" }, successUrl: "http://127.0.0.1:9/ok", cancelUrl: "http://127.0.0.1:9/no" } });
    const hitsAfterPaid = sim.hits.length;
    check("non-$0 inline price → 400 'platform is free' (rejected locally, gateway never contacted)",
      rPaid.status === 400 && /platform is free/.test(rPaid.json?.error || "") && hitsAfterPaid === hitsBefore + 1,
      `${rPaid.status} gateway hits=${hitsAfterPaid - hitsBefore}`);

    const rCat = await api("POST", "/api/billing/checkout", { token: sE.token, body: { price: "price_free_ok", successUrl: "http://127.0.0.1:9/ok", cancelUrl: "http://127.0.0.1:9/no" } });
    const priceGet = sim.hits.filter((h) => h.path === "/v1/prices/price_free_ok").at(-1);
    check("$0 catalog price → 201, verified by a REAL GET /v1/prices first", rCat.status === 201 && !!priceGet && priceGet.method === "GET", `${rCat.status} get=${!!priceGet}`);

    const rCatPaid = await api("POST", "/api/billing/checkout", { token: sE.token, body: { price: "price_not_free", successUrl: "http://127.0.0.1:9/ok", cancelUrl: "http://127.0.0.1:9/no" } });
    check("catalog price unit_amount=2500 → 400 'platform is free' (gateway-verified)", rCatPaid.status === 400 && /platform is free/.test(rCatPaid.json?.error || "") && /2500/.test(rCatPaid.json?.error || ""), String(rCatPaid.json?.error).slice(0, 110));

    // REAL webhook → REAL grant → REAL forward into the credit ledger
    const evt = `evt_freebilling_${crypto.randomBytes(8).toString("hex")}`;
    const payload = stripeEventJson(evt, "checkout.session.completed", {
      id: `cs_freebilling_${crypto.randomBytes(8).toString("hex")}`, object: "checkout.session", customer: `cus_${TAG}`,
      client_reference_id: uE.id, metadata: { userId: uE.id, credits: "75" }, amount_total: 0, currency: "usd",
    });
    const t = Math.floor(Date.now() / 1000);
    const wh = await deliverWebhook(payload, signStripe(payload, t));
    check("validly-signed webhook (independent HMAC) → granted 75", wh.status === 200 && wh.json?.outcome === "granted" && wh.json?.grant?.granted === 75, JSON.stringify(wh.json));
    const grow = (await query("SELECT event_id, credits, source, user_id FROM credit_ledger_entries WHERE event_id = $1", [evt])).rows;
    const growBilling = (await query("SELECT delivered_to_external FROM billing_credit_grants WHERE event_id = $1", [evt])).rows[0];
    check("grant landed in the REAL credit ledger via the stripe forward (source=stripe, delivered)",
      grow.length === 1 && grow[0].credits === 75 && grow[0].source === "stripe" && grow[0].user_id === uE.id && growBilling?.delivered_to_external === true, JSON.stringify({ grow, delivered: growBilling?.delivered_to_external }));
    const replay = await deliverWebhook(payload, signStripe(payload, Math.floor(Date.now() / 1000)));
    const growAfter = (await query("SELECT count(*)::int AS n FROM credit_ledger_entries WHERE event_id = $1", [evt])).rows[0].n;
    check("webhook replay → duplicate, exactly one ledger row (no double grant)", replay.json?.outcome === "duplicate" && growAfter === 1, `${replay.json?.outcome} rows=${growAfter}`);

    const bad = await deliverWebhook(payload, signStripe(payload, t, "whsec_attacker"));
    check("wrong webhook secret → 400 (signature IS the authentication)", bad.status === 400, `${bad.status}`);
  }

  // =========================================================================
  console.log("\n— F. gate matrix: only test+key enables machinery; everything else is free noop —");
  // =========================================================================
  {
    // test WITHOUT key
    setEnv({ BILLING_MODE: "test", STRIPE_API_BASE: SIM_BASE });
    let hits = sim.hits.length;
    let r = await api("POST", "/api/billing/checkout", { token: sE.token, body: { credits: 5 } });
    check("test mode WITHOUT key → free grant (200), zero gateway calls", r.status === 200 && r.json?.free === true && r.json?.granted === 5 && sim.hits.length === hits, `${r.status} hits=${sim.hits.length - hits}`);

    // unsupported mode with a key present → fail-safe noop
    setEnv({ BILLING_MODE: "live", STRIPE_SECRET_KEY: "sk_test_freebilling_sim", STRIPE_API_BASE: SIM_BASE });
    hits = sim.hits.length;
    const st = await api("GET", "/api/billing/status", { token: sE.token });
    r = await api("POST", "/api/billing/checkout", { token: sE.token, body: { credits: 6 } });
    check("BILLING_MODE=live (unsupported) + key → fail-safe free noop with warning, zero gateway calls",
      st.json?.mode === "noop" && /not a supported mode/.test(st.json?.warning || "") && r.status === 200 && r.json?.granted === 6 && sim.hits.length === hits,
      `${st.json?.mode} hits=${sim.hits.length - hits}`);

    // key present but mode unset → the NOOP DEFAULT wins (noop default proof)
    setEnv({ STRIPE_SECRET_KEY: "sk_test_freebilling_sim", STRIPE_API_BASE: SIM_BASE });
    hits = sim.hits.length;
    const m = billing.billingMode();
    r = await api("POST", "/api/billing/checkout", { token: sE.token, body: { credits: 7 } });
    check("key set but BILLING_MODE unset → STILL free noop, zero gateway calls (noop default wins)",
      m.mode === "noop" && m.stripeActive === false && r.status === 200 && r.json?.granted === 7 && sim.hits.length === hits,
      `${m.mode} hits=${sim.hits.length - hits}`);

    // explicit noop synonym
    setEnv({ BILLING_MODE: "noop", STRIPE_SECRET_KEY: "sk_test_freebilling_sim" });
    const m2 = billing.billingMode();
    check("BILLING_MODE=noop explicit → noop", m2.mode === "noop" && m2.stripeActive === false, JSON.stringify(m2));
  }
} finally {
  // ---- cleanup: real DB rows, servers, env --------------------------------
  setEnv(ENV_SAVED);
  try {
    const users = [uA, uB, uD, uE].filter((u) => u?.id);
    for (const u of users) {
      const id = u.id; // registerUser returns the full user object
      await query("DELETE FROM credit_ledger_entries WHERE user_id = $1", [id]);
      await query("DELETE FROM billing_credit_grants WHERE user_id = $1", [id]);
      await query("DELETE FROM stripe_customers WHERE user_id = $1", [id]);
      await query("DELETE FROM quota_usage_events WHERE scope_id = $1", [id]);
      await query("DELETE FROM quota_usage_daily WHERE scope_id = $1", [id]);
      await query("DELETE FROM quota_reservations WHERE scope_id = $1", [id]);
      await query("DELETE FROM quota_limits WHERE scope_id = $1", [id]);
    }
    await query("DELETE FROM org_members WHERE user_id IN (SELECT id FROM users WHERE email LIKE $1)", [`${TAG}-%`]);
    await query("DELETE FROM organizations WHERE slug LIKE $1 OR name LIKE $2", [`${TAG}-%`, `${TAG}% org`]);
    await query("DELETE FROM users WHERE email LIKE $1", [`${TAG}-%`]);
  } catch (e) {
    console.log(`WARN  cleanup failed: ${String(e?.message || e).slice(0, 140)}`);
  }
  httpServer.close();
  sim.server.close();
}

// ---- the suite-wide no-paywall runtime assertion ----------------------------
const paywallResponses = billingStatuses.filter((s) => s.status === 402 || s.status === 403);
check("RUNTIME: every billing response in this suite was never 402/403 (no paywall anywhere)",
  paywallResponses.length === 0,
  paywallResponses.length ? JSON.stringify(paywallResponses) : `${billingStatuses.length} billing responses, all clean`);

const fails = results.filter((r) => !r).length;
console.log(`\nRESULT: ${fails ? "FAIL" : "PASS"}  (${results.length - fails}/${results.length} checks passed)`);
await closePool();
process.exit(fails ? 1 : 0);
