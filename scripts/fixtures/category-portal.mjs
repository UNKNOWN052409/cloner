// Category fixture — civic/utility portal (task 3.5.1).
//
// 4 routes joined by a portal masthead with a service-nav band:
//   "/"            portal landing — service-tile grid + announcement band
//   "/services"    service index  — 8-row services table with status chips
//   "/waste-collection"  — detail page with a booking form
//   "/account"     account page   — login-ish form + records table
//
// The table + filters pattern is the canonical portal evidence shape: a real
// <table> of services plus a filter form whose inputs the understanding stage
// must classify generically. No credentials, no external hosts, zero deps.
import { sendHtml, reqUrl } from "./server.mjs";

const CSS = `
body{font-family:'Segoe UI',Arial,sans-serif;margin:0;color:#242a33;background:#f2f4f1}
.portal-header{background:#0d3b2e;color:#fff;padding:12px 24px;display:flex;justify-content:space-between;align-items:center}
.portal-header .crest{font-weight:bold;font-size:18px}
.portal-header .account-links a{color:#cfe5da;font-size:14px;margin-left:14px;text-decoration:none}
.service-nav{background:#155c48;padding:9px 24px}
.service-nav a{color:#e4f2ec;margin-right:20px;font-size:14px;text-decoration:none}
main{max-width:1000px;margin:0 auto;padding:20px 16px}
h1{font-size:25px;margin:6px 0 10px}
h2{font-size:19px;margin-top:20px}
.announcement{background:#fff6dd;border:1px solid #e8d491;border-radius:6px;padding:10px 14px;font-size:14px;margin-bottom:16px}
.service-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:14px;margin-top:12px}
.service-tile{background:#fff;border:1px solid #cfd6cd;border-radius:8px;padding:14px}
.service-tile h3{font-size:15px;margin:0 0 6px}
.service-tile p{font-size:13px;color:#5d6659;margin:0}
.service-tile a{display:inline-block;margin-top:8px;font-size:13px;color:#0d5c3f}
.services-table{border-collapse:collapse;width:100%;background:#fff;margin-top:12px}
.services-table td,.services-table th{border:1px solid #bcc4bb;padding:8px 12px;font-size:14px;text-align:left}
.status-open,.status-limited,.status-closed{display:inline-block;border-radius:10px;padding:1px 10px;font-size:12px}
.status-open{background:#d8f0dc;color:#0d5c2f}
.status-limited{background:#fdeecd;color:#8a6116}
.status-closed{background:#f7d9d9;color:#8a2222}
.filter-bar{background:#fff;border:1px solid #cfd6cd;border-radius:8px;padding:12px 14px;margin-top:12px}
.filter-bar label{font-size:13px;margin-right:16px}
.filter-bar input,.filter-bar select{font-size:13px;padding:4px 6px;margin-right:6px}
.filter-bar button{background:#0d5c3f;color:#fff;border:0;border-radius:4px;padding:6px 14px;cursor:pointer}
.booking-form{background:#fff;border:1px solid #cfd6cd;border-radius:8px;padding:16px;margin-top:14px;max-width:460px}
.booking-form label{display:block;font-size:13px;margin:10px 0 4px}
.booking-form input,.booking-form select,.booking-form textarea{width:100%;box-sizing:border-box;font-size:14px;padding:6px}
.booking-form button{margin-top:12px;background:#0d5c3f;color:#fff;border:0;border-radius:4px;padding:8px 16px;cursor:pointer}
.portal-footer{background:#0d3b2e;color:#bcd6c9;text-align:center;font-size:13px;padding:14px;margin-top:28px}
`;

const HEADER = `<header class="portal-header">
<div class="crest">Northbrook Civic Portal</div>
<div class="account-links"><a href="/account">My account</a><a href="/account">Sign in</a></div>
</header>
<nav class="service-nav">
<a href="/">Home</a>
<a href="/services">All services</a>
<a href="/waste-collection">Waste & recycling</a>
<a href="/account">Payments</a>
</nav>`;

const FOOTER = `<footer class="portal-footer">Northbrook Council · Civic Centre, 1 Meadow Way · service desk 8am–6pm</footer>`;

