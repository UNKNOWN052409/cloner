// Data-stream replayer (task 3.4.4, step 2): the generated-runtime companion to
// websocket-session-capture. A captured/synthetic message sequence (relative
// timing, transport-independent) is EMBEDDED into the clone as
// runtime/streams.js; a small ES5 runtime — pattern-matched on
// src/runtimeTemplate.js (read-only, String.raw IIFE, delegated matching) —
// applies the sequence to marked widgets on load.
//
// Widget marking contract (attrs the generator/planner adds to the clone):
//   data-stream-target="channel.key"  → element receives the value (textContent,
//                                       or attribute data-stream-attr="name").
//                                       A bare "key" binds to the FIRST channel.
//   data-stream-status="channel|*"    → element mirrors transport state in
//                                       data-stream-state="connected|disconnected|
//                                       paused"; after a reconnect it also carries
//                                       data-stream-held="<n>" (n held/delayed
//                                       updates flushed on reconnect).
// Direction feedback: numeric updates add stream-up / stream-down / stream-flat
// to the element (kept until the next update — deterministic final state).
//
// Timeline events (per channel, sorted by relative t ms):
//   { t, type: "message",    data: { "a.b": value, ... } }  apply to targets
//   { t, type: "disconnect" }                                socket down; later
//                                                            messages are HELD
//   { t, type: "reconnect" }                                 socket up; held
//                                                            messages flush in
//                                                            order (delayed states)
//   { t, type: "pause" } / { t, type: "resume" }             same hold mechanics,
//                                                            state shown as "paused"
//   { t, type: "connect" }                                   initial open (no-op)
// loop: true restarts the sequence (counters/tickers that never stop). A looping
// channel never sets the DONE flag — that is the author's explicit choice.
//
// Replay is fully offline: the runtime performs NO fetch/XHR/WebSocket — the
// sequence is embedded JSON.
//
// Integration hooks (applied by the integration agent, additive):
//  - reconstruction-pipeline.js: build the channels once per artifacts dir and
//    pass the wiring through cssCtx (see stateful-widget-builder.buildStreamPlan):
//      const streamPlan = buildStreamPlan(artifactsDir, { capture: wsCapture });
//  - generation/project-generator.js renderNode (after the data-replay-id wiring):
//      const streamTarget = cssCtx.streamByIndex?.get(node._elementIndex);
//      if (streamTarget) attrs += ` data-stream-target="${esc(streamTarget)}"`;
//  - project-generator.generateProject (next to runtime/interactions.js):
//      fs.writeFileSync(path.join(outDir, "runtime", "streams.js"), buildStreamRuntime(streamPlan.channelSpecs));
import { stableStringify } from "../exploration/websocket-session-capture.js";

export const STREAM_SCHEMA = "1.0.0";
export const STREAM_TARGET_ATTR = "data-stream-target";
export const STREAM_STATUS_ATTR = "data-stream-status";
export const STREAM_STATE_ATTR = "data-stream-state";
const EVENT_TYPES = ["message", "disconnect", "reconnect", "pause", "resume", "connect"];

// Channel ids share the "channel.key" namespace with data keys — dots are the
// separator, so an id containing one could never be addressed.
export function sanitizeChannelId(id) {
  return String(id || "stream").toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "stream";
}

const SCALAR = (v) => v === null || ["number", "string", "boolean"].includes(typeof v);

// normalizeChannels(channels): coerce + sort (stable by t), sanitize ids, return
// a fresh embedded-ready structure. Invalid events are DROPPED (counted), never
// silently reinterpreted — validateTimeline is the honest pre-flight.
export function normalizeChannels(channels) {
  const out = [];
  const seen = new Set();
  for (const ch of Array.isArray(channels) ? channels : []) {
    if (!ch || typeof ch !== "object") continue;
    const id = sanitizeChannelId(ch.id);
    if (seen.has(id)) continue;
    seen.add(id);
    const events = [];
    let dropped = 0;
    for (const e of Array.isArray(ch.events) ? ch.events : []) {
      const t = Math.round(Number(e?.t));
      if (!Number.isFinite(t) || t < 0 || !EVENT_TYPES.includes(e?.type)) { dropped++; continue; }
      if (e.type === "message") {
        const data = e.data;
        if (!data || typeof data !== "object" || Array.isArray(data)) { dropped++; continue; }
        const flat = {};
        let bad = false;
        for (const [k, v] of Object.entries(data)) {
          if (!SCALAR(v)) { bad = true; break; } // nested payloads must be flattened first
          flat[String(k)] = v;
        }
        if (bad || !Object.keys(flat).length) { dropped++; continue; }
        events.push({ t, type: "message", data: flat });
      } else {
        events.push({ t, type: e.type });
      }
    }
    events.sort((a, b) => a.t - b.t);
    out.push({
      id,
      transport: "replay",
      url: typeof ch.url === "string" ? ch.url : null,
      loop: ch.loop === true,
      loopGap: Math.max(50, Number(ch.loopGap) || 500),
      events,
      dropped,
    });
  }
  return { schema: STREAM_SCHEMA, channels: out };
}

