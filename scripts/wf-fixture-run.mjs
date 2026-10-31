// One-command field-verification harness used by the per-field subagents (and CI).
// Starts the fixture server on an ephemeral port, runs a full cloner pass against
// the icon-plus toolbar fixture, and asserts every hard guarantee of the pipeline:
//   exit 0 · index.html substantive · >=3 trigger marks · snapshot.mhtml valid
//   runtime has 6 records (5 inner modules) · clone.json mhtml wired
//   no "Too many arguments" evaluate failures in the log
// Usage: node scripts/wf-fixture-run.mjs <outDir>
import { spawn, execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const outDir = path.resolve(process.argv[2] || "output/wf-field");
const root = path.resolve(__dirname, "..");

const results = [];
const check = (name, ok, evidence = "") => {
  results.push({ name, ok, evidence });
  console.log(`  ${ok ? "PASS" : "FAIL"} ${name}${evidence ? " — " + evidence : ""}`);
  return ok;
};

// 1. fixture server on an ephemeral port
await new Promise((resolveServer) => {
  const srv = http.createServer((req, res) => {
    try {
      res.writeHead(200, { "content-type": "text/html" });
      res.end(fs.readFileSync(path.join(__dirname, "fixture-toolbar.html")));
    } catch {
      res.writeHead(404); res.end("nf");
    }
  });
  srv.listen(0, "127.0.0.1", () => {
    const port = srv.address().port;
    resolveServer({ srv, url: `http://127.0.0.1:${port}/fixture-toolbar.html` });
  });
}).then(({ srv, url }) => new Promise((resolveAll) => {
  // 2. run the cloner (fresh output dir)
  fs.rmSync(outDir, { recursive: true, force: true });
  const logFile = path.join(outDir + ".run.log");
  fs.mkdirSync(path.dirname(logFile), { recursive: true });
  const proc = spawn(process.execPath, [path.join(root, "bin/cloner.js"), url, "--no-polish", "--no-ui", "-p", "1", "-o", outDir], { cwd: root });
  let log = "";
  proc.stdout.on("data", (d) => { log += d; });
  proc.stderr.on("data", (d) => { log += d; });
  const timer = setTimeout(() => proc.kill(), 180000); // hard cap: 3 min
  proc.on("exit", async (code) => {
    clearTimeout(timer);
    srv.close();
    fs.writeFileSync(logFile, log);
    console.log(`cloner exit=${code} log=${logFile} (${log.length}B)`);

    // 3. assertions
    check("cloner exit 0", code === 0, `exit=${code}`);
    const idxPath = path.join(outDir, "index.html");
    const idx = fs.existsSync(idxPath) ? fs.readFileSync(idxPath, "utf8") : "";
    check("index.html substantive", idx.length > 5000, `${idx.length}B`);
    check("trigger marks >= 3", (idx.match(/data-cloner-trigger=/g) || []).length >= 3, `${(idx.match(/data-cloner-trigger=/g) || []).length}`);
    check("btn-icon carries title (label fix)", /btn btn-icon[^>]*title=/i.test(idx) || /<div class="btn btn-icon" title=/i.test(idx), "marked control keeps accessible label");

    const mhtmlPath = path.join(outDir, "snapshot.mhtml");
    const mhtml = fs.existsSync(mhtmlPath) ? fs.readFileSync(mhtmlPath, "utf8") : "";
    check("snapshot.mhtml exists", mhtml.length > 1000, `${mhtml.length}B`);
    check("snapshot.mhtml valid DevTools format", mhtml.includes("Snapshot-Content-Location") && mhtml.includes("MIME-Version"), "has Snapshot-Content-Location + MIME headers");
    check("snapshot.mhtml holds page content", mhtml.toLowerCase().includes("toolbar fixture"), "subject/content present");

    const rtPath = path.join(outDir, "cloner-runtime.js");
    const rt = fs.existsSync(rtPath) ? fs.readFileSync(rtPath, "utf8") : "";
    // buildRuntime writes "window.__CLONER_INTERACTIONS = <single-line JSON>;\n"
    const m = rt.match(/window\.__CLONER_INTERACTIONS = (\[.*\]);\s*$/m);
    let parsed = [];
    try { parsed = JSON.parse(m ? m[1] : "[]"); } catch {}
    check("runtime records == 6 (1 overlay + 5 inner modules)", parsed.length === 6, `${parsed.length}`);
    check("inner module captures present", parsed.some((r) => r.kind === "module" && (r.html || "").includes("Market Analyzer")), "m-records with Market Analyzer");
    check("picker overlay record present", parsed.some((r) => r.kind === "overlay" && (r.html || "").includes("data-cloner-inner")), "overlay carries inner marks");
    check("canvas snapshots in modules", parsed.filter((r) => r.kind === "module").every((r) => (r.html || "").includes("data-cloner-snap")), "canvas → img");

    const cjPath = path.join(outDir, "clone.json");
    let cj = {};
    try { cj = JSON.parse(fs.readFileSync(cjPath, "utf8")); } catch {}
    check("clone.json wires mhtml", cj.mhtml === "snapshot.mhtml", `mhtml=${cj.mhtml}`);

    check("no multi-arg evaluate failures", !log.includes("Too many arguments"), "playwright single-arg rule holds");
    check("no markTriggers failures", !log.includes("markTriggers failed"), "classify evaluate healthy");

    const fails = results.filter((r) => !r.ok);
    console.log(`\n${results.length - fails.length}/${results.length} checks passed${fails.length ? " — " + fails.map((f) => f.name).join(", ") : ""}`);
    resolveAll(fails.length === 0 ? 0 : 1);
  });
})).then((rc) => process.exit(rc));
