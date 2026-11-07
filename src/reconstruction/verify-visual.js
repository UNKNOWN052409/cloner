// Stage-3 VISUAL engine (split from verify.js, file-size cap): comparison.txt
// parsing, the dynamic-region structural comparison, the pixel/heatmap stage
// (stage3Visual) and the EXACT HEX token comparison — moved verbatim; verify.js
// re-exports the published helpers. parseRuntimeRecords moved here too (shared
// by stages 1/2 and the repair loop, which import it from this module).
import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { launchBrowser } from "../browser.js";
import { DOM_EXTRACTOR_SCRIPT } from "../intelligence/dom-extractor.js"; // clone element measurement

export function parseRuntimeRecords(out) {
  // v1 writes cloner-runtime.js; v2 reconstruction writes runtime/interactions.js
  for (const f of ["cloner-runtime.js", path.join("runtime", "interactions.js")]) {
    try {
      const rt = fs.readFileSync(path.join(out, f), "utf8");
      const m = rt.match(/window\.__CLONER_INTERACTIONS = (\[.*\]);?\s*$/m);
      return { records: JSON.parse(m ? m[1] : "[]"), error: null };
    } catch {}
  }
  return { records: [], error: "no runtime file" };
}

// 12×8 grid index → page region estimate: top rows = header, middle = content,
// bottom = footer; columns add left/center/right precision
export function regionForCell(cell, gx = 12) {
  const row = Math.floor(cell / gx), col = cell % gx;
  const band = row <= 2 ? "header" : row <= 5 ? "content" : "footer";
  const side = col < 4 ? "left" : col < 8 ? "center" : "right";
  return { row, col, region: `${band}-${side}` };
}

// comparison.txt (written by compare-clone.mjs) → structured: pixel %, hottest
// heatmap cells with region names, token-drift table as JSON, grade
export function parseComparisonTxt(text) {
  const pct = Number((text.match(/pixels differing\s*:\s*([\d.]+)%/) || [])[1] ?? NaN);
  const meanDelta = Number((text.match(/mean channel delta\s*:\s*([\d.]+)\/255/) || [])[1] ?? NaN);
  const hotLine = (text.match(/hottest regions \(12×8 grid\):\s*(.*)/) || [])[1] || "";
  const hotRegions = [...hotLine.matchAll(/#(\d+)=([\d.]+)/g)].map((m) => {
    const cell = Number(m[1]);
    return { cell, score: Number(m[2]), ...regionForCell(cell) };
  });
  const tokens = [];
  const tokStart = text.indexOf("token drift");
  if (tokStart >= 0) {
    for (const line of text.slice(tokStart).split("\n").slice(1)) {
      const ok = line.match(/^\s+(.+?)\s{2,}(\d+)\/(\d+)\s+match\s*$/);
      const bad = line.match(/^\s+(.+?)\s{2,}failed:\s*(.*)$/);
      if (ok) tokens.push({ token: ok[1].trim(), matched: Number(ok[2]), total: Number(ok[3]) });
      else if (bad) tokens.push({ token: bad[1].trim(), error: bad[2].trim().slice(0, 120) });
    }
  }
  const grade = (text.match(/^grade:\s*(.+)$/m) || [])[1] || null;
  return { pct, meanDelta, hotRegions, tokens, grade, parsed: !Number.isNaN(pct) };
}

// rgb(a) string → #rrggbb hex (alpha dropped for comparison); fully transparent
// colors return null — transparent black is NOT #000000
export function toHex(rgbStr) {
  const m = String(rgbStr || "").match(/rgba?\(\s*(\d+)[,\s]+(\d+)[,\s]+(\d+)(?:[,\s/]+([\d.]+%?)\s*)?\)/);
  if (!m) return null;
  if (m[4] !== undefined && Number(m[4]) === 0) return null;
  return "#" + [m[1], m[2], m[3]].map((n) => Number(n).toString(16).padStart(2, "0")).join("").toLowerCase();
}

// ====================================== VISUAL — DYNAMIC-REGION STRUCTURE
// Data-driven pages (live quotes, charts, timestamps) drift PIXELS between
// sessions by nature — the QA report's grade C on the authed Tradovate clone
// is exactly this (docs/realignment/qa-report-authenticated-tradovate.md).
// For a region whose content is known-dynamic, raw pixels are the wrong
// comparison: the region is compared STRUCTURALLY instead — element counts
// within tolerance + layout rects within pixel tolerance. The global pixel
// threshold below is NEVER loosened: the structural path can only carry the
// verdict when EVERY hottest heatmap cell is covered by a dynamic region AND
// the region structure matches, and the check detail says so in plain text.

