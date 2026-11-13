// Tradovate computed-style extraction — exact colors/fonts/sizes for the clone.
import { chromium } from "playwright";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
process.chdir(ROOT);
const OUT = path.join(ROOT, "artifacts", "tradovate-live-capture");
const DATA = path.join(OUT, "evidence");

const env = {};
for (const line of fs.readFileSync(".env", "utf8").split(/\r?\n/)) { const m = line.match(/^(TV_USER|TV_PASS)=(.*)$/); if (m) env[m[1]] = m[2].trim(); }

const browser = await chromium.launch({ headless: true, channel: "chrome" });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: "en-US", storageState: path.join(DATA, "live-session.json") });
const ss = JSON.parse(fs.readFileSync(path.join(DATA, "live-session-storage.json"), "utf8"));
await ctx.addInitScript((entries) => { try { if (/tradovate\.com$/.test(location.hostname)) for (const [k, v] of Object.entries(entries.ss || {})) sessionStorage.setItem(k, String(v)); } catch {} }, ss);
const page = await ctx.newPage();
await page.goto("https://trader.tradovate.com/", { waitUntil: "domcontentloaded", timeout: 90000 });
for (let i = 0; i < 30; i++) { if (await page.evaluate(() => !!document.querySelector("canvas")).catch(() => false)) break; await page.waitForTimeout(2000); }
await page.waitForTimeout(4000);

const out = await page.evaluate(() => {
  const pick = (el, props) => { if (!el) return null; const cs = getComputedStyle(el); const o = {}; for (const p of props) o[p] = cs.getPropertyValue(p); return o; };
  const common = ["backgroundColor", "color", "fontFamily", "fontSize", "fontWeight", "borderColor", "borderRadius", "height", "padding"];
  const byText = (t) => [...document.querySelectorAll("*")].filter((e) => e.children.length === 0 && (e.textContent || "").trim() === t).map((e) => e.parentElement).slice(0, 3);
  const res = {};
  res.html = pick(document.documentElement, ["backgroundColor", "color", "fontFamily", "fontSize"]);
  res.body = pick(document.body, ["backgroundColor", "color", "fontFamily", "fontSize"]);
  res.topbar = pick(document.querySelector("header, .top-bar, [class*=topbar], [class*=header]"), common);
  res.tabs = [...document.querySelectorAll('[class*="tab"]')].slice(0, 12).map((e) => ({ cls: (e.className || "").toString().slice(0, 80), txt: (e.innerText || "").trim().slice(0, 20), ...pick(e, common) }));
  res.buttons = byText("Buy Mkt").concat(byText("Sell Mkt")).map((e) => ({ cls: (e.className || "").toString().slice(0, 60), txt: (e.innerText || "").trim().slice(0, 20), ...pick(e, common) }));
  res.tableHeaders = [...document.querySelectorAll("th, [class*=column-header], [class*=header-cell]")].slice(0, 8).map((e) => ({ txt: (e.innerText || "").trim().slice(0, 20), ...pick(e, common) }));
  res.rail = [...document.querySelectorAll("i[class*=icon], [class*=rail] i")].slice(0, 12).map((e) => ({ cls: (e.className || "").toString().slice(0, 80), color: getComputedStyle(e).color }));
  // sample animated/dark surfaces
  const surface = document.elementFromPoint(360, 450); // chart area
  res.chartArea = pick(surface, ["backgroundColor"]);
  return res;
});
fs.writeFileSync(path.join(DATA, "computed-styles.json"), JSON.stringify(out, null, 2));
console.log(JSON.stringify(out, null, 1).slice(0, 3000));
await browser.close();
