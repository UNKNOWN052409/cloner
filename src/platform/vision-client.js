// Vision API reliability client (task 3.4.6). Wraps the EXISTING provider
// request path — src/platform/model-router.js makes its calls through
// `new VisionClient({ model: {...} }).chat(messages, { onDelta, timeoutMs })`
// (src/vision.js, OpenAI-compatible POST {baseUrl}/chat/completions, Bearer
// auth, `stream: true` when onDelta is given) — and adds the reliability layer
// the flaky kiosapi glm-5.3-flash-free endpoint needs:
//
//   • streamed consumption — always requests `stream: true` and assembles the
//     final text from SSE deltas (streaming is what dodges the Cloudflare
//     ~100s hard timeout that kills non-streamed requests on that endpoint);
//     src/vision.js' sseLines already reassembles SSE lines split across
//     chunk boundaries, and this client concatenates the deltas.
//   • request timeout + AbortSignal cancellation — every attempt gets
//     timeoutMs = min(requestTimeoutMs, remaining retry budget); the reused
//     VisionClient aborts the real fetch (and a stalled SSE body read) at that
//     deadline via its internal AbortController (src/vision.js:56-57,90-103).
//     A caller-supplied signal is honoured by racing the attempt: complete()
//     returns AT ONCE when the signal fires and no further attempt is made.
//     Known limit (documented, honest): the reused chat() does not accept an
//     external signal (src/vision.js is read-only), so a caller abort cannot
//     tear down the in-flight socket — that socket remains bounded by the
//     per-attempt timeout, which IS a real fetch abort.
//   • concurrency limit — at most maxInFlight (default 2) provider requests in
//     flight across all complete() calls on this client; the slot is held per
//     HTTP attempt, not during backoff waits.
//   • result cache — SHA1(prompt + NUL + imageBase64 + NUL + model), LRU-capped;
//     only successful completions are cached (a flaky-provider failure is
//     never poisoned into the cache). A hit performs zero network I/O.
//   • bounded retries under a strict budget — policy from
//     src/platform/vision-retry-policy.js; a retry is only started when the
//     backoff AND a minimal request window fit in the remaining budget, so
//     retries can never amplify a provider outage.
//
// Deterministic fallback contract: complete() NEVER throws. On exhaustion,
// permanent error, budget exhaustion, cancellation or invalid input it returns
//   { ok: false, fallback: true, reason, attempts, elapsedMs, errorKind }
// and the caller is expected to proceed with DOM/geometry analysis (mirrors
// src/reconstruction/vision-assist.js FALLBACK_VERDICT philosophy).
//
// No secrets: API keys are never logged; provider error bodies and all event
// fields are passed through redact() (vision-retry-policy.js); prompts and
// image bytes never appear in events or reasons.
import crypto from "node:crypto";
import { VisionClient } from "../vision.js";
import { getProviders } from "./model-router.js";
import {
  normalizePolicy,
  classifyError,
  redact,
  abortableSleep,
  RETRYABLE,
  PERMANENT,
  CANCELLED,
} from "./vision-retry-policy.js";

export const DEFAULT_MODEL = "glm-5.3-flash-free";
export const DEFAULT_REQUEST_TIMEOUT_MS = 20_000; // per attempt; streaming responses are small verdicts
export const DEFAULT_MAX_IN_FLIGHT = 2; // ask: "concurrency limit (max 2 in-flight)"
export const DEFAULT_CACHE_MAX_ENTRIES = 128;
const MIN_ATTEMPT_MS = 1_000; // a retry needs at least this much budget left to be started

// SHA1 cache key: prompt + image bytes + model (ask: "keyed by SHA1(prompt+imageBytes+model)").
export function visionCacheKey(prompt, imageBase64, model) {
  return crypto
    .createHash("sha1")
    .update(String(prompt ?? ""))
    .update("\u0000")
    .update(String(imageBase64 ?? ""))
    .update("\u0000")
    .update(String(model ?? ""))
    .digest("hex");
}

