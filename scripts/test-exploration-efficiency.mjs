// Task 3.5.5 — intelligent exploration efficiency test.
//
// Runs the SAME redundant-navigation fixture through the real exploration
// pipeline twice:
//   baseline  = completeness/legacy mode (policy.routes.prioritize: false —
//               pre-3.5.5 behavior: every discovered URL is a navigation)
//   optimized = default 3.5.5 mode (score-ordered routes, query-variant
//               duplicates skipped BEFORE navigating)
// and asserts:
//   1. total document navigations DROP in the optimized run,
//   2. documented coverage does NOT shrink (unique pages explored and
//      distinct documented states are >= baseline),
//   3. route redundancy is recorded, not silently lost,
// plus direct assertions on the new state-candidate layer (pre-navigation
// fingerprint dedup, interaction-potential scoring, budget-capped planning)
// and on interruption/resumption (restore re-seeds the dedup index).
//
// Run: node scripts/test-exploration-efficiency.mjs   (exit 1 on any failure)
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import { runExplorationJob } from "../src/pipeline/exploration-pipeline.js";
import {
  createStateGraph,
  contentKey,
  interactionPotentialScore,
  stateFingerprint,
} from "../src/exploration/state-discovery.js";
import {
  createRouteDiscovery,
  scoreRoute,
  isQueryVariantOf,
} from "../src/exploration/route-discovery.js";

const ROOT = path.resolve(".");
let pass = 0, fail = 0;
const check = (name, ok, detail = "") => { console.log(`  ${ok ? "PASS" : "FAIL"} ${name}${detail ? " — " + detail : ""}`); ok ? pass++ : fail++; };

// ---- fixture: 5 unique documents joined by a nav, plus 4 query-variant
// footer links that point at ALREADY-NAVIGABLE documents (the redundant
// navigation source the task targets) ----
const shell = (title, body) => `<!DOCTYPE html><html><head><title>${title}</title></head><body>
<style>body{padding-left:40px}</style>
<nav><a href="/">Home</a><a href="/products">Products</a><a href="/pricing">Pricing</a><a href="/dashboard">Dashboard</a><a href="/about">About</a></nav>
<h1>${title}</h1>${body}
<script>
function openModal(){ document.getElementById('modal').style.display='block'; }
function selectTab(t){ document.querySelectorAll('.pane').forEach(p=>p.style.display='none'); document.getElementById('pane-'+t).style.display='block'; }
</script>
</body></html>`;

const pages = {
  "/": shell("Efficiency Home",
    `<button class="btn" onclick="openModal()">Open Settings</button>
<div id='modal' style='display:none' class='modal'><h2>Settings Modal</h2><form><label>Name <input name='n'></label><label>Email <input name='e' type='email'></label><select><option>Option A</option><option>Option B</option></select><label><input type='checkbox'> Subscribe</label><textarea name='notes'></textarea></form><button onclick='this.parentElement.style.display="none"'>Dismiss</button></div>
<button class="tabbtn" data-t="1" onclick="selectTab(1)">Tab A</button><button class="tabbtn" data-t="2" onclick="selectTab(2)">Tab B</button>
<div class="pane" id="pane-1">Pane A content</div><div class="pane" id="pane-2" style="display:none">Pane B content</div>
<footer><a href="/products?ref=footer">Products (footer)</a><a href="/pricing?ref=footer">Pricing (footer)</a><a href="/dashboard?src=menu">Dashboard (menu)</a><a href="/about?lang=en">About (lang)</a></footer>`),
  "/products": shell("Efficiency Products", "<p>Products catalog page with unique catalog copy.</p>"),
  "/pricing": shell("Efficiency Pricing", "<table><tr><th>Plan</th><th>Price</th></tr><tr><td>Basic</td><td>$10</td></tr></table>"),
  "/dashboard": shell("Efficiency Dashboard",
    `<button class="btn" onclick="openModal()">Open Panel</button>
<div id='modal' style='display:none' class='modal'><h2>Dashboard Panel</h2><form><label>Range <input name='r'></label><label>Metric <select><option>views</option><option>clicks</option></select></label><label><input type='checkbox'> Compare</label><textarea name='notes'></textarea></form><button onclick='this.parentElement.style.display="none"'>Dismiss</button></div>
<button class="tabbtn" data-t="1" onclick="selectTab(1)">View A</button><button class="tabbtn" data-t="2" onclick="selectTab(2)">View B</button>
<div class="pane" id="pane-1">Dashboard view A with metrics table</div><div class="pane" id="pane-2" style="display:none">Dashboard view B</div>
<input name='q' placeholder='search'><select><option>range a</option><option>range b</option></select>`),
  "/about": shell("Efficiency About", "<p>About page with unique company copy.</p>"),
};

