import { chromium } from "playwright";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
const PAGE_FILE = resolve("D:/project 2/cloner/artifacts/exp-mw60jhf5pwjh-project/index.html");
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
await page.goto(pathToFileURL(PAGE_FILE).href, { waitUntil: "load" });
await page.waitForTimeout(500);
// Does findRec resolve ANY of the 17 elements to a recorded interaction module?
const probe = await page.evaluate(() => {
  const DATA = window.__CLONER_INTERACTIONS || [];
  const sigs = DATA.map(r => (r.text || "").trim().toLowerCase());
  const els = [...document.querySelectorAll("a, button, [role=button], input, select, textarea, [data-cloner-trigger]")];
  return els.map((el, i) => {
    const t = ((el.innerText || "") + " " + (el.getAttribute("aria-label") || "") + " " + (el.getAttribute("title") || "")).trim().toLowerCase();
    const sigHit = sigs.findIndex(s => s && (s === t || (t.length >= 3 && s.startsWith(t))));
    return { i, tag: el.tagName.toLowerCase(), cls: (el.getAttribute("class") || "").split(" ").slice(0,2).join("."),
      text: t.slice(0, 40) || null, sigHit: sigHit > -1 ? sigs[sigHit] : null };
  });
});
console.log(JSON.stringify(probe, null, 1));
console.log("window.__CLONER_RUNTIME:", JSON.stringify(await page.evaluate(() => window.__CLONER_RUNTIME && { status: window.__CLONER_RUNTIME.status, records: window.__CLONER_RUNTIME.records, errors: window.__CLONER_RUNTIME.errors, moduleCap: window.__CLONER_RUNTIME.moduleCap })));
await browser.close();
