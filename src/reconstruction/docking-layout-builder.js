// Docking-layout builder (task 3.4.2): turns a workspace tree from
// workspace-analyzer.detectWorkspace() into the CSS + runtime behaviors a clone
// needs to behave like the captured docking interface — splitter resizing with
// min-size clamps, tab switching, pane close + reopen affordance, pane collapse,
// and session-preserved state across reloads.
//
// Generalizes the Phase 3.2 Golden-Layout wiring in src/runtimeTemplate.js
// (which hard-codes .lm_splitter/.lm_tab/[class*='sidebar'] conventions): here
// every behavior is driven by the ANALYZED tree — the augment step stamps
// data-ws-* attributes onto the generated clone elements, and the runtime binds
// to those attributes, so any class vocabulary works.
//
// Public surface:
//   workspaceCss(tree, opts)                → styles/workspace.css text
//   workspaceConfig(tree, opts)             → inline runtime config object
//   workspaceConfigScript(tree, opts)       → <script>…</script> for the page
//   extendRuntimeWorkspace(runtimeSrc)      → INTEGRATION HOOK (see below)
//   augmentProjectWithWorkspace(outDir, tree, opts) → one-call project augment
//
// INTEGRATION HOOK for the shared pipeline (applied by the integration agent —
// src/reconstruction/generation/project-generator.js:136):
//     fs.writeFileSync(path.join(outDir, "runtime", "interactions.js"),
//         extendRuntimeWorkspace(buildRuntime(interactionRecords)));
// i.e. wrap the existing buildRuntime(...) argument with extendRuntimeWorkspace.
// This module never edits src/runtimeTemplate.js or the pipeline itself.
//
// augmentProjectWithWorkspace(outDir, tree, { pages, elements }) performs:
//   1. writes styles/workspace.css (flex nesting with explicit basis sizes from
//      the captured rects, splitter styling),
//   2. extends runtime/interactions.js with the workspace behaviors (marker-
//      guarded, idempotent),
//   3. per page: links workspace.css AFTER styles/components.css (cascade —
//      buildComponentCss bakes per-element px geometry that the dock must
//      override; `.cx-x .cx-N` scoping additionally wins specificity), injects
//      the inline window.__CLONER_WORKSPACE config BEFORE runtime/interactions.js,
//      stamps data-ws-* attributes onto the managed elements,
//   4. strips recorded replay attrs/records from dock controls (tabs, close,
//      collapse, splitters) so the replay runtime cannot hijack dock clicks —
//      same conflict-avoidance the responsive layer applies to its wired trigger.
//
// No credentials/tokens anywhere: the config carries only element indexes,
// pane titles and behavior constants from the captured DOM.

import fs from "node:fs";
import path from "node:path";

const escAttr = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const escJs = (s) => String(s ?? "").replace(/</g, "\\u003c").replace(/>/g, "\\u003e").replace(/&/g, "\\u0026");

const DEFAULT_OPTS = { minW: 120, minH: 80, railPx: 28, persist: true };

const selOf = (i) => `.cx-x .cx-${i}`;

// ---------------------------------------------------------------------------
// CSS emission
// ---------------------------------------------------------------------------

