// Distributed tracing context (task 4.2.10) — W3C Trace Context propagation
// across the clone-job pipeline: producer (API/enqueue) → queue → worker →
// stages, plus a span tree with timing.
//
// Format: the W3C "traceparent" header value
//     {version}-{trace-id}-{parent-id}-{trace-flags}
// e.g.  "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01"
//   version   2 lowercase hex ("ff" is forbidden by the spec; unknown versions
//             are still parsed per spec — the first 4 fields keep their shape)
//   trace-id  32 lowercase hex, NOT all zeros
//   parent-id 16 lowercase hex, NOT all zeros
//   flags     2 lowercase hex (01 = sampled)
//
// Propagation contract (how it crosses the queue boundary):
//   • PRODUCER side: wrap the enqueue call in a span and inject the span's
//     traceparent into the job payload — injectTraceparent(payload) returns
//     { ...payload, traceparent }. The queue treats the payload as opaque
//     data, so the traceparent crosses BOTH backends (memory and BullMQ job
//     data) verbatim with zero queue changes.
//   • WORKER side: tracedExecutor(baseExecutor) extracts payload.traceparent
//     (W3C format), starts the job span as a CHILD of that remote parent, and
//     derives one child span per pipeline stage from the report() protocol
//     (exploring → stage.exploration, reconstructing → stage.reconstruction,
//     verifying → stage.verification — the same vocabulary task_stages uses).
//   • A missing/invalid traceparent NEVER fails the job: the worker degrades
//     to a fresh root trace and records why in a span attribute.
//
// Recording: ended spans go to (a) the registered span sink — usually the
// JSON-lines exporter in trace-export.js (span timing export) — and (b) a
// bounded in-process ring buffer for tests/debugging. Sink failures are
// swallowed: observability must never fail a clone job (same posture as the
// task_stages persister in clone-worker.js).
//
// Attributes are sanitized: values truncated to 200 chars, max 16 keys, and
// keys that look credential-bearing (password/token/cookie/secret/…, same
// heuristic family as artifact-store redact) are dropped entirely — traces
// must not become a credential leak vector.
import { randomBytes } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";

// ---- W3C traceparent codec -------------------------------------------------

// strict lowercase hex, exact field lengths (W3C trace-context ABNF)
const TRACEPARENT_RE = /^([0-9a-f]{2})-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/;
const ALL_ZERO = /^0+$/;

/**
 * Parse a W3C traceparent value. Strict: lowercase hex only, exact lengths,
 * all-zero ids and version "ff" rejected. Never throws — invalid input
 * returns null so callers degrade to a fresh root trace.
 * @param {unknown} value raw traceparent string (e.g. an HTTP header value or payload.traceparent)
 * @returns {{ version: string, traceId: string, spanId: string, flags: string } | null}
 */
export function parseTraceparent(value) {
  if (typeof value !== "string") return null;
  const m = TRACEPARENT_RE.exec(value);
  if (!m) return null;
  const [, version, traceId, spanId, flags] = m;
  if (version === "ff") return null; // forbidden version (W3C §2.3.1)
  if (ALL_ZERO.test(traceId) || ALL_ZERO.test(spanId)) return null; // W3C §2.2.2 / §2.2.4
  return { version, traceId, spanId, flags };
}

/** Re-emit a parsed/normalized traceparent string; throws on invalid parts (programmer error). */
export function formatTraceparent({ version = "00", traceId, spanId, flags = "01" } = {}) {
  const bad = (what) => { throw new Error(`formatTraceparent: invalid ${what}`); };
  if (typeof version !== "string" || !/^[0-9a-f]{2}$/.test(version) || version === "ff") bad("version");
  if (typeof traceId !== "string" || !/^[0-9a-f]{32}$/.test(traceId) || ALL_ZERO.test(traceId)) bad("trace-id");
  if (typeof spanId !== "string" || !/^[0-9a-f]{16}$/.test(spanId) || ALL_ZERO.test(spanId)) bad("span-id");
  if (typeof flags !== "string" || !/^[0-9a-f]{2}$/.test(flags)) bad("trace-flags");
  return `${version}-${traceId}-${spanId}-${flags}`;
}

export function randomTraceId() {
  let id = randomBytes(16).toString("hex");
  while (ALL_ZERO.test(id)) id = randomBytes(16).toString("hex");
  return id;
}

export function randomSpanId() {
  let id = randomBytes(8).toString("hex");
  while (ALL_ZERO.test(id)) id = randomBytes(8).toString("hex");
  return id;
}

// ---- recording surface -----------------------------------------------------

let spanSink = null; // fn(record) — set by trace-export.js attach helpers / tests

/** Register the span consumer (JSONL exporter). Pass null to detach. */
export function setSpanSink(fn) { spanSink = typeof fn === "function" ? fn : null; }
export function getSpanSink() { return spanSink; }

