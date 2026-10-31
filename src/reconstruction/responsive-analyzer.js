// Responsive reconstruction (task 3.4.7): infer breakpoint-driven layout rules
// from CAPTURED per-viewport element evidence instead of a single desktop
// snapshot, and emit CSS media queries keyed to breakpoints derived BETWEEN the
// observed viewport widths (never arbitrary framework defaults).
//
// Evidence sources (both normalize into the same per-viewport element-set shape
// that inferResponsiveRules(sets, opts) consumes):
//  - pages/<pageId>/responsive.json — written by the exploration pipeline for the
//    FIRST explored page only (src/pipeline/exploration-pipeline.js:172-181) and
//    only for the NON-primary policy viewports (viewports.slice(1) — tablet +
//    mobile, exploration-pipeline.js:173). Its geometry holds top-level container
//    fingerprints only (src/assets/asset-manifest.js:66-75: cls/w/h/display/
//    flexDirection/gridCols — no child geometry, no x/y), so this path detects
//    display flips / width / grid changes for matched containers; the primary
//    (desktop) viewport evidence comes from dom.json (loadResponsiveEvidence).
//  - capturePerViewportEvidence(page, viewports) — richer Playwright-side capture
//    (per-element display/rect/class/parent/testid, including display:none
//    subtrees) for callers that can drive a browser. This is the evidence path
//    the e2e test uses for reorder + collapsed-nav detection, which the pipeline
//    responsive.json cannot express.
//
// Uncertainty contract (hard):
//  - fewer than 2 viewports of evidence → NO media queries at all;
//  - elements not matched across viewports (or matched ambiguously) produce no
//    rules — they are reported in `unmatched`;
//  - a changed state with no wider base observation to bracket it (change holds
//    at every observed width) gets no breakpoint — reported in `notes`;
//  - elements hidden at the base viewport are absent from dom.json (the DOM
//    extractor skips sub-2px boxes, src/intelligence/dom-extractor.js:19), so a
//    show-flip is only emitted when the element resolves to a captured clone
//    element (.cx-N); otherwise it is recorded, never fabricated.
//
// Mobile-specific mapping (ask step 2): a collapsed navigation (hamburger) whose
// trigger control is captured is mapped onto the runtime's EXISTING sidebar
// wiring (src/runtimeTemplate.js:276-285 — data-testid="sidebar-*" toggles the
// inline display of [class*='app-sidebar'] elements): augmentProjectWithResponsive
// stamps the trigger with data-testid="sidebar-nav-toggle", adds the app-sidebar
// class token to the collapsible menu, and ships runtime/responsive.js, which
// keeps the menu hidden by INLINE display inside its breakpoint band so the
// existing runtime toggle can reveal and re-hide it. Hidden sidebars are
// reported in `sidebars` with the same wiring note (the runtime's close/toggle
// handlers already target [class*='sidebar'] — src/runtimeTemplate.js:159,271).
import fs from "node:fs";
import path from "node:path";
import { DEFAULT_POLICY } from "../exploration/exploration-policy.js";

// width-change guardrails: an element counts as discretely resized (vs fluid
// scaling with the viewport) when its width ratio deviates from the viewport
// ratio by >= 30%, and the step differs from the previously emitted value by
// > 8px. Fluid containers (width tracking the viewport) never emit rules.
export const WIDTH_DEVIATION = 0.3;
export const WIDTH_MIN_DELTA = 8;

const MAX_CAPTURE_ELEMENTS = 400;
const MAX_CAPTURE_DEPTH = 5;

// ---------- element identity (stable across viewports) ----------

const normTag = (tag) => String(tag || "").toLowerCase().trim() || "*";

const classTokens = (cls) => String(cls || "").trim().split(/\s+/).filter(Boolean);

// Cross-viewport identity: "tag.token1.token2..." with the class tokens sorted
// so "sidebar container" and "container sidebar" match. Elements without a tag
// (responsive.json containers) get "*" and are matched via tokenSetKey.
export function keyOf(tag, cls) {
  const toks = [...new Set(classTokens(cls))].sort();
  return normTag(tag) + "." + toks.join(".");
}

const tokenSetKey = (cls) => "*." + [...new Set(classTokens(cls))].sort().join(".");

// ---------- rich per-viewport capture (Playwright side) ----------