// walk the tree emitting scoped rules; pct = the flex-basis percentage this node
// received from its parent row/column (null for the root)
function emitSegment(node, pct, parentAxis, lines, opts) {
  if (!node || typeof node !== "object") return;
  const sel = selOf(node.elementIndex);
  const basis = pct != null ? ` flex: 0 1 ${pct}%;` : "";

  if (node.kind === "row" || node.kind === "column") {
    const isRoot = parentAxis === null;
    const height = isRoot && node.rect && node.rect.h ? ` height: ${node.rect.h}px;` : " height: auto;";
    lines.push(`${sel} { display: flex; flex-direction: ${node.kind === "row" ? "row" : "column"}; flex-wrap: nowrap; align-items: stretch;${basis}${height} width: auto; min-width: 0; min-height: 0; overflow: hidden; }`);
    (node.splitters || []).forEach((spIdx, k) => {
      const thick = (node.splitterPx || [])[k] ?? 6;
      if (node.axis === "y") {
        lines.push(`${selOf(spIdx)} { flex: 0 0 ${thick}px; height: ${thick}px; width: auto; min-height: 0; cursor: row-resize; }`);
      } else {
        lines.push(`${selOf(spIdx)} { flex: 0 0 ${thick}px; width: ${thick}px; height: auto; min-width: 0; cursor: col-resize; }`);
      }
    });
    (node.children || []).forEach((c, i) => emitSegment(c, (node.sizes || [])[i], node.axis, lines, opts));
    return;
  }

  if (node.kind === "tabs") {
    const isRoot = parentAxis === null;
    const height = isRoot && node.rect && node.rect.h ? ` height: ${node.rect.h}px;` : " height: auto;";
    lines.push(`${sel} { display: flex; flex-direction: column;${basis}${height} width: auto; min-width: 0; min-height: 0; overflow: hidden; }`);
    if (node.strip != null) {
      const stripH = node.stripHeight ?? 34;
      lines.push(`${selOf(node.strip)} { flex: 0 0 auto; height: ${stripH}px; width: auto; display: flex; align-items: stretch; }`);
    }
    for (let k = 0; k < (node.tabs || []).length; k++) {
      const t = node.tabs[k];
      if (t?.elementIndex != null) lines.push(`${selOf(t.elementIndex)} { cursor: pointer; user-select: none; }`);
    }
    if (node.stack != null) {
      lines.push(`${selOf(node.stack)} { flex: 1 1 auto; position: relative; width: auto; height: auto; min-height: 0; min-width: 0; }`);
    }
    emitPanels(node, lines);
    return;
  }

  if (node.kind === "stack") {
    lines.push(`${sel} { position: relative;${basis} width: auto; height: auto; min-width: 0; min-height: 0; overflow: hidden; }`);
    emitPanels(node, lines);
    return;
  }

  // pane leaf
  lines.push(`${sel} {${basis} width: auto; height: auto; min-width: 0; min-height: 0; overflow: hidden; }`);
}

// stacked panels: absolute-fill inside their stack; [data-ws-hidden] hides the
// inactive ones (the runtime swaps the attribute on tab switches). The captured
// style.opacity of the INACTIVE panel (the analyzer's visibility evidence) is
// baked into components.css as opacity:0 — it would pin the panel permanently
// invisible, so panel visibility is reset here and owned exclusively by the
// runtime attribute (applied synchronously before first paint).
function emitPanels(node, lines) {
  for (const p of node.children || []) {
    if (typeof p !== "number") continue;
    lines.push(`${selOf(p)} { position: absolute; top: 0; left: 0; right: 0; bottom: 0; width: auto; height: auto; opacity: 1; }`);
    lines.push(`${selOf(p)}[data-ws-hidden] { display: none; }`);
  }
}

export function workspaceCss(tree, opts = {}) {
  const lines = [
    "/* workspace reconstruction (task 3.4.2) — docking layout emitted from the",
    "   analyzed workspace tree (src/reconstruction/workspace-analyzer.js).",
    "   Flex nesting with explicit basis sizes from the captured rects; rules are",
    "   scoped under the generated page wrapper .cx-x so they outrank the",
    "   per-element px geometry in components.css. */",
  ];
  if (!tree || typeof tree.elementIndex !== "number") {
    lines.push("/* no workspace evidence — nothing emitted */");
    return lines.join("\n") + "\n";
  }
  if (Array.isArray(tree.stacks)) {
    for (const st of tree.stacks) emitSegment(st, null, null, lines, opts);
  }
  emitSegment(tree, null, null, lines, opts);
  // generic active-tab affordance styling (visuals beyond the captured
  // per-element styles — the clone swaps data-ws-active on tab clicks)
  lines.push(`.cx-x [data-ws-tab][data-ws-active] { font-weight: 700; }`);
  // collapsed panes show ONLY the rail strip: the runtime stamps
  // data-ws-collapsed on the pane (click + session-restore paths), and every
  // descendant except the collapse control itself (the un-collapse affordance
  // and its ancestor chain) leaves the layout. Without this, a restored
  // collapsed pane keeps its baked head-button widths — clipped by the pane's
  // overflow:hidden, but still reporting real rects, so coordinate-based
  // clickers and readers see invisible controls that cannot be hit.
  lines.push(`.cx-x [data-ws-collapsed] :not([data-ws-collapse]):not([data-ws-collapsed]):not(:has([data-ws-collapse])) { display: none; }`);
  return lines.join("\n") + "\n";
}

