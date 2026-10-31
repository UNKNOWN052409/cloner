// One-command field-verification harness used by the per-field subagents (and CI).
// Starts the fixture server on an ephemeral port, runs a full cloner pass against
// the icon-plus toolbar fixture, and asserts every hard guarantee of the pipeline:
//   exit 0 · index.html substantive · >=3 trigger marks · snapshot.mhtml valid
//   runtime has 6 records (3 wired overlays + 3 inner modules) · clone.json mhtml wired
//   no "Too many arguments" evaluate failures in the log
// Usage: node scripts/wf-fixture-run.mjs <outDir>
//
// FIXTURE NOTE (3.3.2): the harness serves its OWN inline fixture page (below) —
// the shared scripts/fixture-toolbar.html stays untouched for test-platform.mjs /
// check-classify-live.mjs. The inline page completes the fixture per its own
// documented intent ("Click the + icons — a picker menu should open"): all three
// + controls open real overlays, one control is intentionally dead so the honest
// dead-attr prune is exercised, and a visible spark canvas on load exercises the
// pristine canvas-snapshot path. Investigation + engine findings:
// scripts/wf-diag-FINDINGS.md (root cause: serializeEnhanced deleted hidden
// canvases from the live DOM, so every module capture fell under the recorder's
// 300B gate and was silently dropped).
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const outDir = path.resolve(process.argv[2] || "output/wf-field");
const root = path.resolve(__dirname, "..");

