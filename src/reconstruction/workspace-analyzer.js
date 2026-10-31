// Workspace analyzer (task 3.4.2): detects Golden-Layout-class interfaces —
// docking systems, splitter-resizable regions, tabbed panel stacks, collapse
// affordances — from ONE captured artifact page, and emits a workspace tree the
// docking-layout-builder (docking-layout-builder.js) turns into CSS + runtime
// behaviors for the clone.
//
// detectWorkspace(domElements, layout, understanding) → tree | null
//   domElements   dom.json `elements` array ({i, tag, cls, id, text, role,
//                 ariaName, rect:{x,y,w,h}, parent, style, layout, ...}) as the
//                 DOM extractor emits it (src/intelligence/dom-extractor.js).
//   layout        the analyzeLayout() map (elementIndex → {kind, horizontal, …}),
//                 plain object or Map; used as corroboration only. May be null.
//   understanding task 3.4.1's buildUnderstandingPage() model — components with
//                 kinds (sidebar/splitter/workspace/toolbar …) + regions index.
//                 Used for region labels + splitter corroboration only; may be
//                 null. It NEVER creates docking structure on its own.
//
// EVIDENCE GATE (the contract): the tree is only produced when docking evidence
// is present — at least 1 splitter element (thin strip between two sizable
// sibling panes, or a splitter/dock token class) or at least 1 tab group (tab
// strip + adjacent panel stack). Ordinary flexbox/grid pages return null.
//
// Node vocabulary: { kind: 'row'|'column'|'tabs'|'stack'|'pane', … }
//   row/column — a splitter container; children are the segments BETWEEN the
//                splitters, sizes are each segment's percentage of the
//                container's usable size (last one normalized so they sum to 100).
//   tabs       — a tab strip + panel stack pair: { strip, stack, tabs:[{label,
//                elementIndex, panelElementIndex}], children (panel indexes),
//                activeTab }. Stacked panels = children whose captured boxes
//                coincide (docking stacks overlap their panes).
//   stack      — a coinciding-children (layered) container WITHOUT a tab strip;
//                visibleIndex points at the captured-visible child.
//   pane       — leaf dock region: { elementIndex, size, region?, title?, close?,
//                collapse? }.
//
// CAPTURE MAPPING (which dom.json selectors each behavior relies on):
//   - active tab       → tab element's class tokens `lm_active`, `active`,
//                        `selected`, `current`, `open` (first match wins, in
//                        that order) or aria-selected="true". The extractor
//                        captures the full class string (≤80 chars).
//   - panel visibility → captured style.opacity === "0" marks a hidden stacked
//                        panel. NOTE (honest limitation): the extractor skips
//                        zero-size boxes (src/intelligence/dom-extractor.js:19),
//                        so display:none panels NEVER reach dom.json; a stack
//                        with fewer captured panels than tabs is detected via
//                        the relaxed bar (single captured panel + active-tab
//                        marker, pane-sized, stack >= 2x strip height) and
//                        reported with an inferred-panel-count note; the builder
//                        renders the captured panels only. Fixtures that keep
//                        inactive panes measured (opacity/visibility hidden,
//                        real box) reconstruct fully.
//   - parent links     → the extractor's geometric containment produces
//                        2-CYCLES when a stack container and its overlapping
//                        panes share the same box; detectWorkspace normalizes
//                        them (normalizeContainment, exported) before building
//                        its tree.
//   - collapse state   → collapse affordance = descendant of the pane whose text
//                        is a 1-char chevron glyph (‹ › « ») or whose class/id
//                        carries a collapse token (collapse, rail, pin, chevron).
//                        The captured page is always the UNCOLLAPSED state —
//                        collapse state at capture time is not observable beyond
//                        pane width; a pane ≤ rail width is noted as collapsed.
//   - close affordance → descendant whose text is a close glyph (✕ × ⨯ ✖ x X)
//                        or class/id token close/hide.
//   - splitters        → class/id tokens splitter/gutter/resizer/sash/divider/
//                        separator/lm_splitter, OR thin strip (thickness ≤ 12px,
//                        length ≥ 40px) whose previous AND next captured siblings
//                        are sizable panes (both ≥ 60px in the split axis and
//                        ≥ 60px in the other).
//   - pane sizes       → captured rect widths/heights as percentages of the
//                        container's usable size (container size minus splitter
//                        thickness).

