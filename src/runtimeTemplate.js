// Build the interaction-replay runtime script for a clone.
// records: [{ id, kind: "overlay"|"module", text, html, box,
//             pageId?, domIndex?, path?, page? }] — pageId/domIndex are
// reconstruction bookkeeping; path (structural DOM path of the recorded
// element) and page (generated file of its page) drive the runtime's exact
// element matching, with the text signature kept as last resort.
//
// Task 3.5.8 hardening (all additive — existing replay behavior unchanged):
//   - error isolation: every delegated handler runs inside try/catch; failures
//     are recorded on window.__CLONER_RUNTIME.errors instead of breaking the page
//   - missing assets: capture-phase error listener swaps broken <img> for an
//     inline SVG placeholder and counts failed <script>/<link> resources
//   - idempotent replays: re-clicking the same record toggles its replay
//     (overlay or module) instead of stacking copies; modules are capped
//   - Escape closes overlays AND modules; idle Escape is a no-op
//   - splitter drags clean their document mousemove/mouseup listeners even on
//     window blur (no listener leaks after many clicks)
//   - boot status exposed at window.__CLONER_RUNTIME for verification tooling
export function buildRuntime(interactions) {
  return (
    "window.__CLONER_INTERACTIONS = " +
    JSON.stringify(interactions || []) +
    ";\n" +
    IIFE
  );
}

