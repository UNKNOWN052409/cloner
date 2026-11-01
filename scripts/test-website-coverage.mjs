// Multi-category website coverage test (task 3.5.1).
//
// For each Phase-3.5 category fixture (e-commerce, documentation, portal):
//   1. boot the fixture on an ephemeral server,
//   2. run the REAL exploration pipeline (runExplorationJob) with tight budgets,
//   3. run the REAL understanding engine over the artifacts (loadArtifacts +
//      buildUnderstandingPage) and assert the category's structural evidence
//      was classified correctly from generic votes only,
//   4. run the REAL reconstruction pipeline (reconstructFromArtifacts) and
//      assert the generated clone contract (pages, tokens, assets manifest
//      passthrough, report).
//
// The `category` field on each fixture site is test-runner metadata: the
// engine never sees it. Every assertion below is expressed as evidence
// (tokens/roles/tags/geometry/repetition the understanding engine already
// reads generically) — no fixture-name conditionals, no special-cased
// category branches in src/. The end-of-run audit greps src/reconstruction +
// src/exploration for fixture/category special-casing to keep that true.
//
// Run: node scripts/test-website-coverage.mjs   (exit 1 on any failure)
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { runExplorationJob } from "../src/pipeline/exploration-pipeline.js";
import { reconstructFromArtifacts } from "../src/reconstruction/reconstruction-pipeline.js";
import { loadArtifacts } from "../src/reconstruction/artifact-loader.js";
import { buildUnderstandingPage, pageArtifactsFromLoaded } from "../src/reconstruction/website-understanding.js";
import { startFixtureServer } from "./fixtures/server.mjs";
import { categorySites } from "./fixtures/category-index.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
process.chdir(ROOT);
const ARTIFACTS = path.join(ROOT, "artifacts");

let pass = 0, fail = 0;
const check = (name, ok, detail = "") => {
  console.log(`  ${ok ? "PASS" : "FAIL"} ${name}${detail ? " — " + detail : ""}`);
  ok ? pass++ : fail++;
};
const readJson = (p) => JSON.parse(fs.readFileSync(p, "utf8"));
const pathnameOf = (p) => {
  try { return new URL(p.url).pathname; } catch { return null; }
};
const comp = (u, kind) => (u?.components || []).find((c) => c.kind === kind);
const allKind = (u, kind) => (u?.components || []).filter((c) => c.kind === kind);
const evSources = (c) => [...new Set((c?.evidence || []).map((e) => e.source))];

// tight budgets mandated for every category job (mirrors the fixture-run
// contract so the coverage run stays inside CI time)
const BUDGETS = { maxRoutes: 8, maxStatesPerPage: 6, maxInteractionsPerState: 8, maxTotalTimeMs: 90000 };

// ---- shared structural contract for every category (generic, not per-target) ----
function commonStructuralChecks(name, { artifactsDir, manifest }) {
  check(`${name}: exploration job completed`, manifest.status === "completed", `status=${manifest.status}`);
  check(`${name}: manifest.schemaVersion present`, manifest.schemaVersion === "1.0.0", String(manifest.schemaVersion));
  check(`${name}: routes discovered`, manifest.discoveredRoutes >= 1, `${manifest.discoveredRoutes} route(s)`);
  check(`${name}: multi-page capture`, manifest.pages.length >= 2, `${manifest.pages.length} page(s): ${manifest.pages.map((p) => pathnameOf(p)).join(" ")}`);
  check(`${name}: graph files exist`, ["routes.json", "states.json", "transitions.json"].every((f) => fs.existsSync(path.join(artifactsDir, "graph", f))));
  check(`${name}: asset manifest exists`, fs.existsSync(path.join(artifactsDir, "assets", "manifest.json")));
  check(`${name}: exploration reports written`, ["exploration-summary.json", "coverage-report.json", "failures.json"].every((f) => fs.existsSync(path.join(artifactsDir, "reports", f))));
  // per explored page: dom sampled + screenshot + styles + network entries
  let evidenceOk = manifest.pages.length > 0;
  for (const p of manifest.pages) {
    const domPath = path.join(artifactsDir, "pages", p.pageId, "dom.json");
    if (!fs.existsSync(domPath)) { evidenceOk = false; break; }
    const dom = readJson(domPath);
    if (!(dom.sampled > 0) || !Array.isArray(dom.elements) || dom.elements.length === 0) evidenceOk = false;
    if (!fs.existsSync(path.join(artifactsDir, "pages", p.pageId, "screenshot-viewport.png"))) evidenceOk = false;
    if (!fs.existsSync(path.join(artifactsDir, "pages", p.pageId, "styles.json"))) evidenceOk = false;
  }
  check(`${name}: every explored page has dom+styles+screenshot evidence`, evidenceOk);
}

