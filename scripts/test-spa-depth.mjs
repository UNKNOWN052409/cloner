#!/usr/bin/env node
// Offline SPA-depth test — proves the authed-shell exploration depth end to
// end, everything on 127.0.0.1 (no external site, nothing mocked in the path
// under test):
//
//   [1] fixture: a client-side dashboard whose tabs switch views WITHOUT any
//       URL change, plus the data-driven regions that drift pixels between
//       sessions by nature (live clock, canvas chart redrawn per render, quote
//       table ticking every 400ms). One nav control is deliberately DANGEROUS
//       ("Flatten book" — the policy's forbiddenText matches "flatten") and
//       must never be clicked by the state walker.
//   [2] exploration depth: the page-001 root capture (same artifact shape the
//       exploration pipeline writes) + enumerateInAppStates walking the in-app
//       nav → >= 2 in-URL states with DISTINCT dom captures, DANGEROUS skipped,
//       URL identity preserved, budget respected.
//   [3] manifest contract: manifest.pages carries url#state page entries plus
//       graph/states.json / exploration.json / assets/manifest.json — the shape
//       the reconstruction emits one page per entry from.
//   [4] reconstruction: reconstructFromArtifacts (real engine, deterministic
//       no-vision offline path) emits one page per state entry.
//   [5] verification: verifyTask (three real-browser stages) — visual stage
//       passes with the dynamic region compared STRUCTURALLY (global 60%
//       threshold untouched); the verify cleanups are exercised: blueprint
//       instructions carried, asset weight counting the v2 flat layout,
//       skipped exhaustive-test reported as skipped (ok:null, not ok:true).
//
// No package.json script — runs via `node scripts/test-spa-depth.mjs` from the
// repository root (verify's stage 3 resolves scripts/compare-clone.mjs from cwd).
import fs from "node:fs";
import path from "node:path";
import { launchBrowser } from "../src/browser.js";
import { DOM_EXTRACTOR_SCRIPT, analyzeTypography } from "../src/intelligence/dom-extractor.js";
import {
  createStateGraph, DOM_SIGNATURE_SCRIPT, enumerateInAppStates,
  statePageId, statePageEntries, inAppCandidateSafe,
} from "../src/exploration/state-discovery.js";
import { resolvePolicy, DEFAULT_POLICY } from "../src/exploration/exploration-policy.js";
import { reconstructFromArtifacts } from "../src/reconstruction/reconstruction-pipeline.js";
import { verifyTask, dynamicRegionElements, compareRegionStructure, dynamicAttribution, cellRect, rectsIntersect } from "../src/reconstruction/verify.js";
import { startFixtureServer, solidPng, reqUrl, sendHtml } from "./fixtures/server.mjs";

let pass = 0, fail = 0;
const failures = [];
const check = (label, ok, detail = "") => {
  if (ok) { pass++; console.log(`  PASS  ${label}`); }
  else { fail++; failures.push(label + (detail ? " — " + detail : "")); console.log(`  FAIL  ${label}${detail ? " — " + detail : ""}`); }
};

const ROOT = path.resolve(".");
const INSTRUCTIONS = "Only clone the trading dashboard main view.";