const RECENT_CAP = 2000;
const recent = [];

/** Ended-span ring buffer (bounded) — introspection + tests, not the export path. */
export function recentSpans({ limit = RECENT_CAP } = {}) { return recent.slice(-limit); }
export function resetRecentSpans() { recent.length = 0; }

// attribute hygiene: no credentials in traces, bounded cardinality and size
const SECRET_KEY_RE = /pass(word)?|secret|token|cookie|authorization|credential|api[-_]?key/i;
const MAX_ATTRS = 16;
const MAX_ATTR_LEN = 200;

function sanitizeAttributes(attrs) {
  if (!attrs || typeof attrs !== "object") return {};
  const out = {};
  let n = 0;
  for (const [k, v] of Object.entries(attrs)) {
    if (n >= MAX_ATTRS) break;
    if (v === null || v === undefined || typeof v === "function" || typeof v === "symbol") continue;
    if (SECRET_KEY_RE.test(k)) continue; // never record credential-bearing keys
    let val;
    if (typeof v === "number") val = Number.isFinite(v) ? v : String(v).slice(0, MAX_ATTR_LEN);
    else if (typeof v === "boolean") val = v;
    else if (typeof v === "string") val = v.slice(0, MAX_ATTR_LEN);
    else val = JSON.stringify(v)?.slice(0, MAX_ATTR_LEN) ?? String(v).slice(0, MAX_ATTR_LEN);
    out[String(k).slice(0, 64)] = val;
    n++;
  }
  return out;
}

/** The JSON-lines record shape (one object per span, written by trace-export.js). */
function spanRecord(span) {
  return {
    trace_id: span.traceId,
    span_id: span.spanId,
    parent_span_id: span.parentSpanId ?? null,
    name: span.name,
    status: span.status,
    start_ms: span.startedAt,
    end_ms: span.endedAt,
    duration_ms: Math.max(0, span.endedAt - span.startedAt),
    start_time: new Date(span.startedAt).toISOString(),
    end_time: new Date(span.endedAt).toISOString(),
    attributes: sanitizeAttributes(span.attributes),
  };
}

// ---- span + context --------------------------------------------------------

export class Span {
  constructor({ traceId, parentSpanId = null, name, attributes = {}, startedAt = Date.now() }) {
    this.traceId = traceId;
    this.spanId = randomSpanId();
    this.parentSpanId = parentSpanId;
    this.name = String(name || "span");
    this.attributes = attributes && typeof attributes === "object" ? { ...attributes } : {};
    this.startedAt = startedAt;
    this.endedAt = null;
    this.durationMs = null;
    this.status = "unset"; // "ok" | "error" once ended
    this.ended = false;
  }

  setAttribute(key, value) { this.attributes[key] = value; return this; }

  /** This span as a W3C traceparent value — the inject side of propagation. */
  get traceparent() {
    return formatTraceparent({ traceId: this.traceId, spanId: this.spanId, flags: "01" });
  }

  /**
   * End the span (idempotent — later calls are no-ops). Emits the export
   * record to the sink and the ring buffer; sink failures are swallowed.
   */
  end({ status = "ok", error = null, attributes = null } = {}) {
    if (this.ended) return this;
    this.ended = true;
    this.endedAt = Date.now();
    this.durationMs = Math.max(0, this.endedAt - this.startedAt);
    this.status = status === "error" ? "error" : "ok";
    if (attributes && typeof attributes === "object") Object.assign(this.attributes, attributes);
    if (error) this.attributes["error.message"] = String(error?.message ?? error).slice(0, MAX_ATTR_LEN);
    const rec = spanRecord(this);
    recent.push(rec);
    if (recent.length > RECENT_CAP) recent.shift();
    if (spanSink) {
      try { spanSink(rec); } catch { /* a dead sink never fails the job */ }
    }
    return this;
  }
}

const traceCtx = new AsyncLocalStorage(); // store: { traceId, span }
const isThenable = (v) => !!v && typeof v.then === "function";

/** Current span inside the active trace scope, or null outside any trace. */
export function currentSpan() { return traceCtx.getStore()?.span ?? null; }
/** Current trace id inside the active trace scope, or null. */
export function currentTraceId() { return traceCtx.getStore()?.traceId ?? null; }

/**
 * Create a span WITHOUT making it current. Parent resolution order:
 * opts.parent (Span instance) → opts.traceId/opts.parentSpanId (extracted
 * remote context) → the current ALS span → fresh root.
 */
export function startSpan(name, attributes = {}, opts = {}) {
  if (opts.parent instanceof Span) {
    return new Span({ traceId: opts.parent.traceId, parentSpanId: opts.parent.spanId, name, attributes });
  }
  if (opts.traceId) {
    return new Span({ traceId: opts.traceId, parentSpanId: opts.parentSpanId ?? null, name, attributes });
  }
  const parent = currentSpan();
  if (parent) return new Span({ traceId: parent.traceId, parentSpanId: parent.spanId, name, attributes });
  return new Span({ traceId: randomTraceId(), parentSpanId: null, name, attributes });
}

