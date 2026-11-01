// Category fixture — e-commerce storefront (task 3.5.1).
//
// 3 routes joined by a real <nav> + <header> band with a cart badge:
//   "/"            storefront landing  — product grid (6 same-size .product-card
//                  siblings in a .product-grid container) + pricing teasers
//   "/catalog"     category listing    — filter sidebar + a 9-card product grid
//   "/telescope-kit"         — product detail: price, quantity form,
//                  add-to-cart button (data-cloner-trigger), specs table
//
// Everything is inline HTML/JS with zero deps; the cart badge is a client-side
// counter the understanding stage must read from the DOM, not from a special
// case. No credentials, no external hosts — images are generated locally by
// the shared fixture server helper (solidPng).
import { sendHtml, sendJson, reqUrl, solidPng } from "./server.mjs";

const CSS = `
body{font-family:Arial,Helvetica,sans-serif;margin:0;color:#1c2330;background:#f7f7f9}
.site-header{display:flex;align-items:center;justify-content:space-between;background:#111c33;color:#fff;padding:14px 24px}
.site-header .logo{font-size:20px;font-weight:bold}
.cart-badge{background:#c0392b;color:#fff;border-radius:12px;padding:2px 10px;font-size:13px;margin-left:8px}
.site-nav{background:#1b2b4d;padding:10px 24px}
.site-nav a{color:#e8ecf5;margin-right:18px;text-decoration:none;font-size:15px}
main{max-width:960px;margin:24px auto;padding:0 16px}
h1{font-size:26px;margin:8px 0 12px}
.product-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:16px;margin-top:16px}
.product-card{background:#fff;border:1px solid #d9dde5;border-radius:8px;padding:14px}
.product-card img{width:100%;height:90px;object-fit:cover;border-radius:4px;background:#e8ecf3}
.product-card h3{font-size:16px;margin:8px 0 4px}
.product-card .price{color:#0a7d33;font-weight:bold}
.product-card button{margin-top:8px;padding:6px 12px;background:#0a5bd3;color:#fff;border:0;border-radius:4px;cursor:pointer}
.catalog-layout{display:flex;gap:20px;margin-top:16px}
.filters{width:200px;flex-shrink:0;background:#fff;border:1px solid #d9dde5;border-radius:8px;padding:14px}
.filters h3{font-size:14px;margin:0 0 8px}
.filters label{display:block;font-size:13px;margin:6px 0}
.catalog-results{flex-grow:1}
.result-count{font-size:13px;color:#5a6472}
.pricing-table{border-collapse:collapse;margin-top:10px;background:#fff}
.pricing-table td,.pricing-table th{border:1px solid #b9c0cc;padding:8px 14px;font-size:14px}
.pdp{background:#fff;border:1px solid #d9dde5;border-radius:8px;padding:20px;margin-top:16px}
.pdp .price{font-size:22px;color:#0a7d33;font-weight:bold}
.pdp form{margin-top:12px}
.specs-table{border-collapse:collapse;margin-top:14px}
.specs-table td{border:1px solid #cdd3de;padding:6px 12px;font-size:13px}
.site-footer{background:#111c33;color:#c7cedd;text-align:center;padding:16px;margin-top:32px}
`;

// a product card — repeated sibling markup (the repetition evidence the
// card/card-grid votes key on); image srcs are absolute paths so the network
// recorder sees real image requests.
function productCard(p) {
  return `<div class="product-card" data-sku="${p.sku}">
<img src="/img/${p.sku}.png" alt="${p.name}" width="200" height="90">
<h3>${p.name}</h3>
<p class="price">$${p.price}</p>
<button type="button" class="add-to-cart" data-cloner-trigger="add-to-cart" aria-label="Add ${p.name} to cart">Add to cart</button>
</div>`;
}

const PRODUCTS = [
  { sku: "refractor-80", name: "Starlight Refractor 80", price: 249 },
  { sku: "dobson-10", name: "Heritage Dobson 10", price: 649 },
  { sku: "binoculars-8x42", name: "Trailview 8x42 Binoculars", price: 139 },
  { sku: "tripod-steel", name: "Equinox Steel Tripod", price: 89 },
  { sku: "eyepiece-kit", name: "Wideview Eyepiece Kit", price: 119 },
  { sku: "filter-set", name: "Lunar Filter Set", price: 59 },
  { sku: "red-dot", name: "Pointer Red-Dot Finder", price: 45 },
  { sku: "dew-shield", name: "Nightshift Dew Shield", price: 39 },
  { sku: "star-diagonal", name: "Mirror Star Diagonal", price: 79 },
];

const CATALOG_1 = PRODUCTS.slice(0, 6).map(productCard).join("\n");
const CATALOG_2 = PRODUCTS.slice(3).map(productCard).join("\n");

const HOME = `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><title>Astro Retail — Telescopes & Optics</title>
<style>${CSS}</style></head><body>
<header class="site-header">
  <div class="logo">Astro Retail</div>
  <div class="header-tools">
    <a href="/cart" aria-label="Cart">Cart <span class="cart-badge" id="cart-count">0</span></a>
  </div>
</header>
<nav class="site-nav">
  <a href="/">Home</a>
  <a href="/catalog">Catalog</a>
  <a href="/telescope-kit">Featured kit</a>
</nav>
<main>
  <h1>Optics for backyard astronomers</h1>
  <p>Warehouse-direct telescopes, mounts and accessories with a 30-night return window.</p>
  <div class="product-grid">
${CATALOG_1}
  </div>
  <h2>Membership pricing</h2>
  <table class="pricing-table">
    <tr><th>Plan</th><th>Shipping</th><th>Monthly price</th></tr>
    <tr><td>Observer</td><td>standard</td><td>$0</td></tr>
    <tr><td>Stargazer</td><td>priority</td><td>$9</td></tr>
  </table>
</main>
<footer class="site-footer">© Astro Retail · 44 Harbor Lane · returns within 30 nights</footer>
<script>
let cart = 0;
function updateCart(){ document.getElementById("cart-count").textContent = String(cart); }
window.addEventListener("click", function (ev) {
  var btn = ev.target.closest ? ev.target.closest(".add-to-cart") : null;
  if (btn) { cart += 1; updateCart(); }
});
window.__astro = {
  addToCart: function (sku) { cart += 1; updateCart(); return cart; },
  cartCount: function () { return cart; },
};
</script>
</body></html>`;

