// Unified website-understanding engine (task 3.4.1): turns one captured artifact
// page (dom.json elements + styles.json + geometry.json + screenshot + network
// entries) into a single evidence model — per-component
// { kind, evidence: [{source, ref}], confidence, provenance } — plus the
// parent-child / repeated-group relationships and interaction context between them.
//
// Layers:
//  1. DETERMINISTIC region inference (this file): header, navigation, sidebar,
//     toolbar, workspace, splitter, card, card-grid, table, chart, modal, form,
//     footer — from captured tag/role/aria/class tokens, rect ratios, repeated
//     siblings and computed styles. Every vote carries its evidence record, and
//     the elected kind's confidence comes from cross-source aggregation
//     (component-evidence.aggregateConfidence).
//  2. Repeated groups: reused via vision-assist.repeatedGroups() — the same
//     same-parent + same-class-signature + >=3-members pass that
//     analysis/component-tree-builder.js performs (read, not edited).
//  3. VISION HOOK (weak containers only): components that are containers
//     (>= 2 children) with DETERMINISTIC confidence < 0.5 (the strict
//     DOM_OVERRIDE_FLOOR band from vision-assist.js) are re-classified through
//     vision-assist.classifyAmbiguous(); the verdict is merged with the
//     deterministic side via vision-assist.mergeVerdicts() — so vision can ONLY
//     win inside the < 0.5 band and only with confidence >= 0.7 on a concrete
//     kind. visionFn is injectable; with none injected the default cfg pins the
//     provider to "none" → the deterministic no-provider fallback, zero network.
//  4. Interaction context: data-cloner-trigger marks and network-recorder
//     endpoints (fetch/xhr per pathname, query strings stripped — defense in
//     depth on top of the capture stage's redaction; no credentials anywhere).
//
// Failure honesty: missing/malformed inputs degrade with warnings, never throw;
// an empty evidence page returns an empty model, not a guessed one.

import path from "node:path";
import { makeEvidence, mergeEvidenceLists, aggregateConfidence, electKind } from "./component-evidence.js";
import { repeatedGroups, classifyAmbiguous, mergeVerdicts } from "./vision-assist.js";
import { analyzeLayout } from "./analysis/layout-analyzer.js";
import { loadArtifacts } from "./artifact-loader.js";
// task 3.5.6 (F2/F3): card classification gains a token-less path — repetition +
// geometry agree without requiring a class-name hit (unfamiliar vocabulary still
// classifies); the token path keeps its existing semantics inside the hook. The
// hint vocabularies themselves live in the detector's extensible registry.
import { cardPatternVotes, regionTokenHints } from "./component-pattern-detector.js";

// Region-kind vocabulary this engine emits (deterministic side). The vision
// vocabulary (vision-assist.COMPONENT_KINDS) is narrower; vision verdicts are
// mapped into these names via VISION_KIND_TO_REGION below.
export const REGION_KINDS = [
  "header", "navigation", "sidebar", "toolbar", "workspace", "splitter",
  "card", "card-grid", "table", "chart", "modal", "form", "footer",
];

// vision kind → region kind (only where the vocabularies differ or align).
const VISION_KIND_TO_REGION = {
  nav: "navigation", table: "table", chart: "chart", "card-grid": "card-grid",
  form: "form", sidebar: "sidebar",
};
// region kind → vision kind for feeding mergeVerdicts (kinds outside the vision
// vocabulary — header/toolbar/workspace/splitter/card/modal/footer — map to
// "unknown", which mergeVerdicts treats as overridable-by-vision; the ORIGINAL
// deterministic kind is always restored when vision does NOT win).
const REGION_TO_VISION_KIND = {
  navigation: "nav", table: "table", chart: "chart", "card-grid": "card-grid",
  form: "form", sidebar: "sidebar",
};

// ---- token hint lists (class/id tokens; tokenized on non-alphanumerics) ----
// task 3.5.6 (F3): the vocabulary lives in component-pattern-detector's
// extensible registry (same values, same shape — every probe()/hasToken use is
// unchanged); registerRegionHints() extends it additively as weak votes.
const TOKENS = regionTokenHints();

const clsTokens = (s) => String(s || "").toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
const hasToken = (tokens, words) => tokens.some((t) => words.includes(t));
// tags that only exist inside a table structure — they never carry the table
// geometry vote themselves (their <table>/role=grid ancestor does); ROW_TAGS are
// also what the vote counts when seen as children/grandchildren
const TABLE_INNER_TAGS = new Set(["tbody", "thead", "tfoot", "tr", "td", "th"]);
const ROW_TAGS = new Set(["tr", "td", "th"]);

// ---------- input normalization ----------

