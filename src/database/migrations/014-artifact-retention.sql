-- Migration 014 (task 4.0.5 — artifact retention & lifecycle management).
-- ADDITIVE ONLY on the Phase-3 artifacts table (migration 001-initial.sql:44):
-- existing rows and columns are untouched; every new column is nullable or has
-- a safe default so a forward-only run over an existing database is a no-op
-- risk-wise.
--
-- NOTE: org_id deliberately carries NO foreign key to an organizations table —
-- that table belongs to task 4.0.2's own migration and may not exist yet when
-- 014 runs in the ordered migration run (parallel phase). Adding the FK is a
-- forward-only follow-up once 4.0.2's migration is guaranteed applied.

-- Tenant scope of the artifact row: NULL = legacy (pre-lifecycle, no org).
ALTER TABLE artifacts ADD COLUMN IF NOT EXISTS org_id UUID;

-- Org-scoped relative path under the artifact root, e.g. "<orgId>/<jobId>/pages/x.png".
-- Legacy rows keep the plain "<jobId>/..." storage_key shape.
ALTER TABLE artifacts ADD COLUMN IF NOT EXISTS path TEXT;

-- Lifecycle state machine (staged deletion — never a single delete jump):
--   active → expired → purged
--   'pinned' artifacts are exempted from expiry by retention sweeps.
ALTER TABLE artifacts ADD COLUMN IF NOT EXISTS lifecycle_state TEXT NOT NULL DEFAULT 'active';

-- Retention class driving the tier (temp | failed | completed | deleted),
-- mirroring src/storage/artifact-lifecycle.js RETENTION_TIERS.
ALTER TABLE artifacts ADD COLUMN IF NOT EXISTS retention_class TEXT;

-- Expiry computed at write time from the retention tier (env RETENTION_DAYS).
ALTER TABLE artifacts ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ;

-- Tombstone timestamp for the purged stage (deleted_at IS NULL = retained).
ALTER TABLE artifacts ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;

ALTER TABLE artifacts ADD COLUMN IF NOT EXISTS pinned BOOLEAN NOT NULL DEFAULT false;

-- Sweeps: find expired rows fast; usage accounting groups per org (4.0.4).
CREATE INDEX IF NOT EXISTS idx_artifacts_lifecycle_expires ON artifacts (lifecycle_state, expires_at);
CREATE INDEX IF NOT EXISTS idx_artifacts_org_id ON artifacts (org_id);
