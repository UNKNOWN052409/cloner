// G4.1 SELF-REVERSE — the engine's ultimate test.
//
// The engine clones REAL public sites through its OWN complete pipeline —
// explore (real Chromium against the real HTTP site) → reconstruct (the real
// reconstruction engine) → verifyTask (the real 3-stage verification loop:
// functional / optimization-completeness / visual). Nothing is stubbed, no
// remote-end simulator, no synthetic artifacts: product code paths call the
// REAL external endpoints the whole way through.
//
// Targets are DATA (fixtures/selfreverse/targets.json), never hard-coded here.
// Before any navigation each URL is validated through the SSRF guard
// (src/security/url-guard.js validatePublicUrl) — public URLs only; a target
// that fails the guard fails its clone immediately and the run continues with
// the rest.
//
// Per-clone report (also written to <artifacts>/selfreverse/<id>-result.json):
//   ssrf          validatePublicUrl verdict + resolved addresses
//   exploration   job status, pages, routes, documented behaviors, real
//                 network entries observed (proof of real HTTP), errors
//   reconstruction ok, generated files, repairs, limitations
//   verification  the full 3-stage report: every check name + ok + detail,
//                 pixel diff %/mean/grade, interaction replay metrics
//   artifactsDir  where the artifacts + clone project live
//
// CLI:   node scripts/self-reverse.mjs [--targets <file>] [--only id,id]
//                    [--artifacts <dir>] [--json <out>]
// API:   import { runSelfReverse } from this module (used by
//        scripts/test-self-reverse.mjs).
//
// Exit 0 always when run as CLI with `--no-fail`; without it, exit 1 if any
// clone failed its verification (useful for manual runs; the test harness uses
// the API form and applies its own assertions).
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { validatePublicUrl } from "../src/security/url-guard.js";
import { runExplorationJob } from "../src/pipeline/exploration-pipeline.js";
import { reconstructFromArtifacts } from "../src/reconstruction/reconstruction-pipeline.js";
import { verifyTask } from "../src/reconstruction/verify.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
process.chdir(ROOT); // verifyTask spawns scripts/compare-clone.mjs relative to cwd

// The self-reverse target set intentionally includes control-free public pages
// (example.com, httpbin.org/html). verify.js's stage-2 gate keeps the STRICT
// interaction requirement by default (real app clones must document behaviors +
// replay data); this runner opts out explicitly so control-free sources are
// verified honestly instead of structurally failing (see verify.js G4.1 branch:
// the pass is evidenced by manifest.pages[].records === 0 on every page).
process.env.CLONER_VERIFY_REQUIRE_INTERACTIONS = process.env.CLONER_VERIFY_REQUIRE_INTERACTIONS || "0";

const DEFAULT_TARGETS = path.join(ROOT, "fixtures", "selfreverse", "targets.json");
const DEFAULT_ARTIFACTS = path.join(ROOT, "artifacts", "selfreverse");

const rmrf = (p) => fs.rmSync(p, { recursive: true, force: true });

// pixel diff is parsed from the visual stage's own check detail (single source
// of truth — the number the verifier computed, never recomputed here)
export function parsePixelDiff(verification) {
  const visual = (verification?.stages || []).find((s) => s.stage === "visual");
  const chk = (visual?.checks || []).find((c) => c.name === "pixel difference");
  if (!chk) return { pct: null, meanDelta: null, grade: null };
  const m = String(chk.detail).match(/^([\d.]+)% \(threshold [\d.]+%\), mean delta ([\d.]+)\/255, grade: ([^)]+)\)?/);
  return m
    ? { pct: Number(m[1]), meanDelta: Number(m[2]), grade: m[3].trim() }
    : { pct: null, meanDelta: null, grade: null, raw: chk.detail.slice(0, 120) };
}

