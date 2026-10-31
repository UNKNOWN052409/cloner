// one-off wiring debug for the Tradovate clone
import { launchBrowser } from "../src/browser.js";
import path from "node:path";
const b = await launchBrowser({ headless: true });
const p = await b.newPage({ viewport: { width: 1440, height: 900 } });
const url = "file:///" + path.resolve("platform-data/tmvvfttcya7to/out/index.html").replace(/\\/g, "/");
await p.goto(url, { waitUntil: "load", timeout: 30000 }).catch((e) => console.log("goto fail:", e.message.slice(0, 60)));
await p.waitForTimeout(1500);
const closeInfo = await p.evaluate(() => {
  const btn = document.querySelector('.lm_content .icon-close, .lm_content [class*="close-button"], .module .icon-close, [data-testid="sidebar-close-btn"]');
  if (!btn) return { found: false };
  const panel = btn.closest(".lm_content") || btn.closest("[class*=module]");
  const sb = btn.closest("[class*=sidebar]");
  return { found: true, testid: btn.getAttribute("data-testid"), inLmContent: !!btn.closest(".lm_content"), inSidebar: !!sb, panelFound: !!panel, panelCls: panel ? String(panel.className).slice(0, 60) : null };
});
console.log("CLOSE:", JSON.stringify(closeInfo));
const sp = await p.evaluate(() => {
  const s = document.querySelector(".lm_splitter, [class*=splitter]");
  if (!s) return { found: false };
  const prev = s.previousElementSibling, next = s.nextElementSibling;
  return { found: true, cls: s.className, prevCls: prev ? String(prev.className).slice(0, 40) : null, prevW: prev ? Math.round(prev.getBoundingClientRect().width) : null, nextCls: next ? String(next.className).slice(0, 40) : null, size: s.getBoundingClientRect().width + "x" + s.getBoundingClientRect().height };
});
console.log("SPLITTER:", JSON.stringify(sp));
const drag = await p.evaluate(() => {
  const s = document.querySelector(".lm_splitter, [class*=splitter]");
  if (!s) return { ok: false, why: "no splitter" };
  const prev = s.previousElementSibling;
  const w0 = prev.getBoundingClientRect().width;
  s.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, clientX: 700, clientY: 300 }));
  document.dispatchEvent(new MouseEvent("mousemove", { bubbles: true, clientX: 760, clientY: 300 }));
  document.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, clientX: 760, clientY: 300 }));
  const w1 = prev.getBoundingClientRect().width;
  return { ok: Math.abs(w1 - w0) > 5, w0: Math.round(w0), w1: Math.round(w1) };
});
console.log("DRAG:", JSON.stringify(drag));
await b.close();
process.exit(0);
