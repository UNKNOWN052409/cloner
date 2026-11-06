// Three-step verification + automated correction loop (spec v2).
// Lives in the ENGINE (src/reconstruction/) per ADR-0002: verification is
// engine logic; the shell imports it like any other adapter. Moved verbatim
// from src/platform/verify.js on 2026-11-05 (git mv, history preserved).
//   Step 1 FUNCTIONAL:     everything works — every recorded interaction replays,
//                          inner entries open panels, no decorative buttons.
//   Step 2 OPTIMIZATION &  performance of the clone (load time, asset weight) +
//          COMPLETENESS    completeness (required artifacts, exploration coverage,
//                          requirements from the task) + no unnecessary elements.
//   Step 3 VISUAL:         side-by-side original vs clone — pixel diff + heatmap +
//                          EXACT HEX color/typography/spacing/component comparison,
//                          extra-or-missing element report.
// If any stage fails, autoRemediate() applies bounded corrections (token overrides,
// dead-attribute pruning) and the cycle re-runs — up to MAX_ROUNDS.
// Split for the file-size cap: the stage bodies live in verify-visual2.js
// (stage 1 functional), verify-visual3.js (stage 2 optimization/completeness)
// and verify-visual.js (stage-3 visual engine, re-exported below); this module
// keeps verifyTask, the correction/repair loop and the round orchestration.
import fs from "node:fs";
import path from "node:path";
import { launchBrowser } from "../browser.js";
// Phase 3.4 integrations (wired by the integration agent):
import { analyzeFidelity } from "./visual-fidelity-analyzer.js"; // task 3.4.3
import { classifyDefects } from "./visual-diff-classifier.js"; // task 3.4.3
import { analyzeLayoutDefects } from "./analysis/layout-analyzer.js"; // layout defect detections (header/overflow/section)
import { runRepairLoop } from "./repair-executor.js"; // task 3.4.5
import { runFlowMatrix } from "./verify-flows.js"; // flow-matrix: numbered flow cases (F01-H1…) replayed on the clone
import { DOM_EXTRACTOR_SCRIPT } from "../intelligence/dom-extractor.js"; // clone element measurement
import { createLogger } from "../observability/logger.js"; // stage summary (log contract)
import { createWorkflowEmitter } from "../observability/workflow-events.js"; // viewer todo/stage events
// split (file-size cap): the stage bodies + the shared runtime-records util live
// in the verify-visual*.js modules — imported back for the orchestration loop
import { parseRuntimeRecords, stage3Visual } from "./verify-visual.js";
import { stage1Functional } from "./verify-visual2.js";
import { stage2Optimization } from "./verify-visual3.js";

const MAX_ROUNDS = 3;

// stage-3 visual helpers split to ./verify-visual.js (file-size cap) — re-exported
// so every consumer keeps importing them from this module unchanged.
export {
  regionForCell, parseComparisonTxt, toHex, dynamicRegionElements, cellRect,
  rectsIntersect, dynamicAttribution, compareRegionStructure, rectIoU,
} from "./verify-visual.js";

// v2 layout detection: the reconstruction pipeline writes the editable project
// to <artifactsDir>-project/ — verification must target that tree
function v2Layout(artifactsDir) {
  const cloneDir = artifactsDir + "-project";
  return fs.existsSync(path.join(cloneDir, "index.html")) ? cloneDir : null;
}