// capturePerViewportEvidence(page, viewports) → per-viewport element sets.
// Runs the SAME normalization as the pipeline evidence: { viewport, width,
// height, elements: [{ key, tag, cls, display, rect, text, id, testid, role,
// parentKey, gridTemplateColumns, flexDirection }] }.
// Unlike the DOM extractor (dom-extractor.js:19 skips sub-2px boxes) this
// capture RECORDS display:none elements (without descending into them) so that
// hide/show flips are observable at every viewport.
export async function capturePerViewportEvidence(page, viewports, opts = {}) {
  const waitMs = opts.waitMs ?? 650;
  const original = page.viewportSize();
  const sets = [];
  try {
    for (const vp of viewports) {
      await page.setViewportSize({ width: vp.width, height: vp.height });
      await page.waitForTimeout(waitMs); // reflow + media-query re-evaluation
      const raw = await page.evaluate(() => {
        const MAX = 400, MAX_DEPTH = 5;
        const out = [];
        const walk = (el, depth, parentIdx) => {
          if (out.length >= MAX || depth > MAX_DEPTH) return;
          const tag = el.tagName.toLowerCase();
          if (["script", "style", "link", "meta", "noscript", "head", "template"].includes(tag)) return;
          const r = el.getBoundingClientRect();
          const cs = getComputedStyle(el);
          const rec = {
            parentIdx,
            tag,
            cls: String(el.getAttribute("class") || "").trim().slice(0, 80),
            display: cs.display,
            rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
            text: el.children.length === 0 ? String(el.innerText || "").trim().slice(0, 60) : "",
            id: el.id || null,
            testid: el.getAttribute("data-testid"),
            role: el.getAttribute("role"),
            gridTemplateColumns: cs.display.includes("grid") ? cs.gridTemplateColumns : null,
            flexDirection: cs.display.includes("flex") ? cs.flexDirection : null,
          };
          const idx = out.push(rec) - 1;
          if (cs.display !== "none") for (const child of el.children) walk(child, depth + 1, idx);
        };
        for (const child of document.body.children) walk(child, 1, -1);
        return { innerWidth, innerHeight, elements: out };
      }).catch(() => null);
      if (!raw) continue;
      // resolve keys + parent keys in Node (single source of truth for keyOf)
      const keys = raw.elements.map((el) => keyOf(el.tag, el.cls));
      sets.push({
        viewport: vp.name || String(vp.width),
        width: vp.width,
        height: vp.height,
        innerWidth: raw.innerWidth,
        innerHeight: raw.innerHeight,
        elements: raw.elements.map((el, i) => ({
          key: keys[i],
          tag: el.tag,
          cls: el.cls,
          display: el.display,
          rect: el.rect,
          text: el.text,
          id: el.id,
          testid: el.testid,
          role: el.role,
          gridTemplateColumns: el.gridTemplateColumns,
          flexDirection: el.flexDirection,
          parentKey: el.parentIdx >= 0 && el.parentIdx < keys.length ? keys[el.parentIdx] : null,
        })),
      });
    }
  } finally {
    if (original) await page.setViewportSize({ width: original.width, height: original.height }).catch(() => {});
  }
  return sets;
}

// ---------- pipeline evidence: dom.json (primary) + responsive.json (slice(1)) ----------

// loadResponsiveEvidence(artifactsDir, pageId) → { sets, source }.
// The base (widest) set is built from dom.json (captured at the policy's primary
// viewport); the narrower sets come from pages/<pageId>/responsive.json captures.
// Honest limitation carried in `source.limitation`: responsive.json exists for
// the FIRST explored page only and covers only the non-primary viewports.
export function loadResponsiveEvidence(artifactsDir, pageId, opts = {}) {
  const primary = opts.primaryViewport || DEFAULT_POLICY.viewports.find((v) => v.primary) || DEFAULT_POLICY.viewports[0];
  const source = {
    domJson: null,
    responsive: null,
    primaryViewport: { name: primary.name, width: primary.width, height: primary.height },
    limitation:
      "responsive.json is written for the first explored page only and only for the non-primary viewports " +
      "(src/pipeline/exploration-pipeline.js:172-181 viewports.slice(1)); the primary viewport's element " +
      "evidence comes from dom.json, and responsive.json geometry has no child geometry/parent links, so " +
      "reorder + collapsed-nav detection need capturePerViewportEvidence (src/assets/asset-manifest.js:66-75)",
  };
  let dom = null;
  try { dom = JSON.parse(fs.readFileSync(path.join(artifactsDir, "pages", pageId, "dom.json"), "utf8")); } catch {}
  source.domJson = !!dom && Array.isArray(dom.elements);
  const sets = [];
  if (source.domJson) {
    const els = dom.elements;
    const keys = els.map((e) => keyOf(e?.tag, e?.cls));
    sets.push({
      viewport: primary.name || "desktop",
      width: primary.width,
      height: primary.height,
      primary: true,
      elements: els.filter(Boolean).map((e, i) => ({
        key: keys[i],
        tag: e.tag || "*",
        cls: e.cls || "",
        display: (e.layout && e.layout.display) || "block",
        rect: e.rect || null,
        text: e.text || "",
        id: e.id || null,
        testid: null, // dom.json does not capture data-testid
        role: e.role || null,
        gridTemplateColumns: (e.layout && e.layout.gridTemplateColumns) || null,
        flexDirection: (e.layout && e.layout.flexDirection) || null,
        parentKey: Number.isInteger(e.parent) && e.parent >= 0 && e.parent < keys.length ? keys[e.parent] : null,
      })),
    });
  }
  let responsive = null;
  try { responsive = JSON.parse(fs.readFileSync(path.join(artifactsDir, "pages", pageId, "responsive.json"), "utf8")); } catch {}
  if (responsive && Array.isArray(responsive.captures)) {
    source.responsive = responsive.captures.map((c) => ({ viewport: c.viewport, width: c.width, containers: (c.geometry?.containers || []).length }));
    for (const cap of responsive.captures) {
      if (!cap.geometry || !Array.isArray(cap.geometry.containers)) continue;
      sets.push({
        viewport: cap.viewport || String(cap.width),
        width: cap.width,
        height: cap.height,
        elements: cap.geometry.containers.map((c) => ({
          // no tag in the responsive capture — matched via the class token set
          key: keyOf("*", c.cls),
          tag: "*",
          cls: c.cls || "",
          display: c.display || "block",
          rect: { x: null, y: null, w: c.w, h: c.h },
          text: "",
          id: null,
          testid: null,
          role: null,
          gridTemplateColumns: c.gridCols || null,
          flexDirection: c.flexDirection || null,
          parentKey: null,
        })),
      });
    }
  }
  return { sets, source };
}

