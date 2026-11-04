// Audit service (task 4.0.9): append-only, tamper-evident audit trail.
//
// Design
//   • Single append point: every row is written through recordAuditEvent().
//     There is intentionally NO update or delete function in this module.
//   • Hash chain: payload_hash = sha256(prev_hash + canonical_payload). The
//     first row chains from GENESIS_PREV_HASH. verifyAuditChain() walks the
//     chain and reports the first broken row id. Any out-of-band UPDATE or
//     mid-row DELETE is detected; deleting the newest row is not (standard
//     hash-chain limitation) — pair with external anchoring if needed.
//   • Concurrency: chain writes are serialized with a transaction-scoped
//     advisory lock, so parallel recorders cannot fork the chain.
//   • Allowlisted, versioned event schema (v1). Unknown actions are rejected —
//     the audit trail must not become a free-form data dump (plan §4.0.9 risk
//     note: audit logs are a secondary leak vector).
//   • Redaction: metadata keys matching SENSITIVE_KEY are replaced with
//     "[REDACTED]" before storage AND before hashing.
//   • No foreign keys: audit rows outlive the user/task/org they describe.
//
// Role separation note: this codebase has one DB role, so "ordinary users
// cannot alter audit history" is enforced by the absence of mutation code
// paths here, not by GRANTs. A production deployment should add a dedicated
// audit role with INSERT-only rights on audit_events.
//
// Retention (plan step 8): rows are kept 365 days by default
// (AUDIT_RETENTION_DAYS). Pruning must go archive → verifyAuditChain() on the
// archive → delete prefix → restart chain at GENESIS, because a plain prefix
// delete breaks the chain by design. A purge routine is deliberately NOT
// provided in this module.
//
// Integrator wiring: import { queryAuditEvents, verifyAuditChain } and expose
// behind admin auth; tenant queries pass orgId, platform-wide queries pass
// platformWide: true (queryAuditEvents refuses unscoped queries otherwise).

import crypto from "node:crypto";
import { query, withTransaction } from "../database/client.js";

export const AUDIT_SCHEMA_VERSION = 1;
export const GENESIS_PREV_HASH = "GENESIS";
export const AUDIT_RETENTION_DAYS = 365;

// Allowlisted event schema v1. Adding actions = schema version bump territory.
export const AUDIT_ACTIONS = new Set([
  // auth + sessions
  "auth.register", "auth.login.success", "auth.login.failure",
  "auth.logout", "auth.session.revoked",
  // task lifecycle
  "task.create", "task.cancel", "task.export", "task.delete",
  // organizations
  "org.create", "org.member.add", "org.member.remove", "org.role.update",
  // api keys
  "apikey.create", "apikey.revoke", "apikey.delete",
  // admin
  "admin.access", "admin.action",
  // throttling / abuse
  "quota.denied", "ratelimit.hit",
]);

const ACTOR_TYPES = new Set(["user", "service", "anonymous"]);
const OUTCOMES = new Set(["success", "failure", "denied"]);
const SENSITIVE_KEY = /pass|pwd|secret|token|api[_-]?key|authorization|bearer|cookie|credential|session/i;
const MAX_METADATA_JSON = 8192;
const AUDIT_ADVISORY_KEY = 1097857385; // serializes hash-chain appends
export { AUDIT_ADVISORY_KEY }; // so maintenance scripts (test cleanup) share the same lock

const sha256 = (s) => crypto.createHash("sha256").update(s, "utf8").digest("hex");

