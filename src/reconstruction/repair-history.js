// Repair history (task 3.4.5): append-only per-repair-round history + project
// snapshots for rollback.
//
// History: one JSON line per repair round in .repair/history.jsonl —
//   { ts, round, action, before, after, kept, reason }
// JSONL (not a rewritten JSON array) keeps the file strictly append-only: a
// crash mid-append loses nothing already written, and entries are greppable.
//
// Snapshots: before each repair round the executor snapshots the mutation
// surface — index.html + the styles/ tree + clone-fixes.css when present —
// into .repair/snapshots/round-NNN/ with a manifest.json. restoreSnapshot()
// copies files back, DELETES files that were absent at snapshot time (e.g. a
// clone-fixes.css the failed round created) and replaces mutated directories,
// so a reverted round leaves the project byte-identical to its pre-round state.
import fs from "node:fs";
import path from "node:path";

// snapshot surface: the executor only ever mutates index.html, styles/ and
// clone-fixes.css (asset remaps + attr pruning edit index.html in place; CSS
// repairs append to clone-fixes.css), so copying those covers full rollback.
export const DEFAULT_SNAPSHOT_FILES = Object.freeze(["index.html"]);
export const DEFAULT_SNAPSHOT_DIRS = Object.freeze(["styles"]);
export const DEFAULT_SNAPSHOT_EXTRA = Object.freeze(["clone-fixes.css"]);

// snapshotProject(projectDir, snapshotDir, opts?) → { dir, files, dirs, manifest }
// opts: { files?, dirs?, extra? } — relative paths inside projectDir.
export function snapshotProject(projectDir, snapshotDir, opts = {}) {
  const files = opts.files ?? DEFAULT_SNAPSHOT_FILES;
  const dirs = opts.dirs ?? DEFAULT_SNAPSHOT_DIRS;
  const extra = opts.extra ?? DEFAULT_SNAPSHOT_EXTRA;
  fs.mkdirSync(snapshotDir, { recursive: true });
  const manifest = {
    createdAt: new Date().toISOString(),
    projectDir,
    files: [],   // existed at snapshot time → restored on rollback
    absent: [],  // did NOT exist → deleted on rollback (undo a round's creation)
    dirs: [],    // directory trees → replaced wholesale on rollback
    missingDirs: [],
  };
  for (const rel of [...files, ...extra]) {
    const src = path.join(projectDir, rel);
    if (fs.existsSync(src)) {
      const dest = path.join(snapshotDir, rel);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.cpSync(src, dest, { recursive: true });
      manifest.files.push(rel);
    } else {
      manifest.absent.push(rel);
    }
  }
  for (const rel of dirs) {
    const src = path.join(projectDir, rel);
    if (fs.existsSync(src) && fs.statSync(src).isDirectory()) {
      fs.cpSync(src, path.join(snapshotDir, rel), { recursive: true });
      manifest.dirs.push(rel);
    } else {
      manifest.missingDirs.push(rel);
    }
  }
  fs.writeFileSync(path.join(snapshotDir, "manifest.json"), JSON.stringify(manifest, null, 2));
  return { dir: snapshotDir, files: manifest.files, dirs: manifest.dirs, manifest };
}

// restoreSnapshot(projectDir, snapshotDir) → { restored, removed }
// Rolls the project back to the snapshot's state (see module header).
export function restoreSnapshot(projectDir, snapshotDir) {
  const manifest = JSON.parse(fs.readFileSync(path.join(snapshotDir, "manifest.json"), "utf8"));
  const restored = [];
  const removed = [];
  // files created since the snapshot must disappear again
  for (const rel of manifest.absent) {
    const target = path.join(projectDir, rel);
    if (fs.existsSync(target)) {
      fs.rmSync(target, { recursive: true, force: true });
      removed.push(rel);
    }
  }
  for (const rel of manifest.files) {
    const target = path.join(projectDir, rel);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.cpSync(path.join(snapshotDir, rel), target, { recursive: true });
    restored.push(rel);
  }
  for (const rel of manifest.dirs) {
    const target = path.join(projectDir, rel);
    if (fs.existsSync(target)) fs.rmSync(target, { recursive: true, force: true });
    fs.cpSync(path.join(snapshotDir, rel), target, { recursive: true });
    restored.push(rel + "/");
  }
  return { restored, removed };
}

// appendHistory(historyPath, entry) → entry — appends one JSON line (plus a ts
// timestamp). Never rewrites the file; creates the parent dir on first append.
export function appendHistory(historyPath, entry) {
  fs.mkdirSync(path.dirname(historyPath), { recursive: true });
  fs.appendFileSync(historyPath, JSON.stringify({ ts: new Date().toISOString(), ...entry }) + "\n");
  return entry;
}

// readHistory(historyPath) → entry[] — parses the JSONL history (blank-tolerant,
// missing file → []).
export function readHistory(historyPath) {
  let text = "";
  try {
    text = fs.readFileSync(historyPath, "utf8");
  } catch {
    return [];
  }
  return text.split("\n").filter((line) => line.trim()).map((line) => JSON.parse(line));
}