// buildDomIndex(artifactsDir, pageId) → Map<key, { i, root } | null>.
// null marks an ambiguous key (several dom.json elements share it) — no .cx-N
// selector may be derived for it. root = the element is a direct body child
// (its base CSS comes from layout.css "body > .cx-N", so media rules must use
// the same selector shape to win the cascade).
export function buildDomIndex(artifactsDir, pageId) {
  const map = new Map();
  let dom = null;
  try { dom = JSON.parse(fs.readFileSync(path.join(artifactsDir, "pages", pageId, "dom.json"), "utf8")); } catch { return map; }
  for (const e of dom.elements || []) {
    if (!e || typeof e.i !== "number") continue;
    const key = keyOf(e.tag, e.cls);
    if (map.has(key)) map.set(key, null); // ambiguous — first-class selectors only
    else map.set(key, { i: e.i, root: e.parent === null || e.parent === undefined });
  }
  return map;
}

// selectorFor(key, baseEl, domIndex) → clone CSS selector for an element, or
// null. Precise .cx-N when the key resolves in dom.json; falls back to the
// first captured class token (renderNode keeps exactly that token,
// src/reconstruction/generation/project-generator.js:58).
export function selectorFor(key, baseEl, domIndex) {
  const hit = domIndex instanceof Map ? domIndex.get(key) : undefined;
  if (hit && typeof hit === "object") return hit.root ? "body > .cx-" + hit.i : ".cx-" + hit.i;
  const first = classTokens(baseEl?.cls)[0];
  return first ? "." + first : null;
}

// ---------- breakpoint derivation (pure) ----------

// breakpointBetween(changedWidths, baseWidths): the widest observed viewport
// where the CHANGED state holds and the next wider observation of the base
// state bracket the true breakpoint; its midpoint (floored) is the media-query
// boundary. Never returns a value at or beyond an observed width, and never
// invents a width that was not observed on either side.
export function breakpointBetween(changedWidths, baseWidths) {
  const changed = (changedWidths || []).filter((w) => Number.isFinite(w));
  const bases = (baseWidths || []).filter((w) => Number.isFinite(w));
  if (!changed.length) return null;
  const widestChanged = Math.max(...changed);
  const above = bases.filter((w) => w > widestChanged);
  if (!above.length) return null; // no wider base observation — cannot place a breakpoint
  const next = Math.min(...above);
  return { maxWidth: Math.floor((widestChanged + next) / 2), between: [widestChanged, next] };
}

// ---------- inference core (pure over per-viewport element sets) ----------

const SIDEBAR_TOKENS = ["sidebar", "sidepanel", "aside", "appsidebar"];
const NAVMENU_TOKENS = ["nav", "menu", "navbar", "navigation", "drawer", "links"];
const TRIGGER_TOKENS = ["toggle", "hamburger", "burger", "bars", "navtoggle", "menutoggle"];

const elTokens = (el) => classTokens(String(el?.cls || "")).map((t) => t.toLowerCase());
const isSidebarEl = (el) =>
  !!el && (el.tag === "aside" || el.role === "complementary" || elTokens(el).some((t) => SIDEBAR_TOKENS.includes(t)));
const isNavMenuEl = (el) =>
  !!el && (el.tag === "nav" || el.role === "navigation" || elTokens(el).some((t) => NAVMENU_TOKENS.includes(t)));

const sameSeq = (a, b) => a.length === b.length && a.every((k, i) => k === b[i]);

