-- Migration 030 (task 4.2.12 — per-job compute accounting & cost model).
-- FORWARD-ONLY, ADDITIVE ONLY: every statement creates fresh objects with
-- IF NOT EXISTS / indexes guarded by IF NOT EXISTS, so applying it over a
-- database that already has 001/010-016 (and anything the other 4.2 lanes
-- added) is a no-op risk-wise. Depends only on users (migration 001).
--
-- Model:
--   compute_cost_rates  configurable cost rates per scope (scope override >
--                       platform-wide 'global' row > env default from
--                       src/platform/compute-accounting.js DEFAULT_RATES).
--                       Rates are decimals per unit: runtime_minute (credits
--                       per started runtime minute), browser_slot (credits
--                       per browser session/slot consumed by a job),
--                       artifact_byte (credits per stored artifact byte).
--   compute_job_costs   one settled cost record per (scope, job) — the
--                       per-job accounting source of truth. UNIQUE
--                       (scope_type, scope_id, task_key) makes settlement
--                       idempotent: re-settling a live job never double
--                       charges. rates_snapshot freezes the rates actually
--                       used (audit/replay even after a rate change);
--                       ledger_status tracks credit-ledger settlement
--                       independently of cost computation so a ledger outage
--                       never loses accounting (retried via
--                       postUnsettledCosts()).

CREATE TABLE IF NOT EXISTS compute_cost_rates (
  scope_type TEXT NOT NULL CHECK (scope_type IN ('user', 'org', 'global')),
  -- '00000000-0000-0000-0000-000000000000' identifies the platform-wide
  -- 'global' row (PostgreSQL primary keys cannot hold NULL).
  scope_id   UUID NOT NULL DEFAULT '00000000-0000-0000-0000-000000000000',
  rate_key   TEXT NOT NULL CHECK (rate_key IN (
    'runtime_minute',    -- credits per started runtime minute (ceil of ms/60000)
    'browser_slot',      -- credits per browser slot consumed by the job
    'artifact_byte'      -- credits per stored artifact byte
  )),
  -- 30 digits total, 18 after the point: byte-level rates are tiny
  -- (e.g. 0.00000001) while minute-level rates stay exact.
  rate_value NUMERIC(30, 18) NOT NULL CHECK (rate_value >= 0),
  -- Ledger unit for this rate. resolveRates() requires all three rates of a
  -- scope to share one currency (mismatch = configuration error, clean throw).
  currency   TEXT NOT NULL DEFAULT 'credits',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (scope_type, scope_id, rate_key)
);

-- Per-job cost settlement record. Costs are stored as NUMERIC(30,6): the
-- service rounds every component to 6 decimals (documented round6 rule), so
-- storage is exact — never a float artefact like 0.030000000000000002.
CREATE TABLE IF NOT EXISTS compute_job_costs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  task_key  TEXT NOT NULL, -- job handle (jobId / tempId), TEXT not FK (BullMQ ids)
  scope_type TEXT NOT NULL CHECK (scope_type IN ('user', 'org')),
  scope_id   UUID NOT NULL,
  user_id    UUID REFERENCES users(id) ON DELETE SET NULL,
  -- Raw measured quantities (what a human can verify against the job run)
  runtime_ms     BIGINT NOT NULL CHECK (runtime_ms >= 0),
  runtime_minutes INT   NOT NULL CHECK (runtime_minutes >= 0),
  browser_slots  INT    NOT NULL DEFAULT 0 CHECK (browser_slots >= 0),
  artifact_bytes BIGINT NOT NULL DEFAULT 0 CHECK (artifact_bytes >= 0),
  -- Computed cost components + total (credits, 6-decimal exact)
  cost_runtime NUMERIC(30, 6) NOT NULL DEFAULT 0,
  cost_slots   NUMERIC(30, 6) NOT NULL DEFAULT 0,
  cost_bytes   NUMERIC(30, 6) NOT NULL DEFAULT 0,
  cost_total   NUMERIC(30, 6) NOT NULL DEFAULT 0,
  currency     TEXT NOT NULL DEFAULT 'credits',
  -- Exact rates + source ('scope'|'global'|'env') used for this settlement
  rates_snapshot JSONB NOT NULL DEFAULT '{}',
  -- Credit-ledger settlement state, independent of cost computation:
  --   unposted = computed, no ledger injected (or not yet swept)
  --   posted   = debit accepted by the injected credit ledger
  --   rejected = ledger refused (insufficient credits) — retryable after top-up
  --   failed   = ledger threw a non-insufficiency error — retryable by sweep
  ledger_status TEXT NOT NULL DEFAULT 'unposted'
    CHECK (ledger_status IN ('unposted', 'posted', 'rejected', 'failed')),
  ledger_ref   TEXT,
  ledger_error TEXT,
  meta         JSONB NOT NULL DEFAULT '{}',
  settled_at   TIMESTAMPTZ,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Settlement idempotency: at most one cost record per live (scope, job).
CREATE UNIQUE INDEX IF NOT EXISTS uq_compute_job_costs_scope_task
  ON compute_job_costs (scope_type, scope_id, task_key);
-- Scope summaries / date-range reads
CREATE INDEX IF NOT EXISTS idx_compute_job_costs_scope_time
  ON compute_job_costs (scope_type, scope_id, created_at);
-- postUnsettledCosts() sweep: find rows that still owe a debit
CREATE INDEX IF NOT EXISTS idx_compute_job_costs_unsettled
  ON compute_job_costs (ledger_status) WHERE ledger_status <> 'posted';
