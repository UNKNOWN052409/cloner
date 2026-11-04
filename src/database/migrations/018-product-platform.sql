-- Phase 4.1 product platform: onboarding state, project versions, plans,
-- entitlements, notification (activity-center) events.
--
-- Forward-only, idempotent (IF NOT EXISTS everywhere). One file per phase 4.1
-- wave; the integrator's ordered runner applies it after 017.
--
-- NOTES
--   • credit_ledger_entries already exists (created idempotently by
--     src/platform/credit-ledger.js — the 4.5.2 free-grant ledger). This
--     migration does NOT recreate it; the ledger keeps its in-module DDL.
--   • users/tasks/organizations/org_members come from 001/010.

-- ── 4.1.1 onboarding ────────────────────────────────────────────────────────
-- First-use activation state per user. activation_status:
--   'pending'   → registered, onboarding not started
--   'in_progress' → at least one step saved
--   'complete'  → activated (all required steps done or explicitly skipped)
CREATE TABLE IF NOT EXISTS onboarding_profiles (
  user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  activation_status TEXT NOT NULL DEFAULT 'pending'
    CHECK (activation_status IN ('pending', 'in_progress', 'complete')),
  profile JSONB NOT NULL DEFAULT '{}'::jsonb,
  steps_done JSONB NOT NULL DEFAULT '[]'::jsonb,     -- ["profile", "workspace", ...]
  steps_skipped JSONB NOT NULL DEFAULT '[]'::jsonb,
  workspace_defaults JSONB NOT NULL DEFAULT '{}'::jsonb,
  activated_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_onboarding_status ON onboarding_profiles(activation_status);

-- ── 4.1.3 project versions ──────────────────────────────────────────────────
-- Immutable version records per exported project. A version snapshots the
-- export tree (files + sha256 + size) so rollback can materialize the exact
-- byte-identical tree. Rows are never mutated: new content → new version row.
CREATE TABLE IF NOT EXISTS project_versions (
  id BIGSERIAL PRIMARY KEY,
  task_id TEXT NOT NULL,               -- the platform task id (v1 "t…"/v2 job id)
  user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  org_id UUID REFERENCES organizations(id) ON DELETE SET NULL,
  version INTEGER NOT NULL,            -- 1..n per task, monotonic (append-only)
  note TEXT,                           -- caller-supplied label (e.g. "pre-css-fix")
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  manifest JSONB NOT NULL,             -- { files: [{ path, sha256, size }], fileCount, totalBytes }
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (task_id, version)
);
CREATE INDEX IF NOT EXISTS idx_project_versions_task
  ON project_versions(task_id, version DESC);

-- ── 4.1.4 plans + entitlements ──────────────────────────────────────────────
-- Plan catalog rows (free/pro/team). Entitlements are a JSONB map of feature
-- name → limit/value; resolution is per user+org with org-plan-wins semantics
-- enforced in plan-service.js (resolveEntitlements).
CREATE TABLE IF NOT EXISTS plans (
  id TEXT PRIMARY KEY,                 -- 'free' | 'pro' | 'team'
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  entitlements JSONB NOT NULL DEFAULT '{}'::jsonb,
  is_default BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS user_plans (
  user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  plan_id TEXT NOT NULL REFERENCES plans(id),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS org_plans (
  org_id UUID PRIMARY KEY REFERENCES organizations(id) ON DELETE CASCADE,
  plan_id TEXT NOT NULL REFERENCES plans(id),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ── 4.1.12 activity center (product notifications) ─────────────────────────
-- Per-user activity events (task completed/failed, publish done, quota
-- warnings…). Read/unread per user; the list endpoint filters + counts.
-- Channel fan-out (email/webhook) stays in notification-delivery.js (4.2.16);
-- this table is the in-app activity surface.
CREATE TABLE IF NOT EXISTS activity_events (
  id BIGSERIAL PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  org_id UUID REFERENCES organizations(id) ON DELETE SET NULL,
  event TEXT NOT NULL,                 -- 'task.completed' | 'task.failed' | ...
  title TEXT NOT NULL,
  detail JSONB NOT NULL DEFAULT '{}'::jsonb,
  correlation_id TEXT,                 -- task id / publish id that caused it
  read_at TIMESTAMPTZ,                 -- NULL = unread
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_activity_user ON activity_events(user_id, id DESC);
CREATE INDEX IF NOT EXISTS idx_activity_unread ON activity_events(user_id) WHERE read_at IS NULL;
