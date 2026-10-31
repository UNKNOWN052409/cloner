// Exploration-engine fixture test (Phase 1): boots each of the four static
// fixture sites (scripts/fixtures/*) on an ephemeral server, runs the real
// pipeline (runExplorationJob) against it with tight budgets, and asserts the
// §15 artifact contract per fixture — job completed, routes discovered (SPA:
// hash routes appear via the SPA recorder), states recorded, dom.json sampled,
// screenshots, graph files, manifest.schemaVersion, and no credential-shaped
// keys anywhere in the artifact JSON.
//
// Run: node scripts/test-exploration-fixtures.mjs   (exit 1 on any failure)
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runExplorationJob } from "../src/pipeline/exploration-pipeline.js";
import { startFixtureServer } from "./fixtures/server.mjs";
import { sites } from "./fixtures/index.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ARTIFACTS = path.join(ROOT, "artifacts");

let pass = 0, fail = 0;
const check = (name, ok, detail = "") => {
  console.log(`  ${ok ? "PASS" : "FAIL"} ${name}${detail ? " — " + detail : ""}`);
  ok ? pass++ : fail++;
};

// tight budgets mandated for every fixture job
const BUDGETS = { maxRoutes: 4, maxStatesPerPage: 8, maxTotalTimeMs: 90000 };

// credential-shaped JSON keys (redact() in src/storage/artifact-store.js masks
// the same family; bare "auth"/"sessionId" are legitimate manifest/log keys and
// deliberately excluded) plus obvious credential value shapes
const CRED_KEY_RE = /"(?:password|passwd|secret|token|api[-_]?key|apikey|authorization|cookie|cookies|private[-_]?key|session[-_]?token|access[-_]?token|refresh[-_]?token|credentials?)"\s*:/i;
const CRED_VALUE_RE = /(?:Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/i;

function walkJsonFiles(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walkJsonFiles(full, out);
    else if (e.name.endsWith(".json")) out.push(full);
  }
  return out;
}

const readJson = (p) => JSON.parse(fs.readFileSync(p, "utf8"));

// ---- assertions shared by every fixture ----
function commonChecks(name, { jobId, artifactsDir, manifest, elapsed }) {
  check(`${name}: job completed`, manifest.status === "completed", `status=${manifest.status} jobId=${jobId}`);
  check(`${name}: manifest.schemaVersion present`, manifest.schemaVersion === "1.0.0", String(manifest.schemaVersion));
  check(`${name}: tight budgets applied`, manifest.configuration?.budgets?.maxRoutes === 4 && manifest.configuration?.budgets?.maxStatesPerPage === 8 && manifest.configuration?.budgets?.maxTotalTimeMs === 90000, JSON.stringify(manifest.configuration?.budgets));

  check(`${name}: routes discovered`, manifest.discoveredRoutes >= 1, `${manifest.discoveredRoutes} route(s)`);
  check(`${name}: states recorded`, manifest.discoveredStates >= 1, `${manifest.discoveredStates} state(s)`);

  const graphFiles = ["routes.json", "states.json", "transitions.json"];
  const graphOk = graphFiles.every((f) => fs.existsSync(path.join(artifactsDir, "graph", f)));
  check(`${name}: graph files exist`, graphOk, graphFiles.join(", "));
  if (graphOk) {
    const states = readJson(path.join(artifactsDir, "graph", "states.json"));
    check(`${name}: graph states.json count matches manifest`, states.stats?.nodes === manifest.discoveredStates, `states.json=${states.stats?.nodes} manifest=${manifest.discoveredStates}`);
  }

  check(`${name}: asset manifest exists`, fs.existsSync(path.join(artifactsDir, "assets", "manifest.json")));
  const reportFiles = ["exploration-summary.json", "coverage-report.json", "failures.json"];
  check(`${name}: reports written`, reportFiles.every((f) => fs.existsSync(path.join(artifactsDir, "reports", f))), reportFiles.join(", "));

  // per explored page: dom.json sampled > 0 + screenshot exists
  let pagesSeen = manifest.pages.length > 0;
  let domOk = pagesSeen, shotsOk = pagesSeen;
  for (const p of manifest.pages) {
    const domPath = path.join(artifactsDir, "pages", p.pageId, "dom.json");
    if (!fs.existsSync(domPath)) { domOk = false; shotsOk = false; continue; }
    const dom = readJson(domPath);
    if (!(dom.sampled > 0)) domOk = false;
    if (!fs.existsSync(path.join(artifactsDir, "pages", p.pageId, "screenshot-viewport.png"))) shotsOk = false;
  }
  check(`${name}: dom.json sampled > 0 for every explored page (${manifest.pages.length})`, pagesSeen && domOk);
  check(`${name}: screenshot exists for every explored page`, pagesSeen && shotsOk);

  // no credential-shaped keys/values in ANY artifact JSON under the job dir
  const offenders = [];
  for (const f of walkJsonFiles(artifactsDir)) {
    const text = fs.readFileSync(f, "utf8");
    if (CRED_KEY_RE.test(text) || CRED_VALUE_RE.test(text)) offenders.push(path.relative(artifactsDir, f));
  }
  check(`${name}: no credentials in artifact JSON`, offenders.length === 0, offenders.length ? offenders.join(", ") : "clean");

  check(`${name}: job inside 90s total budget`, elapsed < 90, elapsed.toFixed(1) + "s");
}

