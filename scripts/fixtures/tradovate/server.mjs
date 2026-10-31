// Tradovate-class trading-workspace fixture (Phase 3.4 benchmark) — a
// DETERMINISTIC, synthetic market-data platform that emulates the Tradovate
// UI shape: docked panes with splitters, a tabbed working-orders/positions
// stack, a watchlist, an order-ticket overlay, a live market ticker strip and
// quotes table driven by a same-origin WebSocket, and responsive breakpoints.
//
// SAFETY CONTRACT (benchmark requirement):
//   - NO real account data, NO credentials, NO login form, NO PII anywhere.
//   - Every market value is SYNTHETIC and produced by the pure deterministic
//     math below (priceAt/quoteMap/wsTimeline) — identical on every run.
//   - Everything binds to 127.0.0.1 on an OS-picked port; no external service
//     is ever contacted. The name "tradovate" refers to the UI CLASS only.
//
// Composed behaviors (one fixture exercising the whole Phase 3.4 stack):
//   3.4.2 workspace — left watchlist pane (close ✕ + collapse ‹), center tab
//        group (Orders | Positions), right depth pane (close ✕), two 6px
//        splitter bars with min-size clamps (140px), at the exploration
//        viewport 1440×900 (panes 260 / 862 / 300 + 2×6 splitters = 1440).
//   3.4.4 streams — ws://…/ws/market-data scripted timeline (hello → 8 quotes →
//        closing → close → reconnect with 2 replayed quotes → done) plus an
//        /api/quotes polling fallback with the same outage window. The page
//        renders a ticker strip (price+change per symbol), a quotes table and
//        an update counter — the live-data widgets reconstruction detects.
//   3.4.7 responsive — real media queries at 1024/768: sidebar hidden, nav
//        collapsed behind a hamburger (always visible at desktop so the
//        extractor captures it — sub-2px boxes never reach dom.json).
//   overlay record — the "New Order" button opens a real order-ticket overlay
//        so exploration produces a replayable record (verification's functional
//        stage has something to replay in the clone).
//   second route — /analytics (canvas chart) linked from the topbar nav so
//        route discovery finds a real second document.
//
// Capture-order notes carried over from the workspace-dock fixture:
//   - the INACTIVE tab panel keeps its box with opacity:0 (never display:none)
//     so the DOM extractor (which skips zero-size boxes) still captures it;
//   - the stacked panels get INCOMPARABLE boxes (1px offsets) so geometric
//     containment resolves the tabstack as their parent without 2-cycles;
//   - tabs are plain divs (not buttons) so markTriggers does not mark them —
//     tab switching must come from the reconstructed workspace runtime, not
//     from a replay record.
import http from "node:http";
import { WebSocketServer } from "ws";
import { sendHtml, sendJson, reqUrl } from "../server.mjs";

// ---------------------------------------------------------------- market data
export const SYMBOLS = ["MES", "NQ", "CL", "GC"];
const BASE = [5212.25, 18120.5, 82.14, 2384.6];
const STEP_MS = 250;
const RECONNECT_MS = 400;
const QUOTES_BEFORE_OUTAGE = 8;
const REPLAYED_COUNT = 2;

// Deterministic price for symbol idx at sequence number (pure — the benchmark
// imports this to compute expected values; the server recomputes per request).
function priceAt(seq, idx) {
  if (seq <= 0) return BASE[idx];
  const seed = (seq * 7919 + idx * 104729) % 100000;
  const wiggle = ((seed % 2000) - 1000) / 100; // -10.00 .. 9.99
  return Math.round((BASE[idx] + (seq - 1) * 0.25 + wiggle / 100) * 100) / 100;
}

export function quoteFor(seq, symbol) {
  const idx = SYMBOLS.indexOf(symbol);
  if (idx < 0) return null;
  const price = priceAt(seq, idx);
  return { price: Number(price.toFixed(2)), change: Number((price - priceAt(seq - 1, idx)).toFixed(2)) };
}

export function quoteMap(seq) {
  const out = {};
  for (const s of SYMBOLS) out[s] = quoteFor(seq, s);
  return out;
}

