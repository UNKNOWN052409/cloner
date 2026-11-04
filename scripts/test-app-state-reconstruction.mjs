process.env.CLONER_ALLOW_PRIVATE_TARGETS = "1"; // G5.3 SSRF guard: loopback fixture targets — documented opt-in (production default stays strict)
// Phase-3.5 deep application-state reconstruction e2e (task 3.5.3):
// stateful fixture (URL-hash filters + nested state + localStorage) →
// application-state capture → plan → reconstruction → project augmentation →
// Playwright behavior assertions on the CLONE:
//   direct URL loading (deep link), filter combinations, sorting, pagination,
//   nested navigation, refresh persistence and browser back/forward.
//
// Honest evidence notes (mirroring test-responsive-reconstruction.mjs's notes):
//  - The exploration pipeline (src/pipeline/exploration-pipeline.js) visits the
//    seed URL only in this budget (one page, bare "/"), so its captured
//    application-state.json records the bare state; the app's own debug probe
//    (window.__STATEFUL_STATE) is what makes that capture richer than URL-only.
//  - The per-state deep-link captures (filters × sort × page × view × theme)
//    are therefore taken HERE with the same capture contract
//    (attachApplicationStateCapture + exportApplicationState → pages/page-001/
//    application-state.json carries the multi-state fixture), which is exactly
//    the documented Wave-2 pipeline hook — the pipeline will emit one state per
//    visited route/interaction state; this test exercises the multi-state case
//    the builder is built for.
//  - The generated clone strips the original app's inline JS, so the clone's
//    DOM does not carry window.__STATEFUL_STATE and filter clicks cannot
//    re-render there. The clone-level assertions therefore target what the
//    generated runtime actually restores: URL state (deep-link hash/query on
//    bare load), persistence (localStorage entries) and history behavior. The
//    nested-CONTROL restore layer (driving real controls by id/value) is
//    verified against the ORIGINAL fixture page with the generated
//    runtime/app-state.js injected — the runtime is generic
//    (getElementById + change dispatch), the fixture has the real controls.
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import { chromium } from "playwright";
import { runExplorationJob } from "../src/pipeline/exploration-pipeline.js";
import { reconstructFromArtifacts } from "../src/reconstruction/reconstruction-pipeline.js";
import {
  createApplicationStateSink,
  attachApplicationStateCapture,
  exportApplicationState,
} from "../src/exploration/application-state-capture.js";
import {
  buildAppStatePlan,
  buildAppStateRuntime,
  augmentProjectWithAppState,
  summarizeAppStatePlan,
  primaryDeepLink,
} from "../src/reconstruction/application-state-builder.js";
import { statefulAppSite } from "./fixtures/stateful-app.mjs";
import { startFixtureServer } from "./fixtures/server.mjs";

const ROOT = path.resolve(".");
let pass = 0, fail = 0;
const check = (name, ok, detail = "") => { console.log(`  ${ok ? "PASS" : "FAIL"} ${name}${detail ? " — " + detail : ""}`); ok ? pass++ : fail++; };

// ---------- fixture server + pipeline exploration ----------
console.log("\n[1] exploration of the stateful fixture");
const site = await startFixtureServer(statefulAppSite);
const { jobId, artifactsDir, manifest } = await runExplorationJob({
  url: site.base + "/",
  artifactsRoot: path.join(ROOT, "artifacts"),
  config: { policy: { budgets: { maxRoutes: 1, maxStatesPerPage: 4, maxInteractionsPerState: 8, maxTotalTimeMs: 150000 } } },
});
check("exploration completed", manifest.status === "completed", manifest.status);
check("one page explored (maxRoutes=1)", manifest.coverage.routesExplored === 1, String(manifest.coverage.routesExplored));

