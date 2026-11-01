// Application state capture (task 3.5.3, step 1): records URL-driven, nested
// and persistent UI state during exploration so reconstruction can restore it.
//
// Three state sources, captured per state (per route visit / per interaction):
//   - URL state: pathname + query params + hash route (hash path + hash query)
//   - session state: sessionStorage keys (names + sanitized scalar values)
//   - local UI state: localStorage keys (names + sanitized scalar values)
//
// Redaction contract (mirrors websocket-session-capture.js):
//  - storage values are captured only for scalar values (string/number/boolean),
//    capped, and NEVER for credential-named keys (password/token/secret/... —
//    their presence is recorded with a redacted marker instead of the value);
//  - query/hash values are NOT redacted by default — URL state is exactly the
//    thing this task must replay — but keepQueryValues: false restores the
//    websocket capture's `name=<redacted>` shape;
//  - exportApplicationState is a pure function of the sink: same input →
//    byte-identical fixture (stableStringify, relative ms offsets, quantized).
//
// In-page probe: the capture script runs inside the page and must be
// self-contained. It reads, in order of preference:
//   1. window.__STATEFUL_STATE() — the app's own debug probe when one exists
//      (the stateful-app.mjs fixture exposes cat/sort/page/view/theme as one
//      JSON object; real apps with a debug API get richer evidence for free);
//   2. URL + storage + [data-cloner-state] marked inputs — the generic path
//      (a form control the explorer pre-marked, e.g. the sort <select>, is
//      reported with its id/class/value so the builder can restore it).
//
// Integration hook (exploration pipeline, src/pipeline/exploration-pipeline.js,
// applied by the integration agent — additive, three lines):
//   import { createApplicationStateSink, attachApplicationStateCapture, exportApplicationState, APPLICATION_STATE_SCRIPT } from "../exploration/application-state-capture.js";
//   (next to the wsSink lines, BEFORE page.goto: ~line 91)
//     const appStateSink = createApplicationStateSink();
//   (in exploreRoute, right before the graph.addState root node ~line 229:)
//     const appState = await attachApplicationStateCapture(page, appStateSink, { phase: "route", label: pageId });
//   (next to the websocket.json write ~line 217:)
//     store.writeJson(`pages/${pageId}/application-state.json`, exportApplicationState(appStateSink));
//     appStateSink.events = []; appStateSink.dropped = 0;
// exploration/state-discovery.js stays READ-ONLY in this wave (Wave 2 owns it);
// the graph nodes already carry url + interaction labels the builder pairs with.
import crypto from "node:crypto";

const CRED_KEY_RE = /(password|passwd|secret|token|api[-_]?key|apikey|authorization|cookie|private[-_]?key|session[-_]?token|access[-_]?token|refresh[-_]?token|credential|bearer)/i;

export const APP_STATE_SCHEMA = "1.0.0";

export const DEFAULT_APP_STATE_OPTS = Object.freeze({
  keepQueryValues: true,   // false → query/hash param values become <redacted>
  maxStorageEntries: 24,   // per namespace; overflow counted, never thrown
  maxStorageValueLen: 120, // scalar string values are capped
  maxEvents: 400,          // ring cap; overflow counts into sink.dropped
  quantizeMs: 10,          // exported relative offsets round to this grid
  storageNamespaces: ["localStorage", "sessionStorage"],
  maxParams: 24,           // query/hash params recorded per state
});

export function createApplicationStateSink() {
  return { startedAt: null, events: [], dropped: 0, opts: null };
}

function pushEvent(sink, opts, evt) {
  if (sink.events.length >= opts.maxEvents) { sink.dropped++; return; }
  if (sink.startedAt === null) sink.startedAt = evt.at;
  sink.events.push({ ...evt, t: Math.max(0, evt.at - sink.startedAt) });
}

// sanitizeParamValue — keepQueryValues: false → "<redacted>" for param values.
function sanitizeParamValue(v, opts) {
  const s = String(v ?? "");
  return opts.keepQueryValues ? s.slice(0, 120) : "<redacted>";
}

// storageSnapshot(ns, opts) — in-page helper: names + sanitized scalar values.
// Credential-named keys record presence only ({ redacted: true }).
export const STORAGE_SNAPSHOT_SOURCE = String.raw`(function (ns, opts) {
  var out = {};
  var store;
  try { store = window[ns]; } catch (e) { return out; }
  if (!store) return out;
  var names = [];
  try { for (var i = 0; i < store.length; i++) names.push(store.key(i)); } catch (e) {}
  names = names.slice(0, opts.maxStorageEntries);
  var CRED = /(password|passwd|secret|token|api[-_]?key|apikey|authorization|cookie|private[-_]?key|session[-_]?token|access[-_]?token|refresh[-_]?token|credential|bearer)/i;
  for (var k = 0; k < names.length; k++) {
    var name = String(names[k]);
    var raw = null;
    try { raw = store.getItem(name); } catch (e) { raw = null; }
    if (raw === null) { out[name] = { absent: true }; continue; }
    if (CRED.test(name)) { out[name] = { redacted: true, len: raw.length }; continue; }
    if (typeof raw === "string" && raw.length <= opts.maxStorageValueLen) {
      var t = /^-?\d+(\.\d+)?$/.test(raw) ? "number" : (raw === "true" || raw === "false") ? "boolean" : "string";
      out[name] = t === "string" ? { t: "string", v: raw } : { t: t, v: t === "number" ? Number(raw) : raw === "true" };
    } else {
      out[name] = { t: "string", len: raw.length, truncated: true };
    }
  }
  return out;
})`;