// exploration summary: honest absence for missing artifacts — never zeros for
// things that were not measured
function summarizeExploration(artifactsDir, manifest) {
  const summary = {
    status: manifest?.status || null,
    pages: manifest?.pages?.length ?? null,
    routesDiscovered: manifest?.discoveredRoutes ?? null,
    statesRecorded: manifest?.coverage?.statesRecorded ?? null,
    documentedBehaviors: null, // exploration.json behaviors (absent = null)
    realNetworkEntries: null,  // page-001 network.json (absent = null)
    realHosts: [],
    errors: (manifest?.errors || []).map((e) => e.message).slice(0, 5),
    warnings: (manifest?.warnings || []).map((w) => w.message).slice(0, 5),
  };
  try {
    const expl = JSON.parse(fs.readFileSync(path.join(artifactsDir, "exploration.json"), "utf8"));
    summary.documentedBehaviors = (expl.behaviors || []).length;
  } catch { /* control-free page: exploration.json legitimately absent */ }
  try {
    const net = JSON.parse(fs.readFileSync(path.join(artifactsDir, "pages", "page-001", "network.json"), "utf8"));
    const entries = net.entries || [];
    summary.realNetworkEntries = entries.length;
    summary.realHosts = [...new Set(entries.map((e) => { try { return new URL(e.url).host; } catch { return null; } }).filter(Boolean))].slice(0, 8);
  } catch { /* no network capture recorded */ }
  return summary;
}

// one clone, one target — the REAL pipeline, in order, with the honest outcome
export async function selfReverseOne(target, { artifactsRoot = DEFAULT_ARTIFACTS, onProgress = () => {} } = {}) {
  const t0 = Date.now();
  const report = {
    id: target.id,
    url: target.url,
    kind: target.kind || null,
    gating: target.gating !== false,
    ssrf: null,
    exploration: null,
    reconstruction: null,
    verification: null,
    pixelDiff: null,
    interactions: null,
    artifactsDir: null,
    projectDir: null,
    ok: false,
    wallMs: null,
  };

  // ---- SSRF gate (product guard; no navigation before it passes) ----
  onProgress(target.id, "ssrf-guard");
  const guard = await validatePublicUrl(target.url);
  report.ssrf = { ok: guard.ok, error: guard.error || null, resolved: guard.resolved || [] };
  if (!guard.ok) {
    report.wallMs = Date.now() - t0;
    return report;
  }

  const artifactsDir = path.join(artifactsRoot, `selfrev-${target.id}`);
  report.artifactsDir = artifactsDir;
  report.projectDir = artifactsDir + "-project";
  rmrf(artifactsDir);
  rmrf(report.projectDir);

  // ---- Stage 1: exploration (real browser, real HTTP) ----
  onProgress(target.id, "exploring");
  const exploration = await runExplorationJob({
    url: guard.url,
    config: { policy: { budgets: target.budgets || {} } },
    artifactsRoot,
    jobId: `selfrev-${target.id}`,
  });
  report.exploration = summarizeExploration(exploration.artifactsDir, exploration.manifest);

  // ---- Stage 2: reconstruction (real engine) ----
  onProgress(target.id, "reconstructing");
  const reconstruction = await reconstructFromArtifacts(exploration.artifactsDir, {
    outDir: exploration.artifactsDir + "-project",
    interactionRecords: [],
  });
  report.reconstruction = {
    ok: !!reconstruction.ok,
    generatedFiles: reconstruction.report?.generatedFiles ?? null,
    repairs: reconstruction.report?.repairs?.length ?? null,
    limitations: (reconstruction.report?.limitations || []).slice(0, 6),
  };

  // ---- Stage 3: verification (real 3-step verifyTask with auto-remediation) ----
  onProgress(target.id, "verifying");
  const verification = await verifyTask(exploration.artifactsDir);
  report.verification = {
    passed: !!verification.passed,
    rounds: verification.rounds?.length ?? null,
    layout: verification.layout || null,
    stages: (verification.stages || []).map((s) => ({
      stage: s.stage,
      passed: !!s.passed,
      checks: (s.checks || []).map((c) => ({ name: c.name, ok: !!c.ok, detail: String(c.detail || "").slice(0, 220) })),
    })),
  };
  report.pixelDiff = parsePixelDiff(verification);
  const functional = (verification.stages || []).find((s) => s.stage === "functional");
  report.interactions = {
    metrics: functional?.metrics || {},
    documentedBehaviors: report.exploration?.documentedBehaviors ?? 0,
  };

  report.ok = !!verification.passed;
  report.wallMs = Date.now() - t0;
  onProgress(target.id, report.ok ? "passed" : "failed");
  return report;
}

