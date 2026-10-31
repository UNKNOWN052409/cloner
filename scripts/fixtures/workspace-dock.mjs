// Fixture site — dockable workspace (task 3.4.2): a 3-pane Golden-Layout-class
// interface — left sidebar (collapsible, closable), center tab group with TWO
// panels (tab switch), right panel (closable) — plus two splitter bars with
// mouse-drag resizing and min-size clamps. Solid inline CSS, zero dependencies.
//
// Design notes (matched to the capture stages):
//  - Exact geometry at the exploration viewport 1440x900: topbar 42px, dock-root
//    858px tall; panes 260 / 868 / 300 px + two 6px splitter bars (sums to 1440).
//  - The INACTIVE tab panel ("Positions") is hidden with opacity:0 +
//    visibility:hidden while KEEPING ITS BOX: the DOM extractor skips zero-size
//    boxes (src/intelligence/dom-extractor.js:19), so a display:none panel would
//    never reach dom.json and the clone could not reconstruct the second panel.
//    Hidden-but-measured panes are common in docking stacks; the captured
//    style.opacity === "0" is the visibility evidence the workspace analyzer
//    reads (see the capture-mapping header of src/reconstruction/workspace-analyzer.js).
//  - The two stacked panels get INCOMPARABLE boxes (1px offset: orders panel
//    sticks out 1px LEFT, positions panel 1px RIGHT). The extractor resolves
//    parents by geometric containment, and identical/nested boxes would make
//    the stack container and its panes each other's "smallest container",
//    producing 2-cycles in dom.json parent links (observed and documented in
//    src/reconstruction/workspace-analyzer.js — normalizeContainment).
//  - The inactive panel's content is a single LEAF div (≤60-char text, the
//    extractor's leaf-text cap): two overlapping panes' subtrees cannot be
//    separated by geometric containment at all — every child box of one pane
//    is contained in the other pane too, so a full subtree for both panes
//    cannot be captured correctly by this extractor generation. Hiding uses
//    opacity (not visibility) so innerText still yields the leaf's text.
//  - Class names deliberately AVOID the Phase 3.2 runtime's conventions
//    (no lm_*, "splitter", "sidebar", "close-button", "icon-close", "menu",
//    "modal"/"dialog"/"popup" substrings) so the clone's dock behaviors come
//    ONLY from the task 3.4.2 workspace runtime — no double-handling — and the
//    explorer's overlay detector never misreads a tab switch as an overlay.
//  - Tabs are plain divs (not buttons/roles) so markTriggers does not mark them;
//    the capture keeps the pristine state (Orders active). The ✕ and collapse
//    controls are real buttons (explorer may click them AFTER dom.json is
//    captured — the capture order in src/pipeline/exploration-pipeline.js:157-185
//    keeps the extracted DOM pristine).
//  - The tab strip and splitters carry token classes ("tab", "drag-bar") that
//    the workspace analyzer reads as docking evidence.
import { sendHtml, reqUrl } from "./server.mjs";

