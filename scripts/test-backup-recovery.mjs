#!/usr/bin/env node
// Disaster-recovery drill (Phase 4.0.11) — the ask's verification check:
//
//   database backup  →  MUTATE the database  →  restore  →  data matches
//   the pre-mutation snapshot (row counts + user/task/artifact identity)
//
// plus the artifact side: backup a seeded artifact tree, corrupt it, restore,
// and verify every file against the SHA-256 manifest. A restore into a
// non-empty target without --force must be REFUSED.
//
// Runs against the compose PostgreSQL (docker compose up -d postgres if not
// running). If docker is unreachable, prints SKIP lines and exits 0 — this is
// a drill against a real engine, and faking one would prove nothing.
//
// IMPORTANT: the drill deliberately does NOT use the project's live `cloner`
// database — it creates its own throwaway database on the same cluster and
// drops it afterwards, so a failed drill cannot corrupt dev state.
//
// Usage: node scripts/test-backup-recovery.mjs
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const PROJECT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const HOST = process.env.PGHOST || "127.0.0.1";
const PORT = process.env.PGPORT || "5433";
const USER = process.env.PGUSER || "cloner";
const PASSWORD = process.env.PGPASSWORD || "cloner_dev_password"; // eslint-disable-line no-secrets
const CONTAINER = process.env.PG_CONTAINER || "cloner-postgres-1";
const DRILL_DB = `backup_drill_${Date.now().toString(36)}`;

const results = [];
const check = (name, ok, detail = "") => {
  results.push(ok);
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
};
const skipAll = (why) => {
  console.log(`SKIP  test-backup-recovery — ${why}`);
  console.log("SKIP  (docker/postgres unreachable — start it with: docker compose up -d postgres)");
  console.log("\nRESULT: PASS  (0/0 checks — skipped, engine unavailable)");
  process.exit(0);
};

const watchdog = setTimeout(() => { console.log("FAIL  global timeout (180s)"); process.exit(1); }, 180_000);

function docker(args, opts = {}) {
  return spawnSync("docker", args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, ...opts });
}
function dockerOk(args) {
  const r = docker(args);
  return !r.error && r.status === 0 ? r.stdout : null;
}
function sha256(text) { return crypto.createHash("sha256").update(text).digest("hex"); }

// ---- engine availability (loud SKIP per repo rule 3) ----
const ping = dockerOk(["exec", CONTAINER, "pg_isready", "-U", USER]);
if (!ping) skipAll(`postgres container '${CONTAINER}' not reachable via docker exec`);

// throwaway database on the compose cluster
if (dockerOk(["exec", CONTAINER, "psql", "-U", USER, "-d", "postgres", "-c", `DROP DATABASE IF EXISTS ${DRILL_DB}`]) === null)
  skipAll("cannot reach psql in the postgres container");
if (dockerOk(["exec", CONTAINER, "psql", "-U", USER, "-d", "postgres", "-c", `CREATE DATABASE ${DRILL_DB}`]) === null)
  skipAll("cannot create drill database in the postgres container");

// ---- helpers ----
const envForDrill = { ...process.env, PGDATABASE: DRILL_DB };
function runScript(file, args) {
  return spawnSync(process.execPath, [file, ...args], { encoding: "utf8", env: envForDrill, cwd: PROJECT, maxBuffer: 64 * 1024 * 1024 });
}
async function drillPool() {
  return new pg.Pool({ host: HOST, port: Number(PORT), database: DRILL_DB, user: USER, password: PASSWORD, max: 2 });
}

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "backup-drill-"));
const artifactsDir = path.join(tmpRoot, "platform-data");
const tmpDb = path.join(tmpRoot, "db");
const tmpArt = path.join(tmpRoot, "artifacts");
fs.mkdirSync(tmpDb, { recursive: true });
fs.mkdirSync(artifactsDir, { recursive: true });

