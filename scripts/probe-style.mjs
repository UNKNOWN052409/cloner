// decisive probe: can the panel width change via inline style at all?
import { launchBrowser } from "../src/browser.js";
import path from "node:path";
const b = await launchBrowser({ headless: true });
const p = await b.newPage({ viewport: { width: 1440, height: 900 } });
p.on("pageerror", (e) => console.log("PAGE EXCEPTION:", String(e).slice(0, 200)));
const url = "file:///" + path.resolve("platform-data/tmvvfttcya7to/out/index.html").replace(/\\/g, "/");
await p.goto(url, { waitUntil: "load", timeout: 30000 }).catch(() => {});
await p.waitForTimeout(1000);
const probe = await p.evaluate(() => {
  const s = document.querySelector(".lm_splitter");
  const prev = s ? s.previousElementSibling : null;
  if (!prev) return { err: "no splitter/prev" };
  const w0 = Math.round(prev.getBoundingClientRect().width);
  prev.style.width = "900px";
  const wManual = Math.round(prev.getBoundingClientRect().width);
  // does a listener exist on document for mousedown? can't introspect — instead:
  // dispatch through the real handler path but with correct clientX on MOUSEDOWN
  const eDown = new MouseEvent("mousedown", { bubbles: true, clientX: 700, clientY: 300 });
  s.dispatchEvent(eDown);
  document.dispatchEvent(new MouseEvent("mousemove", { bubbles: true, clientX: 760, clientY: 300 }));
  document.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, clientX: 760, clientY: 300 }));
  const wHandler = Math.round(prev.getBoundingClientRect().width);
  return { w0, wManual, wHandler, inlineWidth: prev.style.width };
});
console.log("PROBE:", JSON.stringify(probe));
await b.close();
process.exit(0);
