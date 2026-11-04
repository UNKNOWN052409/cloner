// Plugin framework (task 4.2.14): a controlled extension architecture for
// first-party integrations that react to reconstruction lifecycle events.
//
// Execution-security posture (plan §4.2.14 risk note: "a plugin system is an
// execution-security problem"):
//   • NO third-party code is ever loaded into the control plane. register()
//     requires manifest.codePolicy === "in-process-first-party" and in-process
//     handler functions that the host application itself imported. There is no
//     loader, no eval, no module resolution from user input — the framework
//     only calls handlers it was handed by trusted first-party code.
//   • Every plugin declares PERMISSION SCOPES from the allowlist below. Hook
//     dispatch only reaches a plugin that holds the matching event scope, and
//     the payload is REDACTED to that scope (base ids only, unless the plugin
//     also holds data:task.summary / data:task.details). A scope grant cannot
//     be widened at dispatch time; setPermissions() is the only mutation.
//   • Dispatch is fail-open for the BUSINESS flow and fail-closed for the
//     plugin: a crashing or hung handler is recorded and skipped, it can
//     never break a task, a quota decision or the HTTP handler that triggered
//     the hook. Per-handler timeout (PLUGIN_HOOK_TIMEOUT_MS, default 2000ms)
//     bounds the worst case.
//   • Every dispatch outcome is appended to an in-memory ring + an optional
//     caller-supplied audit sink (async fn), so integrator wiring can route
//     events into the hash-chained 4.0.9 audit trail without this module
//     importing database code.
//
// Integrator wiring (src/platform/server.js is integrator-owned — additive
// lines only):
//
//   import { createPluginRegistry } from "../integrations/plugin-framework.js";
//   const plugins = createPluginRegistry({ audit: (e) => recordAuditEventSafe(e) });
//   plugins.attachEventBus(bus);                       // run:done / run:error → hooks
//   // quota-middleware.js rejection path (one line, integrator-owned file):
//   //   plugins.notifyQuotaDeny({ scope, userId, orgId, reason, limit, used, requested });
//
// This module never blocks startup and never throws out of dispatch().
import { EventEmitter } from "node:events";

// Permission scope allowlist (versioned like AUDIT_ACTIONS — unknown scopes
// are rejected at registration; adding one is a deliberate schema change).
export const PLUGIN_SCOPES = Object.freeze([
  "events:task.complete",   // receives onTaskComplete hook
  "events:task.fail",       // receives onFail hook
  "events:quota.deny",      // receives onQuotaDeny hook
  "data:task.summary",      // payload may carry url / error / duration / quota numbers
  "data:task.details",      // payload may carry verification detail + artifact lists
]);

export const PLUGIN_HOOKS = Object.freeze({
  onTaskComplete: "events:task.complete",
  onFail: "events:task.fail",
  onQuotaDeny: "events:quota.deny",
});

const SCOPE_SET = new Set(PLUGIN_SCOPES);

// Payload field classification — every field outside BASE needs its scope.
const BASE_FIELDS = new Set(["taskId", "jobId", "status", "at", "event"]);
const SUMMARY_FIELDS = new Set(["url", "error", "durationMs", "mode", "userId", "orgId",
  "scope", "reason", "limit", "used", "requested", "limits"]);
const DETAILS_FIELDS = new Set(["verification", "artifacts", "metadata", "history"]);

const DISPATCH_LOG_CAP = 200;
const DEFAULT_HOOK_TIMEOUT_MS = Number(process.env.PLUGIN_HOOK_TIMEOUT_MS || 2000);
const ID_RE = /^[a-z0-9][a-z0-9._-]{1,63}$/;

export class PluginError extends Error {
  constructor(message, code) { super(message); this.name = "PluginError"; this.code = code; }
}

function redactForScopes(payload, scopes) {
  const hasSummary = scopes.has("data:task.summary");
  const hasDetails = scopes.has("data:task.details");
  const out = {};
  const dropped = [];
  for (const [k, v] of Object.entries(payload || {})) {
    if (BASE_FIELDS.has(k)) out[k] = v;
    else if (hasSummary && SUMMARY_FIELDS.has(k)) out[k] = v;
    else if (hasDetails && DETAILS_FIELDS.has(k)) out[k] = v;
    else dropped.push(k); // field dropped — the plugin never sees what it has no scope for
  }
  return { payload: out, dropped };
}

async function callWithTimeout(fn, arg, timeoutMs) {
  return new Promise((resolve) => {
    let settled = false;
    const t = setTimeout(() => {
      if (!settled) { settled = true; resolve({ ok: false, error: `handler timeout after ${timeoutMs}ms` }); }
    }, timeoutMs);
    t.unref?.();
    Promise.resolve()
      .then(() => fn(arg))
      .then((r) => { if (!settled) { settled = true; clearTimeout(t); resolve({ ok: true, result: r }); } })
      .catch((e) => { if (!settled) { settled = true; clearTimeout(t); resolve({ ok: false, error: String(e?.message || e).slice(0, 200) }); } });
  });
}

