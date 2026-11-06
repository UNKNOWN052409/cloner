// Export system: package a finished task's clone into a ZIP, securely.
// - Session files (cookies/storage) and anything under private/ are NEVER included —
//   filtered recursively at copy time AND re-verified on the staged tree before zipping
//   (fail-closed: the export aborts rather than risk leaking credentials, spec §10/§11).
// - A generated docs/INSPECTION.md ships in every export (from exploration.md when present).
// - After a successful export the session files are shredded (spec §10).
// - ZIP via PowerShell Compress-Archive (Windows primary); non-Windows uses `zip`;
//   any zip failure surfaces as one clear, actionable error instead of a raw crash.
import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { taskDir, outDir, loadTask, updateTask, purgeCredentials } from "./tasks.js";
import { verifyArtifactIntegrity } from "../storage/artifact-lifecycle.js";

// v2 pipeline export: exploration artifacts + the reconstructed project tree.
// The clone lives in the SIBLING <jobId>-project/ dir — staged under project/
// so the ZIP carries both evidence and the runnable site. Uses makeZip (same
// portable entry-name rewriting as the v1 flow) and ships docs/INSPECTION.md.
function v2TaskDir(id) { return path.join(process.cwd(), "artifacts", id); }

export async function exportV2Task(id) {
  const v2Dir = v2TaskDir(id);
  const projectDir = v2Dir + "-project";
  const manifestFile = path.join(v2Dir, "manifest.json");
  if (!fs.existsSync(manifestFile)) throw new Error("not a v2 exploration job (manifest.json missing)");
  if (!fs.existsSync(path.join(projectDir, "index.html"))) throw new Error("v2 project dir missing (no -project/index.html) — reconstruction did not run");
  // G5.4 fail-closed: when the job dir carries an integrity manifest, the tree
  // on disk must still match it byte-for-byte (size + sha256) before anything
  // is zipped or shredded. A modified/missing/extra file refuses the export.
  const integrity = verifyArtifactIntegrity(v2Dir);
  if (!integrity.ok) {
    const bad = [
      ...integrity.missing.map((m) => `missing:${m}`),
      ...integrity.modified.map((m) => `modified:${m}`),
      ...integrity.extra.map((m) => `extra:${m}`),
    ].slice(0, 8).join(", ");
    throw new Error(`artifact integrity check failed (${bad}) — export refused; fix the tree or re-record it with writeIntegrityManifest`);
  }
  const staging = path.join(v2Dir, "export-staging");
  fs.rmSync(staging, { recursive: true, force: true });
  fs.mkdirSync(staging, { recursive: true });
  const copyDir = (from, to) => {
    for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
      // auth/ + auth-sessions/ hold the job's session state (storageState) —
      // session material never ships in an export; verifyStagedTree below stays
      // the fail-closed backstop for anything else credential-shaped.
      if (entry.name === "private" || entry.name === "export-staging" || entry.name === "node_modules" || entry.name === "auth" || entry.name === "auth-sessions") continue;
      const src = path.join(from, entry.name);
      const dst = path.join(to, entry.name);
      if (entry.isDirectory()) { fs.mkdirSync(dst, { recursive: true }); copyDir(src, dst); }
      else fs.copyFileSync(src, dst);
    }
  };
  copyDir(v2Dir, staging);
  fs.mkdirSync(path.join(staging, "project"), { recursive: true });
  copyDir(projectDir, path.join(staging, "project"));
  verifyStagedTree(staging); // fail-closed: no credential-shaped entries reach the zip
  // inspection guide — quickstart points at the reconstructed project
  const explPath = path.join(v2Dir, "exploration.md");
  const expl = fs.existsSync(explPath) ? fs.readFileSync(explPath, "utf8") : null;
  fs.mkdirSync(path.join(staging, "docs"), { recursive: true });
  fs.writeFileSync(
    path.join(staging, "docs", "INSPECTION.md"),
    `# Inspection guide\n\nTask: ${id} · Generated ${new Date().toISOString()}\n\n` +
    `## Quick start\n\n1. Open \`project/index.html\` in a browser — the reconstructed editable site (design tokens + component styles + replay runtime).\n` +
    `2. \`styles/tokens.css\` holds the measured design tokens; \`runtime/interactions.js\` replays the recorded controls.\n` +
    `3. \`pages/\`, \`states/\` and \`reports/\` hold the exploration evidence this clone was built from.\n\n` +
    `## Interaction report\n\n` +
    (expl
      ? `Recorded from the live site during exploration — every documented control, its trigger and the captured UI states:\n\n${expl}`
      : `No exploration report was produced for this task (the page exposed no safe interactions to record).`),
  );
  const zipPath = path.join(v2Dir, "export.zip");
  fs.rmSync(zipPath, { force: true });
  try {
    await makeZip(staging, zipPath);
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
  }
  const zst = fs.existsSync(zipPath) ? fs.statSync(zipPath) : null;
  if (!zst || !zst.isFile() || zst.size === 0) throw new Error("ZIP failed — no archive was produced");
  return { zipPath, size: zst.size };
}