// The scripted WS timeline as data (the page's expected message order).
export function wsTimeline() {
  return [
    { type: "hello", server: "tradovate-fixture", interval: STEP_MS, seq: 1 },
    ...Array.from({ length: QUOTES_BEFORE_OUTAGE }, (_, i) => ({ type: "quote", seq: i + 1, quotes: quoteMap(i + 1) })),
    { type: "closing", reason: "maintenance" },
    { type: "quote", seq: QUOTES_BEFORE_OUTAGE + 1, replay: true, quotes: quoteMap(QUOTES_BEFORE_OUTAGE + 1) },
    { type: "quote", seq: QUOTES_BEFORE_OUTAGE + 2, replay: true, quotes: quoteMap(QUOTES_BEFORE_OUTAGE + 2) },
    { type: "quote", seq: QUOTES_BEFORE_OUTAGE + 3, quotes: quoteMap(QUOTES_BEFORE_OUTAGE + 3) },
    { type: "done", seq: QUOTES_BEFORE_OUTAGE + 3 },
  ];
}

export const POLLING_OUTAGE_FROM = QUOTES_BEFORE_OUTAGE + 1; // seq 9..10 → 503
export const POLLING_TOTAL = QUOTES_BEFORE_OUTAGE + 3; // seq 11 → done

