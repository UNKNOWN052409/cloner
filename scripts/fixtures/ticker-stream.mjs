// Fixture site 5 — data-driven interface (task 3.4.4, step 4): a live ticker
// page driven by a real same-origin WebSocket plus deterministic HTTP polling
// endpoints, everything on 127.0.0.1 with a fully scripted timeline.
//
// TRANSPORT CHOICE (documented per the task): the task text says "ws library is
// NOT in deps — use a trivial same-origin polling endpoint OR two HTTP
// endpoints the page fetches on a timer". That premise is outdated: `ws@^8.18.0`
// IS a declared dependency (package.json) and is already imported by
// src/server.js and src/platform/server.js. So the fixture serves a REAL
// WebSocket at ws://127.0.0.1:<port>/ws via the installed `ws` package — this
// keeps tests deterministic (localhost, scripted timeline, no external
// service) while exercising the actual page.on("websocket") capture path.
// The HTTP endpoints below are kept as a documented polling fallback: the page
// automatically switches to /api/quotes polling when WebSocket is unavailable
// (e.g. a runner serving this site object through scripts/fixtures/server.mjs,
// which has no upgrade handling).
//
// Timeline (WS mode, deterministic, driven by the per-connection index):
//   conn 0: hello → quotes seq 1..5 (300ms apart) → {type:"closing"} → close
//   conn 1 (client reconnects after 400ms): {type:"reconnect"} → quotes seq 6,7
//           marked replay:true (the updates missed during the outage — the
//           "delayed states" the clone must reproduce) → quote seq 8 → done
//   conn >= 2: hello → done (idempotent tail)
// Polling fallback mirrors the outage: seq 1..5 → 200, seq 6..7 → 503,
// seq 8 → 200 with replayed count, seq >= 9 → done.
//
// No credentials, no PII, no account-changing behavior: the payloads are
// synthetic ticker numbers and symbol codes only.
import http from "node:http";
import { WebSocketServer } from "ws";
import { sendHtml, sendJson, reqUrl } from "./server.mjs";

export const SYMBOLS = ["AAPL", "MSFT", "ES"];
const BASE = [101.25, 255.4, 4550.5];
const STEP_MS = 300;
const RECONNECT_MS = 400;
const QUOTES_BEFORE_OUTAGE = 5;
const REPLAYED_COUNT = 2; // seq 6..7 delivered after the reconnect

// Deterministic price for a symbol at a sequence number (pure — the test imports
// this to compute expected replay values; the server recomputes per request).
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
    { type: "hello", server: "ticker-fixture", interval: STEP_MS, seq: 1 },
    ...Array.from({ length: QUOTES_BEFORE_OUTAGE }, (_, i) => ({ type: "quote", seq: i + 1, quotes: quoteMap(i + 1) })),
    { type: "closing", reason: "maintenance" },
    { type: "quote", seq: QUOTES_BEFORE_OUTAGE + 1, replay: true, quotes: quoteMap(QUOTES_BEFORE_OUTAGE + 1) },
    { type: "quote", seq: QUOTES_BEFORE_OUTAGE + 2, replay: true, quotes: quoteMap(QUOTES_BEFORE_OUTAGE + 2) },
    { type: "quote", seq: QUOTES_BEFORE_OUTAGE + 3, quotes: quoteMap(QUOTES_BEFORE_OUTAGE + 3) },
    { type: "done", seq: QUOTES_BEFORE_OUTAGE + 3 },
  ];
}