import { makeEvidence, aggregateConfidence } from "./component-evidence.js";

export const WORKSPACE_NODE_KINDS = ["row", "column", "tabs", "stack", "pane"];

// class/id tokens (tokenized on non-alphanumerics) per affordance
const SPLITTER_TOKENS = ["splitter", "gutter", "resizer", "sash", "divider", "separator", "lmsplitter"];
const CLOSE_TOKENS = ["close", "hide", "panehide"];
const COLLAPSE_TOKENS = ["collapse", "collapsed", "rail", "pin", "chevron", "togglepane"];
const ACTIVE_TAB_TOKENS = ["lm_active", "active", "selected", "current", "open"];
const CLOSE_GLYPHS = new Set(["✕", "×", "⨯", "✖", "x", "X"]);
const COLLAPSE_GLYPHS = new Set(["‹", "›", "«", "»", "˂", "˃"]);

const clsTokens = (s) => String(s || "").toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
const hasToken = (s, words) => clsTokens(s).some((t) => words.includes(t));

const DEFAULTS = {
  minPaneSize: 60,       // px — both axes, for a sibling to count as a pane
  maxSplitterThickness: 12, // px — thin-strip threshold
  minSplitterLength: 40, // px
  maxTabHeight: 60,      // px — tab strip children height ceiling
  minTabHeight: 14,      // px — floor (a 2px sliver is not a tab)
  stackTolerance: 3,     // px — box coincidence tolerance for stacked panels
};

function normalize(elements) {
  const raw = Array.isArray(elements) ? elements : elements && Array.isArray(elements.elements) ? elements.elements : [];
  return raw.filter((e) => e && typeof e.i === "number" && e.rect);
}

// normalizeContainment(elements) → elements with acyclic parent links.
//
// The DOM extractor resolves parents by GEOMETRIC CONTAINMENT (smallest-area
// box that contains the element — src/intelligence/dom-extractor.js:60-72).
// Docking stacks break that heuristic: a stack container and its overlapping
// panes can share the SAME box, and then each is the other's "smallest
// container" — the captured parent links form 2-cycles (observed on the
// workspace fixture: tabstack↔panel). Downstream, cycles crash unguarded
// subtree walks and drop the affected subtrees from clone rendering (the
// component tree only renders elements reachable from the roots).
//
// Deterministic repair:
//   1. for a mutual pair (x → y and y → x) or a self-parent (x → x): the
//      EARLIER element (document order — the extractor emits containers before
//      their contents) is the container; the later element keeps
//      parent = earlier; the earlier element's parent is re-resolved to the
//      smallest-area containing box that is NOT in the earlier element's
//      equal-box class (identical x/y/w/h — those would tie or re-cycle);
//   2. any residual cycle: the deepest element's link is dropped (becomes a root).
// Elements are copied; indexes, order and all other fields are untouched.
export function normalizeContainment(elements) {
  const els = normalize(elements).map((e) => ({ ...e }));
  if (els.length < 2) return els;
  const byI = new Map(els.map((e) => [e.i, e]));
  const area = (e) => (e.rect.w ?? 0) * (e.rect.h ?? 0);
  const boxKey = (e) => `${e.rect.x ?? 0}|${e.rect.y ?? 0}|${e.rect.w ?? 0}|${e.rect.h ?? 0}`;
  const boxClass = new Map(); // boxKey → element indexes (document order)
  for (const e of els) {
    const k = boxKey(e);
    if (!boxClass.has(k)) boxClass.set(k, []);
    boxClass.get(k).push(e.i);
  }
  // smallest-area containing box for el, excluding a set of indexes
  const resolveParent = (el, exclude) => {
    let best = null, bestArea = Infinity;
    for (const cand of els) {
      if (cand.i === el.i || exclude.has(cand.i)) continue;
      const r = cand.rect, me = el.rect;
      if (r.x > me.x || r.y > me.y || r.x + r.w < me.x + me.w || r.y + r.h < me.y + me.h) continue;
      const a = area(cand);
      if (a < bestArea || (a === bestArea && best && cand.i < best.i)) { best = cand; bestArea = a; }
    }
    return best ? best.i : null;
  };
  const fixed = new Set();
  for (const el of els) {
    if (fixed.has(el.i)) continue;
    const p = el.parent;
    if (p === null || p === undefined || !byI.has(p)) continue;
    if (p === el.i || byI.get(p).parent === el.i) {
      // mutual pair or self-parent — the earlier index is the container
      const other = byI.get(p);
      const container = el.i < other.i ? el : other;
      const child = el.i < other.i ? other : el;
      child.parent = container.i;
      const exclude = new Set(boxClass.get(boxKey(container)) || [container.i]);
      container.parent = resolveParent(container, exclude);
      fixed.add(container.i);
      fixed.add(child.i);
    }
  }
  // residual cycle sweep (deep cycles the pair rule cannot see): walk each
  // element's ancestor chain; on revisit, drop the DEEPEST link to a root
  for (const el of els) {
    const seen = new Set();
    let cur = el;
    let depth = 0;
    while (cur && cur.parent !== null && cur.parent !== undefined && byI.has(cur.parent) && depth <= els.length + 1) {
      if (seen.has(cur.parent)) { cur.parent = null; break; }
      seen.add(cur.parent);
      cur = byI.get(cur.parent);
      depth++;
    }
  }
  return els;
}

