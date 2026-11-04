#!/usr/bin/env node
// Task 4.0.10 verification — deployment, configuration and database migrations.
//
//   node scripts/test-deployment.mjs
//
// Sections (each prints PASS/FAIL/SKIP; any FAIL exits non-zero):
//   1. [unit]     src/config-schema.js: env validation, secret redaction and the
//                 forward-only migration guard. Always runs, needs no services.
//   2. [docker]   Only when docker is present:
//                   docker compose -f docker-compose.prod.yml config -q
//                   docker build --target runtime -t cloner-platform:deploy-test .
//                 plus non-root and chromium-launch checks inside the image.
//                 Without docker → SKIP with a note.
//   3. [postgres] Only when the dev compose postgres (127.0.0.1:5433) is
//                 reachable — docker compose up -d postgres is started if needed:
//                   fresh-database migration init, idempotent re-run,
//                   live forward-only guard, API boot + shutdown,
//                   worker boot + shutdown (needs redis, same gating).
//                 Unreachable → SKIP with a note.
//
// All database work in this test happens in a THROWAWAY database
// (cloner_deploy_test_<ts>) that is dropped afterwards; the existing dev
// database is only read, never written.

import { spawnSync, spawn } from "node:child_process";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  validateEnv,
  assertEnv,
  ConfigError,
  redact,
  assertMigrationsForwardOnly,
  migrateForwardOnly,
  listMigrationFiles,
} from "../src/config-schema.js";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const results = { pass: 0, fail: 0, skip: 0 };
const children = [];