// ------------------------------------------------------------------- pages
const pageStyle = `* { box-sizing: border-box; }
html, body { height: 100%; }
body { margin: 0; font-family: Arial, Helvetica, sans-serif; color: #d7dee8; background: #131722; display: flex; flex-direction: column; height: 100vh; overflow: hidden; font-size: 13px; }
.app-header { flex: 0 0 48px; height: 48px; display: flex; align-items: center; gap: 14px; padding: 0 16px; background: #0b0e14; border-bottom: 1px solid #2a2e39; }
.brand { width: 26px; height: 26px; background: #2e90fa; border-radius: 6px; flex: 0 0 26px; }
.app-name { font-size: 15px; font-weight: bold; color: #f0f4fa; }
.conn-status { padding: 3px 10px; border-radius: 10px; background: #1d3a2a; color: #7be3a2; font-size: 11px; }
.conn-status.down { background: #4a1f24; color: #ff9aa2; }
.nav-menu { display: flex; gap: 14px; margin-left: 12px; }
.nav-menu a { color: #9fb0c3; text-decoration: none; font-size: 13px; }
.nav-toggle { margin-left: auto; display: inline-flex; align-items: center; padding: 6px 12px; font-size: 13px; background: #344054; color: #fff; border: 0; border-radius: 6px; cursor: pointer; }
.ticket-btn { padding: 7px 14px; font-size: 13px; background: #2e90fa; color: #fff; border: 0; border-radius: 6px; cursor: pointer; }
.dock-root { flex: 1 1 auto; display: flex; min-height: 0; }
.pane { display: flex; flex-direction: column; min-width: 0; min-height: 0; overflow: hidden; background: #161b26; }
.pane-left { flex: 0 0 260px; width: 260px; }
.pane-right { flex: 0 0 300px; width: 300px; }
.pane-center { flex: 1 1 auto; background: #12161f; }
.pane-head { flex: 0 0 34px; height: 34px; display: flex; align-items: center; gap: 6px; padding: 0 10px; background: #1c2230; }
.pane-title { flex: 1; font-size: 12px; font-weight: bold; color: #e7ecf5; white-space: nowrap; overflow: hidden; }
.pane-rail, .pane-x { width: 22px; height: 22px; flex: 0 0 22px; border: 0; background: transparent; cursor: pointer; font-size: 13px; color: #9fb0c3; border-radius: 4px; }
.pane-rail:hover, .pane-x:hover { background: #2a3244; }
.pane-body { flex: 1 1 auto; overflow: auto; padding: 10px; line-height: 1.7; }
.quote-row { display: flex; justify-content: space-between; gap: 8px; padding: 3px 4px; }
.quote-row .bid { color: #7be3a2; }
.quote-row .ask { color: #ff9aa2; }
.pane-left.collapsed { flex-basis: 28px; width: 28px; }
.pane-left.collapsed .pane-title, .pane-left.collapsed .pane-rail, .pane-left.collapsed .pane-body { display: none; }
.splitter { flex: 0 0 6px; width: 6px; background: #2a2e39; cursor: col-resize; }
.splitter:hover, .splitter.dragging { background: #4b5563; }
.tabstrip { flex: 0 0 34px; height: 34px; display: flex; align-items: stretch; background: #1c2230; }
.tab { padding: 0 16px; display: flex; align-items: center; font-size: 12px; cursor: pointer; background: #232b3b; border-right: 1px solid #2a2e39; user-select: none; color: #c3cddb; }
.tab.active { background: #161b26; font-weight: bold; color: #ffffff; }
.tabstack { flex: 1 1 auto; position: relative; min-height: 0; }
.panel { position: absolute; padding: 12px 14px; overflow: auto; line-height: 1.7; background: #161b26; opacity: 0; pointer-events: none; }
.panel.on { opacity: 1; pointer-events: auto; }
.panel-orders { top: 1px; left: 0; right: 1px; bottom: 1px; }
.panel-positions { top: 1px; left: 1px; right: 0; bottom: 1px; }
.orders-table { width: 100%; border-collapse: collapse; }
.orders-table th, .orders-table td { border: 1px solid #2a2e39; padding: 6px 8px; text-align: left; }
.ticker-strip { flex: 0 0 36px; height: 36px; display: flex; align-items: center; gap: 18px; padding: 0 16px; background: #0b0e14; border-top: 1px solid #2a2e39; overflow: hidden; }
.ticker-item { display: inline-flex; gap: 6px; white-space: nowrap; }
.ticker-item .sym { color: #9fb0c3; font-size: 12px; }
.ticker-item .px { color: #ffffff; font-size: 13px; }
.ticker-item .chg { font-size: 11px; }
.updates { margin-left: auto; font-size: 11px; color: #7fd0ff; }
.reopen-chip { position: fixed; left: 8px; bottom: 46px; z-index: 50; padding: 6px 12px; font: 12px/1.4 Arial, sans-serif; background: #1f2937; color: #f9fafb; border: 1px solid #4b5563; border-radius: 6px; cursor: pointer; }
.order-ticket { position: fixed; inset: 0; z-index: 90; display: none; align-items: center; justify-content: center; background: rgba(6, 9, 14, 0.62); }
.order-ticket.open { display: flex; }
.ticket-card { width: 340px; padding: 18px; background: #1c2230; border: 1px solid #2a2e39; border-radius: 8px; }
.ticket-card h2 { margin: 0 0 10px; font-size: 15px; color: #f0f4fa; }
.ticket-card .row { display: flex; justify-content: space-between; padding: 4px 0; }
.ticket-card button { margin-top: 12px; padding: 7px 14px; background: #2e90fa; color: #fff; border: 0; border-radius: 6px; cursor: pointer; }
.chart-page { padding: 24px; }
.chart-page h1 { font-size: 20px; color: #f0f4fa; }
.chart-wrap { width: 900px; height: 420px; background: #161b26; border: 1px solid #2a2e39; }

/* --- original responsive behavior, breakpoints 1024 / 768 --- */
@media (max-width: 1024px) {
  .app-sidebar-filler { display: none; }
  .pane-left { display: none; }      /* watchlist hidden from tablet down */
  .brand { width: 60px; }            /* brand discretely widens (step) */
}
@media (max-width: 768px) {
  .nav-menu { display: none; }       /* nav collapses behind the toggle */
  .nav-menu.open { display: flex; position: absolute; top: 48px; left: 0; right: 0; background: #0b0e14; padding: 12px 16px; z-index: 60; }
}`;