function normalizeElements(dom, geometry, warnings) {
  const raw = Array.isArray(dom) ? dom : dom && Array.isArray(dom.elements) ? dom.elements : null;
  if (raw) {
    const els = raw.filter((e) => e && typeof e.i === "number");
    if (els.length !== raw.length) warnings.push(`${raw.length - els.length} malformed dom element(s) dropped (no index)`);
    return els;
  }
  // degraded path: dom.json missing/malformed but geometry.json containers exist —
  // reduced evidence (tag/cls/rect/layout only, no parent links, no styles)
  const containers = geometry && Array.isArray(geometry.containers) ? geometry.containers : null;
  if (containers) {
    warnings.push("dom.json missing — reduced evidence from geometry.json containers (no parent links, no styles)");
    return containers
      .filter((c) => c && typeof c.i === "number")
      .map((c) => ({ ...c, role: null, ariaName: null, id: null, text: null, parent: null, children: 0, style: {} }));
  }
  warnings.push("no dom evidence — empty understanding model");
  return [];
}

function normalizeEntries(x) {
  return Array.isArray(x) ? x : x && Array.isArray(x.entries) ? x.entries : [];
}

// ---------- tree helpers over the captured containment parents ----------

function buildTreeHelpers(els) {
  const byIndex = new Map(els.map((e) => [e.i, e]));
  const childrenOf = new Map(); // parent index → child elements (document order)
  for (const el of els) {
    const p = el.parent === null || el.parent === undefined ? -1 : el.parent;
    if (!childrenOf.has(p)) childrenOf.set(p, []);
    childrenOf.get(p).push(el);
  }
  const childCount = (i) => (childrenOf.get(i) || []).length;
  // bounded subtree walk — cycle-guarded: captured containment links are
  // heuristic geometric containment and can 2-cycle when a docking stack and its
  // panes share a box (workspace-analyzer FILING, task 3.4.2), which without the
  // guard pushes infinitely and dies with RangeError: Invalid array length
  const descendants = (i) => {
    const out = [];
    const seen = new Set([i]);
    const stack = [...(childrenOf.get(i) || [])];
    while (stack.length) {
      const e = stack.pop();
      if (seen.has(e.i)) continue;
      seen.add(e.i);
      out.push(e);
      const kids = childrenOf.get(e.i);
      if (kids && kids.length) stack.push(...kids);
    }
    return out;
  };
  // nearest ancestor chain (cycle-guarded — captured parent links are heuristic
  // geometric containment, so a bad link must not hang the engine)
  const ancestorChain = (i) => {
    const chain = [];
    const seen = new Set();
    for (let cur = byIndex.get(i)?.parent; cur !== null && cur !== undefined && !seen.has(cur); cur = byIndex.get(cur)?.parent) {
      seen.add(cur);
      const el = byIndex.get(cur);
      if (!el) break;
      chain.push(el);
    }
    return chain;
  };
  return { byIndex, childrenOf, childCount, descendants, ancestorChain };
}

// ---------- geometry votes ----------

function controlsCount(el, ctx) {
  return ctx.descendants(el.i).filter((d) => {
    const t = String(d.tag || "").toLowerCase();
    return t === "a" || t === "button" || t === "input" || t === "select" || String(d.role || "").toLowerCase() === "button";
  }).length;
}

function isTopBand(el, ctx) {
  const r = el.rect || {};
  return (
    (r.y ?? 0) <= Math.max(12, ctx.pageH * 0.02) &&
    (r.w ?? 0) >= 0.8 * ctx.pageW &&
    (r.h ?? 0) >= 24 && (r.h ?? 0) <= 0.3 * ctx.pageH &&
    controlsCount(el, ctx) >= 1
  );
}

function isBottomBand(el, ctx) {
  const r = el.rect || {};
  return (
    (r.y ?? 0) + (r.h ?? 0) >= ctx.pageH - 12 &&
    (r.w ?? 0) >= 0.8 * ctx.pageW &&
    (r.h ?? 0) >= 24 && (r.h ?? 0) <= 0.3 * ctx.pageH
  );
}

function isSideRegion(el, ctx) {
  const r = el.rect || {};
  const rightEdge = (r.x ?? 0) + (r.w ?? 0);
  return (
    ((r.x ?? 0) <= 8 || rightEdge >= ctx.pageW - 8) &&
    (r.w ?? 0) <= 0.45 * ctx.pageW &&
    (r.h ?? 0) >= Math.max(120, 0.6 * ctx.pageH)
  );
}

function isToolbarStrip(el, ctx) {
  const r = el.rect || {};
  const w = r.w ?? 0, h = r.h ?? 0;
  if (h < 28 || h > 0.25 * ctx.pageH || w / h < 3) return false;
  return ctx.descendants(el.i).filter((d) => {
    const t = String(d.tag || "").toLowerCase();
    return t === "button" || t === "input" || t === "select" || String(d.role || "").toLowerCase() === "button";
  }).length >= 2;
}

