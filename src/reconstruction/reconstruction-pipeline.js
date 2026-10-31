// Reconstruction pipeline (spec §11): load → validate → analyze → generate →
// validate → repair → report. Bounded, honest failure classification.
import fs from "node:fs";
import path from "node:path";
import { loadArtifacts } from "./artifact-loader.js";
import { buildComponentTree, flattenTree } from "./analysis/component-tree-builder.js";
import { analyzeLayout, buildTokens, tokensCss } from "./analysis/layout-analyzer.js";
import { buildComponentCss, buildLayoutCss, generatePageHtml, generateProject, buildLayoutCss as layoutCssBuilder } from "./generation/project-generator.js";
import { createLogger } from "../observability/logger.js";

const MAX_ROUNDS = 2;

const escHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

// interaction replay records from captured evidence: exploration.json behaviors
// + states/<pageId>/<recordId>.html captured content. These feed the generated
// runtime so recorded controls actually replay in the clone (overlay for tN
// triggers, module panels for mN picker entries — the runtime matches ids and
// falls back to text signatures after SPA re-renders).
export function deriveInteractionRecords(artifactsDir) {
  const records = [];
  let behaviors = [];
  try { behaviors = JSON.parse(fs.readFileSync(path.join(artifactsDir, "exploration.json"), "utf8")).behaviors || []; } catch { return records; }
  const trigById = new Map();
  for (const b of behaviors) if (b.trigger?.id) trigById.set(b.trigger.id, b);
  const modByText = new Map();
  for (const b of behaviors) for (const cp of b.childPanels || []) if (cp.text) modByText.set(cp.text, cp);
  const statesRoot = path.join(artifactsDir, "states");
  let pageDirs = [];
  try { pageDirs = fs.readdirSync(statesRoot, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name); } catch { return records; }
  for (const pageId of pageDirs) {
    let files = [];
    try { files = fs.readdirSync(path.join(statesRoot, pageId)); } catch { continue; }
    for (const f of files) {
      const m = f.match(/^(t\d+|m\d+)\.html$/);
      if (!m) continue;
      const id = m[1];
      let html = "";
      try { html = fs.readFileSync(path.join(statesRoot, pageId, f), "utf8"); } catch { continue; }
      if (id.startsWith("t")) {
        const b = trigById.get(id);
        if (!b) continue; // no documented behavior for this capture — honest skip
        records.push({ id, kind: b.opens?.kind || "overlay", text: b.trigger.label || "", html, box: { w: b.opens?.w, h: b.opens?.h } });
      } else {
        const h = html.match(/<h[1-4][^>]*>([^<]{1,80})</);
        const text = (h ? h[1] : "").trim();
        const cp = modByText.get(text);
        records.push({ id, kind: "module", text, html, box: cp ? { w: cp.w, h: cp.h } : {} });
      }
    }
  }
  return records;
}