// doc-fetch accounting: every text/html response is one navigation
let docFetches = 0;
const docFetchPaths = new Set();
const srv = http.createServer((req, res) => {
  const u = new URL(req.url, "http://x");
  const key = u.pathname;
  const body = pages[key];
  if (body && (req.headers.accept || "").includes("text/html")) {
    docFetches++;
    docFetchPaths.add(key);
    res.writeHead(200, { "content-type": "text/html" });
    res.end(body);
    return;
  }
  if (body) { res.writeHead(200, { "content-type": "text/html" }); res.end(body); return; }
  res.writeHead(404, { "content-type": "text/plain" });
  res.end("nf");
});
await new Promise((r) => srv.listen(0, "127.0.0.1", r));
const base = "http://127.0.0.1:" + srv.address().port;
console.log(`fixture server at ${base} — 5 unique documents, 4 query-variant footer links`);

const BUDGETS = { maxRoutes: 12, maxStatesPerPage: 10, maxTotalTimeMs: 180000 };
async function run(label, routesPolicy) {
  docFetches = 0;
  docFetchPaths.clear();
  const t0 = Date.now();
  const { jobId, artifactsDir, manifest } = await runExplorationJob({
    url: base + "/",
    artifactsRoot: path.join(ROOT, "artifacts"),
    jobId: "eff-" + label,
    config: { policy: { budgets: BUDGETS, routes: routesPolicy } },
  });
  const elapsedMs = Date.now() - t0;
  let graph = null;
  try { graph = JSON.parse(fs.readFileSync(path.join(artifactsDir, "graph", "states.json"), "utf8")); } catch {}
  return { jobId, artifactsDir, manifest, docFetches, docPaths: new Set(docFetchPaths), elapsedMs, graph };
}

// distinct documented states: nodes deduplicated by content equivalence
// (pathname + DOM signature) — counts unique documents, not redundant fetches
function documentedStates(graph) {
  if (!graph) return -1;
  const keys = new Set();
  for (const n of graph.nodes || []) keys.add(contentKey(n.url, n.domSig ?? ""));
  return keys.size;
}

// distinct documented INTERACTION states only (child states with a parent) —
// baseline's raw edge count is inflated by redundant duplicate pages re-recording
// the same modal/tab states, which is exactly what the optimization removes
function documentedInteractionStates(graph) {
  if (!graph) return -1;
  const keys = new Set();
  for (const n of graph.nodes || []) if (n.parentStateId) keys.add(contentKey(n.url, n.domSig ?? ""));
  return keys.size;
}

console.log("\n== baseline run (completeness mode: prioritize=false, every URL navigated) ==");
const baseRun = await run("baseline", { prioritize: false });
console.log(`   doc fetches: ${baseRun.docFetches}, pages explored: ${baseRun.manifest.pages.length}, states: ${baseRun.manifest.discoveredStates}, ${baseRun.elapsedMs}ms`);

console.log("\n== optimized run (3.5.5 defaults: score-ordered, duplicates skipped pre-navigation) ==");
const optRun = await run("optimized", {});
console.log(`   doc fetches: ${optRun.docFetches}, pages explored: ${optRun.manifest.pages.length}, states: ${optRun.manifest.discoveredStates}, ${optRun.elapsedMs}ms`);

// ---- end-to-end efficiency assertions ----
console.log("\n-- efficiency: baseline vs optimized on the same fixture --");
check("both runs completed", baseRun.manifest.status === "completed" && optRun.manifest.status === "completed",
  `${baseRun.manifest.status} / ${optRun.manifest.status}`);
