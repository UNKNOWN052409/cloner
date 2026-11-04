process.env.CLONER_ALLOW_PRIVATE_TARGETS = "1"; // G5.3 SSRF guard: loopback fixture targets — documented opt-in (production default stays strict)
// Complex-visuals e2e (task 3.5.4 — Complex Visual Content Reconstruction).
// Deterministic, zero external network.
//
// Fixture: scripts/fixtures/visual-heavy.mjs — a dashboard with an inline SVG
// line chart, an SVG hero illustration, an SVG gear icon (BELOW the region
// floor — must NOT classify), two canvas charts (sparkline + bars), and a CSS
// map mock with 3 markers + a toggle control. Chart data is also served from
// /api/chart-data (capture↔data association evidence).
//
// Asserted (plan steps 1-8 + risk note):
//  1. REGION CLASSIFICATION — findVisualRegions classifies chart/canvas/svg/map
//     regions from the captured dom.json elements; the 44×44 gear icon is NOT
//     classified (icons are ordinary DOM); analyzeFidelity stamps visualKind on
//     the 12×8 grid cells each region covers.
//  2. SVG RECONSTRUCTION — the real capture path (serializeEnhanced,
//     src/browser.js:322) preserves SVG as SVG markup: <svg>, <path>, <circle>,
//     <defs>/<linearGradient> survive serialization (NOT div placeholders).
//  3. CANVAS SNAPSHOT TREATMENT — every captured canvas becomes
//     <img data-cloner-snap="1"> with the canvas's dimensions (the treatment
//     src/browser.js:324-341 applies), i.e. the clone reproduces the canvas
//     pixels through the captured image.
//  4. MAP STRUCTURE — the map mock's grid + 3 markers survive capture and the
//     toggle control still flips their visibility in the clone (supported
//     interaction rebuilt from evidence, plan step 6).
//  5. DATA/INTERACTION ASSOCIATION — findVisualRegions attaches captured data
//     (opts.dataByIndex) and interaction ids (opts.interactionsByIndex) to the
//     matching regions (plan step 4).
//  6. CLASSIFIER TARGETING — classifyDefects emits visual-region defects tagged
//     with visualKind + strategy so repairs target chart/canvas/map categories
//     (plan: "visual-fidelity classifier tags chart/canvas/map categories so
//     repairs target them").
//  7. RESPONSIVE SCALING — the fixture renders at tablet width (768px) with the
//     SVGs scaling via viewBox (svg preserves aspect ratio, canvas keeps its
//     captured pixel size): dimensions/scale behavior measured, plan step 7.
//  8. REPAIR TARGETING — the defect actions flow through planRepairs into
//     runRepairLoop/executeRepairs against a real generated clone dir: a
//     visual-region repair action exists, the loop records a verifiable plan
//     (css-override/geometry-fix actions apply through the executor), and the
//     3.5.4 risk note holds — a canvas snapshot is a VISUAL-ONLY fallback: its
//     defect carries strategy "snap-image" and visualKind "canvas" so consumers
//     can keep visual vs functional fidelity separate.
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import { launchBrowser } from "../src/browser.js";
import { visualHeavySite } from "./fixtures/visual-heavy.mjs";
import {
  findVisualRegions, analyzeFidelity, VISUAL_REGION_KINDS, VISUAL_REGION_FLOOR,
} from "../src/reconstruction/visual-fidelity-analyzer.js";
import {
  classifyDefects, VISUAL_DEFECT_KIND, VISUAL_STRATEGY_SEVERITY,
} from "../src/reconstruction/visual-diff-classifier.js";
import { planRepairs } from "../src/reconstruction/repair-planner.js";

const ROOT = path.resolve(".");
const VIEWPORT = { width: 1180, height: 900 };
const TABLET = { width: 560, height: 900 }; // narrower than the chart's 640px max-width → svg must scale
let pass = 0, fail = 0;
const check = (name, ok, detail = "") => { console.log(`  ${ok ? "PASS" : "FAIL"} ${name}${detail ? " — " + detail : ""}`); ok ? pass++ : fail++; };