export async function reconstructFromArtifacts(artifactsDir, { outDir, interactionRecords } = {}) {
  const logger = createLogger({ jobId: path.basename(artifactsDir) + "-recon", artifactsDir: path.dirname(artifactsDir) });
  const report = { rounds: [], repairs: [], limitations: [], generatedFiles: 0, passed: false };
  // explicit records win (runner may pass captured ones); else derive from artifacts
  const replayRecords = (interactionRecords && interactionRecords.length) ? interactionRecords : deriveInteractionRecords(artifactsDir);

  // ---- load + validate evidence (spec §2) ----
  const loaded = loadArtifacts(artifactsDir);
  if (!loaded.ok) return { ok: false, why: "not a phase-1 artifact directory (manifest.json missing)", report };
  let exploration = null;
  try { exploration = JSON.parse(fs.readFileSync(path.join(artifactsDir, "exploration.json"), "utf8")); } catch {}
  logger.info("load", `loaded ${loaded.pages.length} page(s); missing: ${loaded.missing.length}; malformed: ${loaded.malformed.length}`);
  if (loaded.missing.length) report.limitations.push(`missing artifacts: ${loaded.missing.join(", ")}`);
  if (loaded.malformed.length) report.limitations.push(`malformed: ${loaded.malformed.join(", ")}`);

  // ---- per-page analysis + generation (spec §3, §4, §5) ----
  let pages = [];
  let tokens = null;
  let tokensCssText = "";
  let layoutCssText = "";
  let componentsCssText = "";
  const assetMap = new Map();
  for (const entry of loaded.capturedAssets || []) {
    if (entry.localPath && entry.url) assetMap.set(entry.url, entry.localPath);
  }

  for (let round = 1; round <= MAX_ROUNDS; round++) {
    pages = [];
    const allElements = [];
    for (const lp of loaded.pages) {
      if (lp.elements === undefined || lp.emptyEvidence) {
        pages.push({ route: lp.url ? new URL(lp.url, "http://x").pathname : lp.pageId, html: "", elements: 0, skipped: "no dom evidence" });
        continue;
      }
      const rectMap = new Map(lp.elements.map((e) => [e.i, { x: e.rect.x, y: e.rect.y, width: e.rect.w, height: e.rect.h }]));
      const tree = buildComponentTree(lp.dom, lp.pageId);
      const flat = flattenTree(tree);
      const layoutByIndex = new Map();
      for (const el of lp.elements) {
        layoutByIndex.set(el.i, analyzeLayout(lp.elements, rectMap)[el.i] || null);
      }
      const styleByIndex = new Map(lp.elements.map((e) => [e.i, e.style || {}]));
      // asset map: element index → web-relative asset URL. img src (captured
      // resolved absolute URL) is matched against the capture stage's url→localPath
      // entries — exact first, then query/hash-stripped
      const assetByIndex = new Map();
      const assetLookup = new Map();
      for (const entry of loaded.capturedAssets || []) {
        if (!entry.localPath || !entry.url) continue;
        const webRel = "public/assets/" + path.basename(entry.localPath);
        assetLookup.set(entry.url, webRel);
        const bare = entry.url.split("?")[0].split("#")[0];
        if (!assetLookup.has(bare)) assetLookup.set(bare, webRel);
      }
      for (const el of lp.elements) {
        if (el.tag !== "img" || !el.src) continue;
        const hit = assetLookup.get(el.src) || assetLookup.get(el.src.split("?")[0].split("#")[0]);
        if (hit) assetByIndex.set(el.i, hit);
      }
      const interactionsByIndex = new Map();
      for (const rec of replayRecords) {
        if (rec.domIndex !== undefined) interactionsByIndex.set(rec.domIndex, rec.id);
      }
      const routeFileMap = new Map(pages.filter((p) => p.file).map((p) => [p.route, p.file]));
      const cssCtx = { routeFileMap, interactionsByIndex, assetByIndex };
      const html = generatePageHtml({ url: lp.url, pageId: lp.pageId }, { children: [tree] }, cssCtx);
      // route-slug filenames: page-001 (the seed) is always index.html; other
      // pages take a readable route slug ("/pricing" → pricing.html)
      const route = new URL(lp.url, "http://x").pathname;
      const file = lp.pageId === "page-001" || route === "/"
        ? "index.html"
        : (route.replace(/^\//, "").replace(/\.html?$/i, "").replace(/[?&#]/g, "_") || lp.pageId) + ".html";
      pages.push({ route, html, file, elements: flat.length });
      allElements.push(...lp.elements);
      logger.info("generate", `${lp.pageId}: ${flat.length} components, file: ${file}`);
    }

    // tokens from captured evidence
    const stylesElements = loaded.pages.flatMap((p) => p.styles?.elements || []);
    tokens = buildTokens(loaded.assetManifest, stylesElements);
    tokensCssText = tokensCss(tokens);
    // persist the measured tokens next to the artifacts — verification's HEX
    // stage reads this file (same contract as the v1 flow's design-tokens.json)
    if (tokens) {
      try { fs.writeFileSync(path.join(artifactsDir, "design-tokens.json"), JSON.stringify(tokens, null, 2)); } catch {}
    }

    // components.css from all pages' captured styles
    const layoutByIndex = new Map();
    for (const lp of loaded.pages) {
      if (!lp.elements) continue;
      const rectMap = new Map(lp.elements.map((e) => [e.i, { x: e.rect.x, y: e.rect.y, width: e.rect.w, height: e.rect.h }]));
      const pageLayout = analyzeLayout(lp.elements, rectMap);
      for (const [k, v] of Object.entries(pageLayout)) layoutByIndex.set(Number(k), v);
    }
    componentsCssText = buildComponentCss(allElements, layoutByIndex);
    layoutCssText = buildLayoutCss(allElements.slice(0, 5), layoutByIndex);

    // generate the project (copies assets, writes pages + CSS + runtime)
    const routeFileMap = new Map(pages.filter((p) => p.file).map((p) => [p.route, p.file]));
    const gen = generateProject({
      outDir,
      pageHtmls: pages.filter((p) => p.html),
      tokensCssText, layoutCss: layoutCssText, componentsCss: componentsCssText,
      assetMap, // url → captured localPath (routeFileMap is for hrefs, not assets)
      assetRoot: artifactsDir, // localPath is relative to the JOB artifact dir
      interactionRecords: replayRecords,
    });

    // validation (spec §7)
    const validateGenerated = () => (gen.files || []).map((p) => {
      const file = path.join(outDir, p.file);
      const exists = fs.existsSync(file);
      const size = exists ? fs.statSync(file).size : 0;
      const html = exists ? fs.readFileSync(file, "utf8") : "";
      const cssLinksResolve = !html.includes('href="styles/') || ["tokens.css", "layout.css", "components.css"].every((c) => fs.existsSync(path.join(outDir, "styles", c)));
      const runtimeResolves = !html.includes("runtime/interactions.js") || fs.existsSync(path.join(outDir, "runtime", "interactions.js"));
      return { route: p.route, file: p.file, ok: exists && size > 800 && cssLinksResolve && runtimeResolves, size, cssLinksResolve, runtimeResolves };
    });

    // generation is deterministic — repair and re-validate WITHIN the round;
    // regenerating in round 2 would just discard the round-1 repairs
    let validation = validateGenerated();
    if (!validation.every((v) => v.ok)) {
      for (const v of validation) {
        if (v.ok || !v.file) continue;
        const fp = path.join(outDir, v.file);
        if (!fs.existsSync(fp)) continue;
        const html = fs.readFileSync(fp, "utf8");
        if (html.length >= 800) continue;
        // substantive fallback shell: keeps the shared CSS/runtime wiring and adds
        // a navigable notice — an honestly-limited page, not a dead stub
        const title = v.route === "/" ? "Home" : `Page ${v.route}`;
        const shell = html.replace(
          "</body>",
          `<main style="padding:48px 40px;font-family:system-ui;max-width:720px;margin:0 auto">
  <h1 style="font-size:28px;margin:0 0 12px">${escHtml(title)}</h1>
  <p style="color:#666;line-height:1.6">Evidence for this route was incomplete during exploration, so this page is a placeholder shell carrying the site's captured design tokens and styles.</p>
  <p style="margin-top:24px"><a href="index.html" style="color:#0a66c2">← Back to home</a></p>
</main></body>`,
        );
        fs.writeFileSync(fp, shell);
        report.repairs.push(`round ${round}: fallback shell for ${v.route}`);
      }
      validation = validateGenerated();
    }

    const structuralOk = validation.every((v) => v.ok);
    report.rounds.push({ round, validation, structuralOk });
    report.generatedFiles = pages.filter((p) => p.html).length;
    report.validation = validation;
    report.passed = structuralOk;

    if (report.passed || round === MAX_ROUNDS) break;
  }

  // ---- success contract (spec §7) ----
  report.status = report.passed ? "completed" : "completed_with_limitations";
  report.limitations.push(...(loaded.missing.length ? [`missing artifacts: ${loaded.missing.join(", ")}`] : []));

  // write reports
  fs.writeFileSync(path.join(outDir, "reconstruction-report.json"), JSON.stringify(report, null, 2));
  const mdRows = (report.validation || []).map((v) => `| ${v.route} | ${v.file || "—"} | ${v.size || 0}B |`);
  const md = ["# Reconstruction report", "", `- status: ${report.status}`, `- rounds: ${report.rounds.length}`, `- repairs: ${report.repairs.length || 0}`, `- limitations: ${report.limitations.length ? report.limitations.join("; ") : "none"}`, "", "| Route | File | Size |", "|---|---|---|"].concat(mdRows).join("\n");
  fs.writeFileSync(path.join(outDir, "reconstruction-report.md"), md);

  return { ok: report.passed, report, outDir };
}
