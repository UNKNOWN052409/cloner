-- Migration 016 — consolidate the runtime DDL from task 4.0.8 into migration
-- history (integrator duty 2: full ordered migration run). Forward-only,
-- idempotent (IF NOT EXISTS), additive: admin_quotas stores per-user quota
-- overrides as JSONB (unchanged shape — admin-service.js reads/writes it at
-- runtime and its own CREATE TABLE IF NOT EXISTS stays as a fallback for
-- databases where only the code (not this file) has been applied).
CREATE TABLE IF NOT EXISTS admin_quotas (
  user_id    UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  quota      JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_by UUID,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
