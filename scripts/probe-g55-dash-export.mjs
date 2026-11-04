// G5.5 dashboard-export probe — isolate why #btn-export (location.assign to
// the owner-gated download URL) produces no download event for a signed-in user.
import path from "node:path";
import { chromium } from "playwright";
import { startPlatform } from "../src/platform/server.js";

const PORT = 4192;
const BASE = `http://127.0.0.1:${PORT}`;
process.env.CLONER_ENV_FILE = path.join(process.cwd(), "artifacts", "g55-journey-downloads", "probe2.env");

await startPlatform({ port: PORT });

const email = `probe2.${Date.now()}@journey.dev`;
const login = await (await fetch(`${BASE}/api/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: (await (await fetch(`${BASE}/api/auth/register`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email, password: "Probe!Pass1x" }) })).json()).email, password: "Probe!Pass1x" }) })).json();
const { token } = login;
console.log("[probe] user ready");

const created = (await (await fetch(`${BASE}/api/tasks`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token}` }, body: JSON.stringify({ url: "https://example.com", mode: "url" }) })).json()).id;
console.log(`[probe] task ${created}`);
const t0 = Date.now();
while (Date.now() - t0 < 300000) {
  const t = await (await fetch(`${BASE}/api/tasks/${created}`, { headers: { authorization: `Bearer ${token}` } })).json();
  if (["done", "error", "exported"].includes(t.status)) { console.log("[probe] task status:", t.status); break; }
  await new Promise((r) => setTimeout(r, 2000));
}

const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({ acceptDownloads: true });
const page = await ctx.newPage();
page.on("response", (r) => { if (r.status() >= 400) console.log(`[probe] HTTP ${r.status()} ${r.url().slice(0, 140)}`); });
page.on("download", (d) => console.log("[probe] DOWNLOAD EVENT:", d.suggestedFilename?.()));
await page.goto(BASE + "/", { waitUntil: "domcontentloaded" });
await page.evaluate((t) => { sessionStorage.setItem("cloner_token", t); localStorage.setItem("cloner_token", t); }, token);
await page.reload({ waitUntil: "domcontentloaded" });
await page.waitForSelector("#task-list li[data-id]", { timeout: 20000 });
await page.click("#task-list li[data-id]");
await page.waitForTimeout(1500);
console.log("[probe] selected task, clicking Export");
const t1 = Date.now();
await page.click("#btn-export");
const outcome = await Promise.race([
  page.waitForEvent("download", { timeout: 60000 }).then(() => "download event fired"),
  page.waitForURL(/export/, { timeout: 60000 }).then(() => "navigated to export URL").catch(() => null),
  new Promise((r) => setTimeout(() => r("timeout: no download, url=" + page.url()), 62000)),
]);
console.log(`[probe] outcome after ${((Date.now() - t1) / 1000).toFixed(1)}s:`, outcome);
console.log("[probe] page URL now:", page.url().slice(0, 140));
console.log("[probe] activity log tail:", (await page.textContent("#log").catch(() => "")).trim().split("\n").slice(-3).join(" | ").slice(0, 200));
await browser.close();
process.exit(0);
