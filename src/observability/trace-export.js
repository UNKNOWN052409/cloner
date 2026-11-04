// Span timing export (task 4.2.10) — JSON-lines sink for the span records
// emitted by trace-context.js, plus the readers/tree utilities tests and
// operator tooling use.
//
// Format: ONE span per line in <dir>/<file> (default artifacts/traces/traces.jsonl):
//   {"trace_id":"…32hex…","span_id":"…16hex…","parent_span_id":"…|null","name":"…",
//    "status":"ok|error","start_ms":1762…,"end_ms":1762…,"duration_ms":12,
//    "start_time":"2026-11-02T…Z","end_time":"2026-11-02T…Z","attributes":{…}}
// Lines are self-contained (a reader needs no index to rebuild any trace).
//
// Env wiring (see .env.example):
//   CLONER_TRACING=0        disable export entirely (ring buffer only)
//   CLONER_TRACE_DIR=<dir>  override the output dir (default <cwd>/artifacts/traces)
//   CLONER_TRACE_FILE=<f>   override the file name (default traces.jsonl)
//
// Writes are batched: spans buffer in memory and append in one fs write when
// the buffer reaches autoFlushAt lines, or on flush()/close(). Append-only —
// never rewrites the file, safe to tail. Sink failures are logged once and
// swallowed: observability must never fail the clone job.
import fs from "node:fs";
import path from "node:path";
import { setSpanSink } from "./trace-context.js";

export const DEFAULT_TRACE_DIR_SEGMENTS = ["artifacts", "traces"];
export const DEFAULT_TRACE_FILE = "traces.jsonl";
const FLUSH_AT_DEFAULT = 64;

/** Resolve the trace output directory/file from env (with product defaults). */
export function traceTargetFromEnv(env = process.env) {
  if (String(env.CLONER_TRACING) === "0") return null;
  const dir = env.CLONER_TRACE_DIR || path.join(process.cwd(), ...DEFAULT_TRACE_DIR_SEGMENTS);
  return { dir, file: path.join(dir, env.CLONER_TRACE_FILE || DEFAULT_TRACE_FILE) };
}

/**
 * Create a JSON-lines span sink.
 * @param {object} [opts]
 * @param {string} opts.dir            output directory (created recursively)
 * @param {string} [opts.fileName]     file name inside dir (default traces.jsonl)
 * @param {number} [opts.autoFlushAt]  buffer size that triggers an append (default 64)
 * @returns {{ handle(record): void, flush(): number, close(): void, file: string,
 *             written(): number, buffered(): number }}
 */
export function createJsonlSpanSink({ dir, fileName = DEFAULT_TRACE_FILE, autoFlushAt = FLUSH_AT_DEFAULT } = {}) {
  if (!dir || typeof dir !== "string") throw new Error("createJsonlSpanSink: dir is required");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, fileName);
  let buffer = [];
  let writes = 0;
  let warned = false;

  function flush() {
    if (!buffer.length) return 0;
    const chunk = buffer.join("");
    buffer = [];
    try {
      fs.appendFileSync(file, chunk, "utf8");
      writes += chunk.split("\n").filter(Boolean).length;
    } catch (e) {
      // observability must never fail the job — drop the chunk, warn once
      if (!warned) {
        console.warn(`[trace-export] span write to ${file} failed (${e?.message || e}) — spans dropped`);
        warned = true;
      }
    }
    return writes;
  }

  return {
    handle(record) {
      if (!record || typeof record !== "object") return;
      buffer.push(JSON.stringify(record) + "\n");
      if (buffer.length >= autoFlushAt) flush();
    },
    flush,
    close() { flush(); },
    file,
    written: () => writes,
    buffered: () => buffer.length,
  };
}

/**
 * Attach the env-configured sink as THE process-wide span consumer.
 * CLONER_TRACING=0 → no-op (returns null). Returns the attached sink.
 */
export function attachTraceSinkFromEnv(env = process.env) {
  const target = traceTargetFromEnv(env);
  if (!target) return null;
  const sink = createJsonlSpanSink({ dir: target.dir, fileName: path.basename(target.file) });
  setSpanSink(sink.handle);
  return sink;
}

/** Detach any span sink (tests / graceful shutdown). */
export function detachTraceSink() { setSpanSink(null); }

/**
 * Read a JSON-lines trace file back into span records. Throws with the
 * offending line number on malformed input (a truncated tail line is a data
 * error, not silently skipped).
 * @param {string} file
 * @returns {Array<object>}
 */
export function readSpans(file) {
  const text = fs.readFileSync(file, "utf8");
  const out = [];
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    try {
      out.push(JSON.parse(line));
    } catch (e) {
      throw new Error(`readSpans: malformed span JSON at ${file}:${i + 1} — ${e.message}`);
    }
  }
  return out;
}

/**
 * Group spans into per-trace trees.
 *   trace_id groups the set; each span with a parent_span_id resolvable
 *   inside the trace becomes a child node; spans with a null/unresolvable
 *   parent are roots (an unresolvable parent id ALSO lands the span in
 *   `orphans` so callers can assert trace integrity).
 * @param {Array<object>} spans
 * @returns {{ trees: Map<string, { traceId: string, roots: object[], nodes: Map<string, object>, size: number, spans: object[] }>,
 *             orphans: object[], count: number }}
 * node = { span, children: [] }
 */
export function buildTraceTrees(spans) {
  const byTrace = new Map();
  for (const span of spans || []) {
    if (!span?.trace_id || !span?.span_id) continue; // not a span record
    let t = byTrace.get(span.trace_id);
    if (!t) { t = { traceId: span.trace_id, nodes: new Map(), spans: [] }; byTrace.set(span.trace_id, t); }
    if (t.nodes.has(span.span_id)) continue; // duplicate span id — ignore replayed record
    t.nodes.set(span.span_id, { span, children: [] });
    t.spans.push(span);
  }
  const orphans = [];
  for (const t of byTrace.values()) {
    t.roots = [];
    for (const node of t.nodes.values()) {
      const pid = node.span.parent_span_id;
      if (pid && t.nodes.has(pid)) t.nodes.get(pid).children.push(node);
      else {
        t.roots.push(node);
        if (pid) orphans.push(node.span); // parent referenced but missing → broken chain
      }
    }
    t.size = t.spans.length;
  }
  return { trees: byTrace, orphans, count: (spans || []).length };
}

/** Human-readable tree (for test output / CLI inspection), e.g. root → child. */
export function describeTree(node, depth = 0, lines = []) {
  lines.push(`${"  ".repeat(depth)}${node.span.name}  (${node.span.duration_ms}ms, ${node.span.status})`);
  for (const child of node.children) describeTree(child, depth + 1, lines);
  return lines;
}