// code/asset extensions — a site's own source named "storage.js" must survive the export
const CODE_FILE = /\.(js|mjs|cjs|ts|jsx|tsx|css|html?|mhtml|svg|woff2?|ttf|eot|png|jpe?g|gif|webp|avif|ico|map)$/i;
// data extensions that CAN hold session state when the name says so (spec §11)
const SESSIONY_EXT = /\.(json|txt|db|sqlite3?|dat|log|xml|ya?ml|ini|cfg|state)$/i;

// credential/session-named entry — checked at EVERY depth of the staged tree:
//  - any "private" (or staging) dir name — defense in depth
//  - any basename mentioning cookies (cookies.json, session-cookies.txt, mycookies.db …)
//  - storage/session/credential/secret naming on data files (storageState.json,
//    local-storage.txt, credentials.json …) — site source (storage.js) is exempt
export function isSensitiveName(name) {
  const n = name.toLowerCase();
  if (n === "private" || n === "export-staging") return true;
  if (/^private([-_. ]|$)/.test(n)) return true; // private/, private_backup, private-old …
  if (n.includes("cookie")) return true;
  // credential-shaped DIRECTORY names ship their whole subtree — block the
  // strong vocabulary regardless of extension (a "secrets/" or "credentials/"
  // folder is a credential store even when its children are .json/.txt/…).
  // Weak tokens (auth, token, storage, session) stay legal as directory names:
  // real sites serve /auth/ or /token/ route dirs (high false-positive risk).
  const hasFileExt = /\.[a-z0-9]+$/.test(n);
  if (!hasFileExt && /(^|[-_. ])(secret|credential|password|passwd|vault|private)(s|[-_. ]|$)/.test(n)) return true;
  if (CODE_FILE.test(n)) return false; // site source/assets are never credentials
  if (n === ".env" || n.startsWith(".env.")) return true;
  // "design-tokens.json" (measured colors/fonts/spacing) is a DESIGN artifact,
  // not auth material — allowlist it ahead of the weak "token" vocabulary,
  // whose substring match otherwise false-positives on "design-tokens".
  if (/(^|[-_. ])design[-_. ]tokens?($|\.)/.test(n)) return false;
  // data files whose NAME announces session/credential material — vocabulary
  // widened beyond storage/session/credential/secret: passwords.json,
  // token.json, api-token.txt, vault.txt … (data-file extensions only)
  if (/password|passwd|token|apikey|api-key|api_key|vault/.test(n) && SESSIONY_EXT.test(n)) return true;
  return /storage|session|credential|secret/.test(n) && SESSIONY_EXT.test(n);
}

// fail-closed: refuse to zip if anything credential-shaped reached the staged tree
function verifyStagedTree(staged) {
  const offenders = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (isSensitiveName(e.name)) { offenders.push(path.relative(staged, p)); continue; }
      if (e.isDirectory()) walk(p);
    }
  };
  walk(staged);
  if (offenders.length) throw new Error(`export aborted — credential/session-named entries in staging: ${offenders.join(", ")}`);
}

