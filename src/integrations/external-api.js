// External API surface (task 4.2.14): HMAC-signed webhooks OUT.
//
// The platform's extension surface toward third parties is outbound webhook
// delivery: when lifecycle events fire, signed deliveries POST to subscriber
// endpoints configured via ENVIRONMENT (never hardcoded, never in code):
//
//   CLONER_WEBHOOK_<NAME>_URL      https://receiver.example/hooks/cloner
//   CLONER_WEBHOOK_<NAME>_SECRET   shared HMAC secret (≥ 16 chars advised)
//   CLONER_WEBHOOK_<NAME>_EVENTS   optional comma list, e.g. task.completed,task.failed
//                                  (absent = all events)
//
// NO-MOCKS mandate: deliverWebhook() always calls the REAL configured HTTP(S)
// endpoint. When no target is configured the caller gets a typed
// WebhookNotConfiguredError naming the env vars to set — there is no fake
// success, no silent drop. Tests may point the env at a local receiver that
// simulates the REMOTE side; that simulator lives in the test file only.
//
// Signature scheme (Stripe-style, replay-safe):
//   signed string = "v1." + timestamp(seconds) + "." + deliveryId + "." + body
//   X-Cloner-Signature: v1=<hex hmac-sha256(signedString, secret)>
//   X-Cloner-Delivery:  <uuid>   unique per logical delivery (nonce)
//   X-Cloner-Timestamp: <unix seconds>
//   X-Cloner-Event:     <event name>
// verifyDelivery() recomputes the HMAC with constant-time compare, enforces a
// timestamp tolerance window AND a deliveryId nonce store — a replayed
// delivery (identical body + headers, re-POSTed later) is rejected as
// `replay`, and a stale-but-re-signed old payload is rejected by tolerance.
//
// Delivery hardening: per-attempt timeout, bounded retries with exponential
// backoff on network error / 429 / 5xx (4xx others = permanent, no retry),
// and a per-target minimum interval (client-side rate limit).
import crypto from "node:crypto";

export const SIGNATURE_VERSION = "v1";
export const DEFAULT_TOLERANCE_MS = 5 * 60 * 1000;  // replay window for timestamps
export const DEFAULT_NONCE_TTL_MS = 24 * 60 * 60 * 1000;
export const DEFAULT_TIMEOUT_MS = 10_000;
export const DEFAULT_RETRIES = 2;
const DEFAULT_MIN_INTERVAL_MS = Number(process.env.WEBHOOK_MIN_INTERVAL_MS || 50);

export class WebhookNotConfiguredError extends Error {
  constructor(message, details) { super(message); this.name = "WebhookNotConfiguredError"; this.code = "WEBHOOK_NOT_CONFIGURED"; this.details = details || []; }
}
export class WebhookSignatureError extends Error {
  constructor(message, code = "BAD_SIGNATURE") { super(message); this.name = "WebhookSignatureError"; this.code = code; }
}

// deterministic JSON (sorted keys, recursive) — retries re-send the EXACT
// bytes that were signed, so a receiver-side byte comparison is stable
export function canonicalJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return "[" + value.map(canonicalJson).join(",") + "]";
  const keys = Object.keys(value).sort();
  return "{" + keys.map((k) => JSON.stringify(k) + ":" + canonicalJson(value[k])).join(",") + "}";
}

export function signDelivery({ secret, event, payload, deliveryId, timestamp, body }) {
  if (!secret || typeof secret !== "string") throw new WebhookSignatureError("secret required", "NO_SECRET");
  const rawBody = body ?? canonicalJson(payload ?? {});
  const ts = timestamp ?? Math.floor(Date.now() / 1000);
  const id = deliveryId ?? crypto.randomUUID();
  const signedString = `${SIGNATURE_VERSION}.${ts}.${id}.${rawBody}`;
  const sig = crypto.createHmac("sha256", secret).update(signedString).digest("hex");
  return {
    deliveryId: id, timestamp: ts, event,
    body: rawBody,
    headers: {
      "content-type": "application/json",
      "x-cloner-event": String(event || "unknown"),
      "x-cloner-delivery": id,
      "x-cloner-timestamp": String(ts),
      "x-cloner-signature": `${SIGNATURE_VERSION}=${sig}`,
    },
  };
}