// ---------------------------------------------------------------------------
// Inline runtime config
// ---------------------------------------------------------------------------

export function workspaceConfig(tree, opts = {}) {
  const o = { ...DEFAULT_OPTS, ...(opts || {}) };
  const titles = {};
  const stacks = [];
  const walk = (node) => {
    if (!node || typeof node !== "object") return;
    if (node.kind === "pane" && node.title) titles[String(node.elementIndex)] = String(node.title).slice(0, 40);
    if (node.kind === "tabs" && node.stack != null) {
      stacks.push({ key: String(node.stack), active: node.activeTab ?? 0, panels: (node.children || []).length });
    }
    for (const c of node.children || []) if (typeof c !== "number") walk(c);
  };
  walk(tree);
  for (const st of tree?.stacks || []) {
    stacks.push({ key: String(st.elementIndex), active: st.visibleIndex ?? 0, panels: (st.children || []).length });
  }
  return { persist: o.persist !== false, minW: o.minW, minH: o.minH, railPx: o.railPx, titles, stacks };
}

export function workspaceConfigScript(tree, opts = {}) {
  const cfg = workspaceConfig(tree, opts);
  return `<script>window.__CLONER_WORKSPACE = ${JSON.stringify(cfg).replace(/</g, "\\u003c")};</script>`;
}

// ---------------------------------------------------------------------------
// Runtime behaviors (appended to runtime/interactions.js)
// ---------------------------------------------------------------------------

export const WORKSPACE_RUNTIME_MARK = "__CLONER_WORKSPACE_RUNTIME__";

