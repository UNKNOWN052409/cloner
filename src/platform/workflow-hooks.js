// Workflow hooks (task 4.2.15): user-defined URLs that receive a signed POST on
// task lifecycle events (created / started / completed / failed / cancelled /
// exported), with retry (3 attempts, exponential backoff) and a dead-letter
// record after exhaustion. The delivery engine talks to the REAL receiver URL
// over the network — there is no simulated transport in any product path; the
// only place a stand-in receiver exists is inside scripts/test-workflow-hooks.mjs
// (the remote-end simulator, per the no-mocks mandate).
//
// SECURITY POSTURE
//   • Receiver URLs are validated with the repo SSRF guard (src/security/
//     url-guard.js). By default private/loopback targets are REJECTED exactly
//     like clone-task URLs; a self-hosted deployment that wants intranet
//     receivers opts in with CLONER_HOOK_ALLOW_PRIVATE_TARGETS=1 (separate from
//     CLONER_ALLOW_PRIVATE_TARGETS so cloning and webhook postures are
//     independent).
//   • Every delivery is signed with a per-hook secret:
//       X-Cloner-Signature: sha256=HMAC_SHA256(secret, `${timestamp}.${rawBody}`)
//     plus X-Cloner-Timestamp (unix seconds). Receivers verify both; the
//     timestamp binding blocks naive replay of captured bodies.
//   • The signing secret is generated server-side ("whsec_…"), shown EXACTLY
//     ONCE at creation/rotation (same pattern as 4.0.6 API keys), and is stored
//     because the server must HMAC at delivery time (Stripe-style outbound
//     signing). It never appears in any list/get/delivery response.
//   • Hooks are per-user; lifecycle events fan out only to the owner's hooks
//     and org-scoped hooks matching the event's org. Anonymous/local task
//     events (no owner) fan out to nobody — a hook can never observe another
//     user's tasks.
//   • Delivery failures never break the task pipeline: emitTaskLifecycleEvent
//     records the delivery and runs it detached (at-least-once semantics; a
//     process restart may re-send a start-class event).
//
// INTEGRATOR WIRING (server.js is integrator-owned — three additive lines):
//   import { hooksRouter, installWorkflowHooks, emitTaskLifecycleEvent } from "./workflow-hooks.js";
//   app.use("/api/hooks", hooksRouter);                       // management CRUD (session-authed)
//   installWorkflowHooks({ queue: getCloneQueue() });         // v2 pipeline fan-out (queue status → events)
//   // v1 legacy runner + export: call emitTaskLifecycleEvent({ status, taskId, url, userId })
//   // from runTask()/createTask()/the export handler (status → event mapping below).
//
// Event mapping (unified over the v2 queue statuses and v1 task statuses):
//   queued                      → task.created
//   running/exploring/reconstructing/verifying → task.started (deduped per task)
//   done/completed/completed_with_limitations  → task.completed
//   error                       → task.failed
//   cancelled                   → task.cancelled
//   exported                    → task.exported
import crypto from "node:crypto";
import { Router } from "express";
import { query } from "../database/client.js";
import { validatePublicUrl } from "../security/url-guard.js";
import { authRequired } from "../auth/auth-middleware.js";

// ---- tunables (env only — no credentials, defaults are safe) ----
const MAX_ATTEMPTS = () => {
  const n = Number(process.env.CLONER_HOOK_MAX_ATTEMPTS);
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : 3; // spec: 3 attempts
};
const RETRY_BACKOFF_MS = () => {
  const n = Number(process.env.CLONER_HOOK_RETRY_BACKOFF_MS);
  return Number.isFinite(n) && n >= 0 ? n : 1000; // exponential: base, base*2
};
const TIMEOUT_MS = () => {
  const n = Number(process.env.CLONER_HOOK_TIMEOUT_MS);
  return Number.isFinite(n) && n >= 100 ? n : 10_000;
};
const HOOK_URL_MAX = 2048;

// ---- lifecycle event allowlist (versioned — no free-form event names) ----
export const TASK_HOOK_EVENTS = [
  "task.created", "task.started", "task.completed", "task.failed",
  "task.cancelled", "task.exported", "hook.ping",
];