// containment children (document order) from the captured geometric parents
function buildTree(els) {
  const byIndex = new Map(els.map((e) => [e.i, e]));
  const childrenOf = new Map();
  for (const el of els) {
    const p = el.parent === null || el.parent === undefined ? -1 : el.parent;
    if (!childrenOf.has(p)) childrenOf.set(p, []);
    childrenOf.get(p).push(el);
  }
  const kids = (i) => childrenOf.get(i) || [];
  const sibs = (el) => (el.parent === null || el.parent === undefined ? childrenOf.get(-1) || [] : kids(el.parent));
  return { byIndex, kids, sibs };
}

function sizable(el, axis, min) {
  if (!el || !el.rect) return false;
  const w = el.rect.w ?? 0, h = el.rect.h ?? 0;
  if (axis === "x") return w >= min && h >= min;
  return h >= min && w >= min;
}

// thin strip → which axis it splits: a VERTICAL bar (w small, h large) separates
// a horizontal row; a HORIZONTAL bar separates a vertical column.
function thinStripAxis(el, cfg) {
  const r = el.rect || {};
  const w = r.w ?? 0, h = r.h ?? 0;
  if (w > 0 && w <= cfg.maxSplitterThickness && h >= cfg.minSplitterLength) return "x";
  if (h > 0 && h <= cfg.maxSplitterThickness && w >= cfg.minSplitterLength) return "y";
  return null;
}

// classify ONE element as a splitter: token hit (weak) or thin strip WITH
// sizable pane siblings on both sides (strong). Returns { axis, evidence } | null.
function classifySplitter(el, tree, cfg) {
  const i = el.i;
  const tokenHit = hasToken(el.cls, SPLITTER_TOKENS) || hasToken(el.id, SPLITTER_TOKENS);
  const stripAxis = thinStripAxis(el, cfg);
  const sibs = tree.sibs(el);
  const pos = sibs.findIndex((s) => s.i === i);
  const prev = pos > 0 ? sibs[pos - 1] : null;
  const next = pos >= 0 && pos < sibs.length - 1 ? sibs[pos + 1] : null;
  if (stripAxis) {
    const panePrev = sizable(prev, stripAxis, cfg.minPaneSize);
    const paneNext = sizable(next, stripAxis, cfg.minPaneSize);
    if (panePrev && paneNext) {
      return {
        axis: stripAxis,
        evidence: [
          makeEvidence("geometry", `elements[${i}].rect`, `thin strip ${el.rect.w}x${el.rect.h} between panes ${prev.i} and ${next.i}`, 0.6),
          ...(tokenHit ? [makeEvidence("dom-class", `elements[${i}].cls`, "splitter token + thin strip", 0.3)] : []),
        ],
      };
    }
    return null; // thin strip without two pane neighbors is NOT docking evidence
  }
  if (tokenHit && prev && next && sizable(prev, "x", cfg.minPaneSize) && sizable(next, "x", cfg.minPaneSize)) {
    // token-named splitter between sizable siblings (thickness above the strip
    // threshold) — still structural docking evidence
    const axis = (el.rect.w ?? 0) <= (el.rect.h ?? 0) ? "x" : "y";
    return { axis, evidence: [makeEvidence("dom-class", `elements[${i}].cls`, "splitter token between sizable siblings", 0.55)] };
  }
  return null;
}

