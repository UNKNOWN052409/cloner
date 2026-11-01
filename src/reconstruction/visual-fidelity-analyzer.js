// Visual fidelity analyzer (task 3.4.3): MEASURABLE typography/geometry/stacking
// fidelity between the original page evidence and the rendered clone — region
// based (12×8 grid, same geometry as scripts/compare-clone.mjs) instead of a
// single pixel count, so defects can be located, classified (see
// ./visual-diff-classifier.js) and repaired.
//
// Inputs mirror the reconstruction evidence shapes exactly:
//  - PNGs: original + clone screenshots (Buffer | base64 | data URL | file path).
//    Rendered at a fixed viewport with deviceScaleFactor 1 (exploration captures
//    viewport screenshots at DPR 1, src/pipeline/exploration-pipeline.js:151), so
//    element rects (viewport CSS px, src/intelligence/dom-extractor.js:34) map
//    1:1 onto screenshot pixels.
//  - Elements: dom.json element lists ({ i, tag, cls, rect: {x,y,w,h},
//    style: { fontFamily, fontSize, fontWeight, lineHeight, ... }, layout: { position, ... } }).
//
// Determinism: pure functions of the given inputs; the only browser work is an
// in-memory canvas decode of the two PNGs (no network, no filesystem reads from
// the page). Playwright page is injectable (opts.page) so callers reuse one
// browser; otherwise a headless one is launched and closed here.
//
// Transparent-RGBA regression guard (the class of bug that turned clone
// backgrounds black — buildTokens fixed it in
// src/reconstruction/analysis/layout-analyzer.js:55): normalizeColor() maps
// fully transparent colors to null, NEVER to #000000, on every path in this
// module (color comparison, defect classification, refine output).
//
// Integration hooks (applied by the integration agent — this module never edits
// shared pipeline files):
//  1. Typography refinement (fidelity-path improvement). In
//     src/reconstruction/reconstruction-pipeline.js reconstructFromArtifacts,
//     immediately after `componentsCssText = buildComponentCss(allElements, layoutByIndex)`
//     (~line 253), append the refinement overrides so the generated clone
//     carries the captured typography the generator drops:
//       import { refineTypography } from "./visual-fidelity-analyzer.js";
//       componentsCssText += "\n/* typography refinement overrides (3.4.3) */\n" + refineTypography(allElements).css;
//  2. Defect classification (post-render verification): render the clone, then
//       const fidelity = await analyzeFidelity(origPng, clonePng, originalElements, cloneElements, { page });
//       const defects = classifyDefects(fidelity); // ./visual-diff-classifier.js
import fs from "node:fs";
import { launchBrowser } from "../browser.js";

// Grid geometry — MUST stay in sync with scripts/compare-clone.mjs (12 columns × 8 rows).
export const GRID_X = 12;
export const GRID_Y = 8;

// Max per-channel delta (0-255) for a pixel to count as "differing" — same
// threshold as scripts/compare-clone.mjs so region scores are comparable.
export const DIFF_THRESHOLD = 30;

// A paired element whose box moved/resized by more than this many px (max of
// |dx|,|dy|,|dw|,|dh|) is a geometry defect. Below it is rendering noise.
export const GEOMETRY_TOLERANCE_PX = 2;

// Sub-pixel tolerance for computed font-size / line-height / letter-spacing
// string comparisons (computed styles round to fractional px).
export const PX_TOLERANCE = 0.5;

const clamp01 = (n) => Math.max(0, Math.min(1, Number(n) || 0));

// ---------------------------------------------------------------------------
// color normalization (transparent-RGBA regression guard)
// ---------------------------------------------------------------------------

// normalizeColor(v) → "#rrggbb" | verbatim lowercase fallback | null.
// null means "no visible color" (fully transparent / transparent keyword /
// empty) — it must NEVER become #000000. Real #000000 stays "#000000".
export function normalizeColor(v) {
  const s = String(v ?? "").trim();
  if (!s) return null;
  const m = s.match(/rgba?\(\s*(\d+)[,\s]+(\d+)[,\s]+(\d+)(?:[,\s/]+([\d.]+%?)\s*)?\)/i);
  if (m) {
    if (m[4] !== undefined && Number(m[4]) === 0) return null; // alpha 0 → invisible, not black
    return "#" + [m[1], m[2], m[3]].map((n) => Number(n).toString(16).padStart(2, "0")).join("").toLowerCase();
  }
  if (/^#[0-9a-f]{3,8}$/i.test(s)) {
    const hex = s.toLowerCase();
    if (hex.length === 4) return "#" + [...hex.slice(1)].map((c) => c + c).join("");
    if (hex.length === 5) { // #rgba
      if (parseInt(hex[4] + hex[4], 16) === 0) return null;
      return "#" + [hex[1], hex[2], hex[3]].map((c) => c + c).join("");
    }
    if (hex.length === 9) { // #rrggbbaa
      if (parseInt(hex.slice(7, 9), 16) === 0) return null;
      return hex.slice(0, 7);
    }
    return hex;
  }
  if (s.toLowerCase() === "transparent") return null;
  return s.toLowerCase(); // named colors etc. — compared verbatim (computed styles are rgb() strings in practice)
}

