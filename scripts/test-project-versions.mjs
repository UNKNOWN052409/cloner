#!/usr/bin/env node
// Task 4.1.3 e2e — project versions, snapshots and rollback.
//
// Exercises version-service.js against the REAL database (project_versions,
// migration 018) and the REAL on-disk version store:
//   • 3 snapshots of an evolving tree → versions 1..3, monotonic
//   • manifests: file list + sha256 + size recorded, stable across reads
//   • version rows are IMMUTABLE — a second write to the same tree creates a
//     NEW version, never mutates the old row (hash stability asserted)
//   • rollback materializes a prior version byte-identical (sha256 per file)
//   • rollback never writes into a non-empty dir (non-destructive refusal)
//   • store drift is detected (tampered store file → verify fails, rollback refused)
//
// SKIP loudly when PostgreSQL is unreachable.
process.env.PGCONNECT_TIMEOUT = process.env.PGCONNECT_TIMEOUT || "4";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const PROJECT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
process.chdir(PROJECT);

const results = [];
const check = (name, ok, detail = "") => {
  results.push(ok);
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
};

async function pgReachable() {
  const { query, closePool } = await import("../src/database/client.js");
  try { await query("SELECT 1"); return { ok: true, query, closePool }; }
  catch { try { await closePool(); } catch {} return { ok: false }; }
}
const db = await pgReachable();
if (!db.ok) {
  console.log("SKIP  project-versions — PostgreSQL unreachable (`docker compose up -d postgres`) — loud SKIP per test convention.");
  process.exit(0);
}
const { query, closePool } = db;

const fsMod = await import("node:fs");
async function applyOwnMigrations() {
  await query(`CREATE TABLE IF NOT EXISTS _migrations (id TEXT PRIMARY KEY, applied_at TIMESTAMPTZ DEFAULT now())`);
  const dir = path.join(PROJECT, "src", "database", "migrations");
  for (const file of ["001-initial.sql", "010-tenants.sql", "018-product-platform.sql"]) {
    const applied = await query("SELECT 1 FROM _migrations WHERE id = $1", [file]);
    if (applied.rows.length) continue;
    await query(fsMod.readFileSync(path.join(dir, file), "utf8"));
    await query("INSERT INTO _migrations (id) VALUES ($1) ON CONFLICT (id) DO NOTHING", [file]);
    console.log(`[db] applied: ${file}`);
  }
}
await applyOwnMigrations();

const V = await import("../src/platform/version-service.js");
const rand = () => crypto.randomBytes(6).toString("hex");

const work = fs.mkdtempSync(path.join(os.tmpdir(), "versions-test-"));
const taskId = "t-ver-" + rand();
const projDir = path.join(work, "project");

function writeTree(version) {
  fs.rmSync(projDir, { recursive: true, force: true });
  fs.mkdirSync(path.join(projDir, "assets"), { recursive: true });
  fs.writeFileSync(path.join(projDir, "index.html"), `<html><body><h1>site v${version}</h1><img src="assets/logo.png"></body></html>`);
  fs.writeFileSync(path.join(projDir, "assets", "logo.png"), Buffer.from(`png-bytes-v${version}-${rand()}`));
  fs.writeFileSync(path.join(projDir, "assets", "style.css"), `body{color:#${version}11}`);
}