// all targets, sequential (one Chromium at a time keeps the runs deterministic
// and the machine sane); a crashed target is caught and reported, not fatal
export async function runSelfReverse({ targetsFile = DEFAULT_TARGETS, only = null, artifactsRoot = DEFAULT_ARTIFACTS, onProgress = () => {} } = {}) {
  const def = JSON.parse(fs.readFileSync(targetsFile, "utf8"));
  let targets = def.targets || [];
  if (only) {
    const wanted = new Set(String(only).split(",").map((s) => s.trim()).filter(Boolean));
    targets = targets.filter((t) => wanted.has(t.id));
  }
  const startedAt = new Date().toISOString();
  const clones = [];
  for (const target of targets) {
    try {
      clones.push(await selfReverseOne(target, { artifactsRoot, onProgress }));
    } catch (e) {
      // a crashed clone is an honest failed result — the run continues
      clones.push({
        id: target.id, url: target.url, kind: target.kind || null, gating: target.gating !== false,
        ssrf: null, exploration: null, reconstruction: null, verification: null,
        pixelDiff: null, interactions: null, artifactsDir: null, projectDir: null,
        ok: false, error: String(e?.message || e).slice(0, 300), wallMs: null,
      });
      onProgress(target.id, "crashed");
    }
  }
  return {
    schema: "selfreverse-results",
    version: "1.0.0",
    startedAt,
    finishedAt: new Date().toISOString(),
    targetsFile,
    passed: clones.filter((c) => c.ok).length,
    failed: clones.filter((c) => !c.ok).length,
    clones,
  };
}

// ------------------------------------------------------------------ CLI
const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const args = process.argv.slice(2);
  const flag = (name) => { const i = args.indexOf("--" + name); return i >= 0 ? args[i + 1] : null; };
  const targetsFile = flag("targets") || DEFAULT_TARGETS;
  const artifactsRoot = flag("artifacts") || DEFAULT_ARTIFACTS;
  const jsonOut = flag("json") || path.join(artifactsRoot, "results.json");
  const only = flag("only");
  const noFail = args.includes("--no-fail");

  console.log(`self-reverse — targets: ${targetsFile}`);
  const result = await runSelfReverse({
    targetsFile, artifactsRoot, only,
    onProgress: (id, phase) => console.log(`  [${id}] ${phase}`),
  });

  fs.mkdirSync(path.dirname(jsonOut), { recursive: true });
  fs.writeFileSync(jsonOut, JSON.stringify(result, null, 2));
  // per-clone files too — one artifact each, easy to publish
  for (const c of result.clones) {
    if (c.artifactsDir) {
      const p = path.join(c.artifactsDir, "selfreverse-result.json");
      try { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, JSON.stringify(c, null, 2)); } catch {}
    }
  }

  console.log(`\n== self-reverse summary (${result.passed}/${result.clones.length} passed) ==`);
  for (const c of result.clones) {
    const stages = (c.verification?.stages || []).map((s) => `${s.stage}:${s.passed ? "PASS" : "FAIL"}`).join(" ") || "n/a";
    const px = c.pixelDiff?.pct != null ? `${c.pixelDiff.pct}% (grade ${c.pixelDiff.grade})` : "n/a";
    const fx = c.interactions?.metrics ? `triggers ${c.interactions.metrics.triggers ?? 0}, opened ${c.interactions.metrics.opened ?? 0}` : "n/a";
    console.log(`  ${c.ok ? "PASS" : "FAIL"} ${c.id} (${c.url}) — wall ${(c.wallMs / 1000).toFixed(1)}s`);
    console.log(`       ssrf: ${c.ssrf?.ok ? "ok (public)" : "BLOCKED: " + c.ssrf?.error} · exploration: ${c.exploration?.status || "n/a"}, ${c.exploration?.pages ?? "?"} page(s), behaviors ${c.exploration?.documentedBehaviors ?? "absent"} · reconstruction: ${c.reconstruction ? (c.reconstruction.ok ? "ok" : "limited") : "n/a"} (${c.reconstruction?.generatedFiles ?? "?"} files)`);
    console.log(`       stages: ${stages} · pixel diff: ${px} · interactions: ${fx}`);
    for (const s of c.verification?.stages || []) {
      for (const k of s.checks.filter((x) => !x.ok)) console.log(`       [FAIL] ${s.stage}/${k.name} — ${k.detail}`);
    }
  }
  console.log(`\nresults: ${jsonOut}`);
  process.exit(noFail || result.failed === 0 ? 0 : 1);
}
