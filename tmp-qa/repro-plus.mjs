import { chromium } from "playwright";
const b = await chromium.launch({ headless: true, channel: "chrome" });
const p = await (await b.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
const errs = [];
p.on("pageerror", (e) => errs.push(String(e).slice(0, 200)));
p.on("console", (m) => { if (m.type() === "error") errs.push(m.text().slice(0, 300)); });
const shot = async (n) => p.screenshot({ path: `tmp-qa/bug-${n}.png` });
const state = async () => p.evaluate(() => ({
  palettes: document.querySelectorAll(".tv-palette").length,
  paletteBackdrop: !!document.querySelector(".tv-palette-backdrop"),
  modules: document.querySelectorAll(".tv-module").length,
  plusVisible: (() => { const el = document.querySelector(".tv-plus"); if (!el) return "missing"; const r = el.getBoundingClientRect(); const top = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2); return top ? top.className || top.tagName : "none"; })(),
}));
await p.goto("http://127.0.0.1:5199/", { waitUntil: "domcontentloaded" });
await p.waitForSelector(".tv-app"); await p.waitForTimeout(1200);
console.log("initial:", JSON.stringify(await state()));
// 1) first + click
await p.click(".tv-plus"); await p.waitForTimeout(500);
console.log("after first +:", JSON.stringify(await state()));
await shot("01-first-plus");
// 2) close palette via X, click + again
const closeBtn = p.locator(".tv-palette-close");
if (await closeBtn.count()) { await closeBtn.first().click(); await p.waitForTimeout(400); }
console.log("after close:", JSON.stringify(await state()));
await p.click(".tv-plus", { timeout: 5000 }).catch((e) => console.log("PLUS CLICK FAILED:", e.message.split("\n")[0]));
await p.waitForTimeout(500);
console.log("after second +:", JSON.stringify(await state()));
await shot("02-second-plus");
console.log("errors:", errs.slice(0, 6));
await b.close();
