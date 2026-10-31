// debug: run the exhaustive enumerate evaluate directly
import { launchBrowser } from "../src/browser.js";
import path from "node:path";
const b = await launchBrowser({ headless: true });
const p = await b.newPage({ viewport: { width: 1440, height: 900 } });
const url = encodeURI("file:///" + path.resolve("platform-data/tmvvfttcya7to/out/index.html").replace(/\\/g, "/"));
await p.goto(url, { waitUntil: "load", timeout: 30000 });
await p.waitForTimeout(1500);
const CLICKABLE = [
  "[data-cloner-trigger]",
  "[data-cloner-inner]",
  "button:not([disabled])",
  "[role='button']",
  ".btn-icon",
  ".icon-close",
  "[data-testid]",
  ".lm_tab",
  ".lm_splitter",
  "a[href='#']",
  "a.btn",
].join(",");
const elems = await p.evaluate((sel) => {
  const seen = new Set();
  const out = [];
  let hidden = 0;
  for (const el of document.querySelectorAll(sel)) {
    const r = el.getBoundingClientRect();
    const vis = r.width > 1 && r.height > 1 && r.x >= 0 && r.y >= 0 && r.x < 2000 && r.y < 3000;
    if (!vis) { hidden++; continue; }
    const key = Math.round(r.x) + ":" + Math.round(r.y) + ":" + el.tagName + ":" + String(el.className || "").slice(0, 30);
    if (seen.has(key)) continue;
    seen.add(key);
    const label =
      el.getAttribute("data-cloner-trigger") || el.getAttribute("data-cloner-inner") || el.getAttribute("data-testid") ||
      el.getAttribute("title") || el.getAttribute("aria-label") || (el.innerText || "").trim().split("\n")[0].slice(0, 24) ||
      String(el.className).split(" ")[0].slice(0, 24) || el.tagName.toLowerCase();
    out.push({ label: String(label).slice(0, 40), x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) });
  }
  return { out, hidden };
}, CLICKABLE);
console.log("visible:", elems.out.length, "| hidden:", elems.hidden);
console.log("first 6:", JSON.stringify(elems.out.slice(0, 6)));
await b.close();
process.exit(0);