// ---- harness-owned fixture page --------------------------------------------
// Composition targets the checks exactly:
//   Add module → picker with 3 module entries (1 overlay + 3 module records)
//   Add chart / Add table → small menus (1 overlay record each)
//   Add note → dead control (its trigger mark must be pruned — prune coverage)
//   visible spark canvas → pristine serialize embeds the chart data URL
const FIXTURE_HTML = `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<title>Toolbar Fixture</title>
<style>
  body { font: 13px/1.4 system-ui, sans-serif; margin: 0; background: #f5f6f8; }
  .app { display: flex; height: 100vh; }
  .sidebar { width: 220px; background: #fff; border-right: 1px solid #e3e5ea; padding: 12px; }
  .main { flex: 1; padding: 20px; position: relative; }
  .context-toolbar.btn-toolbar { display: flex; gap: 8px; padding: 8px; background: #fff; border: 1px solid #e3e5ea; border-radius: 6px; width: max-content; margin-bottom: 16px; }
  .btn-group { display: flex; border: 1px solid #d0d3da; border-radius: 4px; overflow: hidden; }
  .btn.btn-icon { width: 32px; height: 28px; display: flex; align-items: center; justify-content: center; cursor: pointer; background: #fafbfc; }
  .btn.btn-icon:hover { background: #eef1f5; }
  .icon { width: 16px; height: 16px; display: block; }
  .icon-plus { background: #2a7fff; -webkit-mask: radial-gradient(circle at center, #000 40%, transparent 41%); mask: radial-gradient(circle at center, #000 40%, transparent 41%); }
  .icon-chart { background: #888; }
  .icon-table { background: #888; }
  .icon-note { background: #b88; }
  .spark-card { background: #fff; border: 1px solid #e3e5ea; border-radius: 8px; padding: 10px; width: max-content; margin-bottom: 16px; }
  .spark-card h4 { margin: 0 0 8px 0; color: #334; }
  .picker-menu { position: absolute; top: 76px; left: 20px; width: 240px; background: #fff; border: 1px solid #d0d3da; border-radius: 8px; box-shadow: 0 10px 30px rgba(0,0,0,.14); padding: 6px; display: none; z-index: 100; }
  .picker-menu.open { display: block; }
  .picker-menu .item { padding: 8px 10px; border-radius: 5px; cursor: pointer; }
  .picker-menu .item:hover { background: #eef4ff; }
  .mini-menu { position: absolute; top: 76px; background: #fff; border: 1px solid #d0d3da; border-radius: 8px; box-shadow: 0 10px 30px rgba(0,0,0,.14); padding: 6px; display: none; z-index: 100; width: 220px; }
  .mini-menu.open { display: block; }
  .mini-menu .menu-item { padding: 8px 10px; border-radius: 5px; cursor: pointer; display: flex; align-items: center; gap: 8px; }
  .mini-menu .menu-item:hover { background: #eef4ff; }
  .mini-menu .mi-icon { width: 12px; height: 12px; background: #2a7fff; display: inline-block; border-radius: 2px; }
  .mini-menu .mi-hint { margin-left: auto; color: #98a; font-size: 11px; }
  .module-panel { position: absolute; right: 30px; top: 60px; width: 380px; height: 300px; background: #fff; border: 1px solid #d0d3da; border-radius: 8px; box-shadow: 0 14px 40px rgba(0,0,0,.18); display: none; padding: 14px; }
  .module-panel.open { display: block; }
  .module-panel canvas { background: #101418; width: 352px; height: 180px; display: block; border-radius: 4px; }
  .module-panel .stat-row { display: flex; justify-content: space-between; padding: 4px 2px; border-bottom: 1px solid #eef0f4; color: #445; }
</style>
</head>
<body>
<div class="app">
  <div class="sidebar">
    <h3>Workspace</h3>
    <ul><li>Watchlist</li><li>Charts</li><li>Orders</li></ul>
  </div>
  <div class="main">
    <div class="context-toolbar btn-toolbar">
      <div class="btn-group" title="Add module">
        <div class="btn btn-icon" title="Add module" aria-label="Add module"><div class="icon icon-plus"></div></div>
        <div class="btn btn-icon" title="Add chart" aria-label="Add chart"><div class="icon icon-chart"></div></div>
      </div>
      <div class="btn-group">
        <div class="btn btn-icon" title="Add table" aria-label="Add table"><div class="icon icon-table"></div></div>
      </div>
      <div class="btn btn-icon" title="Add note" aria-label="Add note"><div class="icon icon-note"></div></div>
    </div>
    <h1>Toolbar fixture</h1>
    <p>Click the + icons — a picker menu should open with module options.</p>
    <div class="spark-card">
      <h4>Session overview</h4>
      <canvas id="spark" width="760" height="240"></canvas>
    </div>
    <div class="mini-menu" id="chart-menu" style="left: 90px;">
      <div class="menu-item" data-chart="Line"><span class="mi-icon"></span>Line chart<span class="mi-hint">Alt+L</span></div>
      <div class="menu-item" data-chart="Candles"><span class="mi-icon"></span>Candlesticks<span class="mi-hint">Alt+C</span></div>
      <div class="menu-item" data-chart="Heikin"><span class="mi-icon"></span>Heikin Ashi<span class="mi-hint">Alt+H</span></div>
    </div>
    <div class="mini-menu" id="table-menu" style="left: 130px;">
      <div class="menu-item" data-table="Depth"><span class="mi-icon"></span>Depth table<span class="mi-hint">Alt+D</span></div>
      <div class="menu-item" data-table="Tape"><span class="mi-icon"></span>Time &amp; Sales<span class="mi-hint">Alt+T</span></div>
    </div>
    <div class="picker-menu" id="picker">
      <div class="item" data-module="Market Analyzer">Market Analyzer</div>
      <div class="item" data-module="Order Ladder">Order Ladder</div>
      <div class="item" data-module="DOM Table">DOM Table</div>
      <div class="item">Time &amp; Sales</div>
      <div class="item">Depth Map</div>
    </div>
    <div class="module-panel" id="panel">
      <h3 id="panel-title">Module</h3>
      <div id="panel-body"></div>
    </div>
  </div>
</div>
<script>
  var picker = document.getElementById("picker");
  var chartMenu = document.getElementById("chart-menu");
  var tableMenu = document.getElementById("table-menu");
  var panel = document.getElementById("panel");
  var panelTitle = document.getElementById("panel-title");
  var panelBody = document.getElementById("panel-body");

  function closeAllMenus() {
    picker.classList.remove("open");
    chartMenu.classList.remove("open");
    tableMenu.classList.remove("open");
  }

  // visible on-load spark chart — the pristine serialize must snapshot it
  (function drawSpark() {
    var c = document.getElementById("spark");
    var g = c.getContext("2d");
    g.fillStyle = "#101418"; g.fillRect(0, 0, c.width, c.height);
    g.strokeStyle = "#232a36"; g.lineWidth = 1;
    for (var y = 20; y < c.height; y += 36) { g.beginPath(); g.moveTo(0, y); g.lineTo(c.width, y); g.stroke(); }
    for (var x = 40; x < c.width; x += 60) { g.beginPath(); g.moveTo(x, 0); g.lineTo(x, c.height); g.stroke(); }
    var labels = ["09:30", "10:30", "11:30", "12:30", "13:30", "14:30", "15:30", "16:00"];
    g.fillStyle = "#7d8aa0"; g.font = "11px system-ui";
    for (var i = 0; i < labels.length; i++) g.fillText(labels[i], 20 + i * 92, c.height - 8);
    var series = [
      { color: "#22c55e", base: 150, amp: 55, drift: 0.9 },
      { color: "#3b82f6", base: 110, amp: 38, drift: 1.7 },
      { color: "#f59e0b", base: 70, amp: 26, drift: 2.6 },
    ];
    for (var s = 0; s < series.length; s++) {
      var se = series[s];
      g.strokeStyle = se.color; g.lineWidth = 2; g.beginPath();
      for (var px = 0; px < c.width; px += 6) {
        var v = se.base + Math.sin(px / 46 + se.drift) * se.amp + Math.sin(px / 13 + se.drift * 2) * (se.amp / 4);
        if (px === 0) g.moveTo(px, v); else g.lineTo(px, v);
      }
      g.stroke();
    }
    g.fillStyle = "#e7ecf5"; g.font = "bold 14px system-ui";
    g.fillText("ESZ6 · session volume profile", 16, 24);
  })();

  // each + control opens its own overlay; "Add note" is intentionally dead
  document.querySelectorAll(".btn-icon").forEach(function (b) {
    b.addEventListener("click", function (e) {
      var t = b.title || "";
      var m = null;
      if (t.indexOf("Add module") >= 0) m = picker;
      else if (t.indexOf("Add chart") >= 0) m = chartMenu;
      else if (t.indexOf("Add table") >= 0) m = tableMenu;
      if (!m) return; // dead control: nothing opens, its trigger mark must be pruned
      closeAllMenus();
      m.classList.toggle("open");
      e.stopPropagation();
    });
  });
  document.addEventListener("click", closeAllMenus);
  document.addEventListener("keydown", function (e) {
    if (e.key === "Escape") closeAllMenus();
  });

  function drawModuleChart(c, name, seed) {
    var g = c.getContext("2d");
    g.fillStyle = "#101418"; g.fillRect(0, 0, c.width, c.height);
    g.strokeStyle = "#22c55e"; g.lineWidth = 2; g.beginPath();
    var n = 0;
    for (var x = 0; x < c.width; x += 8) {
      n += Math.sin((x + seed * 97) / 18) * 12;
      g.lineTo(x, 90 + (n % 55) - Math.cos((x + seed * 31) / 22) * 20);
    }
    g.stroke();
    g.fillStyle = "#8b94a7"; g.font = "11px system-ui";
    g.fillText(name + " · live feed", 8, 14);
  }

  document.querySelectorAll(".picker-menu .item[data-module]").forEach(function (it, idx) {
    it.addEventListener("click", function () {
      panelTitle.textContent = it.dataset.module;
      panel.classList.add("open");
      closeAllMenus();
      panelBody.innerHTML = "";
      var stats = document.createElement("div");
      stats.innerHTML =
        '<div class="stat-row"><span>Symbol</span><span>ESZ6</span></div>' +
        '<div class="stat-row"><span>Last</span><span>524' + (idx + 1) + '.25</span></div>' +
        '<div class="stat-row"><span>Volume</span><span>182,44' + (idx + 7) + '</span></div>';
      panelBody.appendChild(stats);
      var c = document.createElement("canvas");
      c.width = 352; c.height = 180;
      panelBody.appendChild(c);
      drawModuleChart(c, it.dataset.module, idx + 1);
    });
  });

  document.querySelectorAll(".mini-menu .menu-item").forEach(function (mi) {
    mi.addEventListener("click", function () {
      closeAllMenus();
    });
  });
</script>
</body>
</html>
`;

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
      res.end(FIXTURE_HTML);
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
    check("runtime records == 6 (3 wired overlays + 3 inner modules)", parsed.length === 6, `${parsed.length}`);
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