// unified status → event map (v1 tasks.js statuses ∪ v2 queue statuses)
const STATUS_TO_EVENT = {
  queued: "task.created",
  running: "task.started",
  exploring: "task.started",
  reconstructing: "task.started",
  verifying: "task.started",
  done: "task.completed",
  completed: "task.completed",
  completed_with_limitations: "task.completed",
  error: "task.failed",
  cancelled: "task.cancelled",
  exported: "task.exported",
};

export function statusToEvent(status) {
  return STATUS_TO_EVENT[String(status || "")] || null;
}

const nowIso = () => new Date().toISOString();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sha256hex = (s) => crypto.createHash("sha256").update(s).digest("hex");
const hmacSig = (secret, data) => "sha256=" + crypto.createHmac("sha256", secret).update(data).digest("hex");

// ---- schema (self-bootstrapping, idempotent, forward-only) ------------------
// The integrator's ordered migration run owns migrations/*.sql; this module
// carries its DDL here so it is runnable on its own without touching the
// shared migrations directory. CREATE TABLE IF NOT EXISTS everywhere → safe to
// run at every boot and safe if the integrator later lifts it into a numbered
// migration file (the statements are identical).
let schemaReady = null;
export function ensureHookSchema() {
  if (!schemaReady) {
    schemaReady = (async () => {
      await query(`
        CREATE TABLE IF NOT EXISTS workflow_hooks (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          org_id TEXT,                        -- optional org-wide hook (fan-out on org-tagged events)
          url TEXT NOT NULL,                  -- https?:// receiver, SSRF-guarded at create/update
          description TEXT,
          event_types TEXT[] NOT NULL DEFAULT '{*}',  -- subscription; '*' = every allowlisted event
          secret TEXT NOT NULL,               -- outbound HMAC key; shown once at create/rotate only
          enabled BOOLEAN NOT NULL DEFAULT true,
          created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
          last_delivery_at TIMESTAMPTZ
        )`);
      await query(`CREATE INDEX IF NOT EXISTS idx_workflow_hooks_user ON workflow_hooks(user_id)`);
      await query(`
        CREATE TABLE IF NOT EXISTS workflow_hook_deliveries (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          hook_id UUID NOT NULL REFERENCES workflow_hooks(id) ON DELETE CASCADE,
          event TEXT NOT NULL,
          task_id TEXT,
          org_id TEXT,
          payload JSONB NOT NULL,
          status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','delivered','dead')),
          attempts INT NOT NULL DEFAULT 0,
          last_status_code INT,
          last_error TEXT,
          attempt_log JSONB NOT NULL DEFAULT '[]',
          created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
          delivered_at TIMESTAMPTZ,
          dead_at TIMESTAMPTZ
        )`);
      await query(`CREATE INDEX IF NOT EXISTS idx_whd_hook ON workflow_hook_deliveries(hook_id, created_at DESC)`);
      await query(`CREATE INDEX IF NOT EXISTS idx_whd_dead ON workflow_hook_deliveries(status, created_at DESC)`);
    })();
  }
  return schemaReady;
}

// ---- URL validation (repo SSRF guard, hooks-specific opt-in) ----------------
// Product default: private/loopback receivers are blocked, mirroring the clone
// pipeline. CLONER_HOOK_ALLOW_PRIVATE_TARGETS=1 opts a self-hosted deployment
// into intranet receivers (local tooling, CI listeners, n8n on the LAN).
export function hookAllowPrivateTargets() {
  return process.env.CLONER_HOOK_ALLOW_PRIVATE_TARGETS === "1";
}

export async function validateHookUrl(rawUrl) {
  if (typeof rawUrl !== "string" || !rawUrl.trim()) return { ok: false, error: "url required" };
  if (rawUrl.length > HOOK_URL_MAX) return { ok: false, error: `url exceeds ${HOOK_URL_MAX} chars` };
  // validatePublicUrl enforces: http(s) scheme only, no userinfo, blocked
  // hostnames, private/reserved literal IPs + DNS resolution checks.
  return validatePublicUrl(rawUrl, { allowPrivate: hookAllowPrivateTargets() });
}

