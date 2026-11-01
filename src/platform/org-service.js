// Organization & membership service (phase 4.0.2).
// Enforces the role matrix at the service boundary (not only in HTTP routes):
//
//   operation            | owner | admin | member | viewer
//   ---------------------+-------+-------+--------+-------
//   read org / members   |  yes  |  yes  |  yes   |  yes
//   update org           |  yes  |  yes  |   no   |   no
//   invite member/viewer |  yes  |  yes  |   no   |   no
//   invite admin         |  yes  |   no  |   no   |   no
//   change role          |  yes  |  yes¹ |   no   |   no
//   remove member        |  yes  |  yes¹ |   no   |   no
//   delete org           |  yes  |   no  |   no   |   no
//   grant/transfer owner |  yes  |   no  |   no   |   no
//
// ¹ admin may only touch member/viewer rows, and may only set
//   admin/member/viewer roles. The owner row is untouchable by admins.
// Anti-escalation invariants:
//   - ownership transfer is the ONLY way a new owner is created, and the
//     transferring owner is demoted to admin (single-owner invariant);
//   - nobody can change their own role;
//   - the owner cannot be removed or demoted by anyone but themselves
//     (via transfer) or by deleting the org;
//   - self-removal is rejected (owner must transfer or delete the org).
// Removing a member does NOT touch that member's personal (user-owned)
// tasks/projects — only the org membership row goes away.
import crypto from "node:crypto";
import { query, withTransaction } from "../database/client.js";

export const ROLES = ["owner", "admin", "member", "viewer"];
const INVITABLE_ROLES = ["admin", "member", "viewer"];
const ROLE_RANK = { viewer: 0, member: 1, admin: 2, owner: 3 };
const DEFAULT_INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

export class ServiceError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}
const fail = (status, message) => {
  throw new ServiceError(status, message);
};

