// Per-section parallel builders with deterministic merge (task G6.7 —
// technique 2 of the ai-website-cloner-claudeskill mapping,
// docs/AI-CLONER-SKILL-INTEGRATION.md).
//
// The external skill dispatches one builder agent per section in parallel git
// worktrees, enforces a ~150-line spec budget per builder (complex sections are
// split into sub-component builders plus a wrapper, sub-components dispatched
// FIRST), and merges each completed branch while build-verifying after every
// merge. Our generation is a single global pass
// (src/reconstruction/generation/project-generator.js buildComponentCss over
// every element at once) — nothing decomposes per section, so there is no
// parallelizable unit, no budget, and no merge step.
//
// This module is the deterministic analogue:
//   - planSectionBuilders: one builder per section (from style-spec.js spec
//     files), the SAME budget rule, sub-component builders + wrapper for
//     over-budget sections with sub-components ordered first, builders' input
//     specs carried inline (the skill's "full spec inline, no guessing").
//   - buildSectionFragment: a builder renders ONLY its own subtree (pure
//     function of its members + shared maps), mirroring the production
//     renderer's conventions exactly (cx-N classes, tag whitelist, wiring
//     attrs — cited line-by-line against project-generator.js renderNode) and
//     reusing the production rule builder buildComponentCss so fragment CSS is
//     byte-identical to the monolithic path per element.
//   - mergeSectionFragments: deterministic merge in dispatch order — wrapper
//     markers filled with sub-component output, lead fragments (elements no
//     section covers, rendered by the "lead" like the skill's foundation
//     phase) interleaved in document order, duplicate-selector conflicts
//     resolved fail-closed (first in dispatch order wins, every conflict
//     recorded — never silently overwritten).
//
// Nested sections (a section root inside another section's member set) are
// excluded from the builder plan and recorded — they are already rendered by
// their container's subtree, so building them again would double-emit. This is
// recorded in the plan, never silently dropped.
//
// Determinism: fragment content is a pure function of (spec, elements, maps);
// ordering is document order / capture order / sectionId — no randomness, no
// wall-clock in any fragment. Nothing here writes into the production clone:
// the merge output is a parallel artifact the pipeline MAY adopt; adopting it
// is an integrator decision, not this module's.

import fs from "node:fs";
import path from "node:path";
import { buildComponentCss } from "../generation/project-generator.js";

// The skill's budget, verbatim: "If a builder prompt exceeds ~150 lines of
// spec content, the section is too complex for one agent."
export const SPEC_COMPLEXITY_BUDGET = 150;
export const MAX_SUB_BUILDERS = 8;
export const MAX_INLINE_SPEC_LINES = 200;

const SELF_CLOSE = new Set(["img", "br", "hr", "input", "meta", "link"]);
const esc = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const TAG_RE = /^(h[1-6]|p|nav|header|footer|main|section|aside|ul|ol|li|form|table|button|a|img|canvas|input|select|label|span|div|article|figure)$/;

const docOrder = (a, b) =>
  (a.rect?.y ?? 0) - (b.rect?.y ?? 0) ||
  (a.rect?.x ?? 0) - (b.rect?.x ?? 0) ||
  String(a.sectionId ?? "").localeCompare(String(b.sectionId ?? ""));

// deterministic complexity estimate: every member costs one HTML line and one
// CSS rule line (buildComponentCss emits one line per element), plus a small
// per-fragment header. Deliberately conservative — the estimate errs toward
// splitting, never toward swallowing a complex section.
export function estimateBuilderLines(spec) {
  const members = (spec?.members || []).length;
  return members * 2 + 4;
}

// ---------------------------------------------------------------------------
// planning
// ---------------------------------------------------------------------------