const workspaceHtml = `<!DOCTYPE html><html><head><title>Meridian Futures — trading workspace</title><style>${pageStyle}</style></head><body>
<div class="app-header">
  <div class="brand"></div>
  <div class="app-name">Meridian Futures</div>
  <div class="conn-status" id="conn-status" data-stream-state="connecting">connecting</div>
  <button class="nav-toggle" type="button" id="nav-toggle">Menu</button>
  <nav class="nav-menu container" id="nav-menu">
    <a href="/">Workspace</a>
    <a href="/analytics">Analytics</a>
  </nav>
  <button class="ticket-btn" type="button" id="ticket-btn" aria-label="Trade ticket">Ticket</button>
</div>
<div class="dock-root container" id="dock-root">
  <div class="pane-left container" id="pane-left">
    <div class="pane-head">
      <div class="pane-title">Watchlist</div>
      <button class="pane-rail" type="button" id="rail-left">&#8249;</button>
      <button class="pane-x" type="button" id="x-left">&#10005;</button>
    </div>
    <div class="pane-body" id="watchlist">
      <div class="quote-row"><span>MES</span><span class="bid">5212.00</span><span class="ask">5212.25</span></div>
      <div class="quote-row"><span>NQ</span><span class="bid">18120.25</span><span class="ask">18120.50</span></div>
      <div class="quote-row"><span>CL</span><span class="bid">82.11</span><span class="ask">82.14</span></div>
      <div class="quote-row"><span>GC</span><span class="bid">2384.40</span><span class="ask">2384.60</span></div>
    </div>
  </div>
  <div class="splitter" id="bar-left"></div>
  <div class="pane pane-center">
    <div class="tabstrip" id="tabstrip">
      <div class="tab active" data-panel="orders">Orders</div>
      <div class="tab" data-panel="positions">Positions</div>
    </div>
    <div class="tabstack" id="tabstack">
      <div class="panel panel-orders on" id="panel-orders">
        <table class="orders-table" id="quotes-table">
          <thead><tr><th>Symbol</th><th>Price</th><th>Change</th></tr></thead>
          <tbody>
            <tr class="quote-row-tr" data-row="MES"><td>MES</td><td class="cell-price">0.00</td><td class="cell-change">+0.00</td></tr>
            <tr class="quote-row-tr" data-row="NQ"><td>NQ</td><td class="cell-price">0.00</td><td class="cell-change">+0.00</td></tr>
            <tr class="quote-row-tr" data-row="CL"><td>CL</td><td class="cell-price">0.00</td><td class="cell-change">+0.00</td></tr>
            <tr class="quote-row-tr" data-row="GC"><td>GC</td><td class="cell-price">0.00</td><td class="cell-change">+0.00</td></tr>
          </tbody>
        </table>
      </div>
      <div class="panel panel-positions" id="panel-positions">Open positions blotter: MES long 12, NQ short 4, CL flat, GC flat</div>
    </div>
  </div>
  <div class="splitter" id="bar-right"></div>
  <div class="pane pane-right" id="pane-right">
    <div class="pane-head">
      <div class="pane-title">Depth of market</div>
      <button class="pane-x" type="button" id="x-right">&#10005;</button>
    </div>
    <div class="pane-body">
      <div class="quote-row"><span class="bid">Bid 5212.00 x 18</span></div>
      <div class="quote-row"><span class="bid">Bid 5211.75 x 24</span></div>
      <div class="quote-row"><span class="bid">Bid 5211.50 x 31</span></div>
      <div class="quote-row"><span class="ask">Ask 5212.25 x 12</span></div>
      <div class="quote-row"><span class="ask">Ask 5212.50 x 27</span></div>
      <div class="quote-row"><span class="ask">Ask 5212.75 x 44</span></div>
    </div>
  </div>
</div>
<div class="ticker-strip" id="ticker-strip">
  <span class="ticker-item" data-sym="MES"><span class="sym">MES</span><span class="px">0.00</span><span class="chg">+0.00</span></span>
  <span class="ticker-item" data-sym="NQ"><span class="sym">NQ</span><span class="px">0.00</span><span class="chg">+0.00</span></span>
  <span class="ticker-item" data-sym="CL"><span class="sym">CL</span><span class="px">0.00</span><span class="chg">+0.00</span></span>
  <span class="ticker-item" data-sym="GC"><span class="sym">GC</span><span class="px">0.00</span><span class="chg">+0.00</span></span>
  <span class="updates">Updates: <span id="seq-counter">0</span></span>
</div>
<div class="order-ticket" id="order-ticket" role="dialog" aria-label="Order ticket">
  <div class="ticket-card">
    <h2>Order ticket — MES</h2>
    <div class="row"><span>Side</span><span>Buy</span></div>
    <div class="row"><span>Quantity</span><span>1 lot</span></div>
    <div class="row"><span>Limit price</span><span id="ticket-price">5212.25</span></div>
    <button type="button" id="ticket-close">Close ticket</button>
  </div>
</div>
<script>
// original behaviors: tab switch, splitter drag with min clamps, pane close +
// reopen chip, collapse rail, hamburger nav, order-ticket overlay, market data
// client (WebSocket with polling fallback and the scripted outage).
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
  document.getElementById("tabstrip").addEventListener("click", function (e) {
    var tab = e.target.closest ? e.target.closest(".tab") : null;
    if (tab) activate(tab.getAttribute("data-panel"));
  });
  function makeDrag(barId, minPx) {
    var bar = document.getElementById(barId);
    bar.addEventListener("mousedown", function (e) {
      e.preventDefault();
      bar.classList.add("dragging");
      var prev = bar.previousElementSibling, next = bar.nextElementSibling;
      var sw = prev.getBoundingClientRect().width, nw = next.getBoundingClientRect().width, sx = e.clientX;
      function onMove(ev) {
        var d = ev.clientX - sx;
        var np = Math.max(minPx, sw + d), nn = Math.max(minPx, nw - d);
        if (np <= minPx) nn = nw + (sw - minPx);
        if (nn <= minPx) np = sw + (nw - minPx);
        prev.style.width = np + "px"; prev.style.flex = "0 0 " + np + "px";
        next.style.width = nn + "px"; next.style.flex = "0 0 " + nn + "px";
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
  document.getElementById("nav-toggle").addEventListener("click", function () {
    document.getElementById("nav-menu").classList.toggle("open");
  });
  var ticket = document.getElementById("order-ticket");
  document.getElementById("ticket-btn").addEventListener("click", function () { ticket.classList.add("open"); });
  document.getElementById("ticket-close").addEventListener("click", function () { ticket.classList.remove("open"); });

  // ---- market data client: WebSocket first, /api/quotes polling fallback ----
  var SYMBOLS = ${JSON.stringify(SYMBOLS)};
  var statusEl = document.getElementById("conn-status");
  var counter = document.getElementById("seq-counter");
  var seq = 0;
  window.__STATUS_LOG = [];
  window.__WS_USED = false;
  window.__FIXTURE_DONE = false;
  window.__REPLAYS = 0;
  function setStatus(s) { statusEl.textContent = s; statusEl.setAttribute("data-stream-state", s); window.__STATUS_LOG.push(s); }
  function apply(qmap) {
    for (var i = 0; i < SYMBOLS.length; i++) {
      var sym = SYMBOLS[i], q = qmap[sym];
      if (!q) continue;
      var t = document.querySelector('.ticker-item[data-sym="' + sym + '"]');
      if (t) {
        t.querySelector(".px").textContent = q.price.toFixed(2);
        t.querySelector(".chg").textContent = (q.change >= 0 ? "+" : "") + q.change.toFixed(2);
      }
      var row = document.querySelector('tr[data-row="' + sym + '"]');
      if (row) {
        row.querySelector(".cell-price").textContent = q.price.toFixed(2);
        row.querySelector(".cell-change").textContent = (q.change >= 0 ? "+" : "") + q.change.toFixed(2);
      }
    }
    counter.textContent = String(seq);
    var tp = document.getElementById("ticket-price");
    if (tp) tp.textContent = qmap.MES ? qmap.MES.price.toFixed(2) : tp.textContent;
  }
  function poll() {
    var xhr = new XMLHttpRequest();
    xhr.open("GET", "/api/quotes?seq=" + (seq + 1), true);
    xhr.onload = function () {
      if (xhr.status === 200) {
        setStatus("connected");
        var d = JSON.parse(xhr.responseText);
        seq = d.seq; if (d.replayed) window.__REPLAYS += (d.replayed || 0);
        apply(d.quotes);
        if (d.done) { window.__FIXTURE_DONE = true; return; }
      } else {
        setStatus("disconnected");
      }
      setTimeout(poll, 260);
    };
    xhr.onerror = function () { setStatus("disconnected"); setTimeout(poll, 260); };
    xhr.send();
  }
  function connectWs() {
    var sock;
    try { sock = new WebSocket((location.protocol === "https:" ? "wss://" : "ws://") + location.host + "/ws/market-data"); }
    catch (e) { setStatus("disconnected"); poll(); return; }
    window.__WS_USED = true;
    var idx = 0, timer = null;
    sock.onopen = function () { setStatus("connected"); };
    sock.onmessage = function (ev) {
      var d = JSON.parse(ev.data);
      if (d.type === "hello") { timer = setInterval(sendNext, d.interval || ${STEP_MS}); }
      else if (d.type === "quote") { seq = d.seq; if (d.replay) window.__REPLAYS++; apply(d.quotes); }
      else if (d.type === "closing") { setStatus("disconnecting"); }
      else if (d.type === "done") {
        if (timer) clearInterval(timer);
        window.__FIXTURE_DONE = true;
      }
    };
    function sendNext() {
      // the fixture drives quotes server-side; the client only pings
      try { sock.send(JSON.stringify({ type: "ping" })); } catch (e) {}
      idx++;
    }
    sock.onclose = function () {
      if (timer) clearInterval(timer);
      setStatus("disconnected");
      // reconnect after the scripted outage window
      setTimeout(function () {
        setStatus("reconnecting");
        var sock2;
        try { sock2 = new WebSocket((location.protocol === "https:" ? "wss://" : "ws://") + location.host + "/ws/market-data"); }
        catch (e) { poll(); return; }
        sock2.onopen = function () { setStatus("connected"); };
        sock2.onmessage = sock.onmessage;
        sock2.onclose = function () { setStatus("disconnected"); poll(); };
      }, ${RECONNECT_MS});
    };
  }
  connectWs();
})();
</script></body></html>`;

