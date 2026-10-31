// Fixture site — responsive behavior (task 3.4.7): a single page with REAL CSS
// media queries at 768/1024 that (a) hides the sidebar, (b) reorders the cards,
// (c) collapses the navigation behind the menu toggle, and (d) discretely
// resizes the brand mark. Exploration captures it, reconstruction must
// reproduce the same behavior at 1440/768/390 from per-viewport evidence.
//
// Design notes (matched to the capture stages):
//  - The nav toggle stays VISIBLE at the desktop viewport on purpose: the DOM
//    extractor skips sub-2px boxes (src/intelligence/dom-extractor.js:19), so a
//    display:none hamburger would never reach dom.json and could never be wired
//    in the clone. A permanently-present "Menu" button is a common pattern and
//    keeps desktop clone == desktop original.
//  - Class names feed captureResponsive's container selector
//    (src/assets/asset-manifest.js:66-67 — "body > div, main,
//    [class*='container'], [class*='wrapper']"): header-container,
//    page-body, content (main) and sidebar container are all captured, giving
//    the pipeline's responsive.json real per-viewport container evidence.
//  - The sidebar keeps the "sidebar" token first so the clone's renderNode
//    (first-class-token only) still exposes a .sidebar hook, and the runtime's
//    existing [class*='sidebar'] handlers (src/runtimeTemplate.js:159,271)
//    recognize it.
//  - No control text matches the engine's dangerous-word filter, links are
//    href="#" (allowed anchors), and there are no forms.
import { sendHtml, reqUrl } from "./server.mjs";

const html = `<!DOCTYPE html><html><head><title>Northwind — responsive</title><style>
* { box-sizing: border-box; }
body { margin: 0; font-family: Arial, Helvetica, sans-serif; color: #1c2330; background: #f4f6fa; }
.header-container { display: flex; align-items: center; gap: 18px; padding: 14px 24px; background: #101828; }
.brand-mark { width: 220px; height: 44px; background: #2e90fa; border-radius: 6px; }
.nav-toggle { display: inline-flex; align-items: center; padding: 8px 14px; font-size: 14px; background: #344054; color: #fff; border: 0; border-radius: 6px; cursor: pointer; }
.nav-menu { display: flex; gap: 16px; margin-left: auto; }
.nav-menu a { color: #e4e7ec; text-decoration: none; font-size: 15px; }
.page-body { display: flex; align-items: flex-start; gap: 24px; padding: 24px; min-height: 72vh; }
.sidebar { width: 260px; padding: 16px; background: #ffffff; border: 1px solid #d0d5dd; border-radius: 8px; }
.content { flex: 1; min-width: 0; }
.cards { display: flex; gap: 18px; }
.card { width: 230px; padding: 16px; background: #ffffff; border: 1px solid #d0d5dd; border-radius: 8px; }

/* --- original responsive behavior, breakpoints 1024 / 768 --- */
@media (max-width: 1024px) {
  .sidebar { display: none; }        /* sidebar hidden from tablet down */
  .brand-mark { width: 64%; }        /* brand discretely widens */
  .card-b { order: -1; }             /* cards reorder: B, A, C */
}
@media (max-width: 768px) {
  .nav-menu { display: none; }       /* nav collapses behind the toggle */
  .nav-menu.open { display: flex; }  /* toggle click reveals it */
}
</style></head><body>
<header class="header-container">
  <div class="brand-mark"></div>
  <button class="nav-toggle" type="button">Menu</button>
  <nav class="nav-menu" id="nav-menu">
    <a href="#">Overview</a>
    <a href="#">Reports</a>
    <a href="#">Billing</a>
    <a href="#">Customers</a>
    <a href="#">Settings</a>
  </nav>
</header>
<div class="page-body">
  <aside class="sidebar container" id="main-sidebar">
    <h2>Sidebar</h2>
    <ul>
      <li>Workspace summary</li>
      <li>Recent activity</li>
      <li>Saved filters</li>
      <li>Team members</li>
    </ul>
  </aside>
  <main class="content">
    <h1>Northwind operations</h1>
    <p>Operational overview for the Northwind workspace with per-region delivery metrics and weekly summaries.</p>
    <div class="cards">
      <article class="card card-a"><h3>Card A</h3><p>Deliveries on time across the northern region for this week.</p></article>
      <article class="card card-b"><h3>Card B</h3><p>Warehouse throughput measured against the monthly plan.</p></article>
      <article class="card card-c"><h3>Card C</h3><p>Customer satisfaction index across all supported channels.</p></article>
    </div>
  </main>
</div>
<script>
// original hamburger behavior: toggles the menu at collapsed widths
document.querySelector('.nav-toggle').addEventListener('click', function () {
  document.getElementById('nav-menu').classList.toggle('open');
});
</script></body></html>`;

export const responsivePageSite = {
  name: "responsive-page",
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
export const responsivePageHtml = html;
