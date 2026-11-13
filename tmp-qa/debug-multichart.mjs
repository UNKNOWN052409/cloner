import { chromium } from "playwright";
const b = await chromium.launch({ headless: true, channel: "chrome" });
const p = await (await b.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
const errs = []; p.on("pageerror", (e) => errs.push(String(e).slice(0, 200)));
await p.goto("http://127.0.0.1:5199/", { waitUntil: "domcontentloaded" });
await p.waitForSelector(".tv-app"); await p.waitForTimeout(900);
const state = () => p.evaluate(() => ({
  modules: document.querySelectorAll(".tv-module").length,
  charts: document.querySelectorAll(".mod-chart").length,
  canvases: document.querySelectorAll("canvas").length,
  tabs: [...document.querySelectorAll(".tv-module-tab")].map((t) => t.innerText.replace(/[✕＋]/g, "").trim()),
}));
console.log("start:", JSON.stringify(await state()));
for (let i = 0; i < 3; i++) {
  await p.click(".tv-plus"); await p.waitForTimeout(300);
  const tiles = await p.locator(".tv-palette-tile").allInnerTexts();
  const chartIdx = tiles.findIndex((t) => /^Chart/.test(t.replace(/\s+/g, " ").trim()));
  console.log("chart tile idx:", chartIdx, "labels:", tiles.map(t=>t.replace(/\s+/g," ").trim()).slice(0,4));
  await p.locator(".tv-palette-tile").nth(chartIdx).click();
  await p.waitForTimeout(600);
  console.log("after add", i, JSON.stringify(await state()));
}
console.log("errors:", errs);
await b.close();