function isThinStrip(el) {
  const r = el.rect || {};
  const w = r.w ?? 0, h = r.h ?? 0;
  return (h > 0 && h <= 10 && w >= 40) || (w > 0 && w <= 10 && h >= 40);
}

// >= 3 boxes with mutually similar width AND height (ratio <= 1.25), each of
// moderate size — the arrangement signature of card/tile grids. The 40x40 floor
// keeps table rows/cells (≈30px) and list items out of the vote: repetition of
// small structural rows is NOT a card grid.
function similarBoxes(boxes) {
  if (boxes.length < 3) return false;
  if (boxes.some((b) => (b.w ?? 0) < 40 || (b.h ?? 0) < 40)) return false;
  const maxW = Math.max(...boxes.map((b) => b.w)), minW = Math.min(...boxes.map((b) => b.w));
  const maxH = Math.max(...boxes.map((b) => b.h)), minH = Math.min(...boxes.map((b) => b.h));
  return maxW / Math.max(1, minW) <= 1.25 && maxH / Math.max(1, minH) <= 1.25;
}

const sameSizeChildren = (el, ctx) => similarBoxes((ctx.childrenOf.get(el.i) || []).map((c) => c.rect || {}));
const sameSizeSiblings = (el, ctx) => {
  const p = el.parent === null || el.parent === undefined ? -1 : el.parent;
  return similarBoxes((ctx.childrenOf.get(p) || []).map((c) => c.rect || {}));
};

// ---------- deterministic kind votes for ONE element ----------