const CATALOG = `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><title>Catalog — Astro Retail</title>
<style>${CSS}</style></head><body>
<header class="site-header">
  <div class="logo">Astro Retail</div>
  <div class="header-tools">
    <a href="/cart" aria-label="Cart">Cart <span class="cart-badge" id="cart-count">0</span></a>
  </div>
</header>
<nav class="site-nav">
  <a href="/">Home</a>
  <a href="/catalog">Catalog</a>
  <a href="/telescope-kit">Featured kit</a>
</nav>
<main>
  <div class="catalog-layout">
    <aside class="filters" aria-label="Catalog filters">
      <h3>Filter results</h3>
      <form method="get" action="/catalog">
        <label>Min price <input type="number" name="min" value="0" size="4"></label>
        <label>Max price <input type="number" name="max" value="999" size="4"></label>
        <label><input type="checkbox" name="inStock" checked> In stock only</label>
        <label>Sort
          <select name="sort"><option value="popular">Most popular</option><option value="price-asc">Price ↑</option></select>
        </label>
        <button type="submit">Apply filters</button>
      </form>
    </aside>
    <section class="catalog-results">
      <h1>Catalog</h1>
      <p class="result-count">Showing 6 of 9 products</p>
      <div class="product-grid">
${CATALOG_2}
      </div>
    </section>
  </div>
</main>
<footer class="site-footer">© Astro Retail · 44 Harbor Lane · returns within 30 nights</footer>
</body></html>`;

const PDP = `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><title>Telescope Kit — Astro Retail</title>
<style>${CSS}</style></head><body>
<header class="site-header">
  <div class="logo">Astro Retail</div>
  <div class="header-tools">
    <a href="/cart" aria-label="Cart">Cart <span class="cart-badge" id="cart-count">0</span></a>
  </div>
</header>
<nav class="site-nav">
  <a href="/">Home</a>
  <a href="/catalog">Catalog</a>
  <a href="/telescope-kit">Featured kit</a>
</nav>
<main>
  <h1>Starter Telescope Kit</h1>
  <div class="pdp">
    <img src="/img/telescope-kit.png" alt="Starter Telescope Kit" width="320" height="140">
    <p class="price">$399.00</p>
    <p>Everything a first telescope needs: 80mm refractor, steel tripod, two eyepieces and a lunar filter.</p>
    <form action="/cart" method="post" class="add-form">
      <label>Quantity <input type="number" name="qty" value="1" min="1" max="9" size="3"></label>
      <button type="submit" class="add-to-cart" data-cloner-trigger="add-to-cart">Add to cart</button>
    </form>
    <h2>Specifications</h2>
    <table class="specs-table">
      <tr><td>Aperture</td><td>80 mm</td></tr>
      <tr><td>Focal length</td><td>400 mm</td></tr>
      <tr><td>Mount</td><td>alt-azimuth</td></tr>
      <tr><td>Weight</td><td>4.2 kg</td></tr>
    </table>
  </div>
</main>
<footer class="site-footer">© Astro Retail · 44 Harbor Lane · returns within 30 nights</footer>
</body></html>`;

const CART = `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><title>Cart — Astro Retail</title>
<style>${CSS}</style></head><body>
<header class="site-header">
  <div class="logo">Astro Retail</div>
  <div class="header-tools">
    <a href="/cart" aria-label="Cart">Cart <span class="cart-badge" id="cart-count">0</span></a>
  </div>
</header>
<nav class="site-nav">
  <a href="/">Home</a>
  <a href="/catalog">Catalog</a>
  <a href="/telescope-kit">Featured kit</a>
</nav>
<main>
  <h1>Your cart</h1>
  <p>Your cart is empty — add a telescope from the <a href="/catalog">catalog</a>.</p>
</main>
<footer class="site-footer">© Astro Retail · 44 Harbor Lane · returns within 30 nights</footer>
</body></html>`;

const PAGES = {
  "/": HOME,
  "/catalog": CATALOG,
  "/telescope-kit": PDP,
  "/cart": CART,
};

export const ecommerceCategorySite = {
  name: "category-ecommerce",
  category: "e-commerce",
  entry: "/",
  handle(req, res) {
    const u = reqUrl(req);
    if (u.pathname.startsWith("/img/")) {
      const sku = u.pathname.slice("/img/".length).replace(/\.png$/, "");
      // deterministic palette per sku so different products differ visually
      let h = 0;
      for (const ch of sku) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
      const png = solidPng(20 + (h % 120), 40 + (h % 160), 80 + (h % 140), 40, 18);
      res.writeHead(200, { "content-type": "image/png", "cache-control": "public, max-age=60" });
      res.end(png);
      return;
    }
    if (u.pathname === "/api/cart") {
      sendJson(res, { items: 0, subtotal: 0 });
      return;
    }
    if (PAGES[u.pathname]) {
      sendHtml(res, PAGES[u.pathname]);
      return;
    }
    res.writeHead(404, { "content-type": "text/plain" });
    res.end("category-ecommerce fixture: not found");
  },
};
