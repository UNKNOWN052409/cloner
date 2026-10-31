// Complete separate render of a clone: full-page screenshot of the whole page.
// Usage: node scripts/render-clone.mjs <cloneDir> [outName]
import fs from "node:fs";
import path from "node:path";
import { launchBrowser } from "../src/browser.js";

const dir = path.resolve(process.argv[2] || "");
const outName = process.argv[3] || "full-render.png";
const b = await launchBrowser({ headless: true });
const p = await b.newPage({ viewport: { width: 1440, height: 900 } });
const fileUrl = "file:///" + path.join(dir, "index.html").replace(/\\/g, "/");
await p.goto(fileUrl, { waitUntil: "load", timeout: 30000 }).catch((e) => console.log("goto:", e.message.slice(0, 60)));
await p.waitForTimeout(2500);
const shot = await p.screenshot({ fullPage: true, timeout: 30000 }).catch(() => null);
if (shot) {
  const out = path.join(dir, "_reference", outName);
  fs.writeFileSync(out, shot);
  console.log("full-page render:", out, "(" + (shot.length / 1024).toFixed(0) + "KB)");
} else {
  console.log("render failed");
  process.exitCode = 1;
}
await b.close();