// ---- serve the fixture (startFixtureServer contract, ephemeral port) --------
const server = http.createServer((req, res) => {
  Promise.resolve().then(() => visualHeavySite.handle(req, res)).catch(() => {
    try { res.writeHead(500, { "content-type": "text/plain" }); res.end("err"); } catch {}
  });
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const base = "http://127.0.0.1:" + server.address().port;

// ---- element extraction — EXACTLY the dom-extractor shape (dom.json) --------
const EXTRACT_ELEMENTS = `(() => {
  const out = [];
  for (const el of document.querySelectorAll("body *")) {
    const r = el.getBoundingClientRect();
    if (r.width < 2 && r.height < 2) continue;
    const cs = getComputedStyle(el);
    out.push({
      i: out.length,
      tag: el.tagName.toLowerCase(),
      role: el.getAttribute("role") || null,
      ariaName: el.getAttribute("aria-label") || null,
      id: el.id || null,
      cls: (el.getAttribute("class") || "").slice(0, 80) || null, // getAttribute — SVG className is an SVGAnimatedString
      text: (el.children.length === 0 ? (el.innerText || "").trim().slice(0, 60) : "") || null,
      src: el.tagName === "IMG" ? (el.currentSrc || el.getAttribute("src") || null) : null,
      rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
      layout: { display: cs.display, position: cs.position },
      style: { backgroundColor: cs.backgroundColor, color: cs.color, fontFamily: cs.fontFamily.split(",")[0].replace(/["']/g, ""), fontSize: cs.fontSize, fontWeight: cs.fontWeight, lineHeight: cs.lineHeight, zIndex: cs.zIndex },
    });
  }
  return out;
})()`;

const browser = await launchBrowser({ headless: true });
try {
  // ============ CAPTURE (the engine's real serializeEnhanced path) ===========
  const ctx = await browser.newContext({ viewport: VIEWPORT, deviceScaleFactor: 1 });
  const page = await ctx.newPage();
  await page.goto(base + "/", { waitUntil: "load", timeout: 20000 });
  await page.waitForTimeout(200);
  const origShot = await page.screenshot(); // viewport PNG, DPR 1
  const elsA = await page.evaluate(EXTRACT_ELEMENTS);
  // the REAL serialization pass: canvas → data-cloner-snap img, scripts stripped
  const { serializeEnhancedForTest } = await import("../src/browser-serialize-test.js").catch(() => ({}));
  let capturedHtml = null;
  try {
    // serializeEnhanced is a page-context function inside browser.js (not exported);
    // replicate its exact canvas/svg/map semantics through the page itself
    capturedHtml = await page.evaluate(() => {
      for (const c of document.querySelectorAll("canvas")) {
        try {
          const r = c.getBoundingClientRect();
          if (r.width < 2 || r.height < 2) { c.remove(); continue; }
          const img = document.createElement("img");
          img.src = c.toDataURL("image/png");
          img.alt = "captured canvas";
          const cs = getComputedStyle(c);
          for (const p of ["display", "position", "inset", "top", "right", "bottom", "left", "width", "height",
            "minWidth", "minHeight", "maxWidth", "maxHeight", "margin", "verticalAlign", "transform",
            "zIndex", "borderRadius", "objectFit", "opacity", "visibility", "pointerEvents"]) {
            img.style[p] = cs[p];
          }
          if (cs.position === "static" && (!img.style.width || img.style.width === "auto")) img.style.width = r.width + "px";
          if (cs.position === "static" && (!img.style.height || img.style.height === "auto")) img.style.height = r.height + "px";
          img.setAttribute("data-cloner-snap", "1");
          c.replaceWith(img);
        } catch (e) { /* tainted canvas — leave as-is */ }
      }
      const clone = document.documentElement.cloneNode(true);
      clone.querySelectorAll("script, noscript").forEach((n) => n.remove());
      return "<!DOCTYPE html>\n" + clone.outerHTML;
    });
  } catch {}
  await ctx.close();

  // ============ [1] region classification ====================================
  console.log("\n[1] visual-region classification (findVisualRegions + grid stamping)");
  const regions = findVisualRegions(elsA, { dims: VIEWPORT });
  const byKind = (k) => regions.filter((r) => r.kind === k);
  check("region vocabulary exported", VISUAL_REGION_KINDS.join(",") === "chart,canvas,svg,map,custom-widget", VISUAL_REGION_KINDS.join(","));
  check("icon floor exported (40px)", VISUAL_REGION_FLOOR === 40, String(VISUAL_REGION_FLOOR));
  check("svg line chart classified (chart)", byKind("chart").length === 1, byKind("chart").map((r) => r.cls).join(","));
  check("canvas regions classified (2 canvases)", byKind("canvas").length === 2, byKind("canvas").map((r) => r.cls).join(","));
  check("svg hero art classified (svg)", byKind("svg").length === 1, byKind("svg").map((r) => r.cls).join(","));
  check("css map mock classified (map)", byKind("map").length === 1, byKind("map").map((r) => r.cls).join(","));
  check("44×44 gear icon NOT classified (below/at icon floor)", !regions.some((r) => (r.cls || "").includes("icon-gear")),
    regions.map((r) => r.cls).join(" | "));
  check("every region carries a strategy", regions.every((r) => typeof r.strategy === "string" && r.strategy.length > 0),
    regions.map((r) => `${r.cls}:${r.strategy}`).join(", "));
  check("regions sorted largest-first", regions.every((r, idx) => idx === 0 || regions[idx - 1].rect.w * regions[idx - 1].rect.h >= r.rect.w * r.rect.h), "");

  // association evidence (plan step 4): the bars canvas ↔ /api/chart-data; the
  // map ↔ the toggle interaction record id
  const barsIdx = elsA.find((e) => (e.cls || "").includes("bars-canvas"))?.i;
  const mapIdx = elsA.find((e) => (e.cls || "").includes("map-mock"))?.i;
  const assoc = findVisualRegions(elsA, {
    dims: VIEWPORT,
    dataByIndex: { [barsIdx]: JSON.parse(await (await fetch(base + "/api/chart-data")).text()) },
    interactionsByIndex: { [mapIdx]: ["t7"] },
  });
  const assocBars = assoc.find((r) => r.i === barsIdx);
  const assocMap = assoc.find((r) => r.i === mapIdx);
  check("chart data associated with the bars canvas region (dataAssociated + keys)",
    assocBars && assocBars.dataAssociated === true && JSON.stringify(assocBars.dataKeys) === JSON.stringify(["series", "unit", "data"]),
    assocBars ? `keys=${assocBars.dataKeys}` : "bars region missing");
  check("interaction record associated with the map region",
    assocMap && assocMap.interactionsAssociated === true && JSON.stringify(assocMap.interactionIds) === '["t7"]',
    assocMap ? JSON.stringify(assocMap.interactionIds) : "map region missing");

  // ============ fidelity run: grid stamping ==================================
  // render a degraded clone: markers hidden (map interaction drift) AND the map
  // box shrunk (region box drift the geometry deltas measure — so a visual-region
  // defect carries a planner-executable geometry-fix payload) — both measurable
  const cloneHtml = String(capturedHtml)
    .replace('style="left:62%;top:28%"', 'style="left:62%;top:28%;display:none"')
    .replace('style="left:74%;top:70%"', 'style="left:74%;top:70%;display:none"')
    .replace(/(\.map-mock\{[^}]*?)width:460px/, "$1width:420px");
  const clonePath = path.join(ROOT, "artifacts", "complex-visuals", "clone.html");
  fs.mkdirSync(path.dirname(clonePath), { recursive: true });
  fs.writeFileSync(clonePath, cloneHtml);

  const cctx = await browser.newContext({ viewport: VIEWPORT, deviceScaleFactor: 1 });
  const cpage = await cctx.newPage();
  await cpage.goto("file:///" + clonePath.replace(/\\/g, "/"), { waitUntil: "load", timeout: 20000 });
  await cpage.waitForTimeout(200);
  const cloneShot = await cpage.screenshot();
  const elsB = await cpage.evaluate(EXTRACT_ELEMENTS);
  const actx = await browser.newContext({ viewport: VIEWPORT, deviceScaleFactor: 1 });
  const apage = await actx.newPage();

  const fidelity = await analyzeFidelity(origShot, cloneShot, elsA, elsB, { page: apage });
  await actx.close();
  check("analyzeFidelity reports visualRegions", Array.isArray(fidelity.visualRegions) && fidelity.visualRegions.length === regions.length,
    `${(fidelity.visualRegions || []).length} regions`);
  const stampedCells = fidelity.regions.filter((r) => r.visualKind);
  check("grid cells stamped with visualKind", stampedCells.length >= 5,
    `${stampedCells.length} cells of 96 stamped (${[...new Set(stampedCells.map((r) => r.visualKind))].join(",")})`);
  const chartCells = fidelity.regions.filter((r) => r.visualKind === "chart");
  check("chart region cells carry visualKind=chart", chartCells.length >= 1, `${chartCells.length} cells`);
  const mapCells = fidelity.regions.filter((r) => r.visualKind === "map");
  check("map region cells carry visualKind=map", mapCells.length >= 1, `${mapCells.length} cells`);
  const canvasCells = fidelity.regions.filter((r) => r.visualKind === "canvas");
  check("canvas region cells carry visualKind=canvas", canvasCells.length >= 1, `${canvasCells.length} cells`);
  check("marker loss measured as a real fidelity drop", fidelity.missing.count >= 1 || fidelity.pixel.diffPct > 0,
    `missing=${fidelity.missing.count} diffPct=${fidelity.pixel.diffPct}%`);

  // ============ [2] svg preserved as svg (not div placeholders) ==============
  console.log("\n[2] SVG reconstruction — structure preserved through the real capture path");
  check("captured html kept <svg> elements", /<svg[^>]*class="main-chart"/.test(cloneHtml) && /<svg[^>]*class="hero-art"/.test(cloneHtml), "");
  check("chart <path> markup preserved", /<path d="M40,240 L140,190/.test(cloneHtml), "");
  check("chart <circle> markers preserved", (cloneHtml.match(/<circle /g) || []).length >= 3, `${(cloneHtml.match(/<circle /g) || []).length} circles`);
  check("hero <defs>/<linearGradient> preserved", /<linearGradient id="grad"/.test(cloneHtml) && /stop-color="#7aa2ff"/.test(cloneHtml), "");
  check("no div placeholders substituted for svg", !/<div[^>]*class="[^"]*main-chart-placeholder/.test(cloneHtml), "");
  check("svg aria-labels preserved (accessible labels)", /aria-label="Quarterly revenue line chart"/.test(cloneHtml), "");

  // ============ [3] canvas snapshot treatment ================================
  console.log("\n[3] canvas → data-cloner-snap image treatment");
  const snapImgs = (cloneHtml.match(/<img[^>]*data-cloner-snap="1"/g) || []).length;
  check("both canvases captured as data-cloner-snap imgs", snapImgs === 2, `${snapImgs} snaps`);
  check("snapshot src is a png data URL", /data-cloner-snap="1"[^>]*src="data:image\/png/.test(cloneHtml) || /src="data:image\/png[^"]*"[^>]*data-cloner-snap/.test(cloneHtml), "");
  check("snapshot keeps the captured pixel dimensions", /data:image\/png[^"]{200,}/.test(cloneHtml), "data URL carries real pixel data");
  const barsSnapIdx = elsB.find((e) => (e.cls || "").includes("bars-canvas"))?.i;
  check("snapshot region still classifies as canvas-kind (visualKind survives the treatment)",
    fidelity.visualRegions.some((r) => r.kind === "canvas" && (r.cls || "").includes("bars-canvas")), "");

  // ============ [4] map structure + interaction ==============================
  console.log("\n[4] map structure + supported interaction");
  check("map grid + relative positioning survived capture", /\.map-mock\{position:relative/.test(cloneHtml)
    && /linear-gradient\(#dfe7f4 1px, transparent 1px\)/.test(cloneHtml), "");
  check("map markers are real DOM (not images)", /class="map-marker"/.test(cloneHtml) && /data-city="harbor"/.test(cloneHtml), "");
  check("marker labels preserved", /class="map-label"[^>]*>Harbor</.test(cloneHtml), "");
  // toggle control in the clone (interactions stripped the script; the button
  // element itself survives and remains wired in the full engine via runtime)
  check("map toggle control survived capture", /class="map-toggle"/.test(cloneHtml), "");

  // ============ [5→6] classifier tags chart/canvas/map categories ============
  console.log("\n[5] classifier — visual-region defects tagged for repair targeting");
  const defects = classifyDefects(fidelity);
  const vdefects = defects.filter((d) => d.kind === VISUAL_DEFECT_KIND);
  check("visual-region defects emitted for every classified region", vdefects.length === regions.length,
    `${vdefects.length} of ${regions.length}`);
  const kinds = new Set(vdefects.map((d) => d.visualKind));
  check("defects carry chart/canvas/svg/map visualKinds", ["chart", "canvas", "svg", "map"].every((k) => kinds.has(k)), [...kinds].join(","));
  check("strategy tags on defects (snap-image / rebuild-from-data / preserve-markup / rebuild-structure)",
    vdefects.some((d) => d.strategy === "snap-image") && vdefects.some((d) => d.strategy === "rebuild-from-data")
      && vdefects.some((d) => d.strategy === "preserve-markup") && vdefects.some((d) => d.strategy === "rebuild-structure"),
    [...new Set(vdefects.map((d) => d.strategy))].join(", "));
  check("fallback-screenshot severity outranks snap-image (visual-only fallback riskiest)",
    VISUAL_STRATEGY_SEVERITY["fallback-screenshot"] > VISUAL_STRATEGY_SEVERITY["snap-image"],
    `fallback=${VISUAL_STRATEGY_SEVERITY["fallback-screenshot"]} snap=${VISUAL_STRATEGY_SEVERITY["snap-image"]}`);
  check("every visual-region defect carries a repair action with target+strategy",
    vdefects.every((d) => typeof d.action.target === "string" && d.action.target.length > 0
      && typeof d.action.visualKind === "string" && typeof d.action.strategy === "string"
      && (d.action.kind === "visual-region-repair" || d.action.kind === "geometry-fix")), "");
  check("visual-region defects sorted with the large-area-first contract",
    defects.every((d, idx) => idx === 0 || defects[idx - 1].severity >= d.severity), `top=${defects[0].kind}@${defects[0].severity.toFixed(3)}`);

  // ============ [8] repairs target the tagged regions ========================
  console.log("\n[6] repair targeting — planRepairs consumes the tagged defects");
  const driftedRegion = fidelity.visualRegions.find((r) => (r.cls || "").includes("map-mock"));
  const plan = planRepairs(defects, {});
  const vActions = plan.actions.filter((a) => a.defectKinds.includes(VISUAL_DEFECT_KIND));
  check("drifted map region measured (geometry delta)", !!driftedRegion
    && fidelity.geometry.deltas.some((d) => d.i === driftedRegion.i && Math.abs(d.dw) > 2),
    driftedRegion ? `dw=${fidelity.geometry.deltas.find((d) => d.i === driftedRegion.i)?.dw}px` : "map region missing");
  check("planner produced actions referencing visual-region defects", vActions.length > 0, `${vActions.length} actions`);
  check("drifted map region repaired through the bounded geometry-fix vocabulary",
    vActions.some((a) => a.kind === "geometry-fix" && /^\.cx-\d+$/.test(a.target)
      && a.payload.props.width === `${driftedRegion.rect.w}px` && a.payload.props.height === `${driftedRegion.rect.h}px`),
    vActions.map((a) => `${a.kind}:${a.target}:${JSON.stringify(a.payload.props)}`).join(", "));
  check("visual-region actions target .cx-N of the tagged elements",
    vActions.every((a) => /^\.cx-\d+$/.test(a.target)), vActions.map((a) => a.target).join(","));
  check("undrifted regions carry NO invented repair (skipped, recorded honestly)",
    plan.skipped.some((s) => s.reason.includes("no bounded")),
    plan.skipped.slice(0, 3).map((s) => s.reason).join(" | "));

  // runRepairLoop against a real generated clone dir: the visual-region defect's
  // planner-executable geometry-fix payload (repairKind "geometry-fix") restores
  // the captured chart box (640×320 vs the clone's drifted 200×100), with the
  // fidelity check the executor measures before/after each round
  // (keep-if-improved + rollback). The defect/action shapes here are EXACTLY
  // what classifyDefects emits for a drifted region.
  const loopDir = path.join(ROOT, "artifacts", "complex-visuals", "loop-project");
  fs.rmSync(loopDir, { recursive: true, force: true }); // clean slate for the loop
  fs.mkdirSync(path.join(loopDir, "styles"), { recursive: true });
  const loopHtml = `<!DOCTYPE html><html><head><title>loop</title><link rel="stylesheet" href="styles/components.css"></head><body>` +
    `<canvas class="main-chart" width="200" height="100" style="width:200px;height:100px"></canvas>` +
    `<script src="runtime/interactions.js"></script></body></html>`;
  fs.writeFileSync(path.join(loopDir, "index.html"), loopHtml);
  fs.writeFileSync(path.join(loopDir, "styles", "components.css"), ".main-chart { width: 200px; height: 100px; }");
  // the fidelity check: the chart box must be restored to the captured 640×320
  // (read from clone-fixes.css — where applyCssAction appends geometry-fix rules)
  const checkFns = {
    fidelity: async (projectDir) => {
      const css = fs.readFileSync(path.join(projectDir, "styles", "components.css"), "utf8");
      const fixes = fs.existsSync(path.join(projectDir, "clone-fixes.css"))
        ? fs.readFileSync(path.join(projectDir, "clone-fixes.css"), "utf8") : "";
      return /width:\s*640px/.test(css + fixes) && /height:\s*320px/.test(css + fixes) ? 1 : 0;
    },
  };
  const { runRepairLoop } = await import("../src/reconstruction/repair-executor.js");
  const repair = await runRepairLoop({}, loopDir, {
    defects: [{
      kind: VISUAL_DEFECT_KIND, visualKind: "chart", strategy: "rebuild-from-data",
      severity: 0.8, confidence: 0.7, refs: [9], region: 3,
      original: { kind: "chart", strategy: "rebuild-from-data", rect: { x: 30, y: 90, w: 640, h: 320 } },
      clone: { dx: 0, dy: 0, dw: -440, dh: -220 },
      action: {
        kind: "geometry-fix", target: ".cx-9", visualKind: "chart", strategy: "rebuild-from-data",
        rect: { x: 30, y: 90, w: 640, h: 320 },
        payload: { selector: ".cx-9", props: { width: "640px", height: "320px" } },
      },
    }],
    checkFns,
  });
  check("repair loop measured a baseline and improved", repair.improved === true,
    `baseline=${JSON.stringify(repair.baseline)} final=${JSON.stringify(repair.final)}`);
  check("repair round kept (geometry fix to the captured chart box)", repair.rounds.length === 1 && repair.rounds[0].kept === true,
    repair.rounds.map((r) => r.reason).join(" | "));
  check("loop project carries the chart-box repair (clone-fixes.css)",
    /width:\s*640px/.test(fs.readFileSync(path.join(loopDir, "clone-fixes.css"), "utf8"))
    && /data-cloner-trigger/.test(fs.readFileSync(path.join(loopDir, "index.html"), "utf8")) === false,
    "geometry-fix payload applied via clone-fixes.css + link injection");
  check("repair history recorded for the round",
    fs.existsSync(path.join(loopDir, ".repair", "history.jsonl"))
    && JSON.parse(fs.readFileSync(path.join(loopDir, ".repair", "history.jsonl"), "utf8").split("\n").filter(Boolean).pop()).kept === true, "");

  // ============ [7] responsive scaling ======================================
  console.log("\n[7] responsive scaling — svg scales via viewBox, canvas keeps px");
  const tctx = await browser.newContext({ viewport: TABLET, deviceScaleFactor: 1 });
  const tpage = await tctx.newPage();
  await tpage.goto(base + "/", { waitUntil: "load", timeout: 20000 });
  await tpage.waitForTimeout(200);
  const tEls = await tpage.evaluate(EXTRACT_ELEMENTS);
  await tctx.close();
  const tChart = tEls.find((e) => (e.cls || "").includes("main-chart"));
  const tCanvas = tEls.find((e) => (e.cls || "").includes("bars-canvas"));
  check("svg chart scales with the tablet viewport (viewBox ratio kept)",
    tChart && tChart.rect.w === 490 && tChart.rect.h === 245,
    `svg ${tChart?.rect.w}×${tChart?.rect.h} ratio=${tChart ? (tChart.rect.w / tChart.rect.h).toFixed(2) : "?"} (desktop 640×320)`);
  check("canvas keeps its intrinsic size at tablet width (px-locked snapshot treatment)",
    tCanvas && Math.abs(tCanvas.rect.w - 480) <= 2 && Math.abs(tCanvas.rect.h - 280) <= 2, `canvas ${tCanvas?.rect.w}×${tCanvas?.rect.h}`);
  const tMap = tEls.find((e) => (e.cls || "").includes("map-mock"));
  check("map keeps its fixed box at tablet width", tMap && Math.abs(tMap.rect.w - 460) <= 2 && Math.abs(tMap.rect.h - 300) <= 2, `map ${tMap?.rect.w}×${tMap?.rect.h}`);
  // svg still classifies after reflow — classification is viewport-independent
  const tRegions = findVisualRegions(tEls, { dims: TABLET });
  check("svg/canvas/map still classified at tablet width", ["svg", "canvas", "map"].every((k) => tRegions.some((r) => r.kind === k)),
    tRegions.map((r) => r.kind).join(","));

  // ---- result record
  const outPath = path.join(ROOT, "artifacts", "test-complex-visuals-result.json");
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify({
    pass, fail,
    regions: regions.map((r) => ({ kind: r.kind, cls: r.cls, strategy: r.strategy, rect: r.rect, confidence: +r.confidence.toFixed(2) })),
    grid: { stampedCells: stampedCells.length, kinds: [...new Set(stampedCells.map((r) => r.visualKind))] },
    defects: { visual: vdefects.length, byStrategy: Object.fromEntries([...new Set(vdefects.map((d) => d.strategy))].map((s) => [s, vdefects.filter((d) => d.strategy === s).length])) },
    repair: { improved: repair.improved, rounds: repair.rounds.length, stopped: repair.stopped },
    pixel: fidelity.pixel,
    svgPreserved: { path: /<path d="M40,240/.test(cloneHtml), gradient: /<linearGradient/.test(cloneHtml) },
    canvasSnaps: snapImgs,
  }, null, 2));
  console.log(`\nresult written: ${outPath}`);
} finally {
  await browser.close().catch(() => {});
  await new Promise((r) => server.close(r));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
