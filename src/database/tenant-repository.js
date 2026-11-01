// Tenant repository (task 4.0.1): organizations, org_members, org-scoped
// task access. Every org-scoped read here filters by the resolved tenant
// context { userId, orgId, role } — authorization lives at the repository
// boundary, not only in HTTP routes (plan step 3).
//
// Ownership model:
//   • a task is user-owned when org_id IS NULL → access requires user_id match
//   • a task is org-owned when org_id IS NOT NULL → access requires membership
//     in that org. User ownership of an org task does NOT bypass membership.
//
// Migration 010 (forward-only) creates organizations, org_members and
// tasks.org_id. Existing rows keep org_id NULL → identical access semantics
// to the pre-tenant per-user ownership.
import { query, withTransaction } from "../database/client.js";

// DB task/org ids are UUIDs (migration 001/010). Anything else (guessed ids,
// injection-shaped strings) is denied BEFORE it reaches PostgreSQL — a cast
// error must never surface as a 500 or as information about the schema.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isUuid = (v) => typeof v === "string" && UUID_RE.test(v);

// Org CRUD --------------------------------------------------------------------

export async function createOrganization({ name, slug, ownerUserId }) {
  if (!name || typeof name !== "string") throw new TenantError("organization name required");
  if (!slug || !/^[a-z0-9](?:[a-z0-9-]{1,62}[a-z0-9])?$/.test(slug)) {
    throw new TenantError("invalid slug: 1-64 chars, lowercase letters, digits, hyphens, no leading/trailing hyphen");
  }
  if (!ownerUserId) throw new TenantError("ownerUserId required");
  // Org + owner membership are created atomically: an organization without an
  // owner member row would be unreachable forever.
  return withTransaction(async (client) => {
    const org = await client.query(
      `INSERT INTO organizations (name, slug, owner_user_id) VALUES ($1, $2, $3)
       RETURNING id, name, slug, owner_user_id AS "ownerUserId", status, created_at`,
      [name, slug, ownerUserId]
    ).catch((e) => rethrowTenantViolation(e, client));
    await client.query(
      `INSERT INTO org_members (org_id, user_id, role) VALUES ($1, $2, 'owner')`,
      [org.rows[0].id, ownerUserId]
    );
    return org.rows[0];
  });
}

export async function getOrganization(orgId) {
  const r = await query(
    `SELECT id, name, slug, owner_user_id AS "ownerUserId", status, created_at FROM organizations WHERE id = $1`,
    [orgId]
  );
  return r.rows[0] || null;
}

// Membership ------------------------------------------------------------------

export async function addOrgMember(orgId, userId, role = "member") {
  if (!["owner", "admin", "member"].includes(role)) throw new TenantError(`invalid org role: ${role}`);
  return query(
    `INSERT INTO org_members (org_id, user_id, role) VALUES ($1, $2, $3)
     ON CONFLICT (org_id, user_id) DO UPDATE SET role = EXCLUDED.role`,
    [orgId, userId, role]
  ).then(() => true).catch(rethrowTenantViolation);
}

export async function removeOrgMember(orgId, userId) {
  // An organization must always keep at least one owner.
  const ownerCount = await query(
    `SELECT count(*)::int AS n FROM org_members WHERE org_id = $1 AND role = 'owner'`,
    [orgId]
  );
  const target = await query(
    `SELECT role FROM org_members WHERE org_id = $1 AND user_id = $2`,
    [orgId, userId]
  );
  if (target.rows[0]?.role === "owner" && ownerCount.rows[0].n <= 1) {
    throw new TenantError("cannot remove the last owner of an organization");
  }
  await query(`DELETE FROM org_members WHERE org_id = $1 AND user_id = $2`, [orgId, userId]);
  return true;
}

export async function getOrgMember(orgId, userId) {
  const r = await query(
    `SELECT org_id AS "orgId", user_id AS "userId", role, created_at AS "joinedAt"
     FROM org_members WHERE org_id = $1 AND user_id = $2`,
    [orgId, userId]
  );
  return r.rows[0] || null;
}