const DYNAMIC_TAG_SET = new Set(["canvas", "svg"]);
const DYNAMIC_HINT_RE = /(chart|quote|price|ticker|clock|time|graph|spark|candle|feed|live|depth)/i;

// elements of a dom.json sample whose content is known-dynamic (rendered
// content by construction for canvas/svg; class/id/text hints for quote,
// ticker, clock and friends)
export function dynamicRegionElements(elements) {
  return (elements || []).filter((e) => {
    if (!e || !e.rect) return false;
    // canvas-snapshot imgs ARE dynamic canvas regions: the extractor replaces
    // painted canvases with data-cloner-snap imgs before sampling, so the
    // original dom.json carries tag=img — recognize them by their snap marker
    if (String(e.cls || "").includes("cloner-snap") || e.dataClonerSnap) return true;
    if (DYNAMIC_TAG_SET.has(String(e.tag || ""))) return true;
    return DYNAMIC_HINT_RE.test(String(e.cls || "") + " " + String(e.id || "") + " " + String(e.text || ""));
  });
}

// 12×8 heatmap cell index → pixel rect over the compared W×H frame
export function cellRect(cell, W, H, gx = 12, gy = 8) {
  const col = cell % gx, row = Math.floor(cell / gx);
  return { x: Math.floor((col / gx) * W), y: Math.floor((row / gy) * H), w: Math.max(1, Math.ceil(W / gx)), h: Math.max(1, Math.ceil(H / gy)) };
}

export function rectsIntersect(a, b) {
  return !!(a && b && a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h);
}

// which hottest heatmap cells are covered by a dynamic region — the attribution
// gate: only when every hot cell is dynamic can the elevated pixel diff be
// attributed to data drift rather than layout drift
export function dynamicAttribution(hotRegions, dynEls, W, H) {
  const cells = (hotRegions || []).map((h) => {
    const rect = cellRect(h.cell, W, H);
    const hit = (dynEls || []).find((e) => rectsIntersect(rect, e.rect));
    return { cell: h.cell, score: h.score, region: h.region, covered: !!hit, by: hit ? `${hit.tag}${hit.cls ? "." + String(hit.cls).split(/\s+/)[0] : ""}` : null };
  });
  return { cells, allCovered: cells.length > 0 && cells.every((c) => c.covered) };
}

// STRUCTURE comparison of one dynamic region, anchored on the region element
// itself (matched on the clone side by tag + rect overlap — the generator
// renames classes to cx-N, so class identity does not survive). Element counts
// come from each side's OWN region interior (center-in), and the anchor rect
// must land within position + size tolerance. Intersecting both sides against
// the ORIGINAL rect was wrong: the generator's synthetic page wrapper spans the
// whole document (intersects every region) and a small page-level shift pulls
// boundary elements in/out — measured on the depth fixture: intersect-counting
// read canvas 3→5 elements + 108px bbox drift while the canvas itself had
// moved 48px and resized 0.2%.
export function compareRegionStructure(origAnchor, cloneAnchor, origEls, cloneEls, { countTol = 0.5, rectTolPx = 64, sizeTol = 0.15 } = {}) {
  const centerIn = (els, r) => (els || []).filter((e) => {
    if (!e || !e.rect) return false;
    const cx = e.rect.x + e.rect.w / 2, cy = e.rect.y + e.rect.h / 2;
    return cx > r.x && cx < r.x + r.w && cy > r.y && cy < r.y + r.h;
  });
  const o = centerIn(origEls, origAnchor.rect);
  const c = centerIn(cloneEls, cloneAnchor.rect);
  const countOk = o.length === 0 ? c.length === 0 : Math.abs(c.length - o.length) / o.length <= countTol;
  const posDrift = Math.max(Math.abs(cloneAnchor.rect.x - origAnchor.rect.x), Math.abs(cloneAnchor.rect.y - origAnchor.rect.y));
  const wRatio = origAnchor.rect.w ? Math.abs(cloneAnchor.rect.w - origAnchor.rect.w) / origAnchor.rect.w : 0;
  const hRatio = origAnchor.rect.h ? Math.abs(cloneAnchor.rect.h - origAnchor.rect.h) / origAnchor.rect.h : 0;
  const sizeDrift = Math.max(wRatio, hRatio);
  const rectOk = posDrift <= rectTolPx && sizeDrift <= sizeTol;
  return { ok: countOk && rectOk, origCount: o.length, cloneCount: c.length, countOk, drift: Math.round(posDrift), sizeDrift: +sizeDrift.toFixed(3), rectOk, countTol, rectTolPx, sizeTol };
}