function pass(name, detail = "") {
  results.pass++;
  console.log(`PASS  ${name}${detail ? ` — ${detail}` : ""}`);
}
function fail(name, detail = "") {
  results.fail++;
  console.log(`FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
}
function skip(name, detail = "") {
  results.skip++;
  console.log(`SKIP  ${name}${detail ? ` — ${detail}` : ""}`);
}
function ok(cond, name, detail = "") {
  cond ? pass(name, detail) : fail(name, detail);
}

// dev compose credentials — they are the public, committed development
// fixture from docker-compose.yml, not a secret.
const DEV_PG = {
  PGHOST: "127.0.0.1",
  PGPORT: "5433",
  PGUSER: "cloner",
  PGPASSWORD: "cloner_dev_password",
  PGDATABASE: "cloner",
};

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, {
    cwd: ROOT,
    encoding: "utf8",
    timeout: opts.timeout || 120000,
    env: opts.env ? { ...process.env, ...opts.env } : process.env,
  });
  return { status: r.status, stdout: r.stdout || "", stderr: r.stderr || "" };
}

function tcpProbe(port, host = "127.0.0.1", timeoutMs = 1500) {
  return new Promise((resolve) => {
    const s = net.connect({ port, host });
    s.setTimeout(timeoutMs);
    s.on("connect", () => { s.destroy(); resolve(true); });
    s.on("timeout", () => { s.destroy(); resolve(false); });
    s.on("error", () => resolve(false));
  });
}

// ---------------------------------------------------------------------------
// 1. config-schema units
// ---------------------------------------------------------------------------
async function sectionUnit() {
  console.log("\n── [unit] src/config-schema.js ─────────────────────────────");

  // t1: full valid production environment validates
  const fullEnv = {
    NODE_ENV: "production",
    PORT: "4180",
    PGHOST: "postgres",
    PGPORT: "5432",
    PGDATABASE: "cloner",
    PGUSER: "cloner",
    PGPASSWORD: "unit-pass-771",
    REDIS_URL: "redis://redis:6379",
    MAX_CONCURRENT: "2",
    RETENTION_DAYS: "15",
    PURGE_CREDS_ON_DONE: "1",
  };
  const v1 = validateEnv({ role: "api", env: fullEnv, mode: "production" });
  ok(v1.ok === true, "unit/valid production env accepted", `errors=${JSON.stringify(v1.errors)}`);

  // t2: missing PGPASSWORD in production → actionable error naming key + fix
  const { PGPASSWORD: _omit, ...noPass } = fullEnv;
  const v2 = validateEnv({ role: "api", env: noPass, mode: "production" });
  ok(
    v2.ok === false &&
      v2.errors.join("\n").includes("PGPASSWORD") &&
      v2.errors.join("\n").includes("Fix:"),
    "unit/missing PGPASSWORD flagged with actionable fix",
    v2.errors.join(" | ").slice(0, 120)
  );

  // t3: secret values never echoed in validation errors
  const v3 = validateEnv({
    role: "api",
    env: { ...noPass, PGPASSWORD: "sentinel-pass-9183", REDIS_URL: "postgres://bad-scheme" },
    mode: "production",
  });
  const v3text = v3.errors.join("\n");
  ok(
    v3.ok === false && !v3text.includes("sentinel-pass-9183") && v3text.includes("REDIS_URL"),
    "unit/error text never contains secret values",
    "sentinel absent from errors"
  );

  // t4: redact() scrubs known-secret values
  const r4 = redact("conn redis://:unit-secret-42@host and key unit-key-43", {
    REDIS_URL: "redis://:unit-secret-42@host",
    ANTHROPIC_API_KEY: "unit-key-43",
  });
  ok(
    !r4.includes("unit-secret-42") && !r4.includes("unit-key-43") && r4.includes("***"),
    "unit/redact() masks secret values",
    r4
  );

  // t5: worker without REDIS_URL is rejected in every mode
  const v5 = validateEnv({ role: "worker", env: { ...fullEnv, REDIS_URL: undefined }, mode: "development" });
  ok(v5.ok === false && v5.errors.join("\n").includes("REDIS_URL"), "unit/worker requires REDIS_URL");

  // t6: non-integer PORT rejected without echoing content
  const v6 = validateEnv({ role: "api", env: { ...fullEnv, PORT: "http" }, mode: "production" });
  ok(v6.ok === false && v6.errors.join("\n").includes("PORT"), "unit/invalid PORT rejected");

  // t7: assertEnv throws ConfigError, message redacted
  try {
    // REDIS_URL is present but has a non-redis scheme → validation error;
    // the sentinel "leak-me-77" (its value) must never appear in the message.
    assertEnv("api", { env: { ...fullEnv, REDIS_URL: "postgres://leak-me-77" }, mode: "production" });
    fail("unit/assertEnv throws");
  } catch (e) {
    ok(
      e instanceof ConfigError && e.message.includes("REDIS_URL") && !e.message.includes("leak-me-77"),
      "unit/assertEnv throws redacted ConfigError"
    );
  }

  // t8: forward-only guard (pure)
  try {
    assertMigrationsForwardOnly({ applied: ["001-initial.sql"], files: ["001-initial.sql"] });
    pass("unit/guard accepts consistent history");
  } catch (e) {
    fail("unit/guard accepts consistent history", e.message);
  }
  try {
    assertMigrationsForwardOnly({ applied: ["002-gone.sql"], files: ["001-initial.sql"] });
    fail("unit/guard rejects applied-but-missing file");
  } catch (e) {
    ok(e.message.includes("forward-only violation"), "unit/guard rejects applied-but-missing file");
  }
  try {
    assertMigrationsForwardOnly({ applied: [], files: ["x-bad.sql"] });
    fail("unit/guard rejects non-3-digit filenames");
  } catch (e) {
    ok(e.message.includes("3-digit"), "unit/guard rejects non-3-digit filenames");
  }

  // t9: unknown role throws
  try {
    validateEnv({ role: "nope" });
    fail("unit/unknown role throws");
  } catch {
    pass("unit/unknown role throws");
  }
}

// ---------------------------------------------------------------------------
// 2. docker checks
// ---------------------------------------------------------------------------
function dockerAvailable() {
  return run("docker", ["info", "--format", "{{.ServerVersion}}"], { timeout: 30000 }).status === 0;
}

async function sectionDocker() {
  console.log("\n── [docker] compose config + image build ───────────────────");
  if (!dockerAvailable()) {
    skip("docker/compose config", "docker not available — build/config checks skipped");
    skip("docker/build runtime image", "docker not available — build/config checks skipped");
    skip("docker/non-root user", "docker not available — build/config checks skipped");
    skip("docker/chromium launch in image", "docker not available — build/config checks skipped");
    return false;
  }

  // c1: docker compose -f docker-compose.prod.yml config -q
  const cfg = run(
    "docker",
    ["compose", "-f", "docker-compose.prod.yml", "config", "-q"],
    { env: { POSTGRES_USER: "ci", POSTGRES_PASSWORD: "ci-pass", POSTGRES_DB: "cloner" } }
  );
  ok(cfg.status === 0, "docker/compose config -q valid", cfg.status === 0 ? "" : cfg.stderr.slice(0, 300));

  // c2: build the runtime target
  console.log("      building runtime image (this can take a few minutes)…");
  const build = run("docker", ["build", "--target", "runtime", "-t", "cloner-platform:deploy-test", "."], {
    timeout: 900000,
  });
  ok(build.status === 0, "docker/build --target runtime", build.status === 0 ? "" : (build.stderr || build.stdout).slice(-400));

  if (build.status !== 0) {
    skip("docker/non-root user", "image build failed");
    skip("docker/chromium launch in image", "image build failed");
    return false;
  }

  // c3: non-root (runs as the node user, uid 1000)
  const who = run("docker", ["run", "--rm", "cloner-platform:deploy-test", "id", "-un"], { timeout: 60000 });
  ok(who.status === 0 && who.stdout.trim() === "node", "docker/image runs as non-root (node)", `id -un → ${who.stdout.trim()}`);

  // c4: chromium actually launches inside the image
  const launch = run(
    "docker",
    [
      "run", "--rm", "cloner-platform:deploy-test",
      "node", "-e",
      "import('playwright').then(async (m) => { const b = await m.chromium.launch({ headless: true }); console.log('chromium-launch-ok'); await b.close(); process.exit(0); }).catch((e) => { console.error('LAUNCH-FAIL: ' + e.message.slice(0, 300)); process.exit(1); })",
    ],
    { timeout: 120000 }
  );
  ok(launch.status === 0 && launch.stdout.includes("chromium-launch-ok"), "docker/chromium launches inside image",
     launch.status === 0 ? "" : (launch.stderr + launch.stdout).slice(-300));

  return true;
}

// ---------------------------------------------------------------------------
// 3. postgres-backed checks (throwaway database)
// ---------------------------------------------------------------------------
async function pgConnect(db) {
  const { Client } = await import("pg");
  const c = new Client({ host: DEV_PG.PGHOST, port: Number(DEV_PG.PGPORT), user: DEV_PG.PGUSER, password: DEV_PG.PGPASSWORD, database: db, connectionTimeoutMillis: 4000 });
  await c.connect();
  return c;
}

async function waitPostgres(seconds = 45) {
  const deadline = Date.now() + seconds * 1000;
  while (Date.now() < deadline) {
    if (await tcpProbe(5433)) {
      try { const c = await pgConnect("postgres"); await c.end(); return true; } catch { /* not ready yet */ }
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  return false;
}

async function sectionPostgres() {
  console.log("\n── [postgres] migrations, API boot, worker boot ────────────");
  // bring the dev compose postgres up if it is not running (rule: tests use
  // the compose instance); skip the section entirely when unreachable.
  const up = run("docker", ["compose", "-f", "docker-compose.yml", "up", "-d", "postgres"], { timeout: 120000 });
  if (up.status !== 0) {
    skip("postgres/migrations on fresh database", "docker compose postgres could not be started");
    skip("postgres/idempotent re-run", "docker compose postgres could not be started");
    skip("postgres/forward-only guard vs live DB", "docker compose postgres could not be started");
    skip("postgres/API boot + shutdown", "docker compose postgres could not be started");
    skip("postgres/worker boot + shutdown", "docker compose postgres could not be started");
    return;
  }
  const reachable = await waitPostgres();
  if (!reachable) {
    skip("postgres/migrations on fresh database", "postgres unreachable on 127.0.0.1:5433 — SKIP");
    skip("postgres/idempotent re-run", "postgres unreachable on 127.0.0.1:5433 — SKIP");
    skip("postgres/forward-only guard vs live DB", "postgres unreachable on 127.0.0.1:5433 — SKIP");
    skip("postgres/API boot + shutdown", "postgres unreachable on 127.0.0.1:5433 — SKIP");
    skip("postgres/worker boot + shutdown", "postgres unreachable on 127.0.0.1:5433 — SKIP");
    return;
  }

  const testDb = `cloner_deploy_test_${Date.now() % 10000000}`;
  const admin = await pgConnect("postgres");
  try {
    await admin.query(`DROP DATABASE IF EXISTS "${testDb}"`);
    await admin.query(`CREATE DATABASE "${testDb}"`);
  } catch (e) {
    fail("postgres/test database creation", e.message);
    await admin.end().catch(() => {});
    return;
  }

  const prevDb = process.env.PGDATABASE;
  const bootEnv = {
    ...DEV_PG,
    PGDATABASE: testDb,
    NODE_ENV: "production",
    REDIS_URL: "redis://127.0.0.1:6379",
    PORT: "4199",
  };
  process.env = { ...process.env, ...bootEnv }; // client.js reads process.env

  try {
    // p1: fresh-database migration init (previous schema state: empty DB)
    const files = listMigrationFiles();
    const r1 = await migrateForwardOnly();
    ok(
      r1.appliedBefore.length === 0 &&
        r1.appliedThisRun.length === files.length &&
        r1.appliedThisRun.includes(files[files.length - 1]),
      "postgres/migrations on fresh database",
      `applied ${r1.appliedThisRun.length}/${files.length}: ${r1.appliedThisRun.join(", ")}`
    );

    // p2: re-run is a forward-only no-op
    const r2 = await migrateForwardOnly();
    ok(
      r2.appliedThisRun.length === 0 && r2.appliedBefore.length === files.length,
      "postgres/idempotent re-run (forward-only)",
      `nothing applied on second run`
    );

    // p3: live forward-only guard — a recorded-but-missing migration refuses
    const g = await pgConnect(testDb);
    await g.query(`INSERT INTO _migrations (id) VALUES ('999-does-not-exist.sql')`);
    await g.end();
    let guardThrew = null;
    try { await migrateForwardOnly(); } catch (e) { guardThrew = e; }
    ok(
      guardThrew instanceof ConfigError && guardThrew.message.includes("forward-only violation"),
      "postgres/forward-only guard vs live DB",
      guardThrew ? guardThrew.message.slice(0, 140) : "migrateForwardOnly did NOT throw"
    );
    const g2 = await pgConnect(testDb);
    await g2.query(`DELETE FROM _migrations WHERE id = '999-does-not-exist.sql'`);
    await g2.end();

    // p4: API boot on the migrated fresh DB, then shutdown
    const assert = validateEnv({ role: "api", env: bootEnv, mode: "production" });
    ok(assert.ok, "postgres/api boot env valid", assert.errors.join(" | ").slice(0, 160));

    const api = spawn(process.execPath, ["bin/platform.js", "--port", "4199"], {
      cwd: ROOT,
      env: { ...process.env, ...bootEnv },
    });
    children.push(api);
    let apiOut = "";
    api.stdout.on("data", (d) => (apiOut += d));
    api.stderr.on("data", (d) => (apiOut += d));
    let apiUp = false;
    for (let i = 0; i < 30 && !apiUp; i++) {
      if (api.exitCode !== null) break;
      apiUp = await tcpProbe(4199);
      if (!apiUp) await new Promise((r) => setTimeout(r, 500));
    }
    ok(apiUp && api.exitCode === null, "postgres/API boot (listens on :4199)", apiUp ? "" : apiOut.slice(-300));

    if (apiUp) {
      // G7.1: the platform ships HEADLESS — "/" must 404 (no UI is served),
      // while the API surface stays reachable on the same port.
      const rootHttp = await fetch("http://127.0.0.1:4199/").then((r) => r.status).catch(() => 0);
      const apiHttp = await fetch("http://127.0.0.1:4199/healthz").then((r) => r.status).catch(() => 0);
      ok(rootHttp === 404 && apiHttp === 200, "postgres/API serves API over HTTP, headless root 404s",
         `GET / → ${rootHttp} (404 expected, no UI since G7.1) · GET /healthz → ${apiHttp}`);
      api.kill("SIGTERM");
      const exited = await Promise.race([
        new Promise((r) => api.on("exit", r)),
        new Promise((r) => setTimeout(() => r(false), 10000)),
      ]);
      // On Windows signal delivery is emulated (hard kill) — the container
      // runtime (compose uses init: true) is where the SIGTERM drain runs.
      ok(exited !== false, "postgres/API shutdown on SIGTERM",
         process.platform === "win32" ? "signal emulated on win32" : "graceful exit within 10s");
    } else {
      skip("postgres/API serves API over HTTP, headless root 404s", "API did not come up");
      skip("postgres/API shutdown on SIGTERM", "API did not come up");
    }

    // p5: worker boot (needs redis)
    const redisUp = await tcpProbe(6379);
    if (redisUp) {
      const w = spawn(process.execPath, ["src/workers/clone-worker.js"], {
        cwd: ROOT,
        env: { ...process.env, ...bootEnv },
      });
      children.push(w);
      let wOut = "";
      w.stdout.on("data", (d) => (wOut += d));
      w.stderr.on("data", (d) => (wOut += d));
      const ready = await Promise.race([
        new Promise((resolve) => {
          const t = setInterval(() => {
            if (/ready — queue=clone-jobs/.test(wOut)) { clearInterval(t); resolve(true); }
            else if (w.exitCode !== null) { clearInterval(t); resolve(false); }
          }, 300);
          setTimeout(() => { clearInterval(t); resolve(/ready — queue=clone-jobs/.test(wOut)); }, 15000);
        }),
      ]);
      ok(ready, "postgres/worker boot (BullMQ ready)", ready ? "" : wOut.slice(-300));
      w.kill("SIGTERM");
      const wExited = await Promise.race([
        new Promise((r) => w.on("exit", r)),
        new Promise((r) => setTimeout(() => r(false), 10000)),
      ]);
      ok(wExited !== false, "postgres/worker shutdown on SIGTERM",
         process.platform === "win32" ? "signal emulated on win32" : "drain + exit within 10s");
    } else {
      skip("postgres/worker boot (BullMQ ready)", "redis unreachable on 127.0.0.1:6379 — SKIP");
      skip("postgres/worker shutdown on SIGTERM", "redis unreachable on 127.0.0.1:6379 — SKIP");
    }
  } finally {
    for (const c of children) { try { c.kill("SIGKILL"); } catch {} }
    process.env.PGDATABASE = prevDb;
    try {
      const { closePool } = await import("../src/database/client.js");
      await closePool().catch(() => {});
      await admin.query(`DROP DATABASE IF EXISTS "${testDb}"`);
      pass("postgres/cleanup", `dropped ${testDb}`);
    } catch (e) {
      fail("postgres/cleanup", e.message);
    }
    await admin.end().catch(() => {});
  }
}

// ---------------------------------------------------------------------------
async function main() {
  console.log("cloner platform — deployment test (task 4.0.10)");
  console.log(`node ${process.version} · ${process.platform}`);

  await sectionUnit();
  await sectionDocker();
  await sectionPostgres();

  console.log("\n════════════════════════════════════════════════════════════");
  console.log(`deployment test: ${results.pass} passed · ${results.fail} failed · ${results.skip} skipped`);
  process.exit(results.fail > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error("deployment test crashed:", e);
  process.exit(1);
});
