// one-off: is the saved Tradovate session still alive? (storage-state probe —
// never logs in, so no concurrent session gets kicked)
import fs from "node:fs";
import path from "node:path";
import { chromium } from "playwright";

const root = path.dirname(path.dirname(decodeURIComponent(new URL(import.meta.url).pathname).replace(/^\/([A-Za-z]:)/, "$1")));
const sessionPath = process.argv[2] || path.join(root, "artifacts", "exp-mw60jhf5pwjh", "auth", "session.json");
const sidecarPath = sessionPath.replace("session.json", "session-storage.json");

const storageState = JSON.parse(fs.readFileSync(sessionPath, "utf8"));
const sidecar = fs.existsSync(sidecarPath) ? JSON.parse(fs.readFileSync(sidecarPath, "utf8")) : null;

const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({ storageState, viewport: { width: 1440, height: 900 } });
if (sidecar?.origin) {
  await ctx.addInitScript(({ origin, items }) => {
    if (location.origin === origin) {
      try { for (const [k, v] of Object.entries(items)) sessionStorage.setItem(k, v); } catch {}
    }
  }, sidecar);
}
const page = await ctx.newPage();
await page.goto("https://trader.tradovate.com/", { waitUntil: "domcontentloaded", timeout: 30000 });
await page.waitForTimeout(6000); // SPA hydration
const state = await page.evaluate(() => ({
  url: location.href,
  hasPassword: !!document.querySelector('input[type="password"]'),
  bodyText: (document.body?.innerText || "").slice(0, 400),
  hasTopbar: !!document.querySelector("[class*='topbar' i], [class*='TopBar' i]"),
  cookiesSent: document.cookie.split(";").length,
}));
console.log(JSON.stringify(state, null, 2));
await page.screenshot({ path: path.join(root, "tmp-qa", "session-probe.png") });
await browser.close();
const alive = !state.hasPassword && (state.hasTopbar || /dashboard|accounts|trading/i.test(state.bodyText));
console.log(alive ? "SESSION-ALIVE" : "SESSION-DEAD");
process.exit(0);
