// Visual defect classifier (task 3.4.3): turns the visual-fidelity-analyzer's
// measured report into a CATEGORIZED defect list — geometry, typography, color,
// missing-asset, missing-component, stacking — instead of a single pixel count.
//
// Each defect carries:
//  - kind            one of DEFECT_KINDS
//  - severity        0-1, AREA-WEIGHTED (element/region coverage × mismatch
//                    intensity — large-area problems rank first)
//  - salience        0-1, the pixel grid score of the affected region (high-
//                    salience regions break ties after severity)
//  - confidence      0-1, how directly the defect was measured (element-level
//                    computed-style/geometry evidence is high; region-only
//                    pixel evidence is lower)
//  - refs            affected component refs — the captured element indices
//  - region          grid cell index (or null)
//  - original/clone  the compared values (element defects) or null
//  - action          suggested repair: { kind, target, ... } — action kinds:
//                    geometry-fix, typography-override, color-token-fix,
//                    restore-asset, add-component, stacking-fix
//
// Output is sorted large-area + high-salience first (severity desc → salience
// desc → deterministic tiebreaks), so a consumer repairing defects head-down
// fixes what the eye sees first.
//
// Pure function of the fidelity report — no I/O, no browser, fully
// deterministic. Consumes the shapes analyzeFidelity emits; malformed/absent
// sections degrade to fewer defects, never a throw.
//
// Integration hook: after the verification render,
//   const fidelity = await analyzeFidelity(origPng, clonePng, origEls, cloneEls, { page });
//   const defects = classifyDefects(fidelity);
import {
  GRID_X,
  GRID_Y,
  GEOMETRY_TOLERANCE_PX,
  DIFF_THRESHOLD,
  cellOf,
} from "./visual-fidelity-analyzer.js";

export const DEFECT_KINDS = Object.freeze([
  "geometry", "typography", "color", "missing-asset", "missing-component", "stacking",
]);

// Area-ratio → severity multiplier. A full-intensity mismatch covering 12.5%
// of the viewport reaches severity 1; small chrome elements land well below.
export const SEVERITY_SPREAD = 8;

// Region-only (pixel-grid) color defects fire for hot cells that no element
// defect already explains — the "unexplained drift" bucket. 20/255 mean delta
// is visible drift without being the DIFF_THRESHOLD outlier.
const REGION_SCORE_FLOOR = 20;

const clamp01 = (n) => Math.max(0, Math.min(1, Number(n) || 0));

// severityFor(areaRatio, intensity): area-weighted severity, documented and
// exported so consumers can reproduce the ranking.
export function severityFor(areaRatio, intensity) {
  return clamp01(clamp01(areaRatio) * SEVERITY_SPREAD * (0.35 + 0.65 * clamp01(intensity)));
}

const areaRatioOf = (rect, pageArea) => {
  if (!rect || !pageArea) return 0;
  return clamp01((Math.max(0, rect.w) * Math.max(0, rect.h)) / pageArea);
};

const TYPO_FIELD_WEIGHTS = {
  fontFamily: 1.0,   // wrong typeface — most visible typography failure
  fontSize: 0.9,
  fontWeight: 0.7,
  lineHeight: 0.5,
  letterSpacing: 0.4,
};