// rect overlap (IoU) — the clone-side anchor matcher for dynamic regions
export function rectIoU(a, b) {
  if (!a || !b) return 0;
  const ix = Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x));
  const iy = Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
  const inter = ix * iy;
  const union = a.w * a.h + b.w * b.h - inter;
  return union > 0 ? inter / union : 0;
}

// run the dynamic-region path for stage 3: v2 only (needs the page-001 dom
// evidence as the original side), renders the clone with the same extractor +
// viewport as compare-clone.mjs, compares structure per dynamic region and
// reports which hottest cells the dynamic regions cover
async function dynamicStructuralCheck(out, artifactsDir, cmp, W, H, { diffElevated = true } = {}) {
  const result = { applicable: false, ran: false, ok: true, allCovered: false, regions: [], detail: "" };
  if (!artifactsDir) { result.detail = "not applicable (v1 layout — no exploration dom evidence to compare structure against)"; return result; }
  let origEls = null;
  try { origEls = JSON.parse(fs.readFileSync(path.join(artifactsDir, "pages", "page-001", "dom.json"), "utf8")).elements; } catch {}
  if (!Array.isArray(origEls)) { result.detail = "not applicable (pages/page-001/dom.json missing or malformed)"; return result; }
  result.applicable = true;
  const dynEls = dynamicRegionElements(origEls);
  if (!dynEls.length) { result.detail = `no dynamic regions detected in the captured DOM (0 of ${origEls.length} sampled elements) — structural path not applicable`; return result; }
  if (!cmp.hotRegions.length) { result.detail = "no heatmap cells parsed — nothing to attribute to dynamic regions"; return result; }
  let cloneEls = [];
  const b = await launchBrowser({ headless: true });
  try {
    const p = await b.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
    await p.goto("file:///" + path.join(out, "index.html").replace(/\\/g, "/"), { waitUntil: "load", timeout: 30000 });
    await p.waitForTimeout(700);
    const intel = await p.evaluate(DOM_EXTRACTOR_SCRIPT).catch(() => null);
    if (intel && Array.isArray(intel.elements)) cloneEls = intel.elements;
    await p.close();
  } finally {
    await b.close().catch(() => {});
  }
  result.ran = true;
  const attr = dynamicAttribution(cmp.hotRegions, dynEls, W, H);
  // grade-aware: with a non-elevated diff (grade A), static noise cells do
  // not block attribution — record them but don't fail the gate
  result.allCovered = diffElevated ? attr.allCovered : true;
  result.cells = attr.cells;
  const regions = [...dynEls].sort((a, b2) => (b2.rect.w * b2.rect.h) - (a.rect.w * a.rect.h)).slice(0, 6);
  const hotRects = cmp.hotRegions.map((h) => cellRect(h.cell, W, H));
  result.regions = regions.map((r) => {
    // canvas snapshots carry tag=img — label them canvas so the region names
    // stay stable for consumers that key on the painted-surface kind
    const isSnap = String(r.cls || "").includes("cloner-snap") || r.dataClonerSnap;
    const tagForLabel = isSnap ? "canvas" : r.tag;
    const label = `${tagForLabel}${r.cls && !isSnap ? "." + String(r.cls).split(/\s+/)[0] : ""}`;
    // the regions that gate the verdict are the ones carrying the pixel
    // disagreement (covering a hottest cell) — a dynamic region no hot cell
    // touches contributed nothing measurable, so its shape mismatch is
    // reported but not gating (small elements like a clock scatter under
    // page-level shift without moving any cell's mean)
    const coversHot = hotRects.some((hr) => rectsIntersect(hr, r.rect));
    // clone-side anchor: same tag, highest rect overlap (classes are renamed cx-N)
    let anchor = null, best = 0;
    for (const e of cloneEls) {
      if (!e || e.tag !== r.tag || !e.rect) continue;
      const v = rectIoU(r.rect, e.rect);
      if (v > best) { best = v; anchor = e; }
    }
    if (!anchor || best < 0.3) {
      // No same-tag anchor. When the pixel grade is A the diff is antialiasing
      // noise, not layout drift — the clone renders this area correctly (the
      // screenshot proved it); report the region as observed-missing but don't
      // let it gate. With an elevated diff this stays a hard fail: missing
      // structure + pixel drift together = real layout gap.
      if (!diffElevated) return { region: label, rect: r.rect, coversHot, ok: true, missing: true, nonGatedGradeA: true, origCount: 0, cloneCount: 0, countOk: false, drift: null, sizeDrift: null, rectOk: false };
      return { region: label, rect: r.rect, coversHot, ok: false, missing: true, origCount: 0, cloneCount: 0, countOk: false, drift: null, sizeDrift: null, rectOk: false };
    }
    return { region: label, rect: r.rect, coversHot, ...compareRegionStructure(r, anchor, origEls, cloneEls) };
  });
  const gating = result.regions.filter((r) => r.coversHot);
  result.ok = gating.length ? gating.every((r) => r.ok) : result.regions.every((r) => r.ok);
  const parts = result.regions.map((r) => (r.missing
    ? `${r.region}${r.coversHot ? " [gating]" : ""}: MISSING in the clone (no same-tag element overlaps the captured region)`
    : `${r.region}${r.coversHot ? " [gating]" : ""}: elements ${r.origCount}→${r.cloneCount} (${r.countOk ? "within" : "OUTSIDE"} ±${Math.round(r.countTol * 100)}%), anchor drift ${r.drift}px / size ±${(r.sizeDrift * 100).toFixed(1)}% (${r.rectOk ? "within" : "OUTSIDE"} ${r.rectTolPx}px, ±${Math.round(r.sizeTol * 100)}%)`));
  result.detail = (result.ok ? "structure matches" : "structure drift")
    + " — " + parts.join(" | ")
    + "; hot cells: " + attr.cells.map((c) => `#${c.cell}=${c.covered ? "dynamic(" + c.by + ")" : "static"}`).join(", ")
    + " — dynamic content compared STRUCTURALLY (pixel diff there is data drift, not layout drift); verdict gated on the [gating] regions that carry the hottest cells; global 60% threshold unchanged";
  return result;
}

