#!/usr/bin/env node
// Visual optimizer suite (task G3.2) — automated defect localization feeding the
// EXISTING repair-executor, layout correction with a measurable-improvement gate,
// and regression-prevention hooks for the multisite benchmark (PLAN50 visual
// optimization area).
//
// Sections:
//  [A] LOCALIZATION (pure, deterministic) — hot-cell clustering, connected
//      components, element-explained vs unexplained clusters, candidate ranking,
//      malformed-input degradation, byte-for-byte determinism.
//  [B] LAYOUT CORRECTION on a real project fixture through the EXISTING
//      repair-planner + repair-executor (checkFns injected per the executor's
//      documented contract, exactly like test-autonomous-repair.mjs): gate
//      accepted with kept rounds + history; gate REJECTED restores the project
//      byte-for-byte (sha256 tree digest proof); kind filter skips work;
//      maxRounds bounds the pass.
//  [C] REAL RENDERED JOURNEY (Playwright + analyzeFidelity, no mocks): serve the
//      original and a defective clone over HTTP, measure REAL pixel fidelity,
//      localize the drift cluster over the visibly broken card, run
//      correctLayout with a REAL check (fresh render → analyzeFidelity score),
//      verify the gate accepts, pixel similarity measurably improves, and the
//      repaired card's live DOM box matches the original — what a human sees.
//      Also a REAL no-improvement case: a synthetic bad "fix" must be rejected
//      by the gate and roll the project back byte-identically.
//  [D] REGRESSION PREVENTION — seed shape is byte-compatible with the REAL
//      fixtures/benchmark/baseline.json; evaluate reproduces the benchmark's
//      regressionCheck semantics plus per-dimension drops; similarity ledger
//      round-trip on real fs (atomic, versioned, fail-closed on malformed);
//      regressionGate one-call hook; BENCHMARK_WIRING present.
//
// Zero network beyond localhost (self-hosted fixtures = the remote-end
// simulator allowance; product code paths call the real local files), zero
// credentials, deterministic.
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import {
  HOT_CELL_FLOOR,
  LAYOUT_KINDS,
  LEDGER_VERSION,
  REGRESSION_TOLERANCE,
  localizeDefects,
  clusterHotRegions,
  correctLayout,
  digestTree,
  seedBenchmarkBaseline,
  evaluateBenchmarkRegression,
  writeSimilarityLedger,
  readSimilarityLedger,
  evaluateSimilarityLedger,
  regressionGate,
  BENCHMARK_WIRING,
} from "../src/reconstruction/intelligence/visual-optimizer.js";
import { analyzeFidelity, GRID_X, GRID_Y } from "../src/reconstruction/visual-fidelity-analyzer.js";
import { DOM_EXTRACTOR_SCRIPT } from "../src/intelligence/dom-extractor.js";
import { readHistory } from "../src/reconstruction/repair-history.js";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
process.chdir(ROOT); // suite contract: repo-root-relative paths, like every house suite
const OUT = path.join(ROOT, "artifacts", "test-visual-optimizer");
fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });

let pass = 0, fail = 0;
const check = (name, ok, detail = "") => {
  console.log(`  ${ok ? "PASS" : "FAIL"} ${name}${detail ? " — " + detail : ""}`);
  ok ? pass++ : fail++;
};
const deepEq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
// order-insensitive structural equality (JSON.stringify alone compares key ORDER)
function eqLoose(a, b) {
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((v, i) => eqLoose(v, b[i]));
  if (a && b && typeof a === "object" && typeof b === "object") {
    const ka = Object.keys(a), kb = Object.keys(b);
    return ka.length === kb.length && ka.every((k) => eqLoose(a[k], b[k]));
  }
  return false;
}
const section = (t) => console.log(`\n== ${t}`);

