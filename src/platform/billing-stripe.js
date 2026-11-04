// Stripe-compatible billing — ZERO-DOLLAR rework (task 4.5.2 zero-dollar-billing).
//
// OWNER DIRECTIVE: payment is $0 — the platform is FREE. This module keeps the
// REAL Stripe-compatible REST machinery from G1.3 (checkout sessions, customer
// portal, HMAC-verified webhooks), but it is allowed to run ONLY behind
// BILLING_MODE, and even then every price is $0:
//
//   BILLING_MODE unset/empty (the DEFAULT)   → noop grant. No Stripe call is
//     ever made, even when STRIPE_SECRET_KEY is present. Credits are granted
//     for free directly into the credit ledger (credit-ledger.js).
//   BILLING_MODE=test without STRIPE_SECRET_KEY → still noop grant (free).
//   BILLING_MODE=test WITH STRIPE_SECRET_KEY    → the Stripe-compatible REST
//     machinery is active. ALL prices are enforced $0 (inline priceData must
//     be unit_amount 0; catalog prices are fetched via a REAL GET /v1/prices
//     and rejected unless unit_amount is 0). Checkout completion still grants
//     the credits — payment never blocks anything because nothing costs money.
//   Any other BILLING_MODE value             → fails safe to noop (free) with a
//     warning. There is no paid mode in this platform.
//
// NO MOCKS IN PRODUCT PATHS: every network call in this module goes to a REAL
// Stripe-API-compatible REST endpoint. The endpoint is https://api.stripe.com
// by default; STRIPE_API_BASE may point at any Stripe-API-compatible gateway
// (the test suites point it at a local remote-end SIMULATOR — the simulator
// lives in the test files only, this module never contains one).
//
// NO PAYWALL: no code path in this module returns 402/403 or conditions any
// response on a credit balance. Credits live in credit-ledger.js (unlimited
// free grants); fair-use quotas (quota-middleware.js, 4.0.4) are a separate
// subsystem and are NOT billing.
//
// Webhook crypto is REAL: HMAC-SHA256 over `${t}.${rawBody}` per the Stripe
// spec (timing-safe compare against every v1 entry, replay window enforced,
// raw request bytes required).
//
// INTEGRATOR MOUNT LINE (server.js is integrator-owned — not edited here):
//
//   import { billingRouter } from "./billing-stripe.js";
//   app.use("/api/billing", billingRouter());   // BEFORE express.json
//
//   ROUTES   POST /api/billing/checkout   (authRequired) — stripe-test mode:
//                                          real $0 checkout session; noop mode:
//                                          a FREE credit claim (unlimited)
//            POST /api/billing/portal     (authRequired) — portal link or the
//                                          free-platform notice
//            GET  /api/billing/credits    (authRequired) — ledger balance +
//                                          grants + entries
//            GET  /api/billing/status     (authRequired) — mode + flags
//            POST /api/billing/webhook    (no session auth — the HMAC signature
//                                          IS the authentication; 503 in noop)
//
//   WEBHOOK RAW BODY: POST /api/billing/webhook must receive the RAW request
//   bytes (the signature covers the exact payload). The router parses its own
//   JSON bodies per-route, so the ONLY ordering constraint is that this router
//   must be mounted BEFORE app.use(express.json(...)) — or the webhook route
//   fails closed with HTTP 500 and an actionable message instead of verifying
//   against re-serialized bytes (never accepts under the mis-mounted posture).
//
// Environment (all read per-call, so tests can toggle; .env.example documents):
//   BILLING_MODE             noop gate — unset/empty = noop (default, free);
//                            'test' = allow the Stripe-compatible machinery
//                            (real REST still requires STRIPE_SECRET_KEY; all
//                            prices stay $0); anything else = fails safe noop.
//   STRIPE_SECRET_KEY        machinery key — test-mode keys are sk_test_…
//   STRIPE_WEBHOOK_SECRET    required for webhook verification (whsec_…)
//   STRIPE_API_BASE          optional — Stripe-API-compatible gateway (default real Stripe)
//   STRIPE_PUBLIC_BASE_URL   optional — origin used to build success/cancel URLs
//   STRIPE_SUCCESS_URL       optional — full success redirect (overrides base derivation)
//   STRIPE_CANCEL_URL        optional — full cancel redirect (overrides base derivation)
//   STRIPE_PRICE_<PLAN>      optional — plan name → price id map (plan "pro" → STRIPE_PRICE_PRO)
//   STRIPE_TIMEOUT_MS        optional — per-request timeout (default 15000)
//   STRIPE_WEBHOOK_TOLERANCE_SECONDS  optional — replay window (default 300)
import crypto from "node:crypto";
import express, { Router } from "express";
import { query as dbQuery } from "../database/client.js";
import { authRequired as defaultAuthRequired } from "../auth/auth-middleware.js";
import { grantFreeCredits, ledgerBalance, listLedgerEntries, ensureLedgerSchema, FREE_CLAIM_DEFAULT } from "./credit-ledger.js";

const STRIPE_API_BASE_DEFAULT = "https://api.stripe.com";
const REQUEST_TIMEOUT_MS_DEFAULT = 15_000;
const MAX_WEBHOOK_BYTES = 1024 * 1024;          // Stripe payloads are small; 1 MiB is generous
const RETRYABLE_STATUS = new Set([408, 429, 500, 502, 503, 504]);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_CREDITS = 1_000_000;