// ============================================================ STEP 3 — VISUAL
export function stage3Visual(out, artifactsDir = null) {
  return new Promise((resolve) => {
    // v1: compare within the run dir. v2: the original screenshot is the
    // exploration capture (pages/page-001/) and the clone lives in -project/
    const args = [path.join(process.cwd(), "scripts", "compare-clone.mjs"), out];
    if (artifactsDir) {
      const origShot = path.join(artifactsDir, "pages", "page-001", "screenshot-viewport.png");
      args.push("4199", origShot, path.join(out, "index.html"), artifactsDir);
    }
    execFile(process.execPath, args, { timeout: 180000 }, async (err, stdout, stderr) => {
      let srcText = (stdout || "") + (err?.stdout || "") + (stderr || "");
      let cmp = parseComparisonTxt(srcText);
      if (!cmp.parsed) {
        try {
          srcText = fs.readFileSync(path.join(artifactsDir || out, "_reference", "comparison.txt"), "utf8");
          cmp = parseComparisonTxt(srcText);
        } catch {}
      }
      // compared frame geometry — the 12×8 heatmap cells map onto these pixels
      // (\u00d7 = the multiplication sign compare-clone.mjs prints)
      const dimMatch = srcText.match(/pixels compared\s*:\s*(\d+)\s*\u00d7\s*(\d+)/);
      const cmpW = dimMatch ? Number(dimMatch[1]) : 1440;
      const cmpH = dimMatch ? Number(dimMatch[2]) : 900;
      // dynamic-region structural comparison (data-driven pages: live quotes/
      // charts/timestamps drift pixels between sessions by nature).
      // Grade-aware attribution: a near-identical clone (grade A, low mean
      // delta) has its top hot cells scattered across static antialiasing
      // noise — those are not layout-drift evidence, so static cells only
      // block (allCovered=false → gating) when the diff is elevated (grade
      // B/C/D). Structure comparison itself always runs.
      const diffElevated = /^B|C|D/.test(String(cmp.grade)) || cmp.pct > 15;
      const dyn = await dynamicStructuralCheck(out, artifactsDir, cmp, cmpW, cmpH, { diffElevated }).catch((e) => ({
        applicable: false, ran: false, ok: true, allCovered: false, regions: [],
        detail: "dynamic-region check failed: " + String(e?.message || e).slice(0, 80),
      }));
      // EXACT HEX comparison: live tokens (design-tokens.json) vs re-measured clone
      const hexReport = await hexTokenComparison(out, artifactsDir);
      const pct = cmp.pct;
      // a category with zero captured evidence can't drift — the same
      // absence-is-not-failure rule the EXACT HEX comparison below applies
      // (before G4.1 this demanded total > 0, so a page with no captured
      // background colors failed the token check at a perfect 0/0 match)
      const tokenOk = cmp.tokens.length > 0 && cmp.tokens.every((t) => !t.error && (t.total === 0 || t.matched / t.total >= 0.5));
      // total=0 = no captured evidence for that category — absence can't fail
      const hexOk = hexReport.error ? false : hexReport.categories.every((c) => c.total === 0 || c.matched / c.total >= 0.7);
      const pixelOk = cmp.parsed && pct < 60; // global threshold — NEVER loosened
      // the structural path can carry the verdict only when the comparison is
      // parseable, EVERY hottest cell is covered by a known-dynamic region, and
      // the region structure matches within tolerance — and even then only
      // below a hard 95% ceiling (near-total drift is never "data noise")
      const structuralCarry = cmp.parsed && dyn.applicable && dyn.ran && dyn.ok && dyn.allCovered && pct < 95;
      resolve({
        stage: "visual",
        passed: cmp.parsed && hexOk && (pixelOk || structuralCarry),
        checks: [
          { name: "pixel difference", ok: pixelOk, detail: cmp.parsed ? `${pct}% (threshold 60%), mean delta ${cmp.meanDelta}/255, grade: ${cmp.grade || "n/a"}${structuralCarry && !pixelOk ? " — above threshold, verdict carried by the dynamic-region structural comparison (see that check)" : ""}` : "compare failed — no parseable report" },
          { name: "token drift (categories)", ok: tokenOk, detail: cmp.tokens.length ? cmp.tokens.map((t) => (t.error ? `${t.token}: ERROR` : `${t.token} ${t.matched}/${t.total}`)).join(", ") : "no token rows parsed" },
          { name: "exact HEX comparison", ok: hexOk, detail: hexReport.error ? "failed: " + hexReport.error : hexReport.categories.map((c) => `${c.category} ${c.matched}/${c.total} (${c.drifted.slice(0, 3).map((d) => `live ${d.live} ≠ clone ${d.clone}`).join(", ")})`).join(" | ") },
          { name: "extra/missing elements", ok: hexReport.error ? false : hexReport.extra.length === 0 && hexReport.missing.length === 0, detail: hexReport.error ? "n/a" : `extra: ${hexReport.extra.length ? hexReport.extra.join(",") : "none"} · missing-capture: ${hexReport.missing.length ? hexReport.missing.join(",") : "none"}` },
          { name: "heatmap hottest regions", ok: cmp.hotRegions.length > 0, detail: cmp.hotRegions.length ? cmp.hotRegions.map((h) => `${h.region} (#${h.cell}, score ${h.score})`).join("; ") : "no heatmap cells parsed" },
          { name: "dynamic-region structural comparison", ok: dyn.ok, notApplicable: !dyn.applicable || !dyn.ran, detail: dyn.detail },
        ],
        heatmap: { grid: "12×8", hotRegions: cmp.hotRegions },
        dynamicRegions: dyn,
        tokens: cmp.tokens,
        hex: hexReport,
        report: "_reference/comparison.txt + diff.png",
      });
    });
  });
}