// ES5, defensive: every lookup is guarded, and a page without the stamped
// data-ws-root attribute (or without the inline config) is a no-op.
export const WORKSPACE_RUNTIME = String.raw`
(function () {
  if (window.__CLONER_WORKSPACE_RUNTIME__) return;
  window.__CLONER_WORKSPACE_RUNTIME__ = true;
  var CFG = window.__CLONER_WORKSPACE || {};
  if (!document.querySelector("[data-ws-root]")) return;
  var MIN_W = CFG.minW || 120, MIN_H = CFG.minH || 80, RAIL = CFG.railPx || 28;
  var PERSIST = CFG.persist !== false;
  var KEY = "cloner-ws:" + (location.pathname || "index.html");
  var state = { sizes: {}, active: {}, hidden: [], collapsed: [], collapsedSizes: {} };
  var reopenCount = 0;

  function loadState() {
    if (!PERSIST) return;
    try {
      var raw = sessionStorage.getItem(KEY);
      if (!raw) return;
      var s = JSON.parse(raw);
      if (s && typeof s === "object") {
        state = {
          sizes: s.sizes || {}, active: s.active || {},
          hidden: s.hidden || [], collapsed: s.collapsed || [],
          collapsedSizes: s.collapsedSizes || {},
        };
      }
    } catch (e) {}
  }
  function saveState() {
    if (!PERSIST) return;
    try { sessionStorage.setItem(KEY, JSON.stringify(state)); } catch (e) {}
  }
  function paneOf(el) { return el && el.closest ? el.closest("[data-ws-pane]") : null; }
  function byI(key) { return document.querySelector('[data-ws-i="' + key + '"]'); }
  function basis(el, px) {
    if (!el) return;
    el.style.flexGrow = "0";
    el.style.flexShrink = "0";
    el.style.flexBasis = px + "px";
  }

  // ---- splitters: drag resizes the adjacent panes with min-size clamps ----
  // Sizes are persisted PER PANE (not per splitter pair): two splitters can share
  // a middle pane, and a pair snapshot taken before a later drag on the other
  // splitter would be stale and corrupt the shared pane on restore.
  document.addEventListener("mousedown", function (e) {
    var sp = e.target && e.target.closest ? e.target.closest("[data-ws-splitter]") : null;
    if (!sp) return;
    var prev = sp.previousElementSibling, next = sp.nextElementSibling;
    if (!prev || !next) return;
    var axis = sp.getAttribute("data-ws-axis") === "y" ? "y" : "x";
    var pr = prev.getBoundingClientRect(), nr = next.getBoundingClientRect();
    var startP = axis === "x" ? pr.width : pr.height;
    var startN = axis === "x" ? nr.width : nr.height;
    if (startP <= 0 || startN <= 0) return; // adjacent pane hidden — nothing to resize
    var min = axis === "x" ? MIN_W : MIN_H;
    var sx = e.clientX, sy = e.clientY;
    var prevKey = prev.getAttribute("data-ws-i");
    var nextKey = next.getAttribute("data-ws-i");
    var np = startP, nn = startN;
    e.preventDefault();
    function onMove(ev) {
      var d = axis === "x" ? ev.clientX - sx : ev.clientY - sy;
      np = startP + d; nn = startN - d;
      // two-sided clamp: when one side bottoms out at the min size the other
      // absorbs the remainder, so the pair total stays constant
      if (np < min) { np = min; nn = startN + (startP - min); }
      if (nn < min) { nn = min; np = startP + (startN - min); }
      basis(prev, np);
      basis(next, nn);
    }
    function onUp() {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
      if (prevKey) state.sizes[prevKey] = Math.round(np);
      if (nextKey) state.sizes[nextKey] = Math.round(nn);
      saveState();
    }
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  });

  // ---- tabs: click activates the tab's panel inside its stack ----
  function panelsOf(stackKey) {
    var stack = byI(stackKey);
    if (!stack) return [];
    var panels = [].slice.call(stack.querySelectorAll("[data-ws-panel]"));
    panels.sort(function (a, b) {
      return (parseInt(a.getAttribute("data-ws-panel-index"), 10) || 0) - (parseInt(b.getAttribute("data-ws-panel-index"), 10) || 0);
    });
    return panels;
  }
  function tabsOf(stackKey) {
    return [].slice.call(document.querySelectorAll('[data-ws-tab][data-ws-stack="' + stackKey + '"]'));
  }
  function activateTab(tab) {
    if (!tab) return;
    var stackKey = tab.getAttribute("data-ws-stack");
    var tabs = tabsOf(stackKey);
    var panels = panelsOf(stackKey);
    var idx = parseInt(tab.getAttribute("data-ws-tab-index"), 10) || 0;
    if (idx >= panels.length) idx = Math.max(0, panels.length - 1);
    for (var i = 0; i < tabs.length; i++) {
      if (tabs[i] === tab) tabs[i].setAttribute("data-ws-active", "1");
      else tabs[i].removeAttribute("data-ws-active");
    }
    for (var j = 0; j < panels.length; j++) {
      if (j === idx) panels[j].removeAttribute("data-ws-hidden");
      else panels[j].setAttribute("data-ws-hidden", "1");
    }
    if (stackKey) state.active[stackKey] = idx;
    saveState();
  }

  // ---- pane close → hide + reopen affordance ----
  function addReopen(pane, key) {
    if (document.querySelector('[data-cloner-reopen="' + key + '"]')) return;
    var b = document.createElement("button");
    b.setAttribute("data-cloner-reopen", key);
    var title = (CFG.titles && CFG.titles[key]) || pane.getAttribute("data-ws-title") || "Panel";
    b.textContent = "\u25a4 " + title;
    b.style.cssText = "position:fixed;left:8px;bottom:" + (8 + reopenCount * 36) + "px;z-index:2147481000;padding:6px 12px;font:12px/1.4 system-ui,sans-serif;background:#1f2937;color:#f9fafb;border:1px solid #4b5563;border-radius:6px;cursor:pointer;box-shadow:0 6px 18px rgba(0,0,0,.35)";
    reopenCount++;
    document.body.appendChild(b);
  }
  function hidePane(pane) {
    if (!pane) return;
    var key = pane.getAttribute("data-ws-i");
    pane.style.display = "none";
    pane.setAttribute("data-ws-off", "1");
    if (key && state.hidden.indexOf(key) < 0) state.hidden.push(key);
    saveState();
    if (key) addReopen(pane, key);
  }
  function showPane(key) {
    var pane = key != null ? document.querySelector('[data-ws-pane][data-ws-i="' + key + '"]') : null;
    if (pane) {
      pane.style.display = "";
      pane.removeAttribute("data-ws-off");
    }
    state.hidden = state.hidden.filter(function (k) { return k !== key; });
    saveState();
    var btn = document.querySelector('[data-cloner-reopen="' + key + '"]');
    if (btn && btn.parentNode) btn.parentNode.removeChild(btn);
  }

  // ---- collapse: pane shrinks to a rail, content clipped ----
  function toggleCollapse(btn) {
    var pane = paneOf(btn);
    if (!pane) return;
    var key = pane.getAttribute("data-ws-i");
    var collapsed = pane.getAttribute("data-ws-collapsed") === "1";
    if (collapsed) {
      pane.removeAttribute("data-ws-collapsed");
      var saved = state.collapsedSizes[key];
      if (saved) basis(pane, saved);
      state.collapsed = state.collapsed.filter(function (k) { return k !== key; });
    } else {
      var r = pane.getBoundingClientRect();
      state.collapsedSizes[key] = Math.round(r.width);
      pane.setAttribute("data-ws-collapsed", "1");
      basis(pane, RAIL);
      if (state.collapsed.indexOf(key) < 0) state.collapsed.push(key);
    }
    saveState();
  }

  document.addEventListener("click", function (e) {
    if (!e.target || !e.target.closest) return;
    var reopen = e.target.closest("[data-cloner-reopen]");
    if (reopen) { showPane(reopen.getAttribute("data-cloner-reopen")); e.preventDefault(); return; }
    var tab = e.target.closest("[data-ws-tab]");
    if (tab) { activateTab(tab); e.preventDefault(); return; }
    var closer = e.target.closest("[data-ws-close]");
    if (closer) { hidePane(paneOf(closer)); e.preventDefault(); return; }
    var rail = e.target.closest("[data-ws-collapse]");
    if (rail) { toggleCollapse(rail); e.preventDefault(); return; }
  });

  // ---- init: apply the captured-active tab, then restore saved state ----
  function applyInitialStacks() {
    var stacks = CFG.stacks || [];
    for (var i = 0; i < stacks.length; i++) {
      var st = stacks[i];
      if (state.active[st.key] !== undefined) continue; // saved state wins
      var panels = panelsOf(st.key);
      var tabs = tabsOf(st.key);
      var idx = Math.min(st.active || 0, Math.max(0, panels.length - 1));
      for (var t = 0; t < tabs.length; t++) {
        var ti = parseInt(tabs[t].getAttribute("data-ws-tab-index"), 10) || 0;
        if (ti === idx) tabs[t].setAttribute("data-ws-active", "1");
        else tabs[t].removeAttribute("data-ws-active");
      }
      for (var j = 0; j < panels.length; j++) {
        if (j === idx) panels[j].removeAttribute("data-ws-hidden");
        else panels[j].setAttribute("data-ws-hidden", "1");
      }
    }
  }
  function restore() {
    for (var key in state.sizes) {
      if (!Object.prototype.hasOwnProperty.call(state.sizes, key)) continue;
      // pane-keyed bases only — splitters/stack containers are never resized
      var pane = document.querySelector('[data-ws-pane][data-ws-i="' + key + '"]');
      if (pane) basis(pane, state.sizes[key]);
    }
    for (var sk in state.active) {
      if (!Object.prototype.hasOwnProperty.call(state.active, sk)) continue;
      var tabs = tabsOf(sk);
      var want = state.active[sk];
      for (var t = 0; t < tabs.length; t++) {
        if ((parseInt(tabs[t].getAttribute("data-ws-tab-index"), 10) || 0) === want) activateTab(tabs[t]);
      }
    }
    for (var h = 0; h < state.hidden.length; h++) {
      var pane = document.querySelector('[data-ws-pane][data-ws-i="' + state.hidden[h] + '"]');
      if (pane) {
        pane.style.display = "none";
        pane.setAttribute("data-ws-off", "1");
        addReopen(pane, state.hidden[h]);
      }
    }
    for (var c = 0; c < state.collapsed.length; c++) {
      var p2 = byI(state.collapsed[c]);
      if (p2) {
        p2.setAttribute("data-ws-collapsed", "1");
        basis(p2, RAIL);
      }
    }
  }
  loadState();
  applyInitialStacks();
  restore();
})();
`;

