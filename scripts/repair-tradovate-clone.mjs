// One-off: run the real repair loop over the production Tradovate clone,
// then re-verify visually. Usage: node scripts/repair-tradovate-clone.mjs
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const artifactId = process.argv[2] || "exp-mw1it7ifdb15";
const v2Dir = path.join(root, "artifacts", artifactId);
const projectDir = v2Dir + "-project";

const { runRepairLoop } = await import("../src/reconstruction/repair-executor.js");

// Build the fidelity report input from the captured verification data
const verifyPath = path.join(v2Dir, "_reference", "verification.json");
const verify = fs.existsSync(verifyPath) ? JSON.parse(fs.readFileSync(verifyPath, "utf8")) : {};
const report = verify.fidelity || verify || {};

console.log("Running repair loop on", projectDir);
const repair = await runRepairLoop(report, projectDir, {
  maxRounds: 3,
  onRound: (r, actions) => console.log(`round ${r}: ${actions.length} repair action(s)`),
});
console.log("repair loop result:", JSON.stringify(repair).slice(0, 500));
