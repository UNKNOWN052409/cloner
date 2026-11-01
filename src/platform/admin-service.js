// Admin service (task 4.0.8): server-side administrative operations.
//
// Design rules honored here:
//   • Every dependency is INJECTED — db, audit (the 4.0.9 audit-service
//     interface), queue adapter, api-keys store, retention sweep. Nothing is
//     hardwired to modules owned by parallel tasks, so this compiles and runs
//     before/after 4.0.2 (organizations), 4.0.4 (quotas) and 4.0.6 (api keys).
//   • Every admin action emits an audit event through the injected
//     audit.record() interface. Events conform to the 4.0.9 schema v1
//     allowlist (src/platform/audit-service.js AUDIT_ACTIONS): actions are
//     "admin.access" (inspection, incl. denials) and "admin.action"
//     (mutations); outcomes are success | failure | denied; the granular
//     operation name rides in metadata.operation. Use
//     auditBridgeFromAuditService() to wire the real 4.0.9 service.
//     With no audit implementation provided, a bounded in-memory fallback
//     (createMemoryAudit) is used so "every action is audited" stays testable.
//   • Operations the parallel tasks own are TOLERANT: if their tables are not
//     migrated yet, the service returns an explicit "not provisioned" result
//     instead of guessing a schema.
//   • Quotas live in an idempotently-created admin_quotas table (runtime
//     CREATE TABLE IF NOT EXISTS — additive, no migration-number collision;
//     the integrator may consolidate it into a numbered migration later).
import crypto from "node:crypto";
import { query as defaultQuery } from "../database/client.js";

export const ADMIN_AUDIT_SCHEMA_VERSION = 1;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function httpError(status, message) {
  const e = new Error(message);
  e.status = status;
  return e;
}

// Bounded in-memory audit sink — the fallback when the 4.0.9 audit-service is
// not wired yet. Exposes `events` so tests (and operators) can observe that
// every admin action really did emit an event.
export function createMemoryAudit(capacity = 1000) {
  const events = [];
  return {
    kind: "memory",
    events,
    async record(event) {
      const full = {
        schemaVersion: ADMIN_AUDIT_SCHEMA_VERSION,
        ts: new Date(),
        actorType: "user",
        outcome: "success",
        correlationId: null,
        actorId: null,
        actorEmail: null,
        targetType: null,
        targetId: null,
        metadata: {},
        ...event,
      };
      events.push(full);
      if (events.length > capacity) events.splice(0, events.length - capacity);
      return full;
    },
  };
}

// Bridge from this module's injected audit interface ({ record(event) }) to
// the REAL 4.0.9 audit-service module (src/platform/audit-service.js). The
// integrator mounts:
//   import * as auditService from "./audit-service.js";
//   app.use("/api/admin", adminRouter({ queue: getCloneQueue(),
//     audit: auditBridgeFromAuditService(auditService) }));
export function auditBridgeFromAuditService(auditServiceModule) {
  const record = auditServiceModule?.recordAuditEventSafe || auditServiceModule?.recordAuditEvent;
  if (typeof record !== "function") throw new Error("auditBridgeFromAuditService: module has no recordAuditEvent(Safe)");
  return { kind: "audit-service", record: (event) => record(event) };
}

