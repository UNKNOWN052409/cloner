#!/usr/bin/env node
// 4.5.6 completeness-audit-engine — engine test (docs/COMPLETENESS-AUDIT.md).
//
// Proves, with real runs:
//   1. SENSITIVITY — every seeded violation in fixtures/completeness-audit/
//      is caught with the right category, severity, file AND line; nothing
//      seeded as legal (mocks under test/, wired exports, clean prose) fires.
//   2. EXIT-CODE SEMANTICS — criticals → exit 1; warnings+infos only → exit 0;
//      clean fixture → exit 0 with zero findings (CLI child-process runs).
//   3. REAL REPO — the engine scans this repository, writes
//      output/completeness-report.md (+ .json), markdown counts match the JSON,
//      and the process exit code equals (criticals > 0).
//
// No database, no network, no credentials. Exits 1 if any check fails.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const PROJECT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SCANNER = path.join(PROJECT, "scripts", "audit-completeness.mjs");
const FIXTURES = path.join(PROJECT, "fixtures", "completeness-audit");

const results = [];
const check = (name, ok, detail = "") => { results.push(ok); console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`); };
const watchdog = setTimeout(() => { console.log("FAIL  global timeout (120s)"); process.exit(1); }, 120_000);
watchdog.unref?.();

const { scan, renderMarkdown, maskCommentsAndStrings, maskStringsOnly } =
  await import("../scripts/audit-completeness.mjs");

function runCli(args) {
  return spawnSync(process.execPath, [SCANNER, ...args], { encoding: "utf8", cwd: PROJECT });
}

function findingsFor(report, { file, category, severity, line }) {
  return report.findings.filter((f) =>
    (!file || f.file === file) &&
    (!category || f.category === category) &&
    (!severity || f.severity === severity) &&
    (line === undefined || f.line === line));
}

// ── masking invariants (position preservation is what makes lines truthful) ──
const maskSample = [
  'const a = "str with // not a comment";',
  "// real comment: TODO here",
  "const t = `tpl ${1 + 1} end`;",
  "function f() { return 1; }",
].join("\n");
const m1 = maskCommentsAndStrings(maskSample);
const m2 = maskStringsOnly(maskSample);
check("masking preserves positions/newlines",
  m1.length === maskSample.length && m1.split("\n").length === 4 && m2.split("\n").length === 4);
check("maskCommentsAndStrings hides strings+comments, keeps code",
  m1.includes("const a =") && m1.includes("function f() { return 1; }") &&
  m1.includes("1 + 1") && !m1.includes("str with") && !m1.includes("TODO here"));
check("maskStringsOnly keeps comments but hides strings",
  m2.includes("// real comment: TODO here") && !m2.includes("str with"));

// ── 1. sensitivity: critical fixture — every seed caught ────────────────────
const crit = scan(path.join(FIXTURES, "critical"));

const SEEDS = [
  { name: "mock import in product path caught", file: "src/billing-stub.js", category: "mock-in-product", severity: "critical", line: 3 },
  { name: "TODO in product code caught (critical)", file: "src/billing-stub.js", category: "todo-marker", severity: "critical", line: 8 },
  { name: "HACK annotation caught (warning)", file: "src/billing-stub.js", category: "marker", severity: "warning", line: 10 },
  { name: "not-implemented throw caught (critical)", file: "src/billing-stub.js", category: "not-implemented", severity: "critical", line: 14 },
  { name: "stub return caught (critical)", file: "src/billing-stub.js", category: "stub-return", severity: "critical", line: 20 },
  { name: "unwired export neverWiredHook caught", file: "src/billing-stub.js", category: "unwired-export", severity: "warning", snippet: "neverWiredHook" },
  { name: "unwired export neverWiredHook2 caught", file: "src/hooks.js", category: "unwired-export", severity: "warning", snippet: "neverWiredHook2" },
  { name: "unwired export legacyHandler caught", file: "src/hooks.js", category: "unwired-export", severity: "warning", snippet: "legacyHandler" },
  { name: "empty function body caught", file: "src/hooks.js", category: "empty-function", severity: "warning", line: 13 },
  { name: "dead 501 route caught (critical)", file: "src/routes.js", category: "dead-501", severity: "critical", line: 6 },
  { name: "bare 501 route caught (warning)", file: "src/routes.js", category: "http-501", severity: "warning", line: 9 },
  { name: "test file in product tree caught", file: "src/exhaustive-test.js", category: "test-code-in-product", severity: "warning" },
];
for (const s of SEEDS) {
  const hits = findingsFor(crit, s).filter((f) => !s.snippet || f.snippet.includes(s.snippet));
  check(`seed: ${s.name}`, hits.length > 0,
    hits.length ? `${hits[0].file}:${hits[0].line}` : "NO MATCHING FINDING");
}

// Specificity negatives inside the critical fixture.
check("seed: mocks under test/ produce NO findings",
  crit.findings.filter((f) => f.file.startsWith("test/")).length === 0,
  JSON.stringify(crit.findings.filter((f) => f.file.startsWith("test/"))));
check("seed: misplaced src/exhaustive-test.js only flagged for placement (mock legal there)",
  findingsFor(crit, { file: "src/exhaustive-test.js" }).every((f) => f.category === "test-code-in-product"));
check("seed: wired exports (chargeCard/getBalance/wiredHelper) NOT flagged unwired",
  crit.findings.filter((f) => f.category === "unwired-export" &&
    /chargeCard|getBalance|wiredHelper/.test(f.snippet)).length === 0);
check("seed: consumer index.js and mock module itself produce no findings",
  crit.findings.filter((f) => f.file === "src/index.js" || f.file === "src/mock-gateway.js").length === 0);
check("critical fixture exits 1 (criticals present)", crit.exitCode === 1 && crit.counts.critical > 0,
  `criticals=${crit.counts.critical}`);

// ── 2. warnings-only + clean fixtures: exit code tracks criticals only ──────
const warn = scan(path.join(FIXTURES, "warnings-only"));
check("warnings-only: zero criticals", warn.counts.critical === 0, JSON.stringify(warn.counts));
check("warnings-only: warnings and infos present", warn.counts.warning > 0 && warn.counts.info > 0,
  `warning=${warn.counts.warning} info=${warn.counts.info}`);
check("warnings-only: tooling TODO dropped to warning", findingsFor(warn, { file: "scripts/legacy.js", category: "todo-marker", severity: "warning" }).length > 0);
check("warnings-only: tooling XXX dropped to info", findingsFor(warn, { file: "scripts/legacy.js", category: "marker", severity: "info" }).length > 0);
check("warnings-only: product XXX/HACK stay warning", findingsFor(warn, { file: "src/notes.js", category: "marker", severity: "warning" }).length >= 2);
check("warnings-only: placeholder copy caught", findingsFor(warn, { file: "src/placeholder.html", category: "placeholder-copy" }).length > 0);
check("warnings-only exits 0 despite findings", warn.exitCode === 0);

const clean = scan(path.join(FIXTURES, "clean"));
check("clean fixture: ZERO findings (specificity)", clean.findings.length === 0,
  JSON.stringify(clean.findings.map((f) => `${f.file}:${f.line} ${f.category}`)));
check("clean fixture exits 0", clean.exitCode === 0);

// ── CLI parity (child process, temp outputs) ────────────────────────────────
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "completeness-cli-"));
const cliCrit = runCli(["--root", path.join(FIXTURES, "critical"), "--out", path.join(tmp, "c.md"), "--json", path.join(tmp, "c.json")]);
check("CLI: critical fixture exits 1", cliCrit.status === 1, `status=${cliCrit.status}`);
check("CLI: critical fixture wrote report + json",
  fs.existsSync(path.join(tmp, "c.md")) && fs.existsSync(path.join(tmp, "c.json")));
check("CLI: markdown verdict marks INCOMPLETE",
  fs.readFileSync(path.join(tmp, "c.md"), "utf8").includes("INCOMPLETE"));
const cliWarn = runCli(["--root", path.join(FIXTURES, "warnings-only"), "--out", path.join(tmp, "w.md"), "--json", path.join(tmp, "w.json")]);
check("CLI: warnings-only fixture exits 0", cliWarn.status === 0, `status=${cliWarn.status}`);
const cliClean = runCli(["--root", path.join(FIXTURES, "clean"), "--out", path.join(tmp, "k.md"), "--json", path.join(tmp, "k.json")]);
check("CLI: clean fixture exits 0", cliClean.status === 0, `status=${cliClean.status}`);

// ── 3. real repo: scan, write report, verify structure + exit consistency ───
const real = runCli([]);
const reportMd = path.join(PROJECT, "output", "completeness-report.md");
const reportJson = path.join(PROJECT, "output", "completeness-report.json");
check("real repo: scanner ran without crashing", real.status === 0 || real.status === 1, `status=${real.status}`);
check("real repo: output/completeness-report.md written", fs.existsSync(reportMd));
check("real repo: output/completeness-report.json written", fs.existsSync(reportJson));
const md = fs.readFileSync(reportMd, "utf8");
const rj = JSON.parse(fs.readFileSync(reportJson, "utf8"));
check("real repo: markdown has title + verdict + severity sections",
  md.includes("# Completeness Audit Report") && md.includes("## Critical (") &&
  md.includes("## Warning (") && md.includes("## Info (") && md.includes("## Methodology"));
check("real repo: json counts match markdown verdict line",
  md.includes(`${rj.counts.critical} critical / ${rj.counts.warning} warning / ${rj.counts.info} info`));
check("real repo: files scanned > 100", rj.filesScanned > 100, `files=${rj.filesScanned}`);
check("real repo: every finding has file/category/severity/hint",
  rj.findings.every((f) => f.file && f.category && ["critical", "warning", "info"].includes(f.severity) && f.hint));
check("real repo: counts equal finding tally",
  rj.counts.critical + rj.counts.warning + rj.counts.info === rj.findings.length,
  `counts=${JSON.stringify(rj.counts)} findings=${rj.findings.length}`);
check("real repo: exit code equals criticals>0",
  real.status === (rj.counts.critical > 0 ? 1 : 0),
  `status=${real.status} criticals=${rj.counts.critical}`);
console.log(`      real-repo baseline: ${rj.filesScanned} files — ${rj.counts.critical} critical / ${rj.counts.warning} warning / ${rj.counts.info} info (exit ${real.status})`);
for (const f of rj.findings.filter((x) => x.severity === "critical").slice(0, 10)) {
  console.log(`      CRITICAL ${f.file}:${f.line} ${f.category} — ${f.snippet.slice(0, 90)}`);
}

// ── verdict ─────────────────────────────────────────────────────────────────
const failed = results.filter((r) => !r).length;
console.log(`\n${failed === 0 ? "PASS" : "FAIL"}  completeness-audit suite: ${results.length - failed}/${results.length} checks passed`);
process.exit(failed === 0 ? 0 : 1);
