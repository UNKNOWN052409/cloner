// Per-section computed-style spec files (task G6.7 — technique 1 of the
// ai-website-cloner-claudeskill mapping, docs/AI-CLONER-SKILL-INTEGRATION.md).
//
// The external skill's core loop: for every classified section, walk the DOM
// (bounded depth, bounded children) and capture EXACT getComputedStyle values
// into a per-section spec file — verbatim text, assets, trigger states — so a
// downstream builder never guesses. This module gives OUR engine the same
// artifact, derived from evidence we already capture:
//   - dom.json elements carry per-element computed styles
//     (src/intelligence/dom-extractor.js:44-52)
//   - understanding.json carries per-section classification
//     (src/reconstruction/website-understanding.js makeComponent)
//   - exploration.json + states/<pageId>/<recordId>.html carry recorded
//     trigger states (src/reconstruction/reconstruction-pipeline.js
//     deriveInteractionRecords)
// Nothing here re-classifies or invents values: spec members copy the captured
// computed-style objects verbatim, sections come only from understanding
// components, and elements covered by no section are counted as uncovered —
// never folded into a fabricated section.
//
// Second gap this module closes (the skill lists shadows/transforms/filters/
// letter-spacing among the spec's exact values; the stock extractor records
// none of them): EXTENDED_STYLE_PROPS is the supplementary vocabulary, captured
// live by EXTRACT_EXTENDED_STYLES_FN for elements resolved by structural path.
// Structural paths are the same scheme the replay runtime uses at click time
// (src/reconstruction/reconstruction-pipeline.js: "tag.firstClass:nth-of-type(k)
// chain"), so a path recorded in a spec resolves identically on the original
// page AND on the generated clone. Uncaptured props stay absent — a spec value
// is always a measured value, never a default.

import fs from "node:fs";
import path from "node:path";

// Supplementary computed-style vocabulary (bounded, evidence-only). Each prop
// is read with getComputedStyle and recorded verbatim; nothing is normalized
// here (downstream consumers compare with their own comparators, e.g. the
// 3.4.3 analyzer's PX_TOLERANCE for px fields).
export const EXTENDED_STYLE_PROPS = Object.freeze([
  "letterSpacing", "textTransform", "textAlign", "whiteSpace", "textDecorationLine",
  "boxShadow", "transform", "filter", "transition",
  "flexGrow", "flexShrink", "flexBasis",
  "minWidth", "minHeight", "maxWidth", "maxHeight",
  "backgroundImage", "overflowX", "overflowY", "outline", "verticalAlign",
  "borderTopWidth", "borderLeftWidth",
]);

// Bounded walk, mirroring the skill's depth-limited per-section sweep with
// documented engine bounds (the skill uses depth 4 / 20 children; the engine's
// own extractor samples 1200 elements — these bounds sit between the two).
export const MAX_EXTEND_DEPTH = 6;
export const MAX_EXTEND_CHILDREN = 40;
export const MAX_EXTEND_TARGETS = 64;

// Spec member cap — a section whose member list would exceed this is still
// written, with members truncated and truncation recorded (honest bound).
export const MAX_SPEC_MEMBERS = 200;

// ---------------------------------------------------------------------------
// structural paths (in-page helpers — kept string-shaped for page.evaluate)
// ---------------------------------------------------------------------------

// structPath expression evaluated IN PAGE: "tag.firstClass:nth-of-type(k)"
// chain from body. Same scheme as the replay runtime's domPath so a path
// recorded here resolves on the clone too. cx-* tokens are skipped exactly as
// the runtime skips them (they are generator artifacts, not site structure).
const STRUCT_PATH_IN_PAGE = `(() => {
  const firstClass = (el) => {
    const toks = String(el.getAttribute("class") || "").trim().split(/\\s+/)
      .filter((c) => c && !/^cx-\\d+$/.test(c));
    return toks[0] || null;
  };
  const pathOf = (el) => {
    const parts = [];
    let cur = el;
    while (cur && cur !== document.body) {
      const tag = cur.tagName.toLowerCase();
      const fc = firstClass(cur);
      let k = 1, sib = cur;
      while ((sib = sib.previousElementSibling)) {
        if (sib.tagName.toLowerCase() === tag && firstClass(sib) === fc) k++;
      }
      parts.unshift(fc ? tag + "." + fc + ":nth-of-type(" + k + ")" : tag + ":nth-of-type(" + k + ")");
      cur = cur.parentElement;
    }
    return parts.join(" > ");
  };
  return pathOf;
})()`;

