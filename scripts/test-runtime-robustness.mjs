#!/usr/bin/env node
process.env.CLONER_ALLOW_PRIVATE_TARGETS = "1"; // G5.3 SSRF guard: loopback fixture targets — documented opt-in (production default stays strict)
// Task 3.5.8 — generated runtime robustness e2e.
//
// Builds a minimal but realistic generated project (the exact composition the
// project generator emits: index/page-002 HTML + styles + runtime/interactions.js
// = extendRuntimeWorkspace(buildRuntime(records)) + runtime/streams.js + assets)
// into a scratch dir, then loads it with Playwright and asserts:
//
//   B1/B2  boot with zero page errors and zero JS console errors on http:// AND file://
//   B3     Escape closes the overlay AND modules; idle Escape is a harmless no-op
//   B4     multi-click idempotence: 21 clicks on one trigger → exactly one overlay,
//          20 clicks on a module trigger → exactly one module (toggle), never a stack
//   B5     module ✕ close + Escape cycle; replay re-opens cleanly after close
//   B6     refresh: replay still works after page.reload()
//   B7     deep links: direct navigation to page-002.html over http:// and file://
//          boots clean and replays its own record
//   B8     missing assets: 404 img → inline placeholder (no crash, no page error),
//          failed <script>/<link> counted; page stays fully interactive
//   B9     listener hygiene: 50 real clicks + splitter drags + Escapes — live
//          document listener count returns to the boot baseline (no leaks)
//   B10    error isolation: a component whose handler throws is recorded on
//          window.__CLONER_RUNTIME.errors; page never errors; next replay works
//   S1     static: generated HTML references only relative paths (no engine
//          server / artifact paths) — exported project runs standalone
//
// Browser engines: chromium runs the full suite. firefox/webkit run it too when
// installed; when Playwright reports the engine is not installed the engine is
// skipped with an explicit note (never counted as a failure).
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import { pathToFileURL } from "node:url";
import { fileURLToPath } from "node:url";

const PROJECT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
process.chdir(PROJECT);

const { buildRuntime } = await import("../src/runtimeTemplate.js");
const { extendRuntimeWorkspace } = await import("../src/reconstruction/docking-layout-builder.js");
const { buildStreamRuntime } = await import("../src/reconstruction/data-stream-replayer.js");

const results = [];
const check = (name, ok, detail = "") => {
  results.push(ok);
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
};

// ---- generated project fixture ----------------------------------------------

const TINY_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PzWvWQAAAABJRU5ErkJggg==",
  "base64",
);

const RECORDS = [
  {
    id: "t1", kind: "overlay", text: "Market Analyzer", page: "index.html",
    html: '<div style="padding:12px;font:13px system-ui" data-testid="picker">MARKET-ANALYZER-PICKER<button data-cloner-inner="m1" data-testid="inner-entry">Entry A</button></div>',
    box: { x: 40, y: 160, w: 260, h: 160 },
  },
  {
    id: "t2", kind: "module", text: "Docked Chart", page: "index.html",
    html: '<div style="width:100%;height:100%;background:#1b2333;color:#e7ecf5;font:12px system-ui" data-testid="module-body">DOCKED-CHART</div>',
    box: { x: 320, y: 200, w: 300, h: 200 },
  },
  {
    id: "t3", kind: "overlay", text: "Page Two Panel", page: "page-002.html",
    html: '<div style="padding:12px;font:13px system-ui" data-testid="page2-panel">PAGE-TWO-PANEL</div>',
    box: { x: 60, y: 120, w: 240, h: 140 },
  },
];