function collectVotes(el, ctx) {
  const votes = [];
  const tag = String(el.tag || "").toLowerCase();
  const role = String(el.role || "").toLowerCase();
  const clsT = clsTokens(el.cls);
  const idT = clsTokens(el.id);
  const r = el.rect || { x: 0, y: 0, w: 0, h: 0 };
  const i = el.i;
  // probe() checks class/id token lists and stages "dom-class" evidence records
  // in `probes`; the matching kind rule then re-kinds them (the SAME token hit is
  // evidence for whichever kind list it matched). splice(0) drains the staging
  // list after each rule so a token can never leak into another kind's votes.
  const probes = [];
  const probe = (words) => {
    const hit = clsT.find((t) => words.includes(t));
    const idHit = idT.find((t) => words.includes(t));
    if (hit) probes.push({ source: "dom-class", ref: `elements[${i}].cls`, note: `class token "${hit}"`, weight: 0.6 });
    if (idHit) probes.push({ source: "dom-class", ref: `elements[${i}].id`, note: `id token "${idHit}"`, weight: 0.45 });
    return !!(hit || idHit);
  };
  const kind = (k, source, ref, note, weight) => {
    if (weight <= 0) return;
    votes.push({ kind: k, evidence: [makeEvidence(source, ref, note, weight)] });
  };

  // ---- header ----
  if (tag === "header") kind("header", "dom-tag", `elements[${i}].tag`, "tag=header", 0.9);
  if (role === "banner") kind("header", "dom-role", `elements[${i}].role`, "role=banner", 0.9);
  if (probe(TOKENS.header)) for (const p of probes.splice(0)) votes.push({ kind: "header", evidence: [p] });
  if (isTopBand(el, ctx)) kind("header", "geometry", `elements[${i}].rect`, `top band ${r.w}x${r.h}@${r.x},${r.y} with ${controlsCount(el, ctx)} control(s)`, 0.5);

  // ---- navigation ----
  if (tag === "nav") kind("navigation", "dom-tag", `elements[${i}].tag`, "tag=nav", 0.9);
  if (role === "navigation") kind("navigation", "dom-role", `elements[${i}].role`, "role=navigation", 0.9);
  if (/nav|menu/i.test(String(el.ariaName || ""))) kind("navigation", "dom-aria", `elements[${i}].ariaName`, `aria-label="${String(el.ariaName).slice(0, 40)}"`, 0.45);
  if (probe(TOKENS.navigation)) for (const p of probes.splice(0)) votes.push({ kind: "navigation", evidence: [p] });
  {
    const links = ctx.descendants(i).filter((d) => String(d.tag || "").toLowerCase() === "a").length;
    if (links >= 2 && (r.w ?? 0) >= 0.4 * ctx.pageW) kind("navigation", "geometry", `elements[${i}].rect`, `${links} link(s) across ${r.w}px band`, 0.5);
  }

  // ---- sidebar ----
  if (tag === "aside") kind("sidebar", "dom-tag", `elements[${i}].tag`, "tag=aside", 0.9);
  if (role === "complementary") kind("sidebar", "dom-role", `elements[${i}].role`, "role=complementary", 0.9);
  if (probe(TOKENS.sidebar)) for (const p of probes.splice(0)) votes.push({ kind: "sidebar", evidence: [p] });
  if (isSideRegion(el, ctx)) kind("sidebar", "geometry", `elements[${i}].rect`, `side-anchored ${r.w}x${r.h}@${r.x},${r.y}`, 0.55);

  // ---- toolbar ----
  if (role === "toolbar") kind("toolbar", "dom-role", `elements[${i}].role`, "role=toolbar", 0.9);
  if (probe(TOKENS.toolbar)) for (const p of probes.splice(0)) votes.push({ kind: "toolbar", evidence: [p] });
  if (isToolbarStrip(el, ctx)) kind("toolbar", "geometry", `elements[${i}].rect`, `control strip ${r.w}x${r.h}`, 0.55);

  // ---- splitter (thin strip / token; flag also feeds the workspace vote) ----
  if (probe(TOKENS.splitter)) for (const p of probes.splice(0)) votes.push({ kind: "splitter", evidence: [p] });
  if (isThinStrip(el)) kind("splitter", "geometry", `elements[${i}].rect`, `thin strip ${r.w}x${r.h}`, 0.45);

  // ---- workspace ----
  if (tag === "main") kind("workspace", "dom-tag", `elements[${i}].tag`, "tag=main", 0.85);
  if (role === "main") kind("workspace", "dom-role", `elements[${i}].role`, "role=main", 0.85);
  if (probe(TOKENS.workspace)) for (const p of probes.splice(0)) votes.push({ kind: "workspace", evidence: [p] });
  {
    const kids = ctx.childrenOf.get(i) || [];
    const splitterKids = kids.filter((k) => ctx.splitterFlag.get(k.i)).length;
    const paneKids = kids.length - splitterKids;
    if (splitterKids >= 1 && paneKids >= 2) kind("workspace", "geometry", `elements[${i}].rect`, `${paneKids} panes + ${splitterKids} splitter(s)`, 0.55);
  }

  // ---- card (member) — task 3.5.6 F2 hook: token path OR cross-source
  // repetition+geometry path (unfamiliar vocabulary still classifies; plain
  // repeated blocks still never become cards on repetition alone — the hook
  // requires BOTH sources to agree when no token matched) ----
  {
    votes.push(...cardPatternVotes(el, {
      repeated: ctx.repeated.get(i) || null,
      sameSizeSiblings: sameSizeSiblings(el, ctx),
      siblingsRects: (ctx.childrenOf.get(el.parent === null || el.parent === undefined ? -1 : el.parent) || []).map((c) => c.rect || {}),
    }));
  }

  // ---- card-grid (container) ----
  if (probe(TOKENS.cardGrid)) for (const p of probes.splice(0)) votes.push({ kind: "card-grid", evidence: [p] });
  {
    const g = ctx.repeatedByParent.get(i);
    if (g && g.siblings >= 3) kind("card-grid", "repetition", `elements[${i}].repetition`, `${g.siblings} repeated children ("${g.sig}")`, 0.5);
    if (sameSizeChildren(el, ctx)) kind("card-grid", "geometry", `elements[${i}].rect`, `≥3 same-size children`, 0.45);
  }

  // ---- table ----
  if (tag === "table") kind("table", "dom-tag", `elements[${i}].tag`, "tag=table", 0.9);
  if (["table", "grid", "treegrid"].includes(role)) kind("table", "dom-role", `elements[${i}].role`, `role=${role}`, 0.9);
  if (probe(TOKENS.table)) for (const p of probes.splice(0)) votes.push({ kind: "table", evidence: [p] });
  // row/cell structure vote is DEPTH-LIMITED (≤ 2 levels: table → tbody → tr) so
  // ancestors of a table (app-body, workspace, panes) never inherit a table vote,
  // and the table-structure tags themselves (tbody/tr/td/th) never carry it —
  // their table ancestor already does. Div-based grids (role=grid) qualify: rows
  // are direct children.
  if (!TABLE_INNER_TAGS.has(tag)) {
    let cells = 0;
    for (const c of ctx.childrenOf.get(i) || []) {
      if (ROW_TAGS.has(String(c.tag || "").toLowerCase())) cells++;
      for (const g of ctx.childrenOf.get(c.i) || []) if (ROW_TAGS.has(String(g.tag || "").toLowerCase())) cells++;
    }
    if (cells >= 2) kind("table", "geometry", `elements[${i}].rect`, `${cells} row/cell children within 2 levels`, 0.5);
  }

  // ---- chart ----
  if (tag === "canvas" || tag === "svg") kind("chart", "dom-tag", `elements[${i}].tag`, `tag=${tag}`, 0.9);
  if (probe(TOKENS.chart)) for (const p of probes.splice(0)) votes.push({ kind: "chart", evidence: [p] });
  if (role === "img" && /chart|graph|plot|visualization/i.test(String(el.ariaName || ""))) kind("chart", "dom-aria", `elements[${i}].ariaName`, `role=img aria-label="${String(el.ariaName).slice(0, 40)}"`, 0.5);

  // ---- modal ----
  if (role === "dialog" || role === "alertdialog") kind("modal", "dom-role", `elements[${i}].role`, `role=${role}`, 0.95);
  if (probe(TOKENS.modal)) for (const p of probes.splice(0)) votes.push({ kind: "modal", evidence: [p] });
  {
    const pos = String(el.layout?.position || "").toLowerCase();
    const z = Number(el.style?.zIndex);
    if (pos === "fixed" && Number.isFinite(z) && z >= 10) {
      kind("modal", "css", ctx.styleRef(i), `position=fixed + z-index=${z}`, 0.55);
    }
  }

  // ---- form ----
  if (tag === "form") kind("form", "dom-tag", `elements[${i}].tag`, "tag=form", 0.9);
  if (probe(TOKENS.form)) for (const p of probes.splice(0)) votes.push({ kind: "form", evidence: [p] });
  {
    const fields = ctx.descendants(i).filter((d) => ["input", "select", "textarea"].includes(String(d.tag || "").toLowerCase())).length;
    if (fields >= 2) kind("form", "geometry", `elements[${i}].rect`, `${fields} input control(s)`, 0.5);
  }

  // ---- footer ----
  if (tag === "footer") kind("footer", "dom-tag", `elements[${i}].tag`, "tag=footer", 0.9);
  if (role === "contentinfo") kind("footer", "dom-role", `elements[${i}].role`, "role=contentinfo", 0.9);
  if (probe(TOKENS.footer)) for (const p of probes.splice(0)) votes.push({ kind: "footer", evidence: [p] });
  if (isBottomBand(el, ctx)) kind("footer", "geometry", `elements[${i}].rect`, `bottom band ${r.w}x${r.h}@${r.x},${r.y}`, 0.5);

  return votes;
}

