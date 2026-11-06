// Section-scoped visual-diff final gate (task G6.7 — technique 3 of the
// ai-website-cloner-claudeskill mapping, docs/AI-CLONER-SKILL-INTEGRATION.md).
//
// The external skill's final gate: compare original vs clone side-by-side per
// SECTION at two viewports (1440 + 390); every discrepancy is checked against
// the section's spec file — "re-extract if the spec was wrong, fix the
// component if the builder deviated". Our verification (src/reconstruction/verify.js
// stage3Visual) already gates on page-level pixel difference, token drift and
// the exact-HEX comparison at ONE viewport, and the 3.4.3 analyzer +
// classifier (visual-fidelity-analyzer.js / visual-diff-classifier.js) already
// produce element-level defects. What did NOT exist:
//   1. per-SECTION attribution of measured defects,
//   2. the spec-correlation verdict (clone drifted from captured spec vs the
//      captured spec itself not explaining the pixels vs the defect's field
//      was never captured at all),
//   3. a second-viewport leg.
// This module adds exactly those three, composed ON TOP of the existing
// analyzeFidelity + classifyDefects — same grid geometry, same thresholds, no
// parallel measurement path. It renders with a real browser (injectable page,
// same contract as measureFidelity) and never fabricates evidence: a viewport
// without an original capture is recorded as skipped, not zeroed.
//
// This module is additive: the production gate in verify.js is untouched; the
// integrator may adopt runSectionVisualGate as an additional stage.

import fs from "node:fs";
import path from "node:path";
import { GRID_X, GRID_Y, analyzeFidelity } from "../visual-fidelity-analyzer.js";
import { classifyDefects } from "../visual-diff-classifier.js";
import { launchBrowser } from "../../browser.js";
import { DOM_EXTRACTOR_SCRIPT } from "../../intelligence/dom-extractor.js";
import { buildSectionSpecs, loadSectionSpecs, writeSectionSpecs } from "./style-spec.js";

// A section FAILS when its most severe attributed defect reaches this
// severity (the 3.4.3 classifier's area-weighted 0-1 scale; 0.4 = a
// mismatch covering roughly 5% of the viewport at full intensity — a defect
// a human plainly sees). Between WARN and FAIL the section is flagged, not
// failed. Deterministic constants, exported so consumers can reproduce.
export const SECTION_GATE_FAIL_SEVERITY = 0.4;
export const SECTION_GATE_WARN_SEVERITY = 0.2;

// The skill's two gate viewports.
export const GATE_VIEWPORTS = Object.freeze([
  { name: "desktop", width: 1440, height: 900 },
  { name: "mobile", width: 390, height: 844 },
]);

// Base capture vocabulary the stock dom-extractor records
// (src/intelligence/dom-extractor.js:44-52 style keys + layout keys at 35-43).
// A defect whose field is OUTSIDE both this and the spec member's actual
// captured values is a capture gap, not a clone drift.
const BASE_CAPTURE_FIELDS = new Set([
  "display", "position", "flexDirection", "gridTemplateColumns", "justifyContent", "alignItems", "gap",
  "padding", "margin", "backgroundColor", "color", "fontFamily", "fontSize", "fontWeight", "lineHeight",
  "border", "borderRadius", "opacity", "overflow", "zIndex",
]);

// ---------------------------------------------------------------------------
// attribution (pure)
// ---------------------------------------------------------------------------

// cellsOfRect(rect, dims) — every grid cell the rect intersects (center-cell
// math mirrors visual-fidelity-analyzer.cellOf; the corner walk mirrors the
// analyzer's geometry spreading loop).
export function cellsOfRect(rect, dims) {
  if (!rect || !dims || !(dims.w > 0) || !(dims.h > 0)) return [];
  const c0 = Math.max(0, Math.min(GRID_X - 1, Math.floor((Math.max(0, rect.x ?? 0) / dims.w) * GRID_X)));
  const c1 = Math.max(0, Math.min(GRID_X - 1, Math.floor((Math.max(0, (rect.x ?? 0) + (rect.w ?? 0) - 1) / dims.w) * GRID_X)));
  const r0 = Math.max(0, Math.min(GRID_Y - 1, Math.floor((Math.max(0, rect.y ?? 0) / dims.h) * GRID_Y)));
  const r1 = Math.max(0, Math.min(GRID_Y - 1, Math.floor((Math.max(0, (rect.y ?? 0) + (rect.h ?? 0) - 1) / dims.h) * GRID_Y)));
  const cells = [];
  for (let row = r0; row <= r1; row++) for (let col = c0; col <= c1; col++) cells.push(row * GRID_X + col);
  return cells;
}

