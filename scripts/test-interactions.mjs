import { chromium } from "playwright";
const url = process.argv[2] || "http://localhost:4173/preview/tradovate-live/index.html";
const target = process.argv[3] || "add-module"; // add-module | any
const b = await chromium.launch({ headless: true }).catch(() => chromium.launch({ headless: true, channel: "msedge" }));
const p = await b.newPage({ viewport: { width: 1440, height: 900 } });
await p.goto(url, { waitUntil: "load", timeout: 30000 }).catch(() => {});
await p.waitForTimeout(2000);
const triggers = await p.evaluate(() => [...document.querySelectorAll("[data-cloner-trigger]")].map((el) => ({
  id: el.getAttribute("data-cloner-trigger"),
  desc: (el.className || "").toString().slice(0, 60) || (el.innerText || "").slice(0, 30),
})));
console.log("triggers in clone:", triggers.length, "| sample:", JSON.stringify(triggers.slice(0, 6)));

let plusId = null;
if (target === "add-module") {
  plusId = await p.evaluate(() => {
    const el =
      document.querySelector(".btn-wrap.add-module[data-cloner-trigger]") ||
      document.querySelector(".add-module [data-cloner-trigger]") ||
      document.querySelector("[class*='add-module'][data-cloner-trigger]");
    if (!el) return null;
    let node = el;
    while (node && node.getAttribute) {
      const id = node.getAttribute && node.getAttribute("data-cloner-trigger");
      if (id) return id;
      node = node.parentNode;
    }
    return null;
  });
} else {
  plusId = target; // explicit trigger id
}
console.log("clicking trigger:", plusId);
if (plusId) {
  await p.click(`[data-cloner-trigger="${plusId}"]`, { timeout: 5000 });
  await p.waitForTimeout(1200);
  const overlay = await p.evaluate(() => {
    const o = document.querySelector("[data-cloner-overlay]");
    if (!o) return null;
    const r = o.getBoundingClientRect();
    return { size: `${Math.round(r.width)}x${Math.round(r.height)}`, text: o.innerText.slice(0, 250).replace(/\n+/g, " | ") };
  });
  console.log("OVERLAY after click:", JSON.stringify(overlay));
  await p.screenshot({ path: "output/tradovate-live/_reference/plus-click.png" });
} else {
  console.log("no matching trigger found");
}
await b.close();
