#!/usr/bin/env node
process.env.CLONER_ALLOW_PRIVATE_TARGETS = "1"; // G5.3 SSRF guard: loopback fixture target — documented opt-in (production default stays strict)
// Offline tests for the audited remainders (engine code only, no external sites):
//
//   a. paused-path redaction — the MFA auth fixture (fixtures/auth-site, mode
//      "mfa") runs through the REAL pipeline (runExplorationJob) and pauses on
//      the human-required path; the paused-path reports must carry no
//      credential values (the fixture username/password appear nowhere in
//      reports/exploration-summary.json, reports/failures.json or manifest.json)
//      and the resolved budgets must show the raised defaults in the manifest.
//   b. exploration policy budgets — resolvePolicy() defaults show the raised
//      numbers (30 routes / 900000 ms); CLONER_PROFILE=compact keeps the
//      previous numbers (12 / 600000) via its preset while everything else
//      stays at the shared defaults; explicit userPolicy.budgets still win and
//      DEFAULT_POLICY is never mutated across calls.
//   c. cloneImage stitch guard — provider "stitch" passes the key guard when
//      ONLY STITCH_API_KEY is set (env) or ONLY model.apiKey is set (config),
//      mirroring hasVision() in src/vision.js; stitch without any key and
//      provider "none" are still rejected with messages naming the right keys.
//      The pass cases use a nonexistent image path so the real guard is proven
//      by reaching copyFileSync (ENOENT) — no network is ever touched.
//
// Fully offline: one 127.0.0.1 ephemeral fixture server + Playwright chromium
// for the auth hook; the artifact tree goes under a mkdtemp temp dir.
//
// Run: node scripts/test-remainders.mjs   (exit 1 on any failure)
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { startAuthFixture } from "../fixtures/auth-site/index.mjs";
import { runExplorationJob } from "../src/pipeline/exploration-pipeline.js";
import { resolvePolicy, DEFAULT_POLICY } from "../src/exploration/exploration-policy.js";
import { cloneImage } from "../src/cloneImage.js";

// the credential values handed to the fixture — the assertions grep for these
const USERNAME = "remainder-user";
const PASSWORD = "R3m@inder!pass9";

const results = [];
async function check(name, fn) {
  try {
    await fn();
    results.push({ name, ok: true });
    console.log("  [PASS]", name);
  } catch (err) {
    results.push({ name, ok: false, err });
    console.error("  [FAIL]", name, "--", err && err.message ? err.message : String(err));
  }
}

// ---- a. paused-path redaction (real pipeline, offline MFA fixture) ----
async function partA() {
  console.log("\npart a: paused-path redaction (mfa fixture → runExplorationJob)");
  const profileSaved = process.env.CLONER_PROFILE;
  delete process.env.CLONER_PROFILE; // defaults under test
  const fx = await startAuthFixture({ mode: "mfa", username: USERNAME, password: PASSWORD });
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "remainders-paused-"));
  try {
    let res = null;
    await check("pipeline pauses with status paused-human-required", async () => {
      res = await runExplorationJob({ url: fx.base + "/login", username: USERNAME, password: PASSWORD, artifactsRoot: tmp });
      assert.equal(res.manifest.status, "paused-human-required", "got status " + res.manifest.status);
      assert.equal(res.manifest.auth?.status, "human-required");
    });
    await check("exploration-summary.json contains no credential values", async () => {
      const file = path.join(res.artifactsDir, "reports/exploration-summary.json");
      const text = fs.readFileSync(file, "utf8");
      assert.ok(!text.includes(USERNAME), "username leaked into exploration-summary.json");
      assert.ok(!text.includes(PASSWORD), "password leaked into exploration-summary.json");
      const j = JSON.parse(text);
      assert.equal(j.status, "paused-human-required");
      assert.ok(Array.isArray(j.errors) && Array.isArray(j.warnings));
    });
    await check("failures.json contains no credential values", async () => {
      const file = path.join(res.artifactsDir, "reports/failures.json");
      const text = fs.readFileSync(file, "utf8");
      assert.ok(!text.includes(USERNAME), "username leaked into failures.json");
      assert.ok(!text.includes(PASSWORD), "password leaked into failures.json");
      JSON.parse(text); // still valid JSON
    });
    await check("manifest.json contains no credential values either", async () => {
      const file = path.join(res.artifactsDir, "manifest.json");
      const text = fs.readFileSync(file, "utf8");
      assert.ok(!text.includes(USERNAME), "username leaked into manifest.json");
      assert.ok(!text.includes(PASSWORD), "password leaked into manifest.json");
    });
    await check("resolved raised budgets land in the paused manifest", async () => {
      const b = res.manifest.configuration?.budgets || {};
      assert.equal(b.maxRoutes, 30, "maxRoutes " + JSON.stringify(b));
      assert.equal(b.maxTotalTimeMs, 900000, "maxTotalTimeMs " + JSON.stringify(b));
    });
    await check("fixture mfa step was never submitted (needs human, not bypassed)", async () => {
      const hit = fx.requests.some((r) => r.method === "POST" && r.path === "/login/mfa");
      assert.equal(hit, false, "the pipeline submitted the MFA step form");
    });
  } finally {
    await fx.close().catch(() => {});
    fs.rmSync(tmp, { recursive: true, force: true });
    if (profileSaved === undefined) delete process.env.CLONER_PROFILE;
    else process.env.CLONER_PROFILE = profileSaved;
  }
}