const analyticsHtml = `<!DOCTYPE html><html><head><title>Meridian Futures — analytics</title><style>${pageStyle}
main.chart-main { flex: 1 1 auto; overflow: auto; padding: 20px; }
</style></head><body>
<div class="app-header">
  <div class="brand"></div>
  <div class="app-name">Meridian Futures</div>
  <nav class="nav-menu container" id="nav-menu">
    <a href="/">Workspace</a>
    <a href="/analytics">Analytics</a>
  </nav>
</div>
<main class="chart-main">
  <h1>Session analytics</h1>
  <div class="chart-wrap"><canvas id="chart" width="880" height="400"></canvas></div>
  <p>Synthetic session volume for the four fixture instruments (deterministic values, no live market data).</p>
</main>
<script>
(function () {
  var c = document.getElementById("chart");
  if (!c || !c.getContext) return;
  var ctx = c.getContext("2d");
  var bars = [420, 610, 260, 480];
  var labels = ${JSON.stringify(SYMBOLS)};
  ctx.fillStyle = "#161b26";
  ctx.fillRect(0, 0, c.width, c.height);
  for (var i = 0; i < bars.length; i++) {
    ctx.fillStyle = i % 2 ? "#2e90fa" : "#12b76a";
    ctx.fillRect(60 + i * 200, 380 - bars[i], 120, bars[i]);
    ctx.fillStyle = "#9fb0c3";
    ctx.fillText(labels[i], 60 + i * 200 + 40, 394);
  }
})();
</script></body></html>`;