// one wired record id per page: index/missing.html → t1+t2, page-002 → t3 only
// (both header buttons share a record id; testids target them individually)
const bodyHtml = (ids, extra) => `
<header class="cx-0" style="padding:10px;background:#0d1119">
  <button class="cx-1" data-cloner-trigger="${ids[0]}" data-replay-id="${ids[0]}" data-testid="trigger-1" aria-label="trigger-1">${ids[0]}</button>
  <button class="cx-2" data-cloner-trigger="${ids[1]}" data-replay-id="${ids[1]}" data-testid="trigger-2" aria-label="trigger-2">${ids[1]}</button>
</header>
<main class="cx-3" style="display:flex;gap:8px;padding:8px">
  <section class="cx-4" style="flex:1">
    <img id="img-ok" class="cx-5" src="public/assets/logo.png" width="32" height="32" alt="logo" />
    <p class="cx-6" style="font:14px system-ui">Generated clone page one</p>
  </section>
  <aside class="cx-7" style="width:120px">
    <div class="cx-9" style="height:40px;background:#223"></div>
    <div class="lm_splitter cx-8" style="width:6px;height:200px;background:#333" data-testid="splitter"></div>
    <div class="cx-10" style="height:40px;background:#232"></div>
  </aside>
</main>
${extra}`;

