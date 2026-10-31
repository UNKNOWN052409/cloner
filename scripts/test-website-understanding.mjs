// Website-understanding engine tests (task 3.4.1) — ZERO NETWORK by default.
//
// Sections:
//  [1] component-evidence primitives: per-source-max + noisy-OR confidence
//      aggregation, evidence-list merge/dedup, deterministic kind election.
//  [2] buildUnderstandingPage on a SYNTHETIC captured page (dom.json-shaped
//      element arrays, no browser): classification + provenance + hierarchy,
//      the vision hook (flip for deterministic confidence < 0.5 ONLY), the
//      no-provider deterministic default, and the missing-screenshot path.
//  [3] e2e multi-route fixture (real exploration job): navigation/workspace/
//      table classification with confidence + provenance on real artifacts.
//  [4] e2e lazy-scroll gallery: card-grid + repeated cards + repeated-group
//      relationship + network evidence.
//  [5] e2e synthetic Golden-Layout-style workspace (served page created here):
//      header/navigation/sidebar/toolbar/workspace/splitter/table/chart/modal,
//      parent-child relationships between them, and proof that NO component is
//      weak enough to consult vision (all deterministic confidence >= 0.5).
//
// A global fetch tripwire fails the run if ANY network call is attempted.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PROJECT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
process.chdir(PROJECT);

const { multiRouteSite } = await import("../scripts/fixtures/index.mjs");
const { lazyScrollSite } = await import("../scripts/fixtures/index.mjs");
const { startFixtureServer, sendHtml, reqUrl } = await import("../scripts/fixtures/server.mjs");
const { runExplorationJob } = await import("../src/pipeline/exploration-pipeline.js");
const { loadArtifacts } = await import("../src/reconstruction/artifact-loader.js");
const {
  EVIDENCE_SOURCES, makeEvidence, aggregateConfidence, mergeEvidenceLists, electKind, isStrong,
} = await import("../src/reconstruction/component-evidence.js");
const {
  REGION_KINDS, buildUnderstandingPage, pageArtifactsFromLoaded, understandArtifactsDir, summarizeUnderstanding,
} = await import("../src/reconstruction/website-understanding.js");

let pass = 0, fail = 0;
const check = (name, ok, detail = "") => { console.log(`  ${ok ? "PASS" : "FAIL"} ${name}${detail ? " — " + detail : ""}`); ok ? pass++ : fail++; };

// ---- zero-network tripwire: any attempted fetch is recorded and fails the run ----
const fetchAttempts = [];
globalThis.fetch = (...args) => {
  fetchAttempts.push(String(args[0]));
  return Promise.reject(new Error("NETWORK_BLOCKED_BY_TEST"));
};

// ---- helpers ----
// mk(): one dom.json-shaped element (mirrors src/intelligence/dom-extractor.js)
const mk = (i, tag, cls, rect, extra = {}) => ({
  i, tag, cls: cls || null, role: null, ariaName: null, id: null,
  dataClonerTrigger: null, href: null, src: null, text: null,
  parent: null, children: 0, rect, layout: null, style: {}, ...extra,
});
const comp = (u, kind) => (u.components || []).find((c) => c.kind === kind);
const hasEvidenceSource = (c, source) => (c?.evidence || []).some((e) => e.source === source);
const evSources = (c) => [...new Set((c?.evidence || []).map((e) => e.source))].sort();

// 1x1 transparent PNG so the vision path exercises the real screenshot read
const tmpShot = path.join(os.tmpdir(), "website-understanding-test-shot.png");
fs.writeFileSync(tmpShot, Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=",
  "base64",
));