// ---- b. policy defaults + compact preset ----
async function partB() {
  console.log("\npart b: exploration policy budgets");
  const profileSaved = process.env.CLONER_PROFILE;
  try {
    await check("default budgets show the raised numbers (30 routes / 900000 ms)", async () => {
      delete process.env.CLONER_PROFILE;
      const p = resolvePolicy({});
      assert.equal(p.budgets.maxRoutes, 30, "maxRoutes " + p.budgets.maxRoutes);
      assert.equal(p.budgets.maxTotalTimeMs, 900000, "maxTotalTimeMs " + p.budgets.maxTotalTimeMs);
    });
    await check("CLONER_PROFILE=compact keeps the previous numbers (12 / 600000)", async () => {
      process.env.CLONER_PROFILE = "compact";
      const p = resolvePolicy({});
      assert.equal(p.budgets.maxRoutes, 12, "maxRoutes " + p.budgets.maxRoutes);
      assert.equal(p.budgets.maxTotalTimeMs, 600000, "maxTotalTimeMs " + p.budgets.maxTotalTimeMs);
    });
    await check("compact preset only overrides the two raised knobs (rest unchanged)", async () => {
      process.env.CLONER_PROFILE = "compact";
      const p = resolvePolicy({});
      assert.equal(p.budgets.maxStatesPerPage, DEFAULT_POLICY.budgets.maxStatesPerPage);
      assert.equal(p.budgets.maxTimePerPageMs, DEFAULT_POLICY.budgets.maxTimePerPageMs);
      assert.equal(p.budgets.maxInteractionsPerState, DEFAULT_POLICY.budgets.maxInteractionsPerState);
    });
    await check("explicit userPolicy.budgets beats the compact preset", async () => {
      process.env.CLONER_PROFILE = "compact";
      const p = resolvePolicy({ budgets: { maxRoutes: 5 } });
      assert.equal(p.budgets.maxRoutes, 5, "maxRoutes " + p.budgets.maxRoutes);
      assert.equal(p.budgets.maxTotalTimeMs, 600000, "maxTotalTimeMs " + p.budgets.maxTotalTimeMs);
    });
    await check("DEFAULT_POLICY is not mutated across resolvePolicy calls", async () => {
      process.env.CLONER_PROFILE = "compact";
      resolvePolicy({ budgets: { maxRoutes: 5 } });
      delete process.env.CLONER_PROFILE;
      const p = resolvePolicy({});
      assert.equal(DEFAULT_POLICY.budgets.maxRoutes, 30, "DEFAULT_POLICY mutated: " + DEFAULT_POLICY.budgets.maxRoutes);
      assert.equal(p.budgets.maxRoutes, 30, "second default call " + p.budgets.maxRoutes);
    });
  } finally {
    if (profileSaved === undefined) delete process.env.CLONER_PROFILE;
    else process.env.CLONER_PROFILE = profileSaved;
  }
}

// ---- c. cloneImage stitch guard (offline — pass cases stop at copyFileSync ENOENT) ----
async function partC() {
  console.log("\npart c: cloneImage stitch key guard");
  const keySaved = process.env.STITCH_API_KEY;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "remainders-cloneimg-"));
  const missingImg = path.join(tmp, "does-not-exist.png"); // guard passes → ENOENT at copyFileSync
  const outDir = path.join(tmp, "out");
  try {
    await check("stitch + ONLY STITCH_API_KEY env passes the guard", async () => {
      process.env.STITCH_API_KEY = "st-remainder-test";
      await assert.rejects(
        () => cloneImage(missingImg, { model: { provider: "stitch" } }, outDir),
        (e) => /ENOENT/.test(e.message) && !/vision model/.test(e.message) && !/requires STITCH_API_KEY/.test(e.message),
        "expected the copyFileSync ENOENT (guard passed), got a guard/config error instead"
      );
    });
    await check("stitch + ONLY model.apiKey in config passes the guard too", async () => {
      delete process.env.STITCH_API_KEY;
      await assert.rejects(
        () => cloneImage(missingImg, { model: { provider: "stitch", apiKey: "cfg-key" } }, outDir),
        (e) => /ENOENT/.test(e.message) && !/vision model/.test(e.message) && !/requires STITCH_API_KEY/.test(e.message),
        "expected the copyFileSync ENOENT (guard passed), got a guard/config error instead"
      );
    });
    await check("stitch with NO key anywhere is rejected, naming STITCH_API_KEY", async () => {
      delete process.env.STITCH_API_KEY;
      await assert.rejects(
        () => cloneImage(missingImg, { model: { provider: "stitch" } }, outDir),
        (e) => /STITCH_API_KEY/.test(e.message),
        "expected the STITCH_API_KEY config error"
      );
    });
    await check('provider "none" is still rejected', async () => {
      process.env.STITCH_API_KEY = "st-remainder-test"; // even with a stitch key present
      await assert.rejects(
        () => cloneImage(missingImg, { model: { provider: "none" } }, outDir),
        (e) => /vision model/.test(e.message),
        "expected the vision-model config error"
      );
    });
  } finally {
    if (keySaved === undefined) delete process.env.STITCH_API_KEY;
    else process.env.STITCH_API_KEY = keySaved;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

async function main() {
  await partA();
  await partB();
  await partC();
  const pass = results.filter((r) => r.ok).length;
  const fail = results.length - pass;
  console.log(`\n=== remainders test: ${pass} PASS / ${fail} FAIL (of ${results.length}) ===`);
  if (fail > 0) process.exit(1);
}

main().catch((err) => {
  console.error("test-remainders fatal:", err);
  process.exit(1);
});
