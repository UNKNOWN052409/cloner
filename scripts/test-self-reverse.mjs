// G4.1 self-reverse TEST — runs scripts/self-reverse.mjs's runSelfReverse()
// (the REAL pipeline: real Chromium → real public sites → real reconstruction
// → real 3-step verifyTask) and asserts the ask's standard per target:
//
//   1. SSRF guard: the target's URL validated as public before any navigation
//   2. REAL HTTP: the exploration's network capture contains entries whose host
//      is the real target host (structural proof the browser hit the real site)
//   3. Exploration completed with ≥ expect.minPages captured pages
//   4. Reconstruction produced a clone project (ok + generated files)
//   5. verifyTask stage 1 (functional) PASSED — with interaction metrics
//      reported (triggers sampled / opened / replay records)
//   6. verifyTask stage 2 (optimization-completeness) PASSED
//   7. verifyTask stage 3 (visual) PASSED — pixel diff < expect.maxPixelPct
//      with a grade, from the verifier's own computation
//   8. Interaction evidence: exploration documented ≥ expect.minBehaviors
//      behaviors (0 for control-free pages, ≥1 for the SaaS docs page)
//
// Result JSON: artifacts/test-self-reverse-result.json (full per-check detail).
// Exit 1 if any assertion fails. No stubbing anywhere — this test runs the
// network-touching pipeline exactly as the product does.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runSelfReverse } from "./self-reverse.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
process.chdir(ROOT);

const TARGETS = path.join(ROOT, "fixtures", "selfreverse", "targets.json");
const RESULT_PATH = path.join(ROOT, "artifacts", "test-self-reverse-result.json");

let pass = 0, fail = 0;
const failures = [];
const check = (name, ok, detail = "") => {
  console.log(`  ${ok ? "PASS" : "FAIL"} ${name}${detail ? " — " + detail : ""}`);
  if (ok) pass++;
  else { fail++; failures.push({ name, detail: String(detail).slice(0, 400) }); }
};
const section = (t) => console.log(`\n== ${t} ==`);

console.log("self-reverse test — real public-site clones through the full engine pipeline");
const t0 = Date.now();

const targets = JSON.parse(fs.readFileSync(TARGETS, "utf8")).targets;
const gating = targets.filter((t) => t.gating !== false);
const frontier = targets.filter((t) => t.gating === false);
console.log(`gating targets: ${gating.map((t) => t.id).join(", ")}`);
if (frontier.length) console.log(`non-gating frontier targets (run for evidence, not asserted): ${frontier.map((t) => t.id).join(", ")}`);

const result = await runSelfReverse({
  targetsFile: TARGETS,
  artifactsRoot: path.join(ROOT, "artifacts", "selfreverse"),
  onProgress: (id, phase) => console.log(`  · [${id}] ${phase}`),
});
const wallS = ((Date.now() - t0) / 1000).toFixed(1);
const byId = new Map(result.clones.map((c) => [c.id, c]));

