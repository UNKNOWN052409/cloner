// Reconstruction pipeline (spec §11): load artifacts → validate → analyze →
// generate → validate → repair → re-validate → report. Bounded (MAX_ROUNDS),
// deterministic repairs first, honest failure classification, no infinite loops.
import fs from "node:fs";
import path from "node:path";
import { loadArtifacts } from "./artifact-loader.js";
import { buildComponentTree, flattenTree } from "./analysis/component-tree-builder.js";
import { analyzeLayout, buildTokens, tokensCss } from "./analysis/layout-analyzer.js";
import { generatePageHtml, generateProject } from "./generation/project-generator.js";
import { createLogger } from "../observability/logger.js";
import { buildRuntime } from "../runtimeTemplate.js";

const MAX_ROUNDS = 2;

export async function reconstructFromArtifacts(artifactsDir, { outDir, interactionRecords = [] } = {}) {
  const logger = createLogger({ jobId: path.basename(artifactsDir) + "-recon", artifactsDir: path.join(artifactsDir, "..", "_recon-logs") });
  const report = { rounds: [], repairs: [], limitations: [], generatedFiles: 0 };

  // 1) load + validate evidence
  const loaded = loadArtifacts(artifactsDir);
  let exploration = null;
  try { exploration = JSON.parse(fs.readFileSync(path.join(artifactsDir, "exploration.json"), "utf8")); } catch {}
  if (!loaded.ok) {
    return { ok: false, why: "not a phase-1 artifact directory (manifest.json missing)", report };
  }
  logger.info("load", `loaded ${loaded.pages.length} page(s); missing: ${loaded.missing.length}; malformed: ${loaded.malformed.length}`);
  if (loaded.missing.length) report.limitations.push(`missing artifacts: ${loaded.missing.join(", ")}`);
  if (loaded.malformed.length) report.limitations.push(`malformed artifacts: ${loaded.malformed.join(", ")}`);

  // 2..N generation rounds with repair
  let lastPages = [];
  for (let round = 1; round <= MAX_ROUNDS; round++) {
    const pages = [];
    for (const lp of loaded.pages) {
      if (lp.elements === undefined) { lastPages.push({ route: lp.url, skipped: "no dom evidence" }); continue; }
      const rectMap = new Map(lp.elements.map((e) => [e.i, { x: e.rect.x, y: e.rect.y, width: e.rect.w, height: e.rect.h }]));
      const tree = buildComponentTree(lp.dom, lp.pageId);
      const flat = flattenTree(tree);
      const layoutByIndex = new Map(flat.filter((f) => f._elementIndex !== undefined).map((f) => [f._elementIndex, analyzeLayout(lp.elements, rectMap)[f._elementIndex]]));
      const styleByIndex = new Map(lp.elements.map((e) => [e.i, e.style || {}]));
      const interactionsByIndex = new Map();
      const html = generatePageHtml({ url: lp.url, pageId: lp.pageId }, { children: [tree] }, layoutByIndex, styleByIndex, new Map(), interactionsByIndex);
      pages.push({ route: new URL(lp.url, "http://x").pathname, html, elements: flat.length });
      logger.info("generate", `${lp.pageId}: ${flat.length} components rendered`);
    }

    // tokens from this job's evidence
    const stylesElements = loaded.pages.flatMap((p) => p.styles?.elements || []);
    const tokens = buildTokens(loaded.assetManifest, stylesElements);

    // generate the project
    const gen = generateProject({
      interactionRecords,
      outDir,
      pageHtmls: pages.map((p) => ({ route: p.route, html: p.html })),
      tokens, tokensCss: tokensCss(tokens),
      assetsEntries: loaded.capturedAssets,
      explorationReport: { behaviors: exploration?.behaviors || [] },
      interactionRecords,
    });
    report.generatedFiles = pages.filter((p) => p.html).length;
    // nav link rewrite: internal links point to the generated clone, not the origin
    for (const p of pages) {
      if (!p.html || !p.file) continue;
      let html2 = p.html;
      for (const other of pages) {
        if (other === p || !other.file) continue;
        html2 = html2.split(new URL(other.route, p.route).href).join(other.file);
        html2 = html2.split(p.route === '/' ? new URL('/', p.route).href.replace(/\/$/, '') : new URL(other.route, p.route).href).join(other.file);
      }
      if (html2 !== p.html) { p.html = html2; fs.writeFileSync(path.join(outDir, p.file), html2); }
    }

    // 3) validation: pages exist, non-trivial, links internal
    const validation = (gen.files || []).map((p) => {
      const file = p.file ? path.join(outDir, p.file) : null;
      const exists = file && fs.existsSync(file);
      const size = exists ? fs.statSync(file).size : 0;
      return { route: p.route, file: p.file || null, ok: !!exists && size > 800, size };
    });
    const allOk = validation.every((v) => v.ok);

    report.rounds.push({ round, validation, tokens: { colors: tokens.colors?.length, fonts: tokens.fonts?.length } });
    lastPages = pages;
    if (allOk || round === MAX_ROUNDS) {
      report.validation = validation;
      report.passed = allOk;
      break;
    }
    // deterministic repair: pages too small get a fallback shell (missing evidence is reported, not hidden)
    for (const v of validation) {
      if (!v.ok && v.file && fs.existsSync(v.file)) {
        let html = fs.readFileSync(v.file, "utf8");
        if (html.length < 800) {
          html = html.replace("</body>", '<main style="padding:40px;font-family:system-ui"><h1>Reconstructed page</h1><p>Evidence for this route was incomplete — placeholders preserved honestly.</p></main></body>');
          fs.writeFileSync(v.file, html);
          report.repairs.push(`round ${round}: fallback shell for ${v.route} (incomplete evidence)`);
        }
      }
    }
  }

  report.explorationBehaviors = exploration?.behaviors?.length || 0;
  report.pages = lastPages.map((p) => ({ route: p.route, elements: p.elements, skipped: p.skipped || undefined }));
  fs.writeFileSync(path.join(outDir, 'reconstruction-report.json'), JSON.stringify(report, null, 2));
  const mdRows = (report.validation || []).map((v) => '| ' + v.route + ' | ' + (v.file || '—') + ' | ' + v.size + 'B |');
  const md = ['# Reconstruction report', '', '- status: ' + (report.passed ? 'PASSED' : 'FAILED'), '- rounds: ' + report.rounds.length, '- repairs: ' + (report.repairs.length || 0), '- limitations: ' + (report.limitations.length ? report.limitations.join('; ') : 'none'), '', '| Route | File | Size |', '|---|---|---|'].concat(mdRows).join(String.fromCharCode(10));
  fs.writeFileSync(path.join(outDir, 'reconstruction-report.md'), md);
  return { ok: true, report, outDir };
}