// ---------------- fixture: same-URL tab views + data-driven dynamic regions ----------------
const FIXTURE_HTML = `<!DOCTYPE html><html><head><title>Meridian Desk</title><style>
body{margin:0;font-family:Arial,Helvetica,sans-serif;background:#ffffff;color:#1d2733}
.app-header{background:#123f6d;color:#ffffff;padding:14px 28px;display:flex;align-items:center}
.app-header h1{margin:0;font-size:22px;margin-right:auto}
.brand{width:26px;height:26px;margin-right:12px}
.clock{font-size:15px;font-variant-numeric:tabular-nums}
.app-nav{background:#e9eef5;padding:10px 28px;display:flex;gap:10px}
.nav-btn{padding:8px 16px;font-size:14px;background:#ffffff;border:1px solid #b7c4d4;color:#1d2733;cursor:pointer}
.nav-btn.active{background:#123f6d;color:#ffffff}
main{padding:18px 28px}
h2{margin:0 0 12px 0;font-size:19px}
#chart.trade-chart{width:1000px;height:420px;border:1px solid #ccd6e2;background:#fbfcfe;display:block}
.quote-region{margin-top:16px}
table{border-collapse:collapse;width:1000px;font-size:13px}
th,td{border:1px solid #d4dde8;padding:6px 10px;text-align:left}
th{background:#eef3f9}
.pos-note,.hist-note,.ov-note{margin-top:12px;font-size:13px;color:#52667d}
ul.fill-list{font-size:13px}
</style></head><body>
<header class="app-header"><img class="brand" src="/logo.png" alt="brand"><h1>Meridian Desk</h1><span id="clock" class="clock">--:--:--</span></header>
<nav class="app-nav" role="navigation">
  <button class="nav-btn" data-view="overview">Overview</button>
  <button class="nav-btn" data-view="positions">Positions</button>
  <button class="nav-btn" data-view="history">History</button>
  <button class="nav-btn" data-view="flatten">Flatten book</button>
</nav>
<main id="view"></main>
<script>
var QUOTES = [["ESZ5",6021.25,6021.50],["NQZ5",21368.75,21369.25],["RTYZ5",2318.30,2318.60],["YMZ5",43905.00,43906.00],["CLF6",71.42,71.45],["GCG6",2691.50,2692.10],["ZNZ5",110.36,110.38],["6EZ5",1.09,1.09]];
function quoteRows(){return QUOTES.map(function(q){return "<tr><td>"+q[0]+"</td><td>"+q[1].toFixed(2)+"</td><td>"+q[2].toFixed(2)+"</td><td>"+(q[2]-q[1]).toFixed(2)+"</td></tr>";}).join("");}
var VIEWS = {
  overview:function(){return '<section class="overview-view"><h2>Book overview</h2><canvas id="chart" class="trade-chart" width="1000" height="420"></canvas><div class="quote-region"><table class="quote-table"><thead><tr><th>Symbol</th><th>Bid</th><th>Ask</th><th>Spread</th></tr></thead><tbody>'+quoteRows()+"</tbody></table></div>"+'<p class="ov-note">Data refreshes every 400 ms via the quote stream.</p></section>';},
  positions:function(){return '<section class="positions-view"><h2>Open positions</h2><table class="positions-table"><thead><tr><th>Contract</th><th>Qty</th><th>Avg price</th><th>P/L</th></tr></thead><tbody><tr><td>ESZ5</td><td>3</td><td>6018.25</td><td>+9.00</td></tr><tr><td>NQZ5</td><td>1</td><td>21361.00</td><td>+7.75</td></tr><tr><td>CLF6</td><td>-2</td><td>71.88</td><td>+0.92</td></tr><tr><td>GCG6</td><td>2</td><td>2688.40</td><td>+6.20</td></tr></tbody></table><p class="pos-note">Four open positions across two desks. Margin utilization 41 percent.</p></section>';},
  history:function(){return '<section class="history-view"><h2>Fill history</h2><ul class="fill-list"><li>09:31 ESZ5 bought 2 @ 6017.75</li><li>10:12 CLF6 sold 2 @ 71.88</li><li>10:58 NQZ5 bought 1 @ 21361.00</li><li>11:44 GCG6 bought 2 @ 2688.40</li><li>13:02 ESZ5 bought 1 @ 6021.25</li></ul><p class="hist-note">Five fills today, all routed through the SIM gateway.</p></section>';}
};
function drawChart(){
  var c=document.getElementById("chart");if(!c)return;
  var ctx=c.getContext("2d");
  ctx.fillStyle="#fbfcfe";ctx.fillRect(0,0,c.width,c.height);
  ctx.strokeStyle="#dfe7f0";
  for(var g=0;g<=5;g++){ctx.beginPath();ctx.moveTo(0,g*84);ctx.lineTo(c.width,g*84);ctx.stroke();}
  var v=300;
  for(var i=0;i<24;i++){
    v=Math.max(40,Math.min(380,v+(Math.random()-0.5)*90));
    ctx.fillStyle=i%2?"#1d5fa8":"#3f8ad6";
    ctx.fillRect(12+i*41,c.height-v,26,v);
  }
}
function render(view){
  var btns=document.querySelectorAll(".nav-btn");
  for(var i=0;i<btns.length;i++){btns[i].classList.toggle("active",btns[i].getAttribute("data-view")===view);}
  document.getElementById("view").innerHTML=VIEWS[view]();
  if(view==="overview")drawChart();
}
var navBtns=document.querySelectorAll(".nav-btn");
for(var i=0;i<navBtns.length;i++){(function(b){b.addEventListener("click",function(){render(b.getAttribute("data-view"));});})(navBtns[i]);}
setInterval(function(){var el=document.getElementById("clock");if(el)el.textContent=new Date().toLocaleTimeString("en-GB");},250);
setInterval(function(){
  for(var i=0;i<QUOTES.length;i++){var d=(Math.random()-0.5)*0.5;QUOTES[i][1]=+(QUOTES[i][1]+d).toFixed(2);QUOTES[i][2]=+(QUOTES[i][2]+d).toFixed(2);}
  var tb=document.querySelector(".quote-table tbody");if(tb)tb.innerHTML=quoteRows();
},400);
render("overview");
</script></body></html>`;