// Symmetric TEXT coercion (G5.4 fix): every hashed field must produce EXACTLY
// the TEXT PostgreSQL stores, because verifyAuditChain() re-reads that TEXT and
// re-hashes the string form. The old cap() passed non-strings through, so a
// caller-controlled number/object/email (server.js:86 feeds raw req.body.email
// into loginFailure) hashed the OBJECT form at write time while the stored
// TEXT column got pg's JSON.stringify(number/object) — the stored hash could
// then never verify again (dev-db rows 858-860: actor_email '42', '{"x"}',
// '{"toString":1}' — permanent false breaks found by the G5.4 hostile hunt).
// pg's TEXT serialization: string → as-is; Buffer → utf8 bytes;
// number/boolean/bigint → String(v); object/array → JSON.stringify(v).
const cap = (v, n) => {
  if (v == null) return null;
  let s;
  if (typeof v === "string") s = v;
  else if (typeof v === "object") s = Buffer.isBuffer(v) ? v.toString("utf8") : JSON.stringify(v);
  else s = String(v);
  return s == null ? null : s.slice(0, n);
};

// Deterministic JSON: recursively sorted object keys, compact separators.
// Arrays keep their order. Used both when writing (hash input) and when
// verifying (recomputed from the stored row), so it must never depend on
// insertion order.
function canonicalize(value) {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value) ?? "null"; // undefined → "null" via ?? only when nullish
  }
  if (Array.isArray(value)) return "[" + value.map(canonicalize).join(",") + "]";
  const keys = Object.keys(value).sort();
  return "{" + keys.map((k) => JSON.stringify(k) + ":" + canonicalize(value[k])).join(",") + "}";
}

// Deep-clone metadata with sensitive keys blanked. Key-based, deterministic.
export function redactMetadata(value) {
  if (value === null || typeof value !== "object") return value ?? null;
  if (Array.isArray(value)) return value.map(redactMetadata);
  const out = {};
  for (const [k, v] of Object.entries(value)) {
    out[k] = SENSITIVE_KEY.test(k) ? "[REDACTED]" : redactMetadata(v);
  }
  return out;
}

// Payload definition shared by write and verify paths. Everything that
// defines the event is hashed: schema version, ts (ISO, ms precision),
// actor, tenant, action, outcome, target, redacted metadata, correlation id,
// ip. NOT hashed: id, prev_hash, payload_hash themselves.
function buildPayload({ tsIso, schemaVersion, actorType, actorId, actorEmail, orgId, apiKeyId, sessionId, action, outcome, targetType, targetId, metadata, correlationId, ip }) {
  return canonicalize({
    schema_version: schemaVersion,
    ts: tsIso,
    actor_type: actorType,
    actor_id: actorId,
    actor_email: actorEmail,
    org_id: orgId,
    api_key_id: apiKeyId,
    session_id: sessionId,
    action,
    outcome,
    target_type: targetType,
    target_id: targetId,
    metadata,
    correlation_id: correlationId,
    ip,
  });
}

const computePayloadHash = (prevHash, payload) => sha256(prevHash + payload);

export function computeEventHash(prevHash, event) {
  return computePayloadHash(prevHash, buildPayload(event));
}

/**
 * Append one audit event. Throws on invalid input (unknown action, bad
 * outcome) and on DB errors — audit failures are fail-closed. Use
 * recordAuditEventSafe() where a business flow must not break because the
 * audit sink is down.
 *
 * @param {object} evt { action, actorType?, actorId?, actorEmail?, orgId?,
 *   apiKeyId?, sessionId?, outcome?, targetType?, targetId?, metadata?,
 *   correlationId?, ip?, ts? (Date, else now) }
 * @returns {object} { id, ts, prevHash, payloadHash }
 */
