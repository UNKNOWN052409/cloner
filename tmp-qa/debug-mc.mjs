import { chromium } from "playwright";
const b = await chromium.launch({ headless: true, channel: "chrome" });
const p = await (await b.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
const errs=[]; p.on("pageerror",(e)=>errs.push(String(e).slice(0,200)));
await p.goto("http://127.0.0.1:5199/", { waitUntil: "domcontentloaded" });
await p.waitForSelector(".tv-app"); await p.waitForTimeout(900);
for (let i=0;i<3;i++){ await p.click(".tv-plus"); await p.waitForTimeout(300); await p.locator(".tv-palette-tile").nth(1).click(); await p.waitForTimeout(700); }
const info = () => p.evaluate(() => [...document.querySelectorAll(".mod-chart")].map((m) => {
  const r = m.getBoundingClientRect();
  return { sym: m.querySelector(".tv-symbol-picker-sym")?.innerText || "?", canvas: m.querySelectorAll("canvas").length, empty: m.querySelectorAll(".tv-chart-empty").length, w: Math.round(r.width), h: Math.round(r.height) };
}));
console.log("after adds:", JSON.stringify(await info()));
const wanted = ["ESZ6","GCX6","6EZ6","M2KZ6"];
const n = await p.locator(".mod-chart").count();
for (let i=0;i<Math.min(n,wanted.length);i++){
  const ch = p.locator(".mod-chart").nth(i);
  await ch.locator(".tv-symbol-picker-btn").first().click().catch((e)=>console.log("picker click fail", i, e.message.slice(0,60)));
  await p.waitForTimeout(300);
  await p.keyboard.type(wanted[i], { delay: 20 }); await p.waitForTimeout(300);
  await p.locator(".tv-symbol-picker-row").first().click().catch((e)=>console.log("row click fail", i));
  await p.waitForTimeout(500);
  console.log(`chart ${i}:`, JSON.stringify((await info())[i]));
}
console.log("final:", JSON.stringify(await info()), "canvases:", await p.locator("canvas").count());
console.log("errors:", errs.slice(0,6));
await p.screenshot({ path: "artifacts/tradovate-live-capture/qa-full/110-multichart-debug.png" });
await b.close();