const site = {
  name: "spa-depth",
  handle(req, res) {
    const u = reqUrl(req);
    if (u.pathname === "/") { sendHtml(res, FIXTURE_HTML); return; }
    if (u.pathname === "/logo.png") { res.writeHead(200, { "content-type": "image/png" }); res.end(solidPng(18, 63, 109, 26, 26)); return; }
    sendHtml(res, "<h1>not found</h1>", 404);
  },
};

// ---------------- shared capture helpers (pipeline artifact shapes) ----------------
const artifactsDir = path.join(ROOT, "artifacts", "spa-depth-" + Date.now().toString(36));
fs.mkdirSync(artifactsDir, { recursive: true });
const writeJson = (rel, obj) => { fs.mkdirSync(path.dirname(path.join(artifactsDir, rel)), { recursive: true }); fs.writeFileSync(path.join(artifactsDir, rel), JSON.stringify(obj, null, 2)); };

function writePageArtifacts(pageId, url, intel) {
  const dir = path.join(artifactsDir, "pages", pageId);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "dom.json"), JSON.stringify({ pageId, url, total: intel.total, sampled: intel.sampled, elements: intel.elements, repeated: intel.repeated, fixed: intel.fixed, sticky: intel.sticky, typography: intel.typography }, null, 2));
  fs.writeFileSync(path.join(dir, "geometry.json"), JSON.stringify({ pageId, containers: intel.elements.slice(0, 60).map((e) => ({ i: e.i, tag: e.tag, cls: e.cls, rect: e.rect, layout: e.layout })), fixed: intel.fixed, sticky: intel.sticky }, null, 2));
  fs.writeFileSync(path.join(dir, "styles.json"), JSON.stringify({ pageId, typography: intel.typography, bodyStyle: intel.bodyStyle || null, htmlStyle: intel.htmlStyle || null, elements: intel.elements.map((e) => ({ i: e.i, tag: e.tag, cls: e.cls, style: e.style })) }, null, 2));
  fs.writeFileSync(path.join(dir, "network.json"), JSON.stringify({ pageId, url, entries: [] }, null, 2));
}

async function capturePageArtifacts(page, pageId, url) {
  const dir = path.join(artifactsDir, "pages", pageId);
  fs.mkdirSync(dir, { recursive: true });
  const shot = await page.screenshot({ fullPage: false, timeout: 20000 });
  fs.writeFileSync(path.join(dir, "screenshot-viewport.png"), shot);
  const intel = await page.evaluate(DOM_EXTRACTOR_SCRIPT);
  intel.typography = analyzeTypography(intel.elements);
  writePageArtifacts(pageId, url, intel);
  const domSig = await page.evaluate(DOM_SIGNATURE_SCRIPT);
  return { screenshotRef: `pages/${pageId}/screenshot-viewport.png`, domRef: `pages/${pageId}/dom.json`, domSig, intel };
}

