#!/usr/bin/env node
// Tradovate live clone via the v2 pipeline (final-gate test driver).
// Prereq: node scripts/tradovate-login.mjs has run (exports output/tradovate-cookies.json
// + output/tradovate-storage.json). This script runs exploration → reconstruction →
// verification against the live Tradovate workspace and prints a compact verdict.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

process.chdir(path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."));

const cookiesFile = "output/tradovate-cookies.json";
const storageFile = "output/tradovate-storage.json";
const URL_DEFAULT = "https://demo.tradovate.com/trading";
const url = process.argv[2] || URL_DEFAULT;

if (!fs.existsSync(cookiesFile)) {
  console.error("no session export found — run: node scripts/tradovate-login.mjs");
  process.exit(3);
}

const { runExplorationJob } = await import("../src/pipeline/exploration-pipeline.js");
const { reconstructFromArtifacts } = await import("../src/reconstruction/reconstruction-pipeline.js");
const { verifyTask } = await import("../src/platform/verify.js");

const t0 = Date.now();
console.log("[1/3] exploring", url, "…");
const { jobId, artifactsDir, manifest } = await runExplorationJob({
  url,
  cookiesFile,
  storage: JSON.parse(fs.readFileSync(storageFile, "utf8")),
  artifactsRoot: "artifacts",
  config: { policy: { budgets: { maxTotalTimeMs: 240000 } } },
});
console.log("  exploration:", manifest.status, "| pages:", manifest.pages?.length, "| routes:", manifest.discoveredRoutes, "| states:", manifest.discoveredStates);

console.log("[2/3] reconstructing …");
const recon = await reconstructFromArtifacts(artifactsDir, { outDir: artifactsDir + "-project" });
console.log("  reconstruction:", recon.ok ? "OK" : "LIMITED", "| files:", recon.report.generatedFiles, "| repairs:", recon.report.repairs.length);

console.log("[3/3] verifying …");
const v = await verifyTask(artifactsDir);
const stages = (v.stages || []).map((s) => `${s.stage}:${s.passed ? "PASS" : "FAIL"}`).join(" ");
console.log("  verification:", v.passed ? "PASSED" : "FAILED", "—", stages);

const visual = v.stages?.find((s) => s.stage === "visual");
const pix = visual?.checks?.find((c) => c.name === "pixel difference")?.detail || "n/a";
console.log("  pixel diff:", String(pix).slice(0, 100));

const mins = ((Date.now() - t0) / 60000).toFixed(1);
const ok = v.passed && recon.ok;
console.log(`\nTRADOVATE CLONE ${ok ? "VERDICT: SUCCESS" : "VERDICT: WITH LIMITATIONS"} — ${mins}min total, artifacts: ${artifactsDir}`);
process.exit(ok ? 0 : 1);