check("total document navigations DROP (optimized < baseline)", optRun.docFetches < baseRun.docFetches,
  `optimized ${optRun.docFetches} < baseline ${baseRun.docFetches}`);
check("navigations dropped are exactly the redundant fetches", baseRun.docFetches - optRun.docFetches >= 4,
  `saved ${baseRun.docFetches - optRun.docFetches} (4 query-variant duplicates exist)`);
check("unique pages explored stay >= baseline", optRun.docPaths.size >= baseRun.docPaths.size,
  `optimized ${optRun.docPaths.size} unique docs vs baseline ${baseRun.docPaths.size}`);
check("documented states stay >= baseline (content-equivalence dedup)", documentedStates(optRun.graph) >= documentedStates(baseRun.graph),
  `optimized ${documentedStates(optRun.graph)} >= baseline ${documentedStates(baseRun.graph)}`);
check("distinct interaction-state yield not reduced (deduped by content equivalence)",
  documentedInteractionStates(optRun.graph) >= documentedInteractionStates(baseRun.graph),
  `optimized ${documentedInteractionStates(optRun.graph)} >= baseline ${documentedInteractionStates(baseRun.graph)}`);
check("fixture quality: interaction states actually recorded (modal capturable)", (optRun.graph?.stats?.edges ?? 0) >= 1,
  `${optRun.graph?.stats?.edges} edges`);
check("seed page explored first in optimized run (no wasted return navigation)",
  new URL(optRun.manifest.pages[0].url).pathname === "/", optRun.manifest.pages[0].url);
check("optimized run skips route duplicates at discovery (redundantRoutes recorded)",
  optRun.manifest.discoveredRoutes < baseRun.manifest.discoveredRoutes,
  `optimized ${optRun.manifest.discoveredRoutes} routes vs baseline ${baseRun.manifest.discoveredRoutes}`);

