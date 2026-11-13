import { chromium } from "playwright";
const b = await chromium.launch({ headless: true, channel: "chrome" });
const p = await (await b.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
await p.goto("http://127.0.0.1:5199/", { waitUntil: "domcontentloaded" });
await p.waitForSelector(".tv-app"); await p.waitForTimeout(1200);
await p.screenshot({ path: "artifacts/tradovate-live-capture/shots/fix-10-final-workspace.png" });
// duplicate scan across rendered tables/selects
const scan = await p.evaluate(() => {
  const dups = (arr) => { const c = {}; arr.forEach((x) => (c[x] = (c[x] || 0) + 1)); return Object.entries(c).filter(([, n]) => n > 1); };
  const out = {};
  out.tabs = [...document.querySelectorAll(".tv-module-tab")].map((t) => t.innerText.replace(/[✕＋]/g, "").trim());
  out.selects = [...document.querySelectorAll("select")].map((s) => ({ value: s.value, options: [...s.options].length, dup: dups([...s.options].map((o) => o.value)) }));
  out.tableRows = [...document.querySelectorAll(".tv-table tbody tr")].map((r) => r.innerText.replace(/\s+/g, " ").trim()).filter(Boolean);
  return { tabDup: dups(out.tabs), selects: out.selects, rowDup: dups(out.tableRows) };
});
console.log(JSON.stringify(scan, null, 1).slice(0, 2000));
await b.close();