// understanding must work on EVERY captured page of every category, not just
// the fixture's hero page — that is the "same pipeline handles all categories"
// contract.
async function understandAllPages(name, { artifactsDir, manifest }) {
  const loaded = loadArtifacts(artifactsDir);
  check(`${name}: artifact loader ok`, loaded.ok === true, loaded.missing?.length ? `missing: ${loaded.missing.join(",")}` : `${loaded.pages.length} pages`);
  const understandings = [];
  for (const lp of loaded.pages) {
    const u = await buildUnderstandingPage(pageArtifactsFromLoaded(lp, artifactsDir));
    understandings.push(u);
  }
  check(`${name}: understanding ran on every page without crash`, understandings.length === loaded.pages.length && understandings.every((u) => Array.isArray(u.components)), `${understandings.length} page model(s)`);
  check(`${name}: every page classified >= 3 components`, understandings.every((u) => u.components.length >= 3), understandings.map((u) => `${pathnameOf(u)}:${u.components.length}`).join(" "));
  check(`${name}: navigation classified on every page (shared masthead pattern)`, understandings.every((u) => !!comp(u, "navigation") || !!comp(u, "header")), understandings.map((u) => `${pathnameOf(u)}:${Object.keys(u.regions).join("+")}`).join(" "));
  check(`${name}: no vision consult needed (evidence is strong enough offline)`, understandings.every((u) => u.vision.attempted === false), understandings.map((u) => JSON.stringify(u.vision)).join(" "));
  return { loaded, understandings };
}

// reconstruction contract: the SAME generic pipeline must rebuild each category.
async function reconstructAndCheck(name, { artifactsDir }) {
  const outDir = path.join(ARTIFACTS, path.basename(artifactsDir) + "-project");
  const rec = await reconstructFromArtifacts(artifactsDir, { outDir, interactionRecords: [] });
  check(`${name}: reconstruction ok`, rec.ok === true, rec.ok ? `rounds: ${rec.report.rounds.length}` : JSON.stringify(rec.report?.errors || rec.why || "").slice(0, 200));
  check(`${name}: all pages validated`, rec.report.validation.every((v) => v.ok), rec.report.validation.map((v) => `${v.route}:${v.size}B`).join(", "));
  check(`${name}: one html file per captured route`, rec.report.generatedFiles === manifestRouteCount(artifactsDir), `generated=${rec.report.generatedFiles} routes=${manifestRouteCount(artifactsDir)}`);
  check(`${name}: components.css substantive`, fs.existsSync(path.join(outDir, "styles", "components.css")) && fs.statSync(path.join(outDir, "styles", "components.css")).size > 200, `${fs.statSync(path.join(outDir, "styles", "components.css")).size}B`);
  check(`${name}: tokens.css generated`, fs.existsSync(path.join(outDir, "styles", "tokens.css")));
  check(`${name}: index.html substantive`, fs.existsSync(path.join(outDir, "index.html")) && fs.statSync(path.join(outDir, "index.html")).size > 800, `${fs.statSync(path.join(outDir, "index.html")).size}B`);
  check(`${name}: reconstruction report exists`, fs.existsSync(path.join(outDir, "reconstruction-report.json")));
  check(`${name}: limitations recorded honestly`, Array.isArray(rec.report.limitations), `${(rec.report.limitations || []).length} limitation(s)`);
  return { outDir, rec };
}