// tab strip: a container with >= 2 tab-like children — small, text-bearing,
// near-equal heights, arranged in one row
function tabStripChildren(el, tree, cfg) {
  const kids = tree.kids(el.i).filter((k) => {
    const h = k.rect?.h ?? 0, w = k.rect?.w ?? 0;
    if (h < cfg.minTabHeight || h > cfg.maxTabHeight) return false;
    if (w < 16) return false;
    const text = String(k.text || "").trim();
    const named = text.length > 0 || hasToken(k.cls, ACTIVE_TAB_TOKENS) || k.role === "tab";
    return named;
  });
  if (kids.length < 2) return null;
  const heights = kids.map((k) => k.rect.h);
  const maxH = Math.max(...heights), minH = Math.min(...heights);
  if (maxH - minH > 8) return null; // not a uniform strip
  const ys = kids.map((k) => k.rect.y);
  if (Math.max(...ys) - Math.min(...ys) > 8) return null; // one row only
  return kids;
}

// panel stack: children whose boxes coincide (docking stacks overlap panes).
// Returns every coinciding child (>= 1); detectTabs decides which counts are
// strong enough evidence.
function stackedChildren(el, tree, cfg) {
  const kids = tree.kids(el.i);
  if (kids.length < 1) return null;
  const base = kids[0].rect;
  const coincide = kids.filter((k) =>
    Math.abs((k.rect.x ?? 0) - (base.x ?? 0)) <= cfg.stackTolerance &&
    Math.abs((k.rect.y ?? 0) - (base.y ?? 0)) <= cfg.stackTolerance &&
    Math.abs((k.rect.w ?? 0) - (base.w ?? 0)) <= cfg.stackTolerance &&
    Math.abs((k.rect.h ?? 0) - (base.h ?? 0)) <= cfg.stackTolerance,
  );
  return coincide.length >= 1 ? coincide : null;
}

// activeTab resolution for a tab strip (documented selector precedence — see
// the capture-mapping header): class token > aria-selected
function activeTabIndex(tabs) {
  for (const token of ACTIVE_TAB_TOKENS) {
    const idx = tabs.findIndex((t) => hasToken(t.cls, [token]) || clsTokens(t.id).includes(token));
    if (idx >= 0) return idx;
  }
  const aria = tabs.findIndex((t) => String(t.ariaSelected ?? "").toLowerCase() === "true");
  return aria;
}

// close / collapse affordance lookup inside a pane subtree
function findAffordance(paneEl, tree, glyphs, tokens) {
  const stack = [...tree.kids(paneEl.i)];
  let guard = 0;
  while (stack.length && guard < 200) {
    guard++;
    const el = stack.shift();
    const text = String(el.text || "").trim();
    if (glyphs && glyphs.has(text)) return el;
    if (tokens && (hasToken(el.cls, tokens) || hasToken(el.id, tokens))) return el;
    const kids = tree.kids(el.i);
    if (kids.length) stack.push(...kids);
  }
  return null;
}

function titleOf(paneEl, tree) {
  // pane title: aria-label > first short leaf text in the first 4 descendants
  if (paneEl.ariaName) return String(paneEl.ariaName).slice(0, 40);
  const stack = [...tree.kids(paneEl.i)];
  let guard = 0;
  while (stack.length && guard < 8) {
    guard++;
    const el = stack.shift();
    const t = String(el.text || "").trim();
    if (t && t.length <= 40 && !CLOSE_GLYPHS.has(t) && !COLLAPSE_GLYPHS.has(t)) return t.slice(0, 40);
    const kids = tree.kids(el.i);
    if (kids.length) stack.unshift(...kids.slice(0, 2));
  }
  return null;
}

