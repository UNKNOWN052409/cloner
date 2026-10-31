// Visual-fidelity e2e (task 3.4.3) — deterministic, zero external network.
//
// Fixture: a page with KNOWN typography (h1 weight 400, tracked uppercase
// label, fixed-size cards) is rendered in Playwright at a fixed viewport with
// deviceScaleFactor 1. A hand-built "reconstructed" clone models EXACTLY the
// drift the real generator introduces (buildComponentCss drops font-weight
// "400" — project-generator.js:39 — and never emits letter-spacing, and
// per-element boxes can drift), plus one removed card and one removed image.
//
// Asserted:
//  1. analyzeFidelity reports similarity + a 12×8 region grid (compare-clone.mjs
//     geometry), hot regions, and is deterministic across repeated runs.
//  2. Typography mismatches are detected (h1 font-weight 400→700, label
//     letter-spacing 2px→normal) and CLASSIFIED by classifyDefects.
//  3. Geometry defects are detected (card shifted +12px, shrunk 10px) and
//     classified with area-weighted severity.
//  4. Missing-component (card) and missing-asset (img) defects are classified.
//  5. Transparent-RGBA regression: rgba(0, 0, 0, 0) never normalizes to black
//     and a transparent↔transparent element pair produces NO color defect.
//  6. refineTypography output (from the ORIGINAL captured styles) applied to
//     the clone improves measured fidelity: typography mismatch count drops
//     (the two modeled mismatches are repaired) and pixel meanDelta decreases.
//  7. Defect list is sorted large-area + high-salience first; every defect
//     carries severity/confidence/refs/repair action.
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import { launchBrowser } from "../src/browser.js";
import {
  analyzeFidelity, refineTypography, normalizeColor, pairElements, colorMismatches,
  GRID_X, GRID_Y,
} from "../src/reconstruction/visual-fidelity-analyzer.js";
import { classifyDefects, DEFECT_KINDS } from "../src/reconstruction/visual-diff-classifier.js";

const ROOT = path.resolve(".");
const VIEWPORT = { width: 1440, height: 900 }; // fixed viewport, DPR fixed to 1 below
let pass = 0, fail = 0;
const check = (name, ok, detail = "") => { console.log(`  ${ok ? "PASS" : "FAIL"} ${name}${detail ? " — " + detail : ""}`); ok ? pass++ : fail++; };

// ---- fixture: original page with known typography --------------------------
// h1 is weight 400 (NOT the UA bold default) so the generator's weight drop is
// a REAL drift; the label carries 2px tracking the generator never emits.
const ORIGINAL_HTML = `<!DOCTYPE html><html><head><title>Fidelity Fixture</title></head><body style="margin:0;font-family:Arial, sans-serif;font-size:16px;line-height:1.5;color:#111418">
<header class="topbar" style="height:64px;background:#0f1420;display:flex;align-items:center;padding:0 24px"><span class="brand" style="color:#ffffff;font-size:18px;font-weight:700">ACME</span></header>
<main style="padding:40px 24px;height:700px">
  <h1 class="title" style="font-size:40px;font-weight:400;line-height:1.2;margin:0 0 24px">Visual Fidelity Fixture</h1>
  <p class="label" style="letter-spacing:2px;font-size:12px;color:#6b7280;margin:0 0 24px">TRACKED LABEL</p>
  <section class="cards" style="display:flex;gap:16px">
    <div class="card-a" style="box-sizing:border-box;width:300px;height:160px;background:#f3f4f6;border-radius:8px;padding:16px">Card A body text</div>
    <div class="card-b" style="box-sizing:border-box;width:300px;height:160px;background:#f3f4f6;border-radius:8px;padding:16px">Card B body text</div>
    <div class="card-c" style="box-sizing:border-box;width:300px;height:160px;background:#f3f4f6;border-radius:8px;padding:16px">Card C body text</div>
    <div class="card-d" style="box-sizing:border-box;width:300px;height:160px;background:#f3f4f6;border-radius:8px;padding:16px">Card D body text</div>
  </section>
  <div class="ghost" style="width:200px;height:80px;background:rgba(0, 0, 0, 0);margin-top:24px">transparent bg</div>
  <img class="badge" src="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=" width="48" height="48" alt="badge" style="display:block;margin-top:24px">
  <span class="float-badge" style="position:absolute;top:200px;right:16px;width:24px;height:24px;background:#2563eb;border-radius:50%;z-index:5"></span>
</main></body></html>`;