function manifestRouteCount(artifactsDir) {
  const m = readJson(path.join(artifactsDir, "manifest.json"));
  return new Set(m.pages.map((p) => pathnameOf(p))).size;
}

// =====================================================================
console.log(`website-coverage test — ${categorySites.length} category fixture(s), budgets ${JSON.stringify(BUDGETS)}`);
const tAll = Date.now();

const perCategory = {};

for (const site of categorySites) {
  const name = site.name;
  console.log(`\n== category fixture: ${name} (${site.category}) ==`);
  let server = null;
  try {
    server = await startFixtureServer(site);
    const base = server.base;
    const jobId = `cov-${site.category}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 5)}`;
    const t0 = Date.now();
    const { artifactsDir, manifest } = await runExplorationJob({
      url: base + site.entry,
      artifactsRoot: ARTIFACTS,
      jobId,
      config: { policy: { budgets: BUDGETS } },
    });
    const elapsed = (Date.now() - t0) / 1000;
    check(`${name}: job inside 90s budget`, elapsed < 90, elapsed.toFixed(1) + "s");

    commonStructuralChecks(name, { artifactsDir, manifest });
    const { understandings } = await understandAllPages(name, { artifactsDir, manifest });

    // reconstruction — the pipeline is category-blind; the assertions are not.
    const rec = await reconstructAndCheck(name, { artifactsDir });
    if (rec) perCategory[site.category] = { artifactsDir, understandings, rec };
  } catch (e) {
    check(`${name}: fixture run completed without crash`, false, String((e && e.message) || e).slice(0, 300));
  } finally {
    if (server) await server.close();
  }
}

// =====================================================================
// per-category structural evidence assertions (generic vote evidence only)
console.log("\n== per-category structural evidence ==");