export async function recordAuditEvent(evt) {
  if (!evt || typeof evt !== "object") throw new Error("audit event object required");
  const action = typeof evt.action === "string" ? evt.action : "";
  if (!AUDIT_ACTIONS.has(action)) {
    throw new Error(`audit action not in allowlisted schema v${AUDIT_SCHEMA_VERSION}: ${JSON.stringify(action)}`);
  }
  const actorType = evt.actorType ?? "user";
  if (!ACTOR_TYPES.has(actorType)) throw new Error(`invalid actor_type: ${actorType}`);
  const outcome = evt.outcome ?? "success";
  if (!OUTCOMES.has(outcome)) throw new Error(`invalid outcome: ${outcome}`);

  // Redact, then round-trip through JSON so the write-side canonical form is
  // byte-identical to what verifyAuditChain() recomputes from the JSONB
  // round trip (JSONB normalizes numeric literals and key order).
  let metadata = redactMetadata(evt.metadata ?? {});
  metadata = JSON.parse(JSON.stringify(metadata ?? {}));
  const payloadForSize = buildPayload({ tsIso: "0", schemaVersion: AUDIT_SCHEMA_VERSION, actorType, actorId: cap(evt.actorId, 64), actorEmail: cap(evt.actorEmail, 320), orgId: cap(evt.orgId, 128), apiKeyId: cap(evt.apiKeyId, 128), sessionId: cap(evt.sessionId, 64), action, outcome, targetType: cap(evt.targetType, 128), targetId: cap(evt.targetId, 256), metadata, correlationId: cap(evt.correlationId, 128), ip: cap(evt.ip, 64) });
  if (payloadForSize.length > MAX_METADATA_JSON) {
    metadata = { truncated: true, reason: "metadata exceeded size budget", original_payload_chars: payloadForSize.length };
  }

  const ts = evt.ts instanceof Date ? evt.ts : new Date();
  const fields = {
    tsIso: ts.toISOString(),
    schemaVersion: AUDIT_SCHEMA_VERSION,
    actorType,
    actorId: cap(evt.actorId, 64),
    actorEmail: cap(evt.actorEmail, 320),
    orgId: cap(evt.orgId, 128),
    apiKeyId: cap(evt.apiKeyId, 128),
    sessionId: cap(evt.sessionId, 64),
    action,
    outcome,
    targetType: cap(evt.targetType, 128),
    targetId: cap(evt.targetId, 256),
    metadata,
    correlationId: cap(evt.correlationId, 128),
    ip: cap(evt.ip, 64),
  };

  return withTransaction(async (client) => {
    // Serialize chain appends; released at COMMIT/ROLLBACK.
    await client.query("SELECT pg_advisory_xact_lock($1)", [AUDIT_ADVISORY_KEY]);
    const last = await client.query("SELECT payload_hash FROM audit_events ORDER BY id DESC LIMIT 1");
    const prevHash = last.rows.length ? last.rows[0].payload_hash : GENESIS_PREV_HASH;
    const payloadHash = computePayloadHash(prevHash, buildPayload(fields));
    const ins = await client.query(
      `INSERT INTO audit_events
        (ts, schema_version, actor_type, actor_id, actor_email, org_id, api_key_id, session_id,
         action, outcome, target_type, target_id, metadata, correlation_id, ip, prev_hash, payload_hash)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
       RETURNING id, ts`,
      [ts, fields.schemaVersion, fields.actorType, fields.actorId, fields.actorEmail, fields.orgId,
       fields.apiKeyId, fields.sessionId, fields.action, fields.outcome, fields.targetType,
       fields.targetId, JSON.stringify(fields.metadata), fields.correlationId, fields.ip,
       prevHash, payloadHash]
    );
    return { id: ins.rows[0].id, ts: ins.rows[0].ts, prevHash, payloadHash };
  });
}

/** Non-throwing wrapper: logs and continues when the audit sink fails. */
export async function recordAuditEventSafe(evt) {
  try {
    return await recordAuditEvent(evt);
  } catch (e) {
    console.error("[audit] recording failed:", e.message);
    return null;
  }
}