// ---------------------------------------------------------------------------
// element pairing
// ---------------------------------------------------------------------------

// Identity signature of an element: (tag, first class token), IGNORING the
// generator's own `cx-N` classes — a re-captured clone carries "cx-3 title"
// where the original captured "title", and the replay runtime's domPath skips
// cx-* tokens for the same reason (src/runtimeTemplate.js:56-58).
const sigClasses = (el) => String(el.cls || "").trim().split(/\s+/).filter((c) => c && !/^cx-\d+$/.test(c));
const firstClass = (el) => sigClasses(el)[0] || "";

// pairElements(originalElements, cloneElements):
//  pass 1 — same capture index i AND same (tag, first class): the reconstruction
//           renders the clone from the same element list, so indices align.
//  pass 2 — remaining originals pair with the first unused clone element with
//           the same (tag, first class) signature in captured order (survives
//           index shifts when the clone dropped an element).
//  leftovers: original side → missing; unused clone side → extra.
// Deterministic. Returns { pairs: [{ a, b, matchedBy }], missing, extra, matched }.
export function pairElements(originalElements, cloneElements) {
  const orig = (Array.isArray(originalElements) ? originalElements : []).filter((e) => e && typeof e === "object");
  const clone = (Array.isArray(cloneElements) ? cloneElements : []).filter((e) => e && typeof e === "object");
  const usedClone = new Set();
  const pairs = [];
  const leftover = [];
  const cloneByIndex = new Map();
  for (const b of clone) if (Number.isFinite(b.i)) cloneByIndex.set(b.i, b);
  for (const a of orig) {
    const b = Number.isFinite(a.i) ? cloneByIndex.get(a.i) : null;
    if (b && !usedClone.has(b) && b.tag === a.tag && firstClass(b) === firstClass(a)) {
      usedClone.add(b);
      pairs.push({ a, b, matchedBy: "index" });
    } else {
      leftover.push(a);
    }
  }
  for (const a of leftover) {
    const hit = clone.find((b) => !usedClone.has(b) && b.tag === a.tag && firstClass(b) === firstClass(a));
    if (hit) {
      usedClone.add(hit);
      pairs.push({ a, b: hit, matchedBy: "signature" });
    } else {
      pairs.push({ a, b: null, matchedBy: "missing" });
    }
  }
  return {
    pairs,
    missing: pairs.filter((p) => !p.b).map((p) => p.a),
    extra: clone.filter((b) => !usedClone.has(b)),
    matched: pairs.filter((p) => p.b).length,
  };
}

// ---------------------------------------------------------------------------
// per-axis comparisons (pure)
// ---------------------------------------------------------------------------