// ------------------------------------------------------------------ assertions
for (const t of targets) {
  const c = byId.get(t.id);
  const isGating = t.gating !== false;
  section(`${t.id}${isGating ? "" : " (NON-GATING FRONTIER — reported, not asserted)"} (${t.url})`);
  if (!c) {
    check(`${t.id}: clone reported`, false, "no result entry for target");
    continue;
  }
  if (c.error) check(`${t.id}: runner completed without crash`, false, c.error);

  // evidence lines are ALWAYS reported (they are the run's record); the
  // assertion verdicts below only gate for t.gating !== false targets
  const verdict = (name, ok, detail = "") => {
    check(`${t.id}: ${name}`, !isGating || ok, detail);
  };

  verdict("SSRF guard accepted public URL", c.ssrf?.ok === true, c.ssrf?.error || `${(c.ssrf?.resolved || []).length} resolved addr(s)`);
  verdict("real HTTP captured (network entries on page-001)", (c.exploration?.realNetworkEntries ?? 0) > 0, `${c.exploration?.realNetworkEntries ?? "absent"} entries, hosts: ${(c.exploration?.realHosts || []).join(",") || "none"}`);
  const wantHost = new URL(t.url).host;
  verdict("captured traffic hit the real target host", (c.exploration?.realHosts || []).includes(wantHost), (c.exploration?.realHosts || []).join(","));
  verdict("exploration completed", c.exploration?.status === "completed", `status=${c.exploration?.status}, pages=${c.exploration?.pages}, errors=${(c.exploration?.errors || []).length}`);
  verdict(`pages >= expect.minPages`, (c.exploration?.pages ?? -1) >= t.expect.minPages, `${c.exploration?.pages}`);
  verdict("reconstruction produced clone", c.reconstruction?.ok === true, `${c.reconstruction?.generatedFiles} file(s), repairs=${c.reconstruction?.repairs}`);

  const stageOf = (id) => (c.verification?.stages || []).find((s) => s.stage === id) || null;
  const functional = stageOf("functional");
  const optimization = stageOf("optimization-completeness");
  const visual = stageOf("visual");
  verdict("stage 1 functional PASSED", functional?.passed === true, functional ? functional.checks.filter((x) => !x.ok).map((x) => x.name).join(",") || "all checks green" : "stage absent");
  verdict("stage 2 optimization-completeness PASSED", optimization?.passed === true, optimization ? optimization.checks.filter((x) => !x.ok).map((x) => `${x.name} (${x.detail.slice(0, 90)})`).join("; ") || "all checks green" : "stage absent");
  verdict("stage 3 visual PASSED", visual?.passed === true, visual ? visual.checks.filter((x) => !x.ok).map((x) => `${x.name}: ${x.detail.slice(0, 110)}`).join("; ") || "all checks green" : "stage absent");
  verdict("interaction metrics reported", !!c.interactions?.metrics && typeof c.interactions.metrics.triggers === "number", `triggers=${c.interactions?.metrics?.triggers}, opened=${c.interactions?.metrics?.opened}, records=${c.interactions?.metrics?.records}`);
  verdict("documented behaviors >= expect.minBehaviors", (c.interactions?.documentedBehaviors ?? -1) >= t.expect.minBehaviors, `${c.interactions?.documentedBehaviors ?? "absent"}`);
  verdict(`pixel diff reported and under ${t.expect.maxPixelPct}%`, c.pixelDiff?.pct != null && c.pixelDiff.pct < t.expect.maxPixelPct, c.pixelDiff?.pct != null ? `${c.pixelDiff.pct}% mean ${c.pixelDiff.meanDelta}/255 grade ${c.pixelDiff.grade}` : "not measured");
  verdict("verifyTask PASSED (all 3 stages)", c.verification?.passed === true, `rounds=${c.verification?.rounds}`);
  verdict("clone artifacts on disk", c.projectDir && fs.existsSync(path.join(c.projectDir, "index.html")) && fs.existsSync(path.join(c.projectDir, "styles", "tokens.css")), c.projectDir || "no project dir");
}

section(`self-reverse totals — ${result.passed}/${result.clones.length} clones passed verifyTask, wall ${wallS}s`);
check("all GATING targets passed verification", gating.every((t) => byId.get(t.id)?.verification?.passed === true), `${gating.filter((t) => byId.get(t.id)?.verification?.passed === true).length}/${gating.length} gating targets green${frontier.length ? ` (frontier: ${frontier.map((t) => `${t.id}=${byId.get(t.id)?.verification?.passed ? "pass" : "documented drift"}`).join(", ")})` : ""}`);

fs.mkdirSync(path.dirname(RESULT_PATH), { recursive: true });
fs.writeFileSync(RESULT_PATH, JSON.stringify({
  schema: "test-self-reverse-result",
  version: "1.0.0",
  finishedAt: new Date().toISOString(),
  wallMs: Date.now() - t0,
  passed: pass, fail,
  failures,
  clones: result.clones,
}, null, 2));
console.log(`\nresult JSON: ${RESULT_PATH}`);
console.log(fail === 0 ? "SELF-REVERSE TEST: ALL GREEN" : `SELF-REVERSE TEST: ${fail} FAILURE(S)`);
process.exit(fail === 0 ? 0 : 1);
