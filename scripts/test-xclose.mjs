// test: module ✕ close (new handler) + escape restore + picker open
import { launchBrowser } from "../src/browser.js";
import path from "node:path";
const b = await launchBrowser({ headless: true });
const p = await b.newPage({ viewport: { width: 1440, height: 900 } });
const url = "file:///" + path.resolve("platform-data/tmvvfttcya7to/out/index.html").replace(/\\/g, "/");
await p.goto(url, { waitUntil: "load", timeout: 30000 }).catch((e) => console.log("goto:", e.message.slice(0, 50)));
await p.waitForTimeout(1500);

// 1) module ✕ close → panel hidden + marker
const xclose = await p.evaluate(() => {
  const btn = document.querySelector(".lm_content .icon-close, [class*='module'] .icon-close");
  if (!btn) return { found: false };
  const pnl = btn.closest(".lm_content") || btn.closest("[class*='module']");
  btn.click();
  return { found: true, hidden: pnl.style.display === "none", marked: pnl.getAttribute("data-cloner-hidden") === "1" };
});
console.log("X-CLOSE:", JSON.stringify(xclose), xclose.found && xclose.hidden && xclose.marked ? "✓" : "✗");

// 2) escape restores it
const restore = await p.evaluate(() => {
  document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
  const panels = [...document.querySelectorAll("[data-cloner-hidden]")];
  return { remaining: panels.length };
});
console.log("ESCAPE-RESTORE:", JSON.stringify(restore), restore.remaining === 0 ? "✓" : "✗");

// 3) picker trigger opens overlay with entries
const picker = await p.evaluate(() => {
  const recs = window.__CLONER_INTERACTIONS || [];
  const rec = recs.find((r) => r.kind === "overlay" && (r.html.match(/data-cloner-inner/g) || []).length >= 3);
  if (!rec) return { found: false, why: "no picker record" };
  const el = document.querySelector(`[data-cloner-trigger="${rec.id}"]`);
  if (!el) return { found: false, why: "trigger attr missing for " + rec.id };
  el.click();
  const ov = document.querySelector("[data-cloner-overlay]");
  return { found: true, opened: !!ov, entries: ov ? (ov.innerHTML.match(/data-cloner-inner/g) || []).length : 0 };
});
console.log("PICKER-OPEN:", JSON.stringify(picker), picker.opened ? "✓" : "✗");

// 4) click an inner entry → module/overlay opens
if (picker.opened) {
  const inner = await p.evaluate(() => {
    const ov = document.querySelector("[data-cloner-overlay]");
    const entry = ov && ov.querySelector("[data-cloner-inner]");
    if (!entry) return { tested: false };
    entry.click();
    return { tested: true, opened: !!document.querySelector("[data-cloner-module], [data-cloner-overlay]") };
  });
  console.log("INNER-CLICK:", JSON.stringify(inner), inner.opened ? "✓" : "✗");
}
await b.close();
process.exit(0);