// ---- event subscription normalization ---------------------------------------
// [] | missing → ["*"] (subscribe to everything); mixing '*' with explicit
// events is rejected (ambiguous); unknown event names are rejected 400.
export function normalizeEventTypes(events) {
  if (events === undefined || events === null) return ["*"];
  const list = Array.isArray(events) ? events : String(events).split(",");
  const clean = [...new Set(list.map((s) => String(s).trim()).filter(Boolean))];
  if (clean.includes("*")) {
    if (clean.length > 1) throw new Error("'*' cannot be combined with explicit event types");
    return ["*"];
  }
  for (const e of clean) {
    if (!TASK_HOOK_EVENTS.includes(e)) throw new Error(`unknown event type: ${e} (valid: ${TASK_HOOK_EVENTS.join(", ")}${", *"})`);
  }
  return clean.length ? clean : ["*"];
}

function hookMatchesEvent(hook, event) {
  return (hook.event_types || []).includes("*") || (hook.event_types || []).includes(event);
}

// fan-out scope: the event's owner gets their hooks; the event's org gets the
// org-scoped hooks. An event without an owner matches nothing.
function hookMatchesScope(hook, { userId, orgId }) {
  if (hook.org_id && orgId && hook.org_id === orgId) return true;
  if (hook.user_id && userId && String(hook.user_id) === String(userId)) return true;
  return false;
}

// ---- payload -----------------------------------------------------------------
function buildPayload({ deliveryId, event, evt }) {
  return {
    id: deliveryId,
    event,
    created_at: nowIso(),
    task: {
      id: evt.taskId ?? null,
      tempId: evt.tempId ?? null,
      status: evt.status ?? null,
      url: evt.url ?? null,
      outcome: statusToEvent(evt.status) === "task.completed" ? (evt.status || null) : null,
    },
    context: {
      userId: evt.userId ?? null,
      orgId: evt.orgId ?? null,
      pipeline: evt.pipeline ?? null,
      data: evt.data ?? null,
    },
  };
}

// ---- delivery engine ---------------------------------------------------------
// One attempt = one real POST to the receiver. 2xx → success; anything else
// (HTTP status, network error, timeout) retries with exponential backoff and,
// after MAX_ATTEMPTS, dead-letters the delivery for operator replay.
async function deliverOnce(url, rawBody, headers, timeoutMs) {
  const ctrl = new AbortController();
  const timeoutErr = new Error(`timeout after ${timeoutMs}ms`); // our own abort reason → identifiable rejection
  const timer = setTimeout(() => ctrl.abort(timeoutErr), timeoutMs);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers,
      body: rawBody,
      signal: ctrl.signal,
      redirect: "manual", // a webhook must not silently follow redirects (SSRF pivot)
    });
    return res.ok
      ? { ok: true, status: res.status, error: null }
      : { ok: false, status: res.status, error: `HTTP ${res.status}` };
  } catch (e) {
    if (e === timeoutErr || e?.name === "AbortError" || e?.name === "TimeoutError") {
      return { ok: false, status: null, error: timeoutErr.message };
    }
    // undici wraps network failures as TypeError: fetch failed — the real code
    // (ECONNREFUSED, ENOTFOUND, EAI_AGAIN, …) lives in cause / cause.errors[];
    // pre-connect refusals (unsafe port, bad scheme) only carry cause.message
    const causes = [e?.cause, ...(Array.isArray(e?.cause?.errors) ? e.cause.errors : [])].filter(Boolean);
    const detail = causes.map((c) => c?.code || c?.message).find(Boolean);
    return { ok: false, status: null, error: String(detail || e?.message || e).slice(0, 200) };
  } finally {
    clearTimeout(timer);
  }
}

