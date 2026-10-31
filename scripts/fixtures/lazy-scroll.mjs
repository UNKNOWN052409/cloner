// Fixture site 4 — lazy images + infinite scroll with a hard limit.
//
//  - Photos are served from /img/photo-N.png as generated solid-color PNGs and
//    attached through an IntersectionObserver (data-src swap), so the first
//    visible cards request their images during the initial page load.
//  - The feed is filled from /api/items?batch=N: batch 0 is the initial API
//    page (fetched on load), the "Load more items" button loads batches 1..5
//    (five items per batch), and batch 6+ answers { items: [], done: true } —
//    the button then disables itself ("All items loaded").
//  - Note on artifact visibility: the pipeline flushes network.json for a page
//    BEFORE the interaction explorer runs (src/pipeline/exploration-pipeline.js),
//    so artifact-visible traffic is the initial batch-0 fetch plus lazy image
//    loads; explorer-driven batch fetches happen after that flush.
import { sendHtml, sendJson, reqUrl, solidPng } from "./server.mjs";

const COLORS = [[46, 110, 64], [31, 84, 150], [140, 84, 20], [90, 60, 140], [150, 50, 60]];
const TITLES = ["Canopy line", "Harbor mist", "Ridge trail", "Lake pier", "Old lighthouse", "Pine grove", "Sand quarry", "Moss wall", "River bend", "Field fog"];

const html = `<!DOCTYPE html><html><head><title>Photon Gallery</title><style>
body{font-family:Trebuchet MS,Arial,sans-serif;margin:0;color:#222;background:#f7f7f2}
main{max-width:760px;margin:26px auto;padding:20px}
h1{font-size:26px;margin:0 0 8px}
.lede{color:#555}
#feed{margin-top:16px}
.photo-card{margin:0 0 14px;border:1px solid #bbc;background:#fff;padding:10px;width:264px}
.photo{display:block;width:240px;height:160px;background:#dde}
figcaption{font-size:13px;color:#555;margin-top:6px}
.load-btn{padding:10px 18px;font-size:15px;margin-top:8px}
.feed-status{color:#666;font-size:14px}
</style></head><body>
<main>
<h1>Photon Gallery</h1>
<p class="lede">Photos attach lazily as they enter the viewport; the feed grows in batches with a hard limit of five extra batches.</p>
<div id="feed"></div>
<button class="load-btn" id="load-more">Load more items</button>
<p class="feed-status" id="feed-status">Loading feed…</p>
</main>
<script>
var batch = -1, LIMIT = 5;
var io = new IntersectionObserver(function (entries) {
  entries.forEach(function (en) {
    if (en.isIntersecting && en.target.getAttribute('data-src')) {
      en.target.src = en.target.getAttribute('data-src');
      en.target.removeAttribute('data-src');
      io.unobserve(en.target);
    }
  });
}, { rootMargin: '160px' });
function observeLazy() {
  var imgs = document.querySelectorAll('img[data-src]');
  for (var i = 0; i < imgs.length; i++) io.observe(imgs[i]);
}
function appendBatch(data) {
  var feed = document.getElementById('feed');
  for (var i = 0; i < data.items.length; i++) {
    var it = data.items[i];
    var fig = document.createElement('figure');
    fig.className = 'photo-card';
    fig.innerHTML = '<img class="photo" loading="lazy" data-src="/img/photo-' + it.n + '.png" alt="Archive photo ' + it.n + '" width="240" height="160">' +
      '<figcaption>' + it.title + ' — shelf record ' + it.n + '</figcaption>';
    feed.appendChild(fig);
  }
  observeLazy();
  var shown = document.querySelectorAll('.photo-card').length;
  document.getElementById('feed-status').textContent = 'Showing ' + shown + ' of 30 items.' + (data.done ? ' Feed limit reached.' : '');
}
async function loadNextBatch() {
  if (batch >= LIMIT) return;
  batch++;
  var res = await fetch('/api/items?batch=' + batch);
  var data = await res.json();
  appendBatch(data);
  if (batch >= LIMIT) {
    var btn = document.getElementById('load-more');
    btn.disabled = true;
    btn.textContent = 'All items loaded';
  }
}
document.getElementById('load-more').addEventListener('click', loadNextBatch);
loadNextBatch(); // initial API page (batch 0)
</script></body></html>`;

export const lazyScrollSite = {
  name: "lazy-scroll",
  entry: "/",
  handle(req, res) {
    const u = reqUrl(req);
    if (u.pathname === "/") {
      sendHtml(res, html);
      return;
    }
    if (u.pathname === "/api/items") {
      const batch = Number(u.searchParams.get("batch") || 0);
      if (batch >= 0 && batch <= 5) {
        const items = [0, 1, 2, 3, 4].map((i) => ({
          n: batch * 5 + i + 1,
          title: TITLES[(batch * 5 + i) % TITLES.length],
        }));
        sendJson(res, { batch, items, done: batch >= 5 });
      } else {
        sendJson(res, { batch, items: [], done: true });
      }
      return;
    }
    const img = u.pathname.match(/^\/img\/([a-z0-9-]+)\.png$/i);
    if (img) {
      const num = Number((img[1].match(/(\d+)/) || [0, 0])[1]);
      const c = COLORS[Math.abs(num) % COLORS.length];
      res.writeHead(200, { "content-type": "image/png", "cache-control": "no-store" });
      res.end(solidPng(c[0], c[1], c[2]));
      return;
    }
    res.writeHead(404, { "content-type": "text/plain" });
    res.end("fixture: not found");
  },
};
