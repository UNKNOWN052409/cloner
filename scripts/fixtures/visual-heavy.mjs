// Fixture site 5 (task 3.5.4 — Complex Visual Content Reconstruction):
// visual-heavy dashboard with every complex-visual category the fidelity
// analyzer classifies (VISUAL_REGION_KINDS in visual-fidelity-analyzer.js):
//
//  1. inline SVG line chart (.main-chart, ~640×320) — real <path>/<circle>
//     markup so faithful reconstruction can preserve the structure.
//  2. inline SVG icon (.icon-gear, 44×44) — BELOW the icon floor, must NOT be
//     classified as a visual region (icons are ordinary DOM).
//  3. large SVG hero illustration (.hero-art, 300×180) — svg-kind region.
//  4. canvas sparkline (.sparkline-canvas, 320×120) — painted with 2d context
//     at load; the engine's capture path (serializeEnhanced, src/browser.js:322)
//     turns it into a data-cloner-snap <img>.
//  5. canvas bar chart (.bars-canvas, 480×280) — 12 bars from a deterministic
//     dataset, painted with 2d context.
//  6. CSS-drawn map mock (.map-mock, 460×300) — grid background + absolutely
//     positioned markers (3 pins), no JS library: pure CSS/DOM "map".
//  7. a chart loaded from /api/chart-data — chart evidence association: the
//     analyzer's dataByIndex/interactionsByIndex wiring is exercised against
//     the same numbers the canvas draws.
//
// Design notes matched to the engine:
//  - Every visual sits INSIDE its ≥40×40 box so findVisualRegions' floor
//    (VISUAL_REGION_FLOOR) classifies it and ignores the small gear icon.
//  - Buttons that toggle the map markers / reseed the bar chart are ordinary
//    class-named controls (`.map-toggle`, `.bars-reseed`) — no dangerous words.
//  - No external network: everything is inline SVG, canvas 2d, or JSON served
//    from this same fixture server.
import { sendHtml, sendJson, reqUrl } from "./server.mjs";

// deterministic bar data — the canvas paints exactly this; /api/chart-data
// serves it as JSON so the test can assert capture↔data association
const BARS = [42, 68, 25, 91, 54, 37, 77, 12, 63, 48, 85, 30];