// segment sizes as percentages of the container's USABLE extent along the split
// axis (container size minus total splitter thickness — flex-basis percentages
// resolve against the container's main size, so splitters must be subtracted);
// the LAST size is normalized so the sum is exactly 100 (capture rounding must
// not leave slack in the flex line)
function segmentSizes(segments, container, axis, splitterPxTotal) {
  const usable = Math.max(1, (axis === "x" ? container.rect?.w ?? 0 : container.rect?.h ?? 0) - splitterPxTotal);
  const raw = segments.map((s) => (axis === "x" ? s.rect?.w ?? 0 : s.rect?.h ?? 0));
  const pct = raw.map((v) => Math.round((v / usable) * 10000) / 100);
  if (pct.length > 1) {
    const acc = pct.slice(0, -1).reduce((a, b) => a + b, 0);
    pct[pct.length - 1] = Math.round((100 - acc) * 100) / 100;
  }
  return pct;
}

// detect a tab group inside `container` (strip sibling + panel stack) → node | null
//
// Two evidence bars:
//   strict  — >= 2 stacked panels with coinciding boxes (a docking stack with
//             measured hidden panes); no marker needed.
//   relaxed — only ONE captured panel + an ACTIVE-TAB MARKER on the strip
//             (class token or aria-selected). Covers real stacks whose inactive
//             panes are display:none and therefore never captured (the
//             extractor skips zero-size boxes). Guards against nav-menu false
//             positives: the panel must be pane-sized (>= 120x60), coincide
//             with the stack's own box, and the stack must be >= 2x taller
//             than the strip.
function detectTabs(container, tree, cfg, notes) {
  for (const strip of tree.kids(container.i)) {
    const tabs = tabStripChildren(strip, tree, cfg);
    if (!tabs) continue;
    // the stack is an adjacent sibling of the strip (next preferred, then previous)
    const sibs = tree.sibs(strip);
    const pos = sibs.findIndex((s) => s.i === strip.i);
    const candidates = [sibs[pos + 1], sibs[pos - 1]].filter((s) => s && s.i !== strip.i);
    let stack = null;
    let stacked = null;
    for (const cand of candidates) {
      const st = stackedChildren(cand, tree, cfg);
      if (st && (cand.rect?.w ?? 0) >= (strip.rect?.w ?? 0) * 0.5) { stack = cand; stacked = st; break; }
    }
    if (!stack || !stacked) continue;
    const aIdx = activeTabIndex(tabs);
    const strict = stacked.length >= 2;
    const stackH = stack.rect?.h ?? 0, stripH = strip.rect?.h ?? 0;
    const relaxedOk =
      !strict &&
      stacked.length >= 1 &&
      aIdx >= 0 &&
      stackH >= 2 * stripH &&
      stacked.every((p) => (p.rect?.w ?? 0) >= 120 && (p.rect?.h ?? 0) >= 60) &&
      stacked.every((p) =>
        Math.abs((p.rect.x ?? 0) - (stack.rect?.x ?? 0)) <= cfg.stackTolerance &&
        Math.abs((p.rect.y ?? 0) - (stack.rect?.y ?? 0)) <= cfg.stackTolerance &&
        Math.abs((p.rect.w ?? 0) - (stack.rect?.w ?? 0)) <= cfg.stackTolerance &&
        Math.abs((p.rect.h ?? 0) - (stack.rect?.h ?? 0)) <= cfg.stackTolerance,
      );
    if (!strict && !relaxedOk) continue;
    const panels = stacked;
    const children = panels.map((p) => p.i);
    const tabsOut = tabs.map((t, idx) => ({
      label: String(t.text || "").trim().slice(0, 40) || null,
      elementIndex: t.i,
      panelElementIndex: panels[idx] ? panels[idx].i : null,
    }));
    if (panels.length < tabs.length) {
      notes.push(`tab group at elements[${container.i}]: ${tabs.length} tabs but only ${panels.length} stacked panel(s) captured — display:none panels never reach dom.json (extractor skips zero-size boxes); panel count inferred`);
    }
    const visibleIdx = panels.findIndex((p) => String(p.style?.opacity ?? "1") !== "0");
    const evidence = [
      makeEvidence("geometry", `elements[${strip.i}].children`, `${tabs.length} uniform tab(s) in strip`, 0.6),
      makeEvidence("geometry", `elements[${stack.i}].children`, `${panels.length} coinciding panel box(es) (docked stack)`, 0.6),
    ];
    if (aIdx >= 0) evidence.push(makeEvidence("dom-class", `elements[${tabs[aIdx].i}].cls`, `active-tab token on "${String(tabs[aIdx].text || "").trim()}"`, 0.5));
    return {
      kind: "tabs",
      elementIndex: container.i,
      rect: { ...(container.rect || {}) },
      strip: strip.i,
      stripHeight: strip.rect?.h ?? null,
      stack: stack.i,
      tabs: tabsOut,
      children,
      activeTab: aIdx >= 0 ? aIdx : (visibleIdx >= 0 ? visibleIdx : 0),
      visiblePanelIndex: visibleIdx,
      evidence,
      confidence: aggregateConfidence(evidence),
    };
  }
  return null;
}