// attributeDefectsToSections(defects, specs, fidelity) →
// { bySection: { [sectionId]: defect[] }, unattributed: defect[] }.
// Element-ref defects attribute to the section owning that element; ref-less
// (pixel-grid) defects attribute to the SMALLEST section rect covering the
// defect's region cell (deterministic: area, then sectionId).
export function attributeDefectsToSections(defects, specs, fidelity) {
  const bySection = {};
  const unattributed = [];
  if (!Array.isArray(specs) || !specs.length) return { bySection, unattributed: Array.isArray(defects) ? defects : [] };
  const memberSection = new Map();
  for (const s of specs) for (const m of s.members || []) if (!memberSection.has(m.i)) memberSection.set(m.i, s.sectionId);
  const dims = fidelity?.dims || null;
  const cellCoverage = new Map(); // cell → [{ sectionId, area }]
  for (const s of specs) {
    if (!s.rect) continue;
    const area = Math.max(0, s.rect.w || 0) * Math.max(0, s.rect.h || 0);
    for (const cell of cellsOfRect(s.rect, dims)) {
      if (!cellCoverage.has(cell)) cellCoverage.set(cell, []);
      cellCoverage.get(cell).push({ sectionId: s.sectionId, area });
    }
  }
  for (const d of Array.isArray(defects) ? defects : []) {
    let sectionId = null;
    for (const ref of d.refs || []) {
      if (memberSection.has(ref)) { sectionId = memberSection.get(ref); break; }
    }
    if (!sectionId && d.region !== null && d.region !== undefined && cellCoverage.has(d.region)) {
      const covers = cellCoverage.get(d.region).slice().sort((a, b) => a.area - b.area || String(a.sectionId).localeCompare(String(b.sectionId)));
      sectionId = covers[0].sectionId;
    }
    if (sectionId) {
      if (!bySection[sectionId]) bySection[sectionId] = [];
      bySection[sectionId].push(d);
    } else {
      unattributed.push(d);
    }
  }
  return { bySection, unattributed };
}

// ---------------------------------------------------------------------------
// spec correlation (pure) — the skill's "check the spec file" step
// ---------------------------------------------------------------------------

// correlateDefectWithSpec(defect, spec) → verdict string. Decision table (the
// skill's "check the spec file" step, made deterministic — defect.original is
// the ORIGINAL page's measured value, defect.clone the clone's):
//   spec has the field → spec ≈ original → "clone-drift"    (spec captured the
//     truth; the clone rendered something else → the build deviated → repair
//     against the spec)
//   spec has the field → spec ≉ original → "spec-drift"     (the captured spec
//     disagrees with what the original page measured → the spec is wrong/stale
//     → re-extract)
//   spec lacks the field, field ∈ base capture vocabulary → "spec-drift"
//     (the member's own capture lost a base field the measurement had — spec
//     incomplete for this element → re-extract)
//   spec lacks the field, field ∉ base vocabulary → "uncaptured-property"
//     (the vocabulary itself never recorded it — e.g. boxShadow/letterSpacing
//     before the extended capture → capture gap)
//   no spec member for the element → "unattributed"
//   non-value defect kinds (missing/stacking/visual-region) → "structural"
export function correlateDefectWithSpec(defect, spec) {
  if (!spec) return "unattributed";
  const ref = (defect.refs || [])[0];
  if (ref === undefined || ref === null) return "unattributed";
  const member = (spec.members || []).find((m) => m.i === ref);
  if (!member) return "unattributed";
  if (defect.field === undefined) return "structural";
  const field = defect.field;
  const inBase = BASE_CAPTURE_FIELDS.has(field);
  const captured = member.style ? member.style[field] : undefined;
  const extended = member.extended ? member.extended[field] : undefined;
  if (captured === undefined && extended === undefined) {
    return inBase ? "spec-drift" : "uncaptured-property";
  }
  const specValue = captured !== undefined ? captured : extended;
  const specMatchesOriginal = String(specValue) === String(defect.original) ||
    (pxNum(specValue) !== null && pxNum(defect.original) !== null && Math.abs(pxNum(specValue) - pxNum(defect.original)) <= 0.5);
  return specMatchesOriginal ? "clone-drift" : "spec-drift";
}

const pxNum = (v) => {
  const m = String(v ?? "").match(/^(-?\d+(?:\.\d+)?)px$/);
  return m ? parseFloat(m[1]) : null;
};

// ---------------------------------------------------------------------------
// gate (pure)
// ---------------------------------------------------------------------------