async function runDelivery(deliveryId, hook, payload) {
  const rawBody = JSON.stringify(payload);
  const ts = Math.floor(Date.now() / 1000).toString();
  const headers = {
    "content-type": "application/json",
    "user-agent": "cloner-workflow-hooks/1.0",
    "x-cloner-event": payload.event,
    "x-cloner-delivery": deliveryId,
    "x-cloner-hook-id": hook.id,
    "x-cloner-timestamp": ts,
    "x-cloner-signature": hmacSig(hook.secret, `${ts}.${rawBody}`),
  };
  const max = MAX_ATTEMPTS();
  const backoff = RETRY_BACKOFF_MS();
  const log = [];
  let lastStatus = null;
  let lastError = null;
  let attempts = 0;
  for (let attempt = 1; attempt <= max; attempt++) {
    attempts = attempt;
    const t0 = Date.now();
    const r = await deliverOnce(hook.url, rawBody, headers, TIMEOUT_MS());
    log.push({ at: nowIso(), attempt, ok: r.ok, status: r.status, error: r.error, ms: Date.now() - t0 });
    if (r.ok) {
      await query(
        `UPDATE workflow_hook_deliveries
         SET status='delivered', attempts=$2, last_status_code=$3, last_error=NULL,
             attempt_log=$4::jsonb, delivered_at=now(), dead_at=NULL
         WHERE id=$1`,
        [deliveryId, attempt, r.status, JSON.stringify(log)]
      );
      await query(`UPDATE workflow_hooks SET last_delivery_at=now() WHERE id=$1`, [hook.id]);
      return { ok: true, attempts: attempt, log };
    }
    lastStatus = r.status;
    lastError = r.error;
    if (attempt < max) await sleep(backoff * Math.pow(2, attempt - 1)); // base, base*2, …
  }
  // exhausted → dead letter (the row itself is the record; operator replays it)
  await query(
    `UPDATE workflow_hook_deliveries
     SET status='dead', attempts=$2, last_status_code=$3, last_error=$4,
         attempt_log=$5::jsonb, dead_at=now()
     WHERE id=$1`,
    [deliveryId, attempts, lastStatus, lastError, JSON.stringify(log)]
  );
  return { ok: false, attempts, log, error: lastError };
}

// in-flight tracking so tests can drain deterministically and a shutdown can
// wait for deliveries instead of dropping them mid-flight
const inflight = new Set();
export async function drainWorkflowDeliveries() {
  while (inflight.size) await Promise.allSettled([...inflight]);
}

function track(promise) {
  inflight.add(promise);
  promise.finally(() => inflight.delete(promise)).catch(() => {});
  return promise;
}

// ---- fan-out -----------------------------------------------------------------
// The single integration point for every lifecycle surface. Never throws: a
// hooks failure must never break a running task pipeline.
export async function emitTaskLifecycleEvent(evt = {}) {
  try {
    await ensureHookSchema();
    const event = evt.event || statusToEvent(evt.status);
    if (!event || !TASK_HOOK_EVENTS.includes(event)) return { event: event || null, matched: 0, deliveries: [] };
    const { rows: hooks } = await query(
      `SELECT * FROM workflow_hooks
       WHERE enabled AND (event_types @> ARRAY[$1]::text[] OR '*' = ANY(event_types))`,
      [event]
    );
    const targets = hooks.filter((h) => hookMatchesScope(h, evt));
    const out = [];
    for (const hook of targets) {
      const deliveryId = crypto.randomUUID();
      const payload = buildPayload({ deliveryId, event, evt });
      await query(
        `INSERT INTO workflow_hook_deliveries (id, hook_id, event, task_id, org_id, payload, status)
         VALUES ($1,$2,$3,$4,$5,$6,'pending')`,
        [deliveryId, hook.id, event, evt.taskId ?? null, evt.orgId ?? null, JSON.stringify(payload)]
      );
      track(runDelivery(deliveryId, hook, payload).catch(() => {}));
      out.push({ id: deliveryId, hookId: hook.id }); // hook-tagged: one event fans out to several hooks
    }
    return { event, matched: targets.length, deliveries: out };
  } catch (e) {
    console.warn(`[workflow-hooks] emit failed: ${e?.message || e}`);
    return { event: evt?.event || statusToEvent(evt?.status) || null, matched: 0, deliveries: [], error: String(e?.message || e).slice(0, 200) };
  }
}