// build the node for ONE segment of a dock container (recursive)
function buildSegment(seg, tree, cfg, understanding, notes, depth) {
  if (depth > 8) return { kind: "pane", elementIndex: seg.i, size: null, evidence: [], notes: ["depth limit reached"] };
  // nested dock container?
  const nested = detectDockContainer(seg, tree, cfg, understanding, notes, depth + 1);
  if (nested) return nested;
  // tab group inside the segment?
  const tabs = detectTabs(seg, tree, cfg, notes);
  if (tabs) return withPaneMeta(tabs, seg, tree, understanding);
  return withPaneMeta({ kind: "pane", elementIndex: seg.i, evidence: [makeEvidence("geometry", `elements[${seg.i}].rect`, `dock segment ${seg.rect.w}x${seg.rect.h}`, 0.5)] }, seg, tree, understanding);
}

function withPaneMeta(node, seg, tree, understanding) {
  node.size = null;
  node.title = titleOf(seg, tree);
  const closer = findAffordance(seg, tree, CLOSE_GLYPHS, CLOSE_TOKENS);
  const collapser = findAffordance(seg, tree, COLLAPSE_GLYPHS, COLLAPSE_TOKENS);
  if (closer) node.close = closer.i;
  if (collapser) node.collapse = collapser.i;
  // region label from task 3.4.1's understanding model (corroboration only)
  const comp = understanding?.components?.find((c) => c.elementIndex === seg.i);
  if (comp && ["sidebar", "workspace", "toolbar", "header", "footer", "navigation"].includes(comp.kind)) {
    node.region = comp.kind;
    node.evidence = [
      ...(node.evidence || []),
      makeEvidence("understanding", `components[u-${seg.i}].kind`, `understanding kind "${comp.kind}" (confidence ${comp.confidence})`, 0.3),
    ];
  }
  if (node.evidence) node.confidence = aggregateConfidence(node.evidence);
  return node;
}

