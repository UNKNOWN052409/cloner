// Deterministic gate for the architectural-realignment spec:
// exit 0 = all ten required section headings present.
const fs = require("node:fs");
const specPath = "docs/realignment/IMPLEMENTATION-SPEC.md";
let text;
try {
  text = fs.readFileSync(specPath, "utf8").toLowerCase();
} catch {
  console.error("GATE-FAIL: spec not found at " + specPath);
  process.exit(1);
}
const required = [
  "1. actual existing frontend routes",
  "2. actual backend modules",
  "3. missing or disconnected components",
  "4. required architecture changes",
  "5. database and artifact contracts",
  "6. parallel agent task assignments",
  "7. file ownership and dependency mapping",
  "8. end-to-end acceptance tests",
  "9. execution order and integration gates",
  "10. evidence-based completion",
];
const missing = required.filter((s) => !text.includes(s));
if (missing.length) {
  console.error("GATE-FAIL missing sections: " + missing.join(" | "));
  process.exit(1);
}
console.log(
  "GATE-PASS: all 10 required sections present (" + text.split("\n").length + " lines)",
);
