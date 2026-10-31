#!/usr/bin/env node
// Self-contained platform e2e (spec §6/§10/§11).
//   Phase 1 — unit: exporter credential exclusion. Plants fake cookie/storage files
//             (incl. a nested private/ dir) inside out/ and asserts the staged tree
//             excludes them while legit assets survive; asserts docs/INSPECTION.md
//             is generated from exploration.md.
//   Phase 2 — e2e: boots its own fixture server + the platform on EPHEMERAL ports,
//             POSTs a task, polls to done (120s cap), asserts artifacts + the three
//             verification stages, exports, and asserts the ZIP holds no private/
//             or credential-named entries. private/ must be shredded afterwards.
// Prints PASS/FAIL lines, exits nonzero on any failure, closes everything it opened.
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";

const PROJECT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
process.chdir(PROJECT); // platform-data + cloner.config.json + scripts/* are cwd-relative
// dynamic imports AFTER chdir — tasks.js pins ROOT to process.cwd() at module load
const tasks = await import("../src/platform/tasks.js");
const { startPlatform } = await import("../src/platform/server.js");
const { stageClean, isSensitiveName } = await import("../src/platform/exporter.js");

const SCRIPTS = path.dirname(fileURLToPath(import.meta.url));
const results = [];
const check = (name, ok, detail = "") => {
  results.push(ok);
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const exists = (p) => fs.existsSync(p);

async function api(port, method, p, body) {
  const res = await fetch(`http://127.0.0.1:${port}${p}`, {
    method,
    headers: body ? { "content-type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}
  return { status: res.status, json, text };
}

// fixture server — same pattern as scripts/serve-fixture.mjs, but on an ephemeral port
function startFixture() {
  return new Promise((resolve, reject) => {
    const srv = http.createServer((req, res) => {
      const rel = decodeURIComponent(req.url.split("?")[0]).replace(/^\//, "") || "fixture-toolbar.html";
      const file = path.join(SCRIPTS, rel);
      try {
        const body = fs.readFileSync(file);
        res.writeHead(200, { "content-type": file.endsWith(".css") ? "text/css" : "text/html" });
        res.end(body);
      } catch { res.writeHead(404); res.end("not found"); }
    });
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => resolve(srv));
  });
}

function walkFiles(dir, base = dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walkFiles(p, base));
    else out.push(path.relative(base, p).split(path.sep).join("/"));
  }
  return out;
}

function listZipEntries(zipPath) {
  const q = (s) => s.replace(/'/g, "''");
  return new Promise((resolve, reject) => {
    if (process.platform === "win32") {
      const ps = `Add-Type -AssemblyName System.IO.Compression.FileSystem;$z=[IO.Compression.ZipFile]::OpenRead('${q(zipPath)}');$z.Entries | ForEach-Object { $_.FullName };$z.Dispose()`;
      execFile("powershell", ["-NoProfile", "-NonInteractive", "-Command", ps], { timeout: 60000, windowsHide: true },
        (err, stdout) => (err ? reject(err) : resolve(stdout.split(/\r?\n/).map((s) => s.trim()).filter(Boolean))));
    } else {
      execFile("unzip", ["-Z1", zipPath], { timeout: 60000 },
        (err, stdout) => (err ? reject(err) : resolve(stdout.split(/\r?\n/).filter(Boolean))));
    }
  });
}

const watchdog = setTimeout(() => { console.log("FAIL  global timeout (240s)"); process.exit(1); }, 240_000);
watchdog.unref();

let fixture = null, platform = null;
try {
  // ---------- PHASE 1: exporter unit test — credential exclusion from the staged tree ----------
  const unit = tasks.createTask({ url: "http://unit.test/page", instructions: "exporter unit fixture" });
  try {
    const out = tasks.outDir(unit.id);
    fs.mkdirSync(path.join(out, "assets", "nested", "deep"), { recursive: true });
    fs.mkdirSync(path.join(out, "assets", "lib"), { recursive: true });
    fs.mkdirSync(path.join(out, "private", "session"), { recursive: true }); // private/ nested in out/
    fs.writeFileSync(path.join(out, "index.html"), "<html><body>unit fixture</body></html>");
    // the fake cookie files the exporter must never ship (top-level AND deeply nested)
    fs.writeFileSync(path.join(out, "cookies.json"), '[{"name":"sid","value":"FAKE-SECRET"}]');
    fs.writeFileSync(path.join(out, "assets", "nested", "deep", "session-storage.json"), '{"token":"FAKE"}');
    fs.writeFileSync(path.join(out, "local-storage.txt"), "FAKE");
    // legit site assets that MUST survive (incl. a source file named storage.js)
    fs.writeFileSync(path.join(out, "assets", "app.js"), "console.log('app')");
    fs.writeFileSync(path.join(out, "assets", "lib", "storage.js"), "export const store = {}");

    let stagedFiles = walkFiles(stageClean(unit.id));
    const has = (f) => stagedFiles.includes(f);
    check("unit: planted cookies.json at out/ root is excluded", !stagedFiles.some((f) => /cookie/i.test(f)));
    check("unit: nested session-storage.json is excluded", !has("assets/nested/deep/session-storage.json"));
    check("unit: nested private/ directory is excluded", !stagedFiles.some((f) => f.split("/").includes("private")));
    check("unit: local-storage.txt is excluded", !has("local-storage.txt"));
    check("unit: legit clone files survive (index.html, assets/app.js, assets/lib/storage.js)",
      has("index.html") && has("assets/app.js") && has("assets/lib/storage.js"));
    check("unit: docs/INSPECTION.md generated (stub when no exploration.md)",
      has("docs/INSPECTION.md") && fs.readFileSync(path.join(tasks.taskDir(unit.id), "export-staging", "docs", "INSPECTION.md"), "utf8").includes("No exploration report"));

    // with exploration.md present, INSPECTION.md must embed it
    fs.writeFileSync(path.join(out, "exploration.md"), "# Exploration\n\nMARKER-EXPL-UNIT-7F3A — the only control (Open panel) opens an overlay.");
    stagedFiles = walkFiles(stageClean(unit.id));
    const inspect = fs.readFileSync(path.join(tasks.taskDir(unit.id), "export-staging", "docs", "INSPECTION.md"), "utf8");
    check("unit: docs/INSPECTION.md embeds exploration.md when present", inspect.includes("MARKER-EXPL-UNIT-7F3A"));
  } finally {
    tasks.deleteTask(unit.id); // unit fixture never lingers
  }

  // ---------- PHASE 2: full platform e2e on ephemeral ports ----------
  fixture = await startFixture();
  const fixturePort = fixture.address().port;
  platform = (await startPlatform({ port: 0 })).server; // startPlatform resolves { server, wss, port }
  const port = platform.address().port; // real bound port (requested 0 = ephemeral)
  console.log(`fixture on :${fixturePort} · platform on :${port}`);

  const created = await api(port, "POST", "/api/tasks", { url: `http://127.0.0.1:${fixturePort}/fixture-toolbar.html`, pipeline: "v2" });
  check("e2e: task accepted (201-ish, id returned)", created.status === 200 && !!created.json?.id, `status ${created.status}`);
  check("e2e: per-user stub stored (userId=local)", created.json?.userId === "local", `userId=${created.json?.userId}`);
  const id = created.json?.id;

  // poll to done — 120s cap
  const deadline = Date.now() + 120_000;
  let meta = created.json;
  while (Date.now() < deadline && !["done", "error", "exported"].includes(meta?.status)) {
    await sleep(1000);
    meta = (await api(port, "GET", `/api/tasks/${id}`)).json;
  }
  check("e2e: task reached done within 120s", meta?.status === "done", `status=${meta?.status} ${meta?.error ? "error=" + meta.error : ""}`);

  // artifacts — the five named in the spec, plus the files on disk
  const art = meta?.artifacts || {};
  const needArt = ["index", "snapshot", "exploration", "design-tokens", "cloner-runtime"];
  check("e2e: artifacts recorded (index/snapshot/exploration/design-tokens/cloner-runtime)",
    needArt.every((k) => !!art[k]), needArt.map((k) => `${k}:${art[k] ? "y" : "MISSING"}`).join(" "));
  const outDirPath = tasks.outDir(id);
  const needFiles = ["index.html", "snapshot.mhtml", "exploration.md", "design-tokens.json", "cloner-runtime.js"];
  check("e2e: artifact files exist in out/", needFiles.every((f) => exists(path.join(outDirPath, f))));

  // three-step verification
  const stages = meta?.verification?.stages || [];
  check("e2e: verification has 3 stages (functional/optimization-completeness/visual)",
    stages.length === 3 && stages.every((s) => typeof s.passed === "boolean"),
    stages.map((s) => `${s.stage}:${s.passed ? "pass" : "fail"}`).join(" "));

  // export
  const exp = await api(port, "POST", `/api/export/${id}`);
  const zipPath = path.join(tasks.taskDir(id), "export.zip");
  check("e2e: export succeeded (ok:true, size>0, zip on disk)", exp.status === 200 && exp.json?.ok === true && exp.json?.size > 0 && exists(zipPath),
    exp.status === 200 ? `size=${exp.json?.size}` : (exp.json?.error || exp.text).slice(0, 160));

  // zip contents — no private/, no credential-named entries, INSPECTION.md shipped
  const entries = await listZipEntries(zipPath);
  const offenders = entries.filter((e) => e.split(/[\\/]/).some((seg) => seg && isSensitiveName(seg)));
  check("e2e: zip contains zero private/ or credential-named entries", offenders.length === 0,
    offenders.length ? offenders.join(", ") : `${entries.length} entries scanned`);
  check("e2e: zip entry names are portable (forward slashes)", !entries.some((e) => e.includes("\\")));
  check("e2e: zip ships index.html and docs/INSPECTION.md", entries.includes("index.html") && entries.includes("docs/INSPECTION.md"));
  check("e2e: private/ shredded from task dir after export", !exists(path.join(tasks.taskDir(id), "private")));
} catch (e) {
  check("e2e: no unexpected crash", false, String(e?.stack || e).split("\n")[0]);
} finally {
  // close everything we opened
  if (fixture) { fixture.closeAllConnections?.(); await new Promise((r) => fixture.close(r)); }
  if (platform) { platform.closeAllConnections?.(); await new Promise((r) => platform.close(r)); }
}

const fails = results.filter((r) => !r).length;
console.log(`\n${fails ? "RESULT: FAIL" : "RESULT: PASS"}  (${results.length - fails}/${results.length} checks passed)`);
process.exit(fails ? 1 : 0);