// =====================================================================
console.log("\n[1] component-evidence primitives");
{
  check("evidence sources vocabulary fixed", JSON.stringify(EVIDENCE_SOURCES) === JSON.stringify([
    "dom-tag", "dom-role", "dom-aria", "dom-class", "geometry", "css", "repetition", "network", "vision",
  ]), EVIDENCE_SOURCES.join(","));

  const sameSource = [makeEvidence("dom-class", "e.cls", "a", 0.6), makeEvidence("dom-class", "e.id", "b", 0.6)];
  check("same source never double counts (max, not noisy-OR within a source)", aggregateConfidence(sameSource) === 0.6, String(aggregateConfidence(sameSource)));
  const twoSources = [makeEvidence("dom-class", "r1", "", 0.6), makeEvidence("geometry", "r2", "", 0.5)];
  check("cross-source noisy-OR: 0.6+0.5 → 0.8", aggregateConfidence(twoSources) === 0.8, String(aggregateConfidence(twoSources)));
  check("empty evidence → 0", aggregateConfidence([]) === 0);
  check("zero-weight records are provenance-only", aggregateConfidence([makeEvidence("network", "r", "", 0)]) === 0);
  check("capped at 0.99", aggregateConfidence([makeEvidence("dom-tag", "r", "", 0.95), makeEvidence("geometry", "r", "", 0.95)]) === 0.99);
  check("weight clamped into [0,1]", makeEvidence("dom-tag", "r", "", 7).weight === 1 && makeEvidence("dom-tag", "r", "", -3).weight === 0);

  const merged = mergeEvidenceLists(
    [makeEvidence("dom-tag", "r", "first", 0.6)],
    [makeEvidence("dom-tag", "r", "second", 0.9), makeEvidence("geometry", "r", "other source same ref", 0.4)],
  );
  check("merge dedups by source+ref, keeps first position, upgrades weight", merged.length === 2 && merged[0].note === "second" && merged[0].weight === 0.9 && merged[1].source === "geometry", JSON.stringify(merged));

  const win = electKind([
    { kind: "header", evidence: [makeEvidence("geometry", "r", "", 0.5)] },
    { kind: "navigation", evidence: [makeEvidence("dom-tag", "r", "", 0.9), makeEvidence("dom-class", "r", "", 0.6)] },
  ]);
  check("electKind: highest aggregate wins", win.kind === "navigation" && win.confidence === 0.96, JSON.stringify({ kind: win.kind, conf: win.confidence }));
  const tieWeight = electKind([
    { kind: "aaa", evidence: [makeEvidence("dom-tag", "r1", "", 0.5), makeEvidence("geometry", "r2", "", 0.5)] }, // noisy-OR 0.75, sum 1.0
    { kind: "bbb", evidence: [makeEvidence("dom-tag", "r1", "", 0.75)] }, // noisy-OR 0.75, sum 0.75
  ]);
  check("electKind: aggregate tie → higher summed weight wins", tieWeight.kind === "aaa" && tieWeight.confidence === 0.75, `${tieWeight.kind}@${tieWeight.confidence}`);
  const tieLex = electKind([
    { kind: "zeta", evidence: [makeEvidence("dom-tag", "r1", "", 0.45)] },
    { kind: "alpha", evidence: [makeEvidence("geometry", "r1", "", 0.45)] },
  ]);
  check("electKind: full tie → lexicographic (deterministic)", tieLex.kind === "alpha", tieLex.kind);
  check("electKind: unknown votes dropped", electKind([{ kind: "unknown", evidence: [makeEvidence("dom-tag", "r", "", 0.9)] }]) === null);
  check("isStrong floor semantics (>= 0.5 strong)", isStrong({ confidence: 0.5 }) && !isStrong({ confidence: 0.499 }));
}