// ---------- application-state capture on the live original ----------
console.log("\n[2] application-state capture (filters × sort × page × view × theme)");
const browser = await chromium.launch({ headless: true }).catch(() => chromium.launch({ headless: true, channel: "msedge" }));
const probe = await browser.newPage({ viewport: { width: 1440, height: 900 } });
await probe.goto(site.base + "/", { waitUntil: "domcontentloaded" });
await probe.waitForTimeout(250);

const sink = createApplicationStateSink();
const captureState = async (phase, label) => attachApplicationStateCapture(probe, sink, { phase, label });

await captureState("route", "initial");

// nested combination: the fixture's own query-sync pattern (route → query +
// hash) followed by category=books (6 items → 2 pages), sort=price-asc, page 2
await probe.evaluate(() => {
  history.replaceState(null, "", "/?route=active");
  location.hash = "#/items?view=active";
});
await probe.waitForTimeout(200);
await probe.click('.cat-btn[data-cat="books"]');
await probe.selectOption("#sort", "price-asc");
await probe.click("#page-up");
await probe.waitForTimeout(200);
const combo1 = await captureState("interaction", "books/price-asc/page2/active");

// theme + cart: persistence sources
await probe.click("#theme-toggle");
await probe.click("#cart-add");
const combo2 = await captureState("interaction", "dark-theme/cart1");

const fixturePath = path.join(artifactsDir, "pages", "page-001", "application-state.json");
fs.writeFileSync(fixturePath, JSON.stringify(exportApplicationState(sink), null, 2));
const fixture = JSON.parse(fs.readFileSync(fixturePath, "utf8"));
check("application-state.json written", fixture.stateCount === 3, `${fixture.stateCount} state(s)`);
check("probe evidence captured (cat/sort/page/view)", !!combo1?.probe && combo1.probe.cat === "books" && combo1.probe.sort === "price-asc" && combo1.probe.page === 2 && combo1.probe.view === "active", JSON.stringify(combo1?.probe ?? null).slice(0, 140));
check("deep-link URL captured with hash + query sync", combo1?.params?.hashPath === "#/items" && combo1?.params?.hashQuery?.view === "active" && combo1?.params?.query?.route === "active", JSON.stringify(combo1?.params ?? null));
check("storage evidence captured (theme dark, cart 1)", combo2?.storage?.localStorage?.["stateful:theme"]?.v === "dark" && combo2?.storage?.localStorage?.["stateful:cartCount"]?.v === 1, JSON.stringify(combo2?.storage?.localStorage ?? null));
await probe.close();

// ---------- plan (pure analysis) ----------
console.log("\n[3] state plan from captured evidence");
const plan = buildAppStatePlan(artifactsDir, {});
const summary = summarizeAppStatePlan(plan);
check("plan ok with deep-link + storage sources", plan.ok === true && plan.sources.deepLinks >= 1 && plan.sources.storage >= 2, JSON.stringify(plan.sources));
const deep = primaryDeepLink(plan);
check("primary deep link carries hash + query + probe", !!deep && deep.hash === "#/items?view=active" && deep.probe?.cat === "books", deep ? `${deep.hash} probe=${JSON.stringify(deep.probe).slice(0, 80)}` : "none");
check("control evidence captured (marked sort select, last-wins value)", plan.controls.some((c) => c.id === "sort" && c.tag === "select" && c.value === "price-asc"), JSON.stringify(plan.controls));
check("storage map merged (theme + cartCount)", plan.storage.localStorage["stateful:theme"] === "dark" && plan.storage.localStorage["stateful:cartCount"] === "1", JSON.stringify(plan.storage.localStorage));