// sectionGate(fidelity, defects, specs, opts) →
// { mode, passed, sections, unattributedCount, thresholds }.
// Sections with zero attributed defects pass; severity ≥ FAIL_SEVERITY fails
// a section; ≥ WARN_SEVERITY flags it. With no specs the gate degrades
// honestly to page-level mode on unattributed defects only.
export function sectionGate(defects, specs, fidelity, opts = {}) {
  const failAt = Number.isFinite(opts.failSeverity) ? opts.failSeverity : SECTION_GATE_FAIL_SEVERITY;
  const warnAt = Number.isFinite(opts.warnSeverity) ? opts.warnSeverity : SECTION_GATE_WARN_SEVERITY;
  const defectsList = Array.isArray(defects) ? defects : [];
  if (!Array.isArray(specs) || !specs.length) {
    const worst = defectsList.reduce((m, d) => Math.max(m, d.severity ?? 0), 0);
    return {
      mode: "page-level-fallback",
      passed: worst < failAt,
      sections: [],
      unattributedCount: defectsList.length,
      thresholds: { fail: failAt, warn: warnAt },
      worstSeverity: +worst.toFixed(4),
    };
  }
  const { bySection, unattributed } = attributeDefectsToSections(defectsList, specs, fidelity);
  const sections = [];
  for (const spec of specs) {
    const list = bySection[spec.sectionId] || [];
    const worst = list.reduce((m, d) => Math.max(m, d.severity ?? 0), 0);
    const verdicts = {};
    for (const d of list) {
      const v = correlateDefectWithSpec(d, spec);
      verdicts[v] = (verdicts[v] || 0) + 1;
    }
    sections.push({
      sectionId: spec.sectionId,
      kind: spec.kind || null,
      memberCount: (spec.members || []).length,
      specFile: `specs/${spec.sectionId}-${String(spec.kind || "section").toLowerCase().replace(/[^a-z0-9_-]+/g, "-")}.spec.json`,
      defects: list.length,
      worstSeverity: +worst.toFixed(4),
      status: worst >= failAt ? "fail" : worst >= warnAt ? "warn" : "pass",
      verdicts,
      // the skill's repair routing, deterministic: clone-drift → repair the
      // component against the spec; spec-drift / uncaptured-property →
      // re-extract (the spec or its vocabulary is the problem)
      repairRoute: verdicts["clone-drift"] ? "repair-against-spec" : (verdicts["spec-drift"] || verdicts["uncaptured-property"]) ? "re-extract" : null,
      topDefects: list.slice(0, 5).map((d) => ({
        kind: d.kind, field: d.field ?? null, severity: +(d.severity ?? 0).toFixed(4),
        refs: d.refs || [], verdict: correlateDefectWithSpec(d, spec),
        original: d.original ?? null, clone: d.clone ?? null,
      })),
    });
  }
  return {
    mode: "per-section",
    passed: sections.every((s) => s.status !== "fail"),
    sections,
    unattributedCount: unattributed.length,
    thresholds: { fail: failAt, warn: warnAt },
    worstSeverity: +Math.max(0, ...sections.map((s) => s.worstSeverity), ...unattributed.map((d) => d.severity ?? 0)).toFixed(4),
  };
}

// dualViewportGate({ desktop, mobile, gatingMobile }) — the skill's two
// viewports. The mobile leg gates ONLY when the caller marks the evidence
// real (gatingMobile: true — e.g. an original capture at 390 existed); an
// advisory mobile result is recorded but never decides. Honest modes:
//   "dual-gating"      desktop + mobile both decide
//   "desktop-only"     no usable mobile evidence — recorded, not invented
//   "desktop-gating-mobile-advisory"
export function dualViewportGate({ desktop, mobile = null, gatingMobile = false }) {
  if (!desktop) return { mode: "no-desktop-leg", passed: false, desktop: null, mobile: mobile || null };
  if (!mobile) return { mode: "desktop-only", passed: !!desktop.passed, desktop, mobile: null };
  if (!gatingMobile) return { mode: "desktop-gating-mobile-advisory", passed: !!desktop.passed, desktop, mobile };
  return { mode: "dual-gating", passed: !!desktop.passed && !!mobile.passed, desktop, mobile };
}

// ---------------------------------------------------------------------------
// end-to-end run (real browser, real screenshots, real fidelity math)
// ---------------------------------------------------------------------------