// =====================================================================
console.log("\n[2] buildUnderstandingPage — synthetic captured page");
// A captured page: strong header + nav (3 links) and a WEAK container:
// id "stage" is the only hint (workspace token @0.45 < 0.5) — vision territory.
const SYN = [
  mk(0, "header", "app-header", { x: 0, y: 0, w: 1200, h: 60 }, { layout: { display: "flex", position: "static" } }),
  mk(1, "nav", "main-nav", { x: 20, y: 18, w: 300, h: 24 }, { parent: 0 }),
  mk(2, "a", "link", { x: 20, y: 18, w: 60, h: 24 }, { parent: 1 }),
  mk(3, "a", "link", { x: 90, y: 18, w: 60, h: 24 }, { parent: 1 }),
  mk(4, "a", "link", { x: 160, y: 18, w: 60, h: 24 }, { parent: 1 }),
  mk(5, "div", "panel-zone", { x: 0, y: 80, w: 1200, h: 400 }, { id: "stage", layout: { display: "block", position: "static" } }),
  mk(6, "div", "blob-a", { x: 10, y: 90, w: 380, h: 380 }, { parent: 5 }),
  mk(7, "div", "blob-b", { x: 410, y: 90, w: 380, h: 300 }, { parent: 5 }),
  mk(8, "div", "blob-c", { x: 810, y: 90, w: 380, h: 260 }, { parent: 5 }),
];
const synPage = { pageId: "synthetic-001", url: "https://synthetic.test/", dom: { elements: SYN }, styles: null, geometry: null, network: { entries: [] }, screenshotPath: tmpShot };

console.log("  [2a] deterministic classification + provenance + hierarchy (no-provider default)");
let u2a, u2aAgain;
{
  u2a = await buildUnderstandingPage(synPage);
  const header = comp(u2a, "header"), nav = comp(u2a, "navigation"), stage = u2a.components.find((c) => c.elementIndex === 5);
  check("page metrics from captured boxes", u2a.pageMetrics.width === 1200 && u2a.pageMetrics.height === 480 && u2a.pageMetrics.elements === 9, JSON.stringify(u2a.pageMetrics));
  check("header classified (tag + top-band geometry)", header && header.confidence >= 0.9 && hasEvidenceSource(header, "dom-tag") && hasEvidenceSource(header, "geometry"), `conf=${header?.confidence} sources=${evSources(header)}`);
  check("navigation classified (tag + class hint)", nav && nav.confidence >= 0.9 && hasEvidenceSource(nav, "dom-tag") && hasEvidenceSource(nav, "dom-class"), `conf=${nav?.confidence} sources=${evSources(nav)}`);
  check("provenance carries tag/cls/id/rect", header?.provenance.tag === "header" && header?.provenance.cls === "app-header" && header?.provenance.rect.w === 1200 && stage?.provenance.id === "stage", "");
  check("weak container stays deterministic workspace@<0.5 (no-provider fallback)", stage?.kind === "workspace" && stage.confidence < 0.5 && stage.confidence === 0.45, `kind=${stage?.kind} conf=${stage?.confidence}`);
  check("blob elements never became components (no semantic hint)", !u2a.components.some((c) => [6, 7, 8].includes(c.elementIndex)), u2a.components.map((c) => c.id).join(","));
  check("parent-child: header → navigation (containment)", u2a.relationships.parentChild.some((e) => e.parent === "u-0" && e.child === "u-1" && e.via === "containment"), JSON.stringify(u2a.relationships.parentChild));
  check("regions index maps kinds → component ids", JSON.stringify(u2a.regions.header) === JSON.stringify(["u-0"]) && JSON.stringify(u2a.regions.navigation) === JSON.stringify(["u-1"]), JSON.stringify(u2a.regions));
  check("every evidence record cites a known source with a ref", u2a.components.every((c) => c.evidence.every((e) => EVIDENCE_SOURCES.includes(e.source) && typeof e.ref === "string" && e.ref.length > 0 && e.weight > 0 && e.weight <= 1)), "");
  check("vision: 1 candidate found, fallback kept DOM verdicts, used=false", u2a.vision.candidates === 1 && u2a.vision.attempted === true && u2a.vision.screenshotFound === true && u2a.vision.classifications === 1 && u2a.vision.used === false, JSON.stringify(u2a.vision));
  u2aAgain = await buildUnderstandingPage(synPage);
  check("deterministic: identical input → identical model", JSON.stringify(u2a) === JSON.stringify(u2aAgain), "");
}