// runtime emission (pure checks before augmentation)
const runtimeSrc0 = buildAppStateRuntime(plan);
check("runtime embeds the deep-link hash/query", runtimeSrc0.includes('"hash":"#/items?view=active"') && runtimeSrc0.includes('"query":"?route=active"'), "");
check("runtime embeds storage restore entries", runtimeSrc0.includes('"stateful:theme":"dark"') && runtimeSrc0.includes('"stateful:cartCount":"1"'), "");
const emptyPlan = buildAppStatePlan(ROOT, {}); // repo root has no pages/ artifacts
const emptyRuntime = buildAppStateRuntime(emptyPlan);
check("no-evidence plan → documented no-op runtime (inert on load)", emptyPlan.ok === false && emptyRuntime.includes("var D = {\"schema\":\"1.0.0\",\"hash\":\"\",\"query\":\"\",\"controls\":[],"), emptyRuntime.split("\n").find((l) => l.startsWith("  var D"))?.slice(0, 80) || "");

// ---------- reconstruction + augmentation ----------
console.log("\n[4] reconstruct + augment the generated project");
const outDir = path.join(ROOT, "artifacts", jobId + "-project");
const rec = await reconstructFromArtifacts(artifactsDir, { outDir, interactionRecords: [] });
check("reconstruction ok", rec.ok === true, "rounds: " + rec.report.rounds.length);
const genFiles = (rec.report.validation || []).map((v) => v.file).filter(Boolean);
const aug = augmentProjectWithAppState(outDir, plan, { pages: genFiles });
check("app-state runtime written", aug.applied && fs.existsSync(path.join(outDir, "runtime", "app-state.js")), aug.runtimeFile || "missing");
check("app-state runtime linked into generated pages", aug.linked === genFiles.length && genFiles.length >= 1, `${aug.linked}/${genFiles.length} pages`);
const indexHtml = fs.readFileSync(path.join(outDir, "index.html"), "utf8");
const interPos = indexHtml.indexOf('<script src="runtime/interactions.js"></script>');
const appPos = indexHtml.indexOf('<script src="runtime/app-state.js"></script>');
check("app-state script ordered after interactions runtime", appPos > interPos && interPos > 0, `interactions@${interPos} app-state@${appPos}`);