// inferResponsiveRules(perViewportElementSets, opts) — the ask's core entry point.
// sets: [{ viewport, width, height, elements: [{ key|tag+cls, display, rect,
//         parentKey?, text?, testid?, role?, gridTemplateColumns? }] }]
// opts: { domIndexByKey?: Map<key, {i, root}|null> } — maps evidence elements to
//         generated clone selectors (.cx-N); class-token fallback otherwise.
// Returns { observedViewports, breakpoints, rules, mediaQueries, mobileNav,
//           sidebars, unmatched, notes }.
export function inferResponsiveRules(sets, opts = {}) {
  const domIndexByKey = opts.domIndexByKey instanceof Map ? opts.domIndexByKey : new Map();
  const notes = [];
  const unmatched = [];
  const rules = [];
  const sorted = [...(sets || [])]
    .filter((s) => s && Array.isArray(s.elements))
    .sort((a, b) => a.width - b.width);
  const observedViewports = sorted.map((s) => ({ name: s.viewport || String(s.width), width: s.width }));
  const baseIdx = sorted.length - 1;
  const baseSet = sorted[baseIdx];

  if (sorted.length < 2) {
    notes.push(
      sorted.length === 1
        ? "only one viewport has evidence — no media queries emitted (uncertainty preserved)"
        : "no usable per-viewport element sets",
    );
    return { observedViewports, breakpoints: [], rules, mediaQueries: [], mobileNav: null, sidebars: [], unmatched, notes };
  }

  // ---- base-viewport index (exact keys + class token-set fallback) ----
  const baseExact = new Map();
  const baseTokens = new Map();
  const ambiguousExact = new Set();
  for (const el of baseSet.elements) {
    const key = keyOf(el.tag, el.cls);
    if (baseExact.has(key)) ambiguousExact.add(key);
    else baseExact.set(key, el);
    const tk = tokenSetKey(el.cls);
    if (!baseTokens.has(tk)) baseTokens.set(tk, new Map());
    const m = baseTokens.get(tk);
    if (!m.has(key)) m.set(key, el);
  }

  // match a narrow-set element to its base-viewport element
  const matchBase = (el) => {
    const key = keyOf(el.tag, el.cls);
    if (normTag(el.tag) !== "*") {
      if (ambiguousExact.has(key)) return { key, el: null, why: "ambiguous in base viewport" };
      const hit = baseExact.get(key);
      return hit ? { key, el: hit } : { key, el: null, why: "no base-viewport match" };
    }
    // tag-less entries (responsive.json containers) match by class token set
    const cands = baseTokens.get(tokenSetKey(el.cls));
    if (!cands || cands.size !== 1) {
      return { key, el: null, why: cands && cands.size > 1 ? "ambiguous token set" : "no base-viewport match" };
    }
    const [k, e] = [...cands.entries()][0];
    return { key: k, el: e };
  };

  // ---- cross-viewport observations: baseKey → { base, perSet: Map<setIdx, el> } ----
  const obs = new Map();
  for (let si = 0; si < baseIdx; si++) {
    const set = sorted[si];
    const counts = new Map();
    for (const el of set.elements) {
      const k = keyOf(el.tag, el.cls);
      counts.set(k, (counts.get(k) || 0) + 1);
    }
    for (const el of set.elements) {
      const k = keyOf(el.tag, el.cls);
      if ((counts.get(k) || 0) > 1) {
        if (!unmatched.some((u) => u.key === k)) unmatched.push({ key: k, viewport: set.viewport, why: "ambiguous within this viewport" });
        continue;
      }
      const m = matchBase(el);
      if (!m.el) {
        if (!unmatched.some((u) => u.key === k)) unmatched.push({ key: k, viewport: set.viewport, why: m.why });
        continue;
      }
      if (!obs.has(m.key)) obs.set(m.key, { base: m.el, perSet: new Map() });
      obs.get(m.key).perSet.set(si, el);
    }
  }

  let ruleId = 0;
  const mkRule = (kind, bp, key, baseEl, props, observedAt, baseAt) => {
    const selector = selectorFor(key, baseEl, domIndexByKey);
    const propsText = Object.entries(props).map(([p, v]) => `${p}: ${v}`).join("; ");
    return {
      id: "r" + ++ruleId,
      kind,
      band: bp.maxWidth,
      between: bp.between,
      key,
      selector,
      props,
      propsText,
      evidence: { observedAt, baseAt },
    };
  };

  // ---- 1) display flips (hide/show) ----
  for (const [key, o] of obs) {
    const bDisp = o.base.display || "block";
    const entries = [...o.perSet.entries()];
    const hiddenAt = entries.filter(([, e]) => e.display === "none").map(([si]) => sorted[si].width);
    const shownEntries = entries.filter(([, e]) => e.display && e.display !== "none");
    const shownAt = shownEntries.map(([si]) => sorted[si].width);
    if (bDisp !== "none" && hiddenAt.length) {
      const bp = breakpointBetween(hiddenAt, [...shownAt, baseSet.width]);
      if (!bp) {
        notes.push(`display change of "${key}" holds at every observed width — no wider base observation to bracket a breakpoint; skipped`);
        continue;
      }
      rules.push(mkRule("display-flip", bp, key, o.base, { display: "none" }, hiddenAt, [...shownAt, baseSet.width]));
    } else if (bDisp === "none" && shownAt.length) {
      const bp = breakpointBetween(shownAt, hiddenAt);
      if (!bp) continue;
      // hidden at the base capture ⇒ almost certainly absent from dom.json ⇒ the
      // clone does not contain the element; only emit when a .cx-N selector exists
      const hit = domIndexByKey.get(key);
      if (!hit || typeof hit !== "object") {
        unmatched.push({ key, why: "shown only at narrower viewports but hidden at the base capture — element is not in the clone DOM; recorded, no rule emitted" });
        continue;
      }
      rules.push(mkRule("display-flip-reverse", bp, key, o.base, { display: shownEntries[0][1].display || "block" }, shownAt, hiddenAt));
    }
  }

  // ---- 2) discrete width changes (step function: widest → narrowest) ----
  for (const [key, o] of obs) {
    const bw = o.base.rect && Number.isFinite(o.base.rect.w) ? o.base.rect.w : null;
    if (!bw || bw < 8) continue;
    const pts = [...o.perSet.entries()]
      .filter(([, e]) => e.display !== "none" && e.rect && Number.isFinite(e.rect.w) && e.rect.w > 0)
      .map(([si, e]) => ({ vw: sorted[si].width, w: e.rect.w }))
      .sort((a, b) => b.vw - a.vw); // widest observed first
    let last = bw;
    for (const p of pts) {
      const vwRatio = p.vw / baseSet.width;
      const elRatio = p.w / bw;
      const dev = vwRatio > 0 ? Math.abs(elRatio / vwRatio - 1) : 0;
      if (dev >= WIDTH_DEVIATION && Math.abs(p.w - last) > WIDTH_MIN_DELTA) {
        const widerObserved = [...o.perSet.entries()].filter(([si]) => sorted[si].width > p.vw).map(([si]) => sorted[si].width);
        const bp = breakpointBetween([p.vw], [...widerObserved, baseSet.width]);
        if (bp) rules.push(mkRule("width", bp, key, o.base, { width: p.w + "px" }, [p.vw], [...widerObserved, baseSet.width]));
        last = p.w; // step baseline for the next narrower width
      }
    }
  }

  // ---- 3) grid template changes ----
  for (const [key, o] of obs) {
    const baseCols = o.base.gridTemplateColumns;
    if (!baseCols || baseCols === "none") continue;
    for (const [si, e] of o.perSet) {
      if (e.display === "none") continue;
      const cols = e.gridTemplateColumns;
      if (!cols || cols === baseCols) continue;
      const widerObserved = [...o.perSet.entries()].filter(([j]) => sorted[j].width > sorted[si].width).map(([j]) => sorted[j].width);
      const bp = breakpointBetween([sorted[si].width], [...widerObserved, baseSet.width]);
      if (bp) rules.push(mkRule("grid-change", bp, key, o.base, { "grid-template-columns": cols }, [sorted[si].width], [...widerObserved, baseSet.width]));
      break; // one grid rule per band direction is enough — narrower bands override
    }
  }

  // ---- 4) reorder: visual child-order change inside a container ----
  for (const [ckey, co] of obs) {
    if (co.base.display === "none") continue;
    // per-set child sequences (only matched children of this container)
    const seqs = new Map();
    for (let si = 0; si <= baseIdx; si++) {
      const containerEl = si === baseIdx ? co.base : co.perSet.get(si);
      if (!containerEl || containerEl.display === "none") continue;
      const kids = [];
      for (const el of sorted[si].elements) {
        if (el.parentKey !== ckey) continue;
        // hidden children have no meaningful position (0×0 rect) — their
        // hide/show is owned by display-flip rules, never by order rules
        if (el.display === "none") continue;
        const k = keyOf(el.tag, el.cls);
        const childObs = obs.get(k);
        if (!childObs || childObs.base.parentKey !== ckey) continue;
        kids.push({ k, el });
      }
      if (kids.length < 2) continue;
      const xs = kids.map((x) => x.el.rect?.x).filter(Number.isFinite);
      const ys = kids.map((x) => x.el.rect?.y).filter(Number.isFinite);
      if (xs.length !== kids.length || ys.length !== kids.length) continue; // geometry missing (responsive.json path)
      const horizontal = Math.max(...ys) - Math.min(...ys) <= 8;
      kids.sort((a, b) => (horizontal ? a.el.rect.x - b.el.rect.x : a.el.rect.y - b.el.rect.y));
      seqs.set(si, kids.map((x) => x.k));
    }
    const baseSeq = seqs.get(baseIdx);
    if (!baseSeq) continue;
    const baseKeySet = [...baseSeq].sort().join("|");
    const changedAt = [];
    const baseAt = [baseSet.width];
    let narrowEntry = null;
    for (const [si, seq] of seqs) {
      if (si === baseIdx) continue;
      if ([...seq].sort().join("|") !== baseKeySet) continue; // different children observed — not comparable
      if (sameSeq(seq, baseSeq)) baseAt.push(sorted[si].width);
      else { changedAt.push(sorted[si].width); if (!narrowEntry) narrowEntry = seq; }
    }
    if (!changedAt.length || !narrowEntry) continue;
    const bp = breakpointBetween(changedAt, baseAt);
    if (!bp) {
      notes.push(`child order change inside "${ckey}" holds at every observed width — no breakpoint bracket; skipped`);
      continue;
    }
    // emit an explicit total order for every child (order only affects flex/grid
    // items — the base components.css keeps the container's captured display)
    for (let idx = 0; idx < narrowEntry.length; idx++) {
      const childObs = obs.get(narrowEntry[idx]);
      rules.push(mkRule("reorder", bp, narrowEntry[idx], childObs.base, { order: idx }, changedAt, baseAt));
    }
  }

  // ---- 5) mobile-specific behaviors: hidden sidebars + collapsed navigation ----
  const sidebars = [];
  for (const r of rules) {
    if (r.kind !== "display-flip") continue;
    const el = obs.get(r.key)?.base;
    if (!el || !isSidebarEl(el)) continue;
    const hasSidebarControl = [...baseSet.elements].some((e) => String(e.testid || "").startsWith("sidebar-"));
    sidebars.push({
      key: r.key,
      selector: r.selector,
      hiddenBelow: r.band,
      between: r.between,
      observedAt: r.evidence.observedAt,
      wiredByRuntime: hasSidebarControl,
      runtimeWiring:
        "the clone runtime's existing app-panel handlers already manage [class*='sidebar'] / .app-sidebar elements " +
        "(src/runtimeTemplate.js:159, 271, 277); a source control marked data-testid='sidebar-*' keeps working on it. " +
        "Width-driven hiding stays in CSS media queries (styles/responsive.css).",
    });
  }

  let mobileNav = null;
  for (const r of rules) {
    if (r.kind !== "display-flip") continue;
    const menuEl = obs.get(r.key)?.base;
    if (!menuEl || !isNavMenuEl(menuEl)) continue;
    // trigger search among base-viewport elements (must exist in the clone)
    let trigger = null;
    for (const el of baseSet.elements) {
      if (el === menuEl || (el.display || "block") === "none") continue;
      const toks = elTokens(el);
      const testid = String(el.testid || "");
      let rank = 0;
      if (testid.startsWith("sidebar-")) rank = 3;
      else if (toks.some((t) => TRIGGER_TOKENS.includes(t))) rank = 2;
      else if (/^(menu|☰|hamburger)/i.test(String(el.text || "").trim()) && ["button", "a"].includes(el.tag)) rank = 1;
      if (rank > (trigger ? trigger.rank : 0)) trigger = { el, rank };
    }
    if (!trigger) {
      notes.push(`nav menu "${r.key}" collapses at ${r.evidence.observedAt.join("/")}px but no toggle control was captured — collapse emitted as CSS-only`);
      continue;
    }
    const tkey = keyOf(trigger.el.tag, trigger.el.cls);
    if (ambiguousExact.has(tkey) || !baseExact.has(tkey)) continue;
    const domIdx = (k) => {
      const hit = domIndexByKey.get(k);
      return hit && typeof hit === "object" ? hit.i : null;
    };
    const sourceTestid = String(trigger.el.testid || "");
    mobileNav = {
      kind: "hamburger-collapse",
      band: r.band,
      between: r.between,
      menu: { key: r.key, selector: r.selector, cls: menuEl.cls || "", domIndex: domIdx(r.key) },
      trigger: {
        key: tkey,
        selector: selectorFor(tkey, trigger.el, domIndexByKey),
        cls: trigger.el.cls || "",
        text: trigger.el.text || "",
        testid: sourceTestid || null,
        testidAssigned: sourceTestid.startsWith("sidebar-") ? null : "sidebar-nav-toggle",
        domIndex: domIdx(tkey),
      },
      wiredByRuntime: sourceTestid.startsWith("sidebar-"),
      runtimeWiring:
        "mapped onto the clone runtime's existing sidebar toggle (data-testid='sidebar-*' swaps inline display of " +
        "[class*='app-sidebar'] elements — src/runtimeTemplate.js:276-285). The menu is hidden by INLINE display " +
        "inside its band (runtime/responsive.js) so that toggle can reveal and re-hide it; its CSS display-flip " +
        "rule is therefore excluded from styles/responsive.css.",
      observedAt: r.evidence.observedAt,
    };
    r.runtimeWired = true; // responsiveCss() excludes runtime-wired rules by default
    break;
  }

  // ---- assemble: breakpoints + media queries keyed by derived bands ----
  const breakpoints = [];
  const seenBp = new Set();
  for (const r of rules) {
    if (seenBp.has(r.band)) continue;
    seenBp.add(r.band);
    breakpoints.push({ maxWidth: r.band, between: r.between });
  }
  breakpoints.sort((a, b) => b.maxWidth - a.maxWidth);

  return { observedViewports, breakpoints, rules, mediaQueries: mediaQueriesOf(rules), mobileNav, sidebars, unmatched, notes };
}