console.log("  [2b] vision hook: ONLY the deterministic-<0.5 container is overridable");
{
  const asked = [];
  const visionFn = async (region, imageBase64, ctx) => {
    asked.push({ index: ctx.index, domKind: ctx.domKind, domConfidence: ctx.domConfidence, imageBytes: imageBase64.length });
    if (ctx.index === 1) return { kind: "table", confidence: 0.95, reason: "mock: tries to flip a STRONG nav" };
    if (ctx.index === 5) return { kind: "card-grid", confidence: 0.92, reason: "mock: three blob tiles" };
    return null;
  };
  const u = await buildUnderstandingPage(synPage, { visionFn });
  const header = comp(u, "header"), nav = comp(u, "navigation"), stage = u.components.find((c) => c.elementIndex === 5);
  check("vision asked about classifyAmbiguous's candidates (stage + nav)", asked.map((a) => a.index).sort().join(",") === "1,5", asked.map((a) => a.index).join(","));
  check("full screenshot + region coords reach the visionFn", asked.every((a) => a.imageBytes > 0), JSON.stringify(asked.map((a) => a.index)));
  check("weak container FLIPS to vision kind (card-grid@0.92)", stage?.kind === "card-grid" && stage.confidence === 0.92, `kind=${stage?.kind} conf=${stage?.confidence}`);
  check("flipped component carries a vision evidence record", stage && hasEvidenceSource(stage, "vision") && stage.evidence.some((e) => e.source === "vision" && e.ref === "vision[5]"), evSources(stage).join(","));
  check("STRONG components keep DOM verdicts (nav table@0.95 ignored, header untouched)", nav?.kind === "navigation" && nav.confidence >= 0.9 && !hasEvidenceSource(nav, "vision") && header?.kind === "header" && !hasEvidenceSource(header, "vision"), `nav=${nav?.confidence} header=${header?.confidence}`);
  check("vision used=true reported", u.vision.used === true && u.vision.classifications === 1 && u.vision.candidates === 1, JSON.stringify(u.vision));
  check("regions index reflects the flip (stage left workspace, joined card-grid)", !u.regions.workspace?.includes("u-5") && u.regions["card-grid"]?.includes("u-5"), JSON.stringify(u.regions));
  check("ZERO NETWORK with injected visionFn", fetchAttempts.length === 0, `${fetchAttempts.length} attempts`);
}

console.log("  [2c] missing screenshot → vision skipped honestly");
{
  const u = await buildUnderstandingPage({ ...synPage, screenshotPath: null });
  const stage = u.components.find((c) => c.elementIndex === 5);
  check("no screenshot → no vision attempt", u.vision.attempted === false && u.vision.screenshotFound === false, JSON.stringify(u.vision));
  check("deterministic verdicts kept + warning recorded", stage?.kind === "workspace" && u.warnings.some((w) => /screenshot/i.test(w)), u.warnings.join(" | "));
}

