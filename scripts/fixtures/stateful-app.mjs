// Fixture site 4 — stateful SPA (task 3.5.3): URL-hash routing + nested filter
// state + localStorage persistence, the three state sources deep application-
// state reconstruction must restore.
//
// State model (each axis independent, rendered together):
//   - hash route + view state: "#/items?view=all|active" — the view segment is
//     URL state that must survive a direct load of a deep-linked hash.
//   - category tabs: data-cat="all|books|tools" — books holds 6 items (2 pages
//     at PAGE_SIZE=4) so nested pagination evidence is capturable; sort select:
//     #sort (title / price-asc / price-desc), marked data-cloner-state so the
//     capture script reads it on the generic (no-probe) path.
//   - pagination: #page-down / #page-up buttons (page 1..3, page label #page-lbl).
//   - query param mirror: clicking a nav route also writes ?route=<view> via
//     history.replaceState (the spa-hash.mjs "state sync" pattern the engine
//     already observes), so query state is exercised too.
//   - localStorage "stateful:theme" (light/dark toggle) + "stateful:cartCount":
//     local UI state — the original restores theme on load, so the clone must
//     restore it from the SAME storage (the runtime reads/writes the real key).
//   - session-visible: #status text shows current full state ("books ·
//     price-asc · page 2 · active") — the deterministic assertion target.
//
// Probe API for capture/tests (harmless in the live fixture):
//   window.__STATEFUL_STATE() → { hash, query, theme, cartCount, view, cat,
//     sort, page, items[] } — the single JSON read every stage asserts against.
//
// Design notes matched to the engine (see widgets.mjs / spa-hash.mjs headers):
//  - nav + tab + page controls are <button>s (hash anchors are skipped by the
//    interaction explorer); the sort control is a real <select> the capture
//    script reads directly — the interaction explorer never clicks form controls.
//  - the theme toggle button has class "theme-toggle" (no modal/dropdown words,
//    no dangerous verbs) and toggles a "dark" class on <body> — the restore
//    assertion reads body.classList.
//  - one page only; everything else is client state, so exploration stays cheap.
import { sendHtml, reqUrl } from "./server.mjs";

const items = [
  { id: 1, title: "Aurora Lamp", cat: "books", price: 12 },
  { id: 2, title: "Basalt Mat", cat: "tools", price: 30 },
  { id: 3, title: "Cedar Box", cat: "books", price: 18 },
  { id: 4, title: "Dune Kit", cat: "tools", price: 24 },
  { id: 5, title: "Ember Mug", cat: "books", price: 9 },
  { id: 6, title: "Flint Saw", cat: "tools", price: 40 },
  { id: 7, title: "Gale Rope", cat: "tools", price: 15 },
  { id: 8, title: "Halo Pen", cat: "books", price: 6 },
  { id: 9, title: "Ivory Atlas", cat: "books", price: 21 },
  { id: 10, title: "Juniper Tin", cat: "books", price: 11 },
];