// ---------------- [1] fixture up ----------------
console.log("\n[1] fixture server (127.0.0.1, same-URL tab views + dynamic regions)");
const fx = await startFixtureServer(site);
check("fixture serves the dashboard", (await fetch(fx.base + "/")).status === 200);

// ---------------- [2] exploration depth on the loaded shell ----------------
console.log("\n[2] state-discovery depth: in-URL view switches");
const policy = resolvePolicy({ budgets: { maxRoutes: 1, maxInUrlStates: 4, maxTotalTimeMs: 180000 } });
const graph = createStateGraph();
const browser = await launchBrowser({ headless: true });
let rootIntel = null, rootUrl = null;
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await page.goto(fx.base + "/", { waitUntil: "domcontentloaded", timeout: 20000 });
  await page.waitForTimeout(700);
  rootUrl = page.url();
  const root = await capturePageArtifacts(page, "page-001", rootUrl);
  rootIntel = root.intel;
  const rootNode = graph.addState({ url: rootUrl, domSig: root.domSig, screenshotRef: root.screenshotRef, domRef: root.domRef, viewport: "desktop", status: "explored" });
  const depth = await enumerateInAppStates(page, {
    graph, parentNode: rootNode.node, policy,
    captureState: async ({ page: p, index }) => capturePageArtifacts(p, statePageId("page-001", index), rootUrl),
    budgetMs: 90000,
  });
  console.log("  depth summary:", JSON.stringify(depth));
  check(">= 2 in-URL states recorded", depth.recorded >= 2, `${depth.recorded} recorded, ledger ${JSON.stringify(depth.skipped)}`);
  check("DANGEROUS control never clicked (policy guard)", depth.skipped.unsafe === 1, `${depth.skipped.unsafe} unsafe skip(s) — fixture carries exactly one ("Flatten book")`);
  check("no URL change during the walk", depth.skipped["url-changed"] === 0 && depth.states.every((s) => s.url.startsWith(fx.base + "/#")), `restored=${depth.restoredNavigations}`);
  check("budget respected", depth.recorded <= policy.budgets.maxInUrlStates, `${depth.recorded} <= ${policy.budgets.maxInUrlStates}`);
  const stateDoms = depth.states.map((s) => fs.readFileSync(path.join(artifactsDir, s.domRef), "utf8"));
  check("state DOM captures are distinct", stateDoms.length === depth.states.length && new Set(stateDoms).size === stateDoms.length && stateDoms.length >= 2, `${new Set(stateDoms).size}/${stateDoms.length} distinct dom.json files`);
  const stateShots = depth.states.map((s) => fs.readFileSync(path.join(artifactsDir, s.screenshotRef)));
  check("state screenshots exist and differ", stateShots.length === depth.states.length && stateShots.some((a, i) => stateShots.some((b, j) => j > i && !a.equals(b))), "");
  const viewLabels = depth.states.map((s) => s.interaction);
  check("view switches are the recorded interactions", viewLabels.includes("Positions") && viewLabels.includes("History"), viewLabels.join(", "));
  await page.close();
} finally {
  await browser.close().catch(() => {});
}

// guard unit checks (pure, deterministic): the DANGEROUS rules on descriptors
check("guard: risky text rejected", inAppCandidateSafe({ tag: "button", text: "Flatten book", cls: "nav-btn" }, DEFAULT_POLICY.risk).why === "risky-text");
check("guard: submit type rejected", inAppCandidateSafe({ tag: "button", type: "submit", text: "Go", cls: "" }, DEFAULT_POLICY.risk).why === "submit-button");
check("guard: resolved-policy regex re-hydration (resolvePolicy must not return {} guards)", typeof resolvePolicy({}).risk.forbiddenText.test === "function" && resolvePolicy({}).risk.forbiddenText.test("Flatten book"), "");
check("guard: mangled risk object falls back to defaults, never fail-open", inAppCandidateSafe({ tag: "button", text: "Flatten book", cls: "" }, { forbiddenText: {}, forbiddenTypes: [], allowedAnchorHref: undefined }).why === "risky-text");