// mediaQueriesOf(rules): CSS media-query blocks keyed by band, wider bands
// first so narrower bands override them in the cascade.
export function mediaQueriesOf(rules) {
  const bands = new Map();
  for (const r of rules) {
    if (!bands.has(r.band)) bands.set(r.band, []);
    bands.get(r.band).push(r);
  }
  const out = [];
  for (const bp of [...bands.keys()].sort((a, b) => b - a)) {
    const bandRules = bands
      .get(bp)
      .slice()
      .sort((a, b) => (a.selector + "|" + a.propsText).localeCompare(b.selector + "|" + b.propsText));
    const css =
      `@media (max-width: ${bp}px) {\n` +
      bandRules.map((r) => `  ${r.selector} { ${r.propsText}; } /* ${r.kind}: observed at ${r.evidence.observedAt.join("px, ")}px */`).join("\n") +
      `\n}`;
    out.push({ maxWidth: bp, rules: bandRules.map((r) => r.id), css });
  }
  return out;
}

// ---------- CSS emission ----------

// responsiveCss(analysis, opts) → the styles/responsive.css text.
// Runtime-wired rules (the collapsed nav menu owned by the runtime's sidebar
// toggle + runtime/responsive.js) are excluded unless opts.includeRuntimeWired.
export function responsiveCss(analysis, opts = {}) {
  const widths = (analysis.observedViewports || []).map((v) => v.width).sort((a, b) => a - b);
  const lines = [
    "/* responsive reconstruction (task 3.4.7) — inferred from captured per-viewport evidence */",
    `/* observed viewport widths: ${widths.join(", ")}px — breakpoints derived between observed widths, never arbitrary */`,
  ];
  const rules = (analysis.rules || []).filter((r) => opts.includeRuntimeWired || !r.runtimeWired);
  if (!rules.length) {
    lines.push("/* no breakpoint evidence to emit — single-viewport captures produce no media queries */");
    return lines.join("\n") + "\n";
  }
  const mqs = mediaQueriesOf(rules);
  for (const mq of mqs) {
    const between = (analysis.breakpoints || []).find((b) => b.maxWidth === mq.maxWidth)?.between || [];
    lines.push("");
    lines.push(`/* breakpoint ${between[0]}px ↔ ${between[1]}px — midpoint between observed widths */`);
    lines.push(...mq.css.split("\n"));
  }
  return lines.join("\n") + "\n";
}

