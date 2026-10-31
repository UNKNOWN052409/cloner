// probe: is the new runtime wiring actually active in the rendered clone?
import { launchBrowser } from "../src/browser.js";
import path from "node:path";
const b = await launchBrowser({ headless: true });
const p = await b.newPage({ viewport: { width: 1440, height: 900 } });
p.on("console", (m) => { if (m.type() === "error") console.log("PAGE ERR:", m.text().slice(0, 140)); });
p.on("pageerror", (e) => console.log("PAGE EXCEPTION:", String(e).slice(0, 180)));
const url = "file:///" + path.resolve("platform-data/tmvvfttcya7to/out/index.html").replace(/\\/g, "/");
await p.goto(url, { waitUntil: "load", timeout: 30000 }).catch((e) => console.log("goto fail:", e.message.slice(0, 60)));
await p.waitForTimeout(1200);
const probe = await p.evaluate(() => {
  const s = document.querySelector(".lm_splitter");
  if (!s) return { splitter: false };
  const prev = s.previousElementSibling;
  const w0 = Math.round(prev.getBoundingClientRect().width);
  s.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
  document.dispatchEvent(new MouseEvent("mousemove", { bubbles: true, clientX: 800, clientY: 300 }));
  document.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, clientX: 800, clientY: 300 }));
  const w1 = Math.round(prev.getBoundingClientRect().width);
  return { splitter: true, w0, w1, moved: w1 !== w0, runtimeLoaded: typeof window.__CLONER_INTERACTIONS !== "undefined" };
});
console.log("PROBE:", JSON.stringify(probe));
await b.close();
process.exit(0);