// ---- per-fixture assertions ----
function multiRouteChecks(name, { artifactsDir, manifest }) {
  check(`${name}: 4 routes discovered via nav`, manifest.discoveredRoutes >= 4, `${manifest.discoveredRoutes} route(s)`);
  check(`${name}: all 4 pages explored`, manifest.pages.length === 4, manifest.pages.map((p) => p.pageId).join(","));
  const routes = readJson(path.join(artifactsDir, "graph", "routes.json")).routes.map((r) => new URL(r.url).pathname);
  check(`${name}: routes.json lists the 4 site paths`, ["/", "/products", "/pricing", "/about"].every((p) => routes.includes(p)), routes.join(" "));
  check(`${name}: one root state per route`, manifest.discoveredStates >= 4, `${manifest.discoveredStates} state(s)`);
}

function spaHashChecks(name, { artifactsDir, manifest }) {
  const routes = readJson(path.join(artifactsDir, "graph", "routes.json")).routes;
  const spa = routes.filter((r) => r.source === "spa-transition" && r.url.includes("?route="));
  check(`${name}: hash routes appear via the SPA recorder`, spa.length >= 2, `${spa.length} spa-transition route(s): ${spa.map((r) => r.url).join(" ")}`);
  check(`${name}: hash routes counted in manifest`, manifest.discoveredRoutes >= 3, `${manifest.discoveredRoutes} route(s)`);
  check(`${name}: seed page explored once`, manifest.pages.length === 1, manifest.pages.map((p) => p.pageId).join(","));
  check(`${name}: root state recorded`, manifest.discoveredStates >= 1, `${manifest.discoveredStates} state(s)`);
}

function widgetsChecks(name, { artifactsDir, manifest }) {
  const states = readJson(path.join(artifactsDir, "graph", "states.json"));
  const recorded = states.nodes.filter((n) => n.status === "recorded");
  check(`${name}: modal + dropdown interaction states recorded`, recorded.length >= 2, `${recorded.length} recorded: ${recorded.map((n) => n.interaction).join(", ")}`);
  check(`${name}: root page state explored`, states.nodes.some((n) => n.status === "explored"), `${states.nodes.length} node(s)`);
  check(`${name}: transition edges recorded`, states.edges.length >= 2, `${states.edges.length} edge(s)`);
  check(`${name}: exploration report written`, fs.existsSync(path.join(artifactsDir, "exploration.json")) && fs.existsSync(path.join(artifactsDir, "exploration.md")));
  const dom = readJson(path.join(artifactsDir, "pages", manifest.pages[0].pageId, "dom.json"));
  const inputs = dom.elements.filter((e) => e.tag === "input").length;
  check(`${name}: form inputs extracted into dom.json`, inputs >= 2, `${inputs} input element(s)`);
}