export function createPluginRegistry({ audit = null, hookTimeoutMs = DEFAULT_HOOK_TIMEOUT_MS } = {}) {
  const plugins = new Map();
  const dispatchLog = []; // bounded ring: { at, hook, pluginId, ok, error?, redacted }
  const counters = { dispatched: 0, delivered: 0, failed: 0, timedOut: 0 };
  const emitter = new EventEmitter();
  emitter.setMaxListeners(50);

  function recordDispatch(entry) {
    dispatchLog.push({ at: new Date().toISOString(), ...entry });
    if (dispatchLog.length > DISPATCH_LOG_CAP) dispatchLog.shift();
  }
  async function auditSafe(evt) {
    if (!audit) return;
    try { await Promise.resolve(audit(evt)); } catch {} // audit must never break dispatch
  }

  const registry = new EventEmitter();
  registry.setMaxListeners(50);

  // ---- registration / lifecycle ----
  // manifest = { id, name?, version, publisher, codePolicy, scopes, hooks, handler }
  //   hooks: subset of { onTaskComplete, onFail, onQuotaDeny }; each maps to the
  //   handler METHOD name on `handler` (the same fn object may serve several).
  function register(manifest) {
    const { id, version, publisher, scopes, hooks, handler } = manifest || {};
    if (!id || !ID_RE.test(id)) throw new PluginError("plugin id required (lowercase slug, 2-64 chars)", "INVALID_ID");
    if (!version || !/^\d+\.\d+\.\d+/.test(String(version))) throw new PluginError("plugin version required (semver)", "INVALID_VERSION");
    if (!publisher || typeof publisher !== "string") throw new PluginError("plugin publisher required", "INVALID_PUBLISHER");
    if (manifest.codePolicy !== "in-process-first-party") {
      // plan step 12: never load arbitrary third-party code into the control plane
      throw new PluginError(`codePolicy must be "in-process-first-party" (no third-party code is loaded into this process)`, "UNSAFE_CODE_POLICY");
    }
    if (!Array.isArray(scopes) || scopes.length === 0 || scopes.some((s) => !SCOPE_SET.has(s))) {
      throw new PluginError(`scopes must be a non-empty subset of PLUGIN_SCOPES (${PLUGIN_SCOPES.join(", ")})`, "INVALID_SCOPE");
    }
    if (!hooks || typeof hooks !== "object" || Array.isArray(hooks)) throw new PluginError("hooks object required", "INVALID_HOOKS");
    const hookNames = Object.keys(hooks);
    if (hookNames.length === 0) throw new PluginError("at least one hook required", "INVALID_HOOKS");
    for (const h of hookNames) {
      if (!(h in PLUGIN_HOOKS)) throw new PluginError(`unknown hook "${h}" (allowed: ${Object.keys(PLUGIN_HOOKS).join(", ")})`, "INVALID_HOOK");
      // the declared scope for this hook must be among the granted scopes
      if (!scopes.includes(PLUGIN_HOOKS[h])) {
        throw new PluginError(`hook "${h}" requires scope "${PLUGIN_HOOKS[h]}" which is not in the granted scopes`, "SCOPE_HOOK_MISMATCH");
      }
    }
    if (!handler || typeof handler !== "object" && typeof handler !== "function") {
      throw new PluginError("handler (function or object of hook→fn) required", "INVALID_HANDLER");
    }
    for (const h of hookNames) {
      const fn = typeof handler === "function" ? handler : handler[hooks[h] || h];
      if (typeof fn !== "function") throw new PluginError(`handler method for hook "${h}" missing`, "INVALID_HANDLER");
    }
    if (plugins.has(id)) throw new PluginError(`plugin "${id}" already registered`, "DUPLICATE_ID");
    const rec = {
      id, name: manifest.name || id, version, publisher,
      scopes: [...scopes], hooks: { ...hooks },
      handler, enabled: true, registeredAt: new Date().toISOString(),
    };
    plugins.set(id, rec);
    registry.emit("registered", { id });
    recordDispatch({ hook: "registry.register", pluginId: id, ok: true });
    return { ...rec, handler: undefined }; // handler is callable code — never echoed back
  }

  function unregister(id) {
    if (!plugins.delete(id)) throw new PluginError(`plugin "${id}" not registered`, "NOT_FOUND");
    registry.emit("unregistered", { id });
    return true;
  }
  function setEnabled(id, enabled) {
    const p = plugins.get(id);
    if (!p) throw new PluginError(`plugin "${id}" not registered`, "NOT_FOUND");
    p.enabled = !!enabled;
    return { id, enabled: p.enabled };
  }
  // Grant/revoke: replaces the scope set; hook/scope consistency is re-checked
  // (a revoke that strands a hook's scope also strands the hook).
  function setPermissions(id, scopes) {
    const p = plugins.get(id);
    if (!p) throw new PluginError(`plugin "${id}" not registered`, "NOT_FOUND");
    if (!Array.isArray(scopes) || scopes.some((s) => !SCOPE_SET.has(s))) {
      throw new PluginError("scopes must be a subset of PLUGIN_SCOPES", "INVALID_SCOPE");
    }
    p.scopes = [...scopes];
    for (const h of Object.keys(p.hooks)) {
      if (!p.scopes.includes(PLUGIN_HOOKS[h])) delete p.hooks[h];
    }
    return { id, scopes: [...p.scopes], hooks: { ...p.hooks } };
  }
  function get(id) {
    const p = plugins.get(id);
    return p ? { ...p, handler: undefined } : null;
  }
  function list() {
    return [...plugins.values()].map((p) => ({ ...p, handler: undefined }));
  }
  function dispatchLog_entries() { return [...dispatchLog]; }
  function stats() { return { ...counters, registered: plugins.size, dispatchLog: dispatchLog.length }; }

  // ---- dispatch ----
  // Fan-out to every enabled plugin holding hook+scope. NEVER throws. Returns
  // per-plugin results: { pluginId, ok, error?, redacted: boolean }.
  async function dispatch(hook, payload = {}, { timeoutMs = hookTimeoutMs } = {}) {
    if (!(hook in PLUGIN_HOOKS)) throw new PluginError(`unknown hook "${hook}"`, "INVALID_HOOK");
    const requiredScope = PLUGIN_HOOKS[hook];
    const base = { event: hook, status: hook === "onTaskComplete" ? "completed" : hook === "onFail" ? "error" : payload.status, at: new Date().toISOString(), ...(payload || {}) };
    const results = [];
    for (const p of plugins.values()) {
      if (!p.enabled || !p.hooks[hook]) continue;
      if (!p.scopes.includes(requiredScope)) continue; // fail-closed scope gate
      const scopeSet = new Set(p.scopes);
      const { payload: scopedPayload, dropped } = redactForScopes(base, scopeSet);
      const fn = typeof p.handler === "function" ? p.handler : p.handler[p.hooks[hook]];
      counters.dispatched++;
      const r = await callWithTimeout(fn, scopedPayload, timeoutMs);
      if (r.ok) { counters.delivered++; } else {
        if (String(r.error).includes("timeout")) counters.timedOut++;
        counters.failed++;
      }
      recordDispatch({ hook, pluginId: p.id, ok: r.ok, error: r.error || null });
      results.push({ pluginId: p.id, ok: r.ok, ...(r.ok ? {} : { error: r.error }), redacted: dropped.length > 0, dropped });
      emitter.emit("plugin:dispatched", { hook, pluginId: p.id, ok: r.ok, error: r.error || null, payload: scopedPayload });
      auditSafe({ action: "admin.action", outcome: r.ok ? "success" : "failure", actorType: "service",
        action_detail: `plugin dispatch ${hook} → ${p.id}`, metadata: { pluginId: p.id, hook, error: r.error || null } });
    }
    return results;
  }

  // ---- wiring for the integrator ----
  // Real platform event bus (src/events.js) → hooks. run:done fires when the
  // v1 engine finishes a clone; run:error when the run failed. Both fire the
  // matching hook with whatever the bus carried (tagged with the job id).
  function attachEventBus(bus) {
    const onDone = (e) => { dispatch("onTaskComplete", { taskId: e?.data?.taskId || e?.job || null, jobId: e?.job || null, ...(e?.data || {}) }).catch(() => {}); };
    const onError = (e) => { dispatch("onFail", { taskId: e?.data?.taskId || e?.job || null, jobId: e?.job || null, error: e?.data?.error || null, ...(e?.data || {}) }).catch(() => {}); };
    bus.on("run:done", onDone);
    bus.on("run:error", onError);
    return () => { bus.off("run:done", onDone); bus.off("run:error", onError); };
  }

  // Quota denial hook — the integrator calls this from the quota guard's
  // rejection path (quota-middleware.js, before the 402/429 response body is
  // sent). Accepts the same shape QuotaExceededError carries.
  function notifyQuotaDeny(info = {}) {
    return dispatch("onQuotaDeny", { status: "denied", ...info });
  }

  // low-level emitter for downstream bridges (e.g. external-api webhooks)
  registry.onDispatch = (fn) => { emitter.on("plugin:dispatched", fn); return () => emitter.off("plugin:dispatched", fn); };

  return {
    register, unregister, setEnabled, setPermissions, get, list,
    dispatch, notifyQuotaDeny, attachEventBus,
    dispatchLog: dispatchLog_entries, stats,
    _emitter: registry,
  };
}
