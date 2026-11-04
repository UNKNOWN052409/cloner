// Billing provider ABSTRACTION + billing hooks (task 4.1.6).
//
// The contract (interface only — no payment provider in this module):
//   createCheckout({ amountCredits, userId, orgId, successUrl, cancelUrl })
//   handleWebhook({ rawBody, signatureHeader })  → typed event | { ignored: true }
//   verifySignature(rawBody, signatureHeader, secret) → boolean
//
// The product path wires this abstraction to the ZERO-DOLLAR Stripe-compatible
// REST machinery in billing-stripe.js (4.5.2). THIS module carries the seam:
// registerBillingProvider() stores the active provider, billingHooks() maps
// verified provider events → credit grants via the INJECTED ledger, with
// idempotency (eventId replay never double-grants) and signature rejection.
//
// MockBillingProvider lives HERE deliberately: it is the documented
// remote-end simulator for tests (a scripted stand-in, same interface), and
// the product default is 'none' — with no registered provider every webhook
// is rejected with BILLING_PROVIDER_NOT_CONFIGURED. No mock ever sits in a
// product code path; billing-stripe.js is the real 4.5.2 product integration.
//
// Surface:
//   createBillingProviderContract(provider)  → validates the interface shape
//   registerBillingProvider(provider) / activeBillingProvider()
//   MockBillingProvider (test seam)
//   handleBillingWebhook({ rawBody, signatureHeader, ledger })
//                                    → { handled, granted, duplicate, error }
//   billingHooksRouter({ ledger })   — INTEGRATOR MOUNT LINE:
//       import { billingHooksRouter } from "./billing-hooks.js";
//       app.use("/api/billing-hooks", billingHooksRouter());
import crypto from "node:crypto";
import { Router } from "express";

let active = null;

export function createBillingProviderContract(provider) {
  const missing = ["createCheckout", "handleWebhook", "verifySignature"]
    .filter((k) => typeof provider?.[k] !== "function");
  if (missing.length) {
    const e = new Error(`billing provider is missing required methods: ${missing.join(", ")}`);
    e.status = 500;
    throw e;
  }
  return provider;
}

export function registerBillingProvider(provider) {
  active = createBillingProviderContract(provider);
  return active;
}

export function activeBillingProvider() {
  return active;
}

export function clearBillingProvider() {
  active = null;
}

// ── MockBillingProvider — TEST-ONLY remote-end simulator ────────────────────
// Scripted event queue: tests enqueueProviderEvent({ type, credits, eventId,
// signatureGood }) then drive POST /webhook with the raw body + signature the
// provider WOULD have produced. HMAC signing is REAL (sha256 HMAC over the raw
// bytes with the shared secret) so verifySignature exercises the real path.
export class MockBillingProvider {
  constructor({ secret = "whsec_mock-" + crypto.randomBytes(12).toString("hex") } = {}) {
    this.name = "mock";
    this.secret = secret;
    this.events = [];
    this.checkouts = [];
  }
  sign(rawBody) {
    return "v1=" + crypto.createHmac("sha256", this.secret).update(rawBody).digest("hex");
  }
  enqueueProviderEvent({ type = "credits.granted", credits = 100, eventId = null, signatureGood = true, userId = null, orgId = null }) {
    const body = JSON.stringify({
      id: eventId || "evt_" + crypto.randomBytes(10).toString("hex"),
      type,
      credits,
      userId,
      orgId,
    });
    this.events.push({ body, signature: signatureGood ? this.sign(body) : "v1=deadbeef" });
    return this.events[this.events.length - 1];
  }
  async createCheckout(opts) {
    const rec = { ...opts, url: "https://billing.example.test/checkout/" + crypto.randomBytes(6).toString("hex"), at: new Date().toISOString() };
    this.checkouts.push(rec);
    return rec;
  }
  async handleWebhook({ rawBody, signatureHeader }) {
    if (!this.verifySignature(rawBody, signatureHeader)) return { ignored: true, reason: "bad_signature" };
    const evt = JSON.parse(rawBody.toString("utf8"));
    // the grant subject rides the signed payload (Stripe `metadata` equivalent)
    return { type: evt.type, credits: evt.credits, eventId: evt.id, userId: evt.userId || null, orgId: evt.orgId || null };
  }
  verifySignature(rawBody, signatureHeader) {
    return typeof signatureHeader === "string" && signatureHeader.startsWith("v1=") &&
      timingSafeEq(signatureHeader, this.sign(rawBody));
  }
}

function timingSafeEq(a, b) {
  const ab = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

// ── hooks: provider event → credit grant via the injected ledger ───────────
// ledger contract (the 4.1.5 injection point; real default is credit-ledger.js):
//   grant({ userId, orgId, credits, reason, source, eventId, meta })
//     → { granted, duplicate, ... } — idempotent per eventId.
export async function handleBillingWebhook({ rawBody, signatureHeader, ledger, userId = null, orgId = null }) {
  const provider = activeBillingProvider();
  if (!provider) {
    return { handled: false, granted: 0, error: "BILLING_PROVIDER_NOT_CONFIGURED", status: 503 };
  }
  if (!provider.verifySignature(rawBody, signatureHeader)) {
    return { handled: false, granted: 0, error: "invalid signature", status: 400 };
  }
  let evt;
  try {
    evt = await provider.handleWebhook({ rawBody, signatureHeader });
  } catch (e) {
    return { handled: false, granted: 0, error: String(e?.message || e).slice(0, 160), status: 400 };
  }
  if (!evt || evt.ignored) return { handled: false, granted: 0, error: evt?.reason || "ignored", status: 400 };
  if (evt.type !== "credits.granted") return { handled: false, granted: 0, error: `unhandled event type ${evt.type}`, status: 400 };
  if (!evt.credits || !Number.isInteger(Number(evt.credits)) || Number(evt.credits) <= 0) {
    return { handled: false, granted: 0, error: "event carries no positive credits", status: 400 };
  }
  if (!ledger || typeof ledger.grant !== "function") {
    return { handled: false, granted: 0, error: "credit ledger not wired (injected dependency missing)", status: 503 };
  }
  const grant = await ledger.grant({
    userId: userId || evt.userId || null,
    orgId: orgId || evt.orgId || null,
    credits: Number(evt.credits),
    reason: "billing_" + String(evt.type).slice(0, 60),
    source: "stripe",
    eventId: evt.eventId,            // idempotency: provider event id = ledger key
    meta: { provider: provider.name || "unknown" },
  });
  return { handled: true, granted: grant.granted, duplicate: !!grant.duplicate, eventId: evt.eventId, status: 200 };
}

export function billingHooksRouter({ ledger } = {}) {
  const router = Router();
  // raw body — the signature covers exact bytes; parse per-route
  router.post("/webhook", (req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", async () => {
      const raw = Buffer.concat(chunks);
      try {
        const out = await handleBillingWebhook({ rawBody: raw, signatureHeader: req.headers["x-billing-signature"], ledger });
        res.status(out.status).json(out);
      } catch (e) {
        res.status(500).json({ handled: false, error: String(e?.message || e).slice(0, 160) });
      }
    });
    req.on("error", () => res.status(400).json({ handled: false, error: "request stream error" }));
  });
  return router;
}