// ---------------------------------------------------------------------------
// shared synthetic fidelity report (EXACT analyzeFidelity output shape)
// ---------------------------------------------------------------------------
const DIMS = { w: 1280, h: 800 }; // 12×8 grid → cell 106.67×100
function regionGrid(scores = {}) {
  const regions = [];
  for (let i = 0; i < GRID_X * GRID_Y; i++) {
    regions.push({
      cell: i, col: i % GRID_X, row: Math.floor(i / GRID_X),
      score: scores[i] ?? 0, diffPct: (scores[i] ?? 0) / 25.5,
      geometryErrorPx: null, geometryPairs: 0, typographyMismatches: 0, colorMismatches: 0, visualKind: null,
    });
  }
  return regions;
}
function baseReport() {
  return {
    dims: DIMS, threshold: 30,
    pixel: { meanDelta: 8.4, diffPct: 3.1, similarityPct: 96.9 },
    regions: regionGrid(), hotRegions: [],
    geometry: { matched: 0, paired: 0, mismatched: 0, meanErrorPx: 0, maxErrorPx: 0, deltas: [] },
    typography: { compared: 0, mismatchCount: 0, mismatches: [] },
    color: { mismatchCount: 0, mismatches: [] },
    stacking: { mismatchCount: 0, mismatches: [] },
    missing: { count: 0, elements: [] },
    extra: { count: 0, elements: [] },
    visualRegions: [],
  };
}

// ===========================================================================
section("A. defect localization (pure)");
// ===========================================================================
{
  // hot cells: 14 (r1,c2) + 15 (r1,c3) adjacent → one cluster; 88 (r7,c4) alone → another
  // (88 = row 7 · col 4 → y 700..800, x 426..533 — inside the footer/cta row)
  const hot = { 14: 120, 15: 90, 88: 45 };
  const f = { ...baseReport(), regions: regionGrid(hot) };
  const elements = [
    { i: 0, tag: "div", cls: "hero", rect: { x: 180, y: 90, w: 250, h: 120 } },   // covers cells 14-15
    { i: 1, tag: "div", cls: "footer", rect: { x: 0, y: 700, w: 1280, h: 100 } }, // does NOT cover cell 60 (r7 = y 700..800 → col4 = x 426..533 — footer does not cover col 4... it spans full width!) 
  ];
  // footer spans the full width → it overlaps cell 60; add a tight element too for ranking
  elements.push({ i: 2, tag: "button", cls: "cta", rect: { x: 430, y: 720, w: 90, h: 40 } });

  const loc = localizeDefects(f, { elements });
  check("A1 two clusters found (adjacent pair merged, singleton separate)", loc.clusters.length === 2
    && deepEq(loc.clusters[0].cells, [14, 15]) && deepEq(loc.clusters[1].cells, [88]),
    `cells ${JSON.stringify(loc.clusters.map((c) => c.cells))}`);
  check("A2 cluster rects are page-space unions", loc.clusters[0].rect.x > 0 && loc.clusters[0].rect.w > 200
    && loc.clusters[1].rect.y > 650, JSON.stringify(loc.clusters.map((c) => c.rect)));
  check("A3 clusters with NO element-level evidence stay unexplained (candidates still listed)",
    loc.unexplainedClusters.length === 2 && loc.explainedClusters.length === 0
      && loc.clusters.every((c) => c.verdict === "unexplained" && c.candidates.length > 0),
    `explained ${loc.explainedClusters.length}, unexplained ${loc.unexplainedClusters.length}`);
  check("A4 candidates ranked by overlap share (tight button outranks full-width footer)",
    loc.candidatesByCluster["cluster-2"][0]?.cls === "cta"
      && loc.candidatesByCluster["cluster-2"].length <= 3,
    JSON.stringify((loc.candidatesByCluster["cluster-2"] || []).map((c) => `${c.cls}:${c.overlapPct}%`)));
  check("A5 cluster severity is area-weighted and deterministic (shared curve)",
    loc.clusters[0].severity > loc.clusters[1].severity,
    `${loc.clusters[0].severity} vs ${loc.clusters[1].severity}`);
  check("A6 summary honest", loc.summary.hotCells === 3 && loc.summary.clusters === 2
    && loc.summary.explained === 0 && loc.summary.unexplained === 2 && loc.summary.peakScore === 120,
    JSON.stringify(loc.summary));

  // unexplained: same hot cells but NO element defect anywhere (classifier
  // still emits region-only color defects — refs empty — which must NOT
  // self-explain)
  const loc2 = localizeDefects({ ...baseReport(), regions: regionGrid(hot) }, { elements: [] });
  check("A7 pixel-only drift stays unexplained (region defects can't self-explain)",
    loc2.unexplainedClusters.length === 2 && loc2.explainedClusters.length === 0
      && loc2.elementDefects.length === 3, // 3 hot cells → 3 region-only color defects, refs []
    `unexplained ${loc2.unexplainedClusters.length}, elementDefects ${loc2.elementDefects.length}`);

  // explained by a real geometry defect
  const fG = {
    ...baseReport(),
    regions: regionGrid(hot),
    geometry: { matched: 1, paired: 1, mismatched: 1, meanErrorPx: 40, maxErrorPx: 40,
      deltas: [{ i: 0, rect: elements[0].rect, dx: -40, dy: 20, dw: 0, dh: 0, errorPx: 40 }] },
  };
  const loc3 = localizeDefects(fG, { elements });
  check("A8 geometry defect explains the cluster it lands in",
    loc3.clusters[0].verdict === "explained"
      && loc3.clusters[0].explainedBy.some((s) => s.startsWith("geometry:")),
    JSON.stringify(loc3.clusters[0].explainedBy));

  check("A9 determinism: two runs byte-identical", deepEq(localizeDefects(fG, { elements }), localizeDefects(fG, { elements })));

  // malformed / degraded inputs
  const m1 = localizeDefects(null);
  const m2 = localizeDefects({});
  const m3 = localizeDefects({ dims: { w: 0, h: 0 }, regions: null });
  check("A10 malformed reports degrade to honest empty (never throw)",
    m1.clusters.length === 0 && m2.clusters.length === 0 && m3.elementDefects.length === 0
      && m1.summary.clusters === 0 && m1.summary.hotCells === 0);

  check("A11 HOT_CELL_FLOOR matches the classifier's visible-drift floor", HOT_CELL_FLOOR === 20);

  // cold clusters: below floor are not clusters
  const loc4 = clusterHotRegions(regionGrid({ 3: 5, 4: 19, 5: 20 }), DIMS);
  check("A12 floor respected: score 19 cold, 20 hot", loc4.length === 1 && deepEq(loc4[0].cells, [5]));
}

