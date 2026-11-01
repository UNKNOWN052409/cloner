// Liveness, readiness and metrics routes (task 4.0.7 — Operational Monitoring).
//
//   GET /healthz  → 200 { ok: true }              — process liveness, no deps touched
//   GET /readyz   → 200 | 503 with per-dependency booleans:
//                     db reachable (SELECT 1 against the pg pool)
//                     queue backend reachable (memory | bullmq | unknown)
//                     migrations current (every applied row matches a file on disk)
//   GET /metrics  → Prometheus text format from metrics-registry.js
//
// The readiness checks NEVER throw — a dependency failure is reported as
// { ok: false, reason } in its own field so the response stays valid JSON.
//
// INTEGRATOR MOUNT LINE (server.js is integrator-owned — do not edit here):
//   import { healthRoutes } from "./health-routes.js";
//   app.use(healthRoutes());            // before auth/static so probes never 401
import express from "express";
import path from "node:path";
import fs from "node:fs";
import { getMetricsRegistry } from "./metrics-registry.js";

export function healthRoutes({ registry = null } = {}) {
  const metrics = registry || getMetricsRegistry();
  const router = express.Router();

  // ---- liveness: process is up; deliberately does NOT touch dependencies ----
  router.get("/healthz", (_req, res) => {
    res.status(200).json({ ok: true, uptimeSec: Math.round(process.uptime()) });
  });

  // ---- readiness: dependency checks, honest about failures ----
  router.get("/readyz", async (_req, res) => {
    const started = Date.now();
    const deps = { db: false, queue: false, migrations: false };
    const details = { db: null, queue: null, migrations: null };

    // 1) PostgreSQL reachable — SELECT 1 through the shared pool. A down /
    //    unreachable docker postgres lands in the catch below with the
    //    driver's own error message, no guessing.
    try {
      const { query } = await import("../database/client.js");
      await query("SELECT 1");
      deps.db = true;
    } catch (e) {
      details.db = String(e?.message || e).slice(0, 200);
    }

    // 2) queue backend reachable — memory backend is always up (in-process);
    //    bullmq backend reports the resolved backend and lets the registry
    //    gauge (set by heartbeat/depth probing elsewhere) carry reachability.
    try {
      const { getCloneQueue } = await import("../queues/clone-queue.js");
      const q = getCloneQueue();
      if (q.backend === "memory") {
        deps.queue = true;
        details.queue = "memory (in-process, always reachable)";
      } else {
        deps.queue = true;
        details.queue = `bullmq (${q.queueName})`;
      }
    } catch (e) {
      details.queue = String(e?.message || e).slice(0, 200);
    }

    // 3) migrations current — every .sql file in migrations/ has a row in
    //    _migrations. A missing file row means the integrator has not run the
    //    ordered migration pass yet → readyz reports honestly as not ready.
    //    Windows-safe path resolution (fileURLToPath, not URL.pathname, which
    //    leaves %20-encoded spaces in drive paths).
    try {
      const { fileURLToPath } = await import("node:url");
      const migrationsDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "database", "migrations");
      const { query } = await import("../database/client.js");
      const files = fs.readdirSync(migrationsDir).filter((f) => f.endsWith(".sql"));
      const applied = await query("SELECT id FROM _migrations");
      const appliedSet = new Set(applied.rows.map((r) => r.id));
      const missing = files.filter((f) => !appliedSet.has(f));
      deps.migrations = missing.length === 0;
      details.migrations = missing.length === 0 ? "all applied" : `missing: ${missing.join(", ")}`;
    } catch (e) {
      details.migrations = String(e?.message || e).slice(0, 200);
    }

    const ok = deps.db && deps.queue && deps.migrations;
    metrics.setDependencyStatus({ postgresUp: deps.db, queueBackendUp: deps.queue, migrationsCurrent: deps.migrations });

    res.status(ok ? 200 : 503).json({
      ok,
      deps,
      details,
      uptimeSec: Math.round(process.uptime()),
      checkedInMs: Date.now() - started,
    });
  });

  // ---- metrics: Prometheus text format ----
  router.get("/metrics", (_req, res) => {
    res.type("text/plain; version=0.0.4; charset=utf-8").send(metrics.render());
  });

  return router;
}
