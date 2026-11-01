-- Migration 012 (task 4.0.4 — per-user/org resource quotas & usage accounting).
-- FORWARD-ONLY, ADDITIVE ONLY: every statement is IF NOT EXISTS / creates fresh
-- tables, so running it over a database that already has migrations
-- 001/010/011/013/014/015 applied is a no-op risk-wise. Depends only on
-- organizations + org_members (migrations 010/011) and users (001).
--
-- Model:
--   quota_limits      per-scope limit overrides (NULL value = unlimited)
--   quota_reservations atomic concurrent/queued execution slots; released_at
--                     IS NULL = held. Stale reservations (worker crash) are
--                     reclaimed by quota-service.reclaimStaleReservations().
--   quota_usage_daily materialized per-day counters (fast quota checks)
--   quota_usage_events append-only ledger (source of truth; reconciliation)
--
-- Scope: scope_type 'user' (personal workspace) or 'org' (organization pool
-- shared across members — src/platform/quota-service.js resolveScope).

CREATE TABLE IF NOT EXISTS quota_limits (
  scope_type TEXT NOT NULL CHECK (scope_type IN ('user', 'org')),
  scope_id   UUID NOT NULL,
  limit_key  TEXT NOT NULL CHECK (limit_key IN (
    'max_concurrent_jobs',
    'max_queued_jobs',
    'max_jobs_per_day',
    'max_artifact_bytes',
    'max_exploration_minutes_per_day'
  )),
  -- NULL = explicitly unlimited (overrides the env default); otherwise the
  -- numeric limit. Env defaults live in src/platform/quota-service.js — no
  -- commercial subscription tiers are hard-coded here (plan step 9).
  limit_value BIGINT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (scope_type, scope_id, limit_key)
);

-- One held slot per row. task_key is the job handle (jobId / tempId / request
-- ref) — TEXT, not a FK, because BullMQ job ids and in-process temp handles
-- both appear here. A UNIQUE partial index makes reservation idempotent per
-- live task: re-reserving the same live task returns the existing slot.
CREATE TABLE IF NOT EXISTS quota_reservations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  scope_type TEXT NOT NULL CHECK (scope_type IN ('user', 'org')),
  scope_id   UUID NOT NULL,
  task_key   TEXT NOT NULL,
  -- 'queued' = parked pre-execution (queued-jobs limit), 'running' = holds one
  -- concurrent-execution slot (concurrent-jobs limit). promoteReservation()
  -- moves queued → running under the same advisory lock as reserveJobSlot.
  state      TEXT NOT NULL DEFAULT 'running' CHECK (state IN ('queued', 'running')),
  created_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  reserved_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  released_at TIMESTAMPTZ,
  released_reason TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- only one LIVE reservation per (scope, task)
CREATE UNIQUE INDEX IF NOT EXISTS uq_quota_reservations_live
  ON quota_reservations (scope_type, scope_id, task_key) WHERE released_at IS NULL;
-- active-capacity lookups (per-scope count under the advisory lock)
CREATE INDEX IF NOT EXISTS idx_quota_reservations_scope_live
  ON quota_reservations (scope_type, scope_id, state) WHERE released_at IS NULL;
-- stale-reclaim sweep
CREATE INDEX IF NOT EXISTS idx_quota_reservations_stale
  ON quota_reservations (reserved_at) WHERE released_at IS NULL;

-- Materialized daily counters (UTC day). Incremented atomically via
-- INSERT … ON CONFLICT DO UPDATE; recomputed from the ledger by
-- reconcileDailyFromLedger() after interrupted runs.
CREATE TABLE IF NOT EXISTS quota_usage_daily (
  scope_type TEXT NOT NULL CHECK (scope_type IN ('user', 'org')),
  scope_id   UUID NOT NULL,
  day        DATE NOT NULL,
  jobs_started   INT NOT NULL DEFAULT 0,
  jobs_completed INT NOT NULL DEFAULT 0,
  jobs_failed    INT NOT NULL DEFAULT 0,
  jobs_cancelled INT NOT NULL DEFAULT 0,
  retries        INT NOT NULL DEFAULT 0,
  exploration_ms BIGINT NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (scope_type, scope_id, day)
);

-- Append-only usage ledger: per-event accounting for started/retry/completed/
-- failed/cancelled jobs and exploration time — "track usage against actual job
-- execution" (plan step 4) with retries, failures, cancellations and
-- interruptions accounted distinctly (plan step 5).
CREATE TABLE IF NOT EXISTS quota_usage_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  scope_type TEXT NOT NULL CHECK (scope_type IN ('user', 'org')),
  scope_id   UUID NOT NULL,
  user_id    UUID REFERENCES users(id) ON DELETE SET NULL,
  task_key   TEXT,
  event_type TEXT NOT NULL CHECK (event_type IN (
    'started', 'retry', 'completed', 'failed', 'cancelled', 'exploration_ms'
  )),
  amount     BIGINT NOT NULL DEFAULT 1, -- exploration_ms events carry ms here
  payload    JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_quota_usage_events_scope_day
  ON quota_usage_events (scope_type, scope_id, created_at);
CREATE INDEX IF NOT EXISTS idx_quota_usage_daily_day ON quota_usage_daily (day);