const pageHtml = `<!DOCTYPE html><html><head><title>Meridian Markets — live ticker</title><style>
body{font-family:Georgia,serif;margin:0;background:#101418;color:#e8ecf1}
main{max-width:640px;margin:34px auto;padding:20px;background:#181e26;border:1px solid #2c3542}
h1{font-size:22px;margin:0 0 6px}
#stream-status{display:inline-block;padding:4px 10px;border-radius:3px;font-size:12px;background:#1d3a2a;color:#7be3a2}
#stream-status[data-stream-state="disconnected"]{background:#4a1f24;color:#ff9aa2}
#backlog-note{min-height:18px;font-size:13px;color:#f0c674;margin:8px 0 0}
.ticker-row{display:flex;gap:14px;margin:18px 0}
.ticker{display:inline-block;padding:10px 12px;border:1px solid #2c3542;background:#141a22;min-width:120px}
.ticker .symbol{font-size:12px;color:#9fb0c3;display:block}
.ticker .price{font-size:19px;color:#ffffff}
.ticker .change{font-size:12px;display:block}
.quotes-table{width:100%;border-collapse:collapse;margin-top:8px}
.quotes-table th,.quotes-table td{border:1px solid #2c3542;padding:8px 10px;text-align:left;font-size:14px}
.counter{margin-top:16px;font-size:14px}
#seq-counter{color:#7fd0ff;font-size:18px}
</style></head><body>
<main>
<h1>Meridian Markets</h1>
<div id="stream-status" data-stream-state="connecting">connecting</div>
<p id="backlog-note"></p>
<div class="ticker-row" id="ticker-row">
  <span class="ticker" data-sym="AAPL"><span class="symbol">AAPL</span><span class="price">0.00</span><span class="change">+0.00</span></span>
  <span class="ticker" data-sym="MSFT"><span class="symbol">MSFT</span><span class="price">0.00</span><span class="change">+0.00</span></span>
  <span class="ticker" data-sym="ES"><span class="symbol">ES</span><span class="price">0.00</span><span class="change">+0.00</span></span>
</div>
<table class="quotes-table" id="quotes-table">
  <thead><tr><th>Symbol</th><th>Price</th><th>Change</th></tr></thead>
  <tbody>
    <tr class="quote-row" data-row="AAPL"><td class="sym">AAPL</td><td class="cell-price">0.00</td><td class="cell-change">+0.00</td></tr>
    <tr class="quote-row" data-row="MSFT"><td class="sym">MSFT</td><td class="cell-price">0.00</td><td class="cell-change">+0.00</td></tr>
    <tr class="quote-row" data-row="ES"><td class="sym">ES</td><td class="cell-price">0.00</td><td class="cell-change">+0.00</td></tr>
  </tbody>
</table>
<div class="counter">Updates received: <span id="seq-counter">0</span></div>
</main>
<script>
var SYMBOLS = ["AAPL", "MSFT", "ES"];
var statusEl = document.getElementById("stream-status");
var backlogEl = document.getElementById("backlog-note");
window.__STATUS_LOG = [];
window.__WS_USED = false;
window.__FIXTURE_DONE = false;
window.__REPLAYS = 0;
function setStatus(s) {
  statusEl.textContent = s;
  statusEl.setAttribute("data-stream-state", s);
  window.__STATUS_LOG.push(s);
}
function fmt(n) { return (n >= 0 ? "+" : "") + n.toFixed(2); }
function apply(q) {
  if (typeof q.seq === "number") document.getElementById("seq-counter").textContent = String(q.seq);
  var quotes = q.quotes || {};
  for (var sym in quotes) {
    var p = quotes[sym];
    var tick = document.querySelector('[data-sym="' + sym + '"]');
    if (tick) {
      tick.querySelector(".price").textContent = p.price.toFixed(2);
      tick.querySelector(".change").textContent = fmt(p.change);
    }
    var row = document.querySelector('#quotes-table tr[data-row="' + sym + '"]');
    if (row) {
      row.querySelector(".cell-price").textContent = p.price.toFixed(2);
      row.querySelector(".cell-change").textContent = fmt(p.change);
    }
  }
}
function onMsg(m) {
  if (m.type === "quote") {
    apply(m);
    if (m.replay) {
      window.__REPLAYS++;
      backlogEl.textContent = window.__REPLAYS + " delayed updates applied after reconnect";
    }
  } else if (m.type === "reconnect") {
    setStatus("connected");
  } else if (m.type === "closing") {
    setStatus("disconnecting");
  } else if (m.type === "done") {
    setStatus("connected");
    window.__FIXTURE_DONE = true;
  }
}
// ---- polling fallback (documented transport choice) ----
var pollingStarted = false;
var pollSeq = 0;
function startPolling() {
  if (pollingStarted) return;
  pollingStarted = true;
  var timer = setInterval(function () {
    pollSeq++;
    fetch("/api/quotes?seq=" + pollSeq).then(function (r) {
      if (r.status !== 200) { setStatus("disconnected"); return null; }
      return r.json();
    }).then(function (j) {
      if (!j) return;
      if (j.done) {
        apply(j);
        setStatus("connected");
        clearInterval(timer);
        window.__FIXTURE_DONE = true;
        return;
      }
      apply(j);
      setStatus("connected");
    }).catch(function () { setStatus("disconnected"); });
  }, 300);
}
// ---- preferred transport: same-origin WebSocket ----
function connectWs() {
  var ws;
  try { ws = new WebSocket("ws://" + location.host + "/ws"); } catch (e) { startPolling(); return; }
  var opened = false;
  ws.onopen = function () {
    opened = true;
    window.__WS_USED = true;
    setStatus("connected");
    try { ws.send(JSON.stringify({ type: "subscribe", symbols: SYMBOLS })); } catch (e) {}
  };
  ws.onmessage = function (e) {
    try { onMsg(JSON.parse(e.data)); } catch (err) {}
  };
  ws.onclose = function () {
    if (window.__FIXTURE_DONE) return;
    setStatus("disconnected");
    if (!opened && !pollingStarted) { startPolling(); return; }
    setTimeout(connectWs, 400);
  };
  ws.onerror = function () { try { ws.close(); } catch (e) {} };
}
fetch("/api/snapshot").then(function (r) { return r.json(); }).then(function (s) { apply(s); }).catch(function () {});
connectWs();
</script></body></html>`;