// render the clone, measure its tokens, HEX-compare against the live site's
// measured tokens (design-tokens.json) + report extra/missing interactive elements
async function hexTokenComparison(out, artifactsDir = null) {
  try {
    const live = JSON.parse(fs.readFileSync(path.join(artifactsDir || out, "design-tokens.json"), "utf8"));
    const b = await launchBrowser({ headless: true });
    // The live token set (design-tokens.json) is measured across EVERY explored
    // page (reconstruction-pipeline.js:390 stylesElements = pages.flatMap(
    // p.styles.elements) — exp-mw5l1whwd178: 455 elements = 373+53+29), but the
    // clone side used to measure ONLY index.html, so a family/color the source
    // used on a secondary page (Roboto-Regular on the open-account form) could
    // never match and the exact-HEX gate failed at fonts 2/3 (66.7% < 70%).
    // Measure every generated clone page and union the computed token maps —
    // the same page set the live side aggregated. extra/missing interactive
    // element bookkeeping stays on the root page (same scope as the stage-2
    // dead-attr scan).
    const clonePages = fs.readdirSync(out).filter((f) => f.endsWith(".html")).sort();
    const p = await b.newPage({ viewport: { width: 1440, height: 900 } });
    const freq = { colors: {}, backgrounds: {}, fonts: {}, fontSizes: {}, spacing: {}, radii: {} };
    let extraTriggers = [];
    for (const pageFile of clonePages) {
      try {
        await p.goto("file:///" + path.join(out, pageFile).replace(/\\/g, "/"), { waitUntil: "load", timeout: 30000 });
        await p.waitForTimeout(900);
        const pageTokens = await p.evaluate(() => {
          const f = { colors: {}, backgrounds: {}, fonts: {}, fontSizes: {}, spacing: {}, radii: {} };
          const els = document.querySelectorAll("body *");
          const step = Math.max(1, Math.floor(els.length / 3500));
          for (let i = 0; i < els.length; i += step) {
            const el = els[i]; const cs = getComputedStyle(el);
            if (cs.color) f.colors[cs.color] = (f.colors[cs.color] || 0) + 1;
            if (cs.backgroundColor && cs.backgroundColor !== "rgba(0, 0, 0, 0)") f.backgrounds[cs.backgroundColor] = (f.backgrounds[cs.backgroundColor] || 0) + 1;
            const fam = (cs.fontFamily || "").split(",")[0].replace(/["']/g, "");
            if (fam) f.fonts[fam] = (f.fonts[fam] || 0) + 1;
            if (cs.fontSize) f.fontSizes[cs.fontSize] = (f.fontSizes[cs.fontSize] || 0) + 1;
            if (cs.margin && cs.margin !== "0px") f.spacing[cs.margin] = (f.spacing[cs.margin] || 0) + 1;
            if (cs.borderRadius && cs.borderRadius !== "0px") f.radii[cs.borderRadius] = (f.radii[cs.borderRadius] || 0) + 1;
          }
          return f;
        });
        for (const cat of Object.keys(freq)) {
          for (const [v, n] of Object.entries(pageTokens[cat] || {})) freq[cat][v] = (freq[cat][v] || 0) + n;
        }
        // extra-trigger bookkeeping: root page only (index.html sorts first and
        // is always present — REQUIRED_ARTIFACTS_V2 gate it)
        if (pageFile === "index.html") {
          extraTriggers = await p.evaluate(() => [...document.querySelectorAll("[data-cloner-trigger]")].map((e) => e.getAttribute("data-cloner-trigger")));
        }
      } catch { /* an unloadable page contributes nothing — the rest still counts */ }
    }
    const top = (o, n = 12) => Object.entries(o).sort((a, b2) => b2[1] - a[1]).slice(0, n);
    const clone = { colors: top(freq.colors), backgrounds: top(freq.backgrounds), fonts: top(freq.fonts, 6), fontSizes: top(freq.fontSizes, 10), spacing: top(freq.spacing, 12), radii: top(freq.radii, 8), extraTriggers };
    await p.close();
    await b.close().catch(() => {});

    const categories = [];
    for (const cat of ["colors", "backgrounds", "fonts", "fontSizes", "spacing", "radii"]) {
      const liveSet = new Map((live[cat] || []).map(([v, n]) => [toHex(cat === "fonts" || cat === "fontSizes" || cat === "spacing" ? v : v) ?? String(v).toLowerCase(), v]));
      const cloneSet = new Map((clone[cat] || []).map(([v]) => [toHex(cat === "fonts" || cat === "fontSizes" || cat === "spacing" ? v : v) ?? String(v).toLowerCase(), v]));
      let matched = 0; const drifted = [];
      for (const [key, value] of liveSet) {
        if (cloneSet.has(key)) matched++;
        else if (drifted.length < 5) drifted.push({ live: value, clone: cloneSet.get(key) || null });
      }
      categories.push({ category: cat, matched, total: liveSet.size, drifted });
    }
    // extra elements in the clone that the original never had (dead interactive marks)
    const { records } = parseRuntimeRecords(out);
    const recordIds = new Set(records.map((r) => r.id));
    const extra = clone.extraTriggers.filter((id) => !recordIds.has(id));
    // behaviors the explorer documented but that produced no replayable record
    let missing = [];
    try {
      const expl = JSON.parse(fs.readFileSync(path.join(artifactsDir || out, "exploration.json"), "utf8"));
      missing = (expl.behaviors || []).filter((bh) => bh.trigger?.id && !recordIds.has(bh.trigger.id)).map((b) => b.trigger.id).slice(0, 8);
    } catch {}
    return { categories, extra, missing };
  } catch (e) {
    return { error: e.message.slice(0, 120), categories: [], extra: [], missing: [] };
  }
}
