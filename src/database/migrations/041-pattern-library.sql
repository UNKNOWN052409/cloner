-- Migration 041 (task G3.1 — 5.0 reconstruction intelligence): persistent
-- cross-clone pattern library.
--
-- recon_patterns: one learned component pattern per structure+style signature
-- (sha256 over canonical structure/style features — see
-- src/reconstruction/intelligence/pattern-library.js componentSignature()).
-- A pattern stores the learned component kind, the source confidence it was
-- learned at, its feature object, evidence + provenance records (capped
-- client-side), observation/hit counters for hit-rate telemetry, and the
-- library entry it was learned from. No page text, no URLs with query values,
-- no credentials — provenance refs cite artifact-relative paths only.
--
-- recon_pattern_telemetry: singleton row (id = 1) with library-wide
-- lookup/hit/boost counters so hit-rate telemetry survives process restarts.
-- Updates are UPSERTs (row created on first write); reads tolerate absence.
--
-- Forward-only, idempotent (IF NOT EXISTS everywhere), additive — no existing
-- table is touched.

CREATE TABLE IF NOT EXISTS recon_patterns (
  signature   TEXT PRIMARY KEY,
  kind        TEXT NOT NULL,
  confidence  REAL NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
  features    JSONB NOT NULL,
  evidence    JSONB NOT NULL DEFAULT '[]'::jsonb,
  provenance  JSONB NOT NULL DEFAULT '[]'::jsonb,
  observations INTEGER NOT NULL DEFAULT 1,
  hits        INTEGER NOT NULL DEFAULT 0,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS recon_patterns_kind_idx ON recon_patterns(kind);
CREATE INDEX IF NOT EXISTS recon_patterns_observations_idx ON recon_patterns(observations DESC);

CREATE TABLE IF NOT EXISTS recon_pattern_telemetry (
  id       INTEGER PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  lookups  BIGINT NOT NULL DEFAULT 0,
  hits     BIGINT NOT NULL DEFAULT 0,
  boosts   BIGINT NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