// ==================================================== AUTOMATED CORRECTION LOOP
// bounded fixes the platform can apply without a live page:
//  - visual token drift → clone-fixes.css overrides from the LIVE measured tokens
//    (body background/color/font + :root variables) — the "grey vs black" class
//  - dead trigger attrs / empty module records → strip them from the clone
function autoRemediate(report, out, artifactsDir = null) {
  const fixes = [];
  try {
    const visual = report.stages.find((s) => s.stage === "visual");
    if (visual && !visual.passed && visual.hex && !visual.hex.error) {
      // measured tokens live in the artifacts dir (v2) or the clone dir (v1)
      const tokensFile = path.join(artifactsDir || out, "design-tokens.json");
      const live = JSON.parse(fs.readFileSync(tokensFile, "utf8"));
      // prefer the measured BODY background — backgrounds[0][0] ranks by
      // element frequency, and on multi-page sites that rank is a NAV/section
      // color, not the body (measured 2026-11-07: a grade-A clone was
      // repainted grade-D by its own nav bar's #1d3557).
      let bg = live.backgrounds?.[0]?.[0];
      try {
        const stylesDir = path.join(artifactsDir || out, "pages");
        const firstPage = fs.readdirSync(stylesDir).find((d) => d.startsWith("page"));
        if (firstPage) {
          const st = JSON.parse(fs.readFileSync(path.join(stylesDir, firstPage, "styles.json"), "utf8"));
          const bodyBg = st?.bodyStyle?.background || st?.bodyStyle?.backgroundColor;
          if (bodyBg && bodyBg !== "rgba(0, 0, 0, 0)" && bodyBg !== "transparent") bg = bodyBg;
        }
      } catch { /* token-frequency fallback stands */ }
      const color = live.colors?.[0]?.[0], font = live.fonts?.[0]?.[0];
      if (bg || color || font) {
        let css = `\n/* auto-correction: token overrides from measured live values */\n`;
        if (bg) css += `body { background: ${bg} !important; }\n`;
        if (color) css += `body { color: ${color} !important; }\n`;
        if (font) css += `body { font-family: ${font} !important; }\n`;
        const fixPath = path.join(out, "clone-fixes.css");
        const linkTag = `<link rel="stylesheet" href="clone-fixes.css">`;
        fs.appendFileSync(fixPath, css);
        const idxPath = path.join(out, "index.html");
        let html = fs.readFileSync(idxPath, "utf8");
        if (!html.includes("clone-fixes.css")) {
          html = html.replace(/<\/head>/i, `  <link rel="stylesheet" href="clone-fixes.css">\n</head>`);
          fs.writeFileSync(idxPath, html);
        }
        fixes.push(`clone-fixes.css: body token overrides applied (bg=${bg}, color=${color}, font=${font}) + link injected`);
      }
    }
    // dead interactive attrs → strip (no record backs them — decorative by definition)
    const extra = report.stages.find((s) => s.stage === "visual")?.hex?.extra || [];
    if (extra.length) {
      const idxPath = path.join(out, "index.html");
      let html = fs.readFileSync(idxPath, "utf8");
      for (const id of extra) {
        html = html.replace(new RegExp(`\\s*data-cloner-trigger="${id}"`, "g"), "");
      }
      fs.writeFileSync(idxPath, html);
      fixes.push(`stripped ${extra.length} dead trigger attr(s): ${extra.join(",")}`);
    }
  } catch (e) {
    fixes.push("remediation error: " + e.message.slice(0, 100));
  }
  return fixes;
}

// ==================================================== FIDELITY + REPAIR (tasks 3.4.3/3.4.5)
// measureFidelity(cloneDir, artifactsDir) — render the clone and measure it
// against the exploration's page-001 viewport screenshot with the 3.4.3
// analyzer (same 12×8 geometry + threshold 30 as compare-clone.mjs). Returns
// the fidelity report, or null when there is nothing to compare (v1 runs, or
// the page-001 screenshot/dom evidence is missing) — null is honest absence,
// never a zero.
async function measureFidelity(cloneDir, artifactsDir) {
  try {
    const origPng = path.join(artifactsDir, "pages", "page-001", "screenshot-viewport.png");
    const domPath = path.join(artifactsDir, "pages", "page-001", "dom.json");
    if (!fs.existsSync(origPng) || !fs.existsSync(domPath) || !fs.existsSync(path.join(cloneDir, "index.html"))) return null;
    const dom = JSON.parse(fs.readFileSync(domPath, "utf8"));
    const originalElements = Array.isArray(dom?.elements) ? dom.elements : null;
    if (!originalElements) return null;
    const b = await launchBrowser({ headless: true });
    let fidelity = null;
    try {
      // same viewport as compare-clone.mjs (policy primary 1440×900) and DPR 1
      // so element rects map 1:1 onto screenshot px
      const p = await b.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
      await p.goto("file:///" + path.join(cloneDir, "index.html").replace(/\\/g, "/"), { waitUntil: "load", timeout: 30000 });
      await p.waitForTimeout(600);
      const cloneShot = await p.screenshot({ timeout: 20000 });
      const intel = await p.evaluate(DOM_EXTRACTOR_SCRIPT).catch(() => null);
      const cloneElements = intel && Array.isArray(intel.elements) ? intel.elements : [];
      fidelity = await analyzeFidelity(origPng, cloneShot, originalElements, cloneElements, { page: p });
    } finally {
      await b.close().catch(() => {});
    }
    return fidelity;
  } catch {
    return null; // measurement failure must not break verification — the repair loop treats null as unmeasurable
  }
}

// functionalScoreFile(projectDir) — repair-loop functional check (higher = better):
// share of data-cloner-trigger elements that a runtime record backs. File-only so
// the executor measures it before/after each dead-attribute prune without a
// browser round-trip; after a successful strip the score is exactly 1.
function functionalScoreFile(projectDir) {
  try {
    const html = fs.readFileSync(path.join(projectDir, "index.html"), "utf8");
    const { records } = parseRuntimeRecords(projectDir);
    const ids = new Set(records.map((r) => r.id));
    const triggers = [...html.matchAll(/data-cloner-trigger="(t\d+)"/g)].map((m) => m[1]);
    if (!triggers.length) return 1;
    return triggers.filter((t) => ids.has(t)).length / triggers.length;
  } catch (e) {
    throw new Error("functional score not measurable: " + String(e?.message || e).slice(0, 80));
  }
}