// ===========================================================================
section("B. layout correction — existing planner + executor, improvement gate (deterministic fixture)");
// ===========================================================================
const B_ROOT = path.join(OUT, "layout-project");
function writeBProject() {
  fs.rmSync(B_ROOT, { recursive: true, force: true });
  fs.mkdirSync(path.join(B_ROOT, "styles"), { recursive: true });
  fs.writeFileSync(path.join(B_ROOT, "index.html"), `<!DOCTYPE html>
<html>
<head>
  <title>Layout Fixture</title>
  <link rel="stylesheet" href="styles/layout.css">
</head>
<body>
  <section class="cx-3 hero" style="background:#ff00ff">Hero</section>
  <div class="cx-7 badge" style="position:relative;z-index:1">Badge</div>
</body>
</html>
`);
  fs.writeFileSync(path.join(B_ROOT, "styles", "layout.css"),
    `.hero { width: 640px; height: 200px; }\n.badge { width: 300px; height: 80px; }\n`);
}
writeBProject();

// measured fidelity report for the fixture: hero box drifted (dx −12, dy 8),
// hero color drifted, badge stacking drifted
const B_FIDELITY = (() => {
  const f = baseReport();
  f.geometry = { matched: 1, paired: 2, mismatched: 1, meanErrorPx: 14.4, maxErrorPx: 14.4,
    deltas: [{ i: 3, rect: { x: 100, y: 80, w: 640, h: 200 }, dx: -12, dy: 8, dw: 0, dh: 0, errorPx: 14.4 }] };
  f.color = { mismatchCount: 1, mismatches: [{ i: 3, field: "backgroundColor", original: "#0f1420", clone: "#ff00ff", rect: { x: 100, y: 80, w: 640, h: 200 }, cell: 2 }] };
  f.stacking = { mismatchCount: 1, mismatches: [{ i: 7, rect: { x: 200, y: 400, w: 300, h: 80 }, cell: 33, fields: { zIndex: "10" } }] };
  return f;
})();

