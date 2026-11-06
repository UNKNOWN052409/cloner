#!/usr/bin/env node
process.env.CLONER_ALLOW_PRIVATE_TARGETS = "1"; // G5.3 SSRF guard: loopback fixtures only — documented opt-in
// Log-contract test (observability realignment). Runs the EXISTING exploration
// fixture flow offline (127.0.0.1 ephemeral servers, no external network):
//   job 1 — multi-route fixture site (the scripts/fixtures flow used by
//           test-exploration-fixtures.mjs), no credentials
//   job 2 — auth-site fixture with a username/password so the no-credential-
//           leakage rule is exercised against a real credential value
// Assertions per job:
//   • EXACTLY ONE stage summary line per stage in logs/job.log (level "stage")
//     carrying status + key numbers
//   • workflow.todo.add count == routes explored (one todo per route in the
//     exploration stage; component batches / verification passes belong to
//     later stages) and every todo.add gets a workflow.todo.done (ok:true, or
//     ok:false with a note — the honest failed note)
//   • workflow.agent units == explored pages, labels == pageIds
//   • workflow.stage: starts "running", ends completed, progress non-decreasing
//   • no credential-looking strings in job.log or any bus event
//   • default CLONER_LOG_LEVEL hides debug chatter (zero engine-scope lines)
// Plus a logger unit block: CLONER_LOG_LEVEL=debug demotion knob, exactly-once
// stage dedupe, credential redaction in log lines, console mirroring.
//
// Run: node scripts/test-log-contract.mjs   (exit 1 on any failure)
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runExplorationJob } from "../src/pipeline/exploration-pipeline.js";
import { createLogger } from "../src/observability/logger.js";
import { bus } from "../src/events.js";
import { startFixtureServer } from "./fixtures/server.mjs";
import { multiRouteSite } from "./fixtures/multi-route.mjs";
import { startAuthFixture } from "../fixtures/auth-site/index.mjs";

let pass = 0, fail = 0;
const check = (name, ok, detail = "") => {
  console.log(`  ${ok ? "PASS" : "FAIL"} ${name}${detail ? " — " + detail : ""}`);
  ok ? pass++ : fail++;
};

const BUDGETS = { maxRoutes: 4, maxStatesPerPage: 8, maxTotalTimeMs: 90000 };
const USER = "alice";
const PASSWORD = "s3cret!42"; // fixture-only credential — must never reach a log

// credential-shaped JSON keys with a real value (redacted placeholders excluded)
const CRED_VALUE_KEY_RE = /"(?:password|passwd|secret|token|api[-_]?key|authorization|cookie|cookies|session[-_]?token|access[-_]?token)"\s*:\s*"(?!redacted)/i;

function readStageRecs(artifactsDir) {
  const file = path.join(artifactsDir, "logs", "job.log");
  return fs.readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
}

function workflowEvents(jobId) {
  return bus.catchUp().events.filter((e) => String(e.type || "").startsWith("workflow.") && (!e.job || e.job === jobId));
}