// repairAssetMap(artifactsDir, cloneDir) — url → clone-relative replacement path
// for asset-remap actions, built from the exploration's captured-assets entries
// (same url→localPath pairs the reconstruction pipeline's asset copy used).
function repairAssetMap(artifactsDir, cloneDir) {
  const map = {};
  try {
    const manifest = JSON.parse(fs.readFileSync(path.join(artifactsDir, "assets", "manifest.json"), "utf8"));
    const have = new Set();
    try { for (const f of fs.readdirSync(path.join(cloneDir, "public", "assets"))) have.add(f); } catch {}
    for (const e of manifest.capturedFromNetwork?.entries || []) {
      if (!e.url || !e.localPath) continue;
      const base = path.basename(e.localPath);
      if (have.has(base)) map[e.url] = "public/assets/" + base;
    }
  } catch {}
  return map;
}

export async function verifyTask(outDirPath, task = null, { wf: passedWf = null, logger: passedLogger = null } = {}) {
  // stage observability (log contract + viewer contract): the pipeline caller
  // passes the job's own logger + workflow emitter so the verification summary
  // lands in artifacts/<id>/logs/job.log next to the other stages and the
  // open-todo map stays shared; standalone callers get "-verify"-suffixed
  // defaults writing into the same job dir.
  const jobId = path.basename(outDirPath);
  const logger = passedLogger || createLogger({ jobId: jobId + "-verify", artifactsDir: outDirPath });
  const wf = passedWf || createWorkflowEmitter({ jobId });
  wf.stage("verification", "running", 0); // viewer: the stage has started
  const v2Clone = v2Layout(outDirPath);
  const rounds = [];
  let report = null;
  // G5.1 hunt fix: the round loop is now wall-clock bounded. Each round runs
  // three REAL-browser stages plus optional repair loops with fidelity
  // screenshots — on a loaded host one round can take several minutes, so the
  // old unbounded "up to MAX_ROUNDS" schedule left a clone in "verifying" for
  // 10+ minutes with no terminal state (reproduced: run 4's clone finished
  // exploration in 30s, then the poll exhausted while verification round 2+
  // was still cycling). The budget (CLONER_VERIFY_BUDGET_MS, default 8 min)
  // stops NEW rounds once spent; the round in flight always finishes so the
  // report is complete, and the result is an honest completed_with_limitations
  // instead of an endless pipeline.
  const verifyBudgetMs = Number(process.env.CLONER_VERIFY_BUDGET_MS || 8 * 60_000);
  const verifyDeadline = Date.now() + (Number.isFinite(verifyBudgetMs) && verifyBudgetMs > 0 ? verifyBudgetMs : 8 * 60_000);
  // flow-matrix verification runs right after the functional stage of round 1
  // (the matrix replays the RECORDED evidence, which repair rounds do not
  // change — once per verifyTask keeps the wall-clock budget honest). NON-FATAL
  // by contract: a matrix error lands in its own report field, never fails
  // verification; the full matrix goes to <artifacts>/reports/flow-matrix.json.
  let flowMatrix = null;
  for (let round = 1; round <= MAX_ROUNDS; round++) {
    // stage order per spec: 1 functional → 2 optimization/completeness → 3 visual
    const s1 = await stage1Functional(v2Clone || outDirPath);
    if (round === 1) {
      try {
        flowMatrix = await runFlowMatrix(v2Clone || outDirPath, outDirPath);
      } catch (e) {
        flowMatrix = { flows: [], bugs: [], error: e.message.slice(0, 140) };
      }
      // flow-matrix todos (viewer contract): one todo per replayed flow, closed
      // with the honest per-flow result as soon as the matrix returns — the
      // matrix builds AND replays internally (verify-flows.js is the live
      // boundary), so the add/done pair at this boundary carries each flow's
      // measured outcome rather than an invented one
      for (const flow of flowMatrix.flows || []) {
        const todoId = wf.todoAdd(`verify:${flow.id}`, `${flow.id} ${flow.page || ""}`.trim(), "flow");
        const cases = flow.cases || [];
        const failed = cases.filter((c) => c.result !== "pass").length;
        wf.todoDone(todoId, failed ? `${failed}/${cases.length} flow cases failed` : null);
      }
    }
    const s2 = await stage2Optimization(v2Clone || outDirPath, task, v2Clone ? outDirPath : null);
    const s3 = await stage3Visual(v2Clone || outDirPath, v2Clone ? outDirPath : null);
    report = {
      generatedAt: new Date().toISOString(),
      round,
      stages: [s1, s2, s3],
      passed: s1.passed && s2.passed && s3.passed,
      layout: v2Clone ? "v2" : "v1",
    };
    rounds.push({ round, passed: report.passed, failed: report.stages.filter((s) => !s.passed).map((s) => s.stage) });
    if (report.passed || round === MAX_ROUNDS) break;
    if (Date.now() >= verifyDeadline) {
      report.limitations = (report.limitations || []).concat([`verification stopped at the ${Math.round(verifyBudgetMs / 1000)}s wall-clock budget after round ${round}`]);
      report.fixes = (report.fixes || []).concat([`round ${round}: verification budget exhausted — remaining rounds skipped`]);
      break;
    }
    const fixes = autoRemediate(report, v2Clone || outDirPath, outDirPath);
    if (fixes.length) {
      report.fixes = (report.fixes || []).concat(fixes.map((f) => `round ${round}: ${f}`));
    } else {
      // task 3.4.5: autonomous repair loop — autoRemediate had nothing bounded to
      // offer, so classify 3.4.3 fidelity defects and apply measured repairs
      // (snapshot → apply → re-measure the RELEVANT check → keep if improved,
      // else byte-for-byte rollback). With no defects and no dead triggers the
      // plan is empty and improved=false — exactly the old break behavior.
      const cloneDir = v2Clone || outDirPath;
      const fidelityReport = await measureFidelity(cloneDir, outDirPath);
      // layout defect detections (layout-analyzer buildDetections) join the
      // plan alongside the pixel classifier's: run 1 of exp-mw59a16doczk
      // measured a page-level horizontal overflow (+4054px scrollWidth) and a
      // transparent header band that classifyDefects cannot express — the
      // detections existed but this loop never called the analyzer, so
      // planRepairs only ever saw pixel/element defects and applied 0 repairs.
      // Non-fatal: analyzer errors degrade to classifier defects only.
      const layoutDetections = await analyzeLayoutDefects(outDirPath, cloneDir)
        .then((r) => (Array.isArray(r?.defects) ? r.defects : []))
        .catch(() => []);
      const repair = await runRepairLoop(report, cloneDir, {
        defects: [
          ...(fidelityReport ? classifyDefects(fidelityReport) : []),
          ...layoutDetections,
        ],
        checkFns: {
          fidelity: async (projectDir) => {
            const f = await measureFidelity(projectDir, outDirPath);
            if (!f) throw new Error("fidelity not measurable (missing original screenshot/dom evidence)");
            return f.pixel.similarityPct;
          },
          functional: functionalScoreFile,
        },
        assetMap: repairAssetMap(outDirPath, cloneDir),
      });
      report.fixes = (report.fixes || []).concat(repair.applied.map((r) => `round ${round}: repair ${r.action.kind} ${r.action.target} — ${r.reason}`));
      report.repairLoop = {
        stopped: repair.stopped,
        baseline: repair.overall.baseline,
        final: repair.overall.final,
        improved: repair.improved,
        applied: repair.applied.length,
        reverted: repair.reverted.length,
        pending: repair.pending.length,
        unverifiable: repair.unverifiable.length,
      };
      if (!repair.improved) break;
    }
  }
  report.rounds = rounds;
  // flow-matrix result lands in the verification report as a summary — the full
  // numbered matrix (flows/cases/bugs + screenshots) lives in reports/flow-matrix.json
  report.flowMatrix = flowMatrix ? {
    total: flowMatrix.flows.reduce((n, f) => n + f.cases.length, 0),
    passed: flowMatrix.flows.reduce((n, f) => n + f.cases.filter((c) => c.result === "pass").length, 0),
    failed: flowMatrix.flows.reduce((n, f) => n + f.cases.filter((c) => c.result === "fail").length, 0),
    bugs: flowMatrix.bugs.length,
    note: flowMatrix.note || null,
    error: flowMatrix.error || null,
    report: flowMatrix.reportFile || "reports/flow-matrix.json",
  } : null;
  fs.mkdirSync(path.join(outDirPath, "_reference"), { recursive: true });
  fs.writeFileSync(path.join(outDirPath, "_reference", "verification.json"), JSON.stringify(report, null, 2));
  // stage summary (log contract): exactly one per stageId — emitted here, after
  // every fallible step (the report write included), so a crash above leaves the
  // failure summary to the caller's catch path and one stage never prints twice
  logger.stage("verification", report.passed ? "completed" : "failed", {
    rounds: report.rounds?.length,
    stages_failed: (report.stages || []).filter((s) => !s.passed).length,
    flows_passed: report.flowMatrix?.passed,
    flows_failed: report.flowMatrix?.failed,
    bugs: report.flowMatrix?.bugs,
    fixes: (report.fixes || []).length,
  });
  wf.stage("verification", report.passed ? "completed" : "failed", 1);
  return report;
}