export async function listUserOrganizations(userId) {
  const r = await query(
    `SELECT o.id, o.name, o.slug, o.status, m.role, m.created_at AS "joinedAt"
     FROM org_members m JOIN organizations o ON o.id = m.org_id
     WHERE m.user_id = $1 ORDER BY m.created_at`,
    [userId]
  );
  return r.rows;
}

// Role helpers --------------------------------------------------------------
// owner > admin > member

export function roleRank(role) {
  return { owner: 3, admin: 2, member: 1 }[role] || 0;
}

export function roleAtLeast(role, min) {
  return roleRank(role) >= roleRank(min);
}

// Tenant context resolution ---------------------------------------------------
// Resolves { userId, orgId, role } for one user in one organization. Returns
// null when the org does not exist or the user is not a member → callers fail
// closed (tenant-scope middleware turns null into 403).
export async function resolveTenantContext(userId, orgId) {
  if (!userId) return null;
  if (orgId && !isUuid(orgId)) return null; // malformed org id → deny, no query
  if (!orgId) {
    // No org requested → personal workspace context. Nothing here authorizes
    // org resources; org-scoped repository calls reject null orgId.
    return { userId, orgId: null, role: null, personal: true };
  }
  const r = await query(
    `SELECT m.role FROM org_members m JOIN organizations o ON o.id = m.org_id
     WHERE m.org_id = $1 AND m.user_id = $2 AND o.status = 'active'`,
    [orgId, userId]
  );
  const row = r.rows[0];
  if (!row) return null; // not a member (or org inactive) → deny
  return { userId, orgId, role: row.role, personal: false };
}

// Org-scoped task queries -------------------------------------------------------
// Context-shaped: take { userId, orgId, role } as resolved by
// resolveTenantContext/tenant-scope and filter every statement by it.

export async function createOrgTask({ ctx, url, options = {} }) {
  assertOrgContext(ctx);
  const r = await query(
    `INSERT INTO tasks (user_id, org_id, source_url, options) VALUES ($1, $2, $3, $4) RETURNING *`,
    [ctx.userId, ctx.orgId, url, JSON.stringify(options)]
  );
  return r.rows[0];
}

export async function getOrgTask(taskId, ctx) {
  assertOrgContext(ctx);
  if (!isUuid(taskId)) return null; // malformed id → deny, no existence leak
  const r = await query(
    `SELECT t.* FROM tasks t
     JOIN org_members m ON m.org_id = t.org_id AND m.user_id = $3
     WHERE t.id = $1 AND t.org_id = $2`,
    [taskId, ctx.orgId, ctx.userId]
  );
  return r.rows[0] || null;
}

// Unified scoped read: org context → membership-filtered org task; personal
// context → the user's own task AND org_id IS NULL (org tasks are never
// reachable through the personal workspace, even for their creator).
export async function getScopedTask(taskId, ctx) {
  if (!ctx?.userId) return null;
  if (!isUuid(taskId)) return null;
  if (!ctx.orgId) {
    const r = await query(
      `SELECT * FROM tasks WHERE id = $1 AND user_id = $2 AND org_id IS NULL`,
      [taskId, ctx.userId]
    );
    return r.rows[0] || null;
  }
  return getOrgTask(taskId, ctx);
}

export async function listOrgTasks(ctx, { status, limit = 50, offset = 0 } = {}) {
  assertOrgContext(ctx);
  let sql = `SELECT t.* FROM tasks t
     JOIN org_members m ON m.org_id = t.org_id AND m.user_id = $2
     WHERE t.org_id = $1`;
  const params = [ctx.orgId, ctx.userId];
  if (status) { sql += ` AND t.status = $${params.length + 1}`; params.push(status); }
  sql += ` ORDER BY t.created_at DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`;
  params.push(limit, offset);
  return query(sql, params).then((r) => r.rows);
}

export async function updateOrgTask(taskId, ctx, patch) {
  if (!isUuid(taskId)) return null;
  const keys = Object.keys(patch || {});
  if (!keys.length) return getOrgTask(taskId, ctx);
  const sets = keys.map((k, i) => `${k} = $${i + 4}`).join(", ");
  const values = keys.map((k) => patch[k]);
  const r = await query(
    `UPDATE tasks t SET ${sets}, updated_at = now()
     WHERE t.id = $1 AND t.org_id = $2
       AND EXISTS (SELECT 1 FROM org_members m WHERE m.org_id = t.org_id AND m.user_id = $3)
     RETURNING t.*`,
    [taskId, ctx.orgId, ctx.userId, ...values]
  );
  return r.rows[0] || null;
}