// planSectionBuilders(specs, opts) → { ok, why, plan }.
// plan: { order: [builderId…], builders: [builder…], nested: [...], budget }.
// Each builder carries its input inline (inlineSpec) — the skill's "builders
// receive the full spec inline".
export function planSectionBuilders(specs, opts = {}) {
  const list = (Array.isArray(specs) ? specs : []).slice().sort(docOrder);
  if (!list.length) return { ok: false, why: "no section specs — nothing to plan", plan: null };
  const budget = Number.isFinite(opts.budget) ? opts.budget : SPEC_COMPLEXITY_BUDGET;
  // parentOf: Map elementIndex → parent element index (dom.json parent links).
  // Required for the over-budget split — a section's direct children among its
  // members are those whose parent is the section root (or outside the spec).
  const parentOf = opts.parentOf instanceof Map ? opts.parentOf : null;

  // nested-section exclusion: a spec whose member set is a subset of another
  // spec's member set is rendered by the container — recorded, not built
  const memberSets = list.map((s) => new Set((s.members || []).map((m) => m.i)));
  const nested = [];
  const top = [];
  for (let i = 0; i < list.length; i++) {
    let container = null;
    for (let j = 0; j < list.length; j++) {
      if (i === j) continue;
      const a = memberSets[i], b = memberSets[j];
      const subset = a.size <= b.size && [...a].every((x) => b.has(x));
      if (!subset) continue;
      // deterministic container: strictly larger set wins; equal-size ties
      // (impossible for strict subsets) fall back to the lower sectionId
      if (b.size > a.size || (b.size === a.size && list[j].sectionId < list[i].sectionId)) {
        if (!container || list[j].sectionId < container) container = list[j].sectionId;
      }
    }
    if (container) nested.push({ sectionId: list[i].sectionId, nestedInto: container, memberCount: (list[i].members || []).length });
    else top.push(list[i]);
  }

  const builders = [];
  const push = (b) => builders.push(b);
  for (const spec of top) {
    const lines = estimateBuilderLines(spec);
    if (lines <= budget) {
      push({
        builderId: `${spec.sectionId}-b0`,
        sectionId: spec.sectionId,
        role: "section",
        memberIndexes: (spec.members || []).map((m) => m.i),
        rootIndex: spec.elementIndex,
        rect: spec.rect,
        sectionRect: spec.rect,
        estimateLines: lines,
        inlineSpec: inlineSpecFor(spec),
      });
      continue;
    }
    // over budget → split into sub-component builders over the root's direct
    // child subtrees (capture order), then a wrapper builder dispatched LAST
    // (the skill: sub-components first, the wrapper imports them)
    const memberIdxAll = (spec.members || []).map((m) => m.i);
    const inSet = new Set(memberIdxAll);
    const childrenOf = new Map(); // member index → member children (parent links)
    for (const i of memberIdxAll) {
      const p = parentOf ? parentOf.get(i) : null;
      const key = p !== null && p !== undefined && inSet.has(p) ? p : spec.elementIndex;
      if (i === spec.elementIndex) continue;
      if (!childrenOf.has(key)) childrenOf.set(key, []);
      childrenOf.get(key).push(i);
    }
    const direct = (childrenOf.get(spec.elementIndex) || []).slice();
    const batches = Math.min(MAX_SUB_BUILDERS, Math.max(2, Math.ceil(lines / budget)));
    const perBatch = Math.max(1, Math.ceil(direct.length / batches));
    let n = 0;
    for (let k = 0; k < direct.length; k += perBatch) {
      const batch = direct.slice(k, k + perBatch);
      const memberIdx = [];
      const collect = (idx) => {
        memberIdx.push(idx);
        for (const c of childrenOf.get(idx) || []) collect(c);
      };
      for (const c of batch) collect(c);
      push({
        builderId: `${spec.sectionId}-sub${n++}`,
        sectionId: spec.sectionId,
        role: "sub-component",
        subIndex: n - 1,
        memberIndexes: memberIdx,
        rootIndexes: batch,
        rect: batchRect(batch, spec),
        sectionRect: spec.rect,
        estimateLines: memberIdx.length * 2 + 2,
        inlineSpec: inlineSpecFor({ ...spec, members: (spec.members || []).filter((m) => memberIdx.includes(m.i)) }),
      });
    }
    push({
      builderId: `${spec.sectionId}-wrap`,
      sectionId: spec.sectionId,
      role: "wrapper",
      memberIndexes: [spec.elementIndex],
      rootIndex: spec.elementIndex,
      rect: spec.rect,
      sectionRect: spec.rect,
      estimateLines: 4,
      inlineSpec: `# ${spec.sectionId} ${spec.kind || "section"} (wrapper) — composes ${n} sub-component builder(s); owns only the section root .cx-${spec.elementIndex}.`,
    });
  }

  // dispatch order: sections in document order; WITHIN a section, the skill's
  // rule — sub-components first, wrapper last (the wrapper imports them)
  const rank = (b) => (b.role === "sub-component" ? 0 : b.role === "section" ? 1 : 2);
  const secOrder = (a, b) =>
    (a.sectionRect?.y ?? 0) - (b.sectionRect?.y ?? 0) ||
    (a.sectionRect?.x ?? 0) - (b.sectionRect?.x ?? 0);
  builders.sort((a, b) =>
    secOrder(a, b) ||
    rank(a) - rank(b) ||
    String(a.builderId).localeCompare(String(b.builderId)));

  return {
    ok: true,
    why: null,
    plan: {
      budget,
      order: builders.map((b) => b.builderId),
      builders,
      nested,
      sections: top.length,
      uncoveredFromSpecs: opts.uncovered ?? null,
    },
  };
}

