// PostgreSQL client + migration runner (spec §5)
import pg from "pg";
import path from "node:path";

let pool = null;

export function getPool() {
  if (!pool) {
    pool = new pg.Pool({
      host: process.env.PGHOST || "127.0.0.1",
      port: Number(process.env.PGPORT || 5433),
      database: process.env.PGDATABASE || "cloner",
      user: process.env.PGUSER || "cloner",
      password: process.env.PGPASSWORD || "cloner_dev_password",
      max: 10,
      idleTimeoutMillis: 30000,
    });
  }
  return pool;
}

export async function closePool() {
  if (pool) { await pool.end(); pool = null; }
}

// Session-level advisory lock serializing schema upgrades across every
// concurrent boot/worker in the cluster (G5.2 hunt: two boots racing the same
// unapplied file both passed the _migrations SELECT and one died with a
// duplicate-key error on the bookkeeping insert — the boot then logged
// "migration failed" with the schema half-marked). The key is arbitrary but
// fixed; only migration runs take it.
const MIGRATE_ADVISORY_KEY = 902101;

export async function migrate() {
  const p = getPool();
  const { fileURLToPath } = await import("node:url");
  const migrationsDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "migrations");
  const fs = await import("node:fs");
  await p.query(`CREATE TABLE IF NOT EXISTS _migrations (id TEXT PRIMARY KEY, applied_at TIMESTAMPTZ DEFAULT now())`);
  const files = fs.readdirSync(migrationsDir).filter((f) => f.endsWith(".sql")).sort();
  const client = await p.connect();
  try {
    // serialize; the loser re-checks _migrations under the lock and skips
    await client.query("SELECT pg_advisory_lock($1)", [MIGRATE_ADVISORY_KEY]);
    for (const file of files) {
      const id = file;
      const applied = await client.query("SELECT 1 FROM _migrations WHERE id = $1", [id]);
      if (applied.rows.length) continue;
      const sql = fs.readFileSync(path.join(migrationsDir, file), "utf8");
      // one file = one transaction: the bookkeeping row commits together with
      // the DDL, so a failed file can never leave a half-applied, unrecorded state
      await client.query("BEGIN");
      try {
        await client.query(sql);
        await client.query("INSERT INTO _migrations (id) VALUES ($1) ON CONFLICT (id) DO NOTHING", [id]);
        await client.query("COMMIT");
        console.log(`[db] migration applied: ${id}`);
      } catch (e) {
        await client.query("ROLLBACK").catch(() => {});
        throw e;
      }
    }
  } finally {
    try { await client.query("SELECT pg_advisory_unlock($1)", [MIGRATE_ADVISORY_KEY]); } catch { /* pool teardown */ }
    client.release();
  }
}

export async function query(text, params) {
  return getPool().query(text, params);
}

export async function withTransaction(fn) {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}
