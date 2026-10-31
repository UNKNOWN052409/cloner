// Dev verification: render a clone + screenshot the dashboard.
// usage: node scripts/verify.mjs <cloneDir> <port>
import { chromium } from "playwright";
import { pathToFileURL } from "node:url";
import path from "node:path";

const cloneDir = process.argv[2] || "output/test2";
const port = process.argv[3] || 4199;

const browser = await chromium.launch({ headless: true }).catch(() => chromium.launch({ headless: true, channel: "msedge" }));
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });

// 1) clone render (viewport shot for fair comparison)
const fileUrl = pathToFileURL(path.resolve(cloneDir, "index.html")).href;
await page.goto(fileUrl, { waitUntil: "networkidle", timeout: 20000 }).catch((e) => console.log("goto warn:", e.message.slice(0, 100)));
await page.waitForTimeout(800);
await page.screenshot({ path: cloneDir + "/_reference/clone-verify.png" });
console.log("clone-verify.png saved");

// 2) dashboard
const res = await fetch(`http://localhost:${port}/`).catch(() => null);
if (res?.ok) {
  await page.goto(`http://localhost:${port}`, { waitUntil: "networkidle" });
  await page.waitForTimeout(1500);
  await page.screenshot({ path: "output/dashboard-verify.png" });
  console.log("dashboard-verify.png saved");
} else {
  console.log(`dashboard not running on :${port}`);
}
await browser.close();
