// Build the interaction-replay runtime script for a clone.
// records: [{ id, kind: "overlay"|"module", text, html, box }]
export function buildRuntime(interactions) {
  return (
    "window.__CLONER_INTERACTIONS = " +
    JSON.stringify(interactions || []) +
    ";\n" +
    IIFE
  );
}

const IIFE = String.raw`(function () {
  var DATA = window.__CLONER_INTERACTIONS || [];
  var byId = {};
  var bySig = [];
  for (var i = 0; i < DATA.length; i++) {
    byId[DATA[i].id] = DATA[i];
    // signature fallback: after a SPA re-render the data-cloner-* ids can vanish;
    // match by stable signature (text/label/class) instead of losing the record
    var sig = (DATA[i].text || "").trim().toLowerCase();
    if (sig && sig.length >= 3) bySig.push({ sig: sig, rec: DATA[i] });
  }
  var openOverlay = null;
  var openModules = [];

  // walk up from the click target: page triggers (tN/mN) by attribute, then by
  // text signature (stable across re-renders)
  function findRec(target) {
    var node = target;
    while (node && node.getAttribute) {
      var id = node.getAttribute && (node.getAttribute("data-cloner-trigger") || node.getAttribute("data-cloner-inner"));
      if (id && byId[id]) return byId[id];
      node = node.parentNode;
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
  function openModule(rec) {
    var wrap = document.createElement("div");
    wrap.setAttribute("data-cloner-module", "1");
    wrap.innerHTML = rec.html;
    var b = rec.box || {};
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
    document.body.appendChild(wrap);
    openModules.push(wrap);
  }

  document.addEventListener(
    "click",
    function (e) {
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
          mod.parentNode && mod.parentNode.removeChild(mod);
          openModules = openModules.filter(function (m) { return m !== mod; });
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
      // 2) recorded triggers / picker entries
      var rec = findRec(e.target);
      if (rec) {
        e.preventDefault(); e.stopPropagation();
        if (rec.kind === "module") { openModule(rec); return; }
        if (openOverlay) closeOverlay();
        var wrap = document.createElement("div");
        wrap.setAttribute("data-cloner-overlay", "1");
        wrap.innerHTML = rec.html;
        var b = rec.box || {};
        wrap.style.cssText =
          "position:fixed;left:" + (b.x || 0) + "px;top:" + (b.y || 0) + "px;z-index:2147483000;" +
          (b.w ? "width:" + b.w + "px;" : "") + (b.h ? "max-height:" + b.h + "px;" : "");
        document.body.appendChild(wrap);
        openOverlay = wrap;
        return;
      }
      // 2b) TOPBAR APP-CONTROLS: .btn-wrap controls (add-module, trade, settings…)
      // map to captured records by wrapper class — the topbar was recorded too
      var wrap = e.target.closest && e.target.closest(".btn-wrap");
      if (wrap) {
        var wcls = String(wrap.className);
        var topRec = null;
        if (/add-module/.test(wcls)) topRec = DATA.find(function (r) { return r.kind === "overlay" && /data-cloner-inner/.test(r.html || ""); });
        else if (/trade/.test(wcls)) topRec = DATA.find(function (r) { return /order ticket/i.test(r.text || "") || /order ticket/i.test(r.html || ""); });
        else if (/settings/.test(wcls)) topRec = DATA.find(function (r) { return /settings/i.test(r.text || "") && r.kind === "overlay"; });
        if (topRec) {
          e.preventDefault();
          e.stopPropagation();
          if (topRec.kind === "module") { openModule(topRec); return; }
          if (openOverlay) closeOverlay();
          var twrap = document.createElement("div");
          twrap.setAttribute("data-cloner-overlay", "1");
          twrap.innerHTML = topRec.html;
          var tb = topRec.box || {};
          twrap.style.cssText =
            "position:fixed;left:" + (tb.x || 0) + "px;top:" + (tb.y || 0) + "px;z-index:2147483000;" +
            (tb.w ? "width:" + tb.w + "px;" : "") + (tb.h ? "max-height:" + tb.h + "px;" : "");
          document.body.appendChild(twrap);
          openOverlay = twrap;
          return;
        }
      }
      // 3) outside click closes the top overlay (modules stay)
      if (openOverlay && !(e.target.closest && e.target.closest("[data-cloner-overlay]"))) closeOverlay();
    },
    true,
  );
  document.addEventListener("keydown", function (e) {
    if (e.key === "Escape") {
      closeOverlay();
      // restore app panels hidden via ✕ — nothing is lost permanently
      var hidden = document.querySelectorAll("[data-cloner-hidden]");
      for (var h = 0; h < hidden.length; h++) {
        hidden[h].style.display = "";
        hidden[h].removeAttribute("data-cloner-hidden");
      }
    }
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
    },
    false,
  );

  // splitter drags — the multi-chart "shape": dragging the divider resizes the
  // adjacent panels (Golden Layout .lm_splitter / generic [class*=splitter])
  document.addEventListener("mousedown", function (e) {
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
    }
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  });
})();`;
