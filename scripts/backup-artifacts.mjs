#!/usr/bin/env node
// Artifact backup (Phase 4.0.11): tars an artifact tree (platform-data/ or any
// artifacts dir) into backups/artifacts/<UTC-timestamp>-artifacts.tar.gz with a
// SHA-256 manifest of every file inside, written NEXT TO the archive (NOT
// inside it) so the manifest can verify the archive's contents after a restore
// without trusting the archive to describe itself.
//
// By design the archive contains NO credentials: platform-data/<task>/private/
// (cookies, storage state) is excluded — those are session secrets with their
// own lifecycle (purged on done/error, shredded at export, src/platform/tasks.js).
//
// Usage:
//   node scripts/backup-artifacts.mjs                            # backup platform-data/
//   node scripts/backup-artifacts.mjs --src <dir> --out <file>   # explicit
//   node scripts/backup-artifacts.mjs --restore backups/artifacts/<file>.tar.gz <destDir>
// Exit codes: 0 = success, 1 = error.
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PROJECT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const argv = process.argv.slice(2);

function fail(msg) {
  console.error(`ERROR  backup-artifacts: ${msg}`);
  process.exit(1);
}

// tar on Git-Bash-for-Windows ships with the system; bsdtar/libarchive also OK
const tarArgs = (() => {
  // GNU tar needs --force-local so "C:\..." paths are not read as remote hosts;
  // probe once — bsdtar (Windows system tar) lacks the flag and doesn't need it
  const probe = spawnSync("tar", ["--force-local", "--version"], { encoding: "utf8" });
  return !probe.error && probe.status === 0 ? ["--force-local"] : [];
})();
function tar(args, opts = {}) {
  const r = spawnSync("tar", [...tarArgs, ...args], { encoding: "buffer", maxBuffer: 256 * 1024 * 1024, ...opts });
  if (r.error) fail(`tar failed (${r.error.code === "ENOENT" ? "not found on PATH" : r.error.message})`);
  return r;
}

// tar exit status is decisive (G5.4): a truncated/corrupt archive can exit
// non-zero while still extracting a PREFIX of the tree — the extraction must
// be declared failed, not silently continue into verification.
function tarOr(args, opts = {}) {
  const r = tar(args, opts);
  if (r.status !== 0) fail(`tar exited ${r.status}: ${String(r.stderr || "").slice(0, 400)}`);
  return r;
}

function sha256File(file) {
  const h = crypto.createHash("sha256");
  h.update(fs.readFileSync(file));
  return h.digest("hex");
}

function walk(dir, base = dir, acc = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full, base, acc);
    else if (e.isFile()) acc.push(path.relative(base, full).split(path.sep).join("/"));
  }
  return acc;
}

const RESTORE = argv.includes("--restore");

if (RESTORE) {
  // ---- restore: untar + verify every file against the sidecar manifest ----
  const archive = path.resolve(argv[argv.indexOf("--restore") + 1] || "");
  const dest = path.resolve(argv[argv.indexOf("--restore") + 2] || "");
  if (!archive || !fs.existsSync(archive)) fail(`no such archive: ${archive}`);
  if (!dest) fail("usage: --restore <archive.tar.gz> <destDir>");
  fs.mkdirSync(dest, { recursive: true });
  tarOr(["-xzf", archive], { cwd: dest }); // cwd=dest replaces -C (see note above)

  const base = path.basename(archive).replace(/\.tar\.gz$/, "");
  const manifest = path.join(path.dirname(archive), `${base}.manifest.json`);
  if (!fs.existsSync(manifest)) fail(`sidecar manifest missing: ${manifest} (restore refused)`);
  const entries = JSON.parse(fs.readFileSync(manifest, "utf8"));
  let verified = 0;
  for (const [rel, rec] of Object.entries(entries.files)) {
    const f = path.join(dest, rel);
    if (!fs.existsSync(f)) fail(`restored tree missing file: ${rel}`);
    const actual = sha256File(f);
    if (actual !== rec.sha256) fail(`checksum mismatch for ${rel}`);
    verified++;
  }
  // G5.4: the restored tree must not contain FILES the manifest never
  // recorded — a tampered archive that ADDS content would otherwise restore
  // silently ("all verified" only proves the listed files, not the tree).
  // private/ is skipped: the manifest excludes it by design, so a live
  // restore-over-source tree legitimately still holds it.
  const walkRestored = (dir, relBase = "") => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const rel = relBase ? `${relBase}/${e.name}` : e.name;
      if (e.isDirectory()) {
        if (e.name === "private") continue; // never archived → never flagged
        walkRestored(path.join(dir, e.name), rel);
      }
      else if (e.isFile() && !entries.files[rel]) fail(`restored tree has an UNLISTED extra file: ${rel} (archive tampered?)`);
    }
  };
  walkRestored(dest);
  console.log(`OK  backup-artifacts: restored ${verified}/${Object.keys(entries.files).length} file(s) from ${path.basename(archive)}, all SHA-256 verified, no unlisted extras`);
  process.exit(0);
}