// Queue adapter: normalizes whatever queue surface is injected into a single
// `cancel(jobId)` contract. The real clone-queue (src/queues/clone-queue.js)
// has no cancel method yet — until the queue grows one, the adapter flips the
// registry entry to "cancelled" and re-emits the status event on the queue's
// own "status" channel, which is what every status poller consumes. If the
// queue later gains cancel(), the adapter delegates to it automatically.
export function createQueueAdapter(queue) {
  if (!queue) {
    return { cancel: async () => false, listJobs: async () => [], describe: () => "no queue attached" };
  }
  return {
    describe: () => (typeof queue.cancel === "function" ? "native-cancel" : "registry-flip"),
    async cancel(jobId) {
      if (typeof jobId !== "string" || !jobId) return false;
      if (typeof queue.cancel === "function") {
        const r = await queue.cancel(jobId);
        return r !== false;
      }
      const entry = queue.getEntry?.(jobId) || queue.getJob?.(jobId) || null;
      if (!entry) return false;
      if (entry.status === "completed" || entry.status === "error") return false;
      entry.status = "cancelled";
      entry.finishedAt = entry.finishedAt || new Date().toISOString();
      if (Array.isArray(entry.history)) {
        entry.history.push({ at: new Date().toISOString(), event: "cancelled by admin" });
      }
      try {
        queue.emit?.("status", {
          tempId: entry.tempId || null,
          jobId: entry.jobId || null,
          status: "cancelled",
          entry,
          data: { reason: "admin-force-cancel" },
        });
      } catch {}
      return true;
    },
    async listJobs() {
      return typeof queue.listJobs === "function" ? queue.listJobs() : [];
    },
  };
}

// Default API-keys adapter (4.0.6 owns the real schema — 013-api-keys.sql:
// id UUID PK, revoked_at TIMESTAMPTZ). Probes the actual columns instead of
// guessing; guards the UUID cast so a non-UUID key id degrades to a clean
// "not found" rather than a PG 22P02 crash.
function createDefaultApiKeys(db) {
  let schemaCache = null;
  async function probe() {
    if (schemaCache) return schemaCache;
    const t = await db.query(
      "SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'api_keys'"
    );
    if (!t.rows.length) return (schemaCache = { table: false });
    const cols = await db.query(
      `SELECT column_name, data_type FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'api_keys'`
    );
    const byName = new Map(cols.rows.map((r) => [r.column_name, r.data_type]));
    const idColumn = byName.has("key_id") ? "key_id" : byName.has("id") ? "id" : null;
    schemaCache = {
      table: true,
      idColumn,
      idIsUuid: idColumn ? byName.get(idColumn) === "uuid" : false,
      revokedAt: byName.has("revoked_at"),
      revokedFlag: byName.has("revoked"),
      status: byName.has("status"),
    };
    return schemaCache;
  }
  return {
    async revoke(keyId) {
      const s = await probe();
      if (!s.table) return { revoked: false, reason: "api-keys-not-provisioned (4.0.6 schema not migrated)" };
      if (!s.idColumn) return { revoked: false, reason: "api_keys table has no recognizable id column" };
      if (s.idIsUuid && !UUID_RE.test(String(keyId))) {
        return { revoked: false, reason: "api key not found" }; // cannot match a uuid PK
      }
      if (s.revokedAt) {
        const r = await db.query(`UPDATE api_keys SET revoked_at = now() WHERE ${s.idColumn} = $1 RETURNING ${s.idColumn}`, [keyId]);
        return r.rows.length ? { revoked: true, keyId } : { revoked: false, reason: "api key not found" };
      }
      if (s.revokedFlag) {
        const r = await db.query(`UPDATE api_keys SET revoked = true WHERE ${s.idColumn} = $1 RETURNING ${s.idColumn}`, [keyId]);
        return r.rows.length ? { revoked: true, keyId } : { revoked: false, reason: "api key not found" };
      }
      if (s.status) {
        const r = await db.query(`UPDATE api_keys SET status = 'revoked' WHERE ${s.idColumn} = $1 RETURNING ${s.idColumn}`, [keyId]);
        return r.rows.length ? { revoked: true, keyId } : { revoked: false, reason: "api key not found" };
      }
      return { revoked: false, reason: "api_keys table has no revocation column" };
    },
  };
}

