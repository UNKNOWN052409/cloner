#!/usr/bin/env node
// Fix-2 e2e probe: lazy-scroll fixture (real PNGs) → exploration → reconstruction →
// assert generated <img src> points at copied public/assets files that exist on disk.
process.env.CLONER_ALLOW_PRIVATE_TARGETS = "1"; // G5.3 SSRF guard: loopback fixture targets — documented opt-in (production default stays strict)
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PROJECT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
process.chdir(PROJECT);
const { lazyScrollSite } = await import("../scripts/fixtures/index.mjs");
const { startFixtureServer } = await import("../scripts/fixtures/server.mjs");
const { runExplorationJob } = await import("../src/pipeline/exploration-pipeline.js");
const { reconstructFromArtifacts } = await import("../src/reconstruction/reconstruction-pipeline.js");

const results = [];
const check = (name, ok, detail = "") => {
  results.push(ok);
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
};

const { base, close } = await startFixtureServer(lazyScrollSite);
try {
  const { artifactsDir } = await runExplorationJob({ url: base + "/", artifactsRoot: "artifacts" });
  check("exploration completed", fs.existsSync(path.join(artifactsDir, "manifest.json")));

  const res = await reconstructFromArtifacts(artifactsDir, { outDir: artifactsDir + "-project" });
  check("reconstruction ok", res.ok, `rounds=${res.report.rounds.length} repairs=${res.report.repairs.length}`);

  const projDir = artifactsDir + "-project";
  const html = fs.readFileSync(path.join(projDir, "index.html"), "utf8");
  const srcs = [...html.matchAll(/<img [^>]*src="([^"]+)"/g)].map((m) => m[1]);
  const locals = srcs.filter((s) => s.startsWith("public/assets/"));
  check("imgs emitted with local asset src", srcs.length > 0 && locals.length > 0,
    `${srcs.length} imgs, ${locals.length} local`);
  const missing = locals.filter((s) => !fs.existsSync(path.join(projDir, s)));
  check("all local img srcs exist on disk", missing.length === 0,
    missing.length ? "missing: " + missing.join(", ") : locals.slice(0, 3).join(", "));
  const copied = fs.readdirSync(path.join(projDir, "public", "assets"));
  check("public/assets populated", copied.length >= locals.length, `${copied.length} files: ${copied.slice(0, 4).join(", ")}`);
} catch (e) {
  check("no unexpected crash", false, String(e?.stack || e).split("\n").slice(0, 3).join(" | "));
} finally {
  await close();
}
const fails = results.filter((r) => !r).length;
console.log(`\n${fails ? "RESULT: FAIL" : "RESULT: PASS"}  (${results.length - fails}/${results.length})`);
process.exit(fails ? 1 : 0);
