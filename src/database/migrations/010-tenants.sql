-- Migration 010: multi-tenant data isolation (task 4.0.1)
-- FORWARD-ONLY. Adds organizations, org_members (roles owner/admin/member) and
-- org-scoped task linkage.
--
-- Backward compatible by construction:
--   • both new tables start empty; nothing existing is rewritten
--   • tasks.org_id is NULLABLE — NULL means "user-owned / personal workspace",
--     i.e. the exact pre-tenant behavior of every existing task row
--   • all statements are IF NOT EXISTS so re-running a partially applied file
--     (or a database where another tool created an object) stays idempotent

CREATE TABLE IF NOT EXISTS organizations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  slug TEXT UNIQUE NOT NULL,
  owner_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'active',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Membership with the three tenant roles. One row per (org, user).
CREATE TABLE IF NOT EXISTS org_members (
  org_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('owner', 'admin', 'member')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, user_id)
);

-- Org-scoped task linkage: a task is either user-owned (org_id IS NULL) or
-- owned by exactly one organization (org_id set). Deleting an organization
-- demotes its tasks back to their creator's personal workspace (SET NULL)
-- rather than destroying user data.
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS org_id UUID REFERENCES organizations(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_organizations_owner ON organizations(owner_user_id);
CREATE INDEX IF NOT EXISTS idx_org_members_user ON org_members(user_id);
CREATE INDEX IF NOT EXISTS idx_tasks_org_id ON tasks(org_id);

-- Authorization-denial audit trail (plan step 8: explicit denial handling and
-- security logging). Never references other tables, so it can record denials
-- for resources that do not exist (guessed ids must not leak existence).
CREATE TABLE IF NOT EXISTS tenant_denials (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID,
  org_id UUID,
  action TEXT NOT NULL,
  resource_type TEXT,
  resource_id TEXT,
  reason TEXT NOT NULL,
  ip TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