// ---- queue installer (v2 pipeline: clone-queue status events → hooks) --------
// Dedups on the MAPPED EVENT (exploring → reconstructing → verifying all map to
// one task.started delivery per task) with a bounded in-memory window.
export function installWorkflowHooks({ queue, log = console } = {}) {
  if (!queue || typeof queue.onStatus !== "function") throw new Error("queue required (getCloneQueue())");
  const seen = new Map(); // taskId → last mapped event (bounded)
  const SEEN_CAP = 5000;
  const off = queue.onStatus(({ tempId, jobId, status, entry, data }) => {
    try {
      const taskId = jobId || tempId || null;
      const event = statusToEvent(status);
      if (!event) return; // progress statuses without a lifecycle meaning → no hook
      if (taskId) {
        if (seen.get(taskId) === event) return; // duplicate / start-class dedup
        seen.set(taskId, event);
        if (seen.size > SEEN_CAP) seen.delete(seen.keys().next().value);
      }
      const owner = entry?.owner || null;
      emitTaskLifecycleEvent({
        event, status, taskId, tempId: tempId || null, url: entry?.url || null,
        userId: owner?.userId ?? null, orgId: owner?.orgId ?? null,
        pipeline: "v2", data: data ?? null,
      }).catch((e) => log.warn?.(`[workflow-hooks] fan-out ${taskId}/${status}: ${e?.message || e}`));
    } catch (e) {
      log.warn?.(`[workflow-hooks] queue event error: ${e?.message || e}`);
    }
  });
  return { unsubscribe: off };
}

// ---- service operations (used by the router + tests) --------------------------
const SECRET_PREFIX_LEN = 9; // "whsec_" + 3 chars, display only

function hookView(h) {
  return {
    id: h.id, user_id: h.user_id, org_id: h.org_id, url: h.url, description: h.description,
    event_types: h.event_types, enabled: h.enabled, created_at: h.created_at, updated_at: h.updated_at,
    last_delivery_at: h.last_delivery_at,
    secret_prefix: String(h.secret || "").slice(0, SECRET_PREFIX_LEN) + "…",
  };
}

export async function createHook(userId, { url, events, description, orgId } = {}) {
  if (!userId) throw new Error("userId required");
  const guard = await validateHookUrl(url);
  if (!guard.ok) throw new Error(`url rejected: ${guard.error}`);
  const eventTypes = normalizeEventTypes(events); // throws on unknown names
  const secret = "whsec_" + crypto.randomBytes(32).toString("hex");
  const { rows } = await query(
    `INSERT INTO workflow_hooks (user_id, org_id, url, description, event_types, secret)
     VALUES ($1,$2,$3,$4,$5,$6)
     RETURNING *`,
    [userId, orgId ? String(orgId).slice(0, 128) : null, guard.url, String(description || "").slice(0, 500), eventTypes, secret]
  );
  // fullSecret is returned EXACTLY ONCE (creation) — every later view is the prefix
  return { ...hookView(rows[0]), fullSecret: secret };
}

export async function listHooks(userId) {
  const { rows } = await query(`SELECT * FROM workflow_hooks WHERE user_id=$1 ORDER BY created_at DESC`, [userId]);
  return rows.map(hookView);
}

export async function getHook(id, userId) {
  const { rows } = await query(`SELECT * FROM workflow_hooks WHERE id=$1 AND user_id=$2`, [id, userId]);
  return rows[0] || null; // foreign hooks look like missing hooks (no existence leak)
}