// degraded clone — models buildComponentCss output for the SAME captured
// elements: weight "400" dropped (h1 renders UA bold), letter-spacing never
// emitted, card-b color drift, card-c box drift, card-d and img dropped,
// float-badge z-index lost. Every element keeps the generator's cx-N class of
// its ORIGINAL capture index (renderNode, project-generator.js:58).
const CLONE_HTML = (cx) => `<!DOCTYPE html><html><head><title>Fidelity Fixture</title></head><body style="margin:0;font-family:Arial, sans-serif;font-size:16px;line-height:1.5;color:#111418">
<header class="${cx("topbar")}" style="height:64px;background:#0f1420;display:flex;align-items:center;padding:0 24px"><span class="${cx("brand")}" style="color:#ffffff;font-size:18px;font-weight:700">ACME</span></header>
<main class="${cx(null)}" style="padding:40px 24px;height:700px">
  <h1 class="${cx("title")}" style="font-size:40px;line-height:48px;margin:0 0 24px">Visual Fidelity Fixture</h1>
  <p class="${cx("label")}" style="font-size:12px;color:#6b7280;margin:0 0 24px">TRACKED LABEL</p>
  <section class="${cx("cards")}" style="display:flex;gap:16px">
    <div class="${cx("card-a")}" style="box-sizing:border-box;width:300px;height:160px;background:#f3f4f6;border-radius:8px;padding:16px">Card A body text</div>
    <div class="${cx("card-b")}" style="box-sizing:border-box;width:300px;height:160px;background:#e5e7eb;border-radius:8px;padding:16px">Card B body text</div>
    <div class="${cx("card-c")}" style="box-sizing:border-box;margin-left:12px;width:290px;height:160px;background:#f3f4f6;border-radius:8px;padding:16px">Card C body text</div>
  </section>
  <div class="${cx("ghost")}" style="width:200px;height:80px;background:rgba(0, 0, 0, 0);margin-top:24px">transparent bg</div>
  <span class="${cx("float-badge")}" style="position:absolute;top:200px;right:16px;width:24px;height:24px;background:#2563eb;border-radius:50%"></span>
</main></body></html>`;

const PAGE_WITH_CSS = (html, css) => html.replace("</head>", `<style>${css}</style></head>`);