export async function deleteOrgTask(taskId, ctx) {
  if (!isUuid(taskId)) return false;
  const r = await query(
    `DELETE FROM tasks t
     WHERE t.id = $1 AND t.org_id = $2
       AND EXISTS (SELECT 1 FROM org_members m WHERE m.org_id = t.org_id AND m.user_id = $3)`,
    [taskId, ctx.orgId, ctx.userId]
  );
  return (r.rowCount || 0) > 0;
}

// Returns { task, artifacts } when the context may see the task, else null.
export async function getOrgTaskWithArtifacts(taskId, ctx) {
  const task = await getOrgTask(taskId, ctx);
  if (!task) return null;
  const r = await query(`SELECT * FROM artifacts WHERE task_id = $1 ORDER BY created_at`, [taskId]);
  return { task, artifacts: r.rows };
}

export async function getScopedTaskWithArtifacts(taskId, ctx) {
  const task = await getScopedTask(taskId, ctx);
  if (!task) return null;
  const r = await query(`SELECT * FROM artifacts WHERE task_id = $1 ORDER BY created_at`, [taskId]);
  return { task, artifacts: r.rows };
}

// For background jobs: verify one trusted ownership triple WITHOUT going
// through a request context. Returns the task row when the worker identity
// matches what the server recorded, else null (plan step 6 — jobs carry
// trusted ownership metadata established by the server; workers must never
// widen it).
export async function getTaskForJob(taskId, { userId, orgId }) {
  if (!taskId || !userId || !isUuid(taskId)) return null;
  if (orgId) {
    const r = await query(
      `SELECT * FROM tasks WHERE id = $1 AND org_id = $2 AND user_id = $3`,
      [taskId, orgId, userId]
    );
    return r.rows[0] || null;
  }
  const r = await query(`SELECT * FROM tasks WHERE id = $1 AND user_id = $2 AND org_id IS NULL`, [taskId, userId]);
  return r.rows[0] || null;
}

// Security logging (plan step 8): append-only trail of authorization denials.
// Writes to tenant_denials (migration 010); failure to log never breaks the
// request path.
export async function logTenantDenial({ userId, orgId, action, resourceType, resourceId, reason, ip }) {
  try {
    await query(
      `INSERT INTO tenant_denials (user_id, org_id, action, resource_type, resource_id, reason, ip)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [userId || null, orgId || null, action || "unknown", resourceType || null, resourceId || null, reason || "unspecified", ip || null]
    );
  } catch { /* audit is best-effort; denial handling always completes */ }
}

export async function listTenantDenials({ orgId, userId, limit = 50, offset = 0 } = {}) {
  let sql = `SELECT id, user_id AS "userId", org_id AS "orgId", action, resource_type AS "resourceType",
                    resource_id AS "resourceId", reason, ip, created_at AS "at"
             FROM tenant_denials`;
  const params = [];
  if (orgId) { params.push(orgId); sql += ` WHERE org_id = $${params.length}`; }
  if (userId) { params.push(userId); sql += ` ${orgId ? "AND" : "WHERE"} user_id = $${params.length}`; }
  sql += ` ORDER BY created_at DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`;
  params.push(limit, offset);
  return query(sql, params).then((r) => r.rows);
}

export class TenantError extends Error {
  constructor(message) {
    super(message);
    this.name = "TenantError";
    this.status = 400;
  }
}

function assertOrgContext(ctx) {
  if (!ctx || !ctx.userId || !ctx.orgId) {
    throw new TenantError("org-scoped operation requires a resolved tenant context { userId, orgId }");
  }
}

function rethrowTenantViolation(e, _client) {
  if (e?.code === "23505") return Promise.reject(new TenantError("organization slug already in use"));
  if (e?.code === "23503") return Promise.reject(new TenantError("referenced organization or user does not exist"));
  return Promise.reject(e);
}