// =====================================================================
console.log("\n[3] e2e multi-route fixture — navigation/workspace/table on real artifacts");
try {
  const { base, close } = await startFixtureServer(multiRouteSite);
  try {
    const { artifactsDir } = await runExplorationJob({
      url: base + "/",
      artifactsRoot: path.join(PROJECT, "artifacts"),
      config: { policy: { budgets: { maxRoutes: 4, maxStatesPerPage: 4, maxInteractionsPerState: 8, maxTotalTimeMs: 180000 } } },
    });
    check("exploration produced an artifact directory", fs.existsSync(path.join(artifactsDir, "manifest.json")), artifactsDir);
    const loaded = loadArtifacts(artifactsDir);
    check("artifact loader ok", loaded.ok === true && loaded.pages.length >= 2, `${loaded.pages.length} pages`);
    const pathnameOf = (p) => { try { return new URL(p.url).pathname; } catch { return null; } };
    const home = loaded.pages.find((p) => pathnameOf(p) === "/");
    const pricing = loaded.pages.find((p) => pathnameOf(p) === "/pricing");
    check("home + pricing pages captured", !!home && !!pricing, loaded.pages.map((p) => pathnameOf(p)).join(","));

    const uHome = await buildUnderstandingPage(pageArtifactsFromLoaded(home, artifactsDir));
    const nav = comp(uHome, "navigation");
    const ws = comp(uHome, "workspace");
    check("home: navigation classified with confidence + provenance", nav && nav.confidence >= 0.9 && nav.provenance.tag === "nav" && (nav.provenance.cls || "").includes("site-nav"), `conf=${nav?.confidence} tag=${nav?.provenance?.tag} cls=${nav?.provenance?.cls}`);
    check("home: navigation evidence spans dom-tag + dom-class + geometry", evSources(nav).join(",").includes("dom-tag") && evSources(nav).includes("geometry"), evSources(nav).join(","));
    check("home: main classified as workspace", ws && ws.provenance.tag === "main" && ws.confidence >= 0.8, `conf=${ws?.confidence}`);
    check("home: no vision consult needed (all components strong)", uHome.vision.candidates === 0 && uHome.vision.attempted === false, JSON.stringify(uHome.vision));
    check("home: regions index present", Array.isArray(uHome.regions.navigation) && Array.isArray(uHome.regions.workspace), JSON.stringify(Object.keys(uHome.regions)));

    const uPricing = await buildUnderstandingPage(pageArtifactsFromLoaded(pricing, artifactsDir));
    const table = comp(uPricing, "table");
    check("pricing: table classified with multi-source evidence", table && table.confidence >= 0.9 && table.provenance.tag === "table" && evSources(table).includes("dom-tag") && evSources(table).includes("geometry"), `conf=${table?.confidence} sources=${evSources(table)}`);
    check("pricing: workspace → table parent-child edge", uPricing.relationships.parentChild.some((e) => {
      const parent = uPricing.components.find((c) => c.id === e.parent);
      return parent?.kind === "workspace" && e.child === table?.id;
    }), JSON.stringify(uPricing.relationships.parentChild));
    check("pricing: navigation + workspace also present", !!comp(uPricing, "navigation") && !!comp(uPricing, "workspace"), uPricing.regions && Object.keys(uPricing.regions).join(","));

    // whole-directory convenience path (understandArtifactsDir) agrees
    const all = await understandArtifactsDir(artifactsDir);
    check("understandArtifactsDir covers every page", all.ok === true && all.pages.length === loaded.pages.length && all.pages.every((p) => p.understanding), `${all.pages.length} pages`);
    check("summarizeUnderstanding compact summary", (() => {
      const s = summarizeUnderstanding(all.pages.find((p) => p.pageId === home.pageId)?.understanding);
      return s && s.components === uHome.components.length && s.kinds.navigation === 1 && s.visionUsed === false;
    })(), JSON.stringify(summarizeUnderstanding(all.pages.find((p) => p.pageId === home.pageId)?.understanding)));
  } finally {
    await close();
  }
} catch (e) {
  check("multi-route e2e no unexpected crash", false, String(e?.stack || e).split("\n").slice(0, 3).join(" | "));
}