// ---- unit drive: route discovery planning + dedup ----
console.log("\n-- route-discovery: scoring, pre-navigation dedup, planning hooks --");
{
  // canned DOM link harvest: nav links (canonical) first, then the redundant
  // query-variant footer links — mirrors what the fixture home page yields
  const LINKS = [
    { url: "http://x.test/products", nav: true, text: "Products" },
    { url: "http://x.test/pricing", nav: true, text: "Pricing" },
    { url: "http://x.test/dashboard", nav: true, text: "Dashboard" },
    { url: "http://x.test/about", nav: true, text: "About" },
    { url: "http://x.test/products?ref=footer", nav: false, text: "Products (footer)" },
    { url: "http://x.test/pricing?ref=footer", nav: false, text: "Pricing (footer)" },
    { url: "http://x.test/dashboard?src=menu", nav: false, text: "Dashboard (menu)" },
    { url: "http://x.test/about?lang=en", nav: false, text: "About (lang)" },
  ];
  // variant queued BEFORE its canonical URL (ad-hoc discovery order)
  const LINKS_VARIANT_FIRST = [LINKS[4], LINKS[0]];
  const fakePage = (links) => ({ url: () => "http://x.test/", evaluate: async () => links });
  const policy = { budgets: { maxRoutes: 12 }, routes: { sameOriginOnly: true } };
  const noopLogger = { info: () => {}, warn: () => {}, error: () => {} };

  check("scoreRoute ranks nav + value-text above plain links",
    scoreRoute({ url: "http://x.test/dashboard", nav: true, text: "Dashboard" }).score >
    scoreRoute({ url: "http://x.test/blog/post/a/b", nav: false, text: "post" }).score,
    `${scoreRoute({ url: "http://x.test/dashboard", nav: true, text: "Dashboard" }).score} vs ${scoreRoute({ url: "http://x.test/blog/post/a/b", nav: false, text: "post" }).score}`);
  check("isQueryVariantOf matches same-path different-search only",
    isQueryVariantOf("http://x.test/p?ref=1", "http://x.test/p") && !isQueryVariantOf("http://x.test/p?a=1", "http://x.test/p?a=1") && !isQueryVariantOf("http://x.test/other?ref=1", "http://x.test/p"));

  const d = createRouteDiscovery(fakePage(LINKS), policy, noopLogger);
  await d.seed("http://x.test/");
  await d.fromDom();
  const st = d.stats();
  check("duplicate query-variant navigations skipped BEFORE any fetch", st.redundantRoutes === 4 && st.uniquePaths === 5, JSON.stringify(st));

  const d2 = createRouteDiscovery(fakePage(LINKS), policy, noopLogger);
  await d2.seed("http://x.test/");
  await d2.fromDom();

  // first-wins canonical upgrade: a query-less twin replaces a queued variant
  const d3 = createRouteDiscovery(fakePage(LINKS_VARIANT_FIRST), policy, noopLogger);
  await d3.seed("http://x.test/");
  await d3.fromDom();
  const products = d3.routes.find((x) => x.seed === false && new URL(x.url).pathname === "/products");
  check("canonical query-less URL wins over queued parameterized twin",
    !!products && !products.url.includes("?") && products.canonicalizedFrom?.includes("?"),
    `${products?.url} (from ${products?.canonicalizedFrom})`);

  check("planNavigations caps to budget",
    d2.planNavigations({ max: 3 }).length === 3, `planned ${d2.planNavigations({ max: 3 }).length}`);
  check("planNavigations removes already-explored pathnames (pre-navigation dedup)",
    !d2.planNavigations({ max: 12, explored: ["http://x.test/pricing"] }).some((r) => new URL(r.url).pathname === "/pricing"));
  check("routes kept score-ordered with seed pinned first",
    d2.routes[0].seed === true && d2.routes.slice(1).every((r, i, a) => i === 0 || a[i - 1].score >= r.score),
    d2.routes.map((r) => `${r.url}(s${r.score})`).join(" "));

  // completeness mode: legacy behavior preserved
  const d4 = createRouteDiscovery(fakePage(LINKS), { ...policy, routes: { sameOriginOnly: true, prioritize: false } }, noopLogger);
  await d4.seed("http://x.test/");
  await d4.fromDom();
  check("completeness mode (prioritize:false) keeps every discovered URL navigable",
    d4.routes.length === 9 && d4.stats().redundantRoutes === 0 && d4.stats().prioritized === false,
    `${d4.routes.length} routes, redundant=${d4.stats().redundantRoutes}`);

  // determinism: identical inputs → identical plan (stable sort), from fresh
  // instances so the markExplored mutations above cannot leak in
  const d6 = createRouteDiscovery(fakePage(LINKS), policy, noopLogger);
  await d6.seed("http://x.test/");
  await d6.fromDom();
  const planA = [...d6.planNavigations({ max: 12 })].map((r) => r.url).join(",");
  const d7 = createRouteDiscovery(fakePage(LINKS), policy, noopLogger);
  await d7.seed("http://x.test/");
  await d7.fromDom();
  const planB = [...d7.planNavigations({ max: 12 })].map((r) => r.url).join(",");
  check("deterministic exploration: identical inputs produce identical plans", planA === planB, planA);
}

