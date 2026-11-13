// QA-only: verifies the modules integrate inside the real shell at the running
// Vite dev server (http://127.0.0.1:5199) — module frame wrapper + real layout.
import { chromium } from "playwright";
import { fileURLToPath } from "node:url";
import path from "node:path";
import fs from "node:fs";

const here = path.dirname(fileURLToPath(import.meta.url));
const shots = path.join(here, "shots");
fs.mkdirSync(shots, { recursive: true });

const modules = [
  ["marketAnalyzer", "Market Analyzer"],
  ["stocksHotList", "Stocks Hot List"],
  ["orders", "Orders"],
  ["positions", "Positions"],
  ["orderTicket", "Order Ticket"],
  ["timeSales", "T&S"],
  ["tradePerformance", "Trade Performance"],
  ["pulse", "Pulse"],
  ["spreadMatrix", "Spread Matrix"],
  ["optionsChain", "Options Chain"],
];

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const errors = [];
page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
page.on("pageerror", (e) => errors.push("pageerror: " + e.message));

const results = [];
await page.goto("http://127.0.0.1:5199/", { waitUntil: "domcontentloaded" });
await page.waitForSelector(".tv-module", { timeout: 20000 });
await page.waitForTimeout(1200);
await page.screenshot({ path: path.join(shots, "app-default.png") });

for (const [type, name] of modules) {
  await page.goto("http://127.0.0.1:5199/", { waitUntil: "domcontentloaded" });
  await page.waitForSelector(".tv-module", { timeout: 20000 });
  await page.waitForTimeout(700);
  await page.click('[title="Add module"]');
  await page.waitForSelector(".tv-palette", { timeout: 5000 });
  await page.click(`.tv-palette-tile[title="Add ${name} to the dashboard"]`);
  await page.waitForSelector(`.mod.mod-${type}`, { timeout: 8000 });
  await page.waitForTimeout(500);
  const box = await page.locator(`.mod.mod-${type}`).boundingBox();
  const title = await page.locator(`.mod.mod-${type}`).locator("xpath=ancestor::section[contains(@class,'tv-module')]//button[contains(@class,'is-active')]").first().innerText().catch(() => "");
  results.push({
    type,
    mounted: !!box,
    width: Math.round(box?.width || 0),
    height: Math.round(box?.height || 0),
    tab: title.replace(/\s+/g, " ").trim(),
  });
  await page.screenshot({ path: path.join(shots, `app-${type}.png`) });
}

await browser.close();
const payload = { results, errors: errors.filter((e) => !/DevTools|favicon/i.test(e)) };
fs.writeFileSync(path.join(here, "app-check-result.json"), JSON.stringify(payload, null, 2));
console.log(JSON.stringify(payload, null, 2));
if (payload.errors.length || results.some((r) => !r.mounted || r.width < 80 || r.height < 80)) process.exitCode = 1;
