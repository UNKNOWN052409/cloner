// Pass 2: for the 25 elements pass 1 could not click, try every scroll a real
// user could perform (window vertical/horizontal + each scrollable ancestor),
// then click; record Playwright's own error verbatim for whatever remains.
import { chromium } from "playwright";
import { pathToFileURL } from "node:url";
import path from "node:path";
import fs from "node:fs";

const ROOT = path.resolve(import.meta.dirname, "..");
const PAGE = path.join(ROOT, "artifacts", "exp-mw60jhf5pwjh-project", "page-001-state-02.html");
const OUT = path.join(ROOT, "artifacts", "qa-clickthrough", "exp-mw60jhf5pwjh", "page-001-state-02");
const DANGEROUS = /(buy|sell|flatten|reverse|order|submit|confirm|logout|log\s?out|sign\s?out|close|remove|delete|cancel|deposit|withdraw|transfer|place|send|exit|cxl\b)/i;

const targets = [
  ["cx-5", "a.cx-5", "nav btn (no text)"], ["cx-8", "a.cx-8", "nav btn (no text)"],
  ["cx-11", "a.cx-11", "nav btn (no text)"], ["cx-23", "button.cx-23", "Switch to new NinjaTrader Web"],
  ["cx-26", "a.cx-26", "Open Account"], ["cx-36", "a.cx-36", "account link"], ["cx-38", "a.cx-38", "account link"],
  ["cx-65", "a.cx-65", "aside btn"], ["cx-69", "a.cx-69", "aside btn badge 22"], ["cx-73", "a.cx-73", "aside btn"],
  ["cx-76", "a.cx-76", "aside btn"], ["cx-79", "a.cx-79", "aside btn (avatar img)"], ["cx-86", "a.cx-86", "aside btn"],
  ["cx-89", "a.cx-89", "aside btn"], ["cx-92", "a.cx-92", "aside btn"],
  ["cx-493", "button.cx-493", "Open risk settings"],
  ["cx-819", "select.cx-819", "select 1"], ["cx-823", "select.cx-823", "select 2"], ["cx-832", "select.cx-832", "Add Filter select"],
  ["cx-836", "button.cx-836", "empty MUI btn"], ["cx-840", "button.cx-840", "empty MUI btn"],
  ["cx-844", ".cx-844.walkme-player", "Tradovate Help player"],
];

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const consoleErrors = [];
page.on("console", (m) => { if (m.type() === "error") consoleErrors.push(m.text().slice(0, 160)); });
page.on("pageerror", (e) => consoleErrors.push("PAGEERROR: " + String(e).slice(0, 160)));
await page.goto(pathToFileURL(PAGE).href, { waitUntil: "load" });
await page.waitForTimeout(500);

const results = [];
for (const [cls, sel, label] of targets) {
  const probe = label + " | " + cls;
  if (DANGEROUS.test(probe)) { results.push({ cls, label, verdict: "SKIPPED-DANGEROUS" }); continue; }
  const loc = page.locator(sel).first();
  const attempts = [];
  // attempt A: plain click after scrollIntoViewIfNeeded
  await loc.scrollIntoViewIfNeeded({ timeout: 1500 }).catch(() => {});
  try { await loc.click({ timeout: 2000 }); attempts.push("A: clicked"); }
  catch (e) { attempts.push("A failed: " + String(e).split("\n").slice(0, 2).join(" ").replace(/\s+/g, " ").slice(0, 160)); }
  // attempt B: scroll window to bring element center into view, click
  try {
    await loc.evaluate((el) => {
      const r = el.getBoundingClientRect();
      window.scrollTo(Math.max(0, window.scrollX + r.left + r.width / 2 - innerWidth / 2), Math.max(0, window.scrollY + r.top + r.height / 2 - innerHeight / 2));
    });
    await loc.click({ timeout: 2000 });
    attempts.push("B: clicked");
  } catch (e) { attempts.push("B failed: " + String(e).split("\n").slice(0, 2).join(" ").replace(/\s+/g, " ").slice(0, 160)); }
  // attempt C: also scroll each scrollable ancestor so element sits below y=95 (clear of toast band) then click
  try {
    await loc.evaluate((el) => {
      let n = el;
      while (n && n !== document.documentElement) {
        const cs = getComputedStyle(n);
        if ((cs.overflowY === "auto" || cs.overflowY === "scroll") && n.scrollHeight > n.clientHeight) {
          const r = el.getBoundingClientRect(), rc = n.getBoundingClientRect();
          const want = r.top - rc.top - 120;
          n.scrollTop = Math.max(0, want + n.scrollTop);
        }
        n = n.parentElement;
      }
      const r2 = el.getBoundingClientRect();
      window.scrollTo(0, Math.max(0, window.scrollY + r2.top - 100));
    });
    await page.waitForTimeout(150);
    await loc.click({ timeout: 2000 });
    attempts.push("C: clicked");
  } catch (e) { attempts.push("C failed: " + String(e).split("\n").slice(0, 2).join(" ").replace(/\s+/g, " ").slice(0, 160)); }
  const clicked = attempts.some((a) => a.endsWith("clicked"));
  // fixed-position check
  const fixed = await loc.evaluate((el) => { let n = el; while (n && n !== document.documentElement) { if (getComputedStyle(n).position === "fixed") return true; n = n.parentElement; } return false; }).catch(() => "?");
  let note = "";
  if (clicked) {
    await page.waitForTimeout(800);
    const st = await page.evaluate(() => ({ html: document.body.innerHTML.length, text: (document.body.innerText || "").length, dlg: [...document.querySelectorAll('[role=dialog]')].filter((d) => getComputedStyle(d).display !== "none").length }));
    note = "clicked; state html=" + st.html + " text=" + st.text + " dlg=" + st.dlg;
    await page.screenshot({ path: path.join(OUT, "p2-" + cls.replace(/[^a-z0-9]/gi, "") + "-after.png") });
  }
  results.push({ cls, sel, label, fixed, clicked, attempts, note });
  // reset scroll state between targets
  await page.reload({ waitUntil: "load" });
  await page.waitForTimeout(300);
}
console.log(JSON.stringify({ results, consoleErrors: consoleErrors.length, first3: consoleErrors.slice(0, 3) }, null, 1));
fs.writeFileSync(path.join(OUT, "pass2-result.json"), JSON.stringify({ results, consoleErrors: { count: consoleErrors.length, first3: consoleErrors.slice(0, 3) } }, null, 2));
await browser.close();
