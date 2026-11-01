#!/usr/bin/env node
// Database restore (Phase 4.0.11): replays a backup-database.mjs archive into
// the configured PostgreSQL database, with a destructive-restore pre-check and
// post-restore job-state reconciliation.
//
// Pre-check: the target must be EMPTY (no application tables) unless --force
// is given. The dump is written with --clean --if-exists, so --force restores
// drop and recreate the application tables; other databases on the cluster are
// never touched.
//
// Job reconciliation: queued/running/verifying rows cannot survive a restore
// (their worker processes no longer exist) and are flipped to `error` with a
// `failed-recoverable` marker in task_events so they can be retried by the
// operator instead of blocking the pipeline forever.
//
// Usage:
//   node scripts/restore-database.mjs backups/database/<file>.sql
//   node scripts/restore-database.mjs backups/database/<file>.sql --force
// Exit codes: 0 = restored, 1 = refused/failed.
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const PROJECT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const HOST = process.env.PGHOST || "127.0.0.1";
const PORT = process.env.PGPORT || "5433";
const USER = process.env.PGUSER || "cloner";
const PASSWORD = process.env.PGPASSWORD || "cloner_dev_password"; // eslint-disable-line no-secrets
const DATABASE = process.env.PGDATABASE || "cloner";
const CONTAINER = process.env.PG_CONTAINER || "cloner-postgres-1";

const args = process.argv.slice(2).filter((a) => a !== "--force");
const FORCE = process.argv.includes("--force");
const FILE = path.resolve(args[0] || "");
const APP_TABLES = ["users", "tasks", "task_stages", "artifacts", "task_events", "sessions"];

function fail(msg) {
  console.error(`ERROR  restore-database: ${msg}`);
  process.exit(1);
}

// ---- 1. validate the archive before touching the database ----
if (!FILE) fail("usage: restore-database.mjs <backup.sql> [--force]");
if (!fs.existsSync(FILE) || !fs.statSync(FILE).isFile()) fail(`no such file: ${FILE}`);
const sql = fs.readFileSync(FILE, "utf8");
if (!sql.includes("PostgreSQL database dump")) fail(`${path.basename(FILE)} is not a pg_dump SQL archive`);
const sha = crypto.createHash("sha256").update(sql).digest("hex");

// ---- 2. connect and run the destructive pre-check ----
async function pool() {
  const p = new pg.Pool({ host: HOST, port: Number(PORT), database: DATABASE, user: USER, password: PASSWORD, max: 2 });
  try { await p.query("SELECT 1"); return p; } catch (e) { fail(`cannot reach ${HOST}:${PORT}/${DATABASE}: ${e.message}`); }
}

const p = await pool();
const { rows: existing } = await p.query(
  `SELECT table_name FROM information_schema.tables WHERE table_schema='public'`
);
const appTables = existing.map((r) => r.table_name).filter((t) => APP_TABLES.includes(t));
const nonApp = existing.map((r) => r.table_name).filter((t) => !APP_TABLES.includes(t) && !t.startsWith("pg_") && !t.startsWith("_"));

if (appTables.length && !FORCE) {
  console.error(`REFUSED  restore-database: target ${DATABASE} is NOT empty (has: ${appTables.join(", ")})`);
  console.error(`REFUSED  pass --force to drop and recreate the application tables, or restore into an empty database.`);
  await p.end();
  process.exit(1);
}
console.log(
  `OK  restore-database: pre-check ${FORCE ? "--force" : "empty-target"} (${appTables.length} app tables present${
    nonApp.length ? `, untouched non-app: ${nonApp.join(", ")}` : ""
  })`
);

// ---- 3. apply the dump (host psql when available, else docker exec) ----
function apply() {
  let r = spawnSync("psql", ["-h", HOST, "-p", PORT, "-U", USER, "-d", DATABASE, "-v", "ON_ERROR_STOP=1", "-f", FILE], {
    encoding: "utf8",
    env: { ...process.env, PGPASSWORD: PASSWORD },
    maxBuffer: 64 * 1024 * 1024,
  });
  if (!r.error && r.status === 0) return "host-psql";
  if (r.error && r.error.code !== "ENOENT") fail(`host psql failed: ${r.error.message}`);
  // container mode: pipe the SQL through stdin of psql inside the postgres box
  r = spawnSync("docker", ["exec", "-i", CONTAINER, "psql", "-U", USER, "-d", DATABASE, "-v", "ON_ERROR_STOP=1"], {
    encoding: "utf8",
    input: sql,
    maxBuffer: 64 * 1024 * 1024,
  });
  if (r.error) fail(`docker exec failed (is the compose postgres running?): ${r.error.message}`);
  if (r.status !== 0) fail(`container psql exited ${r.status}: ${String(r.stderr).trim().slice(0, 600)}`);
  return `docker-exec:${CONTAINER}`;
}
const mode = apply();
console.log(`OK  restore-database: applied ${path.relative(PROJECT, FILE)} (sha256 ${sha.slice(0, 16)}…, via ${mode})`);

// ---- 4. post-restore job-state reconciliation ----
// queued/running/verifying tasks cannot resume: their workers are gone. They
// become `error` with a recoverable marker recorded in task_events.
// Schema-tolerant: reconciliation applies only when the restored database
// actually has a tasks table with a status column (an older/minimal schema
// without it is restored as-is; there is simply nothing to reconcile).
const IN_FLIGHT = ["queued", "running", "verifying"];
const { rows: tasksTable } = await p.query(
  `SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='tasks' AND column_name='status'`
);
let reconciled = 0;
let leftoverCount = 0;
if (tasksTable.length) {
  const hasErrorCol = (await p.query(
    `SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='tasks' AND column_name='error'`
  )).rows.length > 0;
  const hasEvents = (await p.query(
    `SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='task_events'`
  )).rows.length > 0;
  const errorSet = hasErrorCol ? `, error=$2` : ``;
  const { rows: found } = await p.query(
    `SELECT id, status FROM tasks WHERE status = ANY($1::text[])`, [IN_FLIGHT]
  );
  for (const t of found) {
    const reason = "failed-recoverable: restored from backup while task was " + t.status;
    await p.query(
      `UPDATE tasks SET status='error'${errorSet}${hasErrorCol ? ", updated_at=now()" : ""} WHERE id=$1`,
      hasErrorCol ? [t.id, reason] : [t.id]
    );
    if (hasEvents) {
      await p.query(
        `INSERT INTO task_events (task_id, event_type, payload) VALUES ($1, 'reconciled', $2)`,
        [t.id, JSON.stringify({ from: t.status, to: "error", reason })]
      );
    }
    reconciled++;
  }
  leftoverCount = (await p.query(
    `SELECT count(*)::int AS n FROM tasks WHERE status = ANY($1::text[])`, [IN_FLIGHT]
  )).rows[0].n;
}
await p.end();

console.log(
  `OK  restore-database: reconciled ${reconciled} in-flight task(s) → error/failed-recoverable; ${leftoverCount} remain in-flight`
);
if (leftoverCount > 0) fail(`reconciliation left ${leftoverCount} task(s) in-flight`);
console.log(`OK  restore-database: done — ${DATABASE} restored and reconciled`);