// classifyDefects(fidelity, opts?) → defect[] sorted large-area + high-salience first.
// opts: { regionScoreFloor?: number } — pixel-score floor for unexplained
// region-level color defects (default REGION_SCORE_FLOOR).
export function classifyDefects(fidelity, opts = {}) {
  const f = fidelity && typeof fidelity === "object" ? fidelity : {};
  const dims = f.dims && f.dims.w > 0 && f.dims.h > 0 ? f.dims : null;
  const pageArea = dims ? dims.w * dims.h : null;
  const defects = [];
  const regionScore = (cell) => {
    const r = (f.regions || [])[cell];
    return r && Number.isFinite(r.score) ? r.score : 0;
  };
  const salienceOf = (cell) => (cell === null || cell === undefined ? 0 : clamp01(regionScore(cell) / 255));
  const regionFloor = Number.isFinite(opts.regionScoreFloor) ? opts.regionScoreFloor : REGION_SCORE_FLOOR;

  // ---- geometry: measured box deltas beyond the noise tolerance ----
  for (const d of f.geometry?.deltas || []) {
    if (!(d.errorPx > GEOMETRY_TOLERANCE_PX)) continue;
    const areaRatio = areaRatioOf(d.rect, pageArea);
    // intensity: how far the box drifted relative to half its smaller dimension
    const minDim = Math.max(12, Math.min(d.rect?.w || 12, d.rect?.h || 12) / 2);
    const intensity = clamp01(d.errorPx / minDim);
    const cell = cellOf(d.rect, dims);
    defects.push({
      kind: "geometry",
      severity: severityFor(areaRatio, intensity),
      salience: salienceOf(cell),
      confidence: clamp01(0.6 + 0.4 * intensity), // directly measured deltas
      refs: [d.i],
      region: cell,
      original: { x: d.rect?.x, y: d.rect?.y, w: d.rect?.w, h: d.rect?.h },
      clone: { dx: d.dx, dy: d.dy, dw: d.dw, dh: d.dh },
      action: {
        kind: "geometry-fix",
        target: `.cx-${d.i}`,
        adjust: { dx: -d.dx, dy: -d.dy, dw: -d.dw, dh: -d.dh },
      },
    });
  }

  // ---- typography: per-field computed-style mismatches ----
  for (const m of f.typography?.mismatches || []) {
    const areaRatio = areaRatioOf(m.rect, pageArea);
    const weight = TYPO_FIELD_WEIGHTS[m.field] ?? 0.5;
    const cell = m.cell ?? cellOf(m.rect, dims);
    defects.push({
      kind: "typography",
      severity: severityFor(areaRatio, weight),
      salience: salienceOf(cell),
      confidence: 0.85, // both sides captured as computed styles
      refs: [m.i],
      region: cell ?? null,
      field: m.field,
      original: m.original,
      clone: m.clone,
      action: { kind: "typography-override", target: `.cx-${m.i}`, prop: m.field, value: m.original },
    });
  }

  // ---- color: element-level background/text color drift ----
  for (const m of f.color?.mismatches || []) {
    const areaRatio = areaRatioOf(m.rect, pageArea);
    const cell = m.cell ?? cellOf(m.rect, dims);
    defects.push({
      kind: "color",
      severity: severityFor(areaRatio, 0.8),
      salience: salienceOf(cell),
      confidence: 0.8,
      refs: [m.i],
      region: cell ?? null,
      field: m.field,
      original: m.original,
      clone: m.clone,
      action: { kind: "color-token-fix", target: `.cx-${m.i}`, prop: m.field, value: m.original },
    });
  }

  // ---- stacking: position / z-index drift ----
  for (const m of f.stacking?.mismatches || []) {
    const areaRatio = areaRatioOf(m.rect, pageArea);
    const cell = m.cell ?? cellOf(m.rect, dims);
    defects.push({
      kind: "stacking",
      severity: severityFor(areaRatio, 0.5),
      salience: salienceOf(cell),
      confidence: 0.7,
      refs: [m.i],
      region: cell ?? null,
      original: m.fields,
      clone: null,
      action: { kind: "stacking-fix", target: `.cx-${m.i}`, values: m.fields },
    });
  }

  // ---- missing components / assets ----
  for (const el of f.missing?.elements || []) {
    const areaRatio = areaRatioOf(el.rect, pageArea);
    const cell = cellOf(el.rect, dims);
    const isAsset = el.isImage === true;
    defects.push({
      kind: isAsset ? "missing-asset" : "missing-component",
      severity: severityFor(areaRatio, isAsset ? 0.8 : 0.9),
      salience: salienceOf(cell),
      confidence: isAsset ? 0.8 : 0.75,
      refs: [el.i],
      region: cell ?? null,
      original: { tag: el.tag, cls: el.cls || null, src: el.src || null },
      clone: null,
      action: isAsset
        ? { kind: "restore-asset", target: `.cx-${el.i}`, tag: el.tag, src: el.src || null }
        : { kind: "add-component", target: `.cx-${el.i}`, tag: el.tag, cls: el.cls || null, rect: el.rect || null },
    });
  }

  // ---- unexplained region drift: hot cells no element defect accounts for ----
  const explained = new Set(defects.map((d) => d.region).filter((c) => c !== null && c !== undefined));
  for (const reg of f.regions || []) {
    if (!(reg.score >= regionFloor)) continue;
    if (explained.has(reg.cell)) continue;
    // intensity from the cell's mean channel delta (255 scale)
    const intensity = clamp01(reg.score / 64);
    defects.push({
      kind: "color",
      severity: severityFor(1 / (GRID_X * GRID_Y), intensity),
      salience: clamp01(reg.score / 255),
      confidence: 0.5, // pixel evidence only — no element-level cause found
      refs: [],
      region: reg.cell,
      original: null,
      clone: null,
      action: { kind: "color-token-fix", target: `region:${reg.cell}`, prop: "backgroundColor" },
    });
  }

  // large-area + high-salience first; fully deterministic tiebreaks
  defects.sort((a, b) =>
    b.severity - a.severity ||
    b.salience - a.salience ||
    (a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : 0) ||
    (a.refs[0] ?? -1) - (b.refs[0] ?? -1) ||
    (a.region ?? -1) - (b.region ?? -1),
  );
  return defects;
}