// ---- shared per-job contract checks ----
function jobContractChecks(name, { jobId, artifactsDir, manifest }) {
  const recs = readStageRecs(artifactsDir);
  const stageRecs = recs.filter((r) => r.level === "stage");
  const byStage = {};
  for (const r of stageRecs) byStage[r.stage] = (byStage[r.stage] || 0) + 1;
  check(`${name}: exactly ONE stage summary line per stage`, Object.values(byStage).every((n) => n === 1) && byStage.exploration === 1,
    byStage.exploration === 1 ? "exploration=1" : JSON.stringify(byStage));
  const s = stageRecs.find((r) => r.stage === "exploration");
  check(`${name}: stage line carries status + key numbers`, !!s && typeof s.status === "string" && [s.routes, s.pages, s.states, s.warnings, s.errors].every((n) => Number.isFinite(Number(n))),
    s ? `status=${s.status} routes=${s.routes} pages=${s.pages} states=${s.states} warnings=${s.warnings} errors=${s.errors}` : "no exploration stage line");
  check(`${name}: stage status matches manifest`, !!s && s.status === manifest.status, `log=${s?.status} manifest=${manifest.status}`);

  // noise cut at the default level: no debug lines, no engine chatter
  check(`${name}: zero debug-level lines at default CLONER_LOG_LEVEL`, recs.every((r) => r.level !== "debug"), `levels=${[...new Set(recs.map((r) => r.level))].join(",")}`);
  check(`${name}: zero engine-scope chatter at default level`, recs.every((r) => r.scope !== "engine"), `scopes=${[...new Set(recs.map((r) => r.scope))].join(",")}`);

  // workflow events on the bus
  const wfe = workflowEvents(jobId);
  const adds = wfe.filter((e) => e.type === "workflow.todo.add").map((e) => e.data);
  const dones = wfe.filter((e) => e.type === "workflow.todo.done").map((e) => e.data);
  const agents = wfe.filter((e) => e.type === "workflow.agent").map((e) => e.data);
  const stages = wfe.filter((e) => e.type === "workflow.stage").map((e) => e.data);

  check(`${name}: every workflow event is job-tagged`, wfe.every((e) => e.job === jobId), `${wfe.length} event(s)`);
  check(`${name}: todo.add count == routes explored (expected units)`, adds.length === manifest.pages.length,
    `adds=${adds.length} pages=${manifest.pages.length} units=${[...new Set(adds.map((a) => a.unit))].join(",")}`);
  const addIds = new Set(adds.map((a) => a.id));
  const doneIds = new Set(dones.map((d) => d.id));
  check(`${name}: every todo.add eventually gets todo.done`, [...addIds].every((id) => doneIds.has(id)) && addIds.size === doneIds.size,
    `open=${[...addIds].filter((id) => !doneIds.has(id)).join(",") || "none"}`);
  const failedDone = dones.filter((d) => d.ok === false);
  check(`${name}: closed todos carry ok:true (or an honest ok:false + note)`,
    dones.every((d) => d.ok === true || (d.ok === false && typeof d.note === "string" && d.note.length > 0)),
    `ok=${dones.filter((d) => d.ok === true).length} failedNote=${failedDone.length}`);
  check(`${name}: agent units == explored pages, labels == pageIds`,
    agents.length === manifest.pages.length && manifest.pages.every((p) => agents.some((a) => a.label === p.pageId && a.unit === "page")),
    `agents=${agents.length} labels=${agents.map((a) => a.label).join(",")}`);
  check(`${name}: stage events start running and end completed`,
    stages.length >= 2 && stages[0].status === "running" && stages[stages.length - 1].status === manifest.status,
    stages.map((e) => `${e.status}@${e.progress ?? "-"}`).join(" → "));
  const runningProgress = stages.filter((e) => e.status === "running").map((e) => e.progress ?? 0);
  check(`${name}: stage progress non-decreasing, ends at 1`,
    runningProgress.every((p, i) => i === 0 || p >= runningProgress[i - 1]) && stages[stages.length - 1].progress === 1,
    runningProgress.join(","));
  return { recs, wfe };
}

function credentialChecks(name, { artifactsDir, wfe }) {
  const logText = fs.readFileSync(path.join(artifactsDir, "logs", "job.log"), "utf8");
  const eventText = JSON.stringify(wfe);
  check(`${name}: fixture password never appears in job.log`, !logText.includes(PASSWORD), `${logText.length}B scanned`);
  check(`${name}: fixture password never appears in any bus event`, !eventText.includes(PASSWORD), `${eventText.length}B scanned`);
  check(`${name}: no credential-shaped key with a real value in job.log`, !CRED_VALUE_KEY_RE.test(logText), "clean");
}