// direct HTTP sanity of the lazy-scroll feed contract (no browser involved)
async function lazyScrollSanity(base) {
  for (let b = 0; b <= 5; b++) {
    const j = await (await fetch(base + "/api/items?batch=" + b)).json();
    check(`lazy-scroll: batch ${b} returns 5 items`, j.items?.length === 5, `got ${j.items?.length}`);
  }
  const j6 = await (await fetch(base + "/api/items?batch=6")).json();
  check("lazy-scroll: batch limit enforced at 5", j6.items.length === 0 && j6.done === true, JSON.stringify(j6));
  const img = await fetch(base + "/img/photo-1.png");
  const buf = Buffer.from(await img.arrayBuffer());
  const isPng = buf.length > 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47;
  check("lazy-scroll: image endpoint serves PNG", img.status === 200 && (img.headers.get("content-type") || "").includes("image/png") && isPng, `${buf.length}B`);
}

async function lazyScrollChecks(name, { base, artifactsDir, manifest }) {
  await lazyScrollSanity(base);
  // NOTE: per-request network assertions (/img/ + /api/items) are NOT asserted
  // here because the pipeline never attaches pages to the network recorder —
  // attachNetworkRecorder(ctx, network) at src/pipeline/exploration-pipeline.js:58
  // never calls the returned attach(page) (src/network/network-recorder.js:6),
  // so network.json entries are always empty today. Once the recorder is wired,
  // upgrade this to assert /img/ image requests + the /api/items?batch=0 fetch.
  const net = readJson(path.join(artifactsDir, "pages", manifest.pages[0].pageId, "network.json"));
  check(`${name}: network.json written for explored page`, Array.isArray(net.entries), `entries=${net.entries.length} (recorder detached — engine gap)`);
  const dom = readJson(path.join(artifactsDir, "pages", manifest.pages[0].pageId, "dom.json"));
  const imgs = dom.elements.filter((e) => e.tag === "img").length;
  check(`${name}: lazy img elements extracted into dom.json`, imgs >= 5, `${imgs} img element(s)`);
  const cards = dom.repeated.find((r) => /photo-card/.test(r.signature));
  check(`${name}: photo-card repeated components detected`, !!cards && cards.count >= 5, cards ? `${cards.signature} x${cards.count}` : "none");
}

const siteChecks = {
  "multi-route": multiRouteChecks,
  "spa-hash": spaHashChecks,
  "widgets": widgetsChecks,
  "lazy-scroll": lazyScrollChecks,
};

// ---- run every fixture ----
console.log(`exploration fixture test — ${sites.length} fixture site(s), budgets ${JSON.stringify(BUDGETS)}`);
const tAll = Date.now();

for (const site of sites) {
  console.log(`\n== fixture: ${site.name} ==`);
  let server = null;
  try {
    server = await startFixtureServer(site);
    const base = server.base;
    const jobId = `fx-${site.name}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 5)}`;
    const t0 = Date.now();
    const { artifactsDir, manifest } = await runExplorationJob({
      url: base + site.entry,
      artifactsRoot: ARTIFACTS,
      jobId,
      config: { policy: { budgets: BUDGETS } },
    });
    const elapsed = (Date.now() - t0) / 1000;
    commonChecks(site.name, { jobId, artifactsDir, manifest, elapsed });
    await siteChecks[site.name]?.(site.name, { base, artifactsDir, manifest });
    const notes = [...(manifest.warnings || []), ...(manifest.errors || [])];
    if (notes.length) console.log(`  (notes) ${JSON.stringify(notes)}`);
  } catch (e) {
    check(`${site.name}: fixture run completed without crash`, false, String((e && e.message) || e).slice(0, 200));
  } finally {
    if (server) await server.close();
  }
}

const totalS = ((Date.now() - tAll) / 1000).toFixed(1);
console.log(`\n${pass} passed, ${fail} failed — fixtures run took ${totalS}s`);
process.exit(fail ? 1 : 0);
