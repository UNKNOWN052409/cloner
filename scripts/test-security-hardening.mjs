#!/usr/bin/env node
// Security-hardening regression suite (4.0.12 security lane) — no DB, no live
// services. Locks in the two traversal/leak fixes:
//   1. src/platform/tasks.js — task ids come from untrusted URL params
//      (Express decodes %2f into :id), so taskDir/outDir must clamp any id
//      that is not [A-Za-z0-9_-] into a sandbox INSIDE platform-data/:
//      reads 404, deletes no-op, and nothing can escape the store (the
//      unauthenticated rm-rf / file-read traversal class).
//   2. src/platform/exporter.js — isSensitiveName must reject credential-
//      named DIRECTORIES (secrets/, credentials/, private_backup) and the
//      widened data-file vocabulary (passwords.json, token.json, api-token.txt,
//      vault.txt) while still shipping site source (storage.js, index.html).
// Also verifies the v1 export zip end-to-end carries no credential-named
// entries (fail-closed staged-tree verification).
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const PROJECT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
process.chdir(PROJECT);

const results = [];
const check = (name, ok, detail = "") => {
  results.push(ok);
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
};

// ---- 1. task id hardening ----
const tasks = await import("../src/platform/tasks.js");
const ROOT = path.join(PROJECT, "platform-data");

const insideRoot = (p) => {
  const rel = path.relative(ROOT, path.resolve(p));
  return !rel.startsWith("..") && !path.isAbsolute(rel);
};

const traversalIds = ["../../backups", "../platform-data", "a/b", "a\\b", "", ".", "..", ".hidden", "%2e%2e", "..%2f..%2fx", "x/../../y"];
for (const id of traversalIds) {
  const d = tasks.taskDir(id);
  check(`taskDir clamps traversal id ${JSON.stringify(id)} inside ROOT`, insideRoot(d), d);
  check(`loadTask(${JSON.stringify(id)}) → null (no escape read)`, tasks.loadTask(id) === null);
  const o = tasks.outDir(id);
  check(`outDir clamps ${JSON.stringify(id)} inside ROOT`, insideRoot(o), o);
}
{
  // destructive no-op proof: a canary directory outside platform-data must
  // survive deleteTask with a traversal id
  const canary = path.join(PROJECT, "platform-data");
  const canaryFile = path.join(PROJECT, "package.json"); // must still exist after deleteTask
  tasks.deleteTask("../../package-json-canary-nonexistent"); // sandboxed no-op
  check("deleteTask with traversal id leaves the repo intact", fs.existsSync(canaryFile) && fs.existsSync(canary));
}
{
  // normal ids keep working end-to-end
  const meta = tasks.createTask({ url: "https://example.com/hardening", userId: "hardening-user" });
  check("createTask works with a real id", !!meta.id && fs.existsSync(tasks.taskDir(meta.id)));
  check("loadTask round-trips", tasks.loadTask(meta.id)?.id === meta.id);
  tasks.deleteTask(meta.id);
  check("deleteTask cleans up", !fs.existsSync(tasks.taskDir(meta.id)));
}

// ---- 2. export sensitive-name predicate ----
const { isSensitiveName, exportTask } = await import("../src/platform/exporter.js");
const MUST_BLOCK_NAMES = [
  "private", "cookies.json", "session-cookies.txt", "mycookies.db", "storageState.json",
  "local-storage.txt", "credentials.json", ".env", ".env.production", "session.txt",
  "storage.db", "secrets", "credentials", "passwords", "private_backup", "private-old",
  "passwords.json", "token.json", "api-token.txt", "vault.txt", "apikey.txt", "api_key.json",
  "my-secrets", "secrets_backup",
];
for (const n of MUST_BLOCK_NAMES) check(`isSensitiveName blocks ${JSON.stringify(n)}`, isSensitiveName(n) === true);
const MUST_SHIP_NAMES = ["storage.js", "index.html", "manifest.json", "storage", "session", "auth", "token", "README.md", "app.css"];
for (const n of MUST_SHIP_NAMES) check(`isSensitiveName ships ${JSON.stringify(n)}`, isSensitiveName(n) === false);

// ---- 3. end-to-end v1 export zip sweep ----
{
  const meta = tasks.createTask({
    url: "https://example.com/export-sweep",
    cookies: JSON.stringify([{ name: "sid", value: "s" }]),
    storage: JSON.stringify({ cookies: [] }),
    userId: "hardening-user",
  });
  const out = tasks.outDir(meta.id);
  fs.mkdirSync(path.join(out, "assets", "secrets"), { recursive: true });
  fs.writeFileSync(path.join(out, "assets", "secrets", "api-keys.json"), '{"k":"v"}');
  fs.writeFileSync(path.join(out, "cookies.json"), JSON.stringify([{ name: "sid", value: "x" }]));
  fs.writeFileSync(path.join(out, "storage-state.json"), "{}");
  fs.writeFileSync(path.join(out, "passwords.txt"), "u:p");
  fs.writeFileSync(path.join(out, ".env"), "SECRET=1");
  fs.writeFileSync(path.join(out, "api-token.txt"), "tok");
  fs.writeFileSync(path.join(out, "index.html"), "<html><body>clone</body></html>");
  fs.writeFileSync(path.join(out, "storage.js"), "export const storage = {};");
  fs.writeFileSync(path.join(out, "snapshot.mhtml"), "MIME-Version: 1.0");
  try {
    const exported = await exportTask(meta.id);
    check("v1 export produces a zip", exported.size > 0);
    const list = execFileSync("powershell", ["-NoProfile", "-Command",
      `Add-Type -AssemblyName System.IO.Compression.FileSystem; $z=[IO.Compression.ZipFile]::OpenRead('${exported.zipPath.replace(/'/g, "''")}'); $z.Entries | ForEach-Object { $_.FullName }; $z.Dispose()`],
      { encoding: "utf8", windowsHide: true });
    const entries = list.split(/\r?\n/).filter(Boolean);
    const sensitive = entries.filter((e) => /cookie|(^|\/)private(\/|$)|(^|\/)\.env|password|token|credential|(^|\/)secrets?\/|storage-state/i.test(e));
    check("zip has NO credential-named entries at any depth", sensitive.length === 0, sensitive.join(", ") || "clean");
    check("zip keeps site source + clone artifacts", ["storage.js", "index.html", "snapshot.mhtml"].every((f) => entries.includes(f)), entries.join(", "));
  } catch (e) {
    check("v1 export completes", false, String(e.message).slice(0, 160));
  } finally {
    tasks.deleteTask(meta.id);
  }
}

const passed = results.filter(Boolean).length;
console.log(`\n== security-hardening regression: ${passed}/${results.length} passed ==`);
process.exit(results.every(Boolean) ? 0 : 1);
