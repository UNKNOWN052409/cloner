// wf-diag-trace — replicate the v1 capturePage sequence step by step against the
// toolbar fixture and dump everything the picker pass sees:
//   mark triggers → (pristine) serialize → recordInteractions({ preMarked, ...v1 opts })
// Every page.evaluate / page.click / waitForTimeout is wrapped with timing so a
// slow or timed-out evaluate (withDeadline fires but the evaluate still lands
// later) becomes visible. Compares against a fresh page driven the v2-style way
// (recordInteractions WITHOUT preMarked).
// Usage: node scripts/wf-diag-trace.mjs [outDir]   (default output/wf-diag-trace)
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import { fileURLToPath } from "node:url";
import { launchBrowser, newContext } from "../src/browser.js";
import { markTriggers, recordInteractions } from "../src/interactions.js";
import { bus } from "../src/events.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const outDir = path.resolve(process.argv[2] || "output/wf-diag-trace");
fs.mkdirSync(outDir, { recursive: true });
const root = path.resolve(__dirname, "..");

const t0 = Date.now();
const ts = () => `+${((Date.now() - t0) / 1000).toFixed(2)}s`;
const lines = [];
const out = (s) => { lines.push(s); console.log(s); };

// mirror engine logs with timestamps (bus.emit wraps payloads as {type, data})
bus.on("log", (evt) => out(`  [bus ${ts()}] ${evt?.data?.level}: ${evt?.data?.msg}`));

// ---- fixture server (same shape as wf-fixture-run.mjs) ---------------------
const srv = http.createServer((req, res) => {
  try {
    res.writeHead(200, { "content-type": "text/html" });
    res.end(fs.readFileSync(path.join(__dirname, "fixture-toolbar.html")));
  } catch { res.writeHead(404); res.end("nf"); }
});
await new Promise((r) => srv.listen(0, "127.0.0.1", r));
const port = srv.address().port;
const url = `http://127.0.0.1:${port}/fixture-toolbar.html`;
out(`fixture: ${url}`);

// ---- instrumented page wrapper: time every evaluate/click ------------------
function instrument(page, tag) {
  const rawEval = page.evaluate.bind(page);
  let evalN = 0;
  page.evaluate = async (fn, ...args) => {
    const id = `${tag}#e${++evalN}`;
    const src = String(fn).replace(/\s+/g, " ").slice(0, 70);
    const start = Date.now();
    try {
      const res = await rawEval(fn, ...args);
      let shape = typeof res;
      if (res && typeof res === "object") {
        shape = Array.isArray(res) ? `array(${res.length})` : `obj{${Object.keys(res).slice(0, 6).join(",")}}`;
        if (res && typeof res.html === "string") shape += ` html=${res.html.length}B kind=${res.kind ?? "-"}`;
        if (Array.isArray(res)) {
          shape += ` [${res.slice(0, 3).map((x) => JSON.stringify(x).slice(0, 60)).join(" | ")}]`;
        }
      } else if (typeof res === "string") {
        shape = `str(${res.length}B)`;
      } else {
        shape = String(res);
      }
      out(`  [${ts()}] ${id} evaluate OK ${Date.now() - start}ms → ${shape}  ${src}`);
      return res;
    } catch (e) {
      out(`  [${ts()}] ${id} evaluate THREW ${Date.now() - start}ms  ${src} :: ${String(e?.message || e).slice(0, 90)}`);
      throw e;
    }
  };
  const rawClick = page.click.bind(page);
  page.click = async (sel, opts) => {
    const start = Date.now();
    try {
      const res = await rawClick(sel, opts);
      out(`  [${ts()}] ${tag} click OK ${Date.now() - start}ms ${sel}`);
      return res;
    } catch (e) {
      out(`  [${ts()}] ${tag} click FAIL ${Date.now() - start}ms ${sel} :: ${String(e?.message || e).split("\n")[0].slice(0, 90)}`);
      throw e;
    }
  };
  return page;
}

// inline copy of browser.js serializeEnhanced (not exported) — read-only source,
// kept byte-compatible in behavior for the diagnostic
function serializeEnhanced() {
  for (const c of document.querySelectorAll("canvas")) {
    try {
      const r = c.getBoundingClientRect();
      if (r.width < 2 || r.height < 2) { c.remove(); continue; }
      const img = document.createElement("img");
      img.src = c.toDataURL("image/png");
      img.alt = "captured canvas";
      const cs = getComputedStyle(c);
      for (const p of ["display", "position", "inset", "top", "right", "bottom", "left", "width", "height",
        "minWidth", "minHeight", "maxWidth", "maxHeight", "margin", "verticalAlign", "transform",
        "zIndex", "borderRadius", "objectFit", "opacity", "visibility", "pointerEvents"]) {
        img.style[p] = cs[p];
      }
      if (cs.position === "static" && (!img.style.width || img.style.width === "auto")) img.style.width = r.width + "px";
      if (cs.position === "static" && (!img.style.height || img.style.height === "auto")) img.style.height = r.height + "px";
      img.setAttribute("data-cloner-snap", "1");
      c.replaceWith(img);
    } catch (e) {}
  }
  const clone = document.documentElement.cloneNode(true);
  clone.querySelectorAll("script, noscript").forEach((n) => n.remove());
  clone.querySelectorAll("base").forEach((n) => n.remove());
  const cls = (clone.getAttribute("class") || "").replace(/\bno-js\b/g, "").trim();
  if (cls) clone.setAttribute("class", cls); else clone.removeAttribute("class");
  clone.querySelectorAll("img").forEach((img) => {
    if (img.getAttribute("loading") === "lazy") img.removeAttribute("loading");
  });
  return "<!DOCTYPE html>\n" + clone.outerHTML;
}