const html = `<!DOCTYPE html><html><head><title>Stackline Store — stateful</title><style>
body{font-family:Tahoma,Arial,sans-serif;margin:0;color:#233;background:#f4f6f9}
body.dark{background:#141a24;color:#dfe7f2}
.topbar{background:#28405e;color:#fff;padding:16px 26px;display:flex;gap:14px;align-items:center}
.topbar h1{margin:0;font-size:21px;margin-right:auto}
.topbar button{padding:8px 14px;font-size:14px;cursor:pointer}
main{max-width:760px;margin:24px auto;padding:20px;background:#fff;border:1px solid #ccd}
body.dark main{background:#1d2534;border-color:#33415a}
.controls{display:flex;gap:10px;flex-wrap:wrap;align-items:center;margin-bottom:14px}
.cat-btn{padding:8px 14px;font-size:14px;background:#e8ecf3;border:1px solid #9db}
.cat-btn.active{background:#28405e;color:#fff}
#sort{padding:7px 10px;font-size:14px}
.pager{display:flex;gap:8px;align-items:center;margin:14px 0}
.pager button{padding:6px 12px;font-size:14px}
#item-list{list-style:none;padding:0;margin:0}
#item-list li{display:flex;justify-content:space-between;padding:10px 12px;border-bottom:1px solid #dde;font-size:15px}
#status{margin-top:14px;font-size:14px;color:#557;min-height:20px}
body.dark #status{color:#9fb3d1}
</style></head><body>
<header class="topbar">
  <h1>Stackline Store</h1>
  <button class="theme-toggle" id="theme-toggle">Toggle theme</button>
  <button class="cart-btn" id="cart-add">Add to cart</button>
</header>
<main>
  <div class="controls" role="group" aria-label="filters">
    <button class="cat-btn" data-cat="all">All</button>
    <button class="cat-btn" data-cat="books">Books</button>
    <button class="cat-btn" data-cat="tools">Tools</button>
    <select id="sort" aria-label="Sort order" data-cloner-state="sort">
      <option value="title">Title</option>
      <option value="price-asc">Price ↑</option>
      <option value="price-desc">Price ↓</option>
    </select>
  </div>
  <ul id="item-list"></ul>
  <div class="pager">
    <button id="page-down">Prev page</button>
    <span id="page-lbl">Page 1</span>
    <button id="page-up">Next page</button>
  </div>
  <p id="status">all · title · page 1 · all</p>
</main>
<script>
var ITEMS = ${JSON.stringify(items)};
var PAGE_SIZE = 4;
function store(k, d) { try { return localStorage.getItem(k) || d; } catch (e) { return d; } }
function save(k, v) { try { localStorage.setItem(k, v); } catch (e) {} }

var theme = store("stateful:theme", "light");
function applyTheme() { document.body.classList.toggle("dark", theme === "dark"); }
function toggleTheme() { theme = theme === "dark" ? "light" : "dark"; save("stateful:theme", theme); applyTheme(); }

var cartCount = parseInt(store("stateful:cartCount", "0"), 10) || 0;

// ---- hash state: "#/items?view=all" — view survives a direct deep-link load
function viewFromHash() {
  var m = (location.hash || "").match(/view=(all|active)/);
  return m ? m[1] : "all";
}
function setHashView(view) {
  history.replaceState(null, "", "/?route=" + view + "#/items?view=" + view);
}

var st = { cat: "all", sort: "title", page: 1 };
function visibleItems() {
  var list = ITEMS.filter(function (it) {
    return st.cat === "all" || it.cat === st.cat;
  });
  if (st.sort === "price-asc") list = list.slice().sort(function (a, b) { return a.price - b.price; });
  else if (st.sort === "price-desc") list = list.slice().sort(function (a, b) { return b.price - a.price; });
  else list = list.slice().sort(function (a, b) { return a.title < b.title ? -1 : 1; });
  return list;
}
function render() {
  var view = viewFromHash();
  var list = visibleItems();
  var pages = Math.max(1, Math.ceil(list.length / PAGE_SIZE));
  if (st.page > pages) st.page = pages;
  var slice = list.slice((st.page - 1) * PAGE_SIZE, st.page * PAGE_SIZE);
  var out = "";
  for (var i = 0; i < slice.length; i++) {
    var it = slice[i];
    var line = it.title + (view === "active" ? " •" : "");
    out += '<li><span>' + line + '</span><span>$' + it.price + '</span></li>';
  }
  document.getElementById("item-list").innerHTML = out;
  document.getElementById("page-lbl").textContent = "Page " + st.page;
  var btns = document.querySelectorAll(".cat-btn");
  for (var k = 0; k < btns.length; k++) btns[k].classList.toggle("active", btns[k].getAttribute("data-cat") === st.cat);
  document.getElementById("sort").value = st.sort;
  var viewName = view === "active" ? "active" : "all";
  document.getElementById("status").textContent = st.cat + " · " + st.sort + " · page " + st.page + " · " + viewName;
}
function nav(v) { setHashView(v); render(); } // route click → hash + query sync

// ---- controls
var catBtns = document.querySelectorAll(".cat-btn");
for (var i = 0; i < catBtns.length; i++) {
  catBtns[i].addEventListener("click", function (e) {
    st.cat = e.currentTarget.getAttribute("data-cat"); st.page = 1; render();
  });
}
document.getElementById("sort").addEventListener("change", function (e) {
  st.sort = e.target.value; st.page = 1; render();
});
document.getElementById("page-up").addEventListener("click", function () {
  var pages = Math.max(1, Math.ceil(visibleItems().length / PAGE_SIZE));
  if (st.page < pages) { st.page++; render(); }
});
document.getElementById("page-down").addEventListener("click", function () {
  if (st.page > 1) { st.page--; render(); }
});
document.getElementById("theme-toggle").addEventListener("click", toggleTheme);
document.getElementById("cart-add").addEventListener("click", function () {
  cartCount++; save("stateful:cartCount", String(cartCount)); render();
});

// deep-link restore: a direct load of #/items?view=active starts on active view
window.addEventListener("hashchange", render);
applyTheme();
render();

// probe for capture + tests (harmless in the fixture, mirrors real app debug APIs)
window.__STATEFUL_STATE = function () {
  var list = visibleItems();
  return {
    hash: location.hash || "",
    query: location.search || "",
    theme: document.body.classList.contains("dark") ? "dark" : "light",
    cartCount: cartCount,
    view: viewFromHash(),
    cat: st.cat, sort: st.sort, page: st.page,
    titles: list.map(function (it) { return it.title; }),
    rendered: [].map.call(document.querySelectorAll("#item-list li span:first-child"), function (n) { return n.textContent; })
  };
};
</script></body></html>`;

export const statefulAppSite = {
  name: "stateful-app",
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