// ---------------- [3] manifest + graph + exploration artifacts (spec §8/§15) ----------------
console.log("\n[3] manifest contract: url#state page entries the reconstruction can emit");
const inUrlNodes = graph.nodes.filter((n) => n.status === "in-url");
const pageEntry = { pageId: "page-001", url: rootUrl, route: "/", records: 0, domSampled: rootIntel.sampled };
const stateEntries = statePageEntries(pageEntry, inUrlNodes);
const graphData = graph.serialize();
const manifest = {
  schemaVersion: "1.0.0", jobId: path.basename(artifactsDir),
  startedAt: new Date(Date.now() - 60000).toISOString(), finishedAt: new Date().toISOString(),
  originalUrl: fx.base + "/", status: "completed",
  configuration: { budgets: policy.budgets, viewports: ["desktop"] },
  discoveredRoutes: 1, discoveredStates: graphData.stats.nodes, discoveredInteractions: graphData.stats.edges,
  assets: { total: 1, totalBytes: 1024, byType: {}, deduplicated: 0, capturedFromNetwork: { count: 1, bytes: 1024, entries: [{ url: fx.base + "/logo.png", localPath: "assets/logo.png" }] } },
  pages: [pageEntry, ...stateEntries],
  coverage: { routesExplored: 1, routesDiscovered: 1, statesRecorded: graphData.stats.nodes },
  errors: [], warnings: [], auth: { loginRequired: false, status: "not-required" }, metrics: {}, browserMemory: {},
};
writeJson("manifest.json", manifest);
writeJson("graph/states.json", graphData);
writeJson("graph/transitions.json", { edges: graphData.edges });
writeJson("states/index.json", { note: "state evidence index (spec §8/§15)", states: graphData.nodes, edges: graphData.edges });
writeJson("exploration.json", { generatedAt: new Date().toISOString(), jobId: manifest.jobId, status: "completed", coverage: manifest.coverage, statesDir: "_reference/states", behaviors: [], source: "v2-exploration-summary" });
writeJson("reports/exploration-summary.json", { jobId: manifest.jobId, status: "completed", pages: 1, routes: 1, states: graphData.stats.nodes, interactions: graphData.stats.edges, errors: [], warnings: [] });
const logoBytes = solidPng(18, 63, 109, 26, 26);
fs.mkdirSync(path.join(artifactsDir, "assets"), { recursive: true });
fs.writeFileSync(path.join(artifactsDir, "assets", "logo.png"), logoBytes);
writeJson("assets/manifest.json", { total: 1, totalBytes: logoBytes.length, byType: { png: 1 }, deduplicated: 0, capturedFromNetwork: { count: 1, bytes: logoBytes.length, entries: [{ url: fx.base + "/logo.png", localPath: "assets/logo.png" }] } });
check("manifest.pages keyed url#state", stateEntries.length === inUrlNodes.length && stateEntries.every((e, i) => e.url === fx.base + "/#" + e.state.toLowerCase() && e.pageId === statePageId("page-001", i + 1) && e.stateOf === "page-001"), stateEntries.map((e) => `${e.pageId} → ${e.url}`).join("; "));
check("state page evidence dirs match the manifest pageIds", stateEntries.every((e) => fs.existsSync(path.join(artifactsDir, "pages", e.pageId, "dom.json"))), "");