// dock container at `el`: >= 3 children, >= 1 splitter, all other children sizable
function detectDockContainer(el, tree, cfg, understanding, notes, depth) {
  if (depth > 8) return null;
  const kids = tree.kids(el.i);
  if (kids.length < 3) return null;
  const splitterMap = new Map();
  for (const k of kids) {
    const sp = classifySplitter(k, tree, cfg);
    if (sp) splitterMap.set(k.i, sp);
  }
  if (!splitterMap.size) return null;
  const segments = kids.filter((k) => !splitterMap.has(k.i));
  if (segments.length < 2) return null;
  const axes = [...splitterMap.values()].map((s) => s.axis);
  const axis = axes.filter((a) => a === "x").length >= axes.filter((a) => a === "y").length ? "x" : "y";
  // every segment must be sizable in the split axis — a dock row of panes, not
  // a strip with decoration
  if (!segments.every((s) => sizable(s, axis, cfg.minPaneSize))) return null;
  // splitters must span (≈) the container in the cross axis
  const crossOk = [...splitterMap.keys()].every((i) => {
    const s = tree.byIndex.get(i);
    const cross = axis === "x" ? s.rect.h : s.rect.w;
    const cont = axis === "x" ? el.rect.h : el.rect.w;
    return cross >= Math.min(cont * 0.5, cont - 8);
  });
  if (!crossOk) return null;

  const splitterEls = [...splitterMap.keys()].map((i) => tree.byIndex.get(i));
  const splitterPxTotal = splitterEls.reduce((n, s) => n + (axis === "x" ? s.rect?.w ?? 0 : s.rect?.h ?? 0), 0);
  const sizes = segmentSizes(segments, el, axis, splitterPxTotal);
  const children = segments.map((s, idx) => {
    const node = buildSegment(s, tree, cfg, understanding, notes, depth);
    node.size = sizes[idx];
    node.rect = { ...(s.rect || {}) };
    return node;
  });
  const evidence = [
    ...[...splitterMap.entries()].flatMap(([, sp]) => sp.evidence),
    makeEvidence("geometry", `elements[${el.i}].children`, `${segments.length} pane segment(s) + ${splitterMap.size} splitter(s) along ${axis === "x" ? "horizontal row" : "vertical column"}`, 0.55),
  ];
  return {
    kind: axis === "x" ? "row" : "column",
    elementIndex: el.i,
    axis,
    rect: { ...(el.rect || {}) },
    splitterPx: splitterEls.map((s) => axis === "x" ? s.rect?.w ?? 0 : s.rect?.h ?? 0),
    sizes,
    splitters: [...splitterMap.keys()],
    children,
    evidence,
    confidence: aggregateConfidence(evidence),
  };
}

// layout corroboration pass (kept outside detectDockContainer so the core stays
// pure): dock containers / tab strips whose captured display is flex gain a
// small css evidence record
function addLayoutCorroboration(node, layout) {
  if (!node || !layout) return;
  const get = (i) => (layout instanceof Map ? layout.get(i) : layout[i]) || null;
  const lay = get(node.elementIndex);
  if (lay && (lay.kind === "flex" || lay.kind === "row" || lay.kind === "column")) {
    node.evidence = [
      ...(node.evidence || []),
      makeEvidence("css", `layout[${node.elementIndex}]`, `captured display:${lay.kind}${lay.flexDirection ? ":" + lay.flexDirection : ""}`, 0.25),
    ];
    node.confidence = aggregateConfidence(node.evidence);
  }
  for (const c of node.children || []) {
    if (c && typeof c === "object") addLayoutCorroboration(c, layout);
  }
}

// understanding splitter corroboration: understanding-flagged splitters that the
// geometric pass also found strengthen confidence (never create structure)
function addUnderstandingCorroboration(node, understanding) {
  if (!node || !understanding) return;
  const flagged = new Set((understanding.regions?.splitter || [])
    .map((id) => Number(String(id).replace("u-", "")))
    .filter((n) => Number.isFinite(n)));
  if (flagged.size && Array.isArray(node.splitters)) {
    const overlap = node.splitters.filter((i) => flagged.has(i)).length;
    if (overlap) {
      node.evidence = [
        ...(node.evidence || []),
        makeEvidence("understanding", "regions.splitter", `${overlap} splitter(s) corroborated by the 3.4.1 understanding model`, 0.3),
      ];
      node.confidence = aggregateConfidence(node.evidence);
    }
  }
}