const liveProbe = () => ({
  live: !!document.querySelector('[data-cloner-live="1"]'),
  triggers: [...document.querySelectorAll("[data-cloner-trigger]")].map((e) => e.getAttribute("data-cloner-trigger")),
  inners: [...document.querySelectorAll("[data-cloner-inner]")].map((e) => e.getAttribute("data-cloner-inner")),
  pickerOpen: !!(document.getElementById("picker") || {}).className?.includes?.("open"),
  panelOpen: !!(document.getElementById("panel") || {}).className?.includes?.("open"),
});

const V1_OPTS = { waitMs: 800, max: 56, triggerMax: 140, budgetMs: 170000 }; // cli.js:136 deep mode

async function v1Flow(tag) {
  const browser = await launchBrowser({ headless: true });
  const ctx = await newContext(browser, { viewport: { width: 1280, height: 800 } });
  const page = instrument(await ctx.newPage(), tag);
  out(`\n===== ${tag}: goto ${url} =====`);
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45000 });
  try { await page.waitForLoadState("networkidle", { timeout: 6000 }); } catch {}
  await page.waitForTimeout(1500);

  // step 1: mark triggers (capturePage browser.js:193-201)
  const preMarked = (await markTriggers(page, { max: 100 })).marked || [];
  out(`[${ts()}] preMarked (${preMarked.length}): ${JSON.stringify(preMarked)}`);
  out(`[${ts()}] live after mark: ${JSON.stringify(await page.evaluate(liveProbe))}`);

  // step 2: serialize pristine (capturePage browser.js:204)
  const html = await page.evaluate(serializeEnhanced);
  const triggerAttrs = (html.match(/data-cloner-trigger="[^"]+"/g) || []).join(" ");
  out(`[${ts()}] pristine serialize: ${html.length}B, trigger attrs: [${triggerAttrs}]`);
  fs.writeFileSync(path.join(outDir, `${tag}-pristine.html`), html);
  out(`[${ts()}] live after serialize: ${JSON.stringify(await page.evaluate(liveProbe))}`);

  // step 3: recordInteractions with preMarked (capturePage browser.js:230-234)
  const records = await recordInteractions(page, { ...V1_OPTS, preMarked, outDir });
  out(`[${ts()}] ${tag}: recordInteractions → ${records.length} record(s)`);
  for (const r of records) {
    out(`   - id=${r.id} kind=${r.kind} text=${JSON.stringify(r.text)} html=${(r.html || "").length}B box=${JSON.stringify(r.box)}`);
    if (r.kind === "module") out(`     module html has MarketAnalyzer=${(r.html || "").includes("Market Analyzer")} snap=${(r.html || "").includes("data-cloner-snap")}`);
    if (r.kind === "overlay") out(`     overlay has innerMarks=${(r.html || "").includes("data-cloner-inner")} liveAttr=${(r.html || "").includes("data-cloner-live")}`);
  }
  out(`[${ts()}] live after record: ${JSON.stringify(await page.evaluate(liveProbe))}`);

  // step 4: replicate the browser.js dead-attr prune on the pristine html
  const wired = new Set(records.map((r) => r.id));
  const pruned = html.replace(/ data-cloner-trigger="(t\d+)"/g, (m, id) => (wired.has(id) ? m : ""));
  const marks = (pruned.match(/data-cloner-trigger=/g) || []).length;
  out(`[${ts()}] ${tag}: pruned index.html would be ${pruned.length}B + runtime tag, trigger marks after prune: ${marks}`);

  await browser.close();
  return { records, pruned };
}

// ---- run: A = v1 (preMarked), B = v2-style (no preMarked) ------------------
const A = await v1Flow("A-v1-premarked");
const B = await v1Flow("B-v2-style");

out("\n===== DELTA SUMMARY =====");
out(`A (v1, preMarked): ${A.records.length} records | ids: ${A.records.map((r) => r.id).join(",")}`);
out(`B (v2, no preMarked): ${B.records.length} records | ids: ${B.records.map((r) => r.id).join(",")}`);
out(`A kinds: ${JSON.stringify(A.records.map((r) => r.kind))} | B kinds: ${JSON.stringify(B.records.map((r) => r.kind))}`);
fs.writeFileSync(path.join(outDir, "trace.log"), lines.join("\n"));
srv.close();
process.exit(0);