const RESOLVE_PATH_IN_PAGE = `(paths) => {
  const firstClass = (el) => {
    const toks = String(el.getAttribute("class") || "").trim().split(/\\s+/)
      .filter((c) => c && !/^cx-\\d+$/.test(c));
    return toks[0] || null;
  };
  const resolve = (sel) => {
    const steps = String(sel || "").split(" > ").filter(Boolean);
    let cur = document.body;
    for (const step of steps) {
      const m = step.match(/^([a-z0-9]+)(?:\\.([^:]+))?:nth-of-type\\((\\d+)\\)$/i);
      if (!m) return null;
      const [, tag, fc, kStr] = m;
      const kids = [...cur.children].filter((c) =>
        c.tagName.toLowerCase() === tag && firstClass(c) === (fc || null));
      const hit = kids[Number(kStr) - 1];
      if (!hit) return null;
      cur = hit;
    }
    return cur;
  };
  return paths.map(resolve);
}`;

// EXTRACT_EXTENDED_STYLES_FN(paths, opts) — in-page capture for a bounded list
// of structural paths. For each resolved element: the element's own extended
// computed styles, plus its descendants (bounded depth/children) so a section
// spec can carry the whole subtree's exact values in one pass. Returns entries
// keyed by path; unresolved paths are reported, never guessed.
export const EXTRACT_EXTENDED_STYLES_FN = (paths, opts = {}) => {
  const maxDepth = opts.maxDepth ?? 6;
  const maxChildren = opts.maxChildren ?? 40;
  const PROPS = ["letterSpacing", "textTransform", "textAlign", "whiteSpace", "textDecorationLine",
    "boxShadow", "transform", "filter", "transition",
    "flexGrow", "flexShrink", "flexBasis",
    "minWidth", "minHeight", "maxWidth", "maxHeight",
    "backgroundImage", "overflowX", "overflowY", "outline", "verticalAlign",
    "borderTopWidth", "borderLeftWidth"];
  const firstClass = (el) => {
    const toks = String(el.getAttribute("class") || "").trim().split(/\s+/)
      .filter((c) => c && !/^cx-\d+$/.test(c));
    return toks[0] || null;
  };
  const pathOf = (el) => {
    const parts = [];
    let cur = el;
    while (cur && cur !== document.body) {
      const tag = cur.tagName.toLowerCase();
      const fc = firstClass(cur);
      let k = 1, sib = cur;
      while ((sib = sib.previousElementSibling)) {
        if (sib.tagName.toLowerCase() === tag && firstClass(sib) === fc) k++;
      }
      parts.unshift(fc ? tag + "." + fc + ":nth-of-type(" + k + ")" : tag + ":nth-of-type(" + k + ")");
      cur = cur.parentElement;
    }
    return parts.join(" > ");
  };
  const resolve = (sel) => {
    const steps = String(sel || "").split(" > ").filter(Boolean);
    let cur = document.body;
    for (const step of steps) {
      const m = step.match(/^([a-z0-9]+)(?:\.([^:]+))?:nth-of-type\((\d+)\)$/i);
      if (!m) return null;
      const kids = [...cur.children].filter((c) =>
        c.tagName.toLowerCase() === m[1] && firstClass(c) === (m[2] || null));
      const hit = kids[Number(m[3]) - 1];
      if (!hit) return null;
      cur = hit;
    }
    return cur;
  };
  const readStyles = (el) => {
    const cs = getComputedStyle(el);
    const out = {};
    for (const p of PROPS) {
      const v = cs[p];
      if (typeof v === "string" && v !== "") out[p] = v; // verbatim; absence stays absent
    }
    return out;
  };
  const byPath = {};
  const unresolved = [];
  const targets = (Array.isArray(paths) ? paths : []).slice(0, opts.maxTargets ?? 64);
  for (const sel of targets) {
    const root = resolve(sel);
    if (!root) { unresolved.push(sel); continue; }
    let seen = 0;
    const walk = (el, depth) => {
      if (seen >= maxChildren) return;
      seen++;
      byPath[pathOf(el)] = readStyles(el);
      if (depth >= maxDepth) return;
      for (const child of el.children) walk(child, depth + 1);
    };
    walk(root, 0);
  }
  return { byPath, unresolved, sampled: Object.keys(byPath).length, props: PROPS };
};