// ---- logger unit block: level knob, dedupe, redaction, console mirror ----
function loggerUnitChecks(tmp) {
  const dir = path.join(tmp, "logger-unit");
  const saved = process.env.CLONER_LOG_LEVEL;
  delete process.env.CLONER_LOG_LEVEL;

  // default threshold (info): debug dropped, stage deduped to exactly one
  const l1 = createLogger({ jobId: "unit-default", artifactsDir: dir });
  l1.debug("unit", "chatty debug line that must be dropped");
  l1.info("unit", "info line kept");
  const r1 = l1.stage("unit-stage", "completed", { routes: 3 });
  const r2 = l1.stage("unit-stage", "completed", { routes: 3 }); // must be ignored
  const recs1 = readStageRecs(dir);
  check("logger: debug line dropped at default level", !recs1.some((r) => r.level === "debug"));
  check("logger: stage() exactly-once (second call ignored)", recs1.filter((r) => r.level === "stage").length === 1 && !!r1 && r2 == null);
  check("logger: stage line carries stage/status/numbers", recs1.some((r) => r.stage === "unit-stage" && r.status === "completed" && r.routes === 3));

  // debug threshold: demoted lines become visible
  process.env.CLONER_LOG_LEVEL = "debug";
  const dir2 = path.join(tmp, "logger-unit-debug");
  const l2 = createLogger({ jobId: "unit-debug", artifactsDir: dir2 });
  l2.debug("unit", "debug line visible in debug mode");
  const recs2 = readStageRecs(dir2);
  check("logger: CLONER_LOG_LEVEL=debug demotes nothing", recs2.some((r) => r.level === "debug" && /debug line visible/.test(r.msg)));

  // credentials: the literal value must be scrubbed out of the written line
  process.env.CLONER_LOG_LEVEL = "debug";
  const dir3 = path.join(tmp, "logger-unit-redact");
  const l3 = createLogger({ jobId: "unit-redact", artifactsDir: dir3 });
  l3.info("unit", `submitted password=${PASSWORD} for user`);
  const recs3 = readStageRecs(dir3);
  check("logger: credential value scrubbed from log lines", !fs.readFileSync(path.join(dir3, "logs", "job.log"), "utf8").includes(PASSWORD));

  // console mirror: stage + warn visible at default; info/debug only in debug mode
  delete process.env.CLONER_LOG_LEVEL;
  const dir4 = path.join(tmp, "logger-unit-console");
  const seen = [];
  const origLog = console.log;
  console.log = (s) => seen.push(String(s));
  try {
    const l4 = createLogger({ jobId: "unit-console", artifactsDir: dir4 });
    l4.info("unit", "info line not mirrored by default");
    l4.warn("unit", "warn line mirrored");
    l4.stage("console-stage", "completed", { pages: 1 });
  } finally { console.log = origLog; }
  check("logger: console shows STAGE + WARN at default level, not info chatter",
    seen.some((l) => /STAGE console-stage: completed/.test(l)) && seen.some((l) => /WARN unit: warn line mirrored/.test(l)) && !seen.some((l) => /info line not mirrored/.test(l)),
    seen.map((l) => l.slice(0, 60)).join(" | "));

  if (saved != null) process.env.CLONER_LOG_LEVEL = saved; else delete process.env.CLONER_LOG_LEVEL;
}

// ---- run the two offline fixture jobs ----
async function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "log-contract-test-"));
  console.log(`log-contract test — offline 127.0.0.1 fixtures, artifacts under ${tmp}`);
  const tAll = Date.now();

  console.log("\n== job 1: multi-route fixture (no credentials) ==");
  try {
    const server = await startFixtureServer(multiRouteSite);
    try {
      bus.reset();
      const jobId = `lc-multi-${Date.now().toString(36)}`;
      const artifactsRoot = path.join(tmp, "multi");
      const { artifactsDir, manifest } = await runExplorationJob({
        url: server.base + multiRouteSite.entry, artifactsRoot, jobId,
        config: { policy: { budgets: BUDGETS } },
      });
      const { recs, wfe } = jobContractChecks("multi-route", { jobId, artifactsDir, manifest });
      credentialChecks("multi-route", { artifactsDir, wfe });
      check("multi-route: 4 routes explored as the fixture defines", manifest.pages.length === 4, manifest.pages.map((p) => p.pageId).join(","));
    } finally { await server.close(); }
  } catch (e) {
    check("multi-route: fixture run completed without crash", false, String((e && e.message) || e).slice(0, 200));
  }

  console.log("\n== job 2: auth fixture with credentials (leak rule) ==");
  try {
    const fx = await startAuthFixture({ mode: "plain", username: USER, password: PASSWORD });
    try {
      bus.reset();
      const jobId = `lc-auth-${Date.now().toString(36)}`;
      const artifactsRoot = path.join(tmp, "auth");
      const { artifactsDir, manifest } = await runExplorationJob({
        url: fx.base + "/", artifactsRoot, jobId, username: USER, password: PASSWORD,
        config: { policy: { budgets: BUDGETS } },
      });
      const { wfe } = jobContractChecks("auth", { jobId, artifactsDir, manifest });
      credentialChecks("auth", { artifactsDir, wfe });
      check("auth: failed auth is fail-soft — job still completed exploring",
        ["completed", "completed-with-errors"].includes(manifest.status) && manifest.auth?.status === "failed",
        `status=${manifest.status} auth=${manifest.auth?.status} warnings=${(manifest.warnings || []).length}`);
    } finally { await fx.close(); }
  } catch (e) {
    check("auth: fixture run completed without crash", false, String((e && e.message) || e).slice(0, 200));
  }

  console.log("\n== logger unit block (level knob / dedupe / redaction / console) ==");
  try {
    loggerUnitChecks(tmp);
  } catch (e) {
    check("logger unit block completed", false, String((e && e.message) || e).slice(0, 200));
  }

  const totalS = ((Date.now() - tAll) / 1000).toFixed(1);
  console.log(`\n=== log-contract test: ${pass} PASS / ${fail} FAIL (of ${pass + fail}) — ${totalS}s ===`);
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
  process.exit(fail ? 1 : 0);
}

main().catch((err) => {
  console.error("test-log-contract fatal:", err);
  process.exit(1);
});