const html = `<!DOCTYPE html><html><head><title>Meridian — dockable workspace</title><style>
* { box-sizing: border-box; }
html, body { height: 100%; }
body { margin: 0; font-family: Arial, Helvetica, sans-serif; color: #1c2330; background: #f4f6fa; display: flex; flex-direction: column; height: 100vh; overflow: hidden; }
.topbar { flex: 0 0 42px; height: 42px; display: flex; align-items: center; gap: 12px; padding: 0 16px; background: #101828; color: #e7ecf5; font-size: 14px; }
.topbar .brand { width: 24px; height: 24px; background: #2e90fa; border-radius: 5px; }
.dock-root { flex: 1 1 auto; display: flex; min-height: 0; }
.pane { display: flex; flex-direction: column; min-width: 0; min-height: 0; overflow: hidden; background: #ffffff; }
.pane-left { flex: 0 0 260px; width: 260px; border-right: 0; }
.pane-right { flex: 0 0 300px; width: 300px; }
.pane-center { flex: 1 1 auto; background: #f8fafc; }
.pane-head { flex: 0 0 36px; height: 36px; display: flex; align-items: center; gap: 6px; padding: 0 10px; background: #e2e8f0; }
.pane-title { flex: 1; font-size: 13px; font-weight: bold; white-space: nowrap; overflow: hidden; }
.pane-rail, .pane-x { width: 22px; height: 22px; flex: 0 0 22px; border: 0; background: transparent; cursor: pointer; font-size: 14px; color: #475569; border-radius: 4px; }
.pane-rail:hover, .pane-x:hover { background: #cbd5e1; }
.pane-body { flex: 1 1 auto; overflow: auto; padding: 12px; font-size: 13px; line-height: 1.7; }
.pane-left.collapsed { flex-basis: 28px; width: 28px; }
.pane-left.collapsed .pane-title, .pane-left.collapsed .pane-x, .pane-left.collapsed .pane-body { display: none; }
.drag-bar { flex: 0 0 6px; width: 6px; background: #cbd5e1; cursor: col-resize; }
.drag-bar:hover, .drag-bar.dragging { background: #94a3b8; }
.tabstrip { flex: 0 0 36px; height: 36px; display: flex; align-items: stretch; background: #dde5ef; }
.tab { padding: 0 18px; display: flex; align-items: center; font-size: 13px; cursor: pointer; background: #cdd7e4; border-right: 1px solid #b9c5d4; user-select: none; }
.tab.active { background: #ffffff; font-weight: bold; }
.tabstack { flex: 1 1 auto; position: relative; min-height: 0; }
/* panels are 1px-offset INCOMPARABLE boxes (see header): orders sticks out
   1px left, positions 1px right — geometric containment then resolves
   tabstack as the parent of both, with no cycles.
   Inactive panes hide via OPACITY ONLY (never visibility:hidden): innerText
   of visibility:hidden elements is "" so the extractor would capture no text;
   opacity keeps innerText intact while pointer-events:none keeps the hidden
   pane from intercepting exploration clicks. */
.panel { position: absolute; padding: 14px 16px; overflow: auto; font-size: 13px; line-height: 1.7; background: #ffffff; opacity: 0; pointer-events: none; }
.panel.on { opacity: 1; pointer-events: auto; }
.panel-orders { top: 1px; left: 0; right: 1px; bottom: 1px; }
.panel-positions { top: 1px; left: 1px; right: 0; bottom: 1px; }
.reopen-chip { position: fixed; left: 8px; bottom: 8px; z-index: 50; padding: 6px 12px; font: 12px/1.4 Arial, sans-serif; background: #1f2937; color: #f9fafb; border: 1px solid #4b5563; border-radius: 6px; cursor: pointer; }
</style></head><body>
<div class="topbar"><div class="brand"></div><div>Meridian trading workspace</div></div>
<div class="dock-root">
  <div class="pane pane-left" id="pane-left">
    <div class="pane-head">
      <div class="pane-title">Watchlist</div>
      <button class="pane-rail" type="button" id="rail-left">&#8249;</button>
      <button class="pane-x" type="button" id="x-left">&#10005;</button>
    </div>
    <div class="pane-body">
      <div>EUR USD 1.0842</div>
      <div>GBP USD 1.2718</div>
      <div>USD JPY 151.32</div>
      <div>AUD USD 0.6541</div>
      <div>USD CHF 0.9012</div>
      <div>NZD USD 0.5988</div>
    </div>
  </div>
  <div class="drag-bar" id="bar-left"></div>
  <div class="pane pane-center">
    <div class="tabstrip" id="tabstrip">
      <div class="tab active" data-panel="orders">Orders</div>
      <div class="tab" data-panel="positions">Positions</div>
    </div>
    <div class="tabstack" id="tabstack">
      <div class="panel panel-orders on" id="panel-orders">
        <div>Working orders blotter</div>
        <div>Buy 10 ES 5212.25 working</div>
        <div>Sell 5 CL 82.14 working</div>
        <div>Buy 2 NQ 18120.50 filled</div>
        <div>Sell 1 GC 2384.60 working</div>
      </div>
      <div class="panel panel-positions" id="panel-positions">Open positions blotter: ES long 12, CL short 4, GC flat</div>
    </div>
  </div>
  <div class="drag-bar" id="bar-right"></div>
  <div class="pane pane-right" id="pane-right">
    <div class="pane-head">
      <div class="pane-title">Depth of market</div>
      <button class="pane-x" type="button" id="x-right">&#10005;</button>
    </div>
    <div class="pane-body">
      <div>Bid 5212.00 x 18</div>
      <div>Bid 5211.75 x 24</div>
      <div>Bid 5211.50 x 31</div>
      <div>Ask 5212.25 x 12</div>
      <div>Ask 5212.50 x 27</div>
      <div>Ask 5212.75 x 44</div>
    </div>
  </div>
</div>
<script>
// original workspace behavior: tab switching, splitter dragging with min-size
// clamps, pane collapse to a rail, pane close with a reopen chip
(function () {
  var panels = { orders: document.getElementById("panel-orders"), positions: document.getElementById("panel-positions") };
  function activate(name) {
    var tabs = document.querySelectorAll(".tab");
    for (var i = 0; i < tabs.length; i++) {
      if (tabs[i].getAttribute("data-panel") === name) tabs[i].classList.add("active");
      else tabs[i].classList.remove("active");
    }
    for (var k in panels) {
      if (k === name) panels[k].classList.add("on");
      else panels[k].classList.remove("on");
    }
  }
  var strip = document.getElementById("tabstrip");
  strip.addEventListener("click", function (e) {
    var tab = e.target.closest ? e.target.closest(".tab") : null;
    if (tab) activate(tab.getAttribute("data-panel"));
  });
  function makeDrag(barId, minPx) {
    var bar = document.getElementById(barId);
    bar.addEventListener("mousedown", function (e) {
      e.preventDefault();
      bar.classList.add("dragging");
      var prev = bar.previousElementSibling, next = bar.nextElementSibling;
      var pr = prev.getBoundingClientRect(), nr = next.getBoundingClientRect();
      var sw = pr.width, nw = nr.width, sx = e.clientX;
      function onMove(ev) {
        var d = ev.clientX - sx;
        var np = Math.max(minPx, sw + d), nn = Math.max(minPx, nw - d);
        if (np <= minPx) nn = nw + (sw - minPx);
        if (nn <= minPx) np = sw + (nw - minPx);
        prev.style.width = np + "px";
        prev.style.flex = "0 0 " + np + "px";
        next.style.width = nn + "px";
        next.style.flex = "0 0 " + nn + "px";
      }
      function onUp() {
        bar.classList.remove("dragging");
        document.removeEventListener("mousemove", onMove);
        document.removeEventListener("mouseup", onUp);
      }
      document.addEventListener("mousemove", onMove);
      document.addEventListener("mouseup", onUp);
    });
  }
  makeDrag("bar-left", 140);
  makeDrag("bar-right", 140);
  document.getElementById("rail-left").addEventListener("click", function () {
    document.getElementById("pane-left").classList.toggle("collapsed");
  });
  function wireClose(btnId, paneId, title) {
    document.getElementById(btnId).addEventListener("click", function () {
      var pane = document.getElementById(paneId);
      pane.style.display = "none";
      var chip = document.createElement("button");
      chip.type = "button";
      chip.className = "reopen-chip";
      chip.setAttribute("data-reopen", paneId);
      chip.textContent = "\\u25a4 " + title;
      document.body.appendChild(chip);
      chip.addEventListener("click", function () {
        pane.style.display = "";
        if (chip.parentNode) chip.parentNode.removeChild(chip);
      });
    });
  }
  wireClose("x-left", "pane-left", "Watchlist");
  wireClose("x-right", "pane-right", "Depth of market");
})();
</script></body></html>`;

export const workspaceDockSite = {
  name: "workspace-dock",
  entry: "/",
  handle(req, res) {
    if (reqUrl(req).pathname === "/") {
      sendHtml(res, html);
      return;
    }
    res.writeHead(404, { "content-type": "text/plain" });
    res.end("fixture: not found");
  },
};

// the raw page, exported for direct assertions (unit checks, visual diffs)
export const workspaceDockHtml = html;
