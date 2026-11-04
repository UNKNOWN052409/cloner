-- Task 4.2.8: distributed job leases (src/distributed/job-leases.js).
-- Exactly one worker owns a job at a time: the row IS the lease. Workers
-- claim it with an atomic INSERT ... ON CONFLICT (job_id) DO UPDATE ...
-- WHERE expires_at <= now() — the loser's UPDATE is skipped (rowCount 0) so
-- duplicate execution across regions is impossible, independent of client
-- clocks (PostgreSQL now() is the single authority).
--
--   epoch        fencing token: increments on EVERY takeover (steal), so a
--                worker that lost its lease cannot impersonate the new owner
--                when writing progress/artifacts (lease.validateOwnership).
--   expires_at   TTL. Not renewed in time → any worker may steal.
--   region       where the owning worker runs (cross-region observability).
--
-- Rows are intentionally keyed by job_id only (leases are cluster-wide, not
-- per-tenant — the job id is already tenant-qualified upstream). A missing row
-- means the job is unleased. Forward-only migration, idempotent.

CREATE TABLE IF NOT EXISTS job_leases (
  job_id      TEXT PRIMARY KEY,
  owner       TEXT NOT NULL,
  region      TEXT NOT NULL DEFAULT 'default',
  epoch       BIGINT NOT NULL DEFAULT 1,
  acquired_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  renewed_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at  TIMESTAMPTZ NOT NULL
);

-- Steal/reaper scans look for expired leases; without the index that is a
-- full scan of every in-flight lease.
CREATE INDEX IF NOT EXISTS idx_job_leases_expires_at ON job_leases(expires_at);