// ---------- clone behavior assertions (Playwright) ----------
console.log("\n[5] clone behavior — deep link, refresh, history, persistence, invalid params");
const cloneSrv = http.createServer((req, res) => {
  const rel = decodeURIComponent((req.url || "/").split("?")[0]).replace(/^\/+/, "") || "index.html";
  const fp = path.join(outDir, rel);
  if (!fp.startsWith(outDir) || !fs.existsSync(fp) || !fs.statSync(fp).isFile()) { res.writeHead(404); res.end("nf"); return; }
  const types = { ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8" };
  res.writeHead(200, { "content-type": types[path.extname(fp)] || "application/octet-stream" });
  res.end(fs.readFileSync(fp));
});
await new Promise((r) => cloneSrv.listen(0, "127.0.0.1", r));
const cloneBase = "http://127.0.0.1:" + cloneSrv.address().port;

const pageErrors = [];
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await ctx.newPage();
page.on("pageerror", (e) => pageErrors.push(String(e).slice(0, 120)));

// 5a. direct URL loading of the deep link (full URL with query + hash)
await page.goto(cloneBase + "/?route=active#/items?view=active", { waitUntil: "load" });
await page.waitForTimeout(300);
let urlNow = await page.evaluate(() => ({ search: location.search, hash: location.hash }));
check("deep link: direct load preserves query + hash state", urlNow.search === "?route=active" && urlNow.hash === "#/items?view=active", JSON.stringify(urlNow));

// 5b. bare load: the generated runtime restores the captured URL state
await page.goto(cloneBase + "/", { waitUntil: "load" });
await page.waitForTimeout(300);
urlNow = await page.evaluate(() => ({ search: location.search, hash: location.hash, applied: window.__APP_STATE_APPLIED || null }));
check("bare load: captured deep link restored by runtime", urlNow.hash === "#/items?view=active" && urlNow.search === "?route=active", JSON.stringify(urlNow));
check("bare load: runtime reports the URL restore engaged", !!urlNow.applied && urlNow.applied.url === true, JSON.stringify(urlNow.applied));

// 5c. refresh persistence (the restored URL must survive a reload intact)
await page.reload({ waitUntil: "load" });
await page.waitForTimeout(300);
urlNow = await page.evaluate(() => ({ search: location.search, hash: location.hash }));
check("refresh: restored URL state survives reload", urlNow.hash === "#/items?view=active" && urlNow.search === "?route=active", JSON.stringify(urlNow));

// 5d. browser back/forward over same-document hash history
await page.evaluate(() => { location.hash = "#/items?view=all"; });
await page.waitForTimeout(200);
await page.goBack();
await page.waitForTimeout(250);
const backHash = await page.evaluate(() => location.hash);
check("back: returns to the captured hash state", backHash === "#/items?view=active", backHash);
await page.goForward();
await page.waitForTimeout(250);
const fwdHash = await page.evaluate(() => location.hash);
check("forward: returns to the navigated hash state", fwdHash === "#/items?view=all", fwdHash);

// 5e. persistence: fresh context, empty storage → runtime writes captured entries
const ctx2 = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page2 = await ctx2.newPage();
await page2.goto(cloneBase + "/", { waitUntil: "load" });
await page2.waitForTimeout(300);
check("persistence: theme restored into localStorage", await page2.evaluate(() => localStorage.getItem("stateful:theme")) === "dark", await page2.evaluate(() => localStorage.getItem("stateful:theme") || "null"));
check("persistence: cart count restored into localStorage", await page2.evaluate(() => localStorage.getItem("stateful:cartCount")) === "1", await page2.evaluate(() => localStorage.getItem("stateful:cartCount") || "null"));
await ctx2.close();

// 5f. invalid/missing parameters degrade gracefully (risk note)
await page.goto(cloneBase + "/#/items?view=bogus", { waitUntil: "load" });
await page.waitForTimeout(300);
urlNow = await page.evaluate(() => ({ hash: location.hash, applied: window.__APP_STATE_APPLIED || null }));
check("invalid param: clone loads without crash, runtime leaves URL alone", urlNow.hash === "#/items?view=bogus" && urlNow.applied?.url === false, JSON.stringify(urlNow));

// 5g. nested-CONTROL restore layer: generated runtime injected into the
// ORIGINAL fixture (real controls exist there — the clone strips app JS)
const origPage = await ctx.newPage();
await origPage.goto(site.base + "/", { waitUntil: "load" });
await origPage.waitForTimeout(250);
const runtimeFile = fs.readFileSync(path.join(outDir, "runtime", "app-state.js"), "utf8");
await origPage.evaluate(runtimeFile);
await origPage.waitForTimeout(300);
const restored = await origPage.evaluate(() => (window.__STATEFUL_STATE ? window.__STATEFUL_STATE() : null));
check("controls: runtime re-drives the captured sort select", restored && restored.sort === "price-asc", restored ? `sort=${restored.sort} status=${restored.rendered?.join("|")?.slice(0, 60)}` : "no probe");
const titles = (restored?.rendered || []).map((t) => String(t).replace(/ •$/, ""));
check("controls: restore visible in the app's own rendering (price-asc order)", titles.length === 4 && titles[0] === "Halo Pen" && titles[1] === "Ember Mug" && titles[2] === "Juniper Tin" && titles[3] === "Aurora Lamp", JSON.stringify(restored?.rendered ?? null));

check("no page errors across all clone loads", pageErrors.length === 0, pageErrors.join(" | ").slice(0, 120) || "clean");

await ctx.close();
await browser.close();
await new Promise((r) => cloneSrv.close(r));
await site.close();

console.log(`\n${pass} passed, ${fail} failed`);
fs.writeFileSync(path.join(ROOT, "artifacts", "test-app-state-reconstruction-result.json"), JSON.stringify({
  pass, fail, jobId,
  plan: summary,
  augmentation: { applied: aug.applied, linked: aug.linked, files: aug.files, notes: aug.notes },
  pageErrors,
}, null, 2));
process.exit(fail ? 1 : 0);
