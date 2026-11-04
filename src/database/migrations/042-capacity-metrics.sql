-- Migration 042 — capacity analytics time-series (task 4.2.11).
--
-- Two additive time-series tables backing the capacity dashboards API
-- (src/observability/capacity-analytics.js + src/platform/routes-capacity.js):
--
--   capacity_samples   one sampling point of a REGION's execution capacity:
--                      worker slots, busy slots (→ utilization), queue depth,
--                      active jobs and the completed/failed job deltas observed
--                      since the previous sample.
--   capacity_job_costs one row per billable job: the region it ran in, its
--                      outcome status and the cost (any currency unit the
--                      operator feeds in; column named cost_usd for
--                      convention, values are unit-agnostic numeric).
--
-- Forward-only, idempotent (IF NOT EXISTS). Region values are operator/worker
-- supplied and sanitized to the same bounded label alphabet the metrics
-- registry uses ([A-Za-z0-9_.-]{0,64}); a text column (not an enum) keeps
-- adding a region a data change, not a schema change.
CREATE TABLE IF NOT EXISTS capacity_samples (
  id                  BIGSERIAL PRIMARY KEY,
  region              TEXT        NOT NULL,
  ts                  TIMESTAMPTZ NOT NULL DEFAULT now(),
  worker_slots        INT         NOT NULL DEFAULT 0 CHECK (worker_slots >= 0),
  busy_slots          INT         NOT NULL DEFAULT 0 CHECK (busy_slots >= 0),
  queue_depth         INT         NOT NULL DEFAULT 0 CHECK (queue_depth >= 0),
  active_jobs         INT         NOT NULL DEFAULT 0 CHECK (active_jobs >= 0),
  jobs_completed_delta INT        NOT NULL DEFAULT 0 CHECK (jobs_completed_delta >= 0),
  jobs_failed_delta    INT        NOT NULL DEFAULT 0 CHECK (jobs_failed_delta >= 0)
);

CREATE INDEX IF NOT EXISTS idx_capacity_samples_ts
  ON capacity_samples (ts);
CREATE INDEX IF NOT EXISTS idx_capacity_samples_region_ts
  ON capacity_samples (region, ts DESC);

CREATE TABLE IF NOT EXISTS capacity_job_costs (
  id       BIGSERIAL PRIMARY KEY,
  region   TEXT         NOT NULL,
  job_id   TEXT,
  status   TEXT         NOT NULL DEFAULT 'completed',
  cost_usd NUMERIC(12,6) NOT NULL DEFAULT 0 CHECK (cost_usd >= 0),
  ts       TIMESTAMPTZ  NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_capacity_costs_ts
  ON capacity_job_costs (ts);
CREATE INDEX IF NOT EXISTS idx_capacity_costs_region_ts
  ON capacity_job_costs (region, ts DESC);