function sha256(file) {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

// ---- 3 versions of an evolving tree ----
const snapshots = [];
for (const v of [1, 2, 3]) {
  writeTree(v);
  const snap = await V.snapshotProject({ taskId, projectDir: projDir, note: `snapshot v${v}` });
  snapshots.push(snap);
  check(`V${v}1 version number monotonic (${v})`, snap.version === v, String(snap.version));
  check(`V${v}2 manifest carries every file with sha256+size`, snap.manifest.fileCount === 3 && snap.manifest.files.every((f) => /^[0-9a-f]{64}$/.test(f.sha256) && f.size > 0), `${snap.manifest.fileCount} files`);
  check(`V${v}3 totalBytes is the true sum`, snap.manifest.totalBytes === snap.manifest.files.reduce((a, f) => a + f.size, 0), String(snap.manifest.totalBytes));
}

// ---- manifest stability / immutability ----
{
  const again = await V.getVersion(taskId, 1);
  const first = snapshots[0];
  const sameHashes = again.manifest.files.map((f) => f.sha256).join() === first.manifest.files.map((f) => f.sha256).join();
  const sameTimestamp = new Date(again.createdAt).toISOString() === new Date(first.createdAt).toISOString();
  check("V4  version 1 manifest is byte-stable across reads", sameHashes && sameTimestamp, "row untouched");

  // a 4th snapshot of the SAME tree → new version, old rows untouched
  const dupe = await V.snapshotProject({ taskId, projectDir: projDir, note: "same tree again" });
  check("V5  re-snapshot creates a NEW version (append-only)", dupe.version === 4, String(dupe.version));
  const v3after = await V.getVersion(taskId, 3);
  check("V6  prior rows never mutate on later snapshots",
    v3after.manifest.files.map((f) => f.sha256).join() === snapshots[2].manifest.files.map((f) => f.sha256).join(), "hash set unchanged");
}

// ---- rollback: byte-identical materialization ----
{
  const dest = path.join(work, "rollback-v1");
  const r = await V.rollback(taskId, 1, dest);
  check("R1  rollback reports ok with the file list", r.ok === true && r.files.length === 3, `files=${r.files?.length}`);
  const idx = fs.readFileSync(path.join(dest, "index.html"), "utf8");
  check("R2  restored content is the version-1 content", idx.includes("site v1"), idx.slice(0, 60));
  const srcManifest = (await V.getVersion(taskId, 1)).manifest;
  let allMatch = true;
  for (const f of srcManifest.files) {
    const restored = path.join(dest, f.path);
    if (!fs.existsSync(restored) || sha256(restored) !== f.sha256) allMatch = false;
  }
  check("R3  every restored file matches the recorded sha256 (byte-identical tree)", allMatch, "verified per-file");

  // rollback to v2 differs from v1 (the tree actually moved)
  const dest2 = path.join(work, "rollback-v2");
  await V.rollback(taskId, 2, dest2);
  check("R4  rollback of v2 differs from v1 (versions are distinct trees)",
    fs.readFileSync(path.join(dest2, "assets", "style.css"), "utf8") !== fs.readFileSync(path.join(dest, "assets", "style.css"), "utf8"), "content moved");

  // non-destructive refusal on a non-empty destination
  let refused = false;
  try { await V.rollback(taskId, 1, dest); } catch { refused = true; }
  check("R5  rollback into a NON-EMPTY dir is refused (never destructive)", refused, " threw as designed");
}

// ---- store drift detection ----
{
  const store = V.versionsStoreDir(taskId);
  const v2Store = path.join(store, "2");
  const target = path.join(v2Store, "assets", "style.css");
  fs.writeFileSync(target, "tampered");
  const verdict = await V.verifyVersion(taskId, 2);
  check("T1  tampered store file detected by verify", verdict.ok === false && verdict.problems.some((p) => p.startsWith("modified:")), JSON.stringify(verdict.problems));
  let refused = false;
  try { await V.rollback(taskId, 2, path.join(work, "rollback-tampered")); } catch { refused = true; }
  check("T2  rollback REFUSED on store drift (never silently restores)", refused, "threw on sha mismatch");
  // restore for cleanup symmetry
  writeTree(2);
  fs.copyFileSync(path.join(projDir, "assets", "style.css"), target);
  const healed = await V.verifyVersion(taskId, 2);
  check("T3  verify passes again after the store is repaired", healed.ok === true, "clean");
}

// ---- unknown version ----
{
  let err = null;
  try { await V.rollback(taskId, 99, path.join(work, "nope")); } catch (e) { err = e; }
  check("R6  unknown version → clean error", !!err && /not found/.test(err.message), err?.message?.slice(0, 80));
}

// ---- cleanup ----
fs.rmSync(work, { recursive: true, force: true });
fs.rmSync(V.versionsStoreDir(taskId), { recursive: true, force: true });
await query("DELETE FROM project_versions WHERE task_id = $1", [taskId]);
await closePool();

const pass = results.filter(Boolean).length;
const fail = results.length - pass;
console.log(`\nRESULT: ${fail ? "FAIL" : "PASS"}  (${pass}/${results.length})`);
process.exit(fail ? 1 : 0);
