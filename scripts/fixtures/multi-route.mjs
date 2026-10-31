// Fixture site 1 — multi-route static site: 4 pages joined by a real <nav>.
// Route discovery should pick up all 4 paths from the home page's nav links
// (seed "/" + /products + /pricing + /about) and explore each one.
import { sendHtml, reqUrl } from "./server.mjs";

const NAV = '<nav class="site-nav"><a href="/">Home</a><a href="/products">Products</a><a href="/pricing">Pricing</a><a href="/about">About</a></nav>';

const shell = (title, body) => `<!DOCTYPE html><html><head><title>${title}</title><style>
body{font-family:Arial,Helvetica,sans-serif;margin:0;color:#223;background:#f5f6f8}
.site-nav{background:#20315b;padding:14px 24px}
.site-nav a{color:#fff;margin-right:18px;text-decoration:none;font-size:15px}
main{max-width:760px;margin:32px auto;padding:0 16px;background:#fff;min-height:400px;padding:24px;border:1px solid #ccd}
h1{font-size:28px;margin:0 0 12px}
ul{line-height:1.7}
table{border-collapse:collapse;margin-top:8px}
td,th{border:1px solid #99a;padding:8px 14px}
</style></head><body>${NAV}<main>${body}</main></body></html>`;

const pages = {
  "/": shell(
    "Acme Cloud — Home",
    `<h1>Acme Cloud home</h1>
<p>Acme Cloud archives regional weather telemetry and publishes open datasets for researchers and city planners.</p>
<ul><li>14 station networks online</li><li>Hourly archive sync</li><li>Open data licensing</li></ul>
<p>Every dataset page links back to the station network that produced it.</p>`,
  ),
  "/products": shell(
    "Acme Cloud — Products",
    `<h1>Acme Cloud products</h1>
<p>Three product lines cover ingestion, storage and publishing of climate records.</p>
<ul><li>Gauge Collector — station telemetry ingestion</li><li>Deep Freeze — long-term archive storage</li><li>Beacon — public dataset publishing</li></ul>
<p>Each product ships with a migration guide and a regional rollout checklist.</p>`,
  ),
  "/pricing": shell(
    "Acme Cloud — Pricing",
    `<h1>Acme Cloud pricing</h1>
<p>Plans are billed per station network, with archives included.</p>
<table><tr><th>Plan</th><th>Stations</th><th>Monthly price</th></tr>
<tr><td>Observer</td><td>up to 5</td><td>$29</td></tr>
<tr><td>Network</td><td>up to 40</td><td>$149</td></tr>
<tr><td>Atlas</td><td>unlimited</td><td>$480</td></tr></table>`,
  ),
  "/about": shell(
    "Acme Cloud — About",
    `<h1>About Acme Cloud</h1>
<p>Founded in 2011 in Tallinn, Acme Cloud operates 140 weather stations across the Baltic region.</p>
<p>The team of nine engineers maintains the archive pipeline and answers data requests within two working days.</p>`,
  ),
};

export const multiRouteSite = {
  name: "multi-route",
  entry: "/",
  handle(req, res) {
    const key = reqUrl(req).pathname;
    if (pages[key]) {
      sendHtml(res, pages[key]);
      return;
    }
    res.writeHead(404, { "content-type": "text/plain" });
    res.end("fixture: not found");
  },
};