export async function updateHook(id, userId, { url, events, description, orgId, enabled } = {}) {
  const hook = await getHook(id, userId);
  if (!hook) return null;
  const patch = {};
  if (url !== undefined) {
    const guard = await validateHookUrl(url);
    if (!guard.ok) throw new Error(`url rejected: ${guard.error}`);
    patch.url = guard.url;
  }
  if (events !== undefined) patch.event_types = normalizeEventTypes(events);
  if (description !== undefined) patch.description = String(description).slice(0, 500);
  if (orgId !== undefined) patch.org_id = orgId ? String(orgId).slice(0, 128) : null;
  if (enabled !== undefined) patch.enabled = !!enabled;
  if (!Object.keys(patch).length) return hookView(hook);
  const sets = Object.keys(patch).map((k, i) => `${k}=$${i + 1}`).join(", ");
  const { rows } = await query(
    `UPDATE workflow_hooks SET ${sets}, updated_at=now() WHERE id=$${Object.keys(patch).length + 1} AND user_id=$${Object.keys(patch).length + 2} RETURNING *`,
    [...Object.values(patch), id, userId]
  );
  return hookView(rows[0]);
}

export async function deleteHook(id, userId) {
  const { rows } = await query(`DELETE FROM workflow_hooks WHERE id=$1 AND user_id=$2 RETURNING id`, [id, userId]);
  return rows.length > 0; // deliveries cascade
}

export async function rotateSecret(id, userId) {
  const hook = await getHook(id, userId);
  if (!hook) return null;
  const secret = "whsec_" + crypto.randomBytes(32).toString("hex");
  await query(`UPDATE workflow_hooks SET secret=$2, updated_at=now() WHERE id=$1`, [id, secret]);
  return { id, fullSecret: secret }; // shown once, like creation
}

export async function listDeliveries(hookId, userId, { limit = 50 } = {}) {
  const hook = await getHook(hookId, userId);
  if (!hook) return null;
  const { rows } = await query(
    `SELECT id, event, task_id, org_id, status, attempts, last_status_code, last_error,
            attempt_log, created_at, delivered_at, dead_at
     FROM workflow_hook_deliveries WHERE hook_id=$1 ORDER BY created_at DESC LIMIT $2`,
    [hookId, Math.min(Number(limit) || 50, 200)]
  );
  return rows;
}

export async function listDeadLetters(userId, { limit = 100 } = {}) {
  const { rows } = await query(
    `SELECT d.id, d.hook_id, d.event, d.task_id, d.status, d.attempts, d.last_status_code,
            d.last_error, d.attempt_log, d.created_at, d.dead_at, h.url
     FROM workflow_hook_deliveries d JOIN workflow_hooks h ON h.id = d.hook_id
     WHERE d.status='dead' AND h.user_id=$1 ORDER BY d.created_at DESC LIMIT $2`,
    [userId, Math.min(Number(limit) || 100, 200)]
  );
  return rows;
}

// test ping: one real delivery of a hook.ping event through the real engine,
// to THIS hook only (an operator pressing "send test" expects the receiver to
// get something — subscription filters do not suppress the ping).
export async function sendTestPing(id, userId) {
  const hook = await getHook(id, userId);
  if (!hook) return null;
  const evt = { event: "hook.ping", taskId: null, userId, orgId: hook.org_id, pipeline: "hooks", data: { kind: "test-ping" } };
  const deliveryId = crypto.randomUUID();
  const payload = buildPayload({ deliveryId, event: "hook.ping", evt });
  await query(
    `INSERT INTO workflow_hook_deliveries (id, hook_id, event, task_id, org_id, payload, status)
     VALUES ($1,$2,'hook.ping',NULL,$3,$4,'pending')`,
    [deliveryId, hook.id, hook.org_id, JSON.stringify(payload)]
  );
  track(runDelivery(deliveryId, hook, payload).catch(() => {}));
  return { event: "hook.ping", matched: 1, deliveries: [{ id: deliveryId, hookId: hook.id }] };
}

// replay a dead letter in place (fresh attempts, same payload). Foreign or
// already-delivered replays are 404/no-op respectively.
export async function replayDeadLetter(deliveryId, userId) {
  const { rows } = await query(
    `SELECT d.*, h.user_id AS hook_user_id, h.url AS hook_url, h.secret, h.enabled AS hook_enabled
     FROM workflow_hook_deliveries d JOIN workflow_hooks h ON h.id=d.hook_id
     WHERE d.id=$1 AND h.user_id=$2`,
    [deliveryId, userId]
  );
  const d = rows[0];
  if (!d) return { ok: false, notFound: true };
  if (d.status !== "dead") return { ok: false, error: "delivery is not a dead letter" };
  if (!d.hook_enabled) return { ok: false, error: "hook is disabled — enable it before replaying" };
  await query(
    `UPDATE workflow_hook_deliveries SET status='pending', attempts=0, last_error=NULL, dead_at=NULL WHERE id=$1`,
    [deliveryId]
  );
  const r = await runDelivery(deliveryId, { id: d.hook_id, url: d.hook_url, secret: d.secret }, d.payload);
  return { ok: r.ok, attempts: r.attempts, log: r.log };
}

