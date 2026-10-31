// WebSocket session capture (task 3.4.4, step 1): hooks Playwright WS frames
// during exploration via page.on("websocket") and records, per frame,
// { url, direction, timestamp, payloadStructure } — the payload SHAPE with all
// values REDACTED by default.
//
// Redaction contract (frozen by the task):
//  - String values are NEVER stored. Every string becomes its type + length only.
//    (Exception: keys listed in opts.safeStringKeys — e.g. a public symbol code.)
//  - Numeric values ARE kept by default (keepNumbers: true): ticker/quote streams
//    are numeric and the replay contract (data-stream-replayer) reproduces the
//    observed sequence from them. keepNumbers: false restores full redaction.
//  - Boolean values are shape-only by default (keepBooleans: false).
//  - Object keys are kept (they are structure, not values) EXCEPT credential-named
//    keys (password/token/secret/...) whose value shape collapses to
//    { t: "redacted-credential" } with no length/type leak.
//  - URLs are sanitized: query values are stripped (param names survive) — tokens
//    travel in ?token= on real platforms (see src/platform/ws-auth.js), so a
//    captured socket URL must never carry one.
//  - Timestamps are recorded as absolute ISO (in-memory sink) but the exported
//    FIXTURE carries only relative millisecond offsets (t) — no wall clock, no PII.
//
// Non-JSON payloads are recorded as opaque ({ t: "text", len } / { t: "binary", len });
// their content is never stored (not even hashed into fixtures).
//
// Deterministic fixtures: exportWebSocketFixture / exportWebSocketSink are pure
// functions of the sink (same input → byte-identical output): stable key order,
// quantized relative offsets, no volatile fields.
//
// Integration hook (exploration pipeline, src/pipeline/exploration-pipeline.js) —
// three additive lines, applied by the integration agent:
//   import { attachWebSocketCapture, createWebSocketSink, exportWebSocketSink } from "../exploration/websocket-session-capture.js";
//   (right after attachNetworkRecorder(...).attach(page), ~line 83, BEFORE page.goto:)
//     const wsSink = createWebSocketSink();
//     attachWebSocketCapture(page, wsSink);
//   (right after the network flush, ~line 203:)
//     store.writeJson(`pages/${pageId}/websocket.json`, exportWebSocketSink(wsSink));
import crypto from "node:crypto";
import fs from "node:fs";

// Field names whose values must never survive capture in any shape.
const CRED_KEY_RE = /(password|passwd|secret|token|api[-_]?key|apikey|authorization|cookie|private[-_]?key|session[-_]?token|access[-_]?token|refresh[-_]?token|credential|bearer)/i;

export const DEFAULT_CAPTURE_OPTS = Object.freeze({
  keepNumbers: true,   // numbers survive (ticker contract); false → shape-only numbers
  keepBooleans: false, // booleans are shape-only by default
  safeStringKeys: [],  // exact key names whose string values may survive verbatim
  maxDepth: 6,         // deeper nesting collapses to { t: "truncated" }
  maxArrayItems: 8,    // arrays record their first N item shapes + true length
  maxPayloadAnalyzed: 64 * 1024, // larger payloads are recorded as opaque, un-analyzed
  maxEvents: 800,      // ring cap; overflow counts into sink.dropped, never throws
  quantizeMs: 10,      // exported relative offsets round to this grid
});

export const CAPTURE_SCHEMA = "1.0.0";

export function createWebSocketSink() {
  return { startedAt: null, sockets: 0, events: [], dropped: 0, opts: null };
}

// URL sanitizer: origin + path survive; query PARAM NAMES survive with values
// replaced (tokens ride the query on real platforms); hash is dropped.
export function sanitizeUrl(raw) {
  try {
    const u = new URL(String(raw));
    let out = u.protocol + "//" + u.host + u.pathname;
    const names = [...u.searchParams.keys()];
    if (names.length) out += "?" + names.map((n) => n + "=<redacted>").join("&");
    return out;
  } catch {
    return "<unparsable-url>";
  }
}

const isPlainObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

// shapeOfValue(value, key, depth, opts) → compact shape node. Strings never carry
// content; numbers carry their value only when keepNumbers (the ticker contract);
// credential-named keys collapse entirely.
function shapeOfValue(value, key, depth, opts) {
  if (key && CRED_KEY_RE.test(String(key))) return { t: "redacted-credential" };
  if (depth > opts.maxDepth) return { t: "truncated" };
  if (value === null) return { t: "null" };
  switch (typeof value) {
    case "number":
      return opts.keepNumbers && Number.isFinite(value) ? { t: "number", v: value } : { t: "number" };
    case "boolean":
      return opts.keepBooleans ? { t: "boolean", v: value } : { t: "boolean" };
    case "string":
      if (key && opts.safeStringKeys.includes(String(key))) return { t: "string", v: String(value).slice(0, 120) };
      return { t: "string", len: value.length };
    case "object": {
      if (Array.isArray(value)) {
        const items = [];
        const shown = Math.min(value.length, opts.maxArrayItems);
        for (let i = 0; i < shown; i++) items.push(shapeOfValue(value[i], null, depth + 1, opts));
        const shape = { t: "array", len: value.length, items };
        if (value.length > opts.maxArrayItems) shape.truncated = true;
        return shape;
      }
      if (!isPlainObject(value)) return { t: "opaque", len: 0 }; // Map/Set/Date/etc — no introspection
      const f = {};
      for (const k of Object.keys(value)) f[k] = shapeOfValue(value[k], k, depth + 1, opts);
      return { t: "object", f };
    }
    default:
      return { t: "opaque", len: 0 };
  }
}