const html = `<!DOCTYPE html><html><head><title>Nimbus Analytics — visual heavy</title><style>
body{font-family:'Segoe UI',Arial,sans-serif;margin:0;color:#1c2333;background:#f4f6fb}
header{height:56px;background:#101a33;color:#fff;display:flex;align-items:center;padding:0 20px;font-size:17px;font-weight:600}
main{padding:18px 22px;max-width:1180px;margin:0 auto}
h2{font-size:18px;margin:18px 0 8px}
.panel{background:#fff;border:1px solid #d6dcea;border-radius:8px;padding:12px;margin-bottom:16px}
.main-chart{display:block;width:100%;max-width:640px;height:auto;aspect-ratio:2/1}
.hero-art{display:block;width:300px;height:180px}
.icon-gear{width:44px;height:44px;vertical-align:middle}
.sparkline-canvas{display:block;width:320px;height:120px;background:#fbfcff}
.bars-canvas{display:block;width:480px;height:280px;background:#fbfcff}
.map-mock{position:relative;width:460px;height:300px;background:
  linear-gradient(#dfe7f4 1px, transparent 1px), linear-gradient(90deg,#dfe7f4 1px, transparent 1px);
  background-size:30px 30px;background-color:#eef3fa;border:1px solid #c8d3e6;border-radius:6px;overflow:hidden}
.map-marker{position:absolute;width:16px;height:16px;border-radius:50%;background:#e04a3f;border:2px solid #fff;
  box-shadow:0 1px 3px rgba(0,0,0,.35);transform:translate(-50%,-50%)}
.map-label{position:absolute;font-size:11px;color:#44506b;background:rgba(255,255,255,.9);padding:2px 6px;border-radius:4px;transform:translate(10px,-6px)}
.row{display:flex;gap:18px;flex-wrap:wrap}
.map-toggle,.bars-reseed{margin-top:10px;padding:8px 14px;font-size:14px;background:#2438a8;color:#fff;border:0;border-radius:6px;cursor:pointer}
.map-note{font-size:13px;color:#5a6788;margin:8px 0 0}
</style></head><body>
<header>Nimbus Analytics</header>
<main>
<h2>Market overview</h2>
<div class="panel">
  <svg class="main-chart" viewBox="0 0 640 320" role="img" aria-label="Quarterly revenue line chart">
    <rect x="0" y="0" width="640" height="320" fill="#ffffff"></rect>
    <polyline points="40,40 40,280 600,280" stroke="#c9d2e3" stroke-width="1" fill="none"></polyline>
    <path d="M40,240 L140,190 L240,210 L340,140 L440,160 L540,90 L600,70" stroke="#2f6fed" stroke-width="3" fill="none" stroke-linecap="round"></path>
    <circle cx="140" cy="190" r="5" fill="#2f6fed"></circle>
    <circle cx="340" cy="140" r="5" fill="#2f6fed"></circle>
    <circle cx="540" cy="90" r="5" fill="#2f6fed"></circle>
    <text x="50" y="30" font-size="13" fill="#64748b">Revenue by quarter</text>
  </svg>
</div>
<div class="row">
  <div class="panel">
    <h2>Sparkline</h2>
    <canvas class="sparkline-canvas" width="320" height="120" aria-label="Signal sparkline"></canvas>
  </div>
  <div class="panel">
    <h2>Bar distribution</h2>
    <canvas class="bars-canvas" width="480" height="280" aria-label="Bar distribution chart"></canvas>
    <button class="bars-reseed" type="button">Reseed bars</button>
  </div>
  <div class="panel">
    <h2>Brand</h2>
    <svg class="hero-art" viewBox="0 0 300 180" role="img" aria-label="Nimbus brand illustration">
      <defs>
        <linearGradient id="grad" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stop-color="#7aa2ff"></stop>
          <stop offset="1" stop-color="#2f4bd8"></stop>
        </linearGradient>
      </defs>
      <rect x="0" y="0" width="300" height="180" rx="12" fill="url(#grad)"></rect>
      <ellipse cx="150" cy="80" rx="70" ry="34" fill="#ffffff" opacity="0.92"></ellipse>
      <ellipse cx="110" cy="96" rx="46" ry="24" fill="#eef3ff" opacity="0.9"></ellipse>
      <polygon points="60,150 150,110 240,150" fill="#1c2f8f" opacity="0.85"></polygon>
      <text x="118" y="170" font-size="16" fill="#ffffff" font-weight="600">nimbus</text>
    </svg>
    <svg class="icon-gear" viewBox="0 0 44 44" aria-label="settings gear">
      <circle cx="22" cy="22" r="8" fill="none" stroke="#5a6788" stroke-width="3"></circle>
      <g stroke="#5a6788" stroke-width="3">
        <line x1="22" y1="4" x2="22" y2="12"></line>
        <line x1="22" y1="32" x2="22" y2="40"></line>
        <line x1="4" y1="22" x2="12" y2="22"></line>
        <line x1="32" y1="22" x2="40" y2="22"></line>
      </g>
    </svg>
  </div>
</div>
<div class="panel">
  <h2>Delivery map</h2>
  <div class="map-mock" id="map" role="img" aria-label="Delivery coverage map">
    <div class="map-marker" style="left:30%;top:40%" data-city="harbor"></div>
    <div class="map-label" style="left:30%;top:40%">Harbor</div>
    <div class="map-marker" style="left:62%;top:28%" data-city="midtown"></div>
    <div class="map-label" style="left:62%;top:28%">Midtown</div>
    <div class="map-marker" style="left:74%;top:70%" data-city="airfield"></div>
    <div class="map-label" style="left:74%;top:70%">Airfield</div>
  </div>
  <button class="map-toggle" type="button">Toggle markers</button>
  <p class="map-note" id="map-note">3 markers visible</p>
</div>
</main>
<script>
// canvas sparkline — deterministic walk
(function () {
  var c = document.querySelector('.sparkline-canvas');
  var ctx = c.getContext('2d');
  var pts = [12, 28, 20, 44, 36, 60, 52, 74, 66, 88, 80, 96];
  ctx.strokeStyle = '#2f6fed';
  ctx.lineWidth = 2;
  ctx.beginPath();
  for (var i = 0; i < pts.length; i++) {
    var x = 8 + i * (304 / (pts.length - 1));
    var y = 108 - pts[i];
    if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
  }
  ctx.stroke();
  ctx.fillStyle = '#2f6fed';
  for (var j = 0; j < pts.length; j++) {
    var x2 = 8 + j * (304 / (pts.length - 1));
    ctx.fillRect(x2 - 2, 108 - pts[j] - 2, 4, 4);
  }
})();
// canvas bar chart from the SAME dataset the API serves
window.drawBars = function (data) {
  var c = document.querySelector('.bars-canvas');
  var ctx = c.getContext('2d');
  ctx.clearRect(0, 0, c.width, c.height);
  var bw = (440 / data.length) - 6;
  for (var i = 0; i < data.length; i++) {
    var h = Math.round((data[i] / 100) * 230);
    ctx.fillStyle = i % 2 ? '#4f7cf0' : '#2f4bd8';
    ctx.fillRect(24 + i * (bw + 6), 250 - h, bw, h);
  }
  ctx.strokeStyle = '#c9d2e3';
  ctx.beginPath(); ctx.moveTo(16, 250.5); ctx.lineTo(464, 250.5); ctx.stroke();
};
window.drawBars(${JSON.stringify(BARS)});
document.querySelector('.bars-reseed').addEventListener('click', function () {
  var seed = (window.__barSeed = (window.__barSeed || 0) + 1);
  var d = ${JSON.stringify(BARS)}.map(function (v, i) { return (v + seed * 7 + i * 3) % 100 || 8; });
  window.drawBars(d);
});
// map marker toggle — interaction evidence for the map region
var markersOn = true;
document.querySelector('.map-toggle').addEventListener('click', function () {
  markersOn = !markersOn;
  document.querySelectorAll('.map-marker').forEach(function (m) { m.style.display = markersOn ? 'block' : 'none'; });
  document.getElementById('map-note').textContent = (markersOn ? 3 : 0) + ' markers visible';
});
</script></body></html>`;

export const visualHeavySite = {
  name: "visual-heavy",
  entry: "/",
  handle(req, res) {
    const p = reqUrl(req).pathname;
    if (p === "/") {
      sendHtml(res, html);
      return;
    }
    if (p === "/api/chart-data") {
      sendJson(res, { series: "bars", unit: "score", data: BARS });
      return;
    }
    res.writeHead(404, { "content-type": "text/plain" });
    res.end("fixture: not found");
  },
};
