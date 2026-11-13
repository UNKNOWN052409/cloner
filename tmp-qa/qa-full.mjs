import { chromium } from "playwright";
import fs from "node:fs";
const OUT = "artifacts/tradovate-live-capture/qa-full";
fs.mkdirSync(OUT, { recursive: true });
const b = await chromium.launch({ headless: false, channel: "chrome" });
const p = await (await b.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
const errs = [];
p.on("pageerror", (e) => errs.push("pageerror: " + String(e).slice(0, 200)));
p.on("console", (m) => { if (m.type() === "error") errs.push("console: " + m.text().slice(0, 200)); });
await p.goto("http://127.0.0.1:5199/", { waitUntil: "domcontentloaded" });
await p.waitForSelector(".tv-app"); await p.waitForTimeout(1200);

const shot = async (n) => p.screenshot({ path: `${OUT}/${n}.png` });
const contrast = async (label) => p.evaluate((label) => {
  const lum = (c) => { const m = c.match(/rgba?\(([\d.]+),\s*([\d.]+),\s*([\d.]+)/); if (!m) return null; const [r,g,b] = [m[1],m[2],m[3]].map(Number); const f = (v) => { v/=255; return v<=0.03928? v/12.92 : Math.pow((v+0.055)/1.055,2.4); }; return 0.2126*f(r)+0.7152*f(g)+0.0722*f(b); };
  const bgOf = (el) => { let e = el; while (e) { const cs = getComputedStyle(e); const bg = cs.backgroundColor; if (bg && !/rgba?\(0,\s*0,\s*0,\s*0\)/.test(bg)) return bg; e = e.parentElement; } return getComputedStyle(document.body).backgroundColor; };
  const bad = [];
  for (const el of document.querySelectorAll(".tv-menu-item, .tv-menu-heading, .tv-symbol-picker-row, .tv-palette-label, .tv-btn, select, option, .tv-table td, .tv-table th, .tv-metric-label, .tv-metric-value, .tv-menu .tv-kv span, .tv-menu .tv-kv b")) {
    if (!el.offsetParent && el.tagName !== "OPTION") continue;
    const cs = getComputedStyle(el);
    const fg = lum(cs.color), bg = lum(bgOf(el));
    if (fg == null || bg == null) continue;
    const ratio = (Math.max(fg, bg) + 0.05) / (Math.min(fg, bg) + 0.05);
    if (ratio < 2.2) bad.push({ tag: el.tagName, cls: (el.className||"").toString().slice(0,50), text: (el.innerText||"").slice(0,30), fg: cs.color, bg: bgOf(el), ratio: +ratio.toFixed(2) });
  }
  return { label, bad: bad.slice(0, 25) };
}, label);

const results = [];
// 1) top bar menus
await p.locator(".tv-metric-btn").first().click(); await p.waitForTimeout(350);
await shot("01-account-menu"); results.push(await contrast("account-menu"));
await p.keyboard.press("Escape"); await p.waitForTimeout(200);
await p.locator(".tv-bell-wrap .tv-icon-btn").click(); await p.waitForTimeout(350);
await shot("02-notifications"); results.push(await contrast("notifications"));
await p.keyboard.press("Escape"); await p.waitForTimeout(200);
await p.locator(".tv-layout-btn").click(); await p.waitForTimeout(350);
await shot("03-settings"); results.push(await contrast("settings-modal"));
await p.keyboard.press("Escape"); await p.waitForTimeout(200);
await p.keyboard.press("/"); await p.waitForTimeout(400);
await shot("04-search"); results.push(await contrast("search-modal"));
await p.keyboard.press("Escape"); await p.waitForTimeout(200);

// 2) module settings menu (gear on chart module)
const chartModule = p.locator(".tv-module").nth(1);
await chartModule.locator(".tv-module-actions .tv-icon-btn").nth(2).click(); await p.waitForTimeout(400);
await shot("05-chart-settings-menu"); results.push(await contrast("chart-settings"));
await p.keyboard.press("Escape"); await p.waitForTimeout(200);

// 3) symbol picker
await p.locator(".tv-symbol-picker-btn").first().click(); await p.waitForTimeout(400);
await shot("06-symbol-picker"); results.push(await contrast("symbol-picker"));
await p.keyboard.press("Escape"); await p.waitForTimeout(200);

// 4) palette
await p.click(".tv-plus"); await p.waitForTimeout(500);
await shot("07-palette"); results.push(await contrast("palette"));
await p.keyboard.press("Escape"); await p.waitForTimeout(200);

// 5) multi charts: add chart pane, then a second one, set different symbols
const before = await p.locator("canvas").count();
await p.click(".tv-plus"); await p.waitForTimeout(250);
await p.locator(".tv-palette-tile").filter({ hasText: "Chart" }).first().click(); await p.waitForTimeout(700);
await p.click(".tv-plus"); await p.waitForTimeout(250);
await p.locator(".tv-palette-tile").filter({ hasText: "Chart" }).first().click(); await p.waitForTimeout(700);
const after = await p.locator("canvas").count();
const cards = await p.locator(".tv-symbol-card").count();
await shot("08-multi-chart");
results.push({ label: "multi-chart", canvasesBefore: before, canvasesAfter: after, symbolCards: cards });
// set the second chart to another symbol via its picker
const pickers = p.locator(".tv-symbol-picker-btn");
const n = await pickers.count();
if (n >= 2) {
  await pickers.nth(1).click(); await p.waitForTimeout(300);
  await p.keyboard.type("gold"); await p.waitForTimeout(300);
  await p.locator(".tv-symbol-picker-row").first().click(); await p.waitForTimeout(600);
}
const chartsInfo = await p.evaluate(() => [...document.querySelectorAll(".mod-chart")].map((m) => (m.querySelector(".tv-symbol-picker-sym")?.innerText || "?") + " | canvas:" + m.querySelectorAll("canvas").length));
await shot("09-multi-chart-second-symbol");
results.push({ label: "multi-chart-symbols", chartsInfo });

// 6) native select styling probe
results.push(await p.evaluate(() => {
  const s = document.querySelector("select");
  if (!s) return { label: "select-probe", none: true };
  const cs = getComputedStyle(s);
  const o = s.options[0];
  const ocs = getComputedStyle(o);
  return { label: "select-probe", selectBg: cs.backgroundColor, selectColor: cs.color, optionBg: ocs.backgroundColor, optionColor: ocs.color, options: s.options.length };
}));

fs.writeFileSync(`${OUT}/qa-report.json`, JSON.stringify({ results, errors: [...new Set(errs)] }, null, 2));
console.log(JSON.stringify(results, null, 1).slice(0, 6000));
console.log("ERRORS:", [...new Set(errs)].slice(0, 8));
await b.close();
