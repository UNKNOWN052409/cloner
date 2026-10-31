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
  if (n.includes("cookie")) return true;
  if (CODE_FILE.test(n)) return false; // site source/assets are never credentials
  if (n === ".env" || n.startsWith(".env.")) return true;
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
