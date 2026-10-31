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

export async function migrate() {
  const p = getPool();
  const { fileURLToPath } = await import("node:url");
  const migrationsDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "migrations");
  const fs = await import("node:fs");
  await p.query(`CREATE TABLE IF NOT EXISTS _migrations (id TEXT PRIMARY KEY, applied_at TIMESTAMPTZ DEFAULT now())`);
  const files = fs.readdirSync(migrationsDir).filter((f) => f.endsWith(".sql")).sort();
  for (const file of files) {
    const id = file;
    const applied = await p.query("SELECT 1 FROM _migrations WHERE id = $1", [id]);
    if (applied.rows.length) continue;
    const sql = fs.readFileSync(path.join(migrationsDir, file), "utf8");
    await p.query(sql);
    await p.query("INSERT INTO _migrations (id) VALUES ($1)", [id]);
    console.log(`[db] migration applied: ${id}`);
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