// deterministic file-content fidelity score (the executor's documented injected-
// check contract — the same shape test-autonomous-repair.mjs uses): rewards each
// concrete repair appearing in the project files.
const scoreB = async (dir) => {
  const fixes = fs.existsSync(path.join(dir, "clone-fixes.css"))
    ? fs.readFileSync(path.join(dir, "clone-fixes.css"), "utf8") : "";
  let s = 55;
  if (/background-color:\s*#0f1420/.test(fixes)) s += 20;
  if (/translate\(12px,\s*-8px\)/.test(fixes)) s += 15;
  if (/z-index:\s*10/.test(fixes)) s += 10;
  return s;
};

{
  // full correction pass: layout kinds PLUS color (the fidelity-correction
  // vocabulary the executor already supports) — every classified defect plans
  const r = await correctLayout(B_ROOT, B_FIDELITY, {
    kinds: ["geometry", "stacking", "color"],
    checkFns: { fidelity: scoreB },
    snapshotRoot: path.join(B_ROOT, ".repair", "opt"),
  });
  check("B1 gate ACCEPTED with measurable improvement (55 → 100)", r.accepted === true && r.gate.passed === true
    && r.gate.before === 55 && r.gate.after === 100 && r.gate.delta === 45,
    `gate ${JSON.stringify(r.gate)}`);
  check("B2 plan built through the EXISTING repair-planner (vocabulary + ids)",
    r.plan.actions.length === 3 && r.plan.actions.every((a) => /^R\d+$/.test(a.id))
      && r.plan.actions.every((a) => ["css-override", "token-fix", "geometry-fix"].includes(a.kind)),
    r.plan.actions.map((a) => `${a.id}:${a.kind}:${a.target}`).join(", "));
  check("B3 executor kept every round (existing keep-if-improved loop)",
    r.repair.applied.length === 3 && r.repair.reverted.length === 0 && r.repair.stopped === "exhausted"
      && r.repair.improved === true,
    `stopped ${r.repair.stopped}, applied ${r.repair.applied.length}`);
  check("B4 repairs landed in clone-fixes.css + index.html link (autoRemediate pattern)",
    /background-color:\s*#0f1420 !important/.test(fs.readFileSync(path.join(B_ROOT, "clone-fixes.css"), "utf8"))
      && /translate\(12px,\s*-8px\)/.test(fs.readFileSync(path.join(B_ROOT, "clone-fixes.css"), "utf8"))
      && fs.readFileSync(path.join(B_ROOT, "index.html"), "utf8").includes('href="clone-fixes.css"'));
  check("B5 executor history appended (existing repair-history surface)",
    readHistory(path.join(B_ROOT, ".repair", "history.jsonl")).length === 3);

  // kind filter: only geometry+stacking are layout kinds — a color-only report
  // must produce NO repair and leave the project untouched
  writeBProject();
  const colorOnly = { ...baseReport(), color: B_FIDELITY.color };
  const rOnly = await correctLayout(B_ROOT, colorOnly, { checkFns: { fidelity: scoreB } });
  check("B6 layout kind filter: color-only defect → no repairable action, project untouched",
    rOnly.accepted === false && rOnly.plan.actions.length === 0 && rOnly.repair === null
      && !fs.existsSync(path.join(B_ROOT, "clone-fixes.css"))
      && rOnly.gate.reason.includes("no repairable"),
    rOnly.gate.reason);

  // improvement gate REJECTS a non-improving pass and restores byte-for-byte
  writeBProject();
  const beforeDigest = digestTree(B_ROOT, { exclude: [".repair"] });
  const bogus = {
    kind: "geometry", severity: 1, confidence: 0.95, refs: [3], region: 2,
    original: { x: 100, y: 80, w: 640, h: 200 }, clone: { dx: 50, dy: 0, dw: 0, dh: 0 },
    action: { kind: "geometry-fix", target: ".cx-3", adjust: { dx: 50, dy: 0, dw: 0, dh: 0 } },
  };
  const rBad = await correctLayout(B_ROOT, B_FIDELITY, {
    checkFns: { fidelity: scoreB },
    extraDefects: [bogus], // severity 1 → plans FIRST, applies translate(-50px…) which the score never rewards
  });
  const afterDigest = digestTree(B_ROOT, { exclude: [".repair"] });
  check("B7 non-improving pass REJECTED by the measurable-improvement gate",
    rBad.accepted === false && rBad.gate.passed === false && rBad.gate.delta === 0 && rBad.restored === true,
    `gate ${JSON.stringify(rBad.gate)}`);
  check("B8 rejected pass restored the project byte-for-byte (sha256 tree digest)",
    rBad.restoreIdentical === true && beforeDigest === afterDigest);
  check("B9 executor recorded the reverted round before the gate fired (evidence chain)",
    rBad.repair.rounds.length === 1 && rBad.repair.rounds[0].kept === false && rBad.repair.stopped === "no-improvement");

  // maxRounds bounds the pass; still accepted while measurably improving
  writeBProject();
  const rBound = await correctLayout(B_ROOT, B_FIDELITY, {
    kinds: ["geometry", "stacking", "color"], checkFns: { fidelity: scoreB }, maxRounds: 1,
  });
  check("B10 maxRounds bounds the pass (1 round, 2 pending, still accepted)",
    rBound.accepted === true && rBound.repair.rounds.length === 1
      && rBound.repair.pending.length === 2 && rBound.repair.stopped === "max-rounds");

  // unmeasurable baseline (check throws on first call) → executor reports
  // stopped "unmeasurable"; the optimizer must fail the gate closed and restore
  writeBProject();
  const rCrash = await correctLayout(B_ROOT, B_FIDELITY, {
    checkFns: { fidelity: () => { throw new Error("baseline probe dead"); } },
  });
  check("B11 unmeasurable baseline → gate fails closed, project restored",
    rCrash.accepted === false && rCrash.repair !== null && rCrash.repair.stopped === "unmeasurable"
      && rCrash.restored === true && rCrash.restoreIdentical === true
      && /non-finite|unmeasurable/i.test(rCrash.gate.reason),
    `${rCrash.gate.reason} | stopped=${rCrash.repair?.stopped}`);

  // non-finite final score → gate fails closed
  writeBProject();
  let calls = 0;
  const rNan = await correctLayout(B_ROOT, B_FIDELITY, {
    checkFns: { fidelity: async () => (++calls === 1 ? 55 : NaN) }, // baseline ok, per-round measure NaN
  });
  check("B12 non-finite check score → gate fails closed and restores",
    rNan.accepted === false && rNan.restored === true && rNan.restoreIdentical === true
      && /unmeasurable|non-finite/i.test(rNan.gate.reason),
    rNan.gate.reason);
}

// ===========================================================================
section("C. real rendered journey — Playwright + analyzeFidelity (no mocks)");
// ===========================================================================
const C_ROOT = path.join(OUT, "render-project");
{
  fs.rmSync(C_ROOT, { recursive: true, force: true });
  fs.mkdirSync(path.join(C_ROOT, "styles"), { recursive: true });
  // ORIGINAL page (reference): hero + a 300px-wide card at the left margin.
  // Elements carry the generator's per-element cx-N classes (capture-index
  // order: section cx-0, h1 cx-1, card cx-2, h2 cx-3, p cx-4) while the page
  // CSS styles via plain classes — so the executor's `.cx-N` repair rules are
  // equal-specificity and win the cascade from clone-fixes.css (loaded last).
  const ORIGINAL = `<!DOCTYPE html>
<html><head><title>Reference</title><style>
  body { margin: 0; font-family: Arial, sans-serif; }
  .hero { width: 100%; height: 220px; background: #14304d; color: #fff; display: flex; align-items: center; padding-left: 40px; box-sizing: border-box; }
  .card { margin: 40px 0 0 0; width: 300px; height: 180px; background: #e8eef4; border: 2px solid #14304d; padding: 16px; box-sizing: border-box; }
  .card h2 { margin: 0 0 8px 0; font-size: 20px; color: #14304d; }
  .card p { margin: 0; font-size: 14px; color: #333; }
</style></head><body>
  <section class="cx-0 hero"><h1 class="cx-1">Analytics Console</h1></section>
  <div class="cx-2 card"><h2 class="cx-3">Weekly report</h2><p class="cx-4">Traffic up 12% week over week across all channels.</p></div>
</body></html>`;
  // CLONE page (defective): card is 240px wide and shifted right 40px — a drift
  // a human SEES (same cx-N classes so pairs align element-for-element)
  const CLONE_BODY = ORIGINAL
    .replace(".card { margin: 40px 0 0 0; width: 300px;", ".card { margin: 40px 0 0 40px; width: 240px;");
  fs.writeFileSync(path.join(C_ROOT, "original.html"), ORIGINAL);
  fs.writeFileSync(path.join(C_ROOT, "index.html"), CLONE_BODY);
  fs.writeFileSync(path.join(C_ROOT, "styles", "layout.css"), "/* generator styles (unused here) */\n");

  const MIME = { ".html": "text/html; charset=utf-8", ".css": "text/css" };
  const server = http.createServer((req, res) => {
    const rel = decodeURIComponent((req.url || "/").split("?")[0]).replace(/^\/+/, "") || "index.html";
    const fp = path.join(C_ROOT, rel);
    if (!fp.startsWith(C_ROOT) || !fs.existsSync(fp) || !fs.statSync(fp).isFile()) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { "content-type": MIME[path.extname(fp)] || "application/octet-stream" });
    res.end(fs.readFileSync(fp));
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;

  const browser = await chromium.launch({ headless: true }).catch(() => chromium.launch({ headless: true, channel: "msedge" }));
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 });
  const page = await ctx.newPage();

  const render = async (url) => {
    await page.goto(url, { waitUntil: "load", timeout: 30000 });
    await page.waitForTimeout(250);
    const shot = await page.screenshot();
    const intel = await page.evaluate(DOM_EXTRACTOR_SCRIPT);
    return { shot, elements: intel.elements };
  };

  try {
    const orig = await render(`${base}/original.html`);
    const clone0 = await render(`${base}/index.html`);
    fs.writeFileSync(path.join(OUT, "journey-1-defective.png"), clone0.shot);
    const fid0 = await analyzeFidelity(orig.shot, clone0.shot, orig.elements, clone0.elements, { page });
    check("C1 REAL fidelity measured the visible drift (pixel similarity < 100, geometry defects present)",
      fid0.pixel.similarityPct < 100 && fid0.geometry.deltas.some((d) => d.errorPx > 2),
      `similarity ${fid0.pixel.similarityPct}%, geometry deltas ${fid0.geometry.deltas.length}`);

    const loc = localizeDefects(fid0, { elements: orig.elements.map((e) => ({ i: e.i, tag: e.tag, cls: e.cls, rect: e.rect })) });
    const cluster = loc.clusters[0];
    check("C2 drift localized to a cluster overlapping the visibly broken card",
      !!cluster && cluster.candidates.some((c) => String(c.cls || "").includes("card")),
      `cluster ${cluster ? `cells ${cluster.cells.join(",")} rect ${JSON.stringify(cluster.rect)}` : "none"} candidates ${(cluster?.candidates || []).map((c) => c.cls).join(",")}`);

    // REAL check for the executor: re-render the project and score with analyzeFidelity
    const origShot = orig.shot;
    const realFidelityCheck = async () => {
      await page.goto(`${base}/index.html`, { waitUntil: "load", timeout: 30000 });
      await page.waitForTimeout(200);
      const shot = await page.screenshot();
      const intel = await page.evaluate(DOM_EXTRACTOR_SCRIPT);
      const fid = await analyzeFidelity(origShot, shot, orig.elements, intel.elements, { page });
      return fid.pixel.similarityPct; // 0-100 real pixel similarity
    };

    const before = await realFidelityCheck();
    const r = await correctLayout(C_ROOT, fid0, {
      checkFns: { fidelity: realFidelityCheck },
      elements: orig.elements.map((e) => ({ i: e.i, tag: e.tag, cls: e.cls, rect: e.rect })),
      snapshotRoot: path.join(C_ROOT, ".repair", "opt"),
    });
    check("C3 correctLayout ran the EXISTING repair-executor and the gate ACCEPTED the real improvement",
      r.accepted === true && r.gate.passed === true && r.gate.after > r.gate.before,
      `gate ${JSON.stringify(r.gate)} actions ${r.plan.actions.map((a) => a.kind).join(",")}`);

    const after = await realFidelityCheck();
    check("C4 real pixel similarity measurably improved (before → after)",
      after > before && Math.round((after - before) * 100) / 100 >= 0.5,
      `before ${before.toFixed(2)}% → after ${after.toFixed(2)}%`);

    // HUMAN-JOURNEY check: the repaired card's live DOM box must now match the
    // original's box — what a human sees is the card back in place.
    await page.goto(`${base}/index.html`, { waitUntil: "load", timeout: 30000 });
    await page.waitForTimeout(200);
    const boxNow = await page.evaluate(() => {
      const el = document.querySelector(".card");
      const rr = el.getBoundingClientRect();
      return { x: Math.round(rr.x), y: Math.round(rr.y), w: Math.round(rr.width) };
    });
    const boxRef = orig.elements.find((e) => String(e.cls || "").includes("card")).rect;
    fs.writeFileSync(path.join(OUT, "journey-2-repaired.png"), await page.screenshot());
    check("C5 what a human sees: repaired card box matches the reference (position + size)",
      Math.abs(boxNow.x - boxRef.x) <= 2 && Math.abs(boxNow.y - boxRef.y) <= 2 && Math.abs(boxNow.w - boxRef.w) <= 2,
      `now ${JSON.stringify(boxNow)} vs ref ${JSON.stringify(boxRef)}`);
    check("C6 fix landed through clone-fixes.css (real cascade, real pixels)",
      fs.existsSync(path.join(C_ROOT, "clone-fixes.css"))
        && /transform:\s*translate\(/.test(fs.readFileSync(path.join(C_ROOT, "clone-fixes.css"), "utf8")));

    // REAL no-improvement case: a bogus shift with a REAL measurement must be
    // rejected by the gate and roll the project back byte-for-byte.
    const preReject = fs.readFileSync(path.join(C_ROOT, "clone-fixes.css"), "utf8");
    const digestBefore = digestTree(C_ROOT, { exclude: [".repair"] });
    const bogusShift = {
      kind: "geometry", severity: 1, confidence: 0.9, refs: [2], region: 0,
      original: { x: 0, y: 0, w: 100, h: 100 }, clone: { dx: -3, dy: 0, dw: 0, dh: 0 },
      action: { kind: "geometry-fix", target: ".hero", adjust: { dx: 30, dy: 0, dw: 0, dh: 0 } },
    };
    const rReject = await correctLayout(C_ROOT, fid0, {
      checkFns: { fidelity: realFidelityCheck },
      // require a REAL 0.25-point similarity gain — anti-aliasing noise between
      // identical renders is far below this, so the gate verdict is noise-proof
      minGateImprovement: 0.25,
      extraDefects: [bogusShift], // hero already correct → shifting it 30px worsens real pixels
    });
    const digestAfter = digestTree(C_ROOT, { exclude: [".repair"] });
    check("C7 REAL measurement rejects the bad fix (gate failed, no phantom improvement)",
      rReject.accepted === false && rReject.gate.passed === false && rReject.restored === true,
      `gate ${JSON.stringify(rReject.gate)}`);
    check("C8 rejected pass left the project byte-identical (sha256 tree digest)",
      rReject.restoreIdentical === true && digestBefore === digestAfter
        && fs.readFileSync(path.join(C_ROOT, "clone-fixes.css"), "utf8") === preReject);

    await ctx.close();
  } finally {
    await browser.close().catch(() => {});
    await new Promise((r) => server.close(r));
  }
}

// ===========================================================================
section("D. regression prevention — multisite benchmark hooks");
// ===========================================================================
{
  const rubric = JSON.parse(fs.readFileSync(path.join(ROOT, "fixtures", "benchmark", "rubric.json"), "utf8"));
  const realBaseline = JSON.parse(fs.readFileSync(path.join(ROOT, "fixtures", "benchmark", "baseline.json"), "utf8"));
  const results = Object.entries(realBaseline.perSite).map(([site, v]) => ({
    site, overall: v.overall,
    dimensions: Object.fromEntries(Object.entries(v.dimensions || {}).map(([d, s]) => [d, { score: s.score }])),
  }));

  const reseeded = seedBenchmarkBaseline(results, { rubricVersion: realBaseline.rubricVersion, fixtureVersion: realBaseline.fixtureVersion });
  check("D1 seed reproduces the REAL benchmark baseline structurally (shape-compat proven)",
    eqLoose(reseeded, realBaseline),
    `${Object.keys(reseeded.perSite).length} sites vs ${Object.keys(realBaseline.perSite).length}`);

  const ev0 = evaluateBenchmarkRegression(realBaseline, results, { tolerance: rubric.regressionTolerance });
  check("D2 identical run → gate passes, no regressions", ev0.pass === true && ev0.regressions.length === 0
    && ev0.compared.length === results.length, `compared ${ev0.compared.length}`);

  const dropped = results.map((r) => r.site === "multi-route" ? { ...r, overall: r.overall - 5 } : r);
  const ev1 = evaluateBenchmarkRegression(realBaseline, dropped, { tolerance: rubric.regressionTolerance });
  check("D3 aggregate drop beyond rubric tolerance flags the site (benchmark parity: drop > tolerance)",
    ev1.pass === false && ev1.regressions.length === 1 && ev1.regressions[0].site === "multi-route"
      && ev1.regressions[0].flagged === true,
    `drop ${ev1.regressions[0]?.drop}`);

  const exact = evaluateBenchmarkRegression(realBaseline, results.map((r) => ({ ...r, overall: r.overall - rubric.regressionTolerance })), { tolerance: rubric.regressionTolerance });
  check("D4 drop exactly AT tolerance does not flag (strict >, matching the benchmark)",
    exact.pass === true, JSON.stringify(exact.regressions));

  const dimDrop = results.map((r) => {
    const dims = JSON.parse(JSON.stringify(r.dimensions));
    if (r.site === "e-commerce" && dims.visualSimilarity) dims.visualSimilarity.score -= rubric.regressionTolerance + 1;
    return { ...r, dimensions: dims }; // overall UNCHANGED — a hidden dimension collapse
  });
  const ev2 = evaluateBenchmarkRegression(realBaseline, dimDrop, { tolerance: rubric.regressionTolerance });
  check("D5 hidden per-dimension collapse is caught even when overall holds",
    ev2.pass === false && ev2.regressions.length === 1 && ev2.regressions[0].site === "e-commerce"
      && ev2.regressions[0].dimensionDrops.some((d) => d.dim === "visualSimilarity"),
    JSON.stringify(ev2.regressions[0]?.dimensionDrops));

  const ev3 = evaluateBenchmarkRegression(realBaseline, [...results, { site: "brand-new-site", overall: 90, dimensions: {} }]);
  check("D6 site without a baseline entry is unanchored (reported, never a silent pass/fail)",
    ev3.unanchored.length === 1 && ev3.unanchored[0].site === "brand-new-site" && ev3.pass === true);
  check("D7 evaluation is deterministic (two runs identical)", deepEq(
    evaluateBenchmarkRegression(realBaseline, dropped, { tolerance: rubric.regressionTolerance }),
    evaluateBenchmarkRegression(realBaseline, dropped, { tolerance: rubric.regressionTolerance })));

  // similarity ledger round-trip on real fs
  const ledgerPath = path.join(OUT, "benchmark-visual-ledger.json");
  const records = results.map((r) => ({ site: r.site, similarityPct: 97.5 }));
  writeSimilarityLedger(ledgerPath, records, { rubricVersion: rubric.version, fixtureVersion: "1.0.0" });
  const round = readSimilarityLedger(ledgerPath);
  check("D8 similarity ledger write→read round-trip (atomic, versioned)",
    round.version === LEDGER_VERSION && round.perSite["multi-route"].similarityPct === 97.5
      && JSON.parse(fs.readFileSync(ledgerPath, "utf8")).fixtureVersion === "1.0.0");
  const noDrop = evaluateSimilarityLedger(round, records, { tolerance: rubric.regressionTolerance });
  const withDrop = evaluateSimilarityLedger(round, records.map((r) => r.site === "multi-route" ? { ...r, similarityPct: 92 } : r), { tolerance: rubric.regressionTolerance });
  check("D9 visual similarity drop beyond tolerance flags a visual regression",
    noDrop.pass === true && withDrop.pass === false
      && withDrop.regressions[0].site === "multi-route" && withDrop.regressions[0].drop === 5.5,
    JSON.stringify(withDrop.regressions));

  const badPath = path.join(OUT, "broken-ledger.json");
  fs.writeFileSync(badPath, "{ not json");
  let threw = null;
  try { readSimilarityLedger(badPath); } catch (e) { threw = e.message; }
  check("D10 malformed ledger fails CLOSED (prevention hook never silently accepts)",
    threw !== null && /malformed|v1/.test(threw), threw);

  // one-call gate hook
  const gate = regressionGate({ tolerance: rubric.regressionTolerance, ledgerPath });
  const seeded = gate.seed(results, { rubricVersion: rubric.version, fixtureVersion: "1.0.0" });
  const evG = gate.evaluate(seeded, results);
  gate.writeLedger(records, { rubricVersion: rubric.version, fixtureVersion: "1.0.0" });
  const ckG = gate.checkLedger(records.map((r) => ({ site: r.site, similarityPct: r.similarityPct })));
  check("D11 regressionGate one-call hook: seed + evaluate + ledger all live",
    gate.tolerance === rubric.regressionTolerance && evG.pass === true && ckG.pass === true
      && gate.ledgerPath === ledgerPath);
  check("D12 REGRESSION_TOLERANCE fallback matches the rubric default", REGRESSION_TOLERANCE === 3 && rubric.regressionTolerance === 3);
  check("D13 BENCHMARK_WIRING documents the integrator hooks",
    Array.isArray(BENCHMARK_WIRING) && BENCHMARK_WIRING.length >= 2
      && BENCHMARK_WIRING.some((l) => l.includes("test-multisite-benchmark.mjs"))
      && Object.isFrozen(BENCHMARK_WIRING));

  // LAYOUT_KINDS contract
  check("D14 LAYOUT_KINDS = geometry + stacking (the layout-repair vocabulary)",
    deepEq([...LAYOUT_KINDS], ["geometry", "stacking"]));
}

// ===========================================================================
console.log(`\n==== visual-optimizer: ${pass} passed, ${fail} failed ====`);
if (fail > 0) process.exit(1);
console.log("ALL CHECKS PASS");
