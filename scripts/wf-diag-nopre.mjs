// wf-diag-nopre — the COUNTERFACTUAL arm of the 3.3.2 investigation.
// Calls recordInteractions WITHOUT preMarked (the v2-style path used by
// src/pipeline/exploration-pipeline.js:191) on the same fixture, with NO
// serializeEnhanced beforehand — exactly how the v2 flow drives the engine.
// Expected if the root cause is the pristine serialize (serializeEnhanced
// removes the hidden canvas from the live DOM): this arm captures 6 records
// (1 overlay + 5 modules, each module html carrying the canvas data-URL img),
// while the v1 arm (wf-diag-trace.mjs flow A) captures 1.
// Usage: node scripts/wf-diag-nopre.mjs
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import { fileURLToPath } from "node:url";
import { launchBrowser, newContext } from "../src/browser.js";
import { recordInteractions } from "../src/interactions.js";
import { bus } from "../src/events.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const outDir = path.resolve("output/wf-diag-nopre");
fs.mkdirSync(outDir, { recursive: true });

bus.on("log", (evt) => console.log(`  [bus] ${evt?.data?.level}: ${evt?.data?.msg}`));

const srv = http.createServer((req, res) => {
  try {
    res.writeHead(200, { "content-type": "text/html" });
    res.end(fs.readFileSync(path.join(__dirname, "fixture-toolbar.html")));
  } catch { res.writeHead(404); res.end("nf"); }
});
await new Promise((r) => srv.listen(0, "127.0.0.1", r));
const url = `http://127.0.0.1:${srv.address().port}/fixture-toolbar.html`;

const browser = await launchBrowser({ headless: true });
const ctx = await newContext(browser, { viewport: { width: 1280, height: 800 } });
const page = await ctx.newPage();
await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45000 });
try { await page.waitForLoadState("networkidle", { timeout: 6000 }); } catch {}
await page.waitForTimeout(1500);

// v2-style: recordInteractions WITHOUT preMarked, WITHOUT any prior serialize
const records = await recordInteractions(page, { waitMs: 800, max: 56, triggerMax: 140, budgetMs: 170000, outDir });
console.log(`\nv2-style recordInteractions → ${records.length} record(s)`);
for (const r of records) {
  console.log(`  - id=${r.id} kind=${r.kind} text=${JSON.stringify(r.text)} html=${(r.html || "").length}B snap=${(r.html || "").includes("data-cloner-snap")} market=${(r.html || "").includes("Market Analyzer")}`);
}
fs.writeFileSync(path.join(outDir, "records.json"), JSON.stringify(records, null, 2));
await browser.close();
srv.close();
console.log(`\nrecords=${records.length} (v1 preMarked arm yields 1 — see wf-diag-trace.mjs)`);
process.exit(0);