// ---------- network + trigger context ----------

const urlPathname = (u) => {
  try { const p = new URL(u); return p.pathname; } catch { return String(u || "").split("?")[0].split("#")[0]; }
};

// network endpoint summary from the page's recorded entries. Query strings and
// hashes are stripped here — entries are already redacted upstream, this module
// never re-introduces credential-bearing material.
function summarizeNetwork(entries) {
  const byPath = new Map();
  let imageCount = 0;
  const pathnames = new Set();
  for (const e of entries) {
    const type = String(e?.resourceType || "").toLowerCase();
    if (type === "image") imageCount++;
    if (type !== "fetch" && type !== "xhr") continue;
    const p = urlPathname(e.url);
    pathnames.add(p);
    if (!byPath.has(p)) byPath.set(p, { url: p, methods: new Set(), statuses: new Set(), count: 0 });
    const rec = byPath.get(p);
    rec.count++;
    if (e.method) rec.methods.add(String(e.method).toUpperCase());
    if (e.status) rec.statuses.add(Number(e.status));
  }
  const endpoints = [...byPath.values()]
    .map((r) => ({ url: r.url, methods: [...r.methods].sort(), statuses: [...r.statuses].sort((a, b) => a - b), count: r.count }))
    .sort((a, b) => (a.url < b.url ? -1 : a.url > b.url ? 1 : 0));
  return { endpoints, imageCount, pathnameEvidence: pathnames, entryCount: entries.length };
}

// ---------- component assembly ----------

const STYLE_KEYS = ["position", "zIndex", "backgroundColor", "fontSize", "fontWeight", "borderRadius"];

function makeComponent(el, elected, ctx, networkEvidences) {
  const i = el.i;
  const rep = ctx.repeated.get(i) || null;
  const evidence = networkEvidences.length
    ? mergeEvidenceLists(elected.evidence, networkEvidences)
    : elected.evidence;
  const confidence = aggregateConfidence(evidence);
  const style = {};
  for (const k of STYLE_KEYS) if (el.style && el.style[k] !== undefined && el.style[k] !== null) style[k] = el.style[k];
  return {
    id: `u-${i}`,
    kind: elected.kind,
    elementIndex: i,
    tag: el.tag || null,
    cls: el.cls || null,
    role: el.role || null,
    ariaName: el.ariaName || null,
    rect: { ...(el.rect || { x: 0, y: 0, w: 0, h: 0 }) },
    confidence,
    evidence,
    provenance: {
      tag: el.tag || null,
      cls: el.cls || null,
      id: el.id || null,
      role: el.role || null,
      ariaName: el.ariaName || null,
      text: el.text || null,
      href: el.href || null,
      src: el.src || null,
      rect: { ...(el.rect || { x: 0, y: 0, w: 0, h: 0 }) },
      layout: el.layout ? { display: el.layout.display || null, position: el.layout.position || null } : null,
      style,
      childCount: ctx.childCount(i),
      repeated: rep ? { signature: rep.sig, siblings: rep.siblings } : null,
      dataClonerTrigger: el.dataClonerTrigger || null,
    },
    parentId: null,
    childIds: [],
    depth: 0,
    repeated: rep ? { signature: rep.sig, siblings: rep.siblings } : null,
    interaction: { triggers: [], networkRefs: [] },
  };
}