// extendRuntimeWorkspace(runtimeSrc) — appends the workspace behavior IIFE to a
// built runtime source (marker-guarded, so calling it twice is a no-op).
// Integration hook: see the module header — wrap buildRuntime(...) with this.
export function extendRuntimeWorkspace(runtimeSrc) {
  const src = String(runtimeSrc || "");
  if (src.includes(WORKSPACE_RUNTIME_MARK)) return src;
  return src + (src.endsWith("\n") || !src ? "" : "\n") + WORKSPACE_RUNTIME + "\n";
}

// ---------------------------------------------------------------------------
// Attribute stamping + one-call project augment
// ---------------------------------------------------------------------------

// locate the generated tag whose class carries cx-<cxIndex> and rewrite it
function editTagAttrs(html, cxIndex, mutate) {
  const m = new RegExp("cx-" + cxIndex + '(?=[" ])').exec(html);
  if (!m) return html;
  const start = html.lastIndexOf("<", m.index);
  const end = html.indexOf(">", m.index);
  if (start < 0 || end < 0 || end <= start) return html;
  const next = mutate(html.slice(start, end + 1));
  if (next === null || next === html.slice(start, end + 1)) return html;
  return html.slice(0, start) + next + html.slice(end + 1);
}

const dropReplayAttrs = (tag) => tag.replace(/\s(?:data-cloner-trigger|data-replay-id)="[^"]*"/g, "");
const addAttr = (tag, name, value) => (new RegExp(`\\s${name}="`).test(tag) ? tag : tag.replace(/\/?>$/, (tail) => ` ${name}="${value}"${tail.startsWith("/") ? " /" : ""}>`));