const pxOf = (v) => {
  const m = String(v ?? "").match(/^(-?\d+(?:\.\d+)?)px$/);
  return m ? parseFloat(m[1]) : null;
};
const normalizeWeight = (w) => {
  const s = String(w ?? "").trim().toLowerCase();
  if (s === "normal") return "400";
  if (s === "bold") return "700";
  return s || null;
};
const firstFamily = (v) => String(v ?? "").split(",")[0].replace(/["']/g, "").trim().toLowerCase();

// One typography field comparison. Both sides must be DEFINED (a field the
// capture did not record is honestly skipped, never guessed).
function typographyFieldMatches(field, va, vb) {
  if (va === undefined || vb === undefined || va === null || vb === null) return true; // not comparable → no claim
  if (field === "fontFamily") return firstFamily(va) === firstFamily(vb);
  if (field === "fontWeight") return normalizeWeight(va) === normalizeWeight(vb);
  const a = pxOf(va), b = pxOf(vb);
  if (field === "fontSize") {
    if (a === null || b === null) return String(va) === String(vb);
    return Math.abs(a - b) <= PX_TOLERANCE;
  }
  if (field === "lineHeight" || field === "letterSpacing") {
    // "normal" vs a px value is a real drift; px vs px uses the sub-pixel tolerance
    if (a === null || b === null) return String(va).trim().toLowerCase() === String(vb).trim().toLowerCase();
    return Math.abs(a - b) <= PX_TOLERANCE;
  }
  return String(va) === String(vb);
}

const TYPOGRAPHY_FIELDS = ["fontFamily", "fontSize", "fontWeight", "lineHeight", "letterSpacing"];

// Typography mismatches over paired elements. letterSpacing is part of the
// contract: compared whenever BOTH captures record it (the stock dom-extractor
// does not capture it yet — the field stays inert there until it does; the test
// capture does, mirroring an extractor addition).
export function typographyMismatches(pairs) {
  const out = [];
  for (const { a, b } of pairs) {
    if (!b) continue;
    const sa = a.style || {}, sb = b.style || {};
    for (const field of TYPOGRAPHY_FIELDS) {
      const va = sa[field], vb = sb[field];
      if (va === undefined || vb === undefined) continue; // uncaptured on either side — honest skip
      if (!typographyFieldMatches(field, va, vb)) {
        out.push({ i: a.i, tag: a.tag, cls: a.cls || null, field, original: va, clone: vb });
      }
    }
  }
  return out;
}

// Color mismatches (backgroundColor + color) over paired elements. Transparent
// normalizes to null on both sides (never black); null vs a real color is a
// real drift (a lost/added background) and IS reported, with the RAW values.
export function colorMismatches(pairs) {
  const out = [];
  for (const { a, b } of pairs) {
    if (!b) continue;
    const sa = a.style || {}, sb = b.style || {};
    for (const field of ["backgroundColor", "color"]) {
      const va = sa[field], vb = sb[field];
      if (va === undefined || vb === undefined) continue;
      if (normalizeColor(va) !== normalizeColor(vb)) {
        out.push({ i: a.i, tag: a.tag, cls: a.cls || null, field, original: va, clone: vb });
      }
    }
  }
  return out;
}

// Stacking mismatches: position (layout.position, falling back to
// style.position) and z-index (style.zIndex, "auto" ≡ missing).
export function stackingMismatches(pairs) {
  const out = [];
  for (const { a, b } of pairs) {
    if (!b) continue;
    const posA = a.layout?.position ?? a.style?.position ?? null;
    const posB = b.layout?.position ?? b.style?.position ?? null;
    const zA = a.style?.zIndex ?? null, zB = b.style?.zIndex ?? null;
    const nz = (z) => (z === "auto" || z === "" ? null : z);
    const fields = {};
    if (posA !== posB) fields.position = { original: posA, clone: posB };
    if (nz(zA) !== nz(zB)) fields.zIndex = { original: zA, clone: zB };
    if (Object.keys(fields).length) {
      out.push({ i: a.i, tag: a.tag, cls: a.cls || null, fields });
    }
  }
  return out;
}

// Geometry deltas for every paired element: translation + size deltas of the
// clone box relative to the original box, errorPx = max |delta|, errorPct
// relative to the smaller original box dimension.
export function geometryDeltas(pairs) {
  const deltas = [];
  for (const { a, b, matchedBy } of pairs) {
    if (!b || !a.rect || !b.rect) continue;
    const r = a.rect;
    const dx = b.rect.x - r.x, dy = b.rect.y - r.y;
    const dw = b.rect.w - r.w, dh = b.rect.h - r.h;
    const errorPx = Math.max(Math.abs(dx), Math.abs(dy), Math.abs(dw), Math.abs(dh));
    deltas.push({
      i: a.i, tag: a.tag, cls: a.cls || null, matchedBy,
      rect: { x: r.x, y: r.y, w: r.w, h: r.h },
      dx, dy, dw, dh,
      errorPx,
      errorPct: +(100 * errorPx / Math.max(1, Math.min(r.w || 1, r.h || 1))).toFixed(1),
    });
  }
  return deltas;
}

// cellOf(rect, dims) → grid cell index (row * GRID_X + col) of the rect CENTER,
// clamped into the grid. Null when rect/dims are unusable.
export function cellOf(rect, dims) {
  if (!rect || !dims || !(dims.w > 0) || !(dims.h > 0)) return null;
  const cx = (rect.x ?? 0) + (rect.w ?? 0) / 2;
  const cy = (rect.y ?? 0) + (rect.h ?? 0) / 2;
  const col = Math.min(GRID_X - 1, Math.max(0, Math.floor((cx / dims.w) * GRID_X)));
  const row = Math.min(GRID_Y - 1, Math.max(0, Math.floor((cy / dims.h) * GRID_Y)));
  return row * GRID_X + col;
}

// ---------------------------------------------------------------------------
// in-browser pixel diff (12×8 grid — mirrors scripts/compare-clone.mjs)
// ---------------------------------------------------------------------------

const DATA_URL_RE = /^data:image\//i;

function asDataUrl(png) {
  if (Buffer.isBuffer(png)) return "data:image/png;base64," + png.toString("base64");
  const s = String(png ?? "");
  if (DATA_URL_RE.test(s)) return s;
  if (s && fs.existsSync(s)) return "data:image/png;base64," + fs.readFileSync(s).toString("base64");
  return "data:image/png;base64," + s; // bare base64
}

const acquirePage = async (opts) => {
  if (opts.page) return { page: opts.page, owned: null };
  const browser = await launchBrowser({ headless: opts.headless !== false });
  const ctx = await browser.newContext({
    viewport: opts.viewport || { width: 1440, height: 900 },
    deviceScaleFactor: 1, // fixed DPR — element rects map 1:1 onto screenshot px
  });
  const page = await ctx.newPage();
  return { page, owned: browser };
};

async function pixelDiff(page, aData, bData) {
  return page.evaluate(async ({ aData, bData, gx, gy, threshold }) => {
    const load = (src) => new Promise((res, rej) => {
      const img = new Image();
      img.onload = () => res(img);
      img.onerror = () => rej(new Error("png decode failed"));
      img.src = src;
    });
    const A = await load(aData);
    const B = await load(bData);
    const W = Math.min(A.width, B.width), H = Math.min(A.height, B.height);
    const c = document.createElement("canvas");
    c.width = W; c.height = H;
    const ctx = c.getContext("2d", { willReadFrequently: true });
    const grab = (img) => { ctx.clearRect(0, 0, W, H); ctx.drawImage(img, 0, 0, W, H); return ctx.getImageData(0, 0, W, H).data; };
    const a = grab(A), b = grab(B);
    const cells = Array.from({ length: gx * gy }, () => ({ diff: 0, n: 0, differing: 0 }));
    let differing = 0, total = 0, sum = 0;
    for (let y = 0; y < H; y++) {
      const row = Math.min(gy - 1, Math.floor((y / H) * gy));
      for (let x = 0; x < W; x++) {
        const i = (y * W + x) * 4;
        const d = Math.max(Math.abs(a[i] - b[i]), Math.abs(a[i + 1] - b[i + 1]), Math.abs(a[i + 2] - b[i + 2]));
        sum += d; total++;
        const cell = cells[row * gx + Math.min(gx - 1, Math.floor((x / W) * gx))];
        cell.diff += d; cell.n++;
        if (d > threshold) { differing++; cell.differing++; }
      }
    }
    return {
      w: W, h: H,
      meanDelta: +(sum / (total || 1)).toFixed(2),
      diffPct: +((differing / (total || 1)) * 100).toFixed(2),
      cells: cells.map((c2, idx) => ({
        cell: idx,
        score: +(c2.diff / (c2.n || 1)).toFixed(1),
        diffPct: +((c2.differing / (c2.n || 1)) * 100).toFixed(2),
      })),
    };
  }, { aData, bData, gx: GRID_X, gy: GRID_Y, threshold: DIFF_THRESHOLD });
}

// ---------------------------------------------------------------------------
// complex-visual region classification (task 3.5.4)
// ---------------------------------------------------------------------------

// The closed vocabulary of complex visual regions a capture can classify.
// These are exactly the defect-repair targets 3.4.5's repair pipeline keys off:
// canvas regions expect the data-cloner-snap image treatment (src/browser.js:339),
// chart regions get chart repairs, svg regions are reconstructed as real SVG
// markup (NOT div placeholders), map regions carry marker evidence.
export const VISUAL_REGION_KINDS = Object.freeze(["chart", "canvas", "svg", "map", "custom-widget"]);

// CLASS hints — literal substrings matched against the element's lowercased
// class/id TOKENS (whitespace-split, hyphens kept: "main-chart" matches the
// "chart" hint, "map-marker" matches "marker"). Order inside each list is
// irrelevant; scoring counts the number of DISTINCT matching hints. Note: "icon"
// is deliberately NOT a positive hint — icon-named elements are EXCLUDED below.
const KIND_CLASS_HINTS = {
  chart: ["chart", "sparkline", "graph", "series", "plot", "trend"],
  canvas: ["canvas", "webgl", "draw"],
  svg: ["logo", "glyph", "vector", "hero-art", "illustration"],
  map: ["map", "maplibre", "mapbox", "leaflet", "gmap", "marker", "pin"],
  "custom-widget": ["widget", "gauge", "dial", "meter", "viz", "heatmap", "candles", "ladder"],
};

// data-* hooks recorded by the complex-visual capture (documented contract the
// capture writes into dom.json elements):
//  data-visual-kind  — explicit kind override ("chart"|"canvas"|"svg"|"map"|...)
//  data-visual-category — same vocabulary, alternate naming
const KIND_DATA_ATTRS = ["dataVisualKind", "dataVisualCategory"];

// TAG votes — a canvas element is inherently a canvas-kind region; inline svg is
// inherently svg-kind. Everything else needs class/data hints (an <svg class="map">
// is a map region, not a plain svg icon).
const KIND_TAG_HINTS = { canvas: ["canvas"], svg: ["svg"] };

// CHART_LIBRARY_LIBRARY — chart engines detected from class tokens; their
// presence alone (any descendant class token) upgrades a region to "chart".
export const CHART_LIBRARIES = Object.freeze([
  "chartjs", "chart-js", "highcharts", "echarts", "recharts", "c3-chart", "nvd3", "apexcharts",
  "dygraph", "uPlot", "plotly", "d3-", "victory-chart", "billboard.js", "dc-chart", "morris-chart",
  "pq-grid", "ta-charts", "chart-container", "chart-area", "chart-body",
]);

// VISUAL_REGION_FLOOR — a region shorter/thinner than this (either dimension, in
// CSS px) is decoration/chrome, not a complex visual worth a repair target.
export const VISUAL_REGION_FLOOR = 40;

// lowerTokens(v): lowercased class/id tokens, whitespace-split, hyphens KEPT
// ("main-chart" stays one token so substring hints match inside it).
const lowerTokens = (v) => String(v ?? "").trim().toLowerCase().split(/\s+/).filter(Boolean);

// tokenMatches(token, hint): hint "chart" matches token "main-chart" (substring
// either direction for hints ≥4 chars; short hints need exact equality so the
// word "a" never matches inside "canvas").
function tokenMatches(token, hint) {
  if (!token || !hint) return false;
  if (token === hint) return true;
  if (hint.length >= 4) return token.includes(hint);
  return false;
}

// scoreKinds(tokens, tag): kind → score. Hints count DOUBLE (a class hint is
// semantic intent: ".main-chart" svg is a CHART, not a bare svg region), the
// tag hint counts single (a <canvas> is canvas-kind even with no classes).
// Deterministic; the double-weighting makes hint kinds win tag ties.
function scoreKinds(tokens, tag) {
  const scores = {};
  for (const kind of VISUAL_REGION_KINDS) scores[kind] = 0;
  const tokenSet = new Set(tokens);
  for (const kind of VISUAL_REGION_KINDS) {
    for (const hint of KIND_CLASS_HINTS[kind] || []) {
      if ([...tokenSet].some((tok) => tokenMatches(tok, hint))) scores[kind] += 2;
    }
    for (const t of KIND_TAG_HINTS[kind] || []) {
      if (tag === t) scores[kind] += 1;
    }
  }
  // chart-library class fragments: substring match on any token (e.g. "highcharts-main")
  for (const lib of CHART_LIBRARIES) {
    const frag = lib.toLowerCase();
    if ([...tokenSet].some((tok) => tok.includes(frag))) { scores.chart += 2; break; }
  }
  return scores;
}

// classifyVisualRegion(el, opts?) → region record | null.
// Reads ONE dom.json element (the dom-extractor shape: tag/cls/rect, plus the
// additive capture fields style.position, role, ariaName, id, dataVisualKind,
// dataVisualCategory, visualMeta). Returns null for everything that is not a
// complex-visual candidate (ordinary divs, headings, buttons…). Deterministic.
export function classifyVisualRegion(el, opts = {}) {
  if (!el || typeof el !== "object") return null;
  const tag = String(el.tag || "").toLowerCase();
  const rect = el.rect && Number.isFinite(el.rect.w) && Number.isFinite(el.rect.h) ? el.rect : null;
  if (!rect) return null;
  if (rect.w < VISUAL_REGION_FLOOR || rect.h < VISUAL_REGION_FLOOR) return null;
  const tokens = [...lowerTokens(el.cls), ...lowerTokens(el.id)];
  // ASSET EXCLUSION: <img> elements are captured assets the asset-mapping
  // pipeline owns (project-generator.js:81-88) — never complex-visual regions,
  // whatever their class says ("badge" on an img is an asset, not svg markup).
  if (tag === "img") return null;
  // ICON EXCLUSION: an element named "icon"/"icons" is chrome decoration, not a
  // complex-visual region — icons are ordinary DOM the generator already renders
  // (the 44×44 gear svg in the 3.5.4 fixture is the regression case). The
  // explicit data-visual-kind override still wins over the exclusion.
  if (/^icon|^icons-|icon$|-icon-|-icon$/.test((tokens[0] || "")) && !(el.dataVisualKind || el.dataVisualCategory)) {
    return null;
  }
  const explicit =
    (el.dataVisualKind || el.dataVisualCategory || "").toString().trim().toLowerCase();
  const scores = scoreKinds(tokens, tag);
  // descendant-class evidence (opts.descendantClasses: array of class strings
  // captured inside the region — e.g. a chart region containing
  // ".highcharts-container" or canvas ".chartjs-render-monitor"): every distinct
  // matching library fragment votes for "chart".
  for (const dcls of opts.descendantClasses || []) {
    for (const tok of lowerTokens(dcls)) {
      for (const lib of CHART_LIBRARIES) {
        if (tok.includes(lib.toLowerCase())) { scores.chart += 1; break; }
      }
    }
  }
  let kind = null;
  if (explicit && VISUAL_REGION_KINDS.includes(explicit)) {
    kind = explicit;
  } else {
    let best = 0;
    for (const k of VISUAL_REGION_KINDS) {
      if (scores[k] > best) { best = scores[k]; kind = k; }
    }
    if (best === 0) return null; // no positive evidence — honestly not classified
  }
  const strategy =
    kind === "canvas" ? "snap-image"
    : kind === "svg" ? "preserve-markup"
    : kind === "chart" ? "rebuild-from-data"
    : kind === "map" ? "rebuild-structure"
    : "fallback-screenshot";
  return {
    kind,
    strategy,
    i: Number.isFinite(el.i) ? el.i : null,
    tag,
    cls: el.cls || null,
    rect: { x: rect.x, y: rect.y, w: rect.w, h: rect.h },
    role: el.role || null,
    ariaName: el.ariaName || null,
    cell: cellOf(rect, opts.dims || null),
    confidence: Math.min(0.99, 0.35 + 0.15 * (explicit ? 3 : Math.min(scores[kind] || 1, 4))),
    evidence: explicit
      ? [{ source: "data-attr", note: `data-visual-kind=${explicit}` }]
      : [{ source: "class", note: `tokens=${[...tokens].filter(Boolean).slice(0, 6).join(",") || tag}` }],
  };
}

// findVisualRegions(elements, opts?) → region[] sorted by area desc then capture
// order — the ONE-CALL hook a classifier/planner consumes.
// opts: {
//   dims?,
//   descendantClassesOf?: (el) => string[]  — classes captured INSIDE the region
//     (chart-library fragments upgrade the region to "chart"),
//   dataByIndex?: Map|Object  — element index → captured data series (step 4:
//     associate chart visuals with available data evidence). A region whose
//     chart data was captured carries dataAssociated: true + dataKeys.
//   interactionsByIndex?: Map|Object — element index → interaction record ids
//     resolved to the region (step 4: associate interaction evidence). Regions
//     with recorded interactions carry interactionsAssociated: true + ids.
// }
export function findVisualRegions(elements, opts = {}) {
  const els = (Array.isArray(elements) ? elements : []).filter((e) => e && typeof e === "object");
  const dataByIndex = opts.dataByIndex instanceof Map ? opts.dataByIndex : (opts.dataByIndex && typeof opts.dataByIndex === "object" ? opts.dataByIndex : null);
  const interByIndex = opts.interactionsByIndex instanceof Map ? opts.interactionsByIndex : (opts.interactionsByIndex && typeof opts.interactionsByIndex === "object" ? opts.interactionsByIndex : null);
  const regions = [];
  for (const el of els) {
    const region = classifyVisualRegion(el, {
      dims: opts.dims || null,
      descendantClasses: typeof opts.descendantClassesOf === "function" ? opts.descendantClassesOf(el) : [],
    });
    if (!region) continue;
    // step 4 — data + interaction association (additive fields, honestly absent
    // when the caller supplied no such evidence maps)
    const i = Number.isFinite(el.i) ? el.i : null;
    if (dataByIndex && i !== null && dataByIndex[i] !== undefined) {
      const d = dataByIndex[i];
      region.dataAssociated = true;
      region.dataKeys = Array.isArray(d) ? d.map((_, k) => String(k)) : Object.keys(d || {});
    } else {
      region.dataAssociated = false;
    }
    if (interByIndex && i !== null && interByIndex[i] !== undefined) {
      const ids = interByIndex[i];
      region.interactionsAssociated = true;
      region.interactionIds = (Array.isArray(ids) ? ids : [ids]).map(String);
    } else {
      region.interactionsAssociated = false;
    }
    regions.push(region);
  }
  // deterministic: larger first, then capture index (stable)
  regions.sort((a, b) =>
    (b.rect.w * b.rect.h) - (a.rect.w * a.rect.h) || (a.i ?? 0) - (b.i ?? 0) || a.kind.localeCompare(b.kind));
  return regions;
}

// ---------------------------------------------------------------------------
// analyzeFidelity — the one-call report
// ---------------------------------------------------------------------------

// analyzeFidelity(originalPng, clonePng, originalElements, cloneElements, opts)
// → {
//     dims, threshold,
//     pixel: { meanDelta, diffPct, similarityPct },
//     regions: 96 × { cell, col, row, score, diffPct, geometryErrorPx, geometryPairs, typographyMismatches, colorMismatches },
//     hotRegions: top cells by pixel score,
//     geometry: { matched, paired, mismatched, meanErrorPx, maxErrorPx, deltas },
//     typography: { compared, mismatchCount, mismatches },
//     color: { mismatchCount, mismatches },
//     stacking: { mismatchCount, mismatches },
//     missing: { count, elements }, extra: { count, elements },
//     visualRegions: classified complex-visual regions (task 3.5.4) —
//       [{ kind: chart|canvas|svg|map|custom-widget, strategy, i, tag, cls,
//          rect, cell, confidence, evidence }]
//   }
// opts: { page?, viewport?, headless?, descendantClassesOf? } — page injectable;
// a launched browser is always closed by this call, an injected page is left open.
export async function analyzeFidelity(originalPng, clonePng, originalElements, cloneElements, opts = {}) {
  const { page, owned } = await acquirePage(opts);
  try {
    const raw = await pixelDiff(page, asDataUrl(originalPng), asDataUrl(clonePng));
    const dims = { w: raw.w, h: raw.h };
    const { pairs, missing, extra, matched } = pairElements(originalElements, cloneElements);

    const deltas = geometryDeltas(pairs);
    const typo = typographyMismatches(pairs).map((m) => {
      const src = pairs.find((p) => p.a && p.a.i === m.i);
      return { ...m, rect: src?.a?.rect || null, cell: cellOf(src?.a?.rect, dims) };
    });
    const color = colorMismatches(pairs).map((m) => {
      const src = pairs.find((p) => p.a && p.a.i === m.i);
      return { ...m, rect: src?.a?.rect || null, cell: cellOf(src?.a?.rect, dims) };
    });
    const stacking = stackingMismatches(pairs).map((m) => {
      const src = pairs.find((p) => p.a && p.a.i === m.i);
      return { ...m, rect: src?.a?.rect || null, cell: cellOf(src?.a?.rect, dims) };
    });

    // per-region aggregation: geometry errors spread over ALL cells the original
    // box intersects (a drifting hero flags every region it covers); element
    // typography/color/stacking counts use the element's center cell.
    const regions = raw.cells.map((c, idx) => ({
      cell: idx,
      col: idx % GRID_X,
      row: Math.floor(idx / GRID_X),
      score: c.score,
      diffPct: c.diffPct,
      geometryErrorPx: null,
      geometryPairs: 0,
      typographyMismatches: 0,
      colorMismatches: 0,
      visualKind: null, // task 3.5.4: chart/canvas/svg/map/custom-widget label
    }));
    for (const d of deltas) {
      const r = d.rect;
      const c0 = Math.max(0, Math.min(GRID_X - 1, Math.floor((Math.max(0, r.x) / dims.w) * GRID_X)));
      const c1 = Math.max(0, Math.min(GRID_X - 1, Math.floor((Math.max(0, r.x + r.w - 1) / dims.w) * GRID_X)));
      const r0 = Math.max(0, Math.min(GRID_Y - 1, Math.floor((Math.max(0, r.y) / dims.h) * GRID_Y)));
      const r1 = Math.max(0, Math.min(GRID_Y - 1, Math.floor((Math.max(0, r.y + r.h - 1) / dims.h) * GRID_Y)));
      for (let row = r0; row <= r1; row++) {
        for (let col = c0; col <= c1; col++) {
          const reg = regions[row * GRID_X + col];
          reg.geometryPairs++;
          if (reg.geometryErrorPx === null || d.errorPx > reg.geometryErrorPx) reg.geometryErrorPx = d.errorPx;
        }
      }
    }
    for (const m of typo) if (m.cell !== null && regions[m.cell]) regions[m.cell].typographyMismatches++;
    for (const m of color) if (m.cell !== null && regions[m.cell]) regions[m.cell].colorMismatches++;

    // task 3.5.4: complex-visual region classification — every grid cell an
    // original canvas/svg/chart/map box intersects gets its visualKind; when two
    // kinds overlap in one cell the LARGER area wins (deterministic tiebreak:
    // higher-confidence kind wins on equal area).
    const visualRegions = findVisualRegions(originalElements, {
      dims,
      descendantClassesOf: typeof opts.descendantClassesOf === "function" ? opts.descendantClassesOf : null,
      dataByIndex: opts.dataByIndex,
      interactionsByIndex: opts.interactionsByIndex,
    });
    for (const vr of visualRegions) {
      const r = vr.rect;
      const c0 = Math.max(0, Math.min(GRID_X - 1, Math.floor((Math.max(0, r.x) / dims.w) * GRID_X)));
      const c1 = Math.max(0, Math.min(GRID_X - 1, Math.floor((Math.max(0, r.x + r.w - 1) / dims.w) * GRID_X)));
      const r0 = Math.max(0, Math.min(GRID_Y - 1, Math.floor((Math.max(0, r.y) / dims.h) * GRID_Y)));
      const r1 = Math.max(0, Math.min(GRID_Y - 1, Math.floor((Math.max(0, r.y + r.h - 1) / dims.h) * GRID_Y)));
      const newArea = r.w * r.h;
      for (let row = r0; row <= r1; row++) {
        for (let col = c0; col <= c1; col++) {
          const reg = regions[row * GRID_X + col];
          const cur = reg.visualRegion;
          const curArea = cur ? cur.rect.w * cur.rect.h : -1;
          if (!cur || newArea > curArea || (newArea === curArea && vr.confidence > cur.confidence)) {
            reg.visualKind = vr.kind;
            reg.visualRegion = vr;
          }
        }
      }
    }

    const mismatchedDeltas = deltas.filter((d) => d.errorPx > GEOMETRY_TOLERANCE_PX);
    const errors = mismatchedDeltas.map((d) => d.errorPx);
    const hotRegions = [...regions].sort((x, y) => y.score - x.score || x.cell - y.cell).slice(0, 5);

    return {
      dims,
      threshold: DIFF_THRESHOLD,
      pixel: {
        meanDelta: raw.meanDelta,
        diffPct: raw.diffPct,
        similarityPct: +(100 - raw.diffPct).toFixed(2),
      },
      regions,
      hotRegions,
      geometry: {
        matched,
        paired: deltas.length,
        mismatched: mismatchedDeltas.length,
        meanErrorPx: errors.length ? +(errors.reduce((s, e) => s + e, 0) / errors.length).toFixed(2) : 0,
        maxErrorPx: errors.length ? Math.max(...errors) : 0,
        deltas,
      },
      typography: { compared: pairs.filter((p) => p.b).length, mismatchCount: typo.length, mismatches: typo },
      color: { mismatchCount: color.length, mismatches: color },
      stacking: { mismatchCount: stacking.length, mismatches: stacking },
      missing: {
        count: missing.length,
        elements: missing.map((el) => ({
          i: el.i, tag: el.tag, cls: el.cls || null, rect: el.rect || null,
          isImage: el.tag === "img" && !!el.src, src: el.tag === "img" ? el.src || null : null,
        })),
      },
      extra: { count: extra.length, elements: extra.map((el) => ({ i: el.i, tag: el.tag, cls: el.cls || null, rect: el.rect || null })) },
      // task 3.5.4: classified complex-visual regions (chart/canvas/svg/map/
      // custom-widget) from the ORIGINAL capture — the repair targets for the
      // 3.5.4 repairs and the per-region visualKind labels on `regions`.
      visualRegions,
    };
  } finally {
    if (owned) await owned.close().catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// refineTypography — fidelity-path improvement (typography overrides)
// ---------------------------------------------------------------------------

// Tags whose UA stylesheet default is bold. When the ORIGINAL page captures
// font-weight 400 on one of these, the generator's weight drop
// (src/reconstruction/generation/project-generator.js:39 skips "400") makes the
// clone render BOLD — a real, deterministic typography drift this refinement
// repairs with an explicit override.
const BOLD_DEFAULT_TAGS = new Set(["h1", "h2", "h3", "h4", "h5", "h6", "b", "strong", "th", "dt"]);

// refineTypography(elements) → { css, tokens: { weights, lineHeights, letterSpacing }, overrides }
//
// Token-CSS overrides built ONLY from the captured styles (deterministic; no
// heuristics, no background/color output — the transparent-RGBA regression can
// never re-enter through this path):
//  1. font-weight — captured 400 on a UA-bold-default tag gets an explicit
//     `font-weight: 400` override (repairs the generator's bold drift above).
//  2. line-height — captured px line-height with a px font-size is re-emitted
//     as a unitless ratio (identical rendering, robust if font-size changes).
//  3. letter-spacing — captured non-zero tracking is re-emitted (the generator
//     never emits letter-spacing, so the clone renders "normal" and the
//     tracking is lost). ADDITIVE CONTRACT: emitted only when the capture
//     records style.letterSpacing; the stock dom-extractor does not capture it
//     yet, so this override is inert there until the extractor adds the field.
//
// Overrides target the generator's per-element classes (`.cx-<i>`,
// src/reconstruction/generation/project-generator.js:58) so appending the css
// AFTER components.css wins the cascade at equal specificity.
export function refineTypography(elements, opts = {}) {
  const els = (Array.isArray(elements) ? elements : []).filter((e) => e && typeof e === "object");
  const weights = new Set(), lineHeights = new Set(), letterSpacing = new Set();
  const byElement = new Map(); // i → { selector, props: [[prop, value, reason]] }
  for (const el of els) {
    const i = el.i;
    if (!Number.isFinite(i)) continue;
    const st = el.style || {};
    const props = [];
    const tag = String(el.tag || "").toLowerCase();
    const w = normalizeWeight(st.fontWeight);
    if (w && w === "400" && BOLD_DEFAULT_TAGS.has(tag)) {
      props.push(["font-weight", "400", "captured 400 on UA-bold tag — generator drop would render bold"]);
      weights.add("400");
    }
    const fs = pxOf(st.fontSize);
    const lh = pxOf(st.lineHeight);
    if (fs !== null && fs > 0 && lh !== null && lh > 0) {
      const ratio = +(lh / fs).toFixed(3);
      if (ratio > 0) {
        props.push(["line-height", String(ratio), "captured px line-height normalized to a unitless ratio"]);
        lineHeights.add(String(ratio));
      }
    }
    const ls = pxOf(st.letterSpacing);
    if (ls !== null && ls !== 0) {
      props.push(["letter-spacing", `${ls}px`, "captured tracking — generator never emits letter-spacing"]);
      letterSpacing.add(`${ls}px`);
    }
    if (props.length) byElement.set(i, props);
  }
  const overrides = [];
  for (const [i, props] of [...byElement.entries()].sort((x, y) => x[0] - y[0])) { // deterministic: capture order
    for (const [prop, value, reason] of props) overrides.push({ selector: `.cx-${i}`, prop, value, i, reason });
  }
  const tokenLines = [];
  [...weights].forEach((v, idx) => tokenLines.push(`  --fw-${idx + 1}: ${v};`));
  [...lineHeights].forEach((v, idx) => tokenLines.push(`  --lh-${idx + 1}: ${v};`));
  [...letterSpacing].forEach((v, idx) => tokenLines.push(`  --ls-${idx + 1}: ${v};`));
  // opts.scopeOf(el) — optional selector prefix for multi-page builds (element
  // indexes restart per page; colliding indexes must be scoped with the same
  // body[data-page] marker buildComponentCss uses — by the element's OWN page —
  // or one page's override clobbers another page's element). Additive: without
  // opts the output is byte-identical to the single-page contract.
  const scopeOf = typeof opts.scopeOf === "function" ? opts.scopeOf : null;
  const elByIdx = new Map(els.filter((e) => Number.isFinite(e.i)).map((e) => [e.i, e]));
  const rules = [...byElement.entries()]
    .sort((x, y) => x[0] - y[0])
    .map(([i, props]) => `${scopeOf ? scopeOf(elByIdx.get(i)) : ""}.cx-${i} { ${props.map(([p, v]) => `${p}: ${v}`).join("; ")}; }`);
  const css = [
    tokenLines.length ? ":root {\n" + tokenLines.join("\n") + "\n}" : "",
    ...rules,
  ].filter(Boolean).join("\n");
  return {
    css,
    tokens: { weights: [...weights], lineHeights: [...lineHeights], letterSpacing: [...letterSpacing] },
    overrides,
  };
}
