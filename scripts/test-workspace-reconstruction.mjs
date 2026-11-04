process.env.CLONER_ALLOW_PRIVATE_TARGETS = "1"; // G5.3 SSRF guard: loopback fixture targets — documented opt-in (production default stays strict)
// Phase-3.4 workspace reconstruction e2e (task 3.4.2): a 3-pane dockable fixture
// (left sidebar with collapse+close, center tab group with 2 panels, right
// panel, two drag-resizable splitters) → exploration → workspace tree detection
// (evidence-gated) → reconstruction → project augmentation → Playwright behavior
// assertions on the CLONE: splitter drag resizing with min clamps, tab
// switching, close + reopen, collapse, and state preserved across reload.
//
// The evidence gate is additionally checked NEGATIVELY against a REAL explored
// flexbox page (the responsive fixture has no splitters and no tab groups) —
// detectWorkspace must return null there.
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import { chromium } from "playwright";
import { runExplorationJob } from "../src/pipeline/exploration-pipeline.js";
import { reconstructFromArtifacts } from "../src/reconstruction/reconstruction-pipeline.js";
import { loadArtifacts } from "../src/reconstruction/artifact-loader.js";
import { analyzeLayout } from "../src/reconstruction/analysis/layout-analyzer.js";
import { buildUnderstandingPage } from "../src/reconstruction/website-understanding.js";
import { detectWorkspace, summarizeWorkspace, normalizeContainment } from "../src/reconstruction/workspace-analyzer.js";
import {
  workspaceCss,
  workspaceConfig,
  extendRuntimeWorkspace,
  augmentProjectWithWorkspace,
  dockControlIndexes,
  WORKSPACE_RUNTIME_MARK,
} from "../src/reconstruction/docking-layout-builder.js";
import { buildRuntime } from "../src/runtimeTemplate.js";
import { workspaceDockSite } from "./fixtures/workspace-dock.mjs";
import { responsivePageSite } from "./fixtures/responsive-page.mjs";
import { startFixtureServer } from "./fixtures/server.mjs";

const ROOT = path.resolve(".");
let pass = 0, fail = 0;
const check = (name, ok, detail = "") => { console.log(`  ${ok ? "PASS" : "FAIL"} ${name}${detail ? " — " + detail : ""}`); ok ? pass++ : fail++; };
const approx = (a, b, tol) => Math.abs(a - b) <= tol;

// ---------- synthetic element helpers (pure unit checks) ----------
const mk = (i, tag, cls, parent, rect, extra = {}) => ({ i, tag, cls, parent, rect, style: extra.style || {}, text: extra.text ?? null, id: extra.id ?? null, role: extra.role ?? null });