// ---- backup ----
const srcIdx = argv.indexOf("--src");
const SRC = path.resolve(srcIdx >= 0 ? argv[srcIdx + 1] : path.join(PROJECT, "platform-data"));
const outIdx = argv.indexOf("--out");
const OUT = outIdx >= 0 ? path.resolve(argv[outIdx + 1]) : null; // null = timestamped default below

if (!fs.existsSync(SRC) || !fs.statSync(SRC).isDirectory()) fail(`source dir not found: ${SRC}`);

const outDir = OUT ? path.dirname(OUT) : path.join(PROJECT, "backups", "artifacts");
const baseName = OUT ? path.basename(OUT, ".tar.gz") : `${new Date().toISOString().replace(/[:.]/g, "-")}-artifacts`;
fs.mkdirSync(outDir, { recursive: true });
const archive = path.join(outDir, `${baseName}.tar.gz`);

// build the file list: everything except private/ (session credentials)
const files = walk(SRC).filter((rel) => !/(^|\/)private\//.test(rel) && rel !== "private");
// tar with an explicit -T list that is genuinely NUL-delimited (G5.4 fix: the
// old code joined with "\n" while claiming to be null-delimited — a filename
// containing a newline split into two bogus entries and corrupted the backup;
// --null + NUL separators makes every name byte-safe on Linux prod. Win32
// cannot even create newline-named files, but the backend must not depend on
// that). cwd=SRC replaces -C (GNU tar on Windows mangles -C targets with
// drive letters).
const listFile = path.join(outDir, `.${baseName}.filelist`);
fs.writeFileSync(listFile, Buffer.concat(files.map((f) => Buffer.from(`./${f}\0`, "utf8"))));
const r = tar(["--null", "-czf", archive, "-T", listFile], { cwd: SRC });
fs.rmSync(listFile, { force: true });
if (r.status !== 0) fail(`tar exited ${r.status}: ${String(r.stderr).toString().slice(0, 400)}`);

// SHA-256 manifest of the tree AS BACKED UP (excludes private/), written beside the archive
const manifest = {
  created_at: new Date().toISOString(),
  source: path.relative(PROJECT, SRC) || SRC,
  archive: path.basename(archive),
  file_count: files.length,
  files: Object.fromEntries(
    files.sort().map((rel) => {
      const rec = { size: fs.statSync(path.join(SRC, rel)).size };
      rec.sha256 = sha256File(path.join(SRC, rel));
      return [rel, rec];
    })
  ),
};
const manifestPath = path.join(outDir, `${baseName}.manifest.json`);
fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), "utf8");

const archiveSha = sha256File(archive);
console.log(`OK  backup-artifacts: ${path.relative(PROJECT, archive)} (${files.length} files, sha256 ${archiveSha.slice(0, 16)}…)`);
console.log(`OK  backup-artifacts: manifest ${path.relative(PROJECT, manifestPath)} (private/ excluded by design)`);