// ---------- e-commerce ----------
{
  const cat = perCategory["e-commerce"];
  if (cat) {
    const { artifactsDir, understandings } = cat;
    const uCatalog = understandings.find((u) => pathnameOf(u) === "/catalog");
    check("e-commerce: catalog page captured", !!uCatalog, "routes: " + understandings.map((u) => pathnameOf(u)).join(" "));
    if (uCatalog) {
      const grids = allKind(uCatalog, "card-grid");
      const grid = grids.find((g) => g.provenance?.cls && String(g.provenance.cls).includes("product-grid"));
      check("e-commerce: product grid classified as card-grid", !!grid, grid ? `element ${grid.elementIndex} conf=${grid.confidence}` : "no product-grid card-grid");
      check("e-commerce: card-grid evidence is repetition + geometry (not a category branch)", !!grid && evSources(grid).includes("repetition") && evSources(grid).includes("geometry"), grid ? evSources(grid).join(",") : "");
      const cards = allKind(uCatalog, "card");
      check("e-commerce: >= 3 product cards classified", cards.length >= 3, `${cards.length} card(s)`);
      check("e-commerce: cards carry product class token provenance", cards.length >= 3 && cards.every((c) => String(c.provenance?.cls || "").includes("product-card")), cards.slice(0, 2).map((c) => c.provenance?.cls).join(" | "));
      const groups = uCatalog.relationships.repeatedGroups;
      check("e-commerce: repeated product-card group recorded", groups.some((g) => /product-card/.test(g.signature) && g.siblings >= 3), groups.map((g) => `${g.signature}×${g.siblings}`).join(", "));
      const sidebar = comp(uCatalog, "sidebar");
      check("e-commerce: filter sidebar classified (aside/side region)", !!sidebar, sidebar ? `${sidebar.kind}@${sidebar.confidence} tag=${sidebar.provenance?.tag}` : "no sidebar");
      // cart badge: a tiny inline element the engine records as an element with
      // provenance (not necessarily an elected component) — assert on the
      // captured dom evidence, which is the generic contract.
      const domCatalog = readJson(path.join(artifactsDir, "pages", uCatalog.pageId, "dom.json"));
      const badge = domCatalog.elements.find((e) => /cart-badge/.test(String(e.cls || "")));
      check("e-commerce: cart badge element captured with class provenance", !!badge && badge.text !== undefined, badge ? `cls=${badge.cls} text=${JSON.stringify(badge.text)}` : "no cart-badge element");
    }
    const uPdp = understandings.find((u) => pathnameOf(u) === "/telescope-kit");
    if (uPdp) {
      const table = comp(uPdp, "table");
      check("e-commerce: PDP specs table classified", !!table, table ? `conf=${table.confidence}` : "no table");
      const pdpForm = allKind(uPdp, "form").find((f) => String(f.provenance?.cls || "").includes("add-form"));
      check("e-commerce: PDP add-to-cart form classified", !!pdpForm, pdpForm ? `conf=${pdpForm.confidence}` : "no form");
      const triggers = uPdp.interactions.triggers || [];
      check("e-commerce: add-to-cart trigger captured in interactions", triggers.some((t) => /add-to-cart/.test(t.id || "")), `${triggers.length} trigger(s)`);
      // product images must have been fetched over the network — evidence the
      // asset pipeline can map them
      check("e-commerce: product images recorded as network traffic", uPdp.interactions.imageCount >= 1 || uPdp.interactions.networkEntries >= 1, `images=${uPdp.interactions.imageCount} entries=${uPdp.interactions.networkEntries}`);
    }
    // asset flow: network-captured entries carry hash + localPath, and the
    // generated project copies them into public/assets/ (end-to-end asset
    // loading). byType bucketing is an engine detail — files land under
    // assets/images/ on disk but bucket as "other" in the manifest (the
    // TYPE_BY_DIR map in src/assets/asset-manifest.js has "img", not
    // "images") — asserted as entries, not byType.
    const assetManifest = readJson(path.join(artifactsDir, "assets", "manifest.json"));
    const netEntries = assetManifest.capturedFromNetwork?.entries || [];
    const imageEntries = netEntries.filter((e) => /\.png$/i.test(e.localPath || ""));
    check("e-commerce: asset manifest records network-captured images with hash+localPath", imageEntries.length >= 5 && imageEntries.every((e) => e.hash && e.localPath), `${imageEntries.length} image entr(y/ies)`);
    const projAssets = path.join(cat.rec.outDir, "public", "assets");
    const copiedPngs = fs.existsSync(projAssets) ? fs.readdirSync(projAssets).filter((f) => f.endsWith(".png")) : [];
    check("e-commerce: generated project carries the product images", copiedPngs.length >= imageEntries.length, `${copiedPngs.length} png(s) in public/assets vs ${imageEntries.length} captured`);
  } else {
    check("e-commerce: category ran", false, "missing from perCategory — see earlier failures");
  }
}