function shell(title, body) {
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><title>${title}</title>
<style>${CSS}</style></head><body>${HEADER}<main>${body}</main>${FOOTER}</body></html>`;
}

const SERVICE_TILES = [
  ["Waste & recycling", "Bin days, bulky pickup, drop-off points"],
  ["Building permits", "Applications, inspections, fee schedule"],
  ["Library", "Membership, room booking, events"],
  ["Parks & sport", "Field reservations, gym timetable"],
  ["Public transport", "Timetables, fare cards, disruption alerts"],
  ["Report an issue", "Streetlight, pothole, noise complaints"],
].map(([t, d]) => `<div class="service-tile"><h3>${t}</h3><p>${d}</p></div>`).join("\n");

const SERVICES_TABLE = `<table class="services-table" aria-label="Service catalogue">
<tr><th>Service</th><th>Desk</th><th>Wait time</th><th>Status</th></tr>
<tr><td>Waste & recycling</td><td>Counter A</td><td>10 min</td><td><span class="status-open">open</span></td></tr>
<tr><td>Building permits</td><td>Counter B</td><td>25 min</td><td><span class="status-open">open</span></td></tr>
<tr><td>Library membership</td><td>Counter C</td><td>5 min</td><td><span class="status-open">open</span></td></tr>
<tr><td>Parking permits</td><td>Counter B</td><td>40 min</td><td><span class="status-limited">limited</span></td></tr>
<tr><td>Business licences</td><td>Counter D</td><td>—</td><td><span class="status-closed">closed</span></td></tr>
<tr><td>Registries (births, deaths)</td><td>Counter E</td><td>15 min</td><td><span class="status-open">open</span></td></tr>
<tr><td>Social support</td><td>Counter F</td><td>30 min</td><td><span class="status-limited">limited</span></td></tr>
<tr><td>Lost property</td><td>Counter C</td><td>10 min</td><td><span class="status-open">open</span></td></tr>
</table>`;

const PAGES = {
  "/": shell(
    "Northbrook Civic Portal — Home",
    `<h1>City services in one place</h1>
<div class="announcement">Spring collection dates published — bulky waste pickup moves to Wednesdays from April.</div>
<h2>Popular services</h2>
<div class="service-grid">
${SERVICE_TILES}
</div>`,
  ),
  "/services": shell(
    "All services — Northbrook Civic Portal",
    `<h1>All services</h1>
<div class="filter-bar">
  <form method="get" action="/services">
    <label>Search <input type="search" name="q" placeholder="e.g. waste" size="16"></label>
    <label>Status
      <select name="status"><option value="">Any</option><option>open</option><option>limited</option><option>closed</option></select>
    </label>
    <label>Desk <input type="text" name="desk" placeholder="Counter A" size="9"></label>
    <button type="submit">Filter</button>
  </form>
</div>
${SERVICES_TABLE}`,
  ),
  "/waste-collection": shell(
    "Waste & recycling — Northbrook Civic Portal",
    `<h1>Waste & recycling</h1>
<p>Household bins are collected every Tuesday; recycling alternates weekly. Book a bulky pickup or report a missed collection below.</p>
<div class="booking-form">
  <form method="post" action="/waste-collection/booking" class="waste-booking">
    <label>Collection type
      <select name="type"><option>Bulky item pickup</option><option>Missed collection</option><option>Extra bin</option></select>
    </label>
    <label>Preferred date <input type="date" name="date"></label>
    <label>Address <input type="text" name="address" placeholder="12 Alder Street"></label>
    <label>Notes <textarea name="notes" rows="3"></textarea></label>
    <button type="submit">Book collection</button>
  </form>
</div>
<h2>Bin day lookup</h2>
<table class="services-table"><tr><th>Street</th><th>Refuse day</th><th>Recycling week</th></tr>
<tr><td>Alder Street</td><td>Tuesday</td><td>A</td></tr>
<tr><td>Meadow Way</td><td>Tuesday</td><td>B</td></tr>
</table>`,
  ),
  "/account": shell(
    "My account — Northbrook Civic Portal",
    `<h1>My account</h1>
<div class="booking-form">
  <form method="post" action="/account/session" class="account-signin">
    <label>Reference number <input type="text" name="ref" placeholder="NB-000000"></label>
    <label>PIN <input type="password" name="pin"></label>
    <button type="submit">Sign in</button>
  </form>
</div>
<h2>Recent records (sample)</h2>
<table class="services-table"><tr><th>Date</th><th>Record</th><th>Status</th></tr>
<tr><td>2026-03-14</td><td>Parking permit renewal</td><td><span class="status-open">complete</span></td></tr>
<tr><td>2026-02-02</td><td>Library card issue</td><td><span class="status-open">complete</span></td></tr>
</table>`,
  ),
};

export const portalCategorySite = {
  name: "category-portal",
  category: "portal",
  entry: "/",
  handle(req, res) {
    const p = PAGES[reqUrl(req).pathname];
    if (p) {
      sendHtml(res, p);
      return;
    }
    res.writeHead(404, { "content-type": "text/plain" });
    res.end("category-portal fixture: not found");
  },
};