console.log("\n[1] evidence gate + tree detection (pure inference)");
{
  // ordinary flexbox page — no splitters, no tab groups → null
  const flex = [
    mk(0, "div", "cards", null, { x: 0, y: 0, w: 1200, h: 400 }),
    mk(1, "article", "card", 0, { x: 0, y: 0, w: 380, h: 380 }, { text: "a" }),
    mk(2, "article", "card", 0, { x: 400, y: 0, w: 380, h: 380 }, { text: "b" }),
    mk(3, "article", "card", 0, { x: 800, y: 0, w: 380, h: 380 }, { text: "c" }),
  ];
  check("ordinary flexbox page → detectWorkspace null (gate)", detectWorkspace(flex, null, null) === null, "");

  // 3-pane row dock with two 6px splitters
  const dock = [
    mk(0, "div", "dock", null, { x: 0, y: 0, w: 1200, h: 600 }),
    mk(1, "div", "pane-a", 0, { x: 0, y: 0, w: 200, h: 600 }),
    mk(2, "div", "divider", 0, { x: 200, y: 0, w: 6, h: 600 }),
    mk(3, "div", "pane-b", 0, { x: 206, y: 0, w: 700, h: 600 }),
    mk(4, "div", "divider", 0, { x: 906, y: 0, w: 6, h: 600 }),
    mk(5, "div", "pane-c", 0, { x: 912, y: 0, w: 288, h: 600 }),
  ];
  const t = detectWorkspace(dock, null, null);
  check("dock page → row tree with 3 panes", !!t && t.kind === "row" && t.children.length === 3 && t.children.every((c) => c.kind === "pane"), t ? summarizeWorkspace(t).kinds : "null");
  check("gate evidence counts", !!t && t.gate.splitters === 2 && t.gate.tabGroups === 0, t ? JSON.stringify(t.gate) : "—");
  check("splitters located with captured 6px thickness", !!t && t.splitters.join(",") === "2,4" && t.splitterPx.join(",") === "6,6", t ? `${t.splitters} @ ${t.splitterPx}px` : "—");
  check("sizes are usable-based percentages summing to 100", !!t && Math.abs(t.sizes.reduce((a, b) => a + b, 0) - 100) < 0.02 && approx(t.sizes[0], 200 / 1188 * 100, 0.1), t ? t.sizes.join("/") : "—");

  // thin strip WITHOUT two pane neighbors is not docking evidence
  const edge = [
    mk(0, "div", "page", null, { x: 0, y: 0, w: 1200, h: 600 }),
    mk(1, "div", "content", 0, { x: 0, y: 0, w: 1194, h: 600 }),
    mk(2, "div", "scrollrail", 0, { x: 1194, y: 0, w: 6, h: 600 }), // right edge — one neighbor only
  ];
  check("edge thin strip without pane neighbors → null", detectWorkspace(edge, null, null) === null, "");

  // tab group: lm_active token drives activeTab
  const tabsEls = [
    mk(0, "div", "center", null, { x: 0, y: 0, w: 868, h: 822 }),
    mk(1, "div", "tabstrip", 0, { x: 0, y: 0, w: 868, h: 36 }),
    mk(2, "div", "tab lm_active", 1, { x: 0, y: 4, w: 80, h: 28 }, { text: "Orders" }),
    mk(3, "div", "tab", 1, { x: 80, y: 4, w: 90, h: 28 }, { text: "Positions" }),
    mk(4, "div", "tabstack", 0, { x: 0, y: 36, w: 868, h: 786 }),
    mk(5, "div", "panel a", 4, { x: 0, y: 36, w: 868, h: 786 }, { style: { opacity: "1" } }),
    mk(6, "div", "panel b", 4, { x: 0, y: 36, w: 868, h: 786 }, { style: { opacity: "0" } }),
  ];
  const tt = detectWorkspace(tabsEls, null, null);
  check("tab group alone passes the gate → tabs root", !!tt && tt.kind === "tabs", tt ? summarizeWorkspace(tt).root : "null");
  check("activeTab from .lm_active token, labels kept", !!tt && tt.activeTab === 0 && tt.tabs[0].label === "Orders" && tt.tabs[1].label === "Positions", tt ? `active=${tt.activeTab}` : "—");
  check("stacked panels mapped in document order", !!tt && tt.tabs[0].panelElementIndex === tt.children[0] && tt.tabs[1].panelElementIndex === tt.children[1], tt ? `${tt.children}` : "—");
  check("hidden panel evidence (opacity 0) → visiblePanelIndex", !!tt && tt.visiblePanelIndex === 0, tt ? String(tt.visiblePanelIndex) : "—");

  // fewer captured panels than tabs (display:none panels never reach dom.json)
  const fewer = tabsEls.slice(0, 6); // drop panel b
  const tf = detectWorkspace(fewer, null, null);
  check("fewer panels than tabs → detected via the relaxed bar (active marker)", !!tf && tf.kind === "tabs" && tf.children.length === 1 && (tf.notes || []).some((n) => /display:none panels never reach dom\.json/.test(n)), tf ? (tf.notes || []).join("; ") : "null");

  // relaxed bar must NOT fire without the active-tab marker (nav false positive)
  const noMarker = tabsEls.slice(0, 6).map((e) => (e.i === 2 ? { ...e, cls: "tab" } : e));
  check("relaxed bar without an active-tab marker → null", detectWorkspace(noMarker, null, null) === null, "");

  // normalizeContainment: geometric-containment 2-cycles on equal-box docking
  // stacks are repaired deterministically (container = earlier document order)
  const cyc = [
    mk(0, "div", "pane", null, { x: 0, y: 0, w: 900, h: 860 }),
    mk(1, "div", "tabstack", 0, { x: 0, y: 0, w: 868, h: 822 }),
    mk(2, "div", "panel-a", 1, { x: 0, y: 0, w: 868, h: 822 }), // same box as tabstack…
    mk(3, "div", "content", 2, { x: 10, y: 10, w: 400, h: 100 }),
  ];
  cyc[1].parent = 2; // tabstack → panel-a …and panel-a → tabstack: 2-cycle
  const fixed = normalizeContainment(cyc);
  const f1 = fixed.find((e) => e.i === 1), f2 = fixed.find((e) => e.i === 2);
  check("normalizeContainment breaks the 2-cycle (later element keeps the container)", f2.parent === 1 && f1.parent === 0, `tabstack.parent=${f1.parent} panel.parent=${f2.parent}`);
  check("normalizeContainment leaves acyclic input untouched", (() => {
    const ok = tabsEls.map((e) => e.parent);
    const out = normalizeContainment(tabsEls).map((e) => e.parent);
    return JSON.stringify(ok) === JSON.stringify(out);
  })(), "");

  // understanding corroboration: splitter flag strengthens confidence, never creates it
  const noU = detectWorkspace(dock, null, null);
  const withU = detectWorkspace(dock, null, {
    components: [
      { elementIndex: 2, kind: "splitter", confidence: 0.5 },
      { elementIndex: 4, kind: "splitter", confidence: 0.5 },
      { elementIndex: 1, kind: "sidebar", confidence: 0.6 },
    ],
    regions: { splitter: ["u-2", "u-4"] },
  });
  check("understanding adds corroboration evidence (never structure)", !!withU && withU.evidence.some((e) => e.source === "understanding") && withU.confidence > noU.confidence, `${noU.confidence} → ${withU.confidence}`);
  check("understanding region label carried on the pane", withU.children[0].region === "sidebar", withU.children[0].region || "none");
}