// ---------------------------------------------------------------------------
// spec building (pure — deterministic functions of the captured evidence)
// ---------------------------------------------------------------------------

// childrenIndexMap(elements) — parent index → child indexes in CAPTURE order.
// dom.json's `children` field is a COUNT (src/intelligence/dom-extractor.js:33),
// so sibling order must be derived from parent links + capture order — exactly
// what this map does, once per build.
export function childrenIndexMap(elements) {
  const map = new Map();
  for (const el of elements) {
    if (!el || typeof el.i !== "number") continue;
    const p = el.parent !== null && el.parent !== undefined ? el.parent : -1;
    if (!map.has(p)) map.set(p, []);
    map.get(p).push(el.i);
  }
  return map;
}

// Stable structural path computed IN NODE from dom.json parent links (no
// browser): "tag.firstClass:nth-of-type(k)" chain, same scheme the in-page
// helper emits and the replay runtime resolves. k counts siblings with the
// SAME tag + first class (+1). The TOPMOST captured element (parent null —
// the extractor resolves parents geometrically and body itself is not
// captured) counts its k among same-(tag, first-class) ROOTS in capture
// order, which mirrors the in-page helper's previous-sibling count under
// document.body. Known bound (shared with the replay runtime's domPath): if
// the capture DROPPED a same-tag sibling of the topmost element (bounded
// sampling), the two counts can diverge — unresolved paths are reported by
// the capture, never guessed.
export function structuralPathOf(index, elementsByIndex, childMap) {
  const el = elementsByIndex.get(index);
  if (!el) return null;
  const firstClass = (e) => String(e.cls || "").trim().split(/\s+/).filter((c) => c && !/^cx-\d+$/.test(c))[0] || null;
  const step = (tag, fc, k) => (fc ? `${tag}.${fc}:nth-of-type(${Math.max(1, k)})` : `${tag}:nth-of-type(${Math.max(1, k)})`);
  const parts = [];
  let cur = el;
  let guard = 0;
  while (cur && guard++ < 64) {
    const parent = cur.parent !== null && cur.parent !== undefined ? elementsByIndex.get(cur.parent) : null;
    if (!parent) {
      // topmost step: position among same-(tag, first-class) roots, capture order
      let k = 0;
      for (const cand of elementsByIndex.values()) {
        if (cand.parent !== null && cand.parent !== undefined) continue;
        if (cand.tag !== cur.tag || firstClass(cand) !== firstClass(cur)) continue;
        k++;
        if (cand.i === cur.i) break;
      }
      parts.unshift(step(cur.tag, firstClass(cur), k));
      break;
    }
    const tag = cur.tag, fc = firstClass(cur);
    let k = 0;
    for (const sib of (childMap.get(parent.i) || [])) {
      const sEl = elementsByIndex.get(sib);
      if (!sEl || sEl.tag !== tag || firstClass(sEl) !== fc) continue;
      k++;
      if (sib === cur.i) break;
    }
    parts.unshift(step(tag, fc, k));
    cur = parent;
  }
  return parts.join(" > ") || null;
}

// descendantIndexesOf(rootIndex, childMap) — all elements whose parent chain
// reaches rootIndex, in breadth-first capture order, cycle-safe (a claimed
// element never re-enters the walk).
function descendantIndexesOf(rootIndex, childMap) {
  const out = [];
  const seen = new Set([rootIndex]);
  const queue = [...(childMap.get(rootIndex) || [])];
  while (queue.length) {
    const i = queue.shift();
    if (seen.has(i)) continue;
    seen.add(i);
    out.push(i);
    for (const c of childMap.get(i) || []) if (!seen.has(c)) queue.push(c);
  }
  return out;
}

