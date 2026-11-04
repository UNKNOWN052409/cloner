// Diagnostic: with exported session, probe what demo.tradovate.com/trading really serves.
// Tries /trading, waits for the SPA, reports status/title/body-hint/screenshot.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cookiesFile = path.join(root, "output", "tradovate-cookies.json");
const storageFile = path.join(root, "output", "tradovate-storage.json");
const outDir = path.join(root, "artifacts", "tradovate-probe");
fs.mkdirSync(outDir, { recursive: true });

const storage = JSON.parse(fs.readFileSync(storageFile, "utf8"));
const cookies = JSON.parse(fs.readFileSync(cookiesFile, "utf8")).map(c => ({
  name: c.name, value: c.value, domain: c.domain ?? ".tradovate.com", path: c.path ?? "/",
  expires: c.expires, httpOnly: c.httpOnly, secure: c.secure, sameSite: c.sameSite === "no_restriction" ? "None" : c.sameSite === "lax" ? "Lax" : c.sameSite === "strict" ? "Strict" : undefined,
}));

const b = await chromium.launch({ headless: true });
const ctx = await b.newContext({ viewport: { width: 1600, height: 900 } });
await ctx.addCookies(cookies);
const p = await ctx.newPage();
const responses = [];
p.on("response", r => { if (r.url().includes("tradovate")) responses.push(`${r.status()} ${r.url().slice(0, 110)}`); });

for (const target of ["https://demo.tradovate.com/trading", "https://demo.tradovate.com/"]) {
  console.log(`\n===== PROBE ${target} =====`);
  try {
    const resp = await p.goto(target, { waitUntil: "domcontentloaded", timeout: 45000 });
    console.log("goto status:", resp && resp.status());
    await p.waitForTimeout(8000);
    // push storage in and reload once (session recovery), then wait for SPA render
    await p.evaluate(st => {
      for (const [k, v] of Object.entries(st.ls || {})) localStorage.setItem(k, v);
      for (const [k, v] of Object.entries(st.ss || {})) sessionStorage.setItem(k, v);
    }, storage);
    await p.reload({ waitUntil: "domcontentloaded", timeout: 45000 });
    await p.waitForTimeout(12000);
    const title = await p.title();
    const bodyText = (await p.evaluate(() => document.body.innerText.slice(0, 400)));
    const bodyLen = await p.evaluate(() => document.body.innerHTML.length);
    console.log("final URL:", p.url());
    console.log("title:", JSON.stringify(title));
    console.log("body innerHTML length:", bodyLen);
    console.log("body text head:", JSON.stringify(bodyText.slice(0, 220)));
    const shot = path.join(outDir, `probe-${target.replace(/[^a-z0-9]+/gi, "_")}.png`);
    await p.screenshot({ path: shot, fullPage: false });
    console.log("screenshot:", shot);
  } catch (e) {
    console.log("PROBE ERROR:", String(e).slice(0, 300));
  }
}
console.log("\n===== tradovate responses (first 25) =====");
console.log(responses.slice(0, 25).join("\n"));
await b.close();