// ---------- fixture server + exploration ----------
console.log("\n[2] exploration of the dockable-workspace fixture");
const site = await startFixtureServer(workspaceDockSite);
const { jobId, artifactsDir, manifest } = await runExplorationJob({
  url: site.base + "/",
  artifactsRoot: path.join(ROOT, "artifacts"),
  config: { policy: { budgets: { maxRoutes: 1, maxStatesPerPage: 4, maxInteractionsPerState: 8, maxTotalTimeMs: 150000 } } },
});
check("exploration completed", manifest.status === "completed", manifest.status);
check("one page explored (maxRoutes=1)", manifest.coverage.routesExplored === 1, String(manifest.coverage.routesExplored));

// ---------- workspace detection on the REAL captured artifacts ----------
console.log("\n[3] workspace tree from the captured artifacts (understanding + layout)");
const loaded = loadArtifacts(artifactsDir);
const lp = loaded.pages[0];
const els = lp.elements || [];
// FINDING (task 3.4.1 robustness, reported to the integration agent): the
// extractor's geometric containment yields 2-cycled parent links when a stack
// container and its panes share a box; buildUnderstandingPage's descendants()
// walk (src/reconstruction/website-understanding.js:122-129) has no cycle guard
// and dies with RangeError: Invalid array length. This fixture uses
// incomparable panel boxes so the real capture is acyclic, but the sanitizer is
// kept (and unit-tested above) so this path is hardened end-to-end; the
// website-understanding.js guard itself is 3.4.1's file to fix, not ours.
const elsNorm = normalizeContainment(els);
const rectMap = new Map(els.map((e) => [e.i, { x: e.rect.x, y: e.rect.y, width: e.rect.w, height: e.rect.h }]));
const layout = analyzeLayout(els, rectMap);
const understanding = await buildUnderstandingPage(
  {
    pageId: lp.pageId,
    url: lp.url,
    dom: { ...lp.dom, elements: elsNorm },
    styles: lp.styles,
    geometry: lp.geometry,
    network: lp.network,
    screenshotPath: lp.screenshotRef ? path.join(artifactsDir, lp.screenshotRef) : null,
  },
  {},
);
check("understanding model builds on the captured page", understanding.components.length > 5, `${understanding.components.length} component(s)`);
const tree = detectWorkspace(els, layout, understanding); // raw els — the analyzer normalizes internally
check("workspace tree detected from real dom.json (gate passed)", !!tree, tree ? summarizeWorkspace(tree).root + " gate=" + JSON.stringify(summarizeWorkspace(tree).gate) : "null");
check("gate: 2 splitters + 1 tab group", !!tree && tree.gate.splitters === 2 && tree.gate.tabGroups === 1, tree ? JSON.stringify(tree.gate) : "—");
check("root = row dock container with 3 segments", !!tree && tree.kind === "row" && tree.children.length === 3, tree ? tree.children.map((c) => c.kind).join(",") : "—");
check("splitters: 2 bars at captured 6px", !!tree && tree.splitters.length === 2 && tree.splitterPx.join(",") === "6,6", tree ? `${tree.splitters.join(",")} @ ${tree.splitterPx.join(",")}px` : "—");
check("pane sizes from captured rects (18.2/60.8/21.0, sum 100)", !!tree && approx(tree.sizes[0], 18.21, 0.5) && approx(tree.sizes[1], 60.78, 0.5) && approx(tree.sizes[2], 21.01, 0.5) && Math.abs(tree.sizes.reduce((a, b) => a + b, 0) - 100) < 0.02, tree ? tree.sizes.join("/") : "—");
const [left, tabsNode, right] = tree ? tree.children : [null, null, null];
check("left pane carries close + collapse affordances", !!left && left.kind === "pane" && left.close != null && left.collapse != null, left ? `close=${left.close} collapse=${left.collapse}` : "—");
check("right pane carries a close affordance only", !!right && right.kind === "pane" && right.close != null && right.collapse == null, right ? `close=${right.close}` : "—");
check("center segment is a tabs group (strip + stack, 2 tabs, 2 panels)", !!tabsNode && tabsNode.kind === "tabs" && tabsNode.tabs.length === 2 && tabsNode.children.length === 2, tabsNode ? `strip=${tabsNode.strip} stack=${tabsNode.stack}` : "—");
check("activeTab from the captured .active class (Orders first)", !!tabsNode && tabsNode.activeTab === 0 && tabsNode.tabs[0].label === "Orders" && tabsNode.tabs[1].label === "Positions", tabsNode ? tabsNode.tabs.map((t) => t.label + (tabsNode.tabs[tabsNode.activeTab] === t ? "*" : "")).join(", ") : "—");
check("tab→panel mapping preserves document order", !!tabsNode && tabsNode.tabs[0].panelElementIndex === tabsNode.children[0] && tabsNode.tabs[1].panelElementIndex === tabsNode.children[1], tabsNode ? JSON.stringify(tabsNode.children) : "—");
check("inactive-panel visibility evidence (opacity 0) read from dom.json", !!tabsNode && tabsNode.visiblePanelIndex === 0, tabsNode ? String(tabsNode.visiblePanelIndex) : "—");
check("layout (analyzeLayout) corroborates the dock flex containers", !!tree && tree.evidence.some((e) => e.source === "css"), tree ? tree.evidence.map((e) => e.source).join(",") : "—");
check("understanding (3.4.1) corroborates splitters/region", !!tree && tree.evidence.some((e) => e.source === "understanding") && left?.region === "sidebar", tree ? left?.region || "no region" : "—");