// =====================================================================
console.log("\n[4] e2e lazy-scroll gallery — card grid + repetition + network evidence");
try {
  const { base, close } = await startFixtureServer(lazyScrollSite);
  try {
    const { artifactsDir } = await runExplorationJob({
      url: base + "/",
      artifactsRoot: path.join(PROJECT, "artifacts"),
      config: { policy: { budgets: { maxRoutes: 1, maxStatesPerPage: 2, maxInteractionsPerState: 4, maxTotalTimeMs: 120000 } } },
    });
    const loaded = loadArtifacts(artifactsDir);
    const home = loaded.pages.find((p) => { try { return new URL(p.url).pathname === "/"; } catch { return false; } });
    check("lazy-scroll page captured", !!home, "");
    const u = await buildUnderstandingPage(pageArtifactsFromLoaded(home, artifactsDir));
    const cards = u.components.filter((c) => c.kind === "card");
    const grid = comp(u, "card-grid");
    check("card components detected (batch-0 feed = 5 photo cards)", cards.length === 5, `${cards.length} cards: ${cards.map((c) => c.id).join(",")}`);
    check("cards carry repetition evidence (component-tree-builder-compatible group)", cards.every((c) => hasEvidenceSource(c, "repetition") && c.repeated?.siblings === 5), cards.map((c) => `${c.id}:${evSources(c).join("+")}`).join(" "));
    check("feed container classified card-grid with confidence", grid && grid.confidence >= 0.6 && hasEvidenceSource(grid, "repetition"), `conf=${grid?.confidence} sources=${evSources(grid)}`);
    check("cards classified with confidence >= 0.85 (cls + repetition + geometry)", cards.every((c) => c.confidence >= 0.85), cards.map((c) => c.confidence).join(","));
    check("at least one card cites network evidence (media actually fetched)", cards.some((c) => hasEvidenceSource(c, "network")), cards.filter((c) => hasEvidenceSource(c, "network")).map((c) => c.id).join(","));
    check("network endpoints summarized (api fetch recorded)", u.interactions.networkEndpoints.some((e) => e.url === "/api/items"), JSON.stringify(u.interactions.networkEndpoints));
    check("repeatedGroups relationship: photo-card ×5 under the feed", u.relationships.repeatedGroups.some((g) => g.signature === "photo-card" && g.siblings === 5 && g.memberIndexes.length === 5 && g.containerComponentId === grid?.id), JSON.stringify(u.relationships.repeatedGroups));
    check("parent-child: cards are children of the card-grid container", u.relationships.parentChild.filter((e) => e.parent === grid?.id).length === 5, `${u.relationships.parentChild.length} edges`);
    check("main workspace present alongside the grid", !!comp(u, "workspace"), Object.keys(u.regions).join(","));
    check("no vision consult needed on this page", u.vision.candidates === 0 && u.vision.attempted === false, JSON.stringify(u.vision));
  } finally {
    await close();
  }
} catch (e) {
  check("lazy-scroll e2e no unexpected crash", false, String(e?.stack || e).split("\n").slice(0, 3).join(" | "));
}