// flatten every managed element into { cx, attrs } pairs (deterministic order)
function wiringList(tree) {
  const out = [];
  const walk = (node, parentAxis, isRoot) => {
    if (!node || typeof node !== "object") return;
    if (node.kind === "row" || node.kind === "column") {
      const axis = node.axis === "y" ? "y" : "x";
      if (isRoot) out.push({ cx: node.elementIndex, attrs: [["data-ws-root", "1"], ["data-ws-axis", axis], ["data-ws-i", String(node.elementIndex)]] });
      for (const sp of node.splitters || []) {
        out.push({ cx: sp, attrs: [["data-ws-splitter", "1"], ["data-ws-axis", axis], ["data-ws-i", String(sp)]] });
      }
      for (const c of node.children || []) if (typeof c !== "number") walk(c, axis, false);
      return;
    }
    if (node.kind === "tabs") {
      // a tabs node is also a dock segment (it can be a splitter drag target and
      // its size must restore), so it carries data-ws-pane as well
      out.push({ cx: node.elementIndex, attrs: [["data-ws-tabs", "1"], ["data-ws-pane", "1"], ["data-ws-i", String(node.elementIndex)]] });
      if (node.strip != null) out.push({ cx: node.strip, attrs: [["data-ws-tabstrip", "1"], ["data-ws-i", String(node.strip)]] });
      if (node.stack != null) out.push({ cx: node.stack, attrs: [["data-ws-tabstack", "1"], ["data-ws-i", String(node.stack)]] });
      (node.tabs || []).forEach((t, k) => {
        if (t?.elementIndex != null) {
          out.push({ cx: t.elementIndex, attrs: [["data-ws-tab", "1"], ["data-ws-tab-index", String(k)], ["data-ws-stack", String(node.stack)]] });
        }
      });
      (node.children || []).forEach((p, k) => {
        if (typeof p === "number") out.push({ cx: p, attrs: [["data-ws-panel", "1"], ["data-ws-panel-index", String(k)]] });
      });
      return;
    }
    if (node.kind === "stack") {
      out.push({ cx: node.elementIndex, attrs: [["data-ws-tabstack", "1"], ["data-ws-i", String(node.elementIndex)]] });
      (node.children || []).forEach((p, k) => {
        if (typeof p === "number") out.push({ cx: p, attrs: [["data-ws-panel", "1"], ["data-ws-panel-index", String(k)]] });
      });
      return;
    }
    // pane leaf — segment of a dock row/column
    const attrs = [["data-ws-pane", "1"], ["data-ws-i", String(node.elementIndex)]];
    if (node.title) attrs.push(["data-ws-title", escAttr(node.title)]);
    if (parentAxis) attrs.push(["data-ws-axis", parentAxis === "y" ? "y" : "x"]);
    out.push({ cx: node.elementIndex, attrs });
    if (node.close != null) out.push({ cx: node.close, attrs: [["data-ws-close", "1"]] });
    if (node.collapse != null) out.push({ cx: node.collapse, attrs: [["data-ws-collapse", "1"]] });
  };
  for (const st of tree?.stacks || []) walk(st, null, false);
  walk(tree, null, true);
  return out;
}