export function stageClean(id) {
  const staged = path.join(taskDir(id), "export-staging");
  fs.rmSync(staged, { recursive: true, force: true });
  fs.mkdirSync(staged, { recursive: true });
  const copy = (from, to) => {
    for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
      if (isSensitiveName(entry.name)) continue;
      const f = path.join(from, entry.name);
      const t = path.join(to, entry.name);
      if (entry.isDirectory()) { fs.mkdirSync(t, { recursive: true }); copy(f, t); }
      else fs.copyFileSync(f, t);
    }
  };
  copy(outDir(id), staged);
  // docs/INSPECTION.md — generated inspection guide; embeds the exploration report when present
  fs.mkdirSync(path.join(staged, "docs"), { recursive: true });
  const explPath = path.join(outDir(id), "exploration.md");
  const expl = fs.existsSync(explPath) ? fs.readFileSync(explPath, "utf8") : null;
  fs.writeFileSync(
    path.join(staged, "docs", "INSPECTION.md"),
    `# Inspection guide\n\n` +
    `Task: ${id} · Source: ${loadTask(id)?.url || "unknown"} · Generated ${new Date().toISOString()}\n\n` +
    `## Quick start\n\n` +
    `1. Open \`index.html\` in a browser — the static full-page clone.\n` +
    `2. Open \`snapshot.mhtml\` in Chrome/Edge — the pixel-exact original (DevTools-grade capture).\n` +
    `3. Compare side by side; \`_reference/\` holds the original screenshots and verification report.\n\n` +
    `## Interaction report\n\n` +
    (expl
      ? `Recorded from the live site during cloning — every documented control, its trigger and the captured UI states:\n\n${expl}`
      : `No exploration report was produced for this task (the page exposed no safe interactions to record).`),
  );
  // top-level task artifacts (exploration report, clone.json live in out/ already)
  const meta = loadTask(id);
  fs.writeFileSync(
    path.join(staged, "README.md"),
    `# Clone export — ${meta.url}\n\nGenerated ${new Date().toISOString()} by the cloner platform.\n\n` +
    `- index.html — static full-page clone (open directly)\n` +
    `- docs/INSPECTION.md — how to inspect: quickstart + the recorded interaction report\n` +
    (meta.artifacts?.mhtml ? `- snapshot.mhtml — DevTools-grade exact capture of the original\n` : "") +
    (meta.artifacts?.exploration ? `- exploration.md — every documented interaction + state screenshots\n` : "") +
    (meta.artifacts?.["design-tokens"] || meta.artifacts?.designTokens ? `- design-tokens.json — measured colors/typography/spacing of the live site\n` : "") +
    (meta.artifacts?.scaffold ? `- scaffold/ — framework scaffold preserving the detected stack (npm install && npm run dev)\n` : "") +
    (meta.artifacts?.comparison ? `- out/_reference/comparison.txt — original vs clone comparison report\n` : "") +
    `\nAssets in assets/ include the site's own JS/CSS/fonts/images/data downloaded during cloning.\n` +
    `\nNote: this export contains no credentials or session files by design.\n`,
  );
  verifyStagedTree(staged);
  return staged;
}

export async function exportTask(id) {
  const meta = loadTask(id);
  if (!meta) throw new Error("task not found");
  const staged = stageClean(id);
  const zipPath = path.join(taskDir(id), "export.zip");
  try {
    fs.rmSync(zipPath, { recursive: true, force: true }); // tolerate residue at that path (dir or file)
    await makeZip(staged, zipPath);
  } finally {
    fs.rmSync(staged, { recursive: true, force: true });
  }
  // post-zip validation: a real, non-empty FILE (Compress-Archive may otherwise
  // treat an existing directory as DestinationPath and "succeed" into it)
  const zst = fs.existsSync(zipPath) ? fs.statSync(zipPath) : null;
  if (!zst || !zst.isFile() || zst.size === 0) throw new Error("ZIP failed — no archive was produced");
  // credential cleanup — session files are gone the moment the export exists (spec §10)
  purgeCredentials(id);
  updateTask(id, { status: "exported", artifacts: { ...(meta.artifacts || {}), exportZip: "export.zip" } }, "exported (credentials shredded)");
  return { zipPath, size: fs.statSync(zipPath).size };
}

// Windows PowerShell Compress-Archive is primary; other platforms use `zip`.
// Compress-Archive (PS 5.1) stores entry names with backslashes — not portable —
// so the same command rewrites every entry name to forward slashes before closing.
// Failures surface as ONE clear error (with the tool's output) — never a raw crash.
function makeZip(staged, zipPath) {
  const q = (s) => s.replace(/'/g, "''"); // PowerShell single-quote escape
  const win = process.platform === "win32";
  const cmd = win ? "powershell" : "zip";
  const args = win
    ? [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        [
          `Compress-Archive -Path '${q(staged)}\\*' -DestinationPath '${q(zipPath)}' -Force`,
          "Add-Type -AssemblyName System.IO.Compression.FileSystem",
          `$z=[IO.Compression.ZipFile]::Open('${q(zipPath)}','Update')`,
          `foreach($e in @($z.Entries | Where-Object { $_.FullName.Contains('\\') })){`,
          "$n=$z.CreateEntry($e.FullName.Replace('\\','/'))",
          "$s=$e.Open();$d=$n.Open();$s.CopyTo($d);$d.Dispose();$s.Dispose()",
          "$n.LastWriteTime=$e.LastWriteTime;$e.Delete()}",
          "$z.Dispose()",
        ].join("; "),
      ]
    : ["-r", "-q", zipPath, "."];
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { cwd: staged, timeout: 120000, windowsHide: true }, (err, _stdout, stderr) => {
      if (err) {
        const detail = [err.message, String(stderr || "")].filter(Boolean).join(" — ").slice(0, 400);
        reject(new Error(win
          ? `ZIP failed (PowerShell Compress-Archive): ${detail}`
          : `ZIP failed ('zip' missing or errored — install zip; on Windows PowerShell Compress-Archive is used automatically): ${detail}`));
      } else resolve();
    });
  });
}