// =====================================================================
console.log("\n[5] e2e Golden-Layout-style workspace — nested panes + splitters (served page)");
// A docked-workspace page created for this test: header bar with nav + toolbar,
// left sidebar dock, central workspace with nested panes joined by splitters,
// a canvas chart pane, a table pane, and a visible corner dialog.
const GOLDEN_HTML = `<!DOCTYPE html><html><head><title>Dockly — workspace shell</title><style>
body{font-family:Arial,Helvetica,sans-serif;margin:0;color:#223;background:#eef1f5}
.app-header{background:#20315b;color:#fff;display:flex;align-items:center;padding:0 20px;height:64px}
.app-header .brand{font-size:18px;font-weight:bold;margin-right:28px}
.main-nav a{color:#dfe6f2;margin-right:16px;text-decoration:none;font-size:14px}
.toolbar{display:flex;gap:8px;margin-left:auto}
.toolbar button{padding:8px 12px;font-size:13px}
.app-body{display:flex;min-height:460px;background:#fff}
.sidebar-left{width:220px;background:#f2f4f8;border-right:1px solid #ccd;padding:12px}
.shelf-row{padding:10px 8px;border-bottom:1px solid #dde;font-size:13px}
.workspace{flex:1;display:flex;flex-direction:column}
.pane{background:#fff;border:1px solid #ccd}
.pane-top{height:190px;overflow:auto}
.pane-bottom{flex:1;display:flex;flex-direction:row}
.splitter{background:#b9c2d0;flex:none}
.splitter-h{height:6px;width:100%}
.splitter-v{width:6px}
.pane-chart{flex:1;padding:10px}
.pane-notes{flex:1;padding:10px}
table{border-collapse:collapse;font-size:13px}
td,th{border:1px solid #99a;padding:6px 12px}
.modal-panel{position:fixed;right:24px;bottom:24px;width:280px;min-height:150px;background:#fff;border:2px solid #556;z-index:60;padding:14px}
</style></head><body>
<header class="app-header" role="banner">
  <div class="brand">Dockly</div>
  <nav class="main-nav"><a href="#views">Views</a><a href="#layouts">Layouts</a><a href="#windows">Windows</a></nav>
  <div class="toolbar" role="toolbar" aria-label="Layout actions"><button type="button">New layout</button><button type="button">Save layout</button><button type="button">Reset view</button></div>
</header>
<div class="app-body">
  <aside class="sidebar-left" aria-label="Dock">
    <div class="shelf-row">Orders feed</div><div class="shelf-row">Risk monitor</div><div class="shelf-row">Fills blotter</div>
  </aside>
  <main class="workspace">
    <div class="pane pane-top"><table><tr><th>Symbol</th><th>Bid</th><th>Ask</th></tr><tr><td>ESZ6</td><td>6021.25</td><td>6021.50</td></tr><tr><td>NQZ6</td><td>21784.00</td><td>21784.25</td></tr></table></div>
    <div class="splitter splitter-h"></div>
    <div class="pane pane-bottom">
      <div class="pane pane-chart"><canvas class="chart-canvas" width="420" height="140"></canvas></div>
      <div class="splitter splitter-v"></div>
      <div class="pane pane-notes"><p>Notes pane — drag splitters to resize; panes persist per layout.</p></div>
    </div>
  </main>
</div>
<div class="modal-panel" role="dialog" aria-label="Layout settings"><h2>Layout settings</h2><p>Grid snapping is on.</p><button type="button">Apply</button></div>
</body></html>`;
const goldenSite = {
  name: "golden-workspace",
  entry: "/",
  handle(req, res) {
    if (reqUrl(req).pathname === "/") { sendHtml(res, GOLDEN_HTML); return; }
    res.writeHead(404, { "content-type": "text/plain" });
    res.end("fixture: not found");
  },
};
try {
  const { base, close } = await startFixtureServer(goldenSite);
  try {
    const { artifactsDir } = await runExplorationJob({
      url: base + "/",
      artifactsRoot: path.join(PROJECT, "artifacts"),
      config: { policy: { budgets: { maxRoutes: 1, maxStatesPerPage: 3, maxInteractionsPerState: 6, maxTotalTimeMs: 120000 } } },
    });
    const loaded = loadArtifacts(artifactsDir);
    const home = loaded.pages.find((p) => { try { return new URL(p.url).pathname === "/"; } catch { return false; } });
    check("golden page captured", !!home, "");
    const u = await buildUnderstandingPage(pageArtifactsFromLoaded(home, artifactsDir));
    const kindsFound = Object.keys(u.regions).sort();
    for (const kind of ["header", "navigation", "sidebar", "toolbar", "workspace", "splitter", "modal"]) {
      const c = comp(u, kind);
      check(`golden: ${kind} classified (conf >= 0.7, provenance)`, !!c && c.confidence >= 0.7 && !!c.provenance.tag,
        c ? `conf=${c.confidence} tag=${c.provenance.tag} cls=${c.provenance.cls} sources=${evSources(c).join("+")}` : "MISSING");
    }
    // table/chart: target the SEMANTIC element (a "chart"-class pane div also
    // earns a weak class-hint chart vote; the canvas is the real chart)
    const ws = comp(u, "workspace");
    const table = u.components.find((c) => c.kind === "table" && c.provenance.tag === "table");
    const chart = u.components.find((c) => c.kind === "chart" && c.provenance.tag === "canvas");
    const modal = comp(u, "modal");
    check("golden: table classified (tag=table, dom-tag + geometry evidence)", !!table && table.confidence >= 0.9 && evSources(table).includes("dom-tag") && evSources(table).includes("geometry"),
      table ? `conf=${table.confidence} sources=${evSources(table).join("+")}` : "MISSING");
    check("golden: chart classified (tag=canvas, dom-tag evidence)", !!chart && chart.confidence >= 0.9 && evSources(chart).includes("dom-tag"),
      chart ? `conf=${chart.confidence} sources=${evSources(chart).join("+")}` : "MISSING");
    check("table cells/trs never became components (depth-limited vote)", !u.components.some((c) => ["tbody", "thead", "tr", "td", "th"].includes(String(c.provenance.tag))), u.components.map((c) => c.provenance.tag).join(","));
    check("modal carries css evidence (fixed + z-index)", modal && evSources(modal).includes("css"), evSources(modal).join(","));
    check("splitters: 2 detected (horizontal + vertical)", (u.regions.splitter || []).length === 2, JSON.stringify(u.regions.splitter));
    // ancestor walk through the component parent chain
    const isDescendantOf = (u, id, ancestorId) => {
      const byId = new Map(u.components.map((c) => [c.id, c]));
      for (let c = byId.get(id), seen = new Set(); c && !seen.has(c.id); c = byId.get(c.parentId)) {
        seen.add(c.id);
        if (c.id === ancestorId) return true;
      }
      return false;
    };
    check("workspace → table parent-child (through unclassified pane)", !!table && table.parentId === ws?.id, JSON.stringify(u.relationships.parentChild));
    check("chart canvas descends from workspace through component chain", !!chart && isDescendantOf(u, chart.id, ws?.id), `chart.parent=${chart?.parentId} ws=${ws?.id}`);
    check("header parents navigation AND toolbar", (() => {
      const header = comp(u, "header");
      const kids = u.relationships.parentChild.filter((e) => e.parent === header?.id).map((e) => u.components.find((c) => c.id === e.child)?.kind);
      return kids.includes("navigation") && kids.includes("toolbar");
    })(), JSON.stringify(u.relationships.parentChild));
    check("toolbar carries interaction trigger context (marked buttons)", (() => {
      const tb = comp(u, "toolbar");
      return tb && tb.interaction.triggers.length >= 2;
    })(), JSON.stringify(comp(u, "toolbar")?.interaction.triggers));
    check("all golden components strong → ZERO vision candidates (deterministic-only page)", u.vision.candidates === 0 && u.vision.attempted === false, JSON.stringify(u.vision));
    check("docked sidebar NOT confused with right-side panes", (u.regions.sidebar || []).length === 1, JSON.stringify(u.regions.sidebar));
    check("kind vocabulary covers every emitted kind", u.components.every((c) => REGION_KINDS.includes(c.kind)), kindsFound.join(","));
  } finally {
    await close();
  }
} catch (e) {
  check("golden workspace e2e no unexpected crash", false, String(e?.stack || e).split("\n").slice(0, 3).join(" | "));
}

// ---- zero-network verdict across the whole run ----
check("ZERO NETWORK: no fetch attempted during the entire suite", fetchAttempts.length === 0, fetchAttempts.length ? fetchAttempts.join("; ").slice(0, 200) : "0 attempts");

fs.rmSync(tmpShot, { force: true });
const resultPath = path.join(PROJECT, "artifacts", "test-website-understanding-result.json");
fs.mkdirSync(path.dirname(resultPath), { recursive: true });
fs.writeFileSync(resultPath, JSON.stringify({ pass, fail, fetchAttempts: fetchAttempts.length }, null, 2));
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