// Thin emitters — the service-call surface other modules use. Each maps to
// exactly one allowlisted action; defaults encode the event family.
export const audit = {
  register: (p) => recordAuditEvent({ ...p, action: "auth.register" }),
  loginSuccess: (p) => recordAuditEvent({ ...p, action: "auth.login.success" }),
  loginFailure: (p) => recordAuditEvent({ ...p, action: "auth.login.failure", outcome: "failure" }),
  logout: (p) => recordAuditEvent({ ...p, action: "auth.logout" }),
  sessionRevoked: (p) => recordAuditEvent({ ...p, action: "auth.session.revoked" }),
  taskCreate: (p) => recordAuditEvent({ ...p, action: "task.create", targetType: p.targetType ?? "task" }),
  taskCancel: (p) => recordAuditEvent({ ...p, action: "task.cancel", targetType: p.targetType ?? "task" }),
  taskExport: (p) => recordAuditEvent({ ...p, action: "task.export", targetType: p.targetType ?? "task" }),
  taskDelete: (p) => recordAuditEvent({ ...p, action: "task.delete", targetType: p.targetType ?? "task" }),
  orgCreate: (p) => recordAuditEvent({ ...p, action: "org.create", targetType: p.targetType ?? "org" }),
  orgMemberAdd: (p) => recordAuditEvent({ ...p, action: "org.member.add", targetType: p.targetType ?? "membership" }),
  orgMemberRemove: (p) => recordAuditEvent({ ...p, action: "org.member.remove", targetType: p.targetType ?? "membership" }),
  orgRoleUpdate: (p) => recordAuditEvent({ ...p, action: "org.role.update", targetType: p.targetType ?? "membership" }),
  apikeyCreate: (p) => recordAuditEvent({ ...p, action: "apikey.create", targetType: p.targetType ?? "api_key" }),
  apikeyRevoke: (p) => recordAuditEvent({ ...p, action: "apikey.revoke", targetType: p.targetType ?? "api_key" }),
  apikeyDelete: (p) => recordAuditEvent({ ...p, action: "apikey.delete", targetType: p.targetType ?? "api_key" }),
  adminAccess: (p) => recordAuditEvent({ ...p, action: "admin.access" }),
  adminAction: (p) => recordAuditEvent({ ...p, action: "admin.action" }),
  quotaDenied: (p) => recordAuditEvent({ ...p, action: "quota.denied", outcome: "denied" }),
  ratelimitHit: (p) => recordAuditEvent({ ...p, action: "ratelimit.hit", outcome: "denied" }),
};

/**
 * Admin query API with actor/action/time filters (plan step 7).
 * Refuses unscoped queries unless platformWide: true — tenant scoping is
 * enforced at the service boundary; only trusted admin code may pass
 * platformWide.
 *
 * @param {object} f { actorId?, actorEmail?, orgId?, apiKeyId?, action?,
 *   actionPrefix?, outcome?, targetType?, targetId?, correlationId?,
 *   from?, to?, limit?, offset?, platformWide?, withCount? }
 */
export async function queryAuditEvents(f = {}) {
  const where = [];
  const params = [];
  const add = (clause, value) => { params.push(value); where.push(clause.replace("?", `$${params.length}`)); };
  if (f.actorId) add("actor_id = ?", f.actorId);
  if (f.actorEmail) add("actor_email = ?", f.actorEmail);
  if (f.orgId) add("org_id = ?", f.orgId);
  if (f.apiKeyId) add("api_key_id = ?", f.apiKeyId);
  if (f.action) add("action = ?", f.action);
  if (f.actionPrefix) add("action LIKE ? || '%'", f.actionPrefix);
  if (f.outcome) add("outcome = ?", f.outcome);
  if (f.targetType) add("target_type = ?", f.targetType);
  if (f.targetId) add("target_id = ?", f.targetId);
  if (f.correlationId) add("correlation_id = ?", f.correlationId);
  if (f.from) add("ts >= ?", f.from instanceof Date ? f.from.toISOString() : f.from);
  if (f.to) add("ts <= ?", f.to instanceof Date ? f.to.toISOString() : f.to);
  if (!where.length && !f.platformWide) {
    throw new Error("unscoped audit query refused — pass orgId/actorId/apiKeyId/correlationId, or platformWide:true for admin queries");
  }
  const whereSql = where.length ? "WHERE " + where.join(" AND ") : "";
  // G5.1 hunt fix: a garbage ?limit=abc / ?offset=abc produced NaN, and NaN is
  // truthy-stringified into the SQL as `LIMIT nan` → Postgres parsed it as a
  // column reference → 500 "column \"nan\" does not exist". NaN (or any
  // non-numeric input) now falls back to the default, and the values stay
  // integer-clamped before interpolation.
  const limit = Math.min(Math.max(Number(f.limit ?? 100) || 100, 1), 1000);
  const offset = Math.max(Number(f.offset ?? 0) || 0, 0);
  const sql = `SELECT id, ts, schema_version, actor_type, actor_id, actor_email, org_id, api_key_id, session_id,
    action, outcome, target_type, target_id, metadata, correlation_id, ip, prev_hash, payload_hash
    FROM audit_events ${whereSql} ORDER BY ts DESC, id DESC LIMIT ${limit} OFFSET ${offset}`;
  const result = await query(sql, params);
  let total = undefined;
  if (f.withCount) {
    const c = await query(`SELECT count(*)::int AS n FROM audit_events ${whereSql}`, params);
    total = c.rows[0].n;
  }
  return { events: result.rows, total };
}