function timingSafeEqualStr(a, b) {
  const ab = Buffer.from(String(a), "utf8");
  const bb = Buffer.from(String(b), "utf8");
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

// In-memory nonce store for replay protection. Swap by passing `seenStore`
// implementing { has(id), mark(id) } when delivery spans processes.
export function createSeenStore({ ttlMs = DEFAULT_NONCE_TTL_MS } = {}) {
  const seen = new Map(); // deliveryId → expiry
  let timer = null;
  return {
    has(id) {
      const exp = seen.get(id);
      if (exp === undefined) return false;
      if (exp < Date.now()) { seen.delete(id); return false; }
      return true;
    },
    mark(id) { seen.set(id, Date.now() + ttlMs); },
    size() {
      const now = Date.now();
      for (const [k, exp] of seen) if (exp < now) seen.delete(k);
      return seen.size;
    },
    pruneForever() { if (timer) clearInterval(timer); },
    startSweeper() { if (!timer) timer = setInterval(() => { const now = Date.now(); for (const [k, exp] of seen) if (exp < now) seen.delete(k); }, 60_000); timer.unref?.(); },
  };
}
const defaultSeen = createSeenStore({});

// Receiver-side verification. Throws WebhookSignatureError on any mismatch.
// opts: { rawBody, secret, headers | {signature, timestamp, deliveryId},
//         toleranceMs, seenStore, allowDuplicate }
// markOnVerify: true  → the nonce is recorded as soon as the signature is
//   valid (correct for receivers that 2xx immediately = "processed").
// markOnVerify: false → the caller must call seenStore.mark(deliveryId) AFTER
//   it actually processed the delivery — the correct shape when processing can
//   fail with 5xx, because the sender legitimately re-sends the SAME
//   deliveryId on retry and that retry must NOT be rejected as a replay.
export function verifyDelivery({ rawBody, secret, headers, toleranceMs = DEFAULT_TOLERANCE_MS, seenStore = defaultSeen, markOnVerify = true }) {
  const h = headers || {};
  const sigHeader = h["x-cloner-signature"] || h.signature || "";
  const tsHeader = h["x-cloner-timestamp"] || h.timestamp || "";
  const idHeader = h["x-cloner-delivery"] || h.deliveryId || "";
  const m = /^v1=([0-9a-f]{64})$/i.exec(String(sigHeader));
  if (!m) throw new WebhookSignatureError("missing or malformed X-Cloner-Signature (expected v1=<hex>)", "BAD_SIGNATURE");
  if (!/^\d+$/.test(String(tsHeader))) throw new WebhookSignatureError("missing X-Cloner-Timestamp", "BAD_TIMESTAMP");
  if (!idHeader) throw new WebhookSignatureError("missing X-Cloner-Delivery", "BAD_DELIVERY_ID");
  const ts = Number(tsHeader);
  const skew = Math.abs(Date.now() - ts * 1000);
  if (skew > toleranceMs) throw new WebhookSignatureError(`timestamp outside tolerance window (${Math.round(skew / 1000)}s old, allowed ${Math.round(toleranceMs / 1000)}s)`, "TIMESTAMP_EXPIRED");
  // replay protection: a deliveryId that was already PROCESSED inside the
  // nonce TTL is a replay — reject before spending cycles on the HMAC
  if (seenStore.has(idHeader)) throw new WebhookSignatureError(`delivery ${idHeader} already processed (replay)`, "REPLAY");
  const expected = crypto.createHmac("sha256", secret)
    .update(`${SIGNATURE_VERSION}.${tsHeader}.${idHeader}.${rawBody}`)
    .digest("hex");
  if (!timingSafeEqualStr(m[1], expected)) throw new WebhookSignatureError("signature mismatch", "BAD_SIGNATURE");
  if (markOnVerify) seenStore.mark(idHeader);
  return { ok: true, deliveryId: idHeader, event: h["x-cloner-event"] || null, timestamp: ts };
}

// ---- env-driven targets ----
// CLONER_WEBHOOK_<NAME>_URL / _SECRET / _EVENTS. Names are lowercased in the
// returned target (NAME → name). Invalid entries are reported, not dropped
// silently: url without secret (or vice versa) is an error entry.
export function webhookTargetsFromEnv(env = process.env) {
  const byName = new Map();
  for (const key of Object.keys(env)) {
    const m = /^CLONER_WEBHOOK_([A-Z0-9_]+)_(URL|SECRET|EVENTS)$/.exec(key);
    if (!m) continue;
    const name = m[1].toLowerCase();
    const t = byName.get(name) || { name, envPrefix: `CLONER_WEBHOOK_${m[1]}` };
    if (m[2] === "URL") t.url = env[key];
    else if (m[2] === "SECRET") t.secret = env[key];
    else t.events = String(env[key]).split(",").map((s) => s.trim()).filter(Boolean);
    byName.set(name, t);
  }
  const targets = [], errors = [];
  for (const t of byName.values()) {
    if (t.url && !/^https?:\/\//i.test(t.url)) { errors.push({ name: t.name, error: "url must be http(s)" }); continue; }
    if (t.url && !t.secret) { errors.push({ name: t.name, error: `${t.envPrefix}_SECRET is required when ${t.envPrefix}_URL is set` }); continue; }
    if (!t.url && t.secret) { errors.push({ name: t.name, error: `${t.envPrefix}_URL is required when ${t.envPrefix}_SECRET is set` }); continue; }
    if (t.url) targets.push({ name: t.name, url: t.url, secret: t.secret, events: t.events || null });
  }
  return { targets, errors };
}

// per-target client-side rate limit: no two in-flight/queued sends closer
// than minIntervalMs (token-free fixed spacing — simple, predictable)
const lastSendAt = new Map();
function rateGate(name, minIntervalMs) {
  const now = Date.now();
  const last = lastSendAt.get(name) || 0;
  const wait = Math.max(0, last + minIntervalMs - now);
  lastSendAt.set(name, now + wait);
  return wait;
}

// Deliver ONE signed webhook to one REAL endpoint. Never throws on transport
// failure — returns a result object; throws only on configuration errors.
// opts: { url, secret, event, payload, deliveryId?, timeoutMs?, retries?,
//         backoffMs?, minIntervalMs?, fetchImpl? }
export async function deliverWebhook({ url, secret, event, payload, deliveryId, timeoutMs = DEFAULT_TIMEOUT_MS, retries = DEFAULT_RETRIES, backoffMs = 500, minIntervalMs = DEFAULT_MIN_INTERVAL_MS, fetchImpl = fetch }) {
  if (!url || !/^https?:\/\//i.test(url)) throw new WebhookNotConfiguredError("webhook url required (http(s))", ["url"]);
  if (!secret) throw new WebhookNotConfiguredError("webhook secret required", ["secret"]);
  const wait = rateGate(url, minIntervalMs);
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  const signed = signDelivery({ secret, event, payload, deliveryId });
  const attempts = [];
  for (let attempt = 1; attempt <= retries + 1; attempt++) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    t.unref?.();
    try {
      const res = await fetchImpl(url, { method: "POST", headers: signed.headers, body: signed.body, signal: ctrl.signal });
      attempts.push({ attempt, status: res.status });
      const ok = res.status >= 200 && res.status < 300;
      if (ok) return { delivered: true, status: res.status, attempts, deliveryId: signed.deliveryId, event };
      // 429 / 5xx → retryable; other 4xx → permanent failure, stop now
      if (res.status !== 429 && res.status < 500) {
        return { delivered: false, status: res.status, attempts, deliveryId: signed.deliveryId, event, error: `receiver rejected with ${res.status} (permanent)` };
      }
      if (attempt <= retries) await new Promise((r) => setTimeout(r, backoffMs * 2 ** (attempt - 1)));
    } catch (e) {
      const isTimeout = e?.name === "AbortError" || /abort/i.test(String(e?.message));
      attempts.push({ attempt, error: isTimeout ? `timeout after ${timeoutMs}ms` : String(e?.message || e).slice(0, 200) });
      if (attempt <= retries) await new Promise((r) => setTimeout(r, backoffMs * 2 ** (attempt - 1)));
      else return { delivered: false, status: null, attempts, deliveryId: signed.deliveryId, event, error: isTimeout ? `timeout after ${timeoutMs}ms` : String(e?.message || e).slice(0, 200) };
    } finally { clearTimeout(t); }
  }
  const last = attempts[attempts.length - 1];
  return { delivered: false, status: last?.status ?? null, attempts, deliveryId: signed.deliveryId, event, error: "retries exhausted" };
}

// Fan one lifecycle event out to every ENV-configured target subscribed to it.
//   deliverEvent({ event, payload })            → env-driven targets
//   deliverEvent({ event, payload, targets })   → explicit targets (library use)
// Zero configured targets (and none passed) → WebhookNotConfiguredError with
// the env var names to set — the documented "clean error when env is absent".
export async function deliverEvent({ event, payload, targets, ...opts } = {}) {
  if (!event) throw new WebhookNotConfiguredError("event name required", ["event"]);
  let list = targets;
  if (!list) {
    const { targets: envTargets, errors } = webhookTargetsFromEnv();
    if (errors.length) throw new WebhookNotConfiguredError(`misconfigured webhook targets: ${errors.map((e) => `${e.name}: ${e.error}`).join("; ")}`, errors.map((e) => e.name));
    list = envTargets;
  }
  if (!Array.isArray(list) || list.length === 0) {
    throw new WebhookNotConfiguredError(
      "no webhook targets configured — set CLONER_WEBHOOK_<NAME>_URL and CLONER_WEBHOOK_<NAME>_SECRET (optional CLONER_WEBHOOK_<NAME>_EVENTS) to enable outbound deliveries",
      ["CLONER_WEBHOOK_<NAME>_URL", "CLONER_WEBHOOK_<NAME>_SECRET"],
    );
  }
  const subscribed = list.filter((t) => !t.events || t.events.includes(event) || t.events.includes("*"));
  if (subscribed.length === 0) return { delivered: 0, results: [], skipped: list.map((t) => t.name) };
  const results = await Promise.all(subscribed.map((t) =>
    deliverWebhook({ ...opts, url: t.url, secret: t.secret, event, payload }).then((r) => ({ target: t.name, ...r }))));
  return { delivered: results.filter((r) => r.delivered).length, results };
}

export function closeWebhookState() { lastSendAt.clear(); }