function hashToken(token) {
  return crypto.createHash("sha256").update(token).digest("hex");
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function assertUuid(value, label) {
  if (!UUID_RE.test(value || "")) fail(400, `invalid ${label}`);
  return value;
}

export function slugify(name) {
  const base = String(name || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  return base || "org";
}

async function getRole(orgId, userId) {
  const r = await query("SELECT role FROM org_members WHERE org_id = $1 AND user_id = $2", [orgId, userId]);
  return r.rows[0]?.role || null;
}

async function requireRole(orgId, userId, minRole) {
  const role = await getRole(orgId, userId);
  if (!role) fail(404, "organization not found"); // non-members must not learn the org exists
  if (ROLE_RANK[role] < ROLE_RANK[minRole]) fail(403, "insufficient organization permissions");
  return role;
}

// ---- organization CRUD ----

export async function createOrg({ userId, name, description, slug }) {
  if (!userId) fail(401, "authentication required");
  if (!name || typeof name !== "string" || name.trim().length === 0) fail(400, "organization name required");
  if (name.length > 200) fail(400, "organization name too long");
  if (description !== undefined && description !== null && (typeof description !== "string" || description.length > 2000)) {
    fail(400, "description must be a string of at most 2000 characters");
  }
  const baseSlug = (slug && typeof slug === "string" ? slug : slugify(name)).slice(0, 60).replace(/^-+|-+$/g, "") || "org";
  // slug collisions get a random suffix; unique index is the arbiter
  for (let attempt = 0; attempt < 5; attempt++) {
    const candidate = attempt === 0 ? baseSlug : `${baseSlug}-${crypto.randomBytes(3).toString("hex")}`;
    try {
      return await withTransaction(async (client) => {
        // owner_user_id is maintained alongside created_by so migration 010's
        // (task 4.0.1) tenant code keeps seeing the org owner
        const org = (await client.query(
          "INSERT INTO organizations (name, slug, description, created_by, owner_user_id) VALUES ($1, $2, $3, $4, $4) RETURNING *",
          [name.trim(), candidate, description ?? null, userId]
        )).rows[0];
        await client.query("INSERT INTO org_members (org_id, user_id, role) VALUES ($1, $2, 'owner')", [org.id, userId]);
        return { org, role: "owner" };
      });
    } catch (e) {
      if (e.code === "23505" && attempt < 4) continue;
      throw e;
    }
  }
  fail(500, "could not allocate organization slug");
}

export async function getOrg(orgId, userId) {
  assertUuid(orgId, "organization id");
  const r = await query(
    `SELECT o.*, m.role FROM organizations o
     JOIN org_members m ON m.org_id = o.id AND m.user_id = $2
     WHERE o.id = $1`,
    [orgId, userId]
  );
  if (!r.rows[0]) fail(404, "organization not found");
  return r.rows[0];
}

export async function listOrgs(userId) {
  const r = await query(
    `SELECT o.id, o.name, o.slug, o.description, o.created_at, m.role
     FROM organizations o JOIN org_members m ON m.org_id = o.id
     WHERE m.user_id = $1 ORDER BY o.created_at`,
    [userId]
  );
  return r.rows;
}

export async function updateOrg(orgId, userId, patch) {
  assertUuid(orgId, "organization id");
  await requireRole(orgId, userId, "admin");
  const updates = {};
  if (patch.name !== undefined) {
    if (typeof patch.name !== "string" || !patch.name.trim() || patch.name.length > 200) fail(400, "invalid organization name");
    updates.name = patch.name.trim();
  }
  if (patch.description !== undefined) {
    if (patch.description !== null && (typeof patch.description !== "string" || patch.description.length > 2000)) fail(400, "invalid description");
    updates.description = patch.description;
  }
  if (!Object.keys(updates).length) return getOrg(orgId, userId);
  const keys = Object.keys(updates);
  const r = await query(
    `UPDATE organizations SET ${keys.map((k, i) => `${k} = $${i + 2}`).join(", ")}, updated_at = now()
     WHERE id = $1 RETURNING *`,
    [orgId, ...keys.map((k) => updates[k])]
  );
  return r.rows[0];
}

export async function deleteOrg(orgId, userId) {
  assertUuid(orgId, "organization id");
  const role = await requireRole(orgId, userId, "owner");
  if (role !== "owner") fail(403, "only the owner can delete an organization");
  await withTransaction(async (client) => {
    await client.query("DELETE FROM org_invitations WHERE org_id = $1", [orgId]);
    await client.query("DELETE FROM org_members WHERE org_id = $1", [orgId]);
    await client.query("DELETE FROM organizations WHERE id = $1", [orgId]);
  });
  return { ok: true };
}

// ---- membership ----

export async function listMembers(orgId, userId) {
  assertUuid(orgId, "organization id");
  await requireRole(orgId, userId, "viewer");
  const r = await query(
    `SELECT m.user_id, m.role, m.created_at AS joined_at, u.email
     FROM org_members m JOIN users u ON u.id = m.user_id
     WHERE m.org_id = $1 ORDER BY m.created_at`,
    [orgId]
  );
  return r.rows;
}

// ---- invitations ----

export async function inviteMember({ orgId, actorId, email, role, ttlMs }) {
  assertUuid(orgId, "organization id");
  const actorRole = await requireRole(orgId, actorId, "admin");
  if (!INVITABLE_ROLES.includes(role)) fail(400, "role must be one of admin, member, viewer");
  // anti-escalation: inviting an admin is an owner-only power
  if (role === "admin" && actorRole !== "owner") fail(403, "only the owner can invite admins");
  if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) fail(400, "valid email required");
  const token = crypto.randomBytes(32).toString("hex");
  const ttl = Number.isFinite(ttlMs) ? ttlMs : DEFAULT_INVITE_TTL_MS;
  const expiresAt = new Date(Date.now() + ttl);
  const result = await query(
    `INSERT INTO org_invitations (org_id, email, role, token_hash, expires_at, created_by)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING id, email, role, status, expires_at, created_at`,
    [orgId, email.toLowerCase().trim(), role, hashToken(token), expiresAt, actorId]
  ).catch((e) => {
    if (e.code === "23505") fail(409, "a pending invitation for this email already exists");
    throw e;
  });
  // raw token is returned exactly once; only the hash is stored
  return { invitation: result.rows[0], token };
}

export async function listInvitations(orgId, actorId) {
  assertUuid(orgId, "organization id");
  await requireRole(orgId, actorId, "admin");
  const r = await query(
    `SELECT id, email, role, status, expires_at, created_at, accepted_at, revoked_at
     FROM org_invitations WHERE org_id = $1 ORDER BY created_at DESC`,
    [orgId]
  );
  return r.rows;
}

export async function revokeInvitation(orgId, inviteId, actorId) {
  assertUuid(orgId, "organization id");
  assertUuid(inviteId, "invitation id");
  await requireRole(orgId, actorId, "admin");
  const r = await query(
    `UPDATE org_invitations SET status = 'revoked', revoked_at = now()
     WHERE id = $1 AND org_id = $2 AND status = 'pending' RETURNING id`,
    [inviteId, orgId]
  );
  if (!r.rows[0]) fail(404, "pending invitation not found");
  return { ok: true };
}

export async function acceptInvitation(token, userId) {
  if (!token || typeof token !== "string") fail(400, "invitation token required");
  if (!userId) fail(401, "authentication required");
  const tokenHash = hashToken(token);
  return withTransaction(async (client) => {
    const inv = (await client.query("SELECT * FROM org_invitations WHERE token_hash = $1 FOR UPDATE", [tokenHash])).rows[0];
    if (!inv) fail(404, "invalid invitation token");
    if (inv.status === "accepted") fail(409, "invitation already accepted");
    if (inv.status === "revoked") fail(409, "invitation has been revoked");
    if (new Date(inv.expires_at).getTime() <= Date.now()) fail(410, "invitation expired");
    const user = (await client.query("SELECT email FROM users WHERE id = $1", [userId])).rows[0];
    if (!user) fail(401, "authentication required");
    // invitations are per-email: a token may not be redeemed by another account
    if (user.email !== inv.email) fail(403, "invitation was issued to a different account");
    await client.query(
      "INSERT INTO org_members (org_id, user_id, role) VALUES ($1, $2, $3)",
      [inv.org_id, userId, inv.role]
    ).catch((e) => {
      if (e.code === "23505") fail(409, "already a member of this organization");
      throw e;
    });
    await client.query(
      "UPDATE org_invitations SET status = 'accepted', accepted_by = $2, accepted_at = now() WHERE id = $1",
      [inv.id, userId]
    );
    return { ok: true, orgId: inv.org_id, role: inv.role };
  });
}

// ---- role management ----

export async function changeMemberRole(orgId, actorId, targetUserId, newRole) {
  assertUuid(orgId, "organization id");
  assertUuid(targetUserId, "member id");
  if (!ROLES.includes(newRole)) fail(400, "role must be one of owner, admin, member, viewer");
  const actorRole = await requireRole(orgId, actorId, "admin");
  if (actorId === targetUserId) fail(400, "cannot change your own role");
  const targetRole = await getRole(orgId, targetUserId);
  if (!targetRole) fail(404, "member not found");
  if (targetRole === "owner") fail(403, "the owner role can only be changed via ownership transfer by the owner");
  if (newRole === "owner") {
    if (actorRole !== "owner") fail(403, "only the owner can transfer ownership");
    // single-owner invariant: grantee becomes owner, grantor is demoted to admin
    return withTransaction(async (client) => {
      await client.query("UPDATE org_members SET role = 'owner', updated_at = now() WHERE org_id = $1 AND user_id = $2", [orgId, targetUserId]);
      await client.query("UPDATE org_members SET role = 'admin', updated_at = now() WHERE org_id = $1 AND user_id = $2", [orgId, actorId]);
      return { userId: targetUserId, role: "owner", previousOwnerRole: "admin" };
    });
  }
  // admins may only touch member/viewer rows (documented matrix)
  if (actorRole === "admin" && !["member", "viewer"].includes(targetRole)) fail(403, "admins can only manage member and viewer roles");
  await query("UPDATE org_members SET role = $3, updated_at = now() WHERE org_id = $1 AND user_id = $2", [orgId, targetUserId, newRole]);
  return { userId: targetUserId, role: newRole };
}

export async function removeMember(orgId, actorId, targetUserId) {
  assertUuid(orgId, "organization id");
  assertUuid(targetUserId, "member id");
  const actorRole = await requireRole(orgId, actorId, "admin");
  if (actorId === targetUserId) fail(400, "cannot remove yourself (owner must transfer ownership or delete the organization)");
  const targetRole = await getRole(orgId, targetUserId);
  if (!targetRole) fail(404, "member not found");
  if (targetRole === "owner") fail(403, "the owner cannot be removed (transfer ownership first)");
  // admins may only remove member/viewer; removing another admin needs the owner
  if (actorRole === "admin" && targetRole === "admin") fail(403, "only the owner can remove an admin");
  // NOTE: this deletes only the membership row. The removed user's personal
  // (user-owned) tasks/projects stay untouched; org-scoped resources remain
  // owned by the organization (phase 4.0.2 step 8).
  await query("DELETE FROM org_members WHERE org_id = $1 AND user_id = $2", [orgId, targetUserId]);
  return { ok: true };
}