// ---------- one-call integration helpers ----------

// buildResponsiveCss(artifactsDir, pageId, opts) — pipeline-facing entry point:
// load the pipeline's per-viewport evidence (dom.json + responsive.json) and
// infer the responsive rules. Returns { analysis, css, source }.
export function buildResponsiveCss(artifactsDir, pageId, opts = {}) {
  const { sets, source } = loadResponsiveEvidence(artifactsDir, pageId, opts);
  const domIndexByKey = buildDomIndex(artifactsDir, pageId);
  const analysis = inferResponsiveRules(opts.sets || sets, { domIndexByKey, ...opts });
  return { analysis, css: responsiveCss(analysis), source };
}

// runtime/responsive.js bootstrap — keeps runtime-wired elements hidden by
// INLINE display inside their breakpoint band. The inline state is exactly what
// the existing runtime sidebar toggle swaps (runtimeTemplate.js:280), so the
// captured hamburger reveals and re-hides the collapsed menu with no new
// click-handling code.
function bootstrapScript(wired) {
  return `// runtime/responsive.js — responsive reconstruction bootstrap (task 3.4.7).
// Keeps the mobile-collapsed navigation hidden by INLINE display inside its
// breakpoint band so the runtime's existing sidebar toggle (data-testid="sidebar-*"
// → swaps inline display of [class*='app-sidebar'] elements) can reveal and
// re-hide it. Generated by src/reconstruction/responsive-analyzer.js.
(function () {
  var WIRED = ${JSON.stringify(wired)};
  function apply() {
    for (var i = 0; i < WIRED.length; i++) {
      var w = WIRED[i];
      if (!window.matchMedia) break;
      var m = window.matchMedia("(max-width:" + w.bp + "px)");
      var els = document.querySelectorAll(w.sel);
      for (var k = 0; k < els.length; k++) {
        if (m.matches) { if (els[k].style.display !== "none") els[k].style.display = "none"; }
        else if (els[k].style.display === "none") els[k].style.display = "";
      }
    }
  }
  apply();
  window.addEventListener("resize", apply);
})();`;
}