// ---- element extraction on a rendered page (dom.json shape; computed styles
// ---- include letterSpacing — the additive field refineTypography consumes) --
const EXTRACT_ELEMENTS = () => {
  const out = [];
  for (const el of document.querySelectorAll("body *")) {
    const r = el.getBoundingClientRect();
    if (r.width < 2 && r.height < 2) continue;
    const cs = getComputedStyle(el);
    out.push({
      i: out.length,
      tag: el.tagName.toLowerCase(),
      cls: String(el.className || "").trim() || null,
      parent: null,
      children: el.children.length,
      text: el.children.length === 0 ? (el.innerText || "").trim().slice(0, 60) : null,
      src: el.tagName === "IMG" ? (el.currentSrc || el.getAttribute("src") || null) : null,
      rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
      layout: { display: cs.display, position: cs.position },
      style: {
        backgroundColor: cs.backgroundColor,
        color: cs.color,
        fontFamily: cs.fontFamily.split(",")[0].replace(/["']/g, ""),
        fontSize: cs.fontSize,
        fontWeight: cs.fontWeight,
        lineHeight: cs.lineHeight,
        letterSpacing: cs.letterSpacing,
        zIndex: cs.zIndex,
      },
    });
  }
  return out;
};

// ---- serve fixture pages locally (no external network) ---------------------
const pages = new Map(); // path → html
const srv = http.createServer((req, res) => {
  const html = pages.get(req.url.split("?")[0]);
  if (html) { res.writeHead(200, { "content-type": "text/html" }); res.end(html); }
  else { res.writeHead(404); res.end("nf"); }
});
await new Promise((r) => srv.listen(0, "127.0.0.1", r));
const base = "http://127.0.0.1:" + srv.address().port;

const browser = await launchBrowser({ headless: true });

// render one fixture page at the FIXED viewport + deviceScaleFactor 1; returns
// the viewport screenshot buffer + the captured element list
const renderPage = async (urlPath) => {
  const ctx = await browser.newContext({ viewport: VIEWPORT, deviceScaleFactor: 1 });
  const page = await ctx.newPage();
  await page.goto(base + urlPath, { waitUntil: "load", timeout: 20000 });
  await page.waitForTimeout(150); // layout/font settle (system fonts — no FOUT)
  const shot = await page.screenshot(); // viewport-sized PNG, DPR 1
  const elements = await page.evaluate(EXTRACT_ELEMENTS);
  await ctx.close();
  return { shot, elements };
};

// dedicated analysis page handed to analyzeFidelity (injected-page contract)
const analysisCtx = await browser.newContext({ viewport: VIEWPORT, deviceScaleFactor: 1 });
const analysisPage = await analysisCtx.newPage();

try {
  pages.set("/original", ORIGINAL_HTML);
  const A = await renderPage("/original");
  const elsA = A.elements;
  const byCls = (cls) => elsA.find((e) => e.cls === cls);
  const titleIdx = byCls("title").i, labelIdx = byCls("label").i, badgeIdx = byCls("badge").i;
  const cardBIdx = byCls("card-b").i, cardCIdx = byCls("card-c").i, cardDIdx = byCls("card-d").i;
  const floatIdx = byCls("float-badge").i, ghostIdx = byCls("ghost").i;
  check("fixture captured 13 elements in document order", elsA.length === 13, `${elsA.length} elements; title=#${titleIdx} label=#${labelIdx}`);

  // degraded clone with generator cx-N classes of the ORIGINAL indices
  const cx = (real, idx) => `cx-${idx}${real ? " " + real : ""}`;
  const cloneHtml = CLONE_HTML((real) => cx(real, (byCls(real) || elsA.find((e) => e.tag === "main" && !e.cls)).i));
  pages.set("/clone", cloneHtml);
  const B = await renderPage("/clone");
  const elsB = B.elements;

  console.log("\n[1] analyzeFidelity — similarity + 12×8 region grid");
  const f1 = await analyzeFidelity(A.shot, B.shot, elsA, elsB, { page: analysisPage });
  check("similarity reported", Number.isFinite(f1.pixel.similarityPct) && f1.pixel.similarityPct > 0 && f1.pixel.similarityPct <= 100,
    `similarity ${f1.pixel.similarityPct}% (meanDelta ${f1.pixel.meanDelta}, diffPct ${f1.pixel.diffPct}%)`);
  check("12×8 region grid (compare-clone.mjs geometry)", f1.regions.length === GRID_X * GRID_Y && f1.regions.every((r) => Number.isFinite(r.score)), `${f1.regions.length} cells`);
  check("hot regions ranked", f1.hotRegions.length === 5 && f1.hotRegions[0].score >= f1.hotRegions[4].score, f1.hotRegions.map((h) => `#${h.cell}=${h.score}`).join(", "));
  check("viewport-sized decode at DPR 1", f1.dims.w === VIEWPORT.width && f1.dims.h === VIEWPORT.height, `${f1.dims.w}×${f1.dims.h}`);
  check("deterministic across repeated runs (pure function of inputs)", JSON.stringify((await analyzeFidelity(A.shot, B.shot, elsA, elsB, { page: analysisPage })).pixel) === JSON.stringify(f1.pixel)
    && JSON.stringify((await analyzeFidelity(A.shot, B.shot, elsA, elsB, { page: analysisPage })).regions.map((r) => r.score)) === JSON.stringify(f1.regions.map((r) => r.score)), "");

  console.log("\n[2] typography mismatches detected");
  check("h1 font-weight drift detected (captured 400 vs rendered 700)",
    f1.typography.mismatches.some((m) => m.i === titleIdx && m.field === "fontWeight" && m.original === "400" && m.clone === "700"),
    JSON.stringify(f1.typography.mismatches.map((m) => ({ i: m.i, f: m.field, o: m.original, c: m.clone }))));
  check("label letter-spacing drift detected (captured 2px vs rendered normal)",
    f1.typography.mismatches.some((m) => m.i === labelIdx && m.field === "letterSpacing" && m.original === "2px" && m.clone === "normal"), "");
  check("no uncaptured-field noise: fontFamily/fontSize clean",
    !f1.typography.mismatches.some((m) => m.field === "fontFamily" || m.field === "fontSize"), "");

  console.log("\n[3] geometry defects detected");
  const cardC = f1.geometry.deltas.find((d) => d.i === cardCIdx);
  check("card-c box drift measured (+12px x, -10px w)", cardC && cardC.dx === 12 && cardC.dw === -10 && cardC.errorPx === 12,
    cardC ? `dx=${cardC.dx} dy=${cardC.dy} dw=${cardC.dw} dh=${cardC.dh} err=${cardC.errorPx}px` : "not found");
  check("geometry tolerance: only the drifted card counts", f1.geometry.mismatched === 1, `mismatched=${f1.geometry.mismatched} of ${f1.geometry.paired} paired`);
  check("dropped elements reported (card + image)", f1.missing.count === 2 && f1.extra.count === 0,
    `missing=${f1.missing.count} [${f1.missing.elements.map((m) => m.cls).join(", ")}] extra=${f1.extra.count}`);
  check("missing image flagged as asset", f1.missing.elements.some((m) => m.i === badgeIdx && m.isImage === true), "");
  check("color drift measured (card-b background)", f1.color.mismatches.some((m) => m.i === cardBIdx && m.field === "backgroundColor"), "");
  check("stacking drift measured (float-badge z-index)", f1.stacking.mismatches.some((m) => m.i === floatIdx && m.fields.zIndex), "");

  console.log("\n[4] classifyDefects — categorized, area-weighted, actionable");
  const defects = classifyDefects(f1);
  const kinds = new Set(defects.map((d) => d.kind));
  check("all six defect kinds present", [...DEFECT_KINDS].every((k) => kinds.has(k)), [...kinds].join(", "));
  check("every defect carries severity/confidence/refs/action",
    defects.every((d) => d.severity > 0 && d.severity <= 1 && d.confidence > 0 && d.confidence <= 1 && Array.isArray(d.refs) && typeof d.action?.kind === "string" && d.action.kind.length > 0), "");
  check("sorted large-area + high-salience first", defects.every((d, idx) => idx === 0 || defects[idx - 1].severity >= d.severity), `top: ${defects[0].kind}@${defects[0].severity.toFixed(3)}`);
  check("typography defects classified with repair action",
    defects.some((d) => d.kind === "typography" && d.refs[0] === titleIdx && d.action.kind === "typography-override" && d.action.value === "400")
    && defects.some((d) => d.kind === "typography" && d.refs[0] === labelIdx && d.action.prop === "letterSpacing"), "");
  check("geometry defect classified with refs + adjust action",
    defects.some((d) => d.kind === "geometry" && d.refs[0] === cardCIdx && d.action.kind === "geometry-fix"), "");
  check("missing-component vs missing-asset separated",
    defects.some((d) => d.kind === "missing-component" && d.refs[0] === cardDIdx && d.action.kind === "add-component")
    && defects.some((d) => d.kind === "missing-asset" && d.refs[0] === badgeIdx && d.action.kind === "restore-asset"), "");
  check("stacking defect classified", defects.some((d) => d.kind === "stacking" && d.refs[0] === floatIdx && d.action.kind === "stacking-fix"), "");

  console.log("\n[5] transparent-RGBA regression (backgrounds must not go black)");
  check("normalizeColor: rgba(0, 0, 0, 0) → null (never #000000)", normalizeColor("rgba(0, 0, 0, 0)") === null && normalizeColor("rgba(0,0,0,0)") === null, "");
  check("normalizeColor: real black stays black", normalizeColor("#000000") === "#000000" && normalizeColor("rgb(0, 0, 0)") === "#000000", "");
  check("transparent pair produces NO color defect (ghost element)",
    !f1.color.mismatches.some((m) => m.i === ghostIdx) && !defects.some((d) => d.kind === "color" && d.refs[0] === ghostIdx), "");
  const ghostPair = pairElements(elsA.filter((e) => e.cls === "ghost"), elsB.filter((e) => (e.cls || "").includes("ghost")));
  check("transparent↔transparent compares equal", ghostPair.missing.length === 0 && ghostPair.matched === 1
    && colorMismatches(ghostPair.pairs).length === 0, "pairElements + colorMismatches on ghost only");

  console.log("\n[6] refineTypography — measured fidelity improvement");
  const refined = refineTypography(elsA);
  check("override emitted for the bold-drift h1 (font-weight: 400)",
    refined.overrides.some((o) => o.i === titleIdx && o.prop === "font-weight" && o.value === "400")
    && refined.css.includes(`.cx-${titleIdx} {`) && /\.cx-\d+ \{[^}]*font-weight: 400/.test(refined.css), "");
  check("override emitted for the tracked label (letter-spacing: 2px)",
    refined.overrides.some((o) => o.i === labelIdx && o.prop === "letter-spacing" && o.value === "2px"), "");
  check("line-height normalized to unitless ratios from captured px", refined.tokens.lineHeights.length > 0 && refined.tokens.lineHeights.every((v) => /^[\d.]+$/.test(v)), refined.tokens.lineHeights.join(", "));
  check("refinement never touches background/color (transparent-RGBA discipline)", !/background|^-?color:/im.test(refined.css), "");
  // apply the overrides the way the integration hook does (appended after the
  // generator's components.css — last rule wins at equal specificity)
  pages.set("/clone-fixed", PAGE_WITH_CSS(cloneHtml, refined.css));
  const B2 = await renderPage("/clone-fixed");
  const f2 = await analyzeFidelity(A.shot, B2.shot, elsA, B2.elements, { page: analysisPage });
  check("typography mismatch count drops after refinement", f2.typography.mismatchCount < f1.typography.mismatchCount,
    `${f1.typography.mismatchCount} → ${f2.typography.mismatchCount}`);
  check("h1 weight repaired", !f2.typography.mismatches.some((m) => m.i === titleIdx && m.field === "fontWeight"), "");
  check("label tracking repaired", !f2.typography.mismatches.some((m) => m.i === labelIdx && m.field === "letterSpacing"), "");
  check("pixel fidelity improves too (meanDelta decreases)", f2.pixel.meanDelta < f1.pixel.meanDelta,
    `meanDelta ${f1.pixel.meanDelta} → ${f2.pixel.meanDelta} (similarity ${f1.pixel.similarityPct}% → ${f2.pixel.similarityPct}%)`);
  check("unrelated defects persist honestly (geometry/color/missing untouched by typography fix)",
    f2.geometry.mismatched === f1.geometry.mismatched && f2.color.mismatchCount === f1.color.mismatchCount && f2.missing.count === f1.missing.count, "");

  // result record
  const outPath = path.join(ROOT, "artifacts", "test-visual-fidelity-result.json");
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify({
    pass, fail,
    pixel: { before: f1.pixel, afterRefinement: f2.pixel },
    typographyMismatches: { before: f1.typography.mismatchCount, afterRefinement: f2.typography.mismatchCount },
    defects: { total: defects.length, byKind: Object.fromEntries([...kinds].map((k) => [k, defects.filter((d) => d.kind === k).length])) },
    refineOverrides: refined.overrides.length,
  }, null, 2));
  console.log(`\nresult written: ${outPath}`);
} finally {
  await analysisCtx.close().catch(() => {});
  await browser.close().catch(() => {});
  srv.close();
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
