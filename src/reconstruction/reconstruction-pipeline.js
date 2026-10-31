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

export async function reconstructFromArtifacts(artifactsDir, { outDir, interactionRecords = [] } = {}) {
  const logger = createLogger({ jobId: path.basename(artifactsDir) + "-recon", artifactsDir: path.dirname(artifactsDir) });
  const report = { rounds: [], repairs: [], limitations: [], generatedFiles: 0, passed: false };

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
      // asset map: element index → local asset path (images matched by position/hash)
      const assetByIndex = new Map();
      for (const entry of loaded.capturedAssets || []) {
        if (!entry.localPath || !entry.url) continue;
        // match by tag: img elements get the closest captured image
        // v1: naive — a proper mapper would use rect overlap or alt-text
      }
      const interactionsByIndex = new Map();
      for (const rec of interactionRecords) {
        if (rec.domIndex !== undefined) interactionsByIndex.set(rec.domIndex, rec.id);
      }
      const routeFileMap = new Map(pages.filter((p) => p.file).map((p) => [p.route, p.file]));
      const cssCtx = { routeFileMap, interactionsByIndex, assetByIndex };
      const html = generatePageHtml({ url: lp.url, pageId: lp.pageId }, { children: [tree] }, cssCtx);
      const file = lp.pageId === "page-001" ? "index.html" : lp.pageId + ".html";
      pages.push({ route: new URL(lp.url, "http://x").pathname, html, file, elements: flat.length });
      allElements.push(...lp.elements);
      logger.info("generate", `${lp.pageId}: ${flat.length} components, file: ${file}`);
    }

    // tokens from captured evidence
    const stylesElements = loaded.pages.flatMap((p) => p.styles?.elements || []);
    tokens = buildTokens(loaded.assetManifest, stylesElements);
    tokensCssText = tokensCss(tokens);

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
      assetMap: routeFileMap,
      interactionRecords,
    });

    // validation (spec §7)
    const validation = (gen.files || []).map((p) => {
      const file = path.join(outDir, p.file);
      const exists = fs.existsSync(file);
      const size = exists ? fs.statSync(file).size : 0;
      const html = exists ? fs.readFileSync(file, "utf8") : "";
      const cssLinksResolve = !html.includes('href="styles/') || ["tokens.css", "layout.css", "components.css"].every((c) => fs.existsSync(path.join(outDir, "styles", c)));
      const runtimeResolves = !html.includes("runtime/interactions.js") || fs.existsSync(path.join(outDir, "runtime", "interactions.js"));
      return { route: p.route, file: p.file, ok: exists && size > 800 && cssLinksResolve && runtimeResolves, size, cssLinksResolve, runtimeResolves };
    });
    const structuralOk = validation.every((v) => v.ok);
    report.rounds.push({ round, validation, structuralOk });
    report.generatedFiles = pages.filter((p) => p.html).length;
    report.validation = validation;
    report.passed = structuralOk;

    if (report.passed || round === MAX_ROUNDS) break;

    // deterministic repair: pages too small get fallback shell
    for (const v of validation) {
      if (!v.ok && v.file && fs.existsSync(path.join(outDir, v.file))) {
        const fp = path.join(outDir, v.file);
        const html = fs.readFileSync(fp, "utf8");
        if (html.length < 800) {
          fs.writeFileSync(fp, html.replace("</body>", '<main style="padding:40px;font-family:system-ui"><h1>Reconstructed page</h1><p>Evidence for this route was incomplete.</p></main></body>'));
          report.repairs.push(`round ${round}: fallback shell for ${v.route}`);
        }
      }
    }
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