// editTagAttrs(html, cxIndex, mutate): locate the generated tag whose class
// carries cx-<cxIndex> and rewrite it via mutate(tagString) → tagString.
function editTagAttrs(html, cxIndex, mutate) {
  const m = new RegExp("cx-" + cxIndex + '(?=[" ])').exec(html);
  if (!m) return null;
  const start = html.lastIndexOf("<", m.index);
  const end = html.indexOf(">", m.index);
  if (start < 0 || end < 0 || end <= start) return null;
  const next = mutate(html.slice(start, end + 1));
  if (next === null || next === html.slice(start, end + 1)) return html;
  return html.slice(0, start) + next + html.slice(end + 1);
}

const dropReplayAttrs = (tag) => tag.replace(/\s(?:data-cloner-trigger|data-replay-id)="[^"]*"/g, "");

function addClassToken(tag, token) {
  const m = tag.match(/class="([^"]*)"/);
  if (!m) return tag;
  if (m[1].split(/\s+/).includes(token)) return tag;
  return tag.replace(m[0], `class="${m[1]} ${token}"`);
}

function addAttr(tag, name, value) {
  if (new RegExp(`\\s${name}="`).test(tag)) return tag;
  const m = tag.match(/class="[^"]*"/);
  if (!m) return tag + ` ${name}="${value}"`;
  return tag.replace(m[0], m[0] + ` ${name}="${value}"`);
}