// ---------------- [4] reconstruction emits the state pages ----------------
console.log("\n[4] reconstruction (real engine, offline deterministic path)");
const outDir = artifactsDir + "-project";
const rec = await reconstructFromArtifacts(artifactsDir, { outDir, interactionRecords: [], instructions: INSTRUCTIONS });
check("reconstruction ok", rec.ok === true, rec.ok ? `${rec.report?.generatedFiles ?? "?"} files` : rec.why);
check("design-tokens.json written (verify needs it)", fs.existsSync(path.join(artifactsDir, "design-tokens.json")), "");
check("blueprint.json written with instructions applied", (() => { try { const bp = JSON.parse(fs.readFileSync(path.join(artifactsDir, "blueprint.json"), "utf8")); return bp.instructions?.applied === true && String(bp.instructions?.raw || "").includes("Only clone"); } catch { return false; } })(), "");
for (const e of stateEntries) {
  check(`state page emitted: ${e.pageId}.html`, fs.existsSync(path.join(outDir, e.pageId + ".html")), "");
}
check("project carries the v2 asset (flat public/assets)", fs.existsSync(path.join(outDir, "public", "assets", "logo.png")), "");

// ---------------- [5] verification: visual passes with a dynamic region ----------------
console.log("\n[5] verification (three real-browser stages; dynamic-region structural compare)");
const report = await verifyTask(artifactsDir, { instructions: INSTRUCTIONS });
const s1 = report.stages.find((s) => s.stage === "functional");
const s2 = report.stages.find((s) => s.stage === "optimization-completeness");
const s3 = report.stages.find((s) => s.stage === "visual");
const pixCheck = s3.checks.find((c) => c.name === "pixel difference");
const dynCheck = s3.checks.find((c) => c.name === "dynamic-region structural comparison");
console.log(`  pixel: ${pixCheck.detail}`);
console.log(`  dynamic: ${dynCheck.detail}`);
check("visual stage PASSED", s3.passed === true, `failed checks: ${s3.checks.filter((c) => !c.ok).map((c) => c.name).join(", ") || "none"}`);
check("dynamic-region check ran on real evidence", s3.dynamicRegions?.applicable === true && s3.dynamicRegions?.ran === true, JSON.stringify(s3.dynamicRegions || {}).slice(0, 160));
check("dynamic region detected (canvas chart)", (s3.dynamicRegions?.regions || []).some((r) => /^canvas/.test(r.region)), (s3.dynamicRegions?.regions || []).map((r) => r.region).join(", "));
check("every hottest cell attributed to a dynamic region", s3.dynamicRegions?.allCovered === true, JSON.stringify(s3.dynamicRegions?.cells || []));
check("dynamic regions structurally match", s3.dynamicRegions?.ok === true, (s3.dynamicRegions?.regions || []).map((r) => `${r.region} ${r.origCount}→${r.cloneCount} drift ${r.drift}px`).join("; "));
check("global pixel threshold not loosened", /threshold 60%/.test(pixCheck.detail), "");
const bpCheck = s2.checks.find((c) => c.name === "task instructions carried");
check("cleanup: task instructions carried via blueprint.json (not a fake ok:true)", bpCheck?.ok === true && /instructions\.applied=true/.test(bpCheck.detail || ""), bpCheck ? bpCheck.detail : "check missing");
check("cleanup: asset weight counts the v2 flat layout", (s2.metrics?.totalFiles || 0) >= 1, JSON.stringify(s2.metrics?.weights || {}));
const explCheck = s2.checks.find((c) => c.name === "exploration + replay data complete");
check("cleanup: in-URL states count as documented exploration evidence", explCheck?.ok === true && /in-URL view state/.test(explCheck.detail || ""), explCheck ? explCheck.detail : "check missing");
const exhCheck = s1.checks.find((c) => c.name === "exhaustive click-everywhere");
check("cleanup: skipped exhaustive-test reported as skipped (ok:null, not ok:true)", exhCheck ? (exhCheck.skipped === true ? exhCheck.ok === null : true) : false, exhCheck ? `skipped=${!!exhCheck.skipped} ok=${JSON.stringify(exhCheck.ok)} detail="${exhCheck.detail}"` : "check missing");
console.log(`  stage1 functional passed=${s1.passed}; stage2 passed=${s2.passed}; overall report.passed=${report.passed}`);