// validateTimeline(channels) → { ok, errors, warnings, stats }. Pure. Errors are
// hard contract violations (would produce a broken/deceptive clone); warnings are
// legal-but-noteworthy shapes. Credential-shaped data keys are a HARD error —
// sensitive payloads must never reach a fixture or a clone.
const CRED_KEY_RE = /(password|passwd|secret|token|api[-_]?key|apikey|authorization|cookie|private[-_]?key|credential|bearer)/i;

export function validateTimeline(channels) {
  const errors = [];
  const warnings = [];
  const stats = { channels: 0, messages: 0, disconnects: 0, reconnects: 0 };
  if (!Array.isArray(channels)) {
    return { ok: false, errors: ["channels must be an array"], warnings, stats };
  }
  const seen = new Set();
  for (const ch of channels) {
    const label = ch?.id ?? "<missing-id>";
    if (!ch || typeof ch !== "object") { errors.push(`${label}: channel must be an object`); continue; }
    if (typeof ch.id !== "string" || !ch.id) errors.push(`${label}: channel.id must be a non-empty string`);
    const id = sanitizeChannelId(ch.id);
    if (id.includes(".")) errors.push(`${label}: channel id must not contain "." (key namespace separator)`);
    if (seen.has(id)) errors.push(`${id}: duplicate channel id`);
    seen.add(id);
    stats.channels++;
    if (!Array.isArray(ch.events)) { errors.push(`${id}: events must be an array`); continue; }
    let open = false;
    let lastT = -1;
    for (let i = 0; i < ch.events.length; i++) {
      const e = ch.events[i];
      const t = Number(e?.t);
      if (!Number.isFinite(t) || t < 0) { errors.push(`${id}[${i}]: event.t must be a finite t >= 0`); continue; }
      if (t < lastT) warnings.push(`${id}[${i}]: events are not sorted by t (normalizeChannels fixes this)`);
      lastT = t;
      if (!EVENT_TYPES.includes(e?.type)) { errors.push(`${id}[${i}]: unknown event type "${e?.type}"`); continue; }
      if (e.type === "message") {
        stats.messages++;
        if (!e.data || typeof e.data !== "object" || Array.isArray(e.data) || !Object.keys(e.data).length) {
          errors.push(`${id}[${i}]: message.data must be a non-empty flat object`);
        } else {
          for (const [k, v] of Object.entries(e.data)) {
            if (!SCALAR(v)) errors.push(`${id}[${i}]: data.${k} is not scalar — flatten nested payloads first`);
            if (CRED_KEY_RE.test(k)) errors.push(`${id}[${i}]: data key "${k}" looks like a credential — sensitive payloads are forbidden in streams`);
          }
        }
      } else if (e.type === "disconnect") {
        stats.disconnects++;
        open = false;
      } else if (e.type === "reconnect") {
        stats.reconnects++;
        if (!open && i > 0 && !ch.events.slice(0, i).some((x) => x.type === "disconnect")) {
          warnings.push(`${id}[${i}]: reconnect without a preceding disconnect`);
        }
        open = true;
      }
    }
    if (stats.disconnects && !stats.reconnects) warnings.push(`${id}: ends disconnected — the clone will stay in the disconnected state`);
  }
  return { ok: errors.length === 0, errors, warnings, stats };
}

// flattenData(data, prefix) — dot-path flatten of an author-supplied payload
// (numbers/strings/booleans survive; arrays become indexed paths). Capture-derived
// sequences never contain strings (redaction contract); author-supplied label
// strings are the reconstruction agent's explicit choice.
export function flattenData(data, prefix = "", out = {}) {
  if (data === null || typeof data !== "object") {
    if (prefix) out[prefix] = data;
    return out;
  }
  if (Array.isArray(data)) {
    data.forEach((v, i) => flattenData(v, prefix ? `${prefix}.${i}` : String(i), out));
    return out;
  }
  for (const [k, v] of Object.entries(data)) {
    const key = prefix ? `${prefix}.${String(k).replace(/\./g, "_")}` : String(k).replace(/\./g, "_");
    flattenData(v, key, out);
  }
  return out;
}