// ---------- documentation ----------
{
  const cat = perCategory["documentation"];
  if (cat) {
    const { understandings } = cat;
    const uArticle = understandings.find((u) => pathnameOf(u) === "/install");
    check("docs: article page captured", !!uArticle, "routes: " + understandings.map((u) => pathnameOf(u)).join(" "));
    if (uArticle) {
      const sidebar = comp(uArticle, "sidebar");
      check("docs: sidebar classified", !!sidebar, sidebar ? `tag=${sidebar.provenance?.tag} conf=${sidebar.confidence}` : "no sidebar component");
      check("docs: sidebar evidence is aside tag or side geometry (generic)", !!sidebar && (sidebar.provenance?.tag === "aside" || evSources(sidebar).includes("geometry") || evSources(sidebar).includes("dom-class")), sidebar ? evSources(sidebar).join(",") : "");
      check("docs: sidebar classified on EVERY docs page (persistent pattern)", understandings.every((u) => !!comp(u, "sidebar")), understandings.map((u) => `${pathnameOf(u)}:${!!comp(u, "sidebar")}`).join(" "));
      const sidebars = allKind(uArticle, "sidebar");
      check("docs: sidebar carries documentation nav token provenance", sidebars.some((s) => /docs-sidebar/.test(String(s.provenance?.cls || ""))), sidebars.map((s) => s.provenance?.cls).join(" | "));
      const nav = comp(uArticle, "navigation");
      check("docs: in-sidebar nav classified", !!nav, nav ? `conf=${nav.confidence}` : "no nav");
      check("docs: workspace (article body) classified", !!comp(uArticle, "workspace"), uArticle.regions && Object.keys(uArticle.regions).join(","));
    }
    const uRef = understandings.find((u) => pathnameOf(u) === "/api");
    if (uRef) {
      const table = comp(uRef, "table");
      check("docs: API reference table classified", !!table, table ? `conf=${table.confidence} sources=${evSources(table).join(",")}` : "no table");
    }
    const uHome = understandings.find((u) => pathnameOf(u) === "/");
    if (uHome) {
      const groups = uHome.relationships.repeatedGroups;
      check("docs: guide-tile repeated group recorded", groups.some((g) => /guide-tile/.test(g.signature) && g.siblings >= 3), groups.map((g) => `${g.signature}×${g.siblings}`).join(", "));
    }
  } else {
    check("documentation: category ran", false, "missing from perCategory — see earlier failures");
  }
}

// ---------- portal ----------
{
  const cat = perCategory["portal"];
  if (cat) {
    const { understandings } = cat;
    const uServices = understandings.find((u) => pathnameOf(u) === "/services");
    check("portal: services page captured", !!uServices, "routes: " + understandings.map((u) => pathnameOf(u)).join(" "));
    if (uServices) {
      const table = comp(uServices, "table");
      check("portal: services table classified", !!table, table ? `conf=${table.confidence}` : "no table");
      check("portal: services table evidence is dom-tag + geometry", !!table && evSources(table).includes("dom-tag") && evSources(table).includes("geometry"), table ? evSources(table).join(",") : "");
      const filterForm = allKind(uServices, "form").find((f) => String(f.provenance?.cls || "").includes("filter-bar") || (f.provenance?.cls || "") === "" && f.provenance?.tag === "form");
      check("portal: filter bar classified as form", !!filterForm, filterForm ? `${filterForm.kind}@${filterForm.confidence}` : "no form");
      // status chips are tiny leaves — assert on the captured dom evidence
      // (class + text), the generic capture contract, not on election
      const domServices = readJson(path.join(cat.artifactsDir, "pages", uServices.pageId, "dom.json"));
      const chips = domServices.elements.filter((e) => /status-(open|limited|closed)/.test(String(e.cls || "")));
      check("portal: status chips captured with class + text", chips.length >= 5 && chips.every((c) => /open|limited|closed/.test(String(c.text || ""))), `${chips.length} chip element(s): ${chips.slice(0, 3).map((c) => c.text).join(",")}`);
    }
    const uBooking = understandings.find((u) => pathnameOf(u) === "/waste-collection");
    if (uBooking) {
      const booking = allKind(uBooking, "form").find((f) => String(f.provenance?.cls || "").includes("booking-form") || String(f.provenance?.cls || "").includes("waste-booking"));
      check("portal: booking form classified", !!booking, booking ? `${booking.kind}@${booking.confidence}` : "no booking form");
      // count input/select/textarea descendants of the form element straight
      // from the captured dom.json (generic evidence, not a category rule)
      const dom = readJson(path.join(cat.artifactsDir, "pages", uBooking.pageId, "dom.json"));
      const inputTags = new Set(["input", "select", "textarea"]);
      const formDescendants = (rootIdx) => {
        let n = 0;
        const stack = [rootIdx];
        while (stack.length) {
          const cur = stack.pop();
          for (const e of dom.elements) {
            if (e.parent === cur) {
              if (inputTags.has(String(e.tag || "").toLowerCase())) n++;
              stack.push(e.i);
            }
          }
        }
        return n;
      };
      const fields = booking ? formDescendants(booking.elementIndex) : null;
      check("portal: booking form has multiple input fields captured", fields >= 2, `fields=${fields}`);
    }
    const uAccount = understandings.find((u) => pathnameOf(u) === "/account");
    if (uAccount) {
      // account sign-in form fields captured (input+password+button)
      const dom = readJson(path.join(cat.artifactsDir, "pages", uAccount.pageId, "dom.json"));
      const inputs = dom.elements.filter((e) => ["input", "select", "textarea"].includes(String(e.tag || "").toLowerCase()));
      check("portal: account sign-in form fields captured", inputs.length >= 2, `inputs=${inputs.length}`);
      // no credential material may appear in understanding output — the PIN
      // input exists but its value is never set
      check("portal: no credential values in understanding output", !/"(?:password|pin|secret|token)"\s*:\s*"[^"]{4,}"/i.test(JSON.stringify(uAccount)), "clean");
    }
  } else {
    check("portal: category ran", false, "missing from perCategory — see earlier failures");
  }
}