// subtree interaction context: trigger marks + img srcs actually fetched
// (network evidence ref list — cites only pathnames the recorder really saw).
function collectInteraction(el, ctx, pathnameEvidence) {
  const triggers = [];
  const networkRefs = [];
  const subtree = [el, ...ctx.descendants(el.i)];
  for (const node of subtree) {
    if (node.dataClonerTrigger) triggers.push({ id: node.dataClonerTrigger, elementIndex: node.i, label: node.text || null });
    const src = node.tag && String(node.tag).toLowerCase() === "img" ? node.src : null;
    if (src) {
      const p = urlPathname(src);
      if (pathnameEvidence.has(p)) networkRefs.push(`network:${p}`);
    }
  }
  return { triggers, networkRefs: [...new Set(networkRefs)] };
}

// ---------- public API ----------

// Adapt one loaded page (artifact-loader.loadArtifacts().pages[n]) + the job
// artifacts dir into the pageArtifacts shape buildUnderstandingPage accepts.
export function pageArtifactsFromLoaded(loadedPage, artifactsDir) {
  return {
    pageId: loadedPage.pageId,
    url: loadedPage.url,
    dom: loadedPage.dom,
    styles: loadedPage.styles,
    geometry: loadedPage.geometry,
    network: loadedPage.network,
    screenshotPath: loadedPage.screenshotRef && artifactsDir ? path.join(artifactsDir, loadedPage.screenshotRef) : null,
  };
}