// batchRect(indexes, spec) — bounding rect of a sub-component batch, from the
// spec's own member records (no external lookups).
function batchRect(indexes, spec) {
  const byIndex = new Map((spec.members || []).map((m) => [m.i, m]));
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const i of indexes) {
    const r = byIndex.get(i)?.rect;
    if (!r) continue;
    x0 = Math.min(x0, r.x); y0 = Math.min(y0, r.y);
    x1 = Math.max(x1, r.x + r.w); y1 = Math.max(y1, r.y + r.h);
  }
  return Number.isFinite(x0) ? { x: x0, y: y0, w: x1 - x0, h: y1 - y0 } : null;
}

// inlineSpecFor(spec) — bounded plain-text builder input: exact captured
// values per member (the skill's "every CSS value in the spec is from
// getComputedStyle, not estimated"). Bounded to MAX_INLINE_SPEC_LINES.
export function inlineSpecFor(spec, maxLines = MAX_INLINE_SPEC_LINES) {
  const lines = [];
  lines.push(`# ${spec.sectionId} ${spec.kind || "section"} — rect ${spec.rect ? `${spec.rect.x},${spec.rect.y} ${spec.rect.w}x${spec.rect.h}` : "?"}${typeof spec.confidence === "number" ? ` (confidence ${spec.confidence})` : ""}`);
  if (spec.truncated) lines.push(`(member list truncated at ${spec.members.length})`);
  for (const m of spec.members || []) {
    if (lines.length >= maxLines) { lines.push(`(${spec.members.length - (maxLines - 2)} more member(s) omitted — read the spec file)`); break; }
    const fc = String(m.cls || "").trim().split(/\s+/)[0] || "";
    lines.push(`- .cx-${m.i} ${m.tag}${fc ? "." + fc : ""} @ ${m.rect?.x ?? "?"},${m.rect?.y ?? "?"} ${m.rect?.w ?? "?"}x${m.rect?.h ?? "?"}`);
    const style = m.style && Object.keys(m.style).length ? m.style : null;
    if (style) lines.push(`  style: { ${Object.entries(style).map(([k, v]) => `${k}: ${JSON.stringify(v)}`).join("; ")} }`);
    if (m.extended && Object.keys(m.extended).length) lines.push(`  extended: { ${Object.entries(m.extended).map(([k, v]) => `${k}: ${JSON.stringify(v)}`).join("; ")} }`);
  }
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// building (pure per builder — no cross-builder reads)
// ---------------------------------------------------------------------------

// renderSubtreeFromElements(el, members, childMap, ctx, depth) — mirrors
// src/reconstruction/generation/project-generator.js renderNode conventions
// exactly (tag whitelist, cx-N + first captured class, attr order, self-close,
// text handling, wiring attrs). Deviations here are caught by the
// render-equivalence check in scripts/test-skill-integration.mjs.
function renderSubtreeFromElements(el, memberSet, childMap, ctx, depth) {
  if (!el || depth > 14) return "";
  const tag = TAG_RE.test(el.tag) ? el.tag : "div";
  const cls = `cx-${el.i}${el.cls ? " " + esc(String(el.cls).split(/\s+/)[0]) : ""}`;
  let attrs = `class="${cls}"`;
  if (el.role) attrs += ` role="${esc(el.role)}"`;
  if (el.ariaName) attrs += ` aria-label="${esc(el.ariaName)}"`;
  if (tag === "a") {
    let href = el.href || "#";
    if (ctx.routeFileMap && ctx.routeFileMap.has(new URL(href, "http://x").pathname)) {
      href = ctx.routeFileMap.get(new URL(href, "http://x").pathname);
    }
    attrs += ` href="${esc(href)}"`;
  }
  if (tag === "img") {
    const local = ctx.assetByIndex?.get(el.i);
    const src = local || el.src || "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='120' height='80'%3E%3Crect width='100%25' height='100%25' fill='%23e5e7eb'/%3E%3Ctext x='50%25' y='54%25' text-anchor='middle' font-size='11' fill='%239ca3af'%3Eimg%3C/text%3E%3C/svg%3E";
    attrs += ` src="${esc(src)}"`;
    if (el.rect && el.rect.w > 2 && el.rect.h > 2) attrs += ` width="${el.rect.w}" height="${el.rect.h}"`;
  }
  if (tag === "input" && el.ariaName) attrs += ` placeholder="${esc(el.ariaName)}"`;
  if (el.dataClonerTrigger) attrs += ` data-cloner-trigger="${esc(el.dataClonerTrigger)}"`;
  const wire = ctx.wireByIndex?.get(el.i);
  if (wire) attrs += ` data-replay-id="${esc(wire)}"`;
  const streamTarget = ctx.streamByIndex?.get(el.i);
  if (streamTarget) attrs += ` data-stream-target="${esc(streamTarget)}"`;
  const indent = "  ".repeat(depth);
  if (SELF_CLOSE.has(tag)) return `${indent}<${tag} ${attrs} />`;
  const text = el.text ? esc(el.text) : "";
  // memberSet === null renders the FULL subtree (lead fragments must include
  // nested sections' markup exactly once — their CSS still comes from the
  // section builders, see buildLeadFragments)
  const kidFilter = memberSet ? (i) => memberSet.has(i) : () => true;
  const kids = (childMap.get(el.i) || [])
    .filter(kidFilter)
    .map((i) => ctx.elementsByIndex.get(i))
    .filter(Boolean)
    .map((c) => renderSubtreeFromElements(c, memberSet, childMap, ctx, depth + 1))
    .join("\n");
  if (!kids && text) return `${indent}<${tag} ${attrs}>${text}</${tag}>`;
  return `${indent}<${tag} ${attrs}>\n${kids ? kids + "\n" : ""}${text ? indent + "  " + text + "\n" : ""}${indent}</${tag}>`;
}

// EXTENDED_PROP_CSS — camelCase computed-style prop → CSS property, for the
// spec-faithful emission (technique 1 feeding technique 2: the skill's
// "every CSS value in the spec is from getComputedStyle" carried into the
// built CSS). Values are emitted VERBATIM from the extended capture —
// including "none" defaults, which are cascade-harmless no-ops.
export const EXTENDED_PROP_CSS = Object.freeze({
  letterSpacing: "letter-spacing", textTransform: "text-transform", textAlign: "text-align",
  whiteSpace: "white-space", textDecorationLine: "text-decoration-line",
  boxShadow: "box-shadow", transform: "transform", filter: "filter", transition: "transition",
  flexGrow: "flex-grow", flexShrink: "flex-shrink", flexBasis: "flex-basis",
  minWidth: "min-width", minHeight: "min-height", maxWidth: "max-width", maxHeight: "max-height",
  backgroundImage: "background-image", overflowX: "overflow-x", overflowY: "overflow-y",
  outline: "outline", verticalAlign: "vertical-align",
  borderTopWidth: "border-top-width", borderLeftWidth: "border-left-width",
});

// extendedRulesFor(memberIndexes, ctx) — one additive rule per member whose
// extended capture carries values: `.cx-N { letter-spacing: 2px; …; }`.
// Appended AFTER the base rule so the same-property cascade resolves to the
// captured value; different props never conflict with the base rule.
export function extendedRulesFor(memberIndexes, ctx) {
  const extendedByIndex = ctx.extendedByIndex;
  if (!extendedByIndex || typeof extendedByIndex.get !== "function") return "";
  const lines = [];
  for (const i of memberIndexes || []) {
    const ext = extendedByIndex.get(i);
    if (!ext || typeof ext !== "object") continue;
    const props = [];
    for (const [k, v] of Object.entries(ext)) {
      const cssProp = EXTENDED_PROP_CSS[k];
      if (cssProp && v !== undefined && v !== null && String(v) !== "") props.push(`${cssProp}: ${v}`);
    }
    if (props.length) lines.push(`.cx-${i} { ${props.join("; ")}; }`);
  }
  return lines.join("\n");
}

// buildSectionFragment(builder, ctx) →
// { builderId, sectionId, role, html, css, lines, subIndex? }.
// ctx: { elementsByIndex (Map i → dom.json element), childMap (childrenIndexMap
// output), layoutByIndex, wireByIndex, assetByIndex, streamByIndex,
// routeFileMap, scopeOf?, extendedByIndex? (Map i → extended captured values) }.
// Wrapper builders render the section ROOT plus a merge marker; their CSS
// covers the root element only.
export function buildSectionFragment(builder, ctx) {
  const memberSet = new Set(builder.memberIndexes || []);
  const elementsByIndex = ctx.elementsByIndex;
  if (!elementsByIndex || !elementsByIndex.size) {
    return { builderId: builder.builderId, sectionId: builder.sectionId, role: builder.role, html: "", css: "", lines: 0, why: "no element evidence" };
  }
  const cssEls = (builder.memberIndexes || []).map((i) => elementsByIndex.get(i)).filter(Boolean);
  let css = buildComponentCss(cssEls, ctx.layoutByIndex, { scopeOf: typeof ctx.scopeOf === "function" ? ctx.scopeOf : null });
  const extendedCss = extendedRulesFor(builder.memberIndexes || [], ctx);
  if (extendedCss) css = (css ? css + "\n" : "") + extendedCss;

  let html;
  if (builder.role === "wrapper") {
    const root = elementsByIndex.get(builder.rootIndex);
    const open = renderOpenTag(root, ctx);
    const close = root && !SELF_CLOSE.has(TAG_RE.test(root.tag) ? root.tag : "div") ? `</${TAG_RE.test(root.tag) ? root.tag : "div"}>` : "";
    html = [open, `<!-- merge:${builder.sectionId}:sub -->`, close].filter(Boolean).join("\n");
  } else {
    const roots = builder.role === "sub-component" ? (builder.rootIndexes || []) : [builder.rootIndex];
    html = roots
      .map((i) => elementsByIndex.get(i))
      .filter(Boolean)
      .map((el) => renderSubtreeFromElements(el, memberSet, ctx.childMap, ctx, 2))
      .filter(Boolean)
      .join("\n");
  }
  return {
    builderId: builder.builderId,
    sectionId: builder.sectionId,
    role: builder.role,
    subIndex: builder.subIndex ?? null,
    rootIndex: builder.rootIndex ?? null,
    rect: builder.sectionRect ?? builder.rect ?? null, // top-level placement sort key
    html,
    css,
    lines: (html ? html.split("\n").length : 0) + (css ? css.split("\n").length : 0),
  };
}

// open tag for the wrapper root — same attr construction as renderSubtree, but
// without children/text (marker goes inside).
function renderOpenTag(el, ctx) {
  if (!el) return "";
  const tag = TAG_RE.test(el.tag) ? el.tag : "div";
  const cls = `cx-${el.i}${el.cls ? " " + esc(String(el.cls).split(/\s+/)[0]) : ""}`;
  let attrs = `class="${cls}"`;
  if (el.role) attrs += ` role="${esc(el.role)}"`;
  if (el.ariaName) attrs += ` aria-label="${esc(el.ariaName)}"`;
  const wire = ctx.wireByIndex?.get(el.i);
  if (wire) attrs += ` data-replay-id="${esc(wire)}"`;
  if (el.dataClonerTrigger) attrs += ` data-cloner-trigger="${esc(el.dataClonerTrigger)}"`;
  return `<${tag} ${attrs}>`;
}

// buildLeadFragments(leadRootIndexes, ctx) — the "lead" renders the subtrees
// no section owns (the skill's foundation phase), in the same renderer so the
// merged page is structurally identical to the monolithic one. A lead renders
// its FULL subtree (nested section markup appears exactly once, inside the
// lead); its CSS covers only the UNCLAIMED elements — claimed members get
// their rules from their section builders, so no rule is ever duplicated by
// the merge. ctx: { elementsByIndex, childMap, layoutByIndex, wireByIndex,
// assetByIndex, streamByIndex, routeFileMap, claimedIndexes (Set), scopeOf? }.
export function buildLeadFragments(leadRootIndexes, ctx) {
  const fragments = [];
  const claimed = ctx.claimedIndexes instanceof Set ? ctx.claimedIndexes : new Set();
  for (const rootIndex of leadRootIndexes || []) {
    const el = ctx.elementsByIndex.get(rootIndex);
    if (!el) continue;
    // css: this subtree's UNCLAIMED elements only (claimed ones come from
    // their section builders — the merge dedupes by full selector anyway)
    const unclaimed = [];
    const collect = (idx, seen) => {
      if (seen.has(idx)) return;
      seen.add(idx);
      if (!claimed.has(idx)) unclaimed.push(idx);
      for (const c of ctx.childMap.get(idx) || []) collect(c, seen);
    };
    collect(rootIndex, new Set());
    const html = renderSubtreeFromElements(el, null, ctx.childMap, ctx, 2);
    if (!html) continue;
    let css = buildComponentCss(
      unclaimed.map((i) => ctx.elementsByIndex.get(i)).filter(Boolean),
      ctx.layoutByIndex,
      { scopeOf: typeof ctx.scopeOf === "function" ? ctx.scopeOf : null },
    );
    // spec-faithful emission for the lead's own (unclaimed) elements too — a
    // lead-covered element's extended captured values must reach the built
    // CSS exactly like a section member's
    const extendedCss = extendedRulesFor(unclaimed, ctx);
    if (extendedCss) css = (css ? css + "\n" : "") + extendedCss;
    fragments.push({
      builderId: `lead-${rootIndex}`,
      sectionId: null,
      role: "lead",
      rootIndex,
      rect: el.rect,
      html,
      css,
      unclaimedCount: unclaimed.length,
    });
  }
  return fragments;
}

// ---------------------------------------------------------------------------
// merging (deterministic assembly)
// ---------------------------------------------------------------------------

// fullSelectorOf(rule) — the complete selector text (everything before " {"),
// so page-scoped rules (body[data-page="…"] .cx-N) never collide with their
// unscoped twins on another page.
function fullSelectorOf(rule) {
  const cut = rule.indexOf(" {");
  return (cut >= 0 ? rule.slice(0, cut) : rule).trim();
}

// BORDER_BOX_CORRECTION — the capture model: element rects come from
// getBoundingClientRect, i.e. BORDER-box dimensions. The generated CSS emits
// those as width/height, which the browser interprets as CONTENT-box by
// default — every padded/bordered element renders larger than captured (a
// real drift the section gate measures). Opting in prepends the box-sizing
// declaration so the built CSS reproduces the captured geometry. Generic and
// target-independent: it follows from how rects are measured, not from any
// site's identity.
export const BORDER_BOX_CORRECTION = "*, *::before, *::after { box-sizing: border-box; }";

// mergeSectionFragments({ fragments, plan, leadFragments, parentOf, borderBoxCorrection }) →
// { html, css, conflicts, mergedSections, subComponentsMerged, nestedInLead, lines }.
//   fragments      buildSectionFragment outputs (any order)
//   plan           planSectionBuilders output (defines dispatch order)
//   leadFragments  buildLeadFragments output (optional)
//   parentOf       Map elementIndex → parent index (dom.json links) — used to
//                  keep sections whose root sits INSIDE a lead subtree out of
//                  the top-level placement (their markup already rides in the
//                  lead's full-subtree html; their CSS still comes from their
//                  own builders). Recorded in nestedInLead, never dropped
//                  silently.
// Conflicts: a .cx-N selector emitted by two fragments is resolved to the
// FIRST in dispatch order and every conflict is recorded — fail-closed merge,
// never a silent overwrite. Order: sections in document order, wrapper marker
// filled with sub-components in sub order, lead fragments interleaved by rect.
export function mergeSectionFragments({ fragments, plan, leadFragments = [], parentOf = null, borderBoxCorrection = false }) {
  const orderIndex = new Map((plan?.order || []).map((id, n) => [id, n]));
  const present = (fragments || []).filter((f) => orderIndex.has(f.builderId));
  present.sort((a, b) => (orderIndex.get(a.builderId) ?? 1e9) - (orderIndex.get(b.builderId) ?? 1e9));

  // group by section
  const bySection = new Map();
  for (const f of present) {
    if (!bySection.has(f.sectionId)) bySection.set(f.sectionId, { subs: [], section: null, wrapper: null });
    const g = bySection.get(f.sectionId);
    if (f.role === "sub-component") g.subs.push(f);
    else if (f.role === "wrapper") g.wrapper = f;
    else g.section = f;
  }
  for (const g of bySection.values()) g.subs.sort((a, b) => (a.subIndex ?? 0) - (b.subIndex ?? 0));

  // compose each section's html + collect css chunks in dispatch order
  const leadRoots = new Set((leadFragments || []).map((f) => f.rootIndex));
  const sectionsHtml = [];
  const nestedInLead = [];
  let subComponentsMerged = 0;
  for (const f of present) {
    const g = bySection.get(f.sectionId);
    if (!g) continue;
    if (!g._emitted) {
      g._emitted = true;
      let html;
      if (g.wrapper) {
        const marker = `<!-- merge:${g.wrapper.sectionId}:sub -->`;
        const subHtml = g.subs.map((s) => s.html).filter(Boolean).join("\n");
        subComponentsMerged += g.subs.filter((s) => s.html).length;
        html = g.wrapper.html.replace(marker, subHtml);
      } else {
        html = (g.section?.html || "");
      }
      if (!html) continue;
      // placement: a section nested inside a lead subtree must not ALSO be
      // emitted at top level (its markup is already in the lead's html)
      const rootIndex = (g.wrapper || g.section)?.rootIndex ?? null;
      let insideLead = false;
      if (parentOf && rootIndex !== null && rootIndex !== undefined) {
        let cur = parentOf.get(rootIndex);
        const seen = new Set([rootIndex]);
        while (cur !== null && cur !== undefined && !seen.has(cur)) {
          seen.add(cur);
          if (leadRoots.has(cur)) { insideLead = true; break; }
          cur = parentOf.get(cur);
        }
      }
      if (insideLead) { nestedInLead.push({ sectionId: f.sectionId, rootIndex }); continue; }
      sectionsHtml.push({ rect: (g.wrapper || g.section)?.rect || null, sectionId: f.sectionId, html });
    }
  }

  // top-level assembly: sections + lead fragments in document order
  const topLevel = [
    ...sectionsHtml,
    ...(leadFragments || []).map((f) => ({ rect: f.rect, sectionId: null, html: f.html })),
  ].sort((a, b) =>
    (a.rect?.y ?? 0) - (b.rect?.y ?? 0) ||
    (a.rect?.x ?? 0) - (b.rect?.x ?? 0) ||
    String(a.sectionId ?? "lead").localeCompare(String(b.sectionId ?? "lead")));

  // css: dispatch order; a selector emitted by TWO DIFFERENT fragments is a
  // conflict (first in dispatch order wins, recorded — fail-closed). Multiple
  // rules with the same selector from the SAME fragment are legitimate
  // additive rules (the spec-faithful extended values append same-selector
  // rules after the base rule) and are kept.
  const seenSel = new Map(); // selector → fragmentId
  const conflicts = [];
  const cssParts = [];
  const absorbRules = (f) => {
    if (!f.css) return null;
    const kept = [];
    for (const rule of f.css.split("\n").filter(Boolean)) {
      const sel = fullSelectorOf(rule);
      const owner = seenSel.get(sel);
      if (owner && owner !== f.builderId) {
        conflicts.push({ selector: sel, keptFrom: owner, droppedFrom: f.builderId });
        continue;
      }
      seenSel.set(sel, f.builderId);
      kept.push(rule);
    }
    return kept.length ? kept.join("\n") : null;
  };
  for (const f of present) {
    const css = absorbRules(f);
    if (css) cssParts.push({ builderId: f.builderId, css });
  }
  for (const f of leadFragments || []) {
    const css = absorbRules(f);
    if (css) cssParts.push({ builderId: f.builderId, css });
  }

  const css = (borderBoxCorrection ? BORDER_BOX_CORRECTION + "\n" : "") +
    cssParts.map((c) => `/* builder: ${c.builderId} */\n${c.css}`).join("\n");
  const html = topLevel.map((t) => t.html).join("\n");
  return {
    html,
    css,
    conflicts,
    mergedSections: bySection.size,
    subComponentsMerged,
    nestedInLead,
    lines: (html ? html.split("\n").length : 0) + (css ? css.split("\n").length : 0),
  };
}

// writeBuildPlan(artifactsDir, plan, mergeReport) → specs/build-plan.json.
export function writeBuildPlan(artifactsDir, plan, mergeReport = null) {
  if (!plan) return { ok: false, why: "no plan", file: null };
  const dir = path.join(artifactsDir, "specs");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "build-plan.json");
  fs.writeFileSync(file, JSON.stringify({
    generatedAt: new Date().toISOString(),
    plan,
    merge: mergeReport ? {
      mergedSections: mergeReport.mergedSections,
      conflicts: mergeReport.conflicts,
      lines: mergeReport.lines,
    } : null,
  }, null, 2));
  return { ok: true, file: "specs/build-plan.json" };
}
