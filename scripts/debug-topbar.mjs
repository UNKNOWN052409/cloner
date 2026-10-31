// debug: topbar add-module click → does the runtime open the picker overlay?
import { launchBrowser } from "../src/browser.js";
import path from "node:path";
const b = await launchBrowser({ headless: true });
const p = await b.newPage({ viewport: { width: 1440, height: 900 } });
p.on("pageerror", (e) => console.log("PAGE EXCEPTION:", String(e).slice(0, 200)));
const url = "file:///" + path.resolve("platform-data/tmvvhnf0zakkm/out/index.html").replace(/\\/g, "/");
await p.goto(url, { waitUntil: "load", timeout: 30000 }).catch(() => {});
await p.waitForTimeout(1200);
const r = await p.evaluate(() => {
  const link = document.querySelector(".btn-wrap.add-module a, .btn-wrap.add-module");
  if (!link) return { found: false };
  const before = document.querySelectorAll("[data-cloner-overlay]").length;
  link.click();
  const after = document.querySelectorAll("[data-cloner-overlay]").length;
  // also try the recorded picker trigger directly
  const recs = window.__CLONER_INTERACTIONS || [];
  const picker = recs.find((x) => x.kind === "overlay" && /data-cloner-inner/.test(x.html || ""));
  let directOk = null;
  if (picker) {
    const el = document.querySelector(`[data-cloner-trigger="${picker.id}"]`);
    if (el) { el.click(); directOk = document.querySelectorAll("[data-cloner-overlay]").length > after; }
    else directOk = "attr missing for " + picker.id;
  }
  return { found: true, before, after, pickerId: picker ? picker.id : null, directOk, hasTopbarHandler: true };
});
console.log(JSON.stringify(r, null, 1));
await b.close();
process.exit(0);