// buildUnderstandingPage(pageArtifacts, opts) → unified evidence model for ONE page.
//
// pageArtifacts: { pageId, url, dom, styles, geometry, network, screenshotPath }
//   dom: dom.json object ({elements:[…]}) or a bare elements array
//   styles/geometry/network: the corresponding artifact objects (tolerant of
//   artifact-loader's {missing:true} markers)
// opts: {
//   visionFn     — injectable async (region, imageBase64, ctx) → {kind, confidence, reason?}
//   visionCfg    — config passed to vision-assist when no visionFn is injected;
//                  DEFAULT { model: { provider: "none" } } → deterministic
//                  no-provider fallback, zero network (tests run offline)
//   visionMaxAsk — cap on vision asks per page (default: vision-assist's 12)
// }
export async function buildUnderstandingPage(pageArtifacts, opts = {}) {
  const warnings = [];
  const pageId = pageArtifacts?.pageId || null;
  const url = pageArtifacts?.url || null;
  const els = normalizeElements(pageArtifacts?.dom, pageArtifacts?.geometry, warnings);

  const emptyModel = (extra = []) => ({
    pageId, url,
    pageMetrics: { width: 0, height: 0, elements: els.length },
    components: [],
    regions: {},
    relationships: { parentChild: [], repeatedGroups: [] },
    interactions: { triggers: [], networkEndpoints: [], networkEntries: 0, imageCount: 0 },
    vision: { attempted: false, screenshotFound: false, candidates: 0, classifications: 0, used: false, provider: null },
    warnings: [...warnings, ...extra],
  });
  if (!els.length) return emptyModel();

  // page metrics from the captured boxes (extractor samples body descendants only)
  let pageW = 0, pageH = 0;
  for (const el of els) {
    pageW = Math.max(pageW, (el.rect?.x ?? 0) + (el.rect?.w ?? 0));
    pageH = Math.max(pageH, (el.rect?.y ?? 0) + (el.rect?.h ?? 0));
  }

  // styles.json corroboration map (evidence refs cite styles.json when present)
  const stylesRaw = pageArtifacts?.styles;
  const stylesEls = Array.isArray(stylesRaw) ? stylesRaw : stylesRaw && Array.isArray(stylesRaw.elements) ? stylesRaw.elements : [];
  const stylesByIndex = new Map(stylesEls.filter((e) => e && typeof e.i === "number").map((e) => [e.i, e]));
  const styleRef = (i) => (stylesByIndex.has(i) ? `styles.json#${i}` : `elements[${i}].style`);

  // network context
  const entries = normalizeEntries(pageArtifacts?.network);
  const net = summarizeNetwork(entries);
  // img srcs actually seen on the wire (image responses), by pathname — this is
  // the set network evidence may cite (recorder-observed traffic only)
  const pathnameEvidence = new Set();
  for (const e of entries) if (String(e?.resourceType || "").toLowerCase() === "image" && e.url) pathnameEvidence.add(urlPathname(e.url));

  const tree = buildTreeHelpers(els);
  // repeated sibling groups — the SAME pass component-tree-builder performs,
  // reused from vision-assist (same-parent + same-class-signature + >= 3 members)
  const repeated = repeatedGroups(els);
  const repeatedByParent = new Map();
  for (const [, g] of repeated) {
    const cur = repeatedByParent.get(g.parentIndex);
    if (!cur || g.siblings > cur.siblings) repeatedByParent.set(g.parentIndex, g);
  }

  const ctx = {
    pageW, pageH,
    ...tree,
    repeated,
    repeatedByParent,
    splitterFlag: new Map(els.map((el) => [el.i, hasToken(clsTokens(el.cls), TOKENS.splitter) || hasToken(clsTokens(el.id), TOKENS.splitter) || isThinStrip(el)])),
    styleRef,
  };

  // pass 1: deterministic election
  const components = [];
  for (const el of els) {
    const votes = collectVotes(el, ctx);
    const elected = electKind(votes);
    if (!elected) continue;
    // network corroboration: this component's subtree loaded media that the
    // recorder actually saw (evidence source "network", weak 0.3 weight)
    const networkEvidences = [];
    for (const node of [el, ...tree.descendants(el.i)]) {
      if (String(node.tag || "").toLowerCase() !== "img" || !node.src) continue;
      const p = urlPathname(node.src);
      if (pathnameEvidence.has(p)) networkEvidences.push(makeEvidence("network", `network:${p}`, "media loaded over network", 0.3));
    }
    components.push(makeComponent(el, elected, ctx, networkEvidences));
  }
  components.sort((a, b) => a.elementIndex - b.elementIndex);

  // pass 2: component hierarchy — nearest classified ancestor (intermediate
  // unclassified elements are skipped; raw element containment stays in provenance)
  const byElementIndex = new Map(components.map((c) => [c.elementIndex, c]));
  for (const c of components) {
    for (const anc of tree.ancestorChain(c.elementIndex)) {
      const parentComp = byElementIndex.get(anc.i);
      if (parentComp && parentComp !== c) { c.parentId = parentComp.id; break; }
    }
  }
  for (const c of components) if (c.parentId) byElementIndex.get(c.parentId)?.childIds.push(c.id);
  // depths (iterative, cycle-guarded — a bad containment link must not hang)
  for (const c of components) {
    const seen = new Set();
    let d = 0;
    for (let cur = c; cur?.parentId && !seen.has(cur.parentId); ) {
      seen.add(cur.parentId);
      cur = byElementIndex.get(cur.parentId);
      if (!cur) break;
      d++;
    }
    c.depth = d;
  }
  for (const c of components) c.childIds.sort();

  // pass 3: interaction context (trigger marks + network refs) per component
  for (const c of components) {
    const el = tree.byIndex.get(c.elementIndex);
    if (!el) continue;
    const ic = collectInteraction(el, ctx, pathnameEvidence);
    c.interaction.triggers = ic.triggers;
    c.interaction.networkRefs = ic.networkRefs;
  }

  // pass 4: VISION HOOK — only containers with deterministic confidence < 0.5.
  // The strict-< floor is vision-assist's DOM_OVERRIDE_FLOOR contract; merge
  // goes through vision-assist.mergeVerdicts so the thresholds stay in one place.
  const visionCandidates = components.filter((c) =>
    c.confidence < 0.5 &&
    tree.childCount(c.elementIndex) >= 2 &&
    (c.rect.w ?? 0) >= 40 && (c.rect.h ?? 0) >= 24
  );
  const vision = { attempted: false, screenshotFound: false, candidates: visionCandidates.length, classifications: 0, used: false, provider: null };
  const screenshotPath = pageArtifacts?.screenshotPath || null;
  if (visionCandidates.length && screenshotPath) {
    vision.attempted = true;
    const visOpts = { maxAsk: opts.visionMaxAsk };
    if (opts.visionFn) visOpts.visionFn = opts.visionFn;
    else visOpts.cfg = opts.visionCfg || { model: { provider: "none" } }; // deterministic default: no provider, no fetch
    // layout map feeds vision-assist's own ambiguity gate (same shape the
    // reconstruction pipeline builds)
    const rectMap = new Map(els.map((e) => [e.i, { x: e.rect?.x ?? 0, y: e.rect?.y ?? 0, width: e.rect?.w ?? 0, height: e.rect?.h ?? 0 }]));
    const layoutByIndex = new Map();
    for (const el of els) layoutByIndex.set(el.i, analyzeLayout(els, rectMap)[el.i] || null);
    const res = await classifyAmbiguous(els, layoutByIndex, screenshotPath, visOpts);
    vision.screenshotFound = res.screenshotFound;
    if (!res.screenshotFound) warnings.push("vision candidates exist but the screenshot is missing/unreadable — DOM-only classification kept");
    for (const comp of visionCandidates) {
      const cls = res.byIndex.get(comp.elementIndex);
      if (!cls) continue; // not in vision-assist's candidate set → stays deterministic
      vision.classifications++;
      const visionKind = cls.visionKind ?? "unknown";
      const visionConfidence = Number(cls.visionConfidence ?? 0);
      // merge with the DETERMINISTIC side as primary. Kinds outside the vision
      // vocabulary map to "unknown" for the merge only; when vision does NOT win
      // the original deterministic kind is restored unchanged.
      const domKindForMerge = REGION_TO_VISION_KIND[comp.kind] || "unknown";
      const merged = mergeVerdicts(domKindForMerge, comp.confidence, visionKind, visionConfidence);
      if (merged.source === "vision") {
        const before = comp.kind;
        comp.kind = VISION_KIND_TO_REGION[merged.kind] || merged.kind;
        comp.confidence = merged.confidence;
        comp.evidence = mergeEvidenceLists(comp.evidence, [makeEvidence(
          "vision", `vision[${comp.elementIndex}]`,
          `${before} → vision ${visionKind}@${visionConfidence}${cls.visionReason ? `: ${cls.visionReason}` : ""}`,
          merged.confidence,
        )]);
        vision.used = true;
        vision.provider = cls.visionProvider || "injected";
      }
    }
  } else if (visionCandidates.length && !screenshotPath) {
    warnings.push("vision candidates exist but no screenshotPath was provided — DOM-only classification kept");
  }

  // regions index + relationships
  const regions = {};
  for (const c of components) (regions[c.kind] = regions[c.kind] || []).push(c.id);
  for (const k of Object.keys(regions)) regions[k].sort();
  const parentChild = components
    .filter((c) => c.parentId)
    .map((c) => ({ parent: c.parentId, child: c.id, via: "containment" }));
  const groupsByIdx = new Map();
  for (const [memberIndex, g] of repeated) {
    const key = `${g.parentIndex}|${g.sig}`;
    if (!groupsByIdx.has(key)) groupsByIdx.set(key, { signature: g.sig, siblings: g.siblings, containerIndex: g.parentIndex, memberIndexes: [] });
    groupsByIdx.get(key).memberIndexes.push(memberIndex);
  }
  const repeatedGroupList = [...groupsByIdx.values()].map((g) => ({
    ...g,
    memberIndexes: [...g.memberIndexes].sort((a, b) => a - b),
    containerComponentId: byElementIndex.get(g.containerIndex)?.id || null,
    memberComponentIds: g.memberIndexes.map((mi) => byElementIndex.get(mi)?.id).filter(Boolean),
  })).sort((a, b) => (a.signature < b.signature ? -1 : a.signature > b.signature ? 1 : 0));

  // page-level trigger list
  const triggers = els
    .filter((el) => el.dataClonerTrigger)
    .map((el) => ({ id: el.dataClonerTrigger, elementIndex: el.i, tag: el.tag || null, label: el.text || null }));

  return {
    pageId, url,
    pageMetrics: { width: Math.round(pageW), height: Math.round(pageH), elements: els.length },
    components,
    regions,
    relationships: { parentChild, repeatedGroups: repeatedGroupList },
    interactions: {
      triggers: triggers.sort((a, b) => a.elementIndex - b.elementIndex),
      networkEndpoints: net.endpoints,
      networkEntries: net.entryCount,
      imageCount: net.imageCount,
    },
    vision,
    warnings,
  };
}