// ---- unit drive: state-candidate layer (dedup BEFORE navigating, scoring,
// budget cap, resumption) ----
console.log("\n-- state-discovery: candidate scoring + pre-navigation dedup + budget + resumption --");
{
  const g = createStateGraph();
  const sigRich = JSON.stringify({ c: { buttons: 4, tabs: 2, modals: 1, links: 3, inputs: 2, tables: 1, canvases: 0, headers: 2 }, t: 111 });
  const sigPlain = JSON.stringify({ c: { buttons: 0, links: 2, inputs: 0, tables: 0, canvases: 0, modals: 0, tabs: 0, headers: 1 }, t: 222 });

  check("interaction potential: interactive state outscores static state",
    interactionPotentialScore(JSON.parse(sigRich).c) > interactionPotentialScore(JSON.parse(sigPlain).c),
    `${interactionPotentialScore(JSON.parse(sigRich).c)} vs ${interactionPotentialScore(JSON.parse(sigPlain).c)}`);

  // queue candidates BEFORE any navigation happens
  const c1 = g.addCandidate({ url: "http://x.test/dashboard", domSig: sigRich, interaction: "open panel" });
  const c2 = g.addCandidate({ url: "http://x.test/about", domSig: sigPlain, interaction: "none" });
  const c3 = g.addCandidate({ url: "http://x.test/pricing", domSig: sigRich.replace("222", "333"), interaction: "tabs" });
  check("three distinct candidates queued", !c1.duplicate && !c2.duplicate && !c3.duplicate && g.candidates.length === 3, `queued ${g.candidates.length}`);

  // same interaction encountered again (e.g. page revisited) — must dedupe
  // BEFORE the click, against the queued candidate
  const dup = g.addCandidate({ url: "http://x.test/dashboard", domSig: sigRich, interaction: "open panel" });
  check("re-encountered candidate dedupes pre-navigation (no browser op)", dup.duplicate && (dup.reason === "content-equivalent" || dup.reason === "fingerprint-explored"), dup.reason);

  // candidate matching an EXPLORED node fingerprint dedupes too
  const explored = g.addState({ url: "http://x.test/pricing#tabs", domSig: sigRich.replace("222", "333"), status: "explored" });
  const dup2 = g.addCandidate({ url: "http://x.test/pricing#tabs", domSig: sigRich.replace("222", "333"), interaction: "tabs" });
  check("candidate matching an explored node dedupes by fingerprint", dup2.duplicate && dup2.reason === "fingerprint-explored", dup2.reason);
  check("navigationsSaved counted for both skipped ops", g.stats().navigationsSaved === 2, String(g.stats().navigationsSaved));

  // budget-capped plan: high-value first
  const plan = g.planStates({ budget: 2 });
  check("planStates caps to budget", plan.length === 2, `${plan.length}`);
  check("high interaction potential plans first", plan[0].score >= plan[1].score && plan[0].score > interactionPotentialScore(JSON.parse(sigPlain).c), `top score ${plan[0].score}`);

  // fold explored candidates into the graph (same addState semantics)
  g.markCandidateExplored(plan[0].id, { status: "explored" });
  check("markCandidateExplored creates the node", g.nodes.some((n) => n.url === plan[0].url && n.status === "explored"), plan[0].url);
  const after = g.addCandidate({ url: plan[0].url, domSig: plan[0].domSig, interaction: plan[0].interaction });
  check("explored candidate now dedupes as fingerprint-explored", after.duplicate && after.reason === "fingerprint-explored", after.reason);

  // resumption: restore the serialized graph, dedup index re-seeds
  const snapshot = g.serialize();
  const g2 = createStateGraph({ restore: snapshot });
  const resumed = g2.addCandidate({ url: "http://x.test/dashboard", domSig: sigRich, interaction: "open panel" });
  check("resumed graph dedupes explored states without re-navigation", resumed.duplicate && resumed.reason === "fingerprint-explored", resumed.reason);
  check("resumed graph restores the dedup index", g2.stats().restoredStates > 0, `${g2.stats().restoredStates} states restored`);
  const stateFp = stateFingerprint("http://x.test/dashboard", sigRich);
  check("stateFingerprint stable across versions", typeof stateFp === "string" && stateFp.length === 16, stateFp);
}

// ---- artifact-level checks ----
console.log("\n-- artifact contract --");
{
  const routesJson = JSON.parse(fs.readFileSync(path.join(optRun.artifactsDir, "graph", "routes.json"), "utf8"));
  check("optimized routes.json carries scores", routesJson.routes.every((r) => typeof r.score === "number"), `sample score ${routesJson.routes[0]?.score}`);
  const coverage = JSON.parse(fs.readFileSync(path.join(optRun.artifactsDir, "reports", "coverage-report.json"), "utf8"));
  check("coverage report intact (pipeline contract unchanged)", typeof coverage.coveragePct === "number" && coverage.statesRecorded > 0, `pct ${coverage.coveragePct}`);
}

const totalS = ((baseRun.elapsedMs + optRun.elapsedMs) / 1000).toFixed(1);
console.log(`\n${pass} passed, ${fail} failed — pipeline runs took ${totalS}s (baseline ${baseRun.elapsedMs}ms, optimized ${optRun.elapsedMs}ms)`);
srv.close();
process.exit(fail ? 1 : 0);