// ---------------------------------------------------------------------------
// errors
// ---------------------------------------------------------------------------

export class StripeApiError extends Error {
  constructor(status, type, message, code) {
    super(`stripe ${status} ${type || "api_error"}: ${String(message || "request failed").slice(0, 300)}`);
    this.name = "StripeApiError";
    this.status = status >= 400 && status < 600 ? status : 502;
    this.stripeType = type || null;
    this.stripeCode = code || null;
  }
}

export class WebhookVerifyError extends Error {
  constructor(reason, message) {
    super(message || `webhook signature rejected: ${reason}`);
    this.name = "WebhookVerifyError";
    this.reason = reason; // 'missing_secret' | 'missing_header' | 'bad_header' | 'stale' | 'signature_mismatch' | 'oversized'
    this.status = 400;
  }
}

export class BillingConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = "BillingConfigError";
    this.status = 503; // environment absent → service unavailable, operator-actionable
  }
}

// ---------------------------------------------------------------------------
// configuration (read per call so tests and live rotation can toggle env)
// ---------------------------------------------------------------------------

function readEnv() {
  return {
    secretKey: (process.env.STRIPE_SECRET_KEY || "").trim() || null,
    webhookSecret: (process.env.STRIPE_WEBHOOK_SECRET || "").trim() || null,
    apiBase: (process.env.STRIPE_API_BASE || "").trim() || STRIPE_API_BASE_DEFAULT,
    publicBaseUrl: (process.env.STRIPE_PUBLIC_BASE_URL || "").trim() || null,
    successUrl: (process.env.STRIPE_SUCCESS_URL || "").trim() || null,
    cancelUrl: (process.env.STRIPE_CANCEL_URL || "").trim() || null,
    timeoutMs: positiveInt(process.env.STRIPE_TIMEOUT_MS, REQUEST_TIMEOUT_MS_DEFAULT),
    toleranceSec: positiveInt(process.env.STRIPE_WEBHOOK_TOLERANCE_SECONDS, 300),
  };
}

function positiveInt(raw, fallback) {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

// ---------------------------------------------------------------------------
// BILLING_MODE gate — the zero-dollar contract
// ---------------------------------------------------------------------------

/**
 * Resolve the effective billing mode. Read per call (tests toggle env).
 *   unset/empty/'noop'/'free'/'off' → { mode: "noop", stripeActive: false }
 *   'test' + STRIPE_SECRET_KEY      → { mode: "stripe-test", stripeActive: true }
 *   'test' without the key          → { mode: "noop", stripeActive: false } + warning
 *   anything else                   → { mode: "noop", stripeActive: false } + warning
 *                                     (fail-safe: an unknown mode can never
 *                                     enable paid machinery — and there is no
 *                                     paid machinery in a $0 platform anyway)
 */
export function billingMode() {
  const raw = String(process.env.BILLING_MODE || "").trim().toLowerCase();
  if (raw === "" || raw === "noop" || raw === "free" || raw === "off") {
    return { mode: "noop", stripeActive: false, requested: raw || null };
  }
  if (raw === "test") {
    const { secretKey } = readEnv();
    if (secretKey) return { mode: "stripe-test", stripeActive: true, requested: "test" };
    return {
      mode: "noop", stripeActive: false, requested: "test",
      warning: "BILLING_MODE=test but STRIPE_SECRET_KEY is not set — Stripe-compatible machinery stays off; free (noop) grants apply",
    };
  }
  return {
    mode: "noop", stripeActive: false, requested: raw,
    warning: `BILLING_MODE=${raw} is not a supported mode — failing safe to noop (free) mode`,
  };
}

function requireSecretKey() {
  const { secretKey } = readEnv();
  if (!secretKey) {
    throw new BillingConfigError(
      "Stripe billing is not configured: set STRIPE_SECRET_KEY (test-mode key sk_test_…) in the environment (and BILLING_MODE=test to enable the machinery)"
    );
  }
  return secretKey;
}

function normalizedApiBase() {
  const { apiBase } = readEnv();
  let url;
  try {
    url = new URL(apiBase);
  } catch {
    throw new BillingConfigError(`STRIPE_API_BASE is not a valid URL: ${apiBase.slice(0, 120)}`);
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new BillingConfigError(`STRIPE_API_BASE must be http(s), got ${url.protocol}`);
  }
  if (url.username || url.password) {
    throw new BillingConfigError("STRIPE_API_BASE must not embed credentials");
  }
  return url.origin; // path prefixes like /stripe-v1 are not supported — origin only
}

function priceForPlan(plan) {
  const name = String(plan || "").trim().toUpperCase().replace(/[^A-Z0-9_]/g, "");
  if (!name) return null;
  return (process.env[`STRIPE_PRICE_${name}`] || "").trim() || null;
}

// "sk_test_…" | "rk_test_…" → test; "…live…" → live; anything else unknown.
// Never returns or logs the key itself.
export function keyMode() {
  const key = (process.env.STRIPE_SECRET_KEY || "").trim();
  if (!key) return "unconfigured";
  if (/_test_/.test(key)) return "test";
  if (/_live_/.test(key)) return "live";
  return "unknown";
}

export function stripeConfigured() {
  const env = readEnv();
  return { secret: !!env.secretKey, webhook: !!env.webhookSecret, apiBase: env.apiBase, mode: keyMode() };
}

// ---------------------------------------------------------------------------
// real Stripe REST client (fetch + retry on transient failures)
// ---------------------------------------------------------------------------

function formEncode(params) {
  const body = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === "") continue;
    body.append(key, typeof value === "string" || typeof value === "number" || typeof value === "boolean"
      ? String(value)
      : JSON.stringify(value));
  }
  return body;
}

