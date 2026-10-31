// Vision retry policy (task 3.4.6): pure, dependency-free error classification
// and the frozen default policy for the kiosapi glm-5.3-flash-free endpoint
// (known flaky: 530/524 gateway errors, Cloudflare ~100s hard timeout — the
// client streams to dodge that).
//
// Design rules this module enforces for the client (src/platform/vision-client.js):
//  - Retryable classes get BOUNDED retries under a strict wall-clock budget so
//    retries can never amplify a provider outage (a retry that does not fit in
//    the remaining budget is never started).
//  - Permanent classes fail fast to the deterministic fallback (callers use
//    DOM/geometry analysis) — retrying a 401/400/model-missing only burns budget.
//  - Caller cancellation is never retried and never classified as a failure of
//    the provider.
//  - No secrets: redact() strips API keys / bearer tokens / long base64
//    payloads from anything that might surface in a log, an event, or a
//    fallback reason. Raw provider payloads are never stored or logged.

// Frozen default policy. backoffMs[i] is the wait inserted after failed
// attempt i+1 (i.e. before attempt i+2); the third entry applies when
// maxAttempts is raised above 3. Worst case with these defaults and a 20s
// per-request timeout: 20 + 5 + 20 + 15 + 20 = 80s <= budgetMs 90s.
export const VISION_RETRY_POLICY = Object.freeze({
  maxAttempts: 3,
  backoffMs: Object.freeze([5000, 15000, 45000]),
  budgetMs: 90_000,
});

export const RETRYABLE = "retryable";
export const PERMANENT = "permanent";
export const CANCELLED = "cancelled";

// normalizePolicy(partial) → frozen full policy (defaults filled from
// VISION_RETRY_POLICY). Throws on nonsense values so a bad config fails loudly
// at construction time instead of mid-outage.
export function normalizePolicy(partial = {}) {
  const p = { ...VISION_RETRY_POLICY, ...(partial || {}) };
  if (!Number.isInteger(p.maxAttempts) || p.maxAttempts < 1) {
    throw new Error(`vision retry policy: maxAttempts must be an integer >= 1 (got ${JSON.stringify(p.maxAttempts)})`);
  }
  if (!Array.isArray(p.backoffMs) || p.backoffMs.some((ms) => !Number.isFinite(ms) || ms < 0)) {
    throw new Error("vision retry policy: backoffMs must be an array of non-negative ms delays");
  }
  if (!Number.isFinite(p.budgetMs) || p.budgetMs <= 0) {
    throw new Error("vision retry policy: budgetMs must be a positive number");
  }
  return Object.freeze({ maxAttempts: p.maxAttempts, backoffMs: Object.freeze([...p.backoffMs]), budgetMs: p.budgetMs });
}

// classifyError(err, { signalAborted }) → { kind, status?, reason }.
// kind is one of RETRYABLE / PERMANENT / CANCELLED.
//
// Precedence:
//  1. caller aborted its own signal → CANCELLED (regardless of the underlying
//     error text — an internal AbortError alone means OUR deadline, not the
//     caller's).
//  2. explicit status (err.status, or "… API <code>:" as thrown by
//     src/vision.js) → status rules.
//  3. abort/timeout names → RETRYABLE (our per-request deadline fired; a
//     stalled/gateway-timed-out request is exactly the flaky class).
//  4. model-missing message → PERMANENT (wrong model id will never heal).
//  5. network-ish shapes (fetch failed, ECONN*/ETIMEDOUT, terminated, socket)
//     → RETRYABLE.
//  6. anything unrecognized → RETRYABLE (bounded by maxAttempts + budgetMs —
//     unknown flakiness is cheaper to re-ask than to give up on, and the budget
//     caps the damage either way).
export function classifyError(err, { signalAborted = false } = {}) {
  if (signalAborted) {
    return { kind: CANCELLED, reason: "caller cancelled the vision request" };
  }
  const name = String(err?.name || "");
  const msg = String(err?.message || err || "");

  // 1. explicit status: err.status wins, else parse the "… API 429: …" shape
  //    that src/vision.js VisionClient throws for non-ok responses.
  let status = Number.isInteger(err?.status) ? err.status : null;
  if (status === null) {
    const m = msg.match(/\bAPI\s+(\d{3})\b/);
    if (m) status = Number(m[1]);
  }
  if (status !== null) {
    if (status === 429) return { kind: RETRYABLE, status, reason: "rate limited (429)" };
    if (status >= 500 || [520, 521, 522, 523, 524, 525, 526, 527, 530].includes(status)) {
      return { kind: RETRYABLE, status, reason: `server/gateway error (${status})` };
    }
    if (status === 404) return { kind: PERMANENT, status, reason: "model or endpoint missing (404)" };
    if (status === 401) return { kind: PERMANENT, status, reason: "authentication failed (401)" };
    if (status === 403) return { kind: PERMANENT, status, reason: "forbidden (403)" };
    if (status === 400 || status === 422) return { kind: PERMANENT, status, reason: `bad request (${status})` };
    return { kind: PERMANENT, status, reason: `client error (${status})` }; // unlisted 4xx: fail fast, never amplify
  }

  // 2. our own deadline (per-request timeout aborts the fetch mid-stream)
  if (name === "AbortError" || name === "TimeoutError" || /aborted|timed? ?out/i.test(msg)) {
    return { kind: RETRYABLE, reason: "request timeout / deadline" };
  }

  // 3. model-missing by message (some relays return 200-with-error or odd codes)
  if (/model\b.*(not[_ ]found|does ?not ?exist|not available|invalid|unsupported)/i.test(msg)) {
    return { kind: PERMANENT, reason: "model missing/unsupported" };
  }

  // 4. network class
  if (
    name === "TypeError" || // undici: "fetch failed", "terminated"
    /fetch failed|network|econn(aborted|refused|reset)|enetunreach|ehostunreach|enotfound|etimedout|eai_again|epipe|socket hang up|terminated|premature|connection (reset|closed)/i.test(msg)
  ) {
    return { kind: RETRYABLE, reason: "network error" };
  }

  // 5. unknown → bounded retry
  return { kind: RETRYABLE, reason: "unclassified error (bounded retry)" };
}

// redact(text, { max }) — scrub credentials and payload blobs from any text
// that could reach a log/event/fallback reason. Never store raw payloads.
export function redact(text, { max = 240 } = {}) {
  let s = String(text ?? "");
  s = s
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [redacted]")
    .replace(/\bsk-[A-Za-z0-9_-]{4,}/g, "sk-[redacted]")
    .replace(/\b((?:x-)?api[-_]?key|authorization|token|password)\s*[:=]\s*("?)[^\s",]+\2/gi, "$1: [redacted]")
    .replace(/[A-Za-z0-9+/]{96,}={0,2}/g, "[base64-redacted]"); // long base64 = payload/key material
  return s.slice(0, max);
}

// abortableSleep(ms, signal) — backoff wait that gives up immediately when the
// caller's signal aborts. Rejects with an Error named "AbortError".
export function abortableSleep(ms, signal) {
  return new Promise((resolve, reject) => {
    const abortErr = () => {
      const e = new Error("cancelled during backoff wait");
      e.name = "AbortError";
      e.callerAbort = true;
      return e;
    };
    if (signal?.aborted) return reject(abortErr());
    const t = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      reject(abortErr());
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