// ---------- reconstruction + augmentation ----------
console.log("\n[4] reconstruct + augment the generated project");
const outDir = path.join(ROOT, "artifacts", jobId + "-project");
const rec = await reconstructFromArtifacts(artifactsDir, { outDir, interactionRecords: [] });
check("reconstruction ok", rec.ok === true, "rounds: " + rec.report.rounds.length);
const genFiles = (rec.report.validation || []).map((v) => v.file).filter(Boolean);
const aug = augmentProjectWithWorkspace(outDir, tree, { pages: genFiles, minW: 140, minH: 110, railPx: 28 });
check("styles/workspace.css written", aug.applied && fs.existsSync(path.join(outDir, "styles", "workspace.css")), aug.cssFile || "missing");
check("every dock element stamped (no misses)", aug.applied && aug.notes.length === 0, aug.notes.join("; ") || `${aug.wired} element(s) wired`);
const indexHtml = fs.readFileSync(path.join(outDir, "index.html"), "utf8");
const linkPos = indexHtml.indexOf('href="styles/workspace.css"');
const compPos = indexHtml.indexOf('href="styles/components.css"');
check("workspace.css linked after components.css (cascade wins)", linkPos > compPos && compPos > 0, `components@${compPos} workspace@${linkPos}`);
const cfgPos = indexHtml.indexOf("window.__CLONER_WORKSPACE");
const rtPos = indexHtml.indexOf('src="runtime/interactions.js"');
check("inline workspace config injected before the runtime", cfgPos > 0 && rtPos > 0 && cfgPos < rtPos, `config@${cfgPos} runtime@${rtPos}`);
const runtimeSrc = fs.readFileSync(path.join(outDir, "runtime", "interactions.js"), "utf8");
check("runtime/interactions.js extended with the workspace behaviors", runtimeSrc.includes(WORKSPACE_RUNTIME_MARK), "");
for (const [name, needle, min] of [
  ["data-ws-root", "data-ws-root=", 1],
  ["data-ws-splitter", "data-ws-splitter=", 2],
  ["data-ws-tab", "data-ws-tab=", 2],
  ["data-ws-panel", "data-ws-panel=", 2],
  ["data-ws-close", "data-ws-close=", 2],
  ["data-ws-collapse", "data-ws-collapse=", 1],
]) {
  const n = indexHtml.split(needle).length - 1;
  check(`${name} stamped (${min}+)`, n >= min, String(n));
}
check("pane title carried for the reopen affordance", indexHtml.includes("data-ws-title=") && /data-ws-title="[^"]*Watchlist"/.test(indexHtml), "");
const controls = new Set(dockControlIndexes(tree));
let recs = [];
try { recs = JSON.parse(runtimeSrc.match(/^window\.__CLONER_INTERACTIONS = (.*);$/m)[1]); } catch {}
check("no replay records left on dock controls", recs.every((r) => !controls.has(r.domIndex)), `${recs.length} record(s) total, ${recs.filter((r) => controls.has(r.domIndex)).length} on dock controls`);
check("dock controls carry no replay attrs", !controlsHasReplay(indexHtml, controls), "");
check("dock CSS carries captured splitter thickness + basis sizes", /flex: 0 0 6px/.test(fs.readFileSync(path.join(outDir, "styles", "workspace.css"), "utf8")), "");