// runSectionVisualGate({ artifactsDir, cloneDir, pageId, specs, viewports,
// originalByViewport, page, failSeverity }) →
// { ok, gate (dualViewportGate output), perViewport: {...}, why? }.
//   originalByViewport: { [viewportName]: { png: path|Buffer, elements: [...] } }
//     — REQUIRED for any viewport beyond the primary (the exploration stores
//     one screenshot, at the policy viewport). Absent evidence → the leg is
//     recorded as skipped with the reason; never fabricated.
//   page: injectable Playwright page (reuse the caller's browser); otherwise
//     a headless browser is launched and closed here.
export async function runSectionVisualGate(opts = {}) {
  const {
    artifactsDir, cloneDir, pageId = "page-001",
    specs = null, viewports = [GATE_VIEWPORTS[0]],
    originalByViewport = null, page = null,
    failSeverity = SECTION_GATE_FAIL_SEVERITY,
  } = opts;
  if (!artifactsDir || !cloneDir) return { ok: false, why: "artifactsDir and cloneDir are required", gate: null };

  // specs: loaded from artifacts unless handed in (evidence-gated)
  let specList = specs;
  let specsWhy = null;
  if (!specList) {
    const loaded = loadSectionSpecs(artifactsDir);
    specList = loaded.specs;
    specsWhy = loaded.why;
  }
  if (!specList?.length) {
    return { ok: false, why: `no section specs available${specsWhy ? ` (${specsWhy})` : ""} — gate degrades to page-level verification elsewhere, nothing fabricated here`, gate: null };
  }

  // original evidence for the primary viewport
  const domPath = path.join(artifactsDir, "pages", pageId, "dom.json");
  const shotPath = path.join(artifactsDir, "pages", pageId, "screenshot-viewport.png");
  if (!fs.existsSync(domPath) || !fs.existsSync(shotPath)) {
    return { ok: false, why: "no original screenshot/dom evidence for page-001 (v1 run or capture failure)", gate: null };
  }
  let originalElements;
  try { originalElements = JSON.parse(fs.readFileSync(domPath, "utf8")).elements; } catch { return { ok: false, why: "dom.json unparseable", gate: null }; }
  if (!Array.isArray(originalElements)) return { ok: false, why: "dom.json has no element list", gate: null };

  const indexUrl = "file:///" + path.join(cloneDir, "index.html").replace(/\\/g, "/");
  let owned = null;
  let p = page;
  if (!p) {
    owned = await launchBrowser({ headless: true });
    p = await owned.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
  }

  const perViewport = {};
  try {
    for (const vp of viewports) {
      const name = vp.name || String(vp.width);
      const orig = name === (GATE_VIEWPORTS[0].name)
        ? { png: shotPath, elements: originalElements }
        : originalByViewport?.[name] || originalByViewport?.[String(vp.width)] || null;
      if (!orig) {
        perViewport[name] = { skipped: true, why: `no original capture for viewport ${name} — supply originalByViewport`, width: vp.width, height: vp.height };
        continue;
      }
      if (!orig.png || !Array.isArray(orig.elements)) {
        perViewport[name] = { skipped: true, why: `incomplete original evidence for ${name} (png/elements missing)`, width: vp.width, height: vp.height };
        continue;
      }
      await p.setViewportSize({ width: vp.width, height: vp.height }).catch(() => {});
      await p.goto(indexUrl, { waitUntil: "load", timeout: 30000 });
      await p.waitForTimeout(600);
      const cloneShot = await p.screenshot({ timeout: 20000 });
      const intel = await p.evaluate(DOM_EXTRACTOR_SCRIPT).catch(() => null);
      const cloneElements = intel && Array.isArray(intel.elements) ? intel.elements : [];
      const fidelity = await analyzeFidelity(orig.png, cloneShot, orig.elements, cloneElements, { page: p });
      const defects = classifyDefects(fidelity);
      const gate = sectionGate(defects, specList, fidelity, { failSeverity });
      perViewport[name] = {
        skipped: false,
        width: vp.width, height: vp.height,
        pixel: fidelity.pixel,
        gate,
        defectCount: defects.length,
      };
    }
  } finally {
    if (owned) await owned.close().catch(() => {});
  }

  // dual-viewport combination: the mobile leg gates only when real original
  // evidence for it was supplied by the caller. Legs are projected to the
  // { passed } shape dualViewportGate consumes (the per-viewport record keeps
  // its full detail; the wrapper reads only the verdict).
  const legOf = (v) => (v && !v.skipped ? { passed: !!v.gate?.passed, gate: v.gate, pixel: v.pixel } : null);
  const desktopLeg = legOf(perViewport[GATE_VIEWPORTS[0].name]) ||
    legOf(Object.values(perViewport).find((v) => !v.skipped));
  const mobileLeg = legOf(perViewport[GATE_VIEWPORTS[1].name]);
  const gatingMobile = !!(mobileLeg && originalByViewport &&
    (originalByViewport[GATE_VIEWPORTS[1].name] || originalByViewport[String(GATE_VIEWPORTS[1].width)]));
  const gate = dualViewportGate({ desktop: desktopLeg, mobile: mobileLeg, gatingMobile });

  // persist the gate report next to the specs (same side-of-artifacts contract)
  try {
    const dir = path.join(artifactsDir, "specs");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "section-gate.json"), JSON.stringify({
      generatedAt: new Date().toISOString(),
      cloneDir,
      perViewport,
      gate: { mode: gate.mode, passed: gate.passed },
    }, null, 2));
  } catch { /* report write is best-effort; the gate result itself is returned regardless */ }

  return { ok: true, why: null, gate, perViewport };
}

// re-exported so callers need only this module for the standard flow
export { buildSectionSpecs, writeSectionSpecs, loadSectionSpecs };