// Minimal abort-aware FIFO semaphore. acquire() resolves when a slot is free;
// a waiting acquire is rejected as AbortError when the signal aborts (and its
// listener is always removed when the wait settles either way).
class Semaphore {
  constructor(n) {
    this.free = Math.max(1, n);
    this.waiters = [];
  }
  acquire(signal) {
    if (this.free > 0) {
      this.free--;
      return Promise.resolve();
    }
    return new Promise((resolve, reject) => {
      const w = { resolve, reject, signal, onAbort: null };
      const onAbort = () => {
        const i = this.waiters.indexOf(w);
        if (i >= 0) this.waiters.splice(i, 1);
        const e = new Error("cancelled while waiting for a provider slot");
        e.name = "AbortError";
        reject(e);
      };
      w.onAbort = onAbort;
      signal?.addEventListener("abort", onAbort, { once: true });
      this.waiters.push(w);
    });
  }
  release() {
    const w = this.waiters.shift();
    if (w) {
      w.signal?.removeEventListener("abort", w.onAbort); // slot handed over — abort no longer applies
      w.resolve();
    } else {
      this.free++;
    }
  }
}

// Strip markdown fences and slice the first JSON object out of model text —
// same tolerance as vision-assist.js parseVisionVerdict (first "{"..last "}").
export function extractJson(text) {
  const s = String(text || "").replace(/```(?:json)?/gi, "");
  const a = s.indexOf("{");
  const b = s.lastIndexOf("}");
  if (a < 0 || b <= a) return null;
  try {
    return JSON.parse(s.slice(a, b + 1));
  } catch {
    return null;
  }
}

export class ReliableVisionClient {
  // provider: { name?, provider?, model?, baseUrl, apiKey } — the same shape
  // model-router.js builds for each entry of getProviders(cfg).
  // opts: {
  //   policy:           { maxAttempts, backoffMs, budgetMs } partial override
  //   requestTimeoutMs: per-attempt cap (also capped by remaining budget)
  //   maxInFlight:      concurrency limit (default 2)
  //   maxTokens:        completion budget per ask (default 300 — verdict JSON)
  //   cacheMaxEntries:  LRU cap (default 128)
  //   onEvent:          (event) => void — telemetry WITHOUT secrets/payloads
  // }
  constructor(provider, opts = {}) {
    if (!provider || (!provider.baseUrl && !provider.apiKey)) {
      throw new Error("createVisionClient: provider requires baseUrl and/or apiKey");
    }
    this.providerName = provider.name || provider.provider || "custom";
    this.model = provider.model || DEFAULT_MODEL;
    this.requestTimeoutMs = opts.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.maxTokens = opts.maxTokens ?? 300;
    this.cacheMaxEntries = opts.cacheMaxEntries ?? DEFAULT_CACHE_MAX_ENTRIES;
    this.policy = normalizePolicy(opts.policy);
    this.onEvent = typeof opts.onEvent === "function" ? opts.onEvent : null;
    this.cache = new Map(); // sha1 -> { text, json }
    this.sem = new Semaphore(opts.maxInFlight ?? DEFAULT_MAX_IN_FLIGHT);
    // The transport is the EXACT object model-router.js:69 constructs — same
    // endpoint mapping, same headers, same SSE handling.
    this.#transport = new VisionClient({
      model: {
        provider: provider.provider || "custom",
        model: this.model,
        baseUrl: provider.baseUrl || "",
        apiKey: provider.apiKey || "",
      },
    });
  }
  #transport;

  #emit(type, fields = {}) {
    if (!this.onEvent) return;
    // Event fields are counts/statuses/redacted reasons only — never prompt,
    // never image bytes, never keys.
    try {
      this.onEvent({ type, provider: this.providerName, model: this.model, ...fields });
    } catch {
      /* telemetry must never break the request path */
    }
  }

  // complete({ prompt, imageBase64, signal }) →
  //   { ok: true,  text, json, cached, attempts, elapsedMs, provider, model }
  //   { ok: false, fallback: true, reason, attempts, elapsedMs, errorKind, provider, model }
  async complete({ prompt, imageBase64, signal } = {}) {
    const started = Date.now();
    const elapsed = () => Date.now() - started;
    const remaining = () => this.policy.budgetMs - elapsed();
    const base = { provider: this.providerName, model: this.model };

    // --- input validation (deterministic, no throw) ---
    if (typeof prompt !== "string" || !prompt.trim()) {
      return this.#fallbackResult("invalid request: prompt (non-empty string) required", 0, elapsed(), null, base);
    }
    if (typeof imageBase64 !== "string" || !imageBase64) {
      return this.#fallbackResult("invalid request: imageBase64 (string) required", 0, elapsed(), null, base);
    }
    if (signal?.aborted) {
      return this.#fallbackResult("cancelled: signal already aborted", 0, elapsed(), CANCELLED, base);
    }

    // --- cache: a hit avoids the request entirely (no semaphore, no fetch) ---
    const key = visionCacheKey(prompt, imageBase64, this.model);
    const hit = this.cache.get(key);
    if (hit) {
      this.cache.delete(key); // LRU refresh
      this.cache.set(key, hit);
      this.#emit("cache-hit", { attempts: 0, elapsedMs: elapsed() });
      return { ok: true, text: hit.text, json: hit.json, cached: true, attempts: 0, elapsedMs: elapsed(), ...base };
    }

    let lastClass = null;

    for (let attemptNo = 1; attemptNo <= this.policy.maxAttempts; attemptNo++) {
      // --- strict budget gate: backoff + a minimal request window must fit ---
      if (attemptNo > 1) {
        const waitMs = this.policy.backoffMs[attemptNo - 2] ?? this.policy.backoffMs[this.policy.backoffMs.length - 1] ?? 0;
        if (remaining() < waitMs + MIN_ATTEMPT_MS) {
          this.#emit("budget-exhausted", { attempts: attemptNo - 1, elapsedMs: elapsed() });
          return this.#fallbackResult(
            `vision retry budget exhausted (budgetMs=${this.policy.budgetMs}, waited+attempted ${elapsed()}ms) — deterministic fallback`,
            attemptNo - 1,
            elapsed(),
            lastClass?.kind || RETRYABLE,
            base,
          );
        }
        try {
          await abortableSleep(waitMs, signal);
        } catch {
          return this.#fallbackResult("cancelled during backoff wait", attemptNo - 1, elapsed(), CANCELLED, base);
        }
      }
      if (remaining() < MIN_ATTEMPT_MS) {
        this.#emit("budget-exhausted", { attempts: attemptNo - 1, elapsedMs: elapsed() });
        return this.#fallbackResult(
          `vision retry budget exhausted before attempt ${attemptNo} — deterministic fallback`,
          attemptNo - 1,
          elapsed(),
          lastClass?.kind || RETRYABLE,
          base,
        );
      }

      // --- one provider attempt: slot acquired per attempt, backoff outside ---
      try {
        await this.sem.acquire(signal);
      } catch {
        return this.#fallbackResult("cancelled while waiting for a provider slot", attemptNo - 1, elapsed(), CANCELLED, base);
      }
      let text = null;
      let attemptErr = null;
      try {
        text = await this.#attemptOnce({ prompt, imageBase64, signal, deadlineMs: remaining() });
      } catch (e) {
        attemptErr = e;
      } finally {
        this.sem.release();
      }

      if (attemptErr === null) {
        let json = null;
        try {
          json = extractJson(text);
        } catch {
          json = null;
        }
        // LRU insert (only successes are cached)
        this.cache.set(key, { text, json });
        if (this.cache.size > this.cacheMaxEntries) {
          this.cache.delete(this.cache.keys().next().value);
        }
        this.#emit("success", { attempt: attemptNo, cached: false, elapsedMs: elapsed() });
        return { ok: true, text, json, cached: false, attempts: attemptNo, elapsedMs: elapsed(), ...base };
      }

      // --- classify + react ---
      const cls = classifyError(attemptErr, { signalAborted: signal?.aborted === true });
      lastClass = cls;
      this.#emit("attempt-failed", { attempt: attemptNo, errorKind: cls.kind, status: cls.status ?? null, reason: redact(cls.reason), elapsedMs: elapsed() });

      if (cls.kind === CANCELLED) {
        return this.#fallbackResult(`cancelled: ${redact(attemptErr?.message || "signal aborted", { max: 120 })}`, attemptNo, elapsed(), CANCELLED, base);
      }
      if (cls.kind === PERMANENT) {
        // fail fast: retrying 401/400/model-missing cannot help — deterministic fallback NOW
        this.#emit("permanent-error", { attempt: attemptNo, status: cls.status ?? null, reason: redact(cls.reason) });
        return this.#fallbackResult(
          `permanent vision error: ${redact(cls.reason)} (${redact(attemptErr?.message || "", { max: 160 })})`,
          attemptNo,
          elapsed(),
          PERMANENT,
          base,
        );
      }
      // RETRYABLE → loop continues (budget gate above decides if a retry starts)
    }

    // attempts exhausted
    this.#emit("exhausted", { attempts: this.policy.maxAttempts, elapsedMs: elapsed() });
    return this.#fallbackResult(
      `vision attempts exhausted (${this.policy.maxAttempts} attempts, last: ${redact(lastClass?.reason || "unknown", { max: 120 })}) — deterministic fallback`,
      this.policy.maxAttempts,
      elapsed(),
      lastClass?.kind || RETRYABLE,
      base,
    );
  }

  // One HTTP attempt through the reused VisionClient. deadlineMs bounds BOTH
  // the per-fetch timeout passed down (real abort, incl. stalled SSE bodies)
  // and an outer race — the outer race exists because the reused chat()
  // internally retries [500,502,503,524] once with a 4s sleep
  // (src/vision.js:72-79); the race keeps THIS attempt inside the budget. When
  // the outer race fires, the abandoned chat keeps running in the background
  // only until its own per-fetch timer aborts the socket (bounded).
  async #attemptOnce({ prompt, imageBase64, signal, deadlineMs }) {
    const dataUrl = toDataUrl(imageBase64);
    const mediaType = mediaTypeOf(dataUrl);
    const messages = [
      {
        role: "user",
        content: [
          { type: "image", dataUrl, mediaType }, // VisionClient maps this to image_url (src/vision.js:48)
          { type: "text", text: prompt },
        ],
      },
    ];
    let out = "";
    const chatPromise = this.#transport.chat(messages, {
      maxTokens: this.maxTokens,
      timeoutMs: Math.max(1, Math.min(this.requestTimeoutMs, deadlineMs)), // real fetch abort at the deadline
      onDelta: (d) => {
        out += d; // partial-chunk assembly: SSE deltas concatenated in order
      },
    });

    try {
      return await raceWithDeadline(chatPromise, deadlineMs, signal);
    } catch (e) {
      // abandon the in-flight chat (bounded by its own per-fetch abort timer)
      chatPromise.catch(() => {});
      throw e;
    }
  }

  #fallbackResult(reason, attempts, elapsedMs, errorKind, base) {
    this.#emit("fallback", { attempts, elapsedMs, errorKind, reason: redact(reason) });
    return { ok: false, fallback: true, reason: redact(reason), attempts, elapsedMs, errorKind, ...base };
  }

  // asVisionFn({ buildPrompt }) → async (region, imageBase64, ctx) => verdictObject | null
  //
  // Adoption path for src/reconstruction/vision-assist.js: its injectable
  // contract (resolveVerdict, vision-assist.js:220-229) is
  //   async visionFn(region, imageBase64, ctx) => { kind, confidence, reason? } | null
  // and a null/invalid result is folded into FALLBACK_VERDICT with the DOM
  // verdict kept. So adopting the reliability layer is ONE line at the call
  // site of classifyAmbiguous/mergeVisionIntoLayout — zero edits to
  // vision-assist.js:
  //   opts.visionFn = createVisionClientForConfig(cfg)?.asVisionFn();
  // buildPrompt(region, ctx) defaults to regionPrompt() below (a mirror of
  // vision-assist's REGION_PROMPT text so adopters get identical prompts).
  asVisionFn({ buildPrompt } = {}) {
    return async (region, imageBase64, ctx = {}) => {
      const prompt = buildPrompt ? buildPrompt(region, ctx) : regionPrompt(region, ctx?.note || ctx?.regionNote || "");
      const r = await this.complete({ prompt, imageBase64, signal: ctx?.signal });
      if (!r.ok) return null; // fallback contract → vision-assist keeps DOM-only
      return r.json ?? extractJson(r.text);
    };
  }
}

function toDataUrl(imageBase64) {
  return String(imageBase64).startsWith("data:") ? String(imageBase64) : `data:image/png;base64,${imageBase64}`;
}
function mediaTypeOf(dataUrl) {
  const m = String(dataUrl).match(/^data:([^;]+);/);
  return m ? m[1] : "image/png";
}

// Race a promise against (a) a hard deadline and (b) caller abort. Rejects
// with TimeoutError at the deadline, AbortError on caller abort — both are
// classified by vision-retry-policy.classifyError.
function raceWithDeadline(promise, deadlineMs, signal) {
  return new Promise((resolve, reject) => {
    let timer = null;
    let onAbort = null;
    const cleanup = () => {
      if (timer) clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    };
    timer = setTimeout(() => {
      const e = new Error(`vision attempt deadline exceeded (${Math.round(deadlineMs)}ms)`);
      e.name = "TimeoutError";
      cleanup();
      reject(e);
    }, Math.max(1, deadlineMs));
    onAbort = () => {
      const e = new Error("cancelled by caller signal");
      e.name = "AbortError";
      cleanup();
      reject(e);
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (v) => {
        cleanup();
        resolve(v);
      },
      (e) => {
        cleanup();
        reject(e);
      },
    );
  });
}

// Mirror of vision-assist.js REGION_PROMPT (lines 156-164) for adopters that
// call asVisionFn() without a custom buildPrompt. Kept textually identical so
// reliability-layer adoption does not change what the model is asked.
export function regionPrompt(region, note = "") {
  return [
    "You are analyzing a web page screenshot to classify ONE UI region.",
    `The region of interest is the box at CSS-pixel coordinates relative to the top-left of this (viewport) screenshot: x=${region?.x ?? 0}, y=${region?.y ?? 0}, width=${region?.w ?? 0}, height=${region?.h ?? 0}.${note || ""}`,
    "Look at that box (and enough surrounding context to understand its role).",
    "Classify what the region IS as a UI component. Respond with ONLY a JSON object — no prose, no markdown fences:",
    '{"kind":"nav|table|chart|card-grid|form|sidebar|unknown","confidence":0.0-1.0,"reason":"one short sentence"}',
    'kind meanings: nav=site/navigation bar, table=tabular data, chart=data visualization, card-grid=repeated card/tile blocks, form=input controls, sidebar=side panel, unknown=none of these or the region is not visible in the screenshot.',
  ].join("\n");
}

// createVisionClient(provider, opts) — primary entry point.
export function createVisionClient(provider, opts = {}) {
  return new ReliableVisionClient(provider, opts);
}

// createVisionClientForConfig(cfg, opts) — pick a vision-capable provider from
// a platform config via the model-router's own getProviders(). Returns null
// (NEVER throws) when provider "none" is configured or no provider exists —
// the caller then proceeds with the deterministic DOM/geometry fallback, and
// no fetch is attempted. (Mirrors the explicit "none" off-switch check in
// vision-assist.js:199.)
export function createVisionClientForConfig(cfg, opts = {}) {
  try {
    if (cfg?.model?.provider === "none") return null;
    const providers = getProviders(cfg || {});
    const visionCapable = providers.filter((p) => (p.capabilities || []).includes("vision"));
    const pick = visionCapable[0] || providers[0];
    if (!pick) return null;
    return createVisionClient(pick, opts);
  } catch {
    return null;
  }
}

// One-shot convenience: complete() with config-derived provider. Holds NO
// shared cache/semaphore between calls — pipeline callers should keep an
// instance (createVisionClientForConfig) instead of calling this per region.
export async function completeVision(cfg, { prompt, imageBase64, signal, ...opts } = {}) {
  const client = createVisionClientForConfig(cfg, opts);
  if (!client) {
    return { ok: false, fallback: true, reason: "no vision provider configured — deterministic fallback", attempts: 0, elapsedMs: 0, errorKind: PERMANENT };
  }
  return client.complete({ prompt, imageBase64, signal });
}