/**
 * JSONL export for archival (plan step 8, export policy). Same filters as
 * queryAuditEvents; cap with limit (max 10000).
 */
export async function exportAuditEvents(f = {}) {
  const { events } = await queryAuditEvents({ ...f, platformWide: true, limit: Math.min(Number(f.limit ?? 1000), 10000) });
  return {
    exportedAt: new Date().toISOString(),
    schemaVersion: AUDIT_SCHEMA_VERSION,
    retentionDays: AUDIT_RETENTION_DAYS,
    count: events.length,
    jsonl: events.map((e) => JSON.stringify(e)).join("\n"),
  };
}

/**
 * Walk the full hash chain (oldest → newest) and verify every link:
 *   1. prev_hash linkage (GENESIS for row 1, previous payload_hash after)
 *   2. payload_hash = sha256(prev_hash + payload) recomputed from the row
 * Detects any out-of-band UPDATE, mid-chain DELETE or hash rewrite.
 *
 * @param {object} o { limit?: max rows to check (default 50000) }
 * @returns {object} { ok, checked, brokenAt, errors[] }
 */
export async function verifyAuditChain({ limit = 50000 } = {}) {
  const errors = [];
  let prevHash = GENESIS_PREV_HASH;
  let checked = 0;
  let brokenAt = null;
  let first = true;
  const BATCH = 1000;
  for (let offset = 0; offset < limit; offset += BATCH) {
    const res = await query(
      `SELECT id, ts, schema_version, actor_type, actor_id, actor_email, org_id, api_key_id, session_id,
              action, outcome, target_type, target_id, metadata, correlation_id, ip, prev_hash, payload_hash
       FROM audit_events ORDER BY id ASC LIMIT $1 OFFSET $2`,
      [BATCH, offset]
    );
    for (const row of res.rows) {
      checked++;
      const expectedPrev = first ? GENESIS_PREV_HASH : prevHash;
      if (row.prev_hash !== expectedPrev) {
        if (brokenAt === null) brokenAt = row.id;
        errors.push({ id: row.id, reason: "prev_hash mismatch", expected: expectedPrev, found: row.prev_hash });
      }
      const payload = buildPayload({
        tsIso: row.ts.toISOString(),
        schemaVersion: row.schema_version,
        actorType: row.actor_type,
        actorId: row.actor_id,
        actorEmail: row.actor_email,
        orgId: row.org_id,
        apiKeyId: row.api_key_id,
        sessionId: row.session_id,
        action: row.action,
        outcome: row.outcome,
        targetType: row.target_type,
        targetId: row.target_id,
        metadata: row.metadata ?? {},
        correlationId: row.correlation_id,
        ip: row.ip,
      });
      const recomputed = computePayloadHash(row.prev_hash, payload);
      if (recomputed !== row.payload_hash) {
        if (brokenAt === null) brokenAt = row.id;
        errors.push({ id: row.id, reason: "payload_hash mismatch", expected: recomputed, found: row.payload_hash });
      }
      prevHash = row.payload_hash;
      first = false;
    }
    if (res.rows.length < BATCH) break;
  }
  return { ok: errors.length === 0, checked, brokenAt, errors: errors.slice(0, 20) };
}