// detectWorkspace(domElements, layout, understanding, opts) → workspace tree | null
export function detectWorkspace(domElements, layout, understanding, opts = {}) {
  const cfg = { ...DEFAULTS, ...(opts || {}) };
  const raw = normalize(domElements);
  const notes = [];
  if (raw.length < 4) return null; // no room for a dock in < 4 elements
  // captured parent links can contain 2-cycles on equal-box docking stacks —
  // normalize first so every tree walk below terminates and the stack's panes
  // land under the stack container
  const els = normalizeContainment(raw);
  const tree = buildTree(els);

  // find dock containers everywhere; the root is the OUTERMOST one that has a
  // dock/tabs descendant chain (a dock nested inside a plain page still detects)
  const containers = [];
  for (const el of els) {
    const node = detectDockContainer(el, tree, cfg, understanding, notes, 0);
    if (node) containers.push({ el, node });
  }
  const tabGroups = els
    .map((el) => detectTabs(el, tree, cfg, notes))
    .filter(Boolean);
  const splitterCount = containers.reduce((n, c) => n + c.node.splitters.length, 0);
  const ownTabGroups = tabGroups.filter((t) => !containers.some((c) => c.node.kind === "tabs" && c.node.elementIndex === t.elementIndex));

  // ---- EVIDENCE GATE ----
  if (splitterCount < 1 && tabGroups.length < 1) {
    return null; // ordinary flexbox page — not a workspace
  }
  if (!containers.length && !tabGroups.length) return null;

  let root;
  if (containers.length) {
    // outermost container = the one whose element is not a descendant of another
    // container's element (containment via captured parents, cycle-guarded)
    const containerEls = new Set(containers.map((c) => c.el.i));
    const isInside = (el) => {
      const seen = new Set();
      for (let cur = tree.byIndex.get(el.parent); cur && !seen.has(cur.i); cur = tree.byIndex.get(cur.parent)) {
        seen.add(cur.i);
        if (containerEls.has(cur.i)) return true;
      }
      return false;
    };
    const top = containers.filter((c) => !isInside(c.el));
    root = (top[0] || containers[0]).node;
  } else {
    root = ownTabGroups[0];
  }

  // standalone stacks (coinciding children, no tab strip) inside the root are
  // recorded SEPARATELY (root.stacks) — pushing them into root.children would
  // desynchronize the row/column sizes array from its segments
  const stacks = [];
  for (const el of els) {
    const stacked = stackedChildren(el, tree, cfg);
    // a genuine standalone stack has >= 2 coinciding children — a container
    // whose single child "coincides" with itself is every container (e.g. the
    // dock root and its first pane) and must not qualify
    if (!stacked || stacked.length < 2) continue;
    if (tabGroups.some((t) => t.stack === el.i)) continue;
    if (!containsIndex(root, el.i, tree)) continue;
    const visibleIdx = stacked.findIndex((p) => String(p.style?.opacity ?? "1") !== "0");
    stacks.push({
      kind: "stack",
      elementIndex: el.i,
      children: stacked.map((p) => p.i),
      visibleIndex: visibleIdx >= 0 ? visibleIdx : 0,
      size: null,
      evidence: [makeEvidence("geometry", `elements[${el.i}].children`, `${stacked.length} coinciding child box(es)`, 0.5)],
    });
    notes.push(`standalone stack detected at elements[${el.i}] (no tab strip) — recorded on the workspace root`);
    break; // one is evidence enough; keep the tree focused
  }
  if (stacks.length) root.stacks = stacks;

  addLayoutCorroboration(root, layout);
  addUnderstandingCorroboration(root, understanding);
  root.gate = { splitters: splitterCount, tabGroups: tabGroups.length };
  root.notes = notes;
  root.elementCount = els.length;
  return root;
}

function containsIndex(node, index, tree, guard = 0) {
  if (!node || guard > 32) return false;
  if (node.elementIndex === index) return true;
  for (const c of node.children || []) {
    if (typeof c === "number") { if (c === index) return true; continue; }
    if (containsIndex(c, index, tree, guard + 1)) return true;
  }
  return false;
}

// summarizeWorkspace(tree) — compact summary for pipeline reports
export function summarizeWorkspace(tree) {
  if (!tree) return null;
  const kinds = {};
  const walk = (n, d) => {
    if (!n || typeof n !== "object") return;
    kinds[n.kind] = (kinds[n.kind] || 0) + 1;
    for (const c of n.children || []) if (typeof c !== "number") walk(c, d + 1);
  };
  walk(tree, 0);
  return { root: tree.kind, gate: tree.gate || null, confidence: tree.confidence ?? null, kinds, notes: tree.notes || [] };
}
