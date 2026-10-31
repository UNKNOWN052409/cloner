// wf-diag-patchtest — validates the PROPOSED src/browser.js serializeEnhanced
// patch WITHOUT editing the read-only file: reads src/browser.js, applies the
// exact canvas patch to an in-memory copy, rewrites its relative imports to
// absolute file URLs, writes the copy under output/, imports it, and drives the
// FULL v1 capturePage sequence (mark → serialize → recordInteractions w/
// preMarked) against the CURRENT shared fixture-toolbar.html.
//
// Expected result if the patch is correct:
//   records = 6 (1 overlay + 5 modules, each module html > 300B with the
//   canvas data-URL img) · pristine html > 5000B (data URL embedded) ·
//   trigger marks after the honest prune = 1 (t3/t5 controls open nothing on
//   this fixture — documented in wf-diag-FINDINGS.md).
// Usage: node scripts/wf-diag-patchtest.mjs
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import { pathToFileURL, fileURLToPath } from "node:url";
import { launchBrowser, newContext } from "../src/browser.js";
import { bus } from "../src/events.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const outDir = path.resolve("output/wf-diag-patch");
fs.mkdirSync(outDir, { recursive: true });

bus.on("log", (evt) => console.log(`  [bus] ${evt?.data?.level}: ${evt?.data?.msg}`));

// ---- 1. read the real engine and apply the EXACT proposed patch ------------
const src = fs.readFileSync(path.join(root, "src", "browser.js"), "utf8");
const BEFORE = `      const r = c.getBoundingClientRect();
      if (r.width < 2 || r.height < 2) { c.remove(); continue; }`;
const AFTER = `      const r = c.getBoundingClientRect();
      const w = r.width || c.width;
      const h = r.height || c.height;
      if (w < 2 || h < 2) { c.remove(); continue; }`;
if (!src.includes(BEFORE)) { console.error("patch anchor 1 not found in src/browser.js"); process.exit(1); }
let patched = src.replace(BEFORE, AFTER);
patched = patched.replace(
  `if (cs.position === "static" && (!img.style.width || img.style.width === "auto")) img.style.width = r.width + "px";
      if (cs.position === "static" && (!img.style.height || img.style.height === "auto")) img.style.height = r.height + "px";`,
  `if (cs.position === "static" && (!img.style.width || img.style.width === "auto")) img.style.width = w + "px";
      if (cs.position === "static" && (!img.style.height || img.style.height === "auto")) img.style.height = h + "px";`,
);
// rewrite relative imports so the copy loads from scripts/ context
patched = patched
  .replace(`from "./events.js"`, `from ${JSON.stringify(pathToFileURL(path.join(root, "src", "events.js")).href)}`)
  .replaceAll(`import("./interactions.js")`, `import(${JSON.stringify(pathToFileURL(path.join(root, "src", "interactions.js")).href)})`);
const copyPath = path.join(outDir, "browser-patched.mjs");
fs.writeFileSync(copyPath, patched);
console.log(`patched engine copy written: ${copyPath}`);

const { capturePage } = await import(pathToFileURL(copyPath).href);

// ---- 2. serve the CURRENT shared fixture ------------------------------------
const srv = http.createServer((req, res) => {
  try {
    res.writeHead(200, { "content-type": "text/html" });
    res.end(fs.readFileSync(path.join(__dirname, "fixture-toolbar.html")));
  } catch { res.writeHead(404); res.end("nf"); }
});
await new Promise((r) => srv.listen(0, "127.0.0.1", r));
const url = `http://127.0.0.1:${srv.address().port}/fixture-toolbar.html`;

// ---- 3. full v1 capturePage (same opts as cli.js:136 deep mode) -------------
const browser = await launchBrowser({ headless: true });
const ctx = await newContext(browser, { viewport: { width: 1280, height: 800 } });
const page = await ctx.newPage();
const cap = await capturePage(page, url, { interactions: { waitMs: 800, max: 56, triggerMax: 140, budgetMs: 170000 } });
await browser.close();
srv.close();

// ---- 4. report --------------------------------------------------------------
console.log(`\npatched capturePage → ${cap.interactions.length} record(s)`);
for (const r of cap.interactions) {
  console.log(`  - id=${r.id} kind=${r.kind} text=${JSON.stringify(r.text)} html=${(r.html || "").length}B snap=${(r.html || "").includes("data-cloner-snap")} market=${(r.html || "").includes("Market Analyzer")}`);
}
console.log(`pristine html (post-prune): ${cap.html.length}B`);
console.log(`trigger marks after prune: ${(cap.html.match(/data-cloner-trigger=/g) || []).length}`);
fs.writeFileSync(path.join(outDir, "index-patched.html"), cap.html);
process.exit(0);
