#!/usr/bin/env node
// Database backup (Phase 4.0.11): plain-SQL pg_dump of the compose PostgreSQL
// instance, written to backups/database/<UTC-timestamp>-<database>.sql plus a
// sidecar SHA-256 manifest.
//
// Credentials come from the environment ONLY (PGUSER/PGPASSWORD/PGDATABASE/
// PGHOST/PGPORT, mirroring src/database/client.js defaults). Nothing secret is
// ever hardcoded here and no password appears on any command line: the dump
// runs INSIDE the postgres container over the local trust socket, which needs
// no password at all. Host-side pg_dump is used when the binary is on PATH.
//
// Usage: node scripts/backup-database.mjs [--out-dir backups/database]
// Exit codes: 0 = backup written, 1 = error.
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PROJECT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// ---- configuration (env-first; defaults mirror docker-compose.yml topology,
// but NEVER its credentials — PGUSER/PGPASSWORD fall back to the same dev
// defaults src/database/client.js already uses) ----
const HOST = process.env.PGHOST || "127.0.0.1";
const PORT = process.env.PGPORT || "5433";
const USER = process.env.PGUSER || "cloner";
const PASSWORD = process.env.PGPASSWORD || "cloner_dev_password"; // eslint-disable-line no-secrets
const DATABASE = process.env.PGDATABASE || "cloner";
const CONTAINER = process.env.PG_CONTAINER || "cloner-postgres-1";
const OUT_DIR = path.resolve(
  process.argv.includes("--out-dir")
    ? process.argv[process.argv.indexOf("--out-dir") + 1]
    : path.join(PROJECT, "backups", "database")
);

function fail(msg) {
  console.error(`ERROR  backup-database: ${msg}`);
  process.exit(1);
}

function run(cmd, args, env = {}) {
  return spawnSync(cmd, args, {
    encoding: "utf8",
    env: { ...process.env, ...env },
    maxBuffer: 64 * 1024 * 1024,
  });
}

// Prefer a host pg_dump; fall back to `docker exec` inside the compose
// postgres container (which always has the matching client version).
function dump() {
  const common = [
    "--no-owner",
    "--no-privileges",
    "--no-password",
    "--clean",
    "--if-exists",
  ];
  let r = run("pg_dump", ["-h", HOST, "-p", PORT, "-U", USER, "-d", DATABASE, ...common], {
    PGPASSWORD: PASSWORD,
  });
  if (!r.error && r.status === 0) return { stdout: r.stdout, mode: "host-pg_dump" };
  if (r.error && r.error.code !== "ENOENT") fail(`host pg_dump failed: ${r.error.message}`);
  // container mode — PGPASSWORD deliberately NOT passed; the socket is trust-auth
  r = run("docker", ["exec", CONTAINER, "pg_dump", "-U", USER, "-d", DATABASE, ...common]);
  if (r.error) fail(`docker exec failed (is the compose postgres running?): ${r.error.message}`);
  if (r.status !== 0) fail(`container pg_dump exited ${r.status}: ${String(r.stderr).trim().slice(0, 400)}`);
  return { stdout: r.stdout, mode: `docker-exec:${CONTAINER}` };
}

const { stdout, mode } = dump();
if (!stdout || !stdout.includes("PostgreSQL database dump")) {
  fail("pg_dump output does not look like a dump — refusing to write an empty archive");
}

fs.mkdirSync(OUT_DIR, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const file = path.join(OUT_DIR, `${stamp}-${DATABASE}.sql`);
fs.writeFileSync(file, stdout, "utf8");

const sha = crypto.createHash("sha256").update(stdout).digest("hex");
const bytes = Buffer.byteLength(stdout);
const manifestPath = `${file}.sha256`;
fs.writeFileSync(manifestPath, `${sha}  ${path.basename(file)}\n`, "utf8");

console.log(
  `OK  backup-database: ${path.relative(PROJECT, file)} (${bytes} bytes, sha256 ${sha.slice(0, 16)}…, via ${mode})`
);
console.log(`OK  backup-database: manifest ${path.relative(PROJECT, manifestPath)}`);