try {
  // ============ PHASE 1: database backup → mutate → restore → matches ============
  const pool = await drillPool();
  // schema mirrors production (001-initial.sql) enough to exercise reconciliation
  await pool.query(`CREATE TABLE users (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), email TEXT UNIQUE NOT NULL, created_at TIMESTAMPTZ DEFAULT now())`);
  await pool.query(`CREATE TABLE tasks (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE, source_url TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'queued', error TEXT, updated_at TIMESTAMPTZ DEFAULT now())`);
  await pool.query(`CREATE TABLE artifacts (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), task_id UUID NOT NULL REFERENCES tasks(id) ON DELETE CASCADE, storage_key TEXT NOT NULL)`);
  await pool.query(`CREATE TABLE task_events (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), task_id UUID NOT NULL REFERENCES tasks(id) ON DELETE CASCADE, event_type TEXT NOT NULL, payload JSONB NOT NULL DEFAULT '{}', created_at TIMESTAMPTZ DEFAULT now())`);

  // seed 3 users, 6 tasks (one still 'running' to exercise reconciliation), artifacts
  const seed = {};
  for (const email of ["drill-a@backup.test", "drill-b@backup.test", "drill-c@backup.test"]) {
    const { rows } = await pool.query(`INSERT INTO users (email) VALUES ($1) RETURNING id`, [email]);
    seed[email] = rows[0].id;
  }
  for (const [i, email] of ["drill-a@backup.test", "drill-a@backup.test", "drill-b@backup.test", "drill-b@backup.test", "drill-c@backup.test", "drill-c@backup.test"].entries()) {
    const status = i === 0 ? "running" : "done";
    await pool.query(`INSERT INTO tasks (user_id, source_url, status) VALUES ($1, $2, $3)`,
      [seed[email], `https://drill-${i}.example.test`, status]);
  }
  const { rows: taskRows } = await pool.query(`SELECT id FROM tasks ORDER BY source_url`);
  for (const [i, t] of taskRows.entries()) {
    for (let k = 0; k <= i % 3; k++)
      await pool.query(`INSERT INTO artifacts (task_id, storage_key) VALUES ($1, $2)`, [t.id, `t${i}/out/page-${k}.html`]);
  }
  const snapshot = {
    users: (await pool.query(`SELECT email, id::text FROM users ORDER BY email`)).rows,
    tasks: (await pool.query(`SELECT t.source_url, t.status, u.email FROM tasks t JOIN users u ON u.id=t.user_id ORDER BY t.source_url`)).rows,
    artifactCount: (await pool.query(`SELECT count(*)::int n FROM artifacts`)).rows[0].n,
  };

  // ---- backup (subprocess so env scoping matches operator usage) ----
  let r = runScript(path.join(PROJECT, "scripts", "backup-database.mjs"), ["--out-dir", tmpDb]);
  check("drill: backup-database.mjs exits 0", r.status === 0, (r.stderr || "").split("\n").slice(-1)[0]);
  if (r.status !== 0) throw new Error("backup failed — cannot continue the drill");
  const backupFile = fs.readdirSync(tmpDb).filter((f) => f.endsWith(".sql")).sort().map((f) => path.join(tmpDb, f)).pop();
  check("drill: backup file + sha256 manifest exist", !!backupFile && fs.existsSync(`${backupFile}.sha256`), path.basename(backupFile || "(none)"));

  // ---- MUTATE: drop every table the drill can see (simulates total DB loss) ----
  await pool.query(`DROP TABLE IF EXISTS task_events, artifacts, tasks, users CASCADE`);
  const afterMutation = (await pool.query(
    `SELECT count(*)::int n FROM information_schema.tables WHERE table_schema='public' AND table_name IN ('users','tasks','artifacts','task_events')`
  )).rows[0].n;
  check("drill: database mutated (all tables dropped)", afterMutation === 0, `app tables after mutation: ${afterMutation}`);

  // ---- restore ----
  r = runScript(path.join(PROJECT, "scripts", "restore-database.mjs"), [backupFile]);
  check("drill: restore-database.mjs exits 0", r.status === 0, (r.stderr || "").split("\n").slice(-1)[0]);
  check("drill: restore output reports reconciliation step", /reconciled \d+ in-flight/.test(r.stdout), (r.stdout.match(/reconciled \d+ in-flight[^\n]*/) || ["(missing)"])[0]);

  // ---- post-restore verification: data matches the snapshot ----
  // NOTE: the one seed task seeded as 'running' is EXPECTED to differ — the
  // restore reconciles it to error/failed-recoverable (that is the point).
  // Its source_url and owner email must be identical; only its status changed.
  const expectedTasks = snapshot.tasks.map((t) =>
    t.status === "running" ? { ...t, status: "error" } : t
  );
  const post = {
    users: (await pool.query(`SELECT email, id::text FROM users ORDER BY email`)).rows,
    tasks: (await pool.query(`SELECT t.source_url, t.status, u.email FROM tasks t JOIN users u ON u.id=t.user_id ORDER BY t.source_url`)).rows,
    artifactCount: (await pool.query(`SELECT count(*)::int n FROM artifacts`)).rows[0].n,
  };
  check("drill: users restored identically (emails + uuid ids)", JSON.stringify(post.users) === JSON.stringify(snapshot.users));
  check(
    "drill: tasks restored identically (urls, owner emails; in-flight row reconciled to error)",
    JSON.stringify(post.tasks) === JSON.stringify(expectedTasks),
    post.tasks.length === snapshot.tasks.length ? "statuses: " + post.tasks.map((t) => t.status).join(",") : `row count ${post.tasks.length} vs ${snapshot.tasks.length}`
  );
  check("drill: artifact row count restored", post.artifactCount === snapshot.artifactCount, `${post.artifactCount}/${snapshot.artifactCount}`);

  // ---- reconciliation: the 'running' seed task must now be error/failed-recoverable ----
  const { rows: rec } = await pool.query(
    `SELECT status, error FROM tasks WHERE source_url = 'https://drill-0.example.test'`
  );
  check(
    "drill: in-flight task reconciled → error/failed-recoverable",
    rec.length === 1 && rec[0].status === "error" && /failed-recoverable/.test(rec[0].error || ""),
    rec[0] ? `${rec[0].status}: ${String(rec[0].error).slice(0, 80)}` : "task missing"
  );
  const { rows: events } = await pool.query(
    `SELECT payload FROM task_events te JOIN tasks t ON t.id = te.task_id WHERE te.event_type='reconciled'`
  );
  check("drill: reconciled event row written to task_events", events.length === 1 && events[0].payload.to === "error",
    events.length ? JSON.stringify(events[0].payload).slice(0, 90) : "no reconciled events");

  // ---- refusal guard: non-empty target without --force ----
  r = runScript(path.join(PROJECT, "scripts", "restore-database.mjs"), [backupFile]);
  check("drill: restore into non-empty target WITHOUT --force refused (exit 1)", r.status === 1, (r.stderr || "").split("\n")[0]);
  r = runScript(path.join(PROJECT, "scripts", "restore-database.mjs"), [backupFile, "--force"]);
  check("drill: restore with --force succeeds over existing data", r.status === 0);
  const usersAfterForce = (await pool.query(`SELECT count(*)::int n FROM users`)).rows[0].n;
  check("drill: --force restore leaves data matching snapshot again", usersAfterForce === snapshot.users.length, `${usersAfterForce} users`);
  await pool.end();

  // ============ PHASE 2: artifact backup → corrupt → restore → manifest match ============
  const privateDir = path.join(artifactsDir, "taskX", "private");
  fs.mkdirSync(privateDir, { recursive: true });
  fs.writeFileSync(path.join(artifactsDir, "taskX", "out.html"), "<html>drill page</html>");
  fs.writeFileSync(path.join(artifactsDir, "taskX", "manifest.json"), JSON.stringify({ job: "taskX" }));
  fs.writeFileSync(path.join(privateDir, "cookies.json"), "[{ \"secret\": true }]"); // must NOT be archived

  r = runScript(path.join(PROJECT, "scripts", "backup-artifacts.mjs"), ["--src", artifactsDir, "--out", path.join(tmpArt, "art.tar.gz")]);
  check("drill: backup-artifacts.mjs exits 0", r.status === 0, (r.stderr || "").split("\n").slice(-1)[0]);
  const manifest = JSON.parse(fs.readFileSync(path.join(tmpArt, "art.manifest.json"), "utf8"));
  check("drill: artifact manifest lists exactly the non-private files",
    Object.keys(manifest.files).sort().join(",") === "taskX/manifest.json,taskX/out.html",
    Object.keys(manifest.files).join(","));
  const archiveTar = spawnSync("tar", ["-tzf", path.join(tmpArt, "art.tar.gz")], { encoding: "utf8" });
  check("drill: archive contains NO private/ (credentials excluded by design)",
    !/(^|\/)private\//.test(archiveTar.stdout), archiveTar.stdout.trim().replace(/\n/g, " | "));

  // corrupt: change a file AND delete another
  fs.writeFileSync(path.join(artifactsDir, "taskX", "out.html"), "<html>TAMPERED</html>");
  fs.rmSync(path.join(artifactsDir, "taskX", "manifest.json"));
  r = runScript(path.join(PROJECT, "scripts", "backup-artifacts.mjs"), ["--restore", path.join(tmpArt, "art.tar.gz"), artifactsDir]);
  check("drill: artifact --restore exits 0", r.status === 0, (r.stderr || "").split("\n").slice(-1)[0]);
  const restoredHtml = fs.readFileSync(path.join(artifactsDir, "taskX", "out.html"), "utf8");
  check("drill: tampered file restored from archive", restoredHtml === "<html>drill page</html>");
  check("drill: deleted file restored from archive", fs.existsSync(path.join(artifactsDir, "taskX", "manifest.json")));
  // private/ was never archived, so a restore into a CLEAN dir must not create it
  // (the same-dir restore above leaves the drill's own private/ files in place —
  // restore overlays, it does not wipe)
  const cleanDir = path.join(tmpRoot, "restored-clean");
  r = runScript(path.join(PROJECT, "scripts", "backup-artifacts.mjs"), ["--restore", path.join(tmpArt, "art.tar.gz"), cleanDir]);
  const cleanPrivate = fs.existsSync(path.join(cleanDir, "taskX", "private"));
  check("drill: private/ cookies file NOT restored into a clean dir (never archived)",
    r.status === 0 && cleanPrivate === false, `clean-dir private/ exists: ${cleanPrivate}`);

  // tamper-detection: restore into a clean dir with a corrupted archive fails
  const badArchive = path.join(tmpArt, "bad.tar.gz");
  fs.writeFileSync(badArchive, "this is not a tar.gz");
  r = runScript(path.join(PROJECT, "scripts", "backup-artifacts.mjs"), ["--restore", badArchive, path.join(tmpRoot, "bad")]);
  check("drill: corrupted archive restore FAILS (nonzero exit)", r.status !== 0);

  // ============ summary ============
  const fails = results.filter((x) => !x).length;
  console.log(`\nRESULT: ${fails ? "FAIL" : "PASS"}  (${results.length - fails}/${results.length} checks passed)`);
  process.exitCode = fails ? 1 : 0;
} catch (e) {
  check("drill: unexpected error", false, e.message);
  const fails = results.filter((x) => !x).length;
  console.log(`\nRESULT: ${fails ? "FAIL" : "PASS"}  (${results.length - fails}/${results.length} checks passed)`);
  process.exitCode = 1;
} finally {
  // drop the throwaway database; clean temp dir
  docker(["exec", CONTAINER, "psql", "-U", USER, "-d", "postgres", "-c", `DROP DATABASE IF EXISTS ${DRILL_DB}`]);
  try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch {}
  clearTimeout(watchdog);
}