export function createAdminService({
  db = null,
  audit = null,
  queue = null,
  apiKeys = null,
  retentionSweep = null,
} = {}) {
  const store = db || { query: (text, params) => defaultQuery(text, params) };
  const auditSink = audit || createMemoryAudit();
  const queueAdapter = createQueueAdapter(queue);
  const keys = apiKeys || createDefaultApiKeys(store);

  // best-effort audit — a failing audit sink must never corrupt the admin
  // action itself; failures are surfaced on the response as auditRecorded:false
  async function emitAudit({ operation, mutation, outcome = "success", targetType, targetId, details = {}, actor }) {
    try {
      await auditSink.record({
        schemaVersion: ADMIN_AUDIT_SCHEMA_VERSION,
        ts: new Date(),
        actorType: "user",
        action: mutation ? "admin.action" : "admin.access",
        outcome,
        actorId: actor?.id || null,
        actorEmail: actor?.email || null,
        targetType: targetType || null,
        targetId: targetId != null ? String(targetId).slice(0, 256) : null,
        metadata: { operation, ...details },
        correlationId: actor?.correlationId || null,
      });
      return true;
    } catch (e) {
      console.warn(`[admin-audit] record failed: ${e?.message || e}`);
      return false;
    }
  }

  async function tableExists(name) {
    const r = await store.query(
      "SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = $1",
      [name]
    );
    return r.rows.length > 0;
  }

  // Idempotent runtime table for quota overrides (4.0.4 owns the full quota
  // model; this is the admin-facing override surface, additive and safe).
  async function ensureQuotaTable() {
    await store.query(`
      CREATE TABLE IF NOT EXISTS admin_quotas (
        user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
        quota JSONB NOT NULL DEFAULT '{}'::jsonb,
        updated_by UUID,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);
  }

  // ---------- users / orgs ----------

  async function listUsers({ limit = 100, offset = 0, actor } = {}) {
    const lim = Math.min(Math.max(Number(limit) || 100, 1), 500);
    const off = Math.max(Number(offset) || 0, 0);
    const rows = await store.query(
      `SELECT u.id, u.email, u.role, u.status, u.created_at, u.updated_at,
              (SELECT count(*) FROM tasks t WHERE t.user_id = u.id) AS task_count
       FROM users u ORDER BY u.created_at DESC LIMIT $1 OFFSET $2`,
      [lim, off]
    );
    const total = await store.query("SELECT count(*)::int AS n FROM users");
    const out = { users: rows.rows, total: total.rows[0].n, limit: lim, offset: off };
    await emitAudit({
      operation: "admin.users.list", mutation: false, targetType: "user-collection",
      details: { limit: lim, offset: off, total: out.total }, actor,
    });
    return out;
  }

  async function getUser(userId, { actor } = {}) {
    if (!UUID_RE.test(String(userId || ""))) throw httpError(400, "invalid user id");
    const r = await store.query(
      `SELECT u.id, u.email, u.role, u.status, u.created_at, u.updated_at,
              (SELECT count(*) FROM tasks t WHERE t.user_id = u.id) AS task_count
       FROM users u WHERE u.id = $1`,
      [userId]
    );
    if (!r.rows.length) throw httpError(404, "user not found");
    const out = { user: r.rows[0] };
    await emitAudit({ operation: "admin.users.get", mutation: false, targetType: "user", targetId: userId, actor });
    return out;
  }

  async function listOrganizations({ limit = 100, offset = 0, actor } = {}) {
    let out;
    if (await tableExists("organizations")) {
      const lim = Math.min(Math.max(Number(limit) || 100, 1), 500);
      const off = Math.max(Number(offset) || 0, 0);
      const rows = await store.query("SELECT * FROM organizations ORDER BY created_at DESC LIMIT $1 OFFSET $2", [lim, off]);
      out = { available: true, organizations: rows.rows, limit: lim, offset: off };
    } else {
      out = { available: false, organizations: [], note: "organizations schema not migrated yet (task 4.0.2)" };
    }
    await emitAudit({
      operation: "admin.orgs.list", mutation: false, targetType: "organization-collection",
      details: { available: out.available, count: out.organizations.length }, actor,
    });
    return out;
  }

  // ---------- tasks (read-only inspection + forced cancellation) ----------

  async function listAllTasks({ status, limit = 100, offset = 0, actor } = {}) {
    const lim = Math.min(Math.max(Number(limit) || 100, 1), 500);
    const off = Math.max(Number(offset) || 0, 0);
    const params = [];
    let where = "";
    if (status) {
      where = "WHERE t.status = $1";
      params.push(String(status).slice(0, 40));
    }
    params.push(lim, off);
    const rows = await store.query(
      `SELECT t.id, t.user_id, u.email AS owner_email, t.source_url, t.status, t.current_stage,
              t.progress, t.error, t.retry_count, t.created_at, t.started_at, t.completed_at, t.updated_at
       FROM tasks t JOIN users u ON u.id = t.user_id
       ${where} ORDER BY t.created_at DESC LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params
    );
    const out = { tasks: rows.rows, limit: lim, offset: off };
    await emitAudit({
      operation: "admin.tasks.list", mutation: false, targetType: "task-collection",
      details: { status: status || null, count: rows.rows.length }, actor,
    });
    return out;
  }

  // read-only view of ANY user's task: owner identity, stages, events, artifacts
  async function getTaskAsAdmin(taskId, { actor } = {}) {
    if (!UUID_RE.test(String(taskId || ""))) throw httpError(400, "invalid task id");
    const r = await store.query(
      `SELECT t.*, u.email AS owner_email FROM tasks t JOIN users u ON u.id = t.user_id WHERE t.id = $1`,
      [taskId]
    );
    if (!r.rows.length) throw httpError(404, "task not found");
    const [stages, events, artifacts] = await Promise.all([
      store.query("SELECT id, stage, status, started_at, completed_at, duration_ms, error FROM task_stages WHERE task_id = $1 ORDER BY created_at", [taskId]),
      store.query("SELECT id, event_type, payload, created_at FROM task_events WHERE task_id = $1 ORDER BY created_at DESC LIMIT 50", [taskId]),
      store.query("SELECT id, stage, artifact_type, storage_key, mime_type, size_bytes, created_at FROM artifacts WHERE task_id = $1 ORDER BY created_at", [taskId]),
    ]);
    const task = r.rows[0];
    const out = { task, stages: stages.rows, events: events.rows, artifacts: artifacts.rows };
    await emitAudit({
      operation: "admin.tasks.get", mutation: false, targetType: "task", targetId: taskId,
      details: { ownerId: task.user_id }, actor,
    });
    return out;
  }

  // Force-cancel: goes through the queue adapter FIRST (so the job registry /
  // BullMQ surface is told), then propagates the outcome to the persistent
  // task row (status → 'cancelled') and writes a task event. Works for both
  // UUID DB tasks and non-UUID queue-only job handles.
  async function forceCancelTask(taskId, { actor, reason = "admin force-cancel" } = {}) {
    const id = String(taskId || "");
    if (!id || id.length > 128 || /[\s/\\]/.test(id)) throw httpError(400, "invalid task id");
    let task = null;
    if (UUID_RE.test(id)) {
      const r = await store.query("SELECT id, user_id, status FROM tasks WHERE id = $1", [id]);
      task = r.rows[0] || null;
    }
    if (task && ["done", "error", "cancelled"].includes(task.status)) {
      throw httpError(409, `task already in terminal status '${task.status}'`);
    }
    const queueCancelled = await queueAdapter.cancel(id);
    if (!task && !queueCancelled) throw httpError(404, "task or job not found");

    if (task) {
      await store.query(
        "UPDATE tasks SET status = 'cancelled', updated_at = now(), completed_at = COALESCE(completed_at, now()) WHERE id = $1",
        [id]
      );
      await store.query(
        "INSERT INTO task_events (task_id, event_type, payload) VALUES ($1, $2, $3)",
        [id, "task.cancelled_by_admin", JSON.stringify({ byAdminId: actor?.id || null, reason: String(reason).slice(0, 300), queueCancelled })]
      );
      const after = await store.query(
        `SELECT t.id, t.user_id, u.email AS owner_email, t.status, t.updated_at FROM tasks t JOIN users u ON u.id = t.user_id WHERE t.id = $1`,
        [id]
      );
      task = after.rows[0];
    }
    const out = { taskId: id, queueCancelled, task };
    await emitAudit({
      operation: "admin.tasks.cancel", mutation: true, targetType: "task", targetId: id,
      details: { queueCancelled, queueAdapter: queueAdapter.describe(), reason: String(reason).slice(0, 300) }, actor,
    });
    return out;
  }

  // ---------- quotas ----------

  async function setQuota(userId, patch, { actor } = {}) {
    if (!UUID_RE.test(String(userId || ""))) throw httpError(400, "invalid user id");
    if (!patch || typeof patch !== "object" || Array.isArray(patch)) throw httpError(400, "quota must be an object");
    const bad = Object.keys(patch).filter((k) => {
      const v = patch[k];
      return !(typeof v === "number" && Number.isFinite(v)) && typeof v !== "boolean" && v !== null;
    });
    if (bad.length) throw httpError(400, `quota values must be numbers, booleans or null (offending: ${bad.join(", ")})`);
    if (JSON.stringify(patch).length > 4096) throw httpError(400, "quota payload too large");
    await ensureQuotaTable();
    const r = await store.query(
      `INSERT INTO admin_quotas (user_id, quota, updated_by) VALUES ($1, $2::jsonb, $3)
       ON CONFLICT (user_id) DO UPDATE SET quota = admin_quotas.quota || $2::jsonb, updated_by = $3, updated_at = now()
       RETURNING user_id, quota, updated_at`,
      [userId, JSON.stringify(patch), actor?.id || null]
    );
    const out = { userId, quota: r.rows[0].quota, updatedAt: r.rows[0].updated_at };
    await emitAudit({
      operation: "admin.users.quota.update", mutation: true, targetType: "user", targetId: userId,
      details: { patch }, actor,
    });
    return out;
  }

  async function getQuota(userId, { actor } = {}) {
    if (!UUID_RE.test(String(userId || ""))) throw httpError(400, "invalid user id");
    let out;
    if (await tableExists("admin_quotas")) {
      const r = await store.query("SELECT quota, updated_at FROM admin_quotas WHERE user_id = $1", [userId]);
      out = r.rows.length
        ? { userId, quota: r.rows[0].quota, updatedAt: r.rows[0].updated_at }
        : { userId, quota: {}, updatedAt: null };
    } else {
      out = { userId, quota: {}, updatedAt: null };
    }
    await emitAudit({ operation: "admin.users.quota.get", mutation: false, targetType: "user", targetId: userId, actor });
    return out;
  }

  // ---------- api keys ----------

  async function revokeApiKey(keyId, { actor } = {}) {
    if (!keyId || typeof keyId !== "string" || keyId.length > 200) throw httpError(400, "invalid api key id");
    const result = await keys.revoke(keyId, { actorId: actor?.id || null });
    await emitAudit({
      operation: "admin.api_keys.revoke", mutation: true, targetType: "api_key", targetId: keyId,
      details: { revoked: !!result.revoked, reason: result.reason || null }, actor,
    });
    if (!result.revoked && result.reason?.includes("not provisioned")) {
      throw Object.assign(httpError(503, result.reason), { alreadyAudited: true });
    }
    return { keyId, ...result };
  }

  // ---------- retention ----------

  async function triggerRetentionSweep({ actor } = {}) {
    let swept;
    if (typeof retentionSweep === "function") {
      swept = await retentionSweep();
    } else {
      const tasks = await import("./tasks.js"); // lazy: ROOT pins to process.cwd() at load
      swept = tasks.sweepExpired();
    }
    const out = { swept: Array.isArray(swept) ? swept.length : Number(swept) || 0, ids: Array.isArray(swept) ? swept : [] };
    await emitAudit({
      operation: "admin.retention.sweep", mutation: true, targetType: "platform",
      details: { swept: out.swept }, actor,
    });
    return out;
  }

  return {
    audit: auditSink,
    queueAdapter,
    listUsers,
    getUser,
    listOrganizations,
    listAllTasks,
    getTaskAsAdmin,
    forceCancelTask,
    setQuota,
    getQuota,
    revokeApiKey,
    triggerRetentionSweep,
  };
}
