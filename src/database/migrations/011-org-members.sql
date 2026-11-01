-- Migration 011: organization membership + invitations (phase 4.0.2)
-- Forward-only. Depends on the users table (migration 001).
--
-- COEXISTENCE NOTE: migration 010 (task 4.0.1) may already have created
-- `organizations` (shape: name/slug/owner_user_id/status) and `org_members`
-- (roles owner/admin/member only). Every statement below is therefore
-- idempotent (IF NOT EXISTS / guarded DO block) and widens an existing table
-- additively — no existing column or row is rewritten:
--   • adds description / created_by / owner_user_id / status where missing
--   • backfills created_by <-> owner_user_id from whichever side has data
--   • widens org_members.role to owner/admin/member/viewer
-- A database where only 001 ran gets exactly the shape declared here; a
-- database that already ran 010 gets the additive columns and the wider role set.

CREATE TABLE IF NOT EXISTS organizations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 200),
  slug TEXT UNIQUE NOT NULL,
  description TEXT,
  created_by UUID REFERENCES users(id),
  owner_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'active',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS org_members (
  org_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('owner', 'admin', 'member', 'viewer')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, user_id)
);

CREATE TABLE IF NOT EXISTS org_invitations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  email TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('admin', 'member', 'viewer')),
  token_hash TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'accepted', 'revoked')),
  expires_at TIMESTAMPTZ NOT NULL,
  created_by UUID NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  accepted_by UUID REFERENCES users(id),
  accepted_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ
);

-- only one pending invitation per (org, email); accepted/revoked rows do not block re-invites
CREATE UNIQUE INDEX IF NOT EXISTS uq_org_invitations_pending
  ON org_invitations (org_id, email) WHERE status = 'pending';

-- ---- additive widening for databases where 010 created these tables first ----

ALTER TABLE organizations ADD COLUMN IF NOT EXISTS description TEXT;
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS created_by UUID REFERENCES users(id);
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS owner_user_id UUID REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'active';

-- fill whichever creator column is missing from the other
UPDATE organizations SET created_by = owner_user_id WHERE created_by IS NULL AND owner_user_id IS NOT NULL;
UPDATE organizations SET owner_user_id = created_by WHERE owner_user_id IS NULL AND created_by IS NOT NULL;

ALTER TABLE org_members ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT now();

-- widen the role CHECK to include 'viewer' when an older (3-role) constraint exists
DO $$
DECLARE
  def TEXT;
BEGIN
  SELECT pg_get_constraintdef(oid) INTO def
    FROM pg_constraint
   WHERE conrelid = 'org_members'::regclass AND conname = 'org_members_role_check';
  IF def IS NOT NULL AND def NOT LIKE '%viewer%' THEN
    ALTER TABLE org_members DROP CONSTRAINT org_members_role_check;
    def := NULL;
  END IF;
  IF def IS NULL THEN
    ALTER TABLE org_members ADD CONSTRAINT org_members_role_check
      CHECK (role IN ('owner', 'admin', 'member', 'viewer'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_org_members_user_id ON org_members(user_id);
CREATE INDEX IF NOT EXISTS idx_org_invitations_org ON org_invitations(org_id);
CREATE INDEX IF NOT EXISTS idx_organizations_owner ON organizations(owner_user_id);