// ---- management router -------------------------------------------------------
// INTEGRATOR MOUNT LINE:
//   app.use("/api/hooks", hooksRouter);
// Session-authenticated (authRequired) — hooks carry a signing secret and
// deliver to caller-chosen URLs, so anonymous callers get nothing.
export const hooksRouter = Router();

hooksRouter.use(authRequired);

hooksRouter.post("/", async (req, res) => {
  try {
    const { url, events, description, orgId } = req.body || {};
    const hook = await createHook(req.userId, { url, events, description, orgId });
    res.status(201).json({ ok: true, hook, fullSecret: hook.fullSecret }); // fullSecret shown ONCE
  } catch (e) {
    res.status(400).json({ error: e.message.slice(0, 200) });
  }
});

hooksRouter.get("/", async (req, res) => {
  try { res.json(await listHooks(req.userId)); } catch (e) { res.status(500).json({ error: e.message.slice(0, 200) }); }
});

hooksRouter.get("/dead-letters", async (req, res) => {
  try { res.json(await listDeadLetters(req.userId, { limit: req.query?.limit })); }
  catch (e) { res.status(500).json({ error: e.message.slice(0, 200) }); }
});

hooksRouter.post("/dead-letters/:deliveryId/replay", async (req, res) => {
  try {
    const r = await replayDeadLetter(req.params.deliveryId, req.userId);
    if (r.notFound) return res.status(404).json({ error: "dead letter not found" });
    res.json({ ok: r.ok, attempts: r.attempts, log: r.log, error: r.error || null });
  } catch (e) { res.status(500).json({ error: e.message.slice(0, 200) }); }
});

hooksRouter.get("/:id", async (req, res) => {
  try {
    const hook = await getHook(req.params.id, req.userId);
    if (!hook) return res.status(404).json({ error: "not found" });
    res.json(hookView(hook));
  } catch (e) { res.status(500).json({ error: e.message.slice(0, 200) }); }
});

hooksRouter.patch("/:id", async (req, res) => {
  try {
    const hook = await updateHook(req.params.id, req.userId, req.body || {});
    if (!hook) return res.status(404).json({ error: "not found" });
    res.json(hook);
  } catch (e) {
    res.status(/url rejected|unknown event/.test(e.message) ? 400 : 500).json({ error: e.message.slice(0, 200) });
  }
});

hooksRouter.delete("/:id", async (req, res) => {
  try {
    const ok = await deleteHook(req.params.id, req.userId);
    if (!ok) return res.status(404).json({ error: "not found" });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message.slice(0, 200) }); }
});

hooksRouter.post("/:id/rotate", async (req, res) => {
  try {
    const r = await rotateSecret(req.params.id, req.userId);
    if (!r) return res.status(404).json({ error: "not found" });
    res.json({ ok: true, fullSecret: r.fullSecret }); // new secret shown ONCE
  } catch (e) { res.status(500).json({ error: e.message.slice(0, 200) }); }
});

hooksRouter.post("/:id/test", async (req, res) => {
  try {
    const r = await sendTestPing(req.params.id, req.userId);
    if (!r) return res.status(404).json({ error: "not found" });
    res.json({ ok: true, ...r });
  } catch (e) { res.status(500).json({ error: e.message.slice(0, 200) }); }
});

hooksRouter.get("/:id/deliveries", async (req, res) => {
  try {
    const rows = await listDeliveries(req.params.id, req.userId, { limit: req.query?.limit });
    if (!rows) return res.status(404).json({ error: "not found" });
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message.slice(0, 200) }); }
});