const IIFE = String.raw`(function () {
  var RT = (window.__CLONER_RUNTIME = window.__CLONER_RUNTIME || {
    version: "3.5.8", status: "boot", records: 0,
    errors: [], assetFallbacks: 0, resourceFailures: 0, moduleCap: 6,
  });
  function rtError(where, err) {
    var msg = where + ": " + (err && err.message ? err.message : String(err));
    if (RT.errors.length < 20) RT.errors.push(msg.slice(0, 200));
    try { console.warn("[cloner-runtime] " + msg); } catch (e) { /* isolate */ }
  }

  // ---- MISSING-ASSET FALLBACK (runs first: works even if later boot fails) ----
  // resource error events do not bubble but ARE visible in the capture phase;
  // broken <img> gets a visible placeholder instead of a broken-image glyph,
  // failed <script>/<link> are counted and tolerated. A page error from one
  // missing asset must never take down the generated page.
  var PLACEHOLDER_IMG =
    "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='120' height='80'%3E%3Crect width='100%25' height='100%25' fill='%23e5e7eb'/%3E%3Ctext x='50%25' y='54%25' text-anchor='middle' font-size='11' fill='%239ca3af'%3Eimg%3C/text%3E%3C/svg%3E";
  try {
    document.addEventListener("error", function (e) {
      try {
        var t = e.target;
        if (!t || !t.tagName) return;
        var tag = t.tagName.toLowerCase();
        if (tag === "img") {
          if (t.getAttribute("data-cloner-asset-fallback")) return; // swap once
          t.setAttribute("data-cloner-asset-fallback", "1");
          if (t.getAttribute("srcset")) t.removeAttribute("srcset");
          t.src = PLACEHOLDER_IMG;
          RT.assetFallbacks++;
        } else if (tag === "script" || tag === "link") {
          RT.resourceFailures++;
        }
      } catch (err) { rtError("asset-fallback", err); }
    }, true);
  } catch (err) { rtError("asset-fallback-listener", err); }

  try {
  var DATA = window.__CLONER_INTERACTIONS || [];
  var byId = {};
  var bySig = [];
  var pathMap = {}; // structural path → record (reconstruction derives rec.path)
  for (var i = 0; i < DATA.length; i++) {
    byId[DATA[i].id] = DATA[i];
    // structural path map: rec.path identifies the EXACT recorded element in the
    // clone ("tag.firstClass:nth-of-type(k)" chain) — resolves duplicate/same-text
    // controls that attribute and text matching cannot tell apart
    if (DATA[i].path && !pathMap[DATA[i].path]) pathMap[DATA[i].path] = DATA[i];
    // signature fallback: after a SPA re-render the data-cloner-* ids can vanish;
    // match by stable signature (text/label/class) instead of losing the record
    var sig = (DATA[i].text || "").trim().toLowerCase();
    if (sig && sig.length >= 3) bySig.push({ sig: sig, rec: DATA[i] });
  }
  var openOverlay = null;
  var openModules = [];
  var MAX_MODULES = RT.moduleCap;

  // elements the runtime itself inserted (replayed overlays/modules) are never
  // part of a structural page path — counting them would shift nth-of-type
  function isReplayUi(n) {
    return !!(n.getAttribute && (n.getAttribute("data-cloner-overlay") || n.getAttribute("data-cloner-module")));
  }
  // stable structural path of el: tag.firstClass:nth-of-type(k) chain up to
  // body — the mirror of structuralPathFor() in the reconstruction pipeline.
  // The clone keeps only the first captured class plus the generator's cx-N,
  // so cx-* tokens are skipped when picking the class. Returns null when el
  // sits inside replay UI (no page path exists there).
  function domPath(el) {
    var parts = [];
    var node = el;
    var guard = 0;
    while (node && node.tagName && node !== document.body && guard < 24) {
      guard++;
      if (isReplayUi(node)) return null;
      var tag = node.tagName.toLowerCase();
      var cls = "";
      var cl = node.classList;
      if (cl) {
        for (var ci = 0; ci < cl.length; ci++) {
          if (!/^cx-\d+$/.test(cl[ci])) { cls = cl[ci]; break; }
        }
      }
      var k = 0;
      var par = node.parentElement;
      var sib = par ? par.children : [];
      for (var si = 0; si < sib.length; si++) {
        var s = sib[si];
        if (!s.tagName || s.tagName !== node.tagName) continue;
        if (s !== node && isReplayUi(s)) continue;
        k++;
        if (s === node) break;
      }
      parts.unshift(tag + (cls ? "." + cls : "") + ":nth-of-type(" + k + ")");
      node = par;
    }
    return parts.length ? parts.join(">") : null;
  }
  // structural records annotated with rec.page (their generated file) must
  // belong to the page this runtime is serving — two pages can contain the
  // same structure at the same path. file:// paths keep their file name too.
  function pageMatches(rec) {
    if (!rec.page) return true;
    var cur = String((location.pathname || "").split("/").pop() || "index.html");
    if (cur && cur.indexOf(".") < 0) cur += ".html";
    return rec.page === cur;
  }

  // walk up from the click target, in priority order:
  //  1. attribute match — page triggers (tN) + overlay-inner entries (mN)
  //  2. data-replay-id — emitted by the generator for every wired element
  //     (survives capture-attr pruning / re-renders)
  //  3. structural DOM path — exact element identity (rec.path)
  //  4. text signature — LAST resort (stable across re-renders, but ambiguous
  //     on duplicate controls)
  function findRec(target) {
    var node = target;
    while (node && node.getAttribute) {
      var id = node.getAttribute && (node.getAttribute("data-cloner-trigger") || node.getAttribute("data-cloner-inner"));
      if (id && byId[id]) return byId[id];
      var rid = node.getAttribute && node.getAttribute("data-replay-id");
      if (rid && byId[rid]) return byId[rid];
      node = node.parentNode;
    }
    var snode = target;
    for (var sp = 0; snode && snode.tagName && sp < 16; sp++) {
      if (isReplayUi(snode)) break; // clicked inside a replayed overlay/module
      var p = domPath(snode);
      if (p && pathMap[p] && pageMatches(pathMap[p])) return pathMap[p];
      snode = snode.parentElement;
    }
    var el = target && target.closest ? target : null;
    for (var j = 0; el && j < 4; j++) {
      var t = (el.innerText || el.getAttribute && (el.getAttribute("aria-label") || el.getAttribute("title")) || "").trim().toLowerCase();
      if (t) {
        for (var k = 0; k < bySig.length; k++) {
          if (bySig[k].sig === t || (t.length >= 3 && bySig[k].sig.indexOf(t) === 0)) return bySig[k].rec;
        }
      }
      el = el.parentElement;
    }
    return null;
  }
  function closeOverlay() {
    if (openOverlay && openOverlay.parentNode) openOverlay.parentNode.removeChild(openOverlay);
    openOverlay = null;
  }
  function closeModule(wrap) {
    if (wrap && wrap.parentNode) wrap.parentNode.removeChild(wrap);
    for (var mi = 0; mi < openModules.length; mi++) {
      if (openModules[mi] === wrap) { openModules.splice(mi, 1); break; }
    }
  }
  function closeAllModules() {
    for (var ci = 0; ci < openModules.length; ci++) {
      var w = openModules[ci];
      if (w && w.parentNode) w.parentNode.removeChild(w);
    }
    openModules = [];
  }
  // idempotent: re-opening the same record toggles it closed (multi-click can
  // never stack copies of one replay); module count stays capped
  function findOpenFor(recId, kind) {
    if (kind === "module") {
      for (var fi = 0; fi < openModules.length; fi++) {
        if (openModules[fi].getAttribute("data-cloner-for") === recId) return openModules[fi];
      }
    }
    return null;
  }
  function buildReplay(rec, kind) {
    var wrap = document.createElement("div");
    wrap.setAttribute("data-cloner-" + kind, "1");
    if (rec.id) wrap.setAttribute("data-cloner-for", String(rec.id));
    wrap.innerHTML = rec.html;
    var b = rec.box || {};
    if (kind === "module") {
      wrap.style.cssText =
        "position:fixed;left:" + (b.x || 60) + "px;top:" + (b.y || 80) + "px;z-index:2147482000;" +
        (b.w ? "width:" + b.w + "px;" : "") + (b.h ? "height:" + b.h + "px;" : "") +
        "overflow:hidden;background:#141824;color:#e7ecf5;box-shadow:0 24px 70px rgba(0,0,0,.55);border:1px solid rgba(255,255,255,.14);";
      var bar = document.createElement("div");
      bar.setAttribute("data-cloner-modulebar", "1");
      bar.style.cssText = "display:flex;align-items:center;background:#0d1119;border-bottom:1px solid rgba(255,255,255,.12);height:24px;user-select:none";
      bar.innerHTML =
        '<span style="flex:1;font:11px/24px system-ui;color:#8b94a7;padding:0 8px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">' +
        (rec.text || "Module").replace(/</g, "&lt;") +
        '</span><span data-cloner-modclose title="close" style="cursor:pointer;padding:0 10px;font:12px/24px system-ui;color:#ff7262">\u2715</span>';
      wrap.insertBefore(bar, wrap.firstChild);
    } else {
      wrap.style.cssText =
        "position:fixed;left:" + (b.x || 0) + "px;top:" + (b.y || 0) + "px;z-index:2147483000;" +
        (b.w ? "width:" + b.w + "px;" : "") + (b.h ? "max-height:" + b.h + "px;" : "");
    }
    return wrap;
  }
  function openModule(rec) {
    var existing = findOpenFor(rec.id, "module");
    if (existing) { closeModule(existing); return; } // multi-click toggle
    var wrap = buildReplay(rec, "module");
    document.body.appendChild(wrap);
    openModules.push(wrap);
    while (openModules.length > MAX_MODULES) {
      var oldest = openModules.shift(); // keep memory bounded on heavy replays
      if (oldest && oldest.parentNode) oldest.parentNode.removeChild(oldest);
    }
  }

  document.addEventListener(
    "click",
    function (e) {
      try {
      // 0) APP PANEL CLOSE BUTTONS — the stripped app's own ✕ controls (Golden
      // Layout module headers, tab closes, sidebar close). These must run BEFORE
      // recorded-trigger replay: findRec would otherwise hit an unrelated marked
      // ancestor and open a random overlay instead of closing the panel.
      // Container-aware: hide the nearest real panel (lm_content → module → sidebar).
      var appClose = e.target.closest && e.target.closest('.icon-close, [class*="icon-close"], [class*="close-button"], [data-testid="sidebar-close-btn"], [title="close"], [title="Close"]');
      if (appClose && !e.target.closest("[data-cloner-overlay]:not([data-cloner-module])") && !(e.target.closest && e.target.closest("[data-cloner-module]"))) {
        var pnl =
          appClose.closest(".lm_content") ||
          appClose.closest("[class*='module']:not([data-cloner-module])") ||
          appClose.closest("[class*='app-sidebar']") ||
          appClose.closest("[class*='sidebar']");
        if (pnl && pnl.getBoundingClientRect().width > 40) {
          pnl.style.display = "none";
          pnl.setAttribute("data-cloner-hidden", "1");
          e.preventDefault();
          e.stopPropagation();
          return;
        }
      }
      // 1) close affordances inside replays (panel/module ✕, dialog close buttons)
      var closer = e.target.closest && e.target.closest('[data-cloner-modclose],[data-testid="close-button"],[class*="icon-close"],[class*="close-button"]');
      if (closer) {
        var mod = closer.closest("[data-cloner-module]");
        if (mod) {
          closeModule(mod);
          e.preventDefault(); e.stopPropagation();
          return;
        }
        var ov = closer.closest("[data-cloner-overlay]");
        if (ov) {
          ov.parentNode && ov.parentNode.removeChild(ov);
          if (ov === openOverlay) openOverlay = null;
          e.preventDefault(); e.stopPropagation();
          return;
        }
      }
      // 2) recorded triggers / picker entries — idempotent by REPLACEMENT for
      // overlays (re-click re-opens the same single overlay, never stacks a
      // copy — the established A1 contract); modules toggle via openModule
      var rec = findRec(e.target);
      if (rec) {
        e.preventDefault(); e.stopPropagation();
        if (rec.kind === "module") { openModule(rec); return; }
        if (openOverlay) closeOverlay();
        var wrap = buildReplay(rec, "overlay");
        document.body.appendChild(wrap);
        openOverlay = wrap;
        return;
      }
      // 2b) TOPBAR APP-CONTROLS: .btn-wrap controls (add-module, trade, settings…)
      // map to captured records by wrapper class — the topbar was recorded too
      var wrap2 = e.target.closest && e.target.closest(".btn-wrap");
      if (wrap2) {
        var wcls = String(wrap2.className);
        var topRec = null;
        if (/add-module/.test(wcls)) topRec = DATA.find(function (r) { return r.kind === "overlay" && /data-cloner-inner/.test(r.html || ""); });
        else if (/trade/.test(wcls)) topRec = DATA.find(function (r) { return /order ticket/i.test(r.text || "") || /order ticket/i.test(r.html || ""); });
        else if (/settings/.test(wcls)) topRec = DATA.find(function (r) { return /settings/i.test(r.text || "") && r.kind === "overlay"; });
        if (topRec) {
          e.preventDefault();
          e.stopPropagation();
          if (topRec.kind === "module") { openModule(topRec); return; }
          if (openOverlay) closeOverlay();
          var twrap = buildReplay(topRec, "overlay");
          document.body.appendChild(twrap);
          openOverlay = twrap;
          return;
        }
      }
      // 3) outside click closes the top overlay (modules stay)
      if (openOverlay && !(e.target.closest && e.target.closest("[data-cloner-overlay]"))) closeOverlay();
      } catch (err) { rtError("click", err); }
    },
    true,
  );
  document.addEventListener("keydown", function (e) {
    try {
      if (e.key === "Escape") {
        closeOverlay();
        closeAllModules(); // Escape tears down every replay, not only the overlay
        // restore app panels hidden via ✕ — nothing is lost permanently
        var hidden = document.querySelectorAll("[data-cloner-hidden]");
        for (var h = 0; h < hidden.length; h++) {
          hidden[h].style.display = "";
          hidden[h].removeAttribute("data-cloner-hidden");
        }
      }
    } catch (err) { rtError("keydown", err); }
  });

  // ---- APP-CONTROL WIRING: Golden Layout panels, sidebars, splitters ----
  // The real app's JS is stripped from the clone; these delegated handlers
  // restore the panel behaviors Tradovate gives: close ✕, sidebar toggles,
  // splitter drags (multi-chart "shape" control). Recorded overlays are handled
  // by the capture-phase listener above; this bubble-phase listener handles the rest.
  function appPanelOf(el) {
    return el.closest(".lm_content") || el.closest(".lm_item") || el.closest("[class*='module']:not([data-cloner-module])") || null;
  }
  document.addEventListener(
    "click",
    function (e) {
      try {
      if (!e.target.closest) return;
      var tid = e.target.getAttribute ? e.target.getAttribute("data-testid") || "" : "";
      // 1) panel close buttons (module ✕, tab close, sidebar close)
      var closer = e.target.closest('[data-testid="sidebar-close-btn"], .icon-close, [class*="icon-close"], [class*="close-button"], [title="close"], [title="Close"]');
      if (closer) {
        var panel = appPanelOf(closer);
        if (panel) {
          panel.style.display = "none";
          e.preventDefault();
          e.stopPropagation();
          return;
        }
        // sidebar close: hide the whole sidebar column
        if (/(sidebar|close)/i.test(tid || closer.getAttribute("data-testid") || "")) {
          var sb = document.querySelector(".app-sidebar, [class*='app-sidebar'], [class*='sidebar']:not([class*='close'])");
          if (sb) { sb.style.display = "none"; e.preventDefault(); e.stopPropagation(); return; }
        }
      }
      // 2) sidebar show/hide toggles (data-testid="sidebar-<something>")
      if (tid.indexOf("sidebar-") === 0 && tid !== "sidebar-close-btn") {
        var sbs = document.querySelectorAll(".app-sidebar, [class*='app-sidebar']");
        for (var i = 0; i < sbs.length; i++) {
          var s = sbs[i];
          s.style.display = s.style.display === "none" ? "" : "none";
        }
        e.preventDefault();
        e.stopPropagation();
        return;
      }
      // 3) module tab clicks (Golden Layout tabs): activate the tab's panel
      var gtab = e.target.closest && e.target.closest(".lm_tab");
      if (gtab && gtab.parentElement) {
        var tabs = gtab.parentElement.children;
        for (var j = 0; j < tabs.length; j++) tabs[j].classList && tabs[j].classList.remove("lm_active");
        gtab.classList.add("lm_active");
      }
      } catch (err) { rtError("app-panel-click", err); }
    },
    false,
  );

  // splitter drags — the multi-chart "shape": dragging the divider resizes the
  // adjacent panels (Golden Layout .lm_splitter / generic [class*=splitter])
  document.addEventListener("mousedown", function (e) {
    try {
      var sp = e.target.closest && e.target.closest(".lm_splitter, [class*='splitter']");
      if (!sp) return;
      e.preventDefault();
      var r = sp.getBoundingClientRect();
      var vertical = r.width <= r.height; // tall thin bar → drag horizontally
      var prev = sp.previousElementSibling;
      var next = sp.nextElementSibling;
      if (!prev || !next) return;
      var pr = prev.getBoundingClientRect();
      var nr = next.getBoundingClientRect();
      var sx = e.clientX, sy = e.clientY;
      function onMove(ev) {
        var dx = ev.clientX - sx, dy = ev.clientY - sy;
        if (vertical) {
          prev.style.width = Math.max(120, pr.width + dx) + "px";
          next.style.width = Math.max(120, nr.width - dx) + "px";
        } else {
          prev.style.height = Math.max(80, pr.height + dy) + "px";
          next.style.height = Math.max(80, nr.height - dy) + "px";
        }
      }
      function onUp() {
        document.removeEventListener("mousemove", onMove);
        document.removeEventListener("mouseup", onUp);
        window.removeEventListener("blur", onUp); // drag teardown even if focus is lost
      }
      document.addEventListener("mousemove", onMove);
      document.addEventListener("mouseup", onUp);
      window.addEventListener("blur", onUp, { once: true });
    } catch (err) { rtError("splitter", err); }
  });

  RT.records = DATA.length;
  RT.status = "ok";
  } catch (err) {
    RT.status = "error";
    rtError("boot", err); // a boot failure must not break the generated page itself
  }
})();`;