// ------------------------------------------------------------------ serving

function httpHandle(req, res) {
  const p = reqUrl(req).pathname;
  if (p === "/" || p === "/index.html") { sendHtml(res, workspaceHtml); return; }
  if (p === "/analytics") { sendHtml(res, analyticsHtml); return; }
  if (p === "/api/quotes") {
    const seq = Number(new URL(req.url, "http://127.0.0.1").searchParams.get("seq") || 0);
    // deterministic polling fallback with the same outage window as the WS
    if (seq >= POLLING_OUTAGE_FROM && seq < QUOTES_BEFORE_OUTAGE + REPLAYED_COUNT + 1 && seq <= QUOTES_BEFORE_OUTAGE + REPLAYED_COUNT) {
      // seq 9..10 → simulated outage; the client retries
      res.writeHead(503, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "maintenance window" }));
      return;
    }
    if (seq > POLLING_TOTAL) { sendJson(res, { seq: POLLING_TOTAL, done: true, replayed: 0, quotes: quoteMap(POLLING_TOTAL) }); return; }
    sendJson(res, { seq, done: seq >= POLLING_TOTAL, replayed: 0, quotes: quoteMap(seq) });
    return;
  }
  res.writeHead(404, { "content-type": "text/plain" });
  res.end("fixture: not found");
}