// probe script source (evaluated as a function via new Function) — reads the
// app probe when present, URL + storage + marked inputs otherwise.
export const APP_STATE_SCRIPT_SOURCE = String.raw`(function (opts) {
  var out = { url: location.href, probe: null, params: null, storage: {}, controls: [] };
  try {
    if (typeof window.__STATEFUL_STATE === "function") out.probe = window.__STATEFUL_STATE();
  } catch (e) { out.probe = null; }
  try {
    var u = new URL(location.href);
    var q = {};
    var n = 0;
    u.searchParams.forEach(function (v, k) { if (n++ < opts.maxParams) q[k] = opts.keepQueryValues ? String(v).slice(0, 120) : "<redacted>"; });
    var h = {};
    n = 0;
    var hq = u.hash.indexOf("?");
    if (hq >= 0) {
      var hp = new URLSearchParams(u.hash.slice(hq + 1));
      hp.forEach(function (v, k) { if (n++ < opts.maxParams) h[k] = opts.keepQueryValues ? String(v).slice(0, 120) : "<redacted>"; });
    }
    out.params = { query: q, hashPath: hq >= 0 ? u.hash.slice(0, hq) : u.hash, hashQuery: h };
  } catch (e) { out.params = null; }
  var namespaces = opts.storageNamespaces || ["localStorage", "sessionStorage"];
  for (var i = 0; i < namespaces.length; i++) {
    out.storage[namespaces[i]] = (${STORAGE_SNAPSHOT_SOURCE})(namespaces[i], opts);
  }
  try {
    var marked = document.querySelectorAll("[data-cloner-state]");
    var seen = 0;
    for (var m = 0; m < marked.length && seen < 24; m++) {
      var el = marked[m];
      var tag = String(el.tagName || "").toLowerCase();
      if (tag !== "input" && tag !== "select" && tag !== "textarea") continue;
      seen++;
      out.controls.push({
        tag: tag,
        id: el.id || null,
        cls: String(el.className || "").slice(0, 60) || null,
        type: el.getAttribute("type") || null,
        value: typeof el.value === "string" ? el.value.slice(0, 120) : null,
        checked: !!el.checked,
      });
    }
  } catch (e) {}
  return out;
})`;

// compile once per call site — the sources are exported so tests can also
// evaluate them directly; attaching uses the compiled function. The wrapper
// form gives Playwright a plain `function anonymous(opts) {...}` to stringify
// (no inner-expression parsing surprises).
function compileProbe() {
  return new Function("opts", "return (" + APP_STATE_SCRIPT_SOURCE + ")(opts);");
}

// attachApplicationStateCapture(page, sink, opts) — records ONE state observation
// from the live page (evaluate). `page` is anything with .evaluate (a real
// Playwright Page in the pipeline; a stub in tests). Never throws: on failure it
// records an { error } event so the artifact always exists (honest absence).
// opts: { phase: "route"|"interaction"|"manual", label, ...DEFAULT_APP_STATE_OPTS }
// Returns the normalized observation { phase, label, url, params, probe,
// storage, controls } (or null when nothing could be read).
export async function attachApplicationStateCapture(page, sink, opts = {}) {
  const o = { ...DEFAULT_APP_STATE_OPTS, ...(opts || {}) };
  sink.opts = o;
  let observation = null;
  try {
    observation = await page.evaluate(compileProbe(), o);
  } catch (e) {
    pushEvent(sink, o, { kind: "error", phase: o.phase || "manual", label: o.label || null, message: String(e?.message || e).slice(0, 120), at: Date.now() });
    return null;
  }
  if (!observation || typeof observation !== "object") return null;
  const evt = {
    kind: "state",
    phase: o.phase || "manual",
    label: o.label || null,
    url: observation.url,
    params: observation.params,
    probe: observation.probe ?? null,
    storage: observation.storage || {},
    controls: observation.controls || [],
    at: Date.now(),
  };
  pushEvent(sink, o, evt);
  return evt;
}

// quantized export — pure function of the sink (byte-identical for identical
// observations). Storage maps and params are key-sorted via stableStringify.
export function exportApplicationState(sink, opts = {}) {
  const o = { ...(sink?.opts || DEFAULT_APP_STATE_OPTS), ...(opts || {}) };
  const events = Array.isArray(sink?.events) ? sink.events : [];
  const q = (t) => Math.round(Number(t || 0) / o.quantizeMs) * o.quantizeMs;
  const states = events.filter((e) => e.kind === "state").map((e) => ({
    phase: e.phase,
    label: e.label ?? null,
    t: q(e.t),
    url: e.url,
    params: e.params,
    probe: e.probe,
    storage: e.storage,
    controls: e.controls,
  }));
  return {
    schemaVersion: APP_STATE_SCHEMA,
    generator: "application-state-capture",
    errors: events.filter((e) => e.kind === "error").map((e) => ({ phase: e.phase, label: e.label, message: e.message })),
    dropped: sink?.dropped || 0,
    stateCount: states.length,
    states,
  };
}

// parseStateUrl(url) → { pathname, search, hashPath, hashQuery } — the URL
// decomposition the builder keys on. Pure; used by tests + builder.
export function parseStateUrl(url) {
  try {
    const u = new URL(String(url));
    const hq = u.hash.indexOf("?");
    return {
      pathname: u.pathname,
      search: u.search,
      hashPath: hq >= 0 ? u.hash.slice(0, hq) : u.hash,
      hashQuery: hq >= 0 ? Object.fromEntries(new URLSearchParams(u.hash.slice(hq + 1))) : {},
    };
  } catch {
    return null;
  }
}

export function appStateFingerprint(observation) {
  return crypto.createHash("sha1").update(JSON.stringify(observation && observation.url)).digest("hex").slice(0, 16);
}