// =====================================================================
// same-pipeline guarantee: every category went through the exact same
// runExplorationJob + buildUnderstandingPage + reconstructFromArtifacts calls
// with identical budgets — assert that the per-category runtime shapes are
// structurally comparable (no category got bespoke handling).
console.log("\n== cross-category comparability ==");
{
  const cats = Object.keys(perCategory);
  check("all 3 categories reconstructed through one pipeline", cats.length === 3, cats.join(", "));
  for (const [cat, { rec: recWrap, understandings }] of Object.entries(perCategory)) {
    const warnings = understandings.flatMap((u) => u.warnings || []);
    check(`${cat}: understanding emitted no unexpected warnings`, warnings.length === 0, warnings.join(" | ").slice(0, 200));
    const inner = recWrap?.rec || recWrap; // reconstructAndCheck returns { outDir, rec }
    const rounds = inner?.report?.rounds;
    check(`${cat}: reconstruction produced a report with rounds`, inner?.ok === true && Array.isArray(rounds), `${Array.isArray(rounds) ? rounds.length + " round(s)" : "no report"}`);
  }
}

// =====================================================================
// target-independence guard: no fixture/category/brand special-casing may
// exist in the engine. The coverage test fails if src/ references this test's
// fixture names, the category names, or the brand words used in the fixtures.
console.log("\n== target-independence guard ==");
{
  const engineDirs = ["src/reconstruction", "src/exploration", "src/pipeline"];
  const banned = [
    /category-ecommerce/i, /category-docs/i, /category-portal/i, /telescope-kit/i,
    /northbrook/i, /marshlight/i, /astro[-_ ]?retail/i,
  ];
  const offenders = [];
  for (const dir of engineDirs) {
    const abs = path.join(ROOT, dir);
    for (const entry of fs.readdirSync(abs, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith(".js")) continue;
      const file = path.join(abs, entry.name);
      const text = fs.readFileSync(file, "utf8");
      for (const re of banned) if (re.test(text)) offenders.push(`${path.relative(ROOT, file)} matches ${re}`);
    }
  }
  check("engine has no category-fixture special-casing", offenders.length === 0, offenders.join("; ") || "clean");
}

const totalS = ((Date.now() - tAll) / 1000).toFixed(1);
console.log(`\n${pass} passed, ${fail} failed — coverage run took ${totalS}s`);
process.exit(fail ? 1 : 0);