// rectContains(outer, inner) — inner fully inside outer (with the extractor's
// rounding slack: 1px on every edge).
export function rectContains(outer, inner) {
  if (!outer || !inner) return false;
  const s = 1;
  return inner.x >= outer.x - s && inner.y >= outer.y - s &&
    inner.x + inner.w <= outer.x + outer.w + s && inner.y + inner.h <= outer.y + outer.h + s;
}

// buildSectionSpecs({ elements, understanding, interactions, pageId }) →
// { ok, why, specs, uncovered }.
//   elements      dom.json element list (exact captured computed styles)
//   understanding understanding.json model (components carry kind/rect/evidence)
//   interactions  replay records (deriveInteractionRecords output shape:
//                 { id, pageId, domIndex?, ... }) — optional
// Evidence gate: no understanding components or no element evidence →
// ok:false with the reason; specs: [] (never fabricated). Deterministic.
export function buildSectionSpecs({ elements, understanding, interactions = [], pageId = null }) {
  const els = (Array.isArray(elements) ? elements : []).filter((e) => e && typeof e.i === "number");
  const components = (understanding && Array.isArray(understanding.components)) ? understanding.components : [];
  if (!components.length) return { ok: false, why: "no understanding components — no sections to spec", specs: [], uncovered: els.length, uncoveredIndexes: [] };
  if (!els.length) return { ok: false, why: "no dom element evidence", specs: [], uncovered: 0, uncoveredIndexes: [] };

  const byIndex = new Map(els.map((e) => [e.i, e]));
  const childMap = childrenIndexMap(els);
  // document order: top edge, then left edge, then capture index
  const docOrder = (a, b) =>
    (a.rect?.y ?? 0) - (b.rect?.y ?? 0) ||
    (a.rect?.x ?? 0) - (b.rect?.x ?? 0) ||
    (a.elementIndex ?? 0) - (b.elementIndex ?? 0);
  const sorted = [...components].sort(docOrder);

  // interactions linked to member indexes (page-scoped like the pipeline wires them)
  const interactionsByIndex = new Map();
  for (const rec of Array.isArray(interactions) ? interactions : []) {
    if (rec && typeof rec.domIndex === "number") interactionsByIndex.set(rec.domIndex, rec);
  }

  const claimed = new Set();
  const specs = [];
  sorted.forEach((c, n) => {
    const root = byIndex.get(c.elementIndex);
    if (!root) return; // component references an element the capture dropped — skip, count as uncovered below
    const memberIdx = [root.i, ...descendantIndexesOf(root.i, childMap)];
    const members = [];
    const verbatimText = [];
    const assets = [];
    const linkedInteractions = [];
    for (const i of memberIdx.slice(0, MAX_SPEC_MEMBERS)) {
      const el = byIndex.get(i);
      claimed.add(i);
      members.push({
        i: el.i,
        tag: el.tag || null,
        cls: el.cls || null,
        id: el.id || null,
        role: el.role || null,
        ariaName: el.ariaName || null,
        rect: { ...(el.rect || {}) },
        path: structuralPathOf(el.i, byIndex, childMap),
        style: { ...(el.style || {}) },   // exact captured computed values, verbatim
        layout: { ...(el.layout || {}) },
      });
      if (el.text) verbatimText.push(el.text);
      if (el.tag === "img" && el.src) assets.push({ i: el.i, src: el.src });
      const rec = interactionsByIndex.get(i);
      if (rec) {
        linkedInteractions.push({
          id: rec.id,
          triggerElement: rec.domIndex,
          capturedState: rec.pageId && rec.id ? `states/${rec.pageId}/${rec.id}.html` : null,
        });
      }
    }
    const truncated = memberIdx.length > MAX_SPEC_MEMBERS;
    specs.push({
      sectionId: `sec-${String(n + 1).padStart(3, "0")}`,
      kind: c.kind || null,
      pageId: pageId || understanding.pageId || null,
      elementIndex: c.elementIndex,
      rect: { ...(c.rect || root.rect || {}) },
      confidence: typeof c.confidence === "number" ? c.confidence : null,
      memberCount: memberIdx.length,
      truncated,
      members,
      verbatimText,
      assets,
      interactions: linkedInteractions,
      provenance: {
        source: "dom.json computed styles (verbatim, src/intelligence/dom-extractor.js)",
        understanding: "understanding.json component (src/reconstruction/website-understanding.js)",
        extendedVocabulary: EXTENDED_STYLE_PROPS,
      },
    });
  });

  const uncoveredIndexes = els.filter((e) => !claimed.has(e.i)).map((e) => e.i);
  const uncovered = uncoveredIndexes.length;
  if (!specs.length) return { ok: false, why: "no component resolved to a captured element", specs: [], uncovered, uncoveredIndexes: [] };
  return { ok: true, why: null, specs, uncovered, uncoveredIndexes };
}