// summarizeUnderstanding(u) — compact per-page summary for pipeline reports.
export function summarizeUnderstanding(u) {
  if (!u) return null;
  const kinds = {};
  for (const c of u.components || []) kinds[c.kind] = (kinds[c.kind] || 0) + 1;
  return {
    components: (u.components || []).length,
    kinds,
    visionUsed: u.vision?.used === true,
    warnings: u.warnings || [],
  };
}

// understandArtifactsDir(artifactsDir, opts) — whole-directory convenience:
// loads a phase-1 artifact directory and understands every page in it.
export async function understandArtifactsDir(artifactsDir, opts = {}) {
  const loaded = loadArtifacts(artifactsDir);
  if (!loaded.ok) return { ok: false, why: "not a phase-1 artifact directory (manifest.json missing)", pages: [] };
  const pages = [];
  for (const lp of loaded.pages) {
    if (!lp.elements) {
      pages.push({ pageId: lp.pageId, url: lp.url, understanding: null, why: "no dom evidence" });
      continue;
    }
    const understanding = await buildUnderstandingPage(pageArtifactsFromLoaded(lp, artifactsDir), opts);
    pages.push({ pageId: lp.pageId, url: lp.url, understanding });
  }
  return { ok: true, pages, missing: loaded.missing, malformed: loaded.malformed };
}
