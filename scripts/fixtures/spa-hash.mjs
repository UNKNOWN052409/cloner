// Fixture site 2 — SPA with hash routing: three hash routes (#/home, #/library,
// #/settings) with real content swap driven by the hashchange event.
//
// Design notes (matched to the engine's discovery behavior):
//  - Nav items are <button>s, not <a href="#...">: hash anchors are skipped by
//    the interaction explorer (src/interactions.js rejects anchors whose href
//    is not "#"/javascript:) and route dedup strips hashes, so buttons are what
//    a real hash-SPA uses for app controls anyway.
//  - Each navigation mirrors the route into the query string via
//    history.replaceState(null, "", "/?route=" + route) BEFORE setting the
//    hash. This is the common "state sync" pattern and it is what makes the
//    captured SPA transitions observable as distinct routes: the engine's
//    recorder (window.__CLONER_SPA_ROUTES) captures both the replaceState and
//    the hashchange, and route-discovery keeps pathname+search (hash-stripped).
import { sendHtml, reqUrl } from "./server.mjs";

const html = `<!DOCTYPE html><html><head><title>Nimbus Docs — hash SPA</title><style>
body{font-family:Georgia,serif;margin:0;color:#243;background:#fbfaf6}
.site-head{background:#2e4a3f;color:#fff;padding:18px 28px}
.site-head h1{margin:0 0 10px;font-size:24px}
.routes button{background:#fff;color:#2e4a3f;border:1px solid #2e4a3f;padding:9px 18px;margin-right:10px;font-size:15px}
.routes button.active{background:#d9c98a}
main{max-width:680px;margin:28px auto;padding:20px;background:#fff;border:1px solid #cbb}
h2{margin-top:0}
</style></head><body>
<header class="site-head"><h1>Nimbus Docs</h1>
<nav class="routes" role="navigation">
  <button class="route-btn" data-route="home">Home</button>
  <button class="route-btn" data-route="library">Library</button>
  <button class="route-btn" data-route="settings">Settings</button>
</nav></header>
<main id="view"></main>
<script>
var TITLES = { home: "Welcome to Nimbus Docs", library: "Document library", settings: "Workspace settings" };
var BODIES = {
  home: "<p>Nimbus Docs home route. The workspace overview shows recent activity and pinned documents, all rendered by the hash router.</p>",
  library: "<p>Library route. 24 documents are indexed across five collections, sorted by last edit date.</p>",
  settings: "<p>Settings route. Notification rules, display preferences and export formats live here.</p>"
};
function routeFromHash() {
  var h = location.hash || "#/home";
  return h.replace(/^#\\//, "") || "home";
}
function render(route) {
  if (!TITLES[route]) route = "home";
  document.getElementById("view").innerHTML = "<h2>" + TITLES[route] + "</h2>" + BODIES[route];
  var btns = document.querySelectorAll(".route-btn");
  for (var i = 0; i < btns.length; i++) {
    btns[i].classList.toggle("active", btns[i].getAttribute("data-route") === route);
  }
}
window.addEventListener("hashchange", function () { render(routeFromHash()); });
function go(route) {
  history.replaceState(null, "", "/?route=" + route); // state sync; observed by the SPA recorder
  location.hash = "#/" + route;                       // the actual hash route (drives the content swap)
}
var navBtns = document.querySelectorAll(".route-btn");
for (var j = 0; j < navBtns.length; j++) {
  navBtns[j].addEventListener("click", function (e) { go(e.currentTarget.getAttribute("data-route")); });
}
render(routeFromHash());
</script></body></html>`;

export const spaHashSite = {
  name: "spa-hash",
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