// writeSectionSpecs(specs, artifactsDir) — one JSON file per section plus an
// index, written next to the artifacts (same side-of-artifacts contract as
// design-tokens.json). Deterministic file names: sec-NNN-<kind>.spec.json.
// Returns the written file list.
export function writeSectionSpecs(specs, artifactsDir) {
  if (!Array.isArray(specs) || !specs.length) return { ok: false, why: "no specs to write", files: [] };
  const dir = path.join(artifactsDir, "specs");
  fs.mkdirSync(dir, { recursive: true });
  const safeKind = (k) => String(k || "section").toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "") || "section";
  const files = [];
  for (const s of specs) {
    const name = `${s.sectionId}-${safeKind(s.kind)}.spec.json`;
    fs.writeFileSync(path.join(dir, name), JSON.stringify(s, null, 2));
    files.push({ file: `specs/${name}`, sectionId: s.sectionId, kind: s.kind, members: s.memberCount });
  }
  fs.writeFileSync(path.join(dir, "index.json"), JSON.stringify({
    generatedAt: new Date().toISOString(),
    count: specs.length,
    sections: files,
  }, null, 2));
  files.push({ file: "specs/index.json", sectionId: null, kind: "index", members: null });
  return { ok: true, why: null, files };
}

// enrichSpecsFromExtendedCapture(specs, captureByPath) — merge live extended
// computed styles into spec members. Only measured values are merged (a prop
// the capture did not return stays absent — never defaulted). Returns the
// number of members enriched.
export function enrichSpecsFromExtendedCapture(specs, captureByPath) {
  if (!captureByPath || typeof captureByPath !== "object") return 0;
  let enriched = 0;
  for (const s of Array.isArray(specs) ? specs : []) {
    for (const m of s.members || []) {
      const ext = m.path ? captureByPath[m.path] : null;
      if (ext && typeof ext === "object" && Object.keys(ext).length) {
        m.extended = { ...ext };
        enriched++;
      }
    }
  }
  return enriched;
}

// captureExtendedStyles(page, paths, opts) — run the in-page extended capture
// on a live Playwright page. Injectable page keeps the caller in control of
// browser ownership (same contract as responsive-analyzer.capturePerViewportEvidence).
export async function captureExtendedStyles(page, paths, opts = {}) {
  const res = await page.evaluate(EXTRACT_EXTENDED_STYLES_FN, paths, opts);
  return res && typeof res === "object"
    ? res
    : { byPath: {}, unresolved: [], sampled: 0, props: EXTENDED_STYLE_PROPS };
}

// loadSectionSpecs(artifactsDir) — read back what writeSectionSpecs wrote
// (specs/index.json + files). Missing index → honest absence.
export function loadSectionSpecs(artifactsDir) {
  const dir = path.join(artifactsDir, "specs");
  let index = null;
  try { index = JSON.parse(fs.readFileSync(path.join(dir, "index.json"), "utf8")); } catch { return { ok: false, why: "specs/index.json missing", specs: [] }; }
  const specs = [];
  for (const entry of index.sections || []) {
    try { specs.push(JSON.parse(fs.readFileSync(path.join(artifactsDir, entry.file), "utf8"))); } catch { /* a lost file degrades the set, never fabricates */ }
  }
  return { ok: specs.length > 0, why: specs.length ? null : "no spec files readable", specs };
}