// structureOf(payload, opts) — payload SHAPE of one frame. payload may be a
// string (JSON or text) or Buffer (binary). Content itself is NEVER returned.
export function structureOf(payload, opts = {}) {
  const o = { ...DEFAULT_CAPTURE_OPTS, ...(opts || {}) };
  if (Buffer.isBuffer(payload)) return { t: "binary", len: payload.length };
  if (typeof payload !== "string") {
    if (payload && typeof payload.length === "number") return { t: "binary", len: payload.length };
    return { t: "opaque", len: 0 };
  }
  if (payload.length > o.maxPayloadAnalyzed) return { t: "text", len: payload.length, truncated: true };
  let parsed;
  try { parsed = JSON.parse(payload); } catch { return { t: "text", len: payload.length }; }
  return shapeOfValue(parsed, null, 0, o);
}

// Walk a shape tree and collect the NUMERIC leaf values as flat "a.b.c" → number
// maps — the replayable part of a captured stream (strings are redacted, so a
// capture-derived sequence is numeric by construction).
export function flattenNumericStructure(shape, prefix = "", out = {}) {
  if (!shape || typeof shape !== "object") return out;
  if (shape.t === "number" && typeof shape.v === "number") {
    if (prefix) out[prefix] = shape.v;
    return out;
  }
  if (shape.t === "object" && shape.f) {
    for (const [k, child] of Object.entries(shape.f)) {
      const key = prefix ? prefix + "." + k : k;
      const safeKey = k.includes(".") ? k.replace(/\./g, "_") : k; // never widen the dot namespace
      flattenNumericStructure(child, prefix ? prefix + "." + safeKey : safeKey, out);
    }
    return out;
  }
  if (shape.t === "array" && Array.isArray(shape.items)) {
    shape.items.forEach((item, i) => flattenNumericStructure(item, prefix ? `${prefix}.${i}` : String(i), out));
  }
  return out;
}

// One event pushed per socket lifecycle + frame. Frame events carry exactly the
// ask's { url, direction, timestamp, payloadStructure } plus ordering helpers.
function pushEvent(sink, opts, evt) {
  if (sink.events.length >= opts.maxEvents) { sink.dropped++; return; }
  if (sink.startedAt === null) sink.startedAt = evt.at;
  sink.events.push({ ...evt, t: Math.max(0, evt.at - sink.startedAt) });
}

// attachWebSocketCapture(page, sink, opts) — page is any object that emits the
// Playwright "websocket" event (a real Playwright Page, or an EventEmitter in
// tests). Attach BEFORE navigation so the initial upgrade is captured.
// Returns sink (chainable). Never throws from handlers.
export function attachWebSocketCapture(page, sink, opts = {}) {
  const o = { ...DEFAULT_CAPTURE_OPTS, ...(opts || {}) };
  sink.opts = o;
  const payloadOf = (frame) => {
    try {
      const p = typeof frame?.payload === "function" ? frame.payload() : frame?.payload;
      return p;
    } catch { return null; }
  };
  page.on("websocket", (ws) => {
    let socketId;
    try { socketId = ++sink.sockets; } catch { socketId = 0; }
    const url = sanitizeUrl(ws && ws.url ? ws.url() : "");
    pushEvent(sink, o, { kind: "socket", url, direction: null, timestamp: new Date().toISOString(), at: Date.now(), socketId });
    const onFrame = (direction) => (frame) => {
      const payload = payloadOf(frame);
      pushEvent(sink, o, {
        kind: "frame",
        url,
        direction, // "in" = received, "out" = sent
        timestamp: new Date().toISOString(),
        at: Date.now(),
        socketId,
        payloadStructure: payload === null ? { t: "unavailable" } : structureOf(payload, o),
      });
    };
    try {
      ws.on("framereceived", onFrame("in"));
      ws.on("framesent", onFrame("out"));
      ws.on("close", () => pushEvent(sink, o, { kind: "close", url, direction: null, timestamp: new Date().toISOString(), at: Date.now(), socketId }));
      ws.on("socketerror", () => pushEvent(sink, o, { kind: "error", url, direction: null, timestamp: new Date().toISOString(), at: Date.now(), socketId }));
    } catch { /* a malformed socket object must not break the session */ }
  });
  return sink;
}

// Stable stringify: object keys sorted recursively, arrays in order — the basis
// of byte-identical fixture exports.
export function stableStringify(value) {
  if (Array.isArray(value)) return "[" + value.map((v) => (v === undefined ? "null" : stableStringify(v))).join(",") + "]";
  if (value && typeof value === "object") {
    const keys = Object.keys(value).sort();
    return "{" + keys.map((k) => JSON.stringify(k) + ":" + stableStringify(value[k])).join(",") + "}";
  }
  return JSON.stringify(value);
}