// augmentProjectWithResponsive(outDir, analysis, opts) — applies the inferred
// responsive rules to a GENERATED project (the one-call integration hook for
// reconstructFromArtifacts):
//   1. writes styles/responsive.css (media queries keyed by derived breakpoints),
//   2. links it AFTER styles/components.css in every generated page (the
//      responsive layer must cascade after the desktop geometry that
//      buildComponentCss bakes per element — see generation/project-generator.js:46-50),
//   3. when a collapsed navigation with a captured trigger was detected, maps it
//      onto the runtime's existing sidebar wiring (data-testid="sidebar-nav-toggle"
//      on the trigger + app-sidebar class token on the menu + runtime/responsive.js
//      inline-display bootstrap) and strips the trigger's recorded overlay-replay
//      attrs/record so the two wirings cannot conflict.
// opts: { pages: ["index.html", ...] } — generated files to augment.
// Returns { applied, cssFile, linkInjected, wired, wiredTrigger, wiredMenu,
//           recordsStripped, files, notes }.
export function augmentProjectWithResponsive(outDir, analysis, opts = {}) {
  const pages = opts.pages || ["index.html"];
  const notes = [];
  const result = { applied: false, cssFile: null, linkInjected: 0, wired: false, wiredTrigger: null, wiredMenu: null, recordsStripped: 0, files: [], notes };
  const rules = analysis?.rules || [];
  if (!rules.length && !analysis?.mobileNav) {
    notes.push("no breakpoint evidence — nothing written (uncertainty preserved)");
    return result;
  }
  const css = responsiveCss(analysis);
  fs.mkdirSync(path.join(outDir, "styles"), { recursive: true });
  fs.writeFileSync(path.join(outDir, "styles", "responsive.css"), css);
  result.applied = true;
  result.cssFile = "styles/responsive.css";

  // ---- runtime wiring for the collapsed navigation (ask step 2) ----
  const mn = analysis.mobileNav;
  let bootstrap = null;
  if (mn && mn.trigger?.selector && mn.menu?.selector && mn.trigger.domIndex !== null && mn.menu.domIndex !== null) {
    result.wired = true;
    result.wiredTrigger = mn.trigger.selector;
    result.wiredMenu = mn.menu.selector;
    bootstrap = bootstrapScript([{ sel: mn.menu.selector, bp: mn.band }]);
    fs.mkdirSync(path.join(outDir, "runtime"), { recursive: true });
    fs.writeFileSync(path.join(outDir, "runtime", "responsive.js"), bootstrap);
  } else if (mn) {
    notes.push("collapsed nav detected but trigger/menu did not resolve to captured clone elements — CSS-only collapse");
  }

  for (const rel of pages) {
    const fp = path.join(outDir, rel);
    if (!fs.existsSync(fp)) continue;
    let html = fs.readFileSync(fp, "utf8");
    const before = html;
    // 1) stylesheet link after components.css (cascade: responsive last)
    if (!html.includes("styles/responsive.css")) {
      const link = '<link rel="stylesheet" href="styles/responsive.css">';
      if (html.includes('<link rel="stylesheet" href="styles/components.css">')) {
        html = html.replace(
          '<link rel="stylesheet" href="styles/components.css">',
          '<link rel="stylesheet" href="styles/components.css">\n  ' + link,
        );
      } else if (html.includes("</head>")) {
        html = html.replace("</head>", "  " + link + "\n</head>");
      }
      result.linkInjected++;
    }
    // 2) collapsed-nav wiring on the generated elements
    if (bootstrap) {
      const tBefore = html;
      html = editTagAttrs(html, mn.trigger.domIndex, (tag) => addAttr(dropReplayAttrs(tag), "data-testid", mn.trigger.testidAssigned || mn.trigger.testid || "sidebar-nav-toggle"));
      html = editTagAttrs(html, mn.menu.domIndex, (tag) => addClassToken(tag, "app-sidebar"));
      if (html !== tBefore) {
        if (!html.includes("runtime/responsive.js")) {
          html = html.replace(
            '<script src="runtime/interactions.js"></script>',
            '<script src="runtime/interactions.js"></script>\n  <script src="runtime/responsive.js"></script>',
          );
        }
      } else {
        notes.push(`wiring targets not found in ${rel} — trigger/menu cx elements missing`);
      }
    }
    if (html !== before) {
      fs.writeFileSync(fp, html);
      result.files.push(rel);
    }
  }

  // 3) strip the wired trigger's recorded overlay-replay record: findRec would
  //    otherwise hijack the click (structural path/text signature) and open a
  //    recorded overlay instead of letting the runtime's sidebar toggle fire
  if (bootstrap && mn.trigger.domIndex !== null) {
    const runtimePath = path.join(outDir, "runtime", "interactions.js");
    try {
      const src = fs.readFileSync(runtimePath, "utf8");
      const m = src.match(/^window\.__CLONER_INTERACTIONS = (.*);$/m);
      if (m) {
        const recs = JSON.parse(m[1]);
        const kept = recs.filter((r) => r.domIndex !== mn.trigger.domIndex);
        if (kept.length !== recs.length) {
          fs.writeFileSync(runtimePath, src.replace(m[0], "window.__CLONER_INTERACTIONS = " + JSON.stringify(kept) + ";"));
          result.recordsStripped = recs.length - kept.length;
        }
      }
    } catch (e) {
      notes.push("replay-record strip skipped: " + String(e?.message || e).slice(0, 80));
    }
  }
  return result;
}