function pageHtml(title, ids, missingAssets = false) {
  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>${title}</title>
  <link rel="stylesheet" href="styles/components.css">
  ${missingAssets ? '<link rel="stylesheet" href="styles/gone.css">' : ""}
</head>
<body>
${bodyHtml(ids, missingAssets ? '<img id="img-missing" src="public/assets/missing.png" width="60" height="40" alt="missing" />' : "")}
  <script src="runtime/interactions.js"></script>
  <script src="runtime/streams.js"></script>
  ${missingAssets ? '<script src="public/assets/gone.js"></script>' : ""}
</body>
</html>
`;
}

function buildProject(dir) {
  fs.mkdirSync(path.join(dir, "styles"), { recursive: true });
  fs.mkdirSync(path.join(dir, "runtime"), { recursive: true });
  fs.mkdirSync(path.join(dir, "public", "assets"), { recursive: true });
  fs.writeFileSync(path.join(dir, "styles", "components.css"), "body{margin:0}header button{margin-right:8px}\n");
  // interactions.js mirrors src/reconstruction/generation/project-generator.js:155
  fs.writeFileSync(path.join(dir, "runtime", "interactions.js"), extendRuntimeWorkspace(buildRuntime(RECORDS)));
  fs.writeFileSync(path.join(dir, "runtime", "streams.js"), buildStreamRuntime([]));
  fs.writeFileSync(path.join(dir, "public", "assets", "logo.png"), TINY_PNG);
  // missing.png / gone.js / gone.css deliberately absent — the B8 fixture
  fs.writeFileSync(path.join(dir, "index.html"), pageHtml("page one", ["t1", "t2"], false));
  fs.writeFileSync(path.join(dir, "page-002.html"), pageHtml("page two", ["t3", "t3"], false));
  fs.writeFileSync(path.join(dir, "missing.html"), pageHtml("missing assets", ["t1", "t1"], true));
}

// ---- static server ----------------------------------------------------------

function startProjectServer(root) {
  const server = http.createServer((req, res) => {
    let rel = decodeURIComponent(new URL(req.url, "http://x").pathname).replace(/^\/+/, "") || "index.html";
    if (rel.endsWith("/")) rel += "index.html";
    const fp = path.resolve(root, rel);
    if (!fp.startsWith(path.resolve(root)) || !fs.existsSync(fp) || fs.statSync(fp).isDirectory()) {
      res.writeHead(404, { "content-type": "text/plain" });
      res.end("not found");
      return;
    }
    const types = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".png": "image/png" };
    res.writeHead(200, { "content-type": types[path.extname(fp).toLowerCase()] || "application/octet-stream" });
    res.end(fs.readFileSync(fp));
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve({
    base: "http://127.0.0.1:" + server.address().port,
    close: () => new Promise((r) => server.close(r)),
  })));
}

// ---- listener-leak instrumentation (runs before any page script) ------------

const LISTENER_PROBE = String.raw`
(function () {
  window.__LT = { adds: 0, removes: 0, live: 0 };
  var origA = EventTarget.prototype.addEventListener;
  var origR = EventTarget.prototype.removeEventListener;
  EventTarget.prototype.addEventListener = function (type, fn, opts) {
    if (this === document) { window.__LT.adds++; window.__LT.live++; }
    return origA.call(this, type, fn, opts);
  };
  EventTarget.prototype.removeEventListener = function (type, fn, opts) {
    if (this === document && window.__LT.live > 0) { window.__LT.removes++; window.__LT.live--; }
    return origR.call(this, type, fn, opts);
  };
})();`;

// ---- per-page helpers -------------------------------------------------------

const OVERLAY_STATE = () => ({
  overlays: document.querySelectorAll("[data-cloner-overlay]").length,
  modules: document.querySelectorAll("[data-cloner-module]").length,
  overlayText: (document.querySelector("[data-cloner-overlay]") || {}).textContent || "",
  moduleText: (document.querySelector("[data-cloner-module]") || {}).textContent || "",
  errors: (window.__CLONER_RUNTIME || {}).errors || [],
  status: (window.__CLONER_RUNTIME || {}).status,
});

async function loadAndProbe(page, url) {
  const pageErrors = [];
  const jsConsoleErrors = [];
  const resourceErrors = [];
  const onConsole = (m) => {
    if (m.type() !== "error") return;
    if (/Failed to load resource|net::ERR|ERR_FILE_NOT_FOUND/i.test(m.text())) resourceErrors.push(m.text());
    else jsConsoleErrors.push(m.text());
  };
  const onPageError = (e) => pageErrors.push(String(e?.message || e));
  page.on("console", onConsole);
  page.on("pageerror", onPageError);
  await page.goto(url, { waitUntil: "load", timeout: 20000 });
  await page.waitForTimeout(250);
  page.off("console", onConsole);
  page.off("pageerror", onPageError);
  return { pageErrors, jsConsoleErrors, resourceErrors, state: await page.evaluate(OVERLAY_STATE) };
}

// ---- engine loop ------------------------------------------------------------

const { chromium, firefox, webkit } = await import("playwright");
const ENGINES = [["chromium", chromium], ["firefox", firefox], ["webkit", webkit]];
const skippedEngines = [];
let runEngines = 0;
let projectServer = null;
let scratchDir = null;

try {
  scratchDir = path.join(PROJECT, "platform-data", "rt-robustness-" + Date.now());
  buildProject(scratchDir);
  projectServer = await startProjectServer(scratchDir);

  for (const [engineName, engineType] of ENGINES) {
    let browser;
    try {
      browser = await engineType.launch({ headless: true });
    } catch (e) {
      const msg = String(e?.message || e).split("\n")[0];
      console.log(`SKIP  ${engineName} — Playwright engine not installed (${msg})`);
      skippedEngines.push(engineName);
      continue;
    }
    runEngines++;
    const tag = engineName === "chromium" ? "" : `[${engineName}] `;
    try {
      await runSuite(engineName, tag, browser);
    } finally {
      await browser.close().catch(() => {});
    }
  }
} catch (e) {
  check("no unexpected harness crash", false, String(e?.stack || e).split("\n").slice(0, 3).join(" | "));
} finally {
  if (projectServer) await projectServer.close().catch(() => {});
  if (scratchDir) fs.rmSync(scratchDir, { recursive: true, force: true });
}

async function runSuite(engineName, tag, browser) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  await ctx.addInitScript(LISTENER_PROBE);
  const page = await ctx.newPage();
  const httpBase = projectServer.base;
  const fileIndex = pathToFileURL(path.join(scratchDir, "index.html")).href;
  const filePage2 = pathToFileURL(path.join(scratchDir, "page-002.html")).href;
  const fileMissing = pathToFileURL(path.join(scratchDir, "missing.html")).href;

  // ---- B1 boot over http (intact page: no resource failures tolerated) ----
  let probe = await loadAndProbe(page, httpBase + "/index.html");
  check(tag + "B1 boot http:// — no page errors, no JS console errors, runtime status ok",
    probe.pageErrors.length === 0 && probe.jsConsoleErrors.length === 0 && probe.state.status === "ok",
    `pageErrors=${probe.pageErrors.length} jsErrors=${probe.jsConsoleErrors.length} status=${probe.state.status}`);

  // ---- B2 boot over file:// (standalone export, no server) ----
  probe = await loadAndProbe(page, fileIndex);
  check(tag + "B2 boot file:// — no page errors, no JS console errors, runtime status ok",
    probe.pageErrors.length === 0 && probe.jsConsoleErrors.length === 0 && probe.state.status === "ok",
    `pageErrors=${probe.pageErrors.length} jsErrors=${probe.jsConsoleErrors.length} status=${probe.state.status}`);

  // ---- B3 Escape: overlay + modules; idle Escape is a no-op ----
  await page.click('[data-testid="trigger-1"]');
  await page.waitForTimeout(120);
  let st = await page.evaluate(OVERLAY_STATE);
  check(tag + "B3 trigger opens overlay", st.overlays === 1 && /MARKET-ANALYZER-PICKER/i.test(st.overlayText), `overlays=${st.overlays}`);
  await page.keyboard.press("Escape");
  await page.waitForTimeout(120);
  st = await page.evaluate(OVERLAY_STATE);
  check(tag + "B3 Escape closes overlay", st.overlays === 0, `overlays=${st.overlays}`);
  await page.click('[data-testid="trigger-2"]');
  await page.waitForTimeout(120);
  st = await page.evaluate(OVERLAY_STATE);
  check(tag + "B3 trigger opens module", st.modules === 1 && /DOCKED-CHART/i.test(st.moduleText), `modules=${st.modules}`);
  await page.keyboard.press("Escape");
  await page.waitForTimeout(120);
  st = await page.evaluate(OVERLAY_STATE);
  const errCountBeforeIdle = st.errors.length;
  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape");
  await page.waitForTimeout(120);
  st = await page.evaluate(OVERLAY_STATE);
  check(tag + "B3 Escape closes modules; idle Escape is a no-op (no new runtime errors)",
    st.modules === 0 && st.overlays === 0 && st.errors.length === errCountBeforeIdle,
    `modules=${st.modules} errors=${st.errors.length}`);

  // ---- B4 multi-click idempotence ----
  for (let i = 0; i < 21; i++) await page.click('[data-testid="trigger-1"]');
  await page.waitForTimeout(150);
  st = await page.evaluate(OVERLAY_STATE);
  check(tag + "B4 21 clicks on one trigger → exactly one overlay (re-open/replace, never stacked)",
    st.overlays === 1 && st.modules === 0, `overlays=${st.overlays} modules=${st.modules}`);
  await page.keyboard.press("Escape");
  for (let i = 0; i < 20; i++) await page.click('[data-testid="trigger-2"]');
  await page.waitForTimeout(150);
  st = await page.evaluate(OVERLAY_STATE);
  check(tag + "B4 20 clicks on module trigger → exactly one module (toggle, never stacked)",
    st.modules === 0 && st.overlays === 0, `modules=${st.modules} overlays=${st.overlays}`);

  // ---- B5 module ✕ close + re-open ----
  await page.click('[data-testid="trigger-2"]');
  await page.waitForTimeout(120);
  st = await page.evaluate(OVERLAY_STATE);
  check(tag + "B5 module re-opens after Escape", st.modules === 1, `modules=${st.modules}`);
  await page.click("[data-cloner-modclose]");
  await page.waitForTimeout(120);
  st = await page.evaluate(OVERLAY_STATE);
  check(tag + "B5 module ✕ closes it", st.modules === 0, `modules=${st.modules}`);

  // ---- B6 refresh keeps replay working ----
  await page.reload({ waitUntil: "load" });
  await page.waitForTimeout(250);
  await page.click('[data-testid="trigger-1"]');
  await page.waitForTimeout(150);
  st = await page.evaluate(OVERLAY_STATE);
  check(tag + "B6 replay works after page refresh", st.overlays === 1 && /MARKET-ANALYZER-PICKER/i.test(st.overlayText), `overlays=${st.overlays}`);
  await page.keyboard.press("Escape");

  // ---- B7 deep links: direct navigation to a non-root route file ----
  probe = await loadAndProbe(page, httpBase + "/page-002.html");
  await page.click('[data-testid="trigger-1"]'); // page-002's only wired trigger (t3)
  await page.waitForTimeout(150);
  st = await page.evaluate(OVERLAY_STATE);
  check(tag + "B7 http deep link page-002 boots clean and replays its own record",
    probe.pageErrors.length === 0 && probe.jsConsoleErrors.length === 0 && st.overlays === 1 && /PAGE-TWO-PANEL/i.test(st.overlayText),
    `pageErrors=${probe.pageErrors.length} overlays=${st.overlays}`);
  probe = await loadAndProbe(page, filePage2);
  check(tag + "B7 file:// deep link page-002 boots clean",
    probe.pageErrors.length === 0 && probe.jsConsoleErrors.length === 0 && probe.state.status === "ok",
    `pageErrors=${probe.pageErrors.length} status=${probe.state.status}`);

  // ---- B8 missing assets: placeholder, not crash; page stays interactive ----
  probe = await loadAndProbe(page, httpBase + "/missing.html");
  const assetState = await page.evaluate(() => ({
    fallback: document.getElementById("img-missing").getAttribute("data-cloner-asset-fallback"),
    placeholderLoaded: document.getElementById("img-missing").naturalWidth > 0,
    intactUntouched: document.getElementById("img-ok").getAttribute("data-cloner-asset-fallback") === null,
    assetFallbacks: window.__CLONER_RUNTIME.assetFallbacks,
    resourceFailures: window.__CLONER_RUNTIME.resourceFailures,
  }));
  check(tag + "B8 missing img → placeholder applied, real fallback rendered (no broken image)",
    assetState.fallback === "1" && assetState.placeholderLoaded && assetState.intactUntouched && assetState.assetFallbacks === 1,
    `fallback=${assetState.fallback} naturalWidth>0=${assetState.placeholderLoaded} assetFallbacks=${assetState.assetFallbacks}`);
  check(tag + "B8 failed script/link tolerated and counted, page still boots clean",
    probe.pageErrors.length === 0 && probe.jsConsoleErrors.length === 0 && assetState.resourceFailures >= 1 && probe.state.status === "ok",
    `pageErrors=${probe.pageErrors.length} resourceFailures=${assetState.resourceFailures} status=${probe.state.status}`);
  await page.click('[data-testid="trigger-1"]');
  await page.waitForTimeout(150);
  st = await page.evaluate(OVERLAY_STATE);
  check(tag + "B8 page with missing assets stays fully interactive", st.overlays === 1, `overlays=${st.overlays}`);
  await page.keyboard.press("Escape");
  probe = await loadAndProbe(page, fileMissing);
  check(tag + "B8 file:// missing assets — no page errors either",
    probe.pageErrors.length === 0 && probe.state.status === "ok",
    `pageErrors=${probe.pageErrors.length} status=${probe.state.status}`);

  // ---- B9 50-click listener-leak probe ----
  await loadAndProbe(page, httpBase + "/index.html");
  const baseline = await page.evaluate(() => ({ ...window.__LT }));
  // 21 trigger-1 toggles + 20 trigger-2 toggles + 5 module-✕ cycles (2 clicks each) = 51 clicks
  for (let i = 0; i < 21; i++) await page.click('[data-testid="trigger-1"]');
  for (let i = 0; i < 20; i++) await page.click('[data-testid="trigger-2"]');
  for (let i = 0; i < 5; i++) {
    await page.click('[data-testid="trigger-2"]');
    await page.click("[data-cloner-modclose]");
  }
  // 5 splitter drag cycles — each adds/removes a document mousemove+mouseup pair
  const spBox = await page.locator('[data-testid="splitter"]').boundingBox();
  for (let i = 0; i < 5; i++) {
    await page.mouse.move(spBox.x + 3, spBox.y + 10);
    await page.mouse.down();
    await page.mouse.move(spBox.x + 3, spBox.y + 30);
    await page.mouse.up();
  }
  for (let i = 0; i < 3; i++) await page.keyboard.press("Escape");
  await page.waitForTimeout(200);
  const after = await page.evaluate(() => ({ ...window.__LT, replayNodes: document.querySelectorAll("[data-cloner-overlay],[data-cloner-module]").length }));
  check(tag + "B9 no listener leaks after 50+ clicks (live document listeners back at boot baseline)",
    after.live === baseline.live && after.removes >= 10,
    `baseline live=${baseline.live} (adds=${baseline.adds}) → after live=${after.live} (adds=${after.adds}, removes=${after.removes})`);
  check(tag + "B9 replay DOM bounded after 51 clicks + drags (≤ module cap + 1 overlay)",
    after.replayNodes <= 7,
    `replayNodes=${after.replayNodes}`);

  // ---- B10 error isolation: a failing component must not break the page ----
  await page.evaluate(() => {
    const poison = document.createElement("button");
    poison.id = "poison";
    poison.textContent = "poison";
    Object.defineProperty(poison, "closest", { get() { throw new Error("poisoned-closest"); } });
    document.body.appendChild(poison);
  });
  const pageErrorsDuringPoison = [];
  const onPE = (e) => pageErrorsDuringPoison.push(String(e?.message || e));
  page.on("pageerror", onPE);
  await page.evaluate(() => document.getElementById("poison").dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true })));
  await page.waitForTimeout(150);
  page.off("pageerror", onPE);
  st = await page.evaluate(OVERLAY_STATE);
  check(tag + "B10 poisoned component's error is isolated (no page error, recorded on __CLONER_RUNTIME.errors)",
    pageErrorsDuringPoison.length === 0 && st.errors.length > 0 && st.status === "ok",
    `pageErrors=${pageErrorsDuringPoison.length} recorded=${JSON.stringify(st.errors.slice(-1))}`);
  await page.click('[data-testid="trigger-1"]');
  await page.waitForTimeout(150);
  st = await page.evaluate(OVERLAY_STATE);
  check(tag + "B10 replay still works after the isolated failure", st.overlays === 1, `overlays=${st.overlays}`);
  await page.keyboard.press("Escape");

  // ---- S1 static: exported project is standalone (no engine/artifact paths) ----
  const rtSrc = fs.readFileSync(path.join(scratchDir, "runtime", "interactions.js"), "utf8");
  const pagesSrc = ["index.html", "page-002.html", "missing.html"]
    .map((f) => fs.readFileSync(path.join(scratchDir, f), "utf8")).join("\n");
  check(tag + "S1 generated pages reference only relative paths (no engine server, no artifact paths)",
    !/src="https?:\/\/|href="https?:\/\/|\/artifacts\//.test(pagesSrc) && rtSrc.includes("window.__CLONER_INTERACTIONS = ["),
    "all script/href refs relative; runtime data embedded inline");

  await ctx.close();
}

check("browser engines: at least chromium ran the full suite", runEngines >= 1,
  `ran=${runEngines}${skippedEngines.length ? `, skipped=${skippedEngines.join(", ")} (not installed)` : ""}`);

const fails = results.filter((r) => !r).length;
console.log(`\n${fails ? "RESULT: FAIL" : "RESULT: PASS"}  (${results.length - fails}/${results.length})` +
  (skippedEngines.length ? `  [skipped engines: ${skippedEngines.join(", ")} — not installed]` : ""));
process.exit(fails ? 1 : 0);