// element indexes whose recorded replay attrs/records must be stripped: dock
// controls the workspace runtime owns (clicks/drag on them must never be
// hijacked by an overlay replay)
export function dockControlIndexes(tree) {
  const set = new Set();
  const walk = (node) => {
    if (!node || typeof node !== "object") return;
    if (node.kind === "row" || node.kind === "column") {
      for (const sp of node.splitters || []) set.add(sp);
      for (const c of node.children || []) if (typeof c !== "number") walk(c);
      return;
    }
    if (node.kind === "tabs") {
      for (const t of node.tabs || []) if (t?.elementIndex != null) set.add(t.elementIndex);
      return;
    }
    if (node.close != null) set.add(node.close);
    if (node.collapse != null) set.add(node.collapse);
  };
  for (const st of tree?.stacks || []) walk(st);
  walk(tree);
  return [...set];
}

// augmentProjectWithWorkspace(outDir, tree, opts) — one-call integration for
// reconstructFromArtifacts output (the docking counterpart of
// responsive-analyzer.augmentProjectWithResponsive).
// opts: { pages: ["index.html", ...], minW, minH, railPx, persist }
// Returns { applied, cssFile, runtimeExtended, linkInjected, configInjected,
//           wired, recordsStripped, files, notes }.
export function augmentProjectWithWorkspace(outDir, tree, opts = {}) {
  const notes = [];
  const result = { applied: false, cssFile: null, runtimeExtended: false, linkInjected: 0, configInjected: 0, wired: 0, recordsStripped: 0, files: [], notes };
  if (!tree || typeof tree.elementIndex !== "number") {
    notes.push("no workspace tree — nothing written (evidence gate returned null)");
    return result;
  }
  const pages = opts.pages && opts.pages.length ? opts.pages : ["index.html"];

  // 1) styles/workspace.css
  fs.mkdirSync(path.join(outDir, "styles"), { recursive: true });
  fs.writeFileSync(path.join(outDir, "styles", "workspace.css"), workspaceCss(tree, opts));
  result.cssFile = "styles/workspace.css";
  result.applied = true;

  // 2) runtime/interactions.js — append the workspace behaviors (idempotent)
  const runtimePath = path.join(outDir, "runtime", "interactions.js");
  fs.mkdirSync(path.join(outDir, "runtime"), { recursive: true });
  const src = fs.existsSync(runtimePath) ? fs.readFileSync(runtimePath, "utf8") : "";
  const extended = extendRuntimeWorkspace(src);
  if (extended !== src) {
    fs.writeFileSync(runtimePath, extended);
    result.runtimeExtended = true;
  }

  // 3) per-page: link + inline config + data-ws-* stamping + replay-attr drop
  const wiring = wiringList(tree);
  const controls = new Set(dockControlIndexes(tree));
  for (const rel of pages) {
    const fp = path.join(outDir, rel);
    if (!fs.existsSync(fp)) continue;
    let html = fs.readFileSync(fp, "utf8");
    const before = html;
    if (!html.includes("styles/workspace.css")) {
      const link = '<link rel="stylesheet" href="styles/workspace.css">';
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
    if (!html.includes("__CLONER_WORKSPACE")) {
      const cfgScript = workspaceConfigScript(tree, opts);
      if (html.includes('<script src="runtime/interactions.js"></script>')) {
        html = html.replace('<script src="runtime/interactions.js"></script>', "  " + cfgScript + '\n  <script src="runtime/interactions.js"></script>');
      } else if (html.includes("</body>")) {
        html = html.replace("</body>", "  " + cfgScript + "\n</body>");
      }
      result.configInjected++;
    } else {
      // idempotent re-augment with DIFFERENT opts (e.g. the pipeline augmented
      // with defaults, a caller re-augments with tuned min sizes): replace the
      // existing inline config so the new opts actually take effect
      const cfgScript = workspaceConfigScript(tree, opts);
      const re = /<script>window\.__CLONER_WORKSPACE = [\s\S]*?<\/script>/;
      if (re.test(html) && !html.includes(cfgScript)) {
        html = html.replace(re, cfgScript);
        result.configInjected++;
      }
    }
    for (const w of wiring) {
      const tag0 = html;
      let tag1 = null;
      html = editTagAttrs(html, w.cx, (tag) => {
        let t = dropReplayAttrs(tag);
        for (const [n, v] of w.attrs) t = addAttr(t, n, v);
        tag1 = t;
        return t;
      });
      // wired = the tag changed OR already carries every attr (an idempotent
      // re-augment must not report already-stamped dock elements as "not found")
      if (html !== tag0 || (tag1 && w.attrs.every(([n]) => new RegExp(`\\s${n}=`).test(tag1)))) result.wired++;
    }
    for (const cx of controls) {
      html = editTagAttrs(html, cx, dropReplayAttrs);
    }
    if (html !== before) {
      fs.writeFileSync(fp, html);
      result.files.push(rel);
    }
  }
  if (result.wired < wiring.length) {
    notes.push(`${wiring.length - result.wired} of ${wiring.length} dock elements not found in the generated page(s) — check the reconstruction output`);
  }

  // 4) strip recorded replay records for dock controls from the runtime data —
  //    findRec must never open a recorded overlay on a tab/close/collapse click
  try {
    const rt = fs.readFileSync(runtimePath, "utf8");
    const m = rt.match(/^window\.__CLONER_INTERACTIONS = (.*);$/m);
    if (m) {
      const recs = JSON.parse(m[1]);
      const kept = recs.filter((r) => !(r.domIndex !== undefined && controls.has(r.domIndex)));
      if (kept.length !== recs.length) {
        fs.writeFileSync(runtimePath, rt.replace(m[0], "window.__CLONER_INTERACTIONS = " + JSON.stringify(kept) + ";"));
        result.recordsStripped = recs.length - kept.length;
      }
    }
  } catch (e) {
    notes.push("replay-record strip skipped: " + String(e?.message || e).slice(0, 80));
  }
  return result;
}