// Plain site object (polling-only — usable through scripts/fixtures/server.mjs,
// which has no WS upgrade handling; the page falls back to /api/quotes).
export const tradovateSite = {
  name: "tradovate-fixture",
  entry: "/",
  handle: httpHandle,
};

// startTradovateFixtureServer() — HTTP + WebSocket upgrade on one ephemeral
// 127.0.0.1 port. Same scripted connection pattern as the ticker-stream
// fixture: conn 0 → hello, 8 quotes (250ms apart), closing, close;
// conn 1 → reconnect, 2 replayed quotes, 1 live quote, done; conn ≥ 2 →
// hello, done (idempotent tail).
export async function startTradovateFixtureServer() {
  let connCount = 0;
  const timers = new Set();
  const later = (fn, ms) => {
    const t = setTimeout(() => { timers.delete(t); fn(); }, ms);
    timers.add(t);
    return t;
  };
  const server = http.createServer(httpHandle);
  const wss = new WebSocketServer({ noServer: true });
  server.on("upgrade", (req, socket, head) => {
    let pathname = "/";
    try { pathname = new URL(req.url, "http://127.0.0.1").pathname; } catch {}
    if (pathname !== "/ws/market-data") { socket.destroy(); return; }
    wss.handleUpgrade(req, socket, head, (client) => {
      const connIndex = connCount++;
      client.on("close", () => {});
      client.on("error", () => {});
      client.on("message", () => {}); // ping frames are accepted, not acted on
      const send = (obj) => { try { client.send(JSON.stringify(obj)); } catch {} };
      const tl = wsTimeline();
      if (connIndex === 0) {
        send(tl[0]); // hello
        for (let i = 1; i <= QUOTES_BEFORE_OUTAGE; i++) later(() => send(tl[i]), i * STEP_MS);
        later(() => send(tl[QUOTES_BEFORE_OUTAGE + 1]), (QUOTES_BEFORE_OUTAGE + 1) * STEP_MS); // closing
        later(() => { try { client.close(); } catch {} }, (QUOTES_BEFORE_OUTAGE + 1) * STEP_MS + 120);
      } else if (connIndex === 1) {
        // reconnect: the two quotes missed during the outage, then the live one
        for (let i = 0; i < REPLAYED_COUNT; i++) later(() => send(tl[QUOTES_BEFORE_OUTAGE + 2 + i]), (i + 1) * STEP_MS);
        later(() => send(tl[QUOTES_BEFORE_OUTAGE + 2 + REPLAYED_COUNT]), (REPLAYED_COUNT + 1) * STEP_MS); // live
        later(() => send(tl[tl.length - 1]), (REPLAYED_COUNT + 2) * STEP_MS); // done
      } else {
        send(tl[0]);
        later(() => send(tl[tl.length - 1]), STEP_MS);
      }
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  return {
    base: "http://127.0.0.1:" + port,
    port,
    close: () => new Promise((resolve) => { for (const t of timers) clearTimeout(t); server.close(resolve); }),
  };
}

// the raw pages, exported for direct assertions (unit checks, visual diffs)
export const tradovateWorkspaceHtml = workspaceHtml;
export const tradovateAnalyticsHtml = analyticsHtml;