// ---------------- deterministic unit checks: attribution + structure math ----------------
const W = 1440, H = 900;
const chartRect = { x: 28, y: 190, w: 1000, h: 420 };
const clockRect = { x: 1340, y: 10, w: 70, h: 24 };
const dynEls = dynamicRegionElements([{ tag: "canvas", cls: "trade-chart", rect: chartRect }, { tag: "span", id: "clock", rect: clockRect }, { tag: "p", cls: "intro", rect: { x: 40, y: 700, w: 300, h: 60 } }]);
check("unit: dynamicRegionElements flags canvas + clock, not static prose", dynEls.length === 2, `${dynEls.length} of 3`);
const cell = cellRect(27, W, H); // row 2, col 3 → overlaps the chart
check("unit: cellRect maps the 12×8 grid", cell.w === 120 && cell.h === 113 && rectsIntersect(cell, chartRect), JSON.stringify(cell));
const attr = dynamicAttribution([{ cell: 27, score: 9, region: "content-left" }, { cell: 11, score: 7, region: "header-right" }], dynEls, W, H);
check("unit: attribution covers chart + clock cells", attr.allCovered === true && attr.cells.every((c) => c.covered), JSON.stringify(attr.cells));
const attrStatic = dynamicAttribution([{ cell: 90, score: 9, region: "footer-center" }], dynEls, W, H);
check("unit: a static hot cell blocks attribution (no silent loosening)", attrStatic.allCovered === false, "");
// anchored structure comparison: each side counted in its OWN region interior
const big = Array.from({ length: 10 }, (_, i) => ({ rect: { x: 30 + i * 90, y: 200, w: 60, h: 300 } }));
const origAnchor = { rect: chartRect };
const cloneAnchorOk = { rect: { x: 28, y: 208, w: 1004, h: 424 } }; // the measured clone canvas: 48px down, 0.2% size
const cloneElsOk = big.map((e) => ({ rect: { x: e.rect.x, y: e.rect.y + 48, w: e.rect.w, h: e.rect.h } }));
check("unit: structure matches within tolerance (48px shift, 0.2% size)", compareRegionStructure(origAnchor, cloneAnchorOk, big, cloneElsOk).ok === true, JSON.stringify(compareRegionStructure(origAnchor, cloneAnchorOk, big, cloneElsOk)));
check("unit: layout drift beyond 64px fails structure", compareRegionStructure(origAnchor, { rect: { ...cloneAnchorOk.rect, x: 228 } }, big, cloneElsOk).ok === false, `drift=${compareRegionStructure(origAnchor, { rect: { ...cloneAnchorOk.rect, x: 228 } }, big, cloneElsOk).drift}px`);
check("unit: region size drift beyond ±15% fails structure", compareRegionStructure(origAnchor, { rect: { ...cloneAnchorOk.rect, h: 844 } }, big, cloneElsOk).ok === false, `sizeDrift=${compareRegionStructure(origAnchor, { rect: { ...cloneAnchorOk.rect, h: 844 } }, big, cloneElsOk).sizeDrift}`);
const countDrift = cloneElsOk.concat(cloneElsOk.slice(0, 6)); // 16 vs 10 = +60% > ±50%
check("unit: element-count drift beyond ±50% fails structure", compareRegionStructure(origAnchor, cloneAnchorOk, big, countDrift).ok === false, `counts ${compareRegionStructure(origAnchor, cloneAnchorOk, big, countDrift).origCount}→${compareRegionStructure(origAnchor, cloneAnchorOk, big, countDrift).cloneCount}`);

// ---------------- summary ----------------
await fx.close().catch(() => {});
console.log(`\n${"═".repeat(60)}\nRESULT: ${pass} passed, ${fail} failed  (artifacts: ${artifactsDir})`);
if (failures.length) { console.log("Failures:"); for (const f of failures) console.log("  - " + f); }
process.exit(fail ? 1 : 0);