// The generated runtime (String.raw ES5 IIFE, mirrors src/runtimeTemplate.js style).
const RUNTIME = String.raw`(function () {
  var CFG = window.__CLONER_STREAMS || {};
  var CHANNELS = CFG.channels || [];
  var LOG_MAX = 500;
  var LOG = [];
  window.__CLONER_STREAM_LOG = LOG;
  window.__CLONER_STREAMS_DONE = false;
  function log(e) { if (LOG.length < LOG_MAX) LOG.push(e); }

  // ---- widget resolution: static clone, resolve once at load ----
  var byKey = {};
  var targets = document.querySelectorAll("[data-stream-target]");
  for (var i = 0; i < targets.length; i++) {
    var el = targets[i];
    var key = el.getAttribute("data-stream-target") || "";
    if (!key) continue;
    if (key.indexOf(".") < 0 && CHANNELS.length) key = CHANNELS[0].id + "." + key;
    el.__streamKey = key;
    (byKey[key] = byKey[key] || []).push(el);
  }
  var statusEls = [];
  var sels = document.querySelectorAll("[data-stream-status]");
  for (var s = 0; s < sels.length; s++) statusEls.push(sels[s]);

  var lastNumeric = {};

  function applyValue(el, v) {
    var attr = el.getAttribute("data-stream-attr");
    if (attr) el.setAttribute(attr, String(v)); else el.textContent = String(v);
    var n = Number(v);
    if (isFinite(n) && String(v).trim() !== "") {
      var prev = lastNumeric[el.__streamKey];
      var dir = prev === undefined ? null : (n > prev ? "stream-up" : (n < prev ? "stream-down" : "stream-flat"));
      if (dir) {
        el.classList.remove("stream-up", "stream-down", "stream-flat");
        el.classList.add(dir);
      }
      lastNumeric[el.__streamKey] = n;
    }
  }

  function applyData(chId, data, t) {
    var applied = 0;
    for (var key in data) {
      if (!Object.prototype.hasOwnProperty.call(data, key)) continue;
      var full = chId + "." + key;
      var list = byKey[full];
      if (!list) continue;
      for (var j = 0; j < list.length; j++) applyValue(list[j], data[key]);
      applied++;
      log({ t: t, type: "update", key: full, value: data[key] });
    }
    return applied;
  }

  function setState(state, chId, heldCount, t) {
    for (var i = 0; i < statusEls.length; i++) {
      var el = statusEls[i];
      var scope = el.getAttribute("data-stream-status");
      if (scope !== "*" && scope !== chId) continue;
      el.setAttribute("data-stream-state", state);
      if (state === "connected" && heldCount != null) el.setAttribute("data-stream-held", String(heldCount));
    }
    log({ t: t, type: "state", channel: chId, value: state });
  }

  // held (delayed) updates flush IN ORDER at reconnect — original t kept in the log
  function flushHeld(chId, held, t) {
    var n = held.length;
    for (var i = 0; i < held.length; i++) applyData(chId, held[i].data, held[i].t);
    if (n) log({ t: t, type: "flush", channel: chId, count: n });
    return n;
  }

  // ---- per-channel runner: one setTimeout chain over relative deltas ----
  var pending = 0;
  function runChannel(ch) {
    var events = ch.events || [];
    if (!events.length) return;
    pending++;
    var chId = ch.id;
    var idx = 0;
    var state = "connected";
    var held = [];
    var cycle = 0;
    var cycleLen = events[events.length - 1].t + (ch.loopGap || 500);
    function timeOf(ev) { return ev.t + cycle * cycleLen; }
    function step() {
      if (idx >= events.length) {
        if (ch.loop) { cycle++; idx = 0; setTimeout(step, (ch.loopGap || 500) + Math.max(0, events[0].t)); return; }
        if (--pending === 0) { window.__CLONER_STREAMS_DONE = true; log({ t: 0, type: "done" }); }
        return;
      }
      var ev = events[idx++];
      var t = timeOf(ev);
      if (ev.type === "message") {
        if (state === "connected") applyData(chId, ev.data || {}, t);
        else { held.push(ev); log({ t: t, type: "held", channel: chId }); }
      } else if (ev.type === "disconnect") {
        state = "disconnected"; setState("disconnected", chId, null, t);
      } else if (ev.type === "pause") {
        state = "paused"; setState("paused", chId, null, t);
      } else if (ev.type === "resume") {
        state = "connected";
        var resumed = flushHeld(chId, held, t);
        held = [];
        setState("connected", chId, resumed, t);
      } else if (ev.type === "reconnect") {
        // state transition FIRST, then the delayed backlog replays in order —
        // the log reads: connected(held=N) → the N held updates → flush entry
        state = "connected";
        var pendingHeld = held.length;
        setState("connected", chId, pendingHeld, t);
        flushHeld(chId, held, t);
        held = [];
      } // "connect": initial open — the runner already starts connected
      var next = events[idx];
      if (next) setTimeout(step, Math.max(0, timeOf(next) - t));
      else setTimeout(step, ch.loop ? (ch.loopGap || 500) : 0); // loop restart or onDone
    }
    setTimeout(step, Math.max(0, events[0].t));
  }
  for (var c = 0; c < CHANNELS.length; c++) runChannel(CHANNELS[c]);
  if (pending === 0) { window.__CLONER_STREAMS_DONE = true; log({ t: 0, type: "done" }); }
})();`;

// buildStreamRuntime(channels, opts) → the runtime/streams.js source:
// embedded (normalized) channel specs + the ES5 replay IIFE. Deterministic:
// stable key order via stableStringify.
export function buildStreamRuntime(channels, opts = {}) {
  const normalized = normalizeChannels(channels);
  return (
    "// generated by data-stream-replayer (task 3.4.4) — embedded replay, no network\n" +
    "window.__CLONER_STREAMS = " +
    stableStringify(normalized) +
    ";\n" +
    RUNTIME
  );
}