// ---------- clone serving ----------
const cloneSrv = http.createServer((req, res) => {
  const rel = decodeURIComponent((req.url || "/").split("?")[0]).replace(/^\/+/, "") || "index.html";
  const fp = path.join(outDir, rel);
  if (!fp.startsWith(outDir) || !fs.existsSync(fp) || !fs.statSync(fp).isFile()) { res.writeHead(404); res.end("nf"); return; }
  const types = { ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8" };
  res.writeHead(200, { "content-type": types[path.extname(fp)] || "application/octet-stream" });
  res.end(fs.readFileSync(fp));
});
await new Promise((r) => cloneSrv.listen(0, "127.0.0.1", r));
const cloneBase = "http://127.0.0.1:" + cloneSrv.address().port;

// ---------- Playwright behavior on the CLONE ----------
console.log("\n[5] Playwright behavior on the generated clone (1440x900)");
const browser = await chromium.launch({ headless: true }).catch(() => chromium.launch({ headless: true, channel: "msedge" }));
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await ctx.newPage();
await page.goto(cloneBase + "/", { waitUntil: "load" });
await page.waitForTimeout(300);

// dynamic selectors — all derived from the detected tree, never hard-coded
const leftSel = ".cx-" + left.elementIndex;
const tabsSel = ".cx-" + tabsNode.elementIndex;
const rightSel = ".cx-" + right.elementIndex;
const sp0Sel = ".cx-" + tree.splitters[0];
const sp1Sel = ".cx-" + tree.splitters[1];
const tabSels = tabsNode.tabs.map((t) => ".cx-" + t.elementIndex);
const panelSels = tabsNode.children.map((i) => ".cx-" + i);
const closeLeftSel = ".cx-" + left.close;
const closeRightSel = ".cx-" + right.close;
const collapseSel = ".cx-" + left.collapse;

const widthOf = (sel) => page.$eval(sel, (el) => Math.round(el.getBoundingClientRect().width));
const shown = (sel) => page.$eval(sel, (el) => {
  const cs = getComputedStyle(el);
  return cs.display !== "none" && cs.visibility !== "hidden" && parseFloat(cs.opacity || "1") > 0.1;
});
const dragSplitter = async (sel, dx) => {
  const box = await page.locator(sel).boundingBox();
  const cx = box.x + box.width / 2, cy = box.y + box.height / 2;
  await page.mouse.move(cx, cy);
  await page.mouse.down();
  await page.mouse.move(cx + dx, cy, { steps: 8 });
  await page.mouse.up();
  await page.waitForTimeout(150);
};

check("initial: left pane ≈ captured 260px", approx(await widthOf(leftSel), 260, 8), (await widthOf(leftSel)) + "px");
check("initial: center pane ≈ captured 868px", approx(await widthOf(tabsSel), 868, 8), (await widthOf(tabsSel)) + "px");
check("initial: right pane ≈ captured 300px", approx(await widthOf(rightSel), 300, 8), (await widthOf(rightSel)) + "px");
check("initial: Orders panel visible, Positions hidden", (await shown(panelSels[0])) && !(await shown(panelSels[1])), "");
check("initial: active tab marked on the captured-active tab", await page.$eval(tabSels[0], (el) => el.getAttribute("data-ws-active") === "1") && !(await page.$eval(tabSels[1], (el) => el.hasAttribute("data-ws-active"))), "");

// tab switch — correct panel becomes visible
await page.click(tabSels[1]);
await page.waitForTimeout(150);
check("tab switch → Positions panel visible, Orders hidden", (await shown(panelSels[1])) && !(await shown(panelSels[0])), "");
check("tab switch → active marker moved to the Positions tab", await page.$eval(tabSels[1], (el) => el.getAttribute("data-ws-active") === "1"), "");
check("tab switch → Positions content actually shown", await page.$eval(panelSels[1], (el) => /Open positions blotter/.test(el.textContent)), "");
await page.click(tabSels[0]);
await page.waitForTimeout(150);
check("switch back → Orders visible again", (await shown(panelSels[0])) && !(await shown(panelSels[1])), "");

// splitter drag resizes the adjacent panes
const dragBase = [await widthOf(leftSel), await widthOf(tabsSel), await widthOf(rightSel)];
await dragSplitter(sp0Sel, 100);
const dragAfter = [await widthOf(leftSel), await widthOf(tabsSel), await widthOf(rightSel)];
check("drag splitter 1 → left grows ~100px", dragAfter[0] - dragBase[0] >= 80, `${dragBase[0]}→${dragAfter[0]}`);
check("drag splitter 1 → center shrinks ~100px", dragBase[1] - dragAfter[1] >= 80, `${dragBase[1]}→${dragAfter[1]}`);
check("drag splitter 1 → right pane unaffected", Math.abs(dragAfter[2] - dragBase[2]) <= 3, `${dragBase[2]}→${dragAfter[2]}`);
const beforeClamp = await widthOf(leftSel);
await dragSplitter(sp0Sel, -700);
const clamped = await widthOf(leftSel);
check("min-size clamp holds at minW=140px", approx(clamped, 140, 6), `${beforeClamp}→${clamped}`);
const centerAfterClamp = await widthOf(tabsSel);
check("clamped drag → center absorbed the remainder (pair total kept)", approx(dragBase[0] + dragBase[1], clamped + centerAfterClamp, 6), `left+center ${dragBase[0] + dragBase[1]} → ${clamped + centerAfterClamp}`);

// splitter 2 drag resizes center/right
const c0 = await widthOf(tabsSel), r0 = await widthOf(rightSel);
await dragSplitter(sp1Sel, -80);
check("drag splitter 2 → right grows, center shrinks", (await widthOf(rightSel)) - r0 >= 60 && c0 - (await widthOf(tabsSel)) >= 60, `center ${c0}→${await widthOf(tabsSel)}, right ${r0}→${await widthOf(rightSel)}`);

// close + reopen (right pane)
const rightW = await widthOf(rightSel);
await page.click(closeRightSel);
await page.waitForTimeout(150);
check("close ✕ hides the pane", !(await shown(rightSel)), "display=" + (await page.$eval(rightSel, (el) => getComputedStyle(el).display)));
const reopenSel = '[data-cloner-reopen="' + right.elementIndex + '"]';
check("reopen affordance appears for the closed pane", (await page.$(reopenSel)) !== null, reopenSel);
await page.click(reopenSel);
await page.waitForTimeout(150);
check("reopen restores the pane at its size", (await shown(rightSel)) && approx(await widthOf(rightSel), rightW, 8), (await widthOf(rightSel)) + "px");
check("reopen affordance removed after restore", (await page.$(reopenSel)) === null, "");

// collapse + restore (left pane)
const preCollapseW = await widthOf(leftSel);
await page.click(collapseSel);
await page.waitForTimeout(150);
check("collapse shrinks the pane to the 28px rail", approx(await widthOf(leftSel), 28, 3), (await widthOf(leftSel)) + "px");
await page.click(collapseSel);
await page.waitForTimeout(150);
check("uncollapse restores the pane width", approx(await widthOf(leftSel), preCollapseW, 6), `${preCollapseW}→${await widthOf(leftSel)}`);

// state persistence across reload — set a distinctive state first
await dragSplitter(sp0Sel, 60);
await page.click(tabSels[1]);
await page.click(closeRightSel);
await page.waitForTimeout(150);
const stateBefore = {
  left: await widthOf(leftSel),
  center: await widthOf(tabsSel),
  positionsVisible: await shown(panelSels[1]),
  rightHidden: !(await shown(rightSel)),
};
await page.reload({ waitUntil: "load" });
await page.waitForTimeout(350);
check("reload → splitter sizes preserved", approx(await widthOf(leftSel), stateBefore.left, 4) && approx(await widthOf(tabsSel), stateBefore.center, 4), `left ${stateBefore.left}→${await widthOf(leftSel)}`);
check("reload → active tab preserved (Positions visible, Orders hidden)", (await shown(panelSels[1])) === stateBefore.positionsVisible && !(await shown(panelSels[0])), "");
check("reload → closed pane still hidden + reopen affordance present", stateBefore.rightHidden && !(await shown(rightSel)) && (await page.$(reopenSel)) !== null, "");
await page.click(reopenSel);
await page.waitForTimeout(120);
check("reopen still works after reload", await shown(rightSel), "");

// parity with the ORIGINAL fixture (light): same initial geometry + tab behavior.
// A FRESH tab is used for the clone: sessionStorage (the persisted workspace
// state) is tab-scoped, so the new tab loads the pristine captured state —
// directly comparable to a fresh load of the original.
console.log("\n[6] clone vs original parity (initial geometry + tab switch)");
const clone2 = await ctx.newPage();
await clone2.setViewportSize({ width: 1440, height: 900 });
await clone2.goto(cloneBase + "/", { waitUntil: "load" });
await clone2.waitForTimeout(300);
const orig = await ctx.newPage();
await orig.setViewportSize({ width: 1440, height: 900 });
await orig.goto(site.base + "/", { waitUntil: "load" });
await orig.waitForTimeout(300);
const oWidths = await orig.evaluate(() => ["#pane-left", ".pane-center", "#pane-right"].map((s) => Math.round(document.querySelector(s).getBoundingClientRect().width)));
const cWidthOf = (sel) => clone2.$eval(sel, (el) => Math.round(el.getBoundingClientRect().width));
const cShown = (sel) => clone2.$eval(sel, (el) => {
  const cs = getComputedStyle(el);
  return cs.display !== "none" && cs.visibility !== "hidden" && parseFloat(cs.opacity || "1") > 0.1;
});
const cWidths = [await cWidthOf(leftSel), await cWidthOf(tabsSel), await cWidthOf(rightSel)];
check("initial pane widths match the original (±8px)", oWidths.every((w, i) => Math.abs(w - cWidths[i]) <= 8), `original ${oWidths.join("/")} vs clone ${cWidths.join("/")}`);
await orig.click('.tab[data-panel="positions"]');
await clone2.click(tabSels[1]);
await orig.waitForTimeout(150);
await clone2.waitForTimeout(150);
const oShow = await orig.evaluate(() => {
  const vis = (s) => { const cs = getComputedStyle(document.querySelector(s)); return cs.display !== "none" && cs.visibility !== "hidden" && parseFloat(cs.opacity || "1") > 0.1; };
  return [vis("#panel-orders"), vis("#panel-positions")];
});
const cShow = [await cShown(panelSels[0]), await cShown(panelSels[1])];
check("tab switch parity: same panel visibility mapping as the original", oShow[0] === cShow[0] && oShow[1] === cShow[1], `original orders/positions=${oShow} clone=${cShow}`);
await orig.close();
await clone2.close();

await ctx.close();
await browser.close();

// ---------- NEGATIVE gate against a REAL explored flexbox page ----------
console.log("\n[7] evidence gate — negative check on a real flexbox exploration");
const site2 = await startFixtureServer(responsivePageSite);
const job2 = await runExplorationJob({
  url: site2.base + "/",
  artifactsRoot: path.join(ROOT, "artifacts"),
  config: { policy: { budgets: { maxRoutes: 1, maxStatesPerPage: 2, maxInteractionsPerState: 4, maxTotalTimeMs: 90000 } } },
});
const loaded2 = loadArtifacts(job2.artifactsDir);
const lp2 = loaded2.pages[0];
const els2 = normalizeContainment(lp2.elements || []);
const rectMap2 = new Map(els2.map((e) => [e.i, { x: e.rect.x, y: e.rect.y, width: e.rect.w, height: e.rect.h }]));
const u2 = await buildUnderstandingPage(
  {
    pageId: lp2.pageId,
    url: lp2.url,
    dom: { ...lp2.dom, elements: els2 },
    styles: lp2.styles,
    geometry: lp2.geometry,
    network: lp2.network,
    screenshotPath: lp2.screenshotRef ? path.join(job2.artifactsDir, lp2.screenshotRef) : null,
  },
  {},
);
const tree2 = detectWorkspace(els2, analyzeLayout(els2, rectMap2), u2);
check("real flexbox page (responsive fixture) → detectWorkspace null", els2.length > 10 && tree2 === null, `${els2.length} elements → ${tree2 ? "tree (BAD)" : "null"}`);
await site2.close();

// ---------- runtime hook contract (pure) ----------
console.log("\n[8] extendRuntimeWorkspace integration hook");
{
  const base = buildRuntime([]);
  const ext = extendRuntimeWorkspace(base);
  check("hook: appends the workspace IIFE to the built runtime", ext.startsWith(base) && ext.includes(WORKSPACE_RUNTIME_MARK), "");
  check("hook: idempotent (second call is a no-op)", extendRuntimeWorkspace(ext) === ext, "");
  check("hook: behaviors bind to stamped attrs (generalized, not lm_*)", ext.includes("[data-ws-splitter]") && ext.includes("[data-ws-tab]") && ext.includes("[data-ws-close]"), "");
  check("hook: runtime guards on the stamped root (no-op without it)", ext.includes('if (!document.querySelector("[data-ws-root]")) return;') && ext.includes("window.__CLONER_WORKSPACE || {}"), "");
  const cfg = workspaceConfig(tree, { minW: 140 });
  check("config: titles + stacks + persist derived from the tree", cfg.persist === true && cfg.minW === 140 && cfg.stacks.length === 1 && cfg.stacks[0].key === String(tabsNode.stack) && cfg.stacks[0].active === 0 && Object.keys(cfg.titles).length === 2, JSON.stringify(cfg.stacks));
  check("css: no workspace rules without a tree", workspaceCss(null).includes("no workspace evidence"), "");
}

// ---------- cleanup + summary ----------
await new Promise((r) => cloneSrv.close(r));
await site.close();
console.log(`\n${pass} passed, ${fail} failed`);
fs.writeFileSync(path.join(ROOT, "artifacts", "test-workspace-reconstruction-result.json"), JSON.stringify({
  pass, fail, jobId,
  tree: summarizeWorkspace(tree),
  sizes: tree?.sizes ?? null,
  gate: tree?.gate ?? null,
  augment: aug,
  stateBeforeReload: stateBefore,
}, null, 2));
process.exit(fail ? 1 : 0);

// controls must not carry recorded replay attrs in the generated HTML
function controlsHasReplay(html, controlSet) {
  for (const cx of controlSet) {
    const m = new RegExp("cx-" + cx + '(?=[" ])').exec(html);
    if (!m) continue;
    const start = html.lastIndexOf("<", m.index);
    const end = html.indexOf(">", m.index);
    if (start < 0 || end < 0) continue;
    const tag = html.slice(start, end + 1);
    if (/data-(cloner-trigger|replay-id)=/.test(tag)) return true;
  }
  return false;
}