async function stripeRequest({ method, path, params, secretKey, apiBase, idempotencyKey, timeoutMs }) {
  const body = params ? formEncode(params).toString() : null;
  let lastError = null;
  for (let attempt = 1; attempt <= 3; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(`${apiBase}${path}`, {
        method,
        headers: {
          "authorization": `Bearer ${secretKey}`,
          "content-type": "application/x-www-form-urlencoded",
          ...(idempotencyKey ? { "idempotency-key": idempotencyKey } : {}),
        },
        body,
        signal: controller.signal,
      });
      const text = await res.text();
      let json = null;
      try { json = JSON.parse(text); } catch { /* non-JSON error body */ }
      if (res.ok) return json;
      const retryable = RETRYABLE_STATUS.has(res.status);
      lastError = new StripeApiError(
        res.status,
        json?.error?.type,
        json?.error?.message || text.slice(0, 300),
        json?.error?.code
      );
      if (!retryable || attempt === 3) throw lastError;
      const retryAfter = Number(res.headers?.get?.("retry-after"));
      await sleep(Math.min(Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 300 * 3 ** (attempt - 1), 5000));
    } catch (e) {
      if (e instanceof StripeApiError) throw e; // already classified (incl. final retry)
      lastError = e;
      if (attempt === 3) {
        throw new StripeApiError(502, "network_error", `stripe request failed after 3 attempts: ${String(e?.cause?.message || e?.message || e).slice(0, 200)}`);
      }
      await sleep(300 * 3 ** (attempt - 1));
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastError || new StripeApiError(502, "network_error", "stripe request failed");
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// ---------------------------------------------------------------------------
// $0 price enforcement (the zero-dollar contract, machinery paths only)
// ---------------------------------------------------------------------------

/** REAL GET /v1/prices/:id — a catalog price may only be used when the remote
 *  says it is a $0 price. unit_amount null (tiered etc.) cannot be proven $0
 *  and is rejected: fail closed toward free, never toward a charge. */
async function requireZeroPrice(priceId, { secretKey, apiBase, timeoutMs }) {
  const price = await stripeRequest({
    method: "GET",
    path: `/v1/prices/${encodeURIComponent(String(priceId))}`,
    secretKey,
    apiBase,
    timeoutMs,
  });
  if (price?.unit_amount !== 0) {
    throw badRequest(
      `platform is free — payment is $0: Stripe price ${String(priceId).slice(0, 80)} is not a $0 price (unit_amount=${JSON.stringify(price?.unit_amount ?? null)}); create a $0 price or use inline priceData { unitAmount: 0 }`
    );
  }
  return price;
}

// ---------------------------------------------------------------------------
// checkout session create (REAL POST /v1/checkout/sessions — $0 prices only)
// ---------------------------------------------------------------------------

/**
 * Create a real Stripe Checkout Session at a $0 price.
 * @param {object} opts
 *   userId (required)   — authenticated caller (client_reference_id + metadata)
 *   orgId               — optional org scope, lands in metadata
 *   price               — Stripe price id (price_…) — fetched and verified $0
 *   plan                — alternative: plan name mapped through STRIPE_PRICE_<PLAN>
 *   quantity            — default 1
 *   mode                — "payment" (default) | "subscription"
 *   credits             — credits granted on completion (metadata.credits)
 *   successUrl/cancelUrl— explicit overrides; otherwise derived from public base
 *   customerEmail       — optional customer_email for the session
 *   metadata            — extra metadata merged in
 * @returns the session object ({ id, url, customer, … }) from Stripe
 */
export async function createCheckoutSession(opts = {}) {
  const env = readEnv();
  const secretKey = requireSecretKey();
  const apiBase = normalizedApiBase();
  const { userId, orgId = null, price, plan, quantity = 1, mode = "payment", credits = null, successUrl, cancelUrl, customerEmail, metadata = {}, priceData = null } = opts;
  if (!userId) throw new BillingConfigError("checkout requires an authenticated user");
  if (!["payment", "subscription"].includes(mode)) throw badRequest("mode must be payment|subscription");
  const priceId = price || priceForPlan(plan);
  if (!priceId && !priceData) {
    const planHint = plan && !price ? ` — for plan "${plan}" set STRIPE_PRICE_${String(plan).trim().toUpperCase().replace(/[^A-Z0-9_]/g, "")}` : "";
    throw badRequest(`price required (a $0 Stripe price id, plan mapped via STRIPE_PRICE_<PLAN>${planHint}, or inline priceData { unitAmount: 0, currency, productName })`);
  }
  if (priceData) {
    const unit = Number(priceData.unitAmount);
    if (!Number.isInteger(unit) || unit < 0 || unit > 999_999_999) throw badRequest("priceData.unitAmount must be an integer of the currency's smallest unit (0..999999999)");
    if (unit !== 0) {
      throw badRequest(`platform is free — payment is $0: checkout prices must be unitAmount 0 (zero-dollar-billing), got unitAmount ${unit}`);
    }
    if (!/^[a-z]{3}$/i.test(String(priceData.currency || ""))) throw badRequest("priceData.currency must be a 3-letter ISO code (e.g. usd)");
  }
  if (priceId) {
    // REAL remote verification — a catalog price may only be used when the
    // gateway itself confirms it is a $0 price.
    await requireZeroPrice(priceId, { secretKey, apiBase, timeoutMs: env.timeoutMs });
  }
  const qty = Math.max(1, Math.min(Number(quantity) || 1, 10_000));
  if (credits !== null && (!Number.isInteger(Number(credits)) || Number(credits) < 0 || Number(credits) > MAX_CREDITS)) {
    throw badRequest(`credits must be an integer 0..${MAX_CREDITS}`);
  }
  const success = successUrl || env.successUrl || deriveUrl(env.publicBaseUrl, "success");
  const cancel = cancelUrl || env.cancelUrl || deriveUrl(env.publicBaseUrl, "cancelled");
  if (!success || !cancel) throw badRequest("successUrl/cancelUrl required (or set STRIPE_PUBLIC_BASE_URL / STRIPE_SUCCESS_URL, STRIPE_CANCEL_URL)");
  for (const [label, u] of [["successUrl", success], ["cancelUrl", cancel]]) {
    if (!/^https?:\/\//i.test(u)) throw badRequest(`${label} must be an http(s) URL`);
  }

  const meta = {
    userId: String(userId),
    ...(orgId ? { orgId: String(orgId) } : {}),
    ...(credits !== null && credits !== undefined && Number(credits) > 0 ? { credits: String(Number(credits)) } : {}),
    ...Object.fromEntries(Object.entries(metadata || {}).map(([k, v]) => [k, String(v).slice(0, 480)])),
  };

  return stripeRequest({
    method: "POST",
    path: "/v1/checkout/sessions",
    secretKey,
    apiBase,
    timeoutMs: env.timeoutMs,
    idempotencyKey: crypto.randomUUID(),
    params: {
      mode,
      success_url: success,
      cancel_url: cancel,
      // catalog price (verified $0 above) OR Stripe's documented inline
      // price_data with unit_amount 0 (no catalog needed)
      ...(priceId
        ? { "line_items[0][price]": priceId }
        : {
            "line_items[0][price_data][currency]": String(priceData.currency).toLowerCase(),
            "line_items[0][price_data][unit_amount]": "0",
            "line_items[0][price_data][product_data][name]": String(priceData.productName || "cloner free credits").slice(0, 120),
          }),
      "line_items[0][quantity]": qty,
      client_reference_id: String(userId),
      ...(customerEmail ? { customer_email: String(customerEmail).slice(0, 320) } : {}),
      ...Object.fromEntries(Object.entries(meta).map(([k, v]) => [`metadata[${k}]`, v])),
    },
  });
}

function deriveUrl(publicBaseUrl, outcome) {
  const base = publicBaseUrl || "";
  if (!base) return null;
  return `${base.replace(/\/$/, "")}/ui/?billing=${outcome}`;
}

function badRequest(message) {
  const e = new Error(message);
  e.status = 400;
  return e;
}

// ---------------------------------------------------------------------------
// customer portal link (REAL POST /v1/billing_portal/sessions)
// ---------------------------------------------------------------------------

/**
 * Create a real Stripe Billing Portal session for the user's mapped customer.
 * Requires a customer on file (created when a completed checkout/grant event
 * mapped the Stripe customer to the user). Throws 400 with a clean message
 * when none exists yet.
 */
export async function createCustomerPortalSession({ userId, returnUrl } = {}) {
  const env = readEnv();
  const secretKey = requireSecretKey();
  const apiBase = normalizedApiBase();
  if (!userId) throw new BillingConfigError("portal requires an authenticated user");
  const mapped = await getCustomerMapping(userId);
  if (!mapped) {
    throw badRequest("no Stripe customer on file for this user — complete a checkout first");
  }
  const ret = returnUrl || (env.publicBaseUrl ? deriveUrl(env.publicBaseUrl, "portal") : null);
  if (!ret || !/^https?:\/\//i.test(ret)) throw badRequest("returnUrl required (or set STRIPE_PUBLIC_BASE_URL)");
  const session = await stripeRequest({
    method: "POST",
    path: "/v1/billing_portal/sessions",
    secretKey,
    apiBase,
    timeoutMs: env.timeoutMs,
    idempotencyKey: crypto.randomUUID(),
    params: { customer: mapped.stripeCustomerId, return_url: ret },
  });
  return { id: session?.id || null, url: session?.url || null, customer: mapped.stripeCustomerId };
}

// ---------------------------------------------------------------------------
// webhook signature verification — REAL HMAC per Stripe spec
// https://docs.stripe.com/webhooks#verify-manually
// ---------------------------------------------------------------------------

/**
 * Verify a Stripe webhook signature header against the RAW payload bytes.
 * Throws WebhookVerifyError on any failure. Returns { timestamp, ageSeconds }.
 * @param {Buffer|string} payload  EXACT raw request body (never re-serialized)
 * @param {string} header          Stripe-Signature: t=<ts>,v1=<hex>,v1=<hex>…
 * @param {string} secret          STRIPE_WEBHOOK_SECRET (whsec_…)
 * @param {object} o               { toleranceSeconds=300, now=Date.now() }
 */
export function verifyWebhookSignature(payload, header, secret, o = {}) {
  if (!secret) throw new WebhookVerifyError("missing_secret", "webhook verification unavailable: STRIPE_WEBHOOK_SECRET is not set");
  if (!header || typeof header !== "string") throw new WebhookVerifyError("missing_header", "Stripe-Signature header missing");
  const buf = Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload ?? ""), "utf8");
  if (buf.length > MAX_WEBHOOK_BYTES) throw new WebhookVerifyError("oversized", `webhook payload exceeds ${MAX_WEBHOOK_BYTES} bytes`);

  const parts = {};
  for (const piece of header.split(",")) {
    const idx = piece.indexOf("=");
    if (idx <= 0) throw new WebhookVerifyError("bad_header", "Stripe-Signature header malformed");
    const key = piece.slice(0, idx).trim();
    const val = piece.slice(idx + 1).trim();
    if (key === "v1") (parts.v1 ||= []).push(val);
    else parts[key] = val;
  }
  const timestamp = parts.t;
  const v1 = parts.v1 || [];
  if (!timestamp || !/^\d+$/.test(timestamp) || v1.length === 0) {
    throw new WebhookVerifyError("bad_header", "Stripe-Signature header must contain t=<unix ts> and at least one v1=<hmac hex>");
  }

  const now = o.now ?? Date.now();
  const tolerance = o.toleranceSeconds ?? readEnv().toleranceSec;
  const ageSeconds = Math.abs(now / 1000 - Number(timestamp));
  if (ageSeconds > tolerance) {
    throw new WebhookVerifyError("stale", `webhook timestamp outside ±${tolerance}s replay window (age ${Math.round(ageSeconds)}s)`);
  }

  // signed_payload = `${timestamp}.${payload}` — EXACT raw bytes, per spec.
  const signedPayload = Buffer.concat([Buffer.from(`${timestamp}.`, "utf8"), buf]);
  const expected = crypto.createHmac("sha256", secret).update(signedPayload).digest("hex");
  const expectedBuf = Buffer.from(expected, "hex");
  for (const candidate of v1) {
    if (!/^[0-9a-f]{64}$/i.test(candidate)) continue; // malformed entries can never match
    const candidateBuf = Buffer.from(candidate, "hex");
    // timing-safe compare (same length guaranteed by the hex-64 check above)
    if (candidateBuf.length === expectedBuf.length && crypto.timingSafeEqual(candidateBuf, expectedBuf)) {
      return { timestamp: Number(timestamp), ageSeconds };
    }
  }
  throw new WebhookVerifyError("signature_mismatch", "webhook signature does not match any v1 entry");
}

// ---------------------------------------------------------------------------
// credit ledger (real grants) — idempotent by Stripe event id
// ---------------------------------------------------------------------------

let schemaPromise = null;

/** Idempotent DDL (admin-service.js precedent: in-module CREATE TABLE IF NOT
 *  EXISTS — additive, no migration-number collision). Also ensures the
 *  credit-ledger tables (the balance source of truth). */
export function ensureBillingSchema() {
  if (!schemaPromise) {
    schemaPromise = (async () => {
      await ensureLedgerSchema();
      await dbQuery(`
        CREATE TABLE IF NOT EXISTS billing_credit_grants (
          id BIGSERIAL PRIMARY KEY,
          event_id TEXT UNIQUE,
          event_type TEXT NOT NULL,
          stripe_object_id TEXT,
          customer_id TEXT,
          user_id UUID,
          org_id UUID,
          credits INTEGER NOT NULL DEFAULT 0 CHECK (credits >= 0),
          amount_total BIGINT,
          currency TEXT,
          reason TEXT,
          delivered_to_external BOOLEAN NOT NULL DEFAULT FALSE,
          metadata JSONB,
          created_at TIMESTAMPTZ NOT NULL DEFAULT now()
        )`);
      await dbQuery(`
        CREATE TABLE IF NOT EXISTS stripe_customers (
          user_id UUID PRIMARY KEY,
          stripe_customer_id TEXT NOT NULL,
          created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
        )`);
      await dbQuery(`CREATE INDEX IF NOT EXISTS idx_billing_grants_user ON billing_credit_grants(user_id)`);
      await dbQuery(`CREATE INDEX IF NOT EXISTS idx_billing_grants_org ON billing_credit_grants(org_id)`);
    })().catch((e) => {
      schemaPromise = null; // allow retry on next call
      throw e;
    });
  }
  return schemaPromise;
}

async function getCustomerMapping(userId) {
  const r = await dbQuery("SELECT user_id, stripe_customer_id FROM stripe_customers WHERE user_id = $1", [userId]);
  const row = r.rows[0] || null;
  // normalize to camelCase — every caller reads stripeCustomerId
  return row ? { userId: row.user_id, stripeCustomerId: row.stripe_customer_id } : null;
}

async function upsertCustomerMapping(userId, customerId) {
  if (!userId || !customerId) return;
  await dbQuery(
    `INSERT INTO stripe_customers (user_id, stripe_customer_id) VALUES ($1, $2)
     ON CONFLICT (user_id) DO UPDATE SET stripe_customer_id = EXCLUDED.stripe_customer_id, updated_at = now()`,
    [userId, String(customerId).slice(0, 255)]
  );
}

/**
 * Record a real credit grant from a billing event. Idempotent: a second call
 * with the same eventId inserts nothing and returns { duplicate: true }
 * (replay-safe webhook path). After committing, the grant is forwarded into
 * the credit ledger (credit-ledger.js — the balance source of truth) via
 * registerLedger() or the discovered ./credit-ledger.js sibling module.
 */
export async function grantCredits({ eventId, eventType, objectId = null, customerId = null, userId = null, orgId = null, credits = 0, amountTotal = null, currency = null, reason = "grant", metadata = null }) {
  await ensureBillingSchema();
  const creditAmount = Math.max(0, Math.min(Number(credits) || 0, MAX_CREDITS));
  const r = await dbQuery(
    `INSERT INTO billing_credit_grants
       (event_id, event_type, stripe_object_id, customer_id, user_id, org_id, credits, amount_total, currency, reason, metadata)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
     ON CONFLICT (event_id) DO NOTHING
     RETURNING id, event_id, credits, user_id, org_id, reason, created_at`,
    [
      eventId || null, String(eventType || "unknown"), objectId ? String(objectId).slice(0, 255) : null,
      customerId ? String(customerId).slice(0, 255) : null,
      UUID_RE.test(String(userId || "")) ? userId : null,
      UUID_RE.test(String(orgId || "")) ? orgId : null,
      creditAmount, amountTotal === null ? null : Number(amountTotal),
      currency ? String(currency).slice(0, 16) : null,
      String(reason).slice(0, 120), metadata ? JSON.stringify(metadata) : null,
    ]
  );
  if (!r.rows.length) return { duplicate: true, granted: 0 };
  const row = r.rows[0];
  // only positive-credit grants flow into the credit ledger — 0-credit audit
  // rows (expired sessions, unhandled types) stay internal by design
  const delivered = row.credits > 0
    ? await forwardToExternalLedger({
        userId: row.user_id, orgId: row.org_id, credits: row.credits, reason: `${eventType || "stripe"}:${row.reason}`,
        eventId: row.event_id, source: "stripe", meta: { stripeObjectId: objectId, customerId },
      })
    : false;
  if (delivered) {
    await dbQuery("UPDATE billing_credit_grants SET delivered_to_external = TRUE WHERE id = $1", [row.id]).catch(() => {});
  }
  return { duplicate: false, granted: row.credits, grantId: row.id, deliveredToExternal: !!delivered };
}

/**
 * Balance for the caller's scope — delegated to the credit ledger
 * (credit-ledger.js), the single source of truth for credit balances.
 * Informational only: nothing in the platform gates on this number.
 */
export async function creditBalance({ userId = null, orgId = null } = {}) {
  await ensureBillingSchema();
  return ledgerBalance({ userId, orgId });
}

/** Stripe-event audit rows (billing_credit_grants) — provenance, not balance. */
export async function listGrants({ userId = null, orgId = null, limit = 25 } = {}) {
  await ensureBillingSchema();
  const lim = Math.max(1, Math.min(Number(limit) || 25, 200));
  const where = userId ? "WHERE user_id = $1" : orgId ? "WHERE org_id = $1" : null;
  if (!where) throw badRequest("userId or orgId required");
  const r = await dbQuery(
    `SELECT id, event_id, event_type, stripe_object_id, customer_id, user_id, org_id, credits,
            amount_total, currency, reason, delivered_to_external, created_at
     FROM billing_credit_grants ${where} ORDER BY id DESC LIMIT ${lim}`,
    [userId || orgId]
  );
  return r.rows;
}

// ---- credit ledger forwarding (the credit-ledger wire-in) ------------------
//
// Priority: (1) injected ledger (registerLedger) — the org-routes.js injected
// dependency pattern; (2) the ./credit-ledger.js sibling module (always present
// in this repo) — adapted to the first of grantCredits|grant|addCredits it
// exports. Both are best-effort: a forward failure NEVER un-grants or breaks
// the webhook (delivered_to_external stays false so operators can reconcile).

let injectedLedger = null;
let discoveredLedger; // undefined = not yet attempted, null = attempted and absent

export function registerLedger(ledger) {
  if (ledger && typeof ledger.grant !== "function") {
    throw new Error("registerLedger: injected ledger must expose grant({ userId, orgId, credits, reason, meta })");
  }
  injectedLedger = ledger || null;
}

async function forwardToExternalLedger(grant) {
  let external = injectedLedger;
  if (!external) {
    if (discoveredLedger === undefined) {
      try {
        const mod = await import("./credit-ledger.js");
        const fn = pickExternalGrantFn(mod);
        discoveredLedger = fn ? { grant: (g) => fn.call(mod, g) } : null;
      } catch {
        discoveredLedger = null; // sibling module not present — internal ledger only
      }
    }
    external = discoveredLedger;
  }
  if (!external || typeof external.grant !== "function") return false;
  try {
    await external.grant(grant);
    return true;
  } catch (e) {
    console.warn(`[billing] credit ledger forward failed (grant kept internally): ${String(e?.message || e).slice(0, 200)}`);
    return false;
  }
}

export function pickExternalGrantFn(mod) {
  for (const name of ["grantCredits", "grant", "addCredits", "credit"]) {
    if (typeof mod?.[name] === "function") return mod[name];
  }
  return null;
}

// ---------------------------------------------------------------------------
// webhook event handling → real grants
// ---------------------------------------------------------------------------

const WEBHOOK_EVENT_TYPES = new Set([
  "checkout.session.completed",
  "checkout.session.expired",
  "invoice.paid",
  "customer.subscription.deleted",
]);

/**
 * Verify + process a webhook delivery.
 * @param {Buffer|string} rawBody  EXACT raw request bytes
 * @param {string} signatureHeader Stripe-Signature header value
 * @returns { received: true, eventId, eventType, outcome, grant? } — outcome is
 *   "granted" | "recorded" | "duplicate" | "ignored"
 */
export async function handleWebhookEvent({ rawBody, signatureHeader, now } = {}) {
  const env = readEnv();
  const payloadStr = Buffer.isBuffer(rawBody) ? rawBody.toString("utf8") : String(rawBody ?? "");
  verifyWebhookSignature(rawBody, signatureHeader, env.webhookSecret, now ? { now } : {});
  let event;
  try {
    event = JSON.parse(payloadStr);
  } catch {
    throw badRequest("webhook payload is not valid JSON");
  }
  if (!event || typeof event !== "object" || !event.id || !event.type) throw badRequest("webhook payload missing id/type");

  const eventType = String(event.type);
  const eventId = String(event.id).slice(0, 255);
  if (!WEBHOOK_EVENT_TYPES.has(eventType)) {
    // signature-valid but not a billing event → record delivery (credits 0), 200
    const res = await grantCredits({
      eventId, eventType, objectId: event?.data?.object?.id || null, reason: "unhandled_event_type",
    });
    return { received: true, eventId, eventType, outcome: res.duplicate ? "duplicate" : "recorded" };
  }

  const obj = event?.data?.object || {};
  const meta = obj.metadata || {};
  const userId = obj.client_reference_id || meta.userId || null;
  const orgId = meta.orgId || null;
  const customerId = obj.customer || null;

  if (eventType === "checkout.session.completed" || eventType === "invoice.paid") {
    if (customerId && userId) await upsertCustomerMapping(userId, customerId);
    const rawCredits = meta.credits;
    const credits = Number(rawCredits);
    const validCredits = Number.isInteger(credits) && credits > 0 && credits <= MAX_CREDITS;
    if (!validCredits) {
      const res = await grantCredits({
        eventId, eventType, objectId: obj.id || null, customerId, userId, orgId,
        credits: 0, amountTotal: obj.amount_total ?? obj.amount_paid ?? null, currency: obj.currency || null,
        reason: rawCredits !== undefined && rawCredits !== "" ? "invalid_metadata_credits" : "no_credits_metadata",
        metadata: meta,
      });
      return { received: true, eventId, eventType, outcome: res.duplicate ? "duplicate" : "recorded", grant: res };
    }
    const res = await grantCredits({
      eventId, eventType, objectId: obj.id || null, customerId, userId, orgId,
      credits, amountTotal: obj.amount_total ?? obj.amount_paid ?? null, currency: obj.currency || null,
      reason: eventType === "invoice.paid" ? "subscription_renewal" : "checkout_completed",
      metadata: meta,
    });
    if (res.duplicate) return { received: true, eventId, eventType, outcome: "duplicate" };
    return { received: true, eventId, eventType, outcome: "granted", grant: res };
  }

  // expired / subscription.deleted → audit row, no credit change
  const res = await grantCredits({
    eventId, eventType, objectId: obj.id || null, customerId, userId, orgId,
    credits: 0, reason: eventType === "checkout.session.expired" ? "checkout_expired" : "subscription_ended",
  });
  return { received: true, eventId, eventType, outcome: res.duplicate ? "duplicate" : "recorded" };
}

// ---------------------------------------------------------------------------
// Express router (self-contained body handling — see mount line in header)
// ---------------------------------------------------------------------------

/** Raw-body capture for the webhook route. Fails closed (500 + actionable
 *  message) when a body parser has already consumed the stream. */
export function billingRawBody() {
  return (req, res, next) => {
    if (Buffer.isBuffer(req.body)) return next(); // express.raw ran upstream
    if (req._body === true || req.body !== undefined) {
      const e = new Error(
        "webhook raw body unavailable: a body parser consumed the stream. Mount billingRouter BEFORE app.use(express.json(...)) — signature verification requires the exact raw bytes"
      );
      e.status = 500;
      e.expose = true;
      return next(e);
    }
    const chunks = [];
    let size = 0;
    let done = false;
    req.on("data", (c) => {
      size += c.length;
      if (size > MAX_WEBHOOK_BYTES && !done) {
        done = true;
        res.status(413).json({ error: `webhook payload exceeds ${MAX_WEBHOOK_BYTES} bytes` });
        req.removeAllListeners("data");
        req.resume(); // drain the rest so the 413 response can flush cleanly
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      if (done) return;
      done = true;
      req.body = Buffer.concat(chunks);
      next();
    });
    req.on("error", (e) => { if (!done) { done = true; next(e); } });
  };
}

export function billingRouter({ authRequired = defaultAuthRequired, ledger = null } = {}) {
  if (ledger) registerLedger(ledger);
  const router = Router();
  // per-route JSON parsing (see header: router may be mounted BEFORE the
  // global express.json — body-parser's req._body guard makes a second parse
  // a no-op when mounted after it)
  const jsonSmall = express.json({ limit: "64kb" });
  const wrap = (fn) => (req, res) => {
    Promise.resolve(fn(req, res)).catch((e) => {
      const status = e?.status || (e instanceof WebhookVerifyError ? 400 : e instanceof BillingConfigError ? 503 : 500);
      res.status(status).json({ error: String(e?.message || "internal error").slice(0, 300) });
    });
  };

  router.get("/status", authRequired, wrap(async (_req, res) => {
    const m = billingMode();
    res.json({
      ok: true,
      mode: m.mode,
      free: true,
      price: "$0",
      stripe: stripeConfigured(),
      ledger: { unlimitedFreeGrants: true },
      ...(m.warning ? { warning: m.warning } : {}),
      webhookEventTypes: [...WEBHOOK_EVENT_TYPES],
    });
  }));

  // stripe-test mode → real $0 Stripe checkout session (201);
  // noop mode (DEFAULT) → a FREE credit claim — no remote call, no paywall.
  router.post("/checkout", authRequired, jsonSmall, wrap(async (req, res) => {
    const body = req.body || {};
    if (billingMode().stripeActive) {
      const session = await createCheckoutSession({
        userId: req.userId,
        orgId: body.orgId || req.tenant?.orgId || null,
        price: body.price,
        plan: body.plan,
        priceData: body.priceData,
        quantity: body.quantity,
        mode: body.mode,
        credits: body.credits ?? null,
        successUrl: body.successUrl,
        cancelUrl: body.cancelUrl,
        customerEmail: body.customerEmail,
        metadata: body.metadata,
      });
      res.status(201).json({ id: session?.id || null, url: session?.url || null, mode: session?.mode || null });
      return;
    }
    // NOOP (free) PATH — the zero-dollar default: grant the credits for free.
    const credits = body.credits === undefined || body.credits === null || body.credits === ""
      ? FREE_CLAIM_DEFAULT
      : Number(body.credits);
    const result = await grantFreeCredits({
      userId: req.userId,
      orgId: body.orgId || req.tenant?.orgId || null,
      amount: credits,
      reason: "free_claim",
      source: "free",
      eventId: body.eventId || null,
      meta: { via: "checkout", requested: body.credits ?? null },
    });
    res.status(200).json({
      ok: true,
      mode: "noop",
      free: true,
      price: 0,
      granted: result.granted,
      duplicate: result.duplicate,
      balance: result.balance,
    });
  }));

  router.post("/portal", authRequired, jsonSmall, wrap(async (req, res) => {
    if (!billingMode().stripeActive) {
      // free platform — a portal link would manage payments that do not exist
      res.json({ ok: true, mode: "noop", free: true, portal: null, message: "the platform is free — payment is $0; there is no billing portal" });
      return;
    }
    const out = await createCustomerPortalSession({ userId: req.userId, returnUrl: req.body?.returnUrl });
    res.json({ ok: true, ...out });
  }));

  router.get("/credits", authRequired, wrap(async (req, res) => {
    const m = billingMode();
    const balance = await ledgerBalance({ userId: req.userId });
    const grants = await listGrants({ userId: req.userId, limit: 25 });        // stripe event audit rows
    const entries = await listLedgerEntries({ userId: req.userId, limit: 25 }); // ledger entries behind the balance
    res.json({ ok: true, mode: m.mode, free: true, balance, grants, ledger: entries });
  }));

  // signature IS the authentication here — no authRequired by design.
  // In noop (free) mode the machinery is off: fail closed with an actionable
  // 503 rather than silently accepting deliveries nothing will process.
  router.post("/webhook", billingRawBody(), wrap(async (req, res) => {
    if (!billingMode().stripeActive) {
      res.status(503).json({
        error: "billing is in noop (free) mode — Stripe webhooks are not processed; set BILLING_MODE=test (plus STRIPE_SECRET_KEY) to enable the Stripe-compatible machinery",
      });
      return;
    }
    const signature = req.headers["stripe-signature"];
    const result = await handleWebhookEvent({ rawBody: req.body, signatureHeader: signature });
    res.json(result);
  }));

  // router-level error handler: failures raised inside the router (incl. the
  // raw-body fail-closed error from billingRawBody) become clean JSON with an
  // actionable message — regardless of how the integrator composed the app
  router.use((err, _req, res, _next) => {
    const status = err?.status || (err instanceof WebhookVerifyError ? 400 : err instanceof BillingConfigError ? 503 : 500);
    res.status(status).json({ error: String(err?.message || "internal error").slice(0, 300) });
  });

  return router;
}