// exportWebSocketSink(sink, opts) → sanitized, deterministic fixture OBJECT.
// Pure: no wall clock, no absolute timestamps, relative offsets quantized.
export function exportWebSocketSink(sink, opts = {}) {
  const o = { ...DEFAULT_CAPTURE_OPTS, ...(opts || {}) };
  const events = Array.isArray(sink?.events) ? sink.events : [];
  const channels = [];
  const bySocket = new Map();
  for (const e of events) {
    if (!bySocket.has(e.socketId)) {
      bySocket.set(e.socketId, { id: "ws-" + e.socketId, url: e.url, framesIn: 0, framesOut: 0, closes: 0 });
      channels.push(bySocket.get(e.socketId));
    }
    const ch = bySocket.get(e.socketId);
    if (e.kind === "frame") { if (e.direction === "in") ch.framesIn++; else if (e.direction === "out") ch.framesOut++; }
    else if (e.kind === "close") ch.closes++;
  }
  const q = (t) => Math.round(Number(t || 0) / o.quantizeMs) * o.quantizeMs;
  const out = {
    schemaVersion: CAPTURE_SCHEMA,
    generator: "websocket-session-capture",
    redacted: true,
    keepNumbers: o.keepNumbers,
    channelCount: channels.length,
    channels,
    dropped: sink?.dropped || 0,
    events: events.map((e) => {
      const rec = { kind: e.kind, url: e.url, direction: e.direction ?? null, t: q(e.t), socketId: e.socketId };
      if (e.kind === "frame") rec.payloadStructure = e.payloadStructure ?? null;
      return rec;
    }),
  };
  return out;
}

// exportWebSocketFixture(sink, filePath, opts) — write the sanitized fixture as
// stable JSON (byte-identical for identical sinks). Returns the fixture object.
export function exportWebSocketFixture(sink, filePath, opts = {}) {
  const fixture = exportWebSocketSink(sink, opts);
  if (filePath) fs.writeFileSync(filePath, stableStringify(fixture));
  return fixture;
}

// Channel id from a sanitized socket URL: the last path segment, slugified
// ("/ws" → "ws"). Kept in sync with stateful-widget-builder.channelFromUrl.
function urlChannelId(url) {
  let seg = "ws";
  try { seg = new URL(String(url)).pathname.split("/").filter(Boolean).pop() || "ws"; } catch {}
  return String(seg).toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "ws";
}

// sequenceFromCapture(events, opts) → replayer channel specs built from captured
// events (data-stream-replayer contract). Per socket: open → connect, close →
// disconnect, a later socket on the same url → reconnect; inbound frames become
// { type: "message", data } with their NUMERIC leaves flattened (capture-derived
// sequences are numeric-only by the redaction contract). Returns { channels }.
export function sequenceFromCapture(events, opts = {}) {
  const maxMessages = opts.maxMessages || 400;
  const frames = (Array.isArray(events) ? events : []).filter((e) => e && typeof e.t === "number");
  const byUrl = new Map(); // sanitized url → channel
  for (const e of frames) {
    if (!byUrl.has(e.url)) byUrl.set(e.url, { id: opts.channelId || urlChannelId(e.url), url: e.url, sockets: [], events: [] });
  }
  // walk chronologically; track open/closed state per channel
  const state = new Map(); // url → { open: bool, socketCount, lastSocketId }
  for (const e of frames) {
    const ch = byUrl.get(e.url);
    const st = state.get(e.url) || { open: false, socketsSeen: new Set() };
    state.set(e.url, st);
    if (e.kind === "socket") {
      st.socketsSeen.add(e.socketId);
      if (st.open) continue; // duplicate open event for the same socket
      st.open = true;
      // first open of this channel → connect; a fresh socket after a close → reconnect
      if (st.socketsSeen.size > 1 && ch.events.length) ch.events.push({ t: e.t, type: "reconnect" });
      else if (!ch.events.length) ch.events.push({ t: e.t, type: "connect" });
    } else if (e.kind === "close" || e.kind === "error") {
      if (!st.open) continue;
      st.open = false;
      ch.events.push({ t: e.t, type: "disconnect" });
    } else if (e.kind === "frame" && e.direction === "in") {
      const data = flattenNumericStructure(e.payloadStructure);
      if (!Object.keys(data).length) continue; // hello/pong-ish frames carry no replayable values
      if (ch.events.filter((x) => x.type === "message").length >= maxMessages) continue;
      ch.events.push({ t: e.t, type: "message", data });
    }
  }
  return { channels: [...byUrl.values()].map((c) => ({ id: c.id, transport: "replay", url: c.url, loop: false, events: c.events.sort((a, b) => a.t - b.t || 0) })) };
}

// Identity helper for dedup/diff tooling: content hash of a frame payload —
// deliberately NOT part of exported fixtures (identity only, never replayed data).
export function payloadFingerprint(payload) {
  const buf = Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload ?? ""), "utf8");
  return crypto.createHash("sha256").update(buf).digest("hex").slice(0, 16);
}
