// Pull the full tradable contract/instrument catalog using the saved live session.
import { chromium } from "playwright";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
process.chdir(ROOT);
const EVID = path.join(ROOT, "artifacts", "tradovate-live-capture", "evidence");
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

const browser = await chromium.launch({ headless: true, channel: "chrome" });
const ctxOpts = { viewport: { width: 1440, height: 900 }, locale: "en-US" };
if (fs.existsSync(path.join(EVID, "live-session.json"))) ctxOpts.storageState = path.join(EVID, "live-session.json");
const ctx = await browser.newContext(ctxOpts);
const ss = JSON.parse(fs.readFileSync(path.join(EVID, "live-session-storage.json"), "utf8"));
await ctx.addInitScript((e) => { try { if (/tradovate\.com$/.test(location.hostname)) for (const [k, v] of Object.entries(e.ss || {})) sessionStorage.setItem(k, String(v)); } catch {} }, ss);
const page = await ctx.newPage();
const urls = [
  "https://config.tradovateapi.com/share/8777118/search?obfuscated=ok",
  "https://live.tradovateapi.com/v1/contract/list",
];
for (const url of urls) {
  try {
    const res = await page.goto(url, { waitUntil: "domcontentloaded", timeout: 120000 });
    const status = res?.status();
    const body = await page.evaluate(() => document.body.innerText);
    const name = url.includes("contract/list") ? "catalog-contract-list.json" : "catalog-search.json";
    fs.writeFileSync(path.join(EVID, name), body);
    log(url.slice(0, 80), "HTTP", status, "bytes", body.length, "| head:", body.slice(0, 200).replace(/\s+/g, " "));
  } catch (e) {
    log("FAILED", url.slice(0, 80), e.message.slice(0, 160));
  }
}
await browser.close();