// run fn inside `span`'s scope; auto-ends ok on resolve / error on throw.
// Sync fns execute AND end synchronously (enqueue timing preserved).
function executeIn(span, fn) {
  return traceCtx.run({ traceId: span.traceId, span }, () => {
    let result;
    try { result = fn(span); } catch (e) { span.end({ status: "error", error: e }); throw e; }
    if (isThenable(result)) {
      return Promise.resolve(result).then(
        (v) => { span.end(); return v; },
        (e) => { span.end({ status: "error", error: e }); throw e; },
      );
    }
    span.end();
    return result;
  });
}

/**
 * Run fn inside a NEW child span of the current span (fresh root when none).
 * @returns fn's value (sync) or a Promise resolving to it (async)
 */
export function withSpan(name, attributes, fn) {
  return executeIn(startSpan(name, attributes), fn);
}

/**
 * Run fn inside a ROOT-OR-CONTINUED span: `traceparent` (if present and
 * valid) supplies the remote trace id + parent span id — this is the WORKER
 * side of queue propagation. Invalid carriers degrade to a fresh root with a
 * diagnostic attribute; they never fail the job.
 */
export function runInTrace({ name, traceparent = null, attributes = {} } = {}, fn) {
  const remote = traceparent ? parseTraceparent(traceparent) : null;
  const attrs = remote ? { ...attributes } : { ...attributes, "trace.remote_parent": traceparent ? "invalid_traceparent" : "none" };
  const span = new Span({
    traceId: remote?.traceId || randomTraceId(),
    parentSpanId: remote?.spanId ?? null,
    name,
    attributes: attrs,
  });
  return executeIn(span, fn);
}

// ---- boundary helpers (the actual queue → worker plumbing) ------------------

/**
 * PRODUCER side: return the payload to enqueue WITH the current span's
 * traceparent attached. The queue treats payloads as opaque data, so this one
 * field is the entire cross-backend propagation contract.
 * Returns a shallow copy (never mutates the caller's payload).
 */
export function injectTraceparent(payload = {}) {
  const span = currentSpan();
  return { ...payload, traceparent: span ? span.traceparent : null };
}

/** Normalized traceparent of an arbitrary span/record, or null. */
export function traceparentOf(spanOrRecord) {
  if (!spanOrRecord?.traceId || !spanOrRecord?.spanId) return null;
  try {
    return formatTraceparent({ traceId: spanOrRecord.traceId, spanId: spanOrRecord.spanId, flags: "01" });
  } catch { return null; }
}

// report(status) protocol (src/queues/pipeline-job.js vocabulary) → span name
// — the SAME canonical stage names task_stages rows use (clone-worker.js)
export const STAGE_SPANS = {
  exploring: "stage.exploration",
  reconstructing: "stage.reconstruction",
  verifying: "stage.verification",
};
const TERMINAL_STATUSES = new Set(["completed", "completed_with_limitations", "error"]);

/**
 * WORKER side executor wrapper — THE queue→worker→stages propagation point.
 *
 * Wraps a clone-worker executor (the `(payload, { jobId, job, report }) => result`
 * contract startCloneWorker passes) so that:
 *   1. the job runs in a span continued from `payload.traceparent` (W3C) —
 *      or a fresh root when the payload carries none/invalid;
 *   2. each report() stage transition opens/closes a stage span
 *      (stage.exploration / stage.reconstruction / stage.verification),
 *      child of the job span;
 *   3. a thrown pipeline error marks the open stage span AND the job span
 *      as error status before propagating (BullMQ retry classification
 *      sees the same exception).
 */
export function tracedExecutor(baseExecutor, { jobSpanName = "worker.clone-job" } = {}) {
  return async function tracedJobExecutor(payload, ctx = {}) {
    const tp = payload && typeof payload === "object" ? payload.traceparent ?? null : null;
    return runInTrace(
      { name: jobSpanName, traceparent: tp, attributes: { "job.id": ctx?.jobId ?? null } },
      async () => {
        let open = null; // { span, name } — the currently running stage span
        const closeOpen = (status = "ok") => {
          if (!open) return;
          open.span.end({ status });
          open = null;
        };
        const report = (status, data = {}) => {
          const stage = STAGE_SPANS[status];
          if (stage) {
            closeOpen();
            open = { span: startSpan(stage, { status }) };
          } else if (TERMINAL_STATUSES.has(status)) {
            closeOpen(status === "error" ? "error" : "ok");
          }
          return ctx.report ? ctx.report(status, data) : undefined;
        };
        try {
          const result = await baseExecutor(payload, { ...ctx, report });
          closeOpen();
          return result;
        } catch (e) {
          closeOpen("error");
          throw e;
        }
      },
    );
  };
}