function httpHandle(req, res) {
  const u = reqUrl(req);
  if (u.pathname === "/") { sendHtml(res, pageHtml); return; }
  if (u.pathname === "/api/snapshot") { sendJson(res, { seq: 0, quotes: quoteMap(1) }); return; }
  if (u.pathname === "/api/quotes") {
    const seq = Number(u.searchParams.get("seq") || 0);
    if (seq >= 1 && seq <= QUOTES_BEFORE_OUTAGE) { sendJson(res, { seq, quotes: quoteMap(seq) }); return; }
    if (seq === QUOTES_BEFORE_OUTAGE + 1 || seq === QUOTES_BEFORE_OUTAGE + 2) {
      sendJson(res, { error: "simulated outage" }, 503);
      return;
    }
    if (seq === QUOTES_BEFORE_OUTAGE + 3) { sendJson(res, { seq, quotes: quoteMap(seq), replayed: REPLAYED_COUNT }); return; }
    if (seq >= QUOTES_BEFORE_OUTAGE + 4) { sendJson(res, { seq, done: true, quotes: quoteMap(seq) }); return; }
    sendJson(res, { error: "seq must be >= 1" }, 400);
    return;
  }
  res.writeHead(404, { "content-type": "text/plain" });
  res.end("fixture: not found");
}

// Standard site object (HTTP only). Served through scripts/fixtures/server.mjs
// (no upgrade handling) the page automatically falls back to /api/quotes polling.
export const tickerStreamSite = { name: "ticker-stream", entry: "/", handle: httpHandle };

// startTickerStreamServer() — HTTP + WebSocket upgrade on one ephemeral
// 127.0.0.1 port. Returns { base, wssUrl, port, close, connections() }.
export async function startTickerStreamServer() {
  let connCount = 0;
  const timers = new Set();
  const clients = new Set();
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
    if (pathname !== "/ws") { socket.destroy(); return; }
    wss.handleUpgrade(req, socket, head, (client) => {
      const connIndex = connCount++;
      clients.add(client);
      client.on("close", () => clients.delete(client));
      client.on("error", () => {});
      client.on("message", () => {}); // subscribe frames are accepted, not acted on
      const send = (obj) => { try { client.send(JSON.stringify(obj)); } catch {} };
      if (connIndex === 0) {
        // scripted first session: hello, 5 quotes, closing, close
        send(wsTimeline()[0]);
        for (let i = 1; i <= QUOTES_BEFORE_OUTAGE; i++) {
          later(() => send(wsTimeline()[i]), STEP_MS * i);
        }
        later(() => send(wsTimeline()[QUOTES_BEFORE_OUTAGE + 1]), STEP_MS * (QUOTES_BEFORE_OUTAGE + 1) + 60);
        later(() => { try { client.close(1000, "maintenance"); } catch {} }, STEP_MS * (QUOTES_BEFORE_OUTAGE + 1) + 200);
      } else if (connIndex === 1) {
        // reconnect session: the two missed (delayed) updates, then the live one, done
        send({ type: "reconnect", server: "ticker-fixture", seq: QUOTES_BEFORE_OUTAGE + 1 });
        later(() => send(wsTimeline()[QUOTES_BEFORE_OUTAGE + 2]), STEP_MS);
        later(() => send(wsTimeline()[QUOTES_BEFORE_OUTAGE + 3]), STEP_MS * 2);
        later(() => send(wsTimeline()[QUOTES_BEFORE_OUTAGE + 4]), STEP_MS * 3);
        later(() => send(wsTimeline()[QUOTES_BEFORE_OUTAGE + 5]), STEP_MS * 3 + 100);
      } else {
        send({ type: "hello", server: "ticker-fixture", reconnected: true });
        later(() => send(wsTimeline()[QUOTES_BEFORE_OUTAGE + 5]), STEP_MS);
      }
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  return {
    base: "http://127.0.0.1:" + port,
    wssUrl: "ws://127.0.0.1:" + port + "/ws",
    port,
    connections: () => connCount,
    close: async () => {
      for (const t of timers) clearTimeout(t);
      timers.clear();
      for (const c of clients) { try { c.terminate(); } catch {} }
      clients.clear();
      await new Promise((resolve) => wss.close(() => resolve()));
      await new Promise((resolve) => server.close(resolve));
    },
  };
}
