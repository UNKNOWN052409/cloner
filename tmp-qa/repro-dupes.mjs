import { chromium } from "playwright";
const b = await chromium.launch({ headless: true, channel: "chrome" });
const p = await (await b.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
const errs = []; p.on("pageerror", (e) => errs.push(String(e).slice(0, 200)));
await p.goto("http://127.0.0.1:5199/", { waitUntil: "domcontentloaded" });
await p.waitForSelector(".tv-app"); await p.waitForTimeout(1000);
const dupes = (arr) => { const c = {}; arr.forEach((x) => (c[x] = (c[x] || 0) + 1)); return Object.entries(c).filter(([, n]) => n > 1); };

const addTile = async (name) => {
  if ((await p.locator(".tv-palette").count()) === 0) { await p.click(".tv-plus"); await p.waitForTimeout(250); }
  await p.locator(".tv-palette-tile").filter({ hasText: name }).first().click();
  await p.waitForTimeout(600);
};
// accounts module via palette
await addTile("Accounts");
const accTexts = await p.evaluate(() => [...document.querySelectorAll(".mod-accounts tr")].map((r) => r.innerText.replace(/\s+/g, " ").trim()).filter(Boolean));
console.log("ACCOUNTS rows:", JSON.stringify(accTexts));
console.log("ACCOUNTS dup rows:", JSON.stringify(dupes(accTexts)));

// market analyzer
await addTile("Market Analyzer");
const maSyms = await p.evaluate(() => [...document.querySelectorAll(".mod-market-analyzer tbody tr")].map((r) => r.cells[0]?.innerText?.trim()).filter(Boolean));
console.log("MA symbols:", JSON.stringify(maSyms), "dupes:", JSON.stringify(dupes(maSyms)));

// spread matrix
await addTile("Spread Matrix");
const smRows = await p.evaluate(() => [...document.querySelectorAll(".mod-spread-matrix tr")].map((r) => [...r.cells].map((c) => c.innerText.trim()).join("|")).slice(0, 12));
console.log("SM rows:", JSON.stringify(smRows));

// chart symbol select options on default chart
const selOpts = await p.evaluate(() => [...document.querySelectorAll(".tv-symbol-select")].flatMap((s) => [...s.options].map((o) => o.value)));
console.log("symbol select options:", selOpts.length, "dupes:", JSON.stringify(dupes(selOpts)));

// positions/orders after two orders
await p.locator(".tv-symbol-actions .tv-btn--buy").first().click();
await p.waitForTimeout(2000);
const orderRows = await p.evaluate(() => [...document.querySelectorAll(".tv-module .tv-table tbody tr, .tv-module tbody tr")].map((r) => r.innerText.replace(/\s+/g, " ").trim()).filter((t) => /BUY|SELL|MNQ|MBT|MGC/i.test(t)).slice(0, 10));
console.log("order-ish rows:", JSON.stringify(orderRows));
console.log("errors:", errs.slice(0, 5));
await b.close();
