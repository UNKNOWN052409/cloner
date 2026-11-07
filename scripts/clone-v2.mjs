// clone-v2 — TRUE one-shot clone: runs the REAL 5-stage pipeline
// (runPipelineJob: exploration → artifact_validation → reconstruction →
// verification → export) exactly like the platform queue does, so stage
// summaries, integrity re-pin and the deliverable ZIP all behave identically.
//
// Usage:
//   node scripts/clone-v2.mjs <url> [username password]
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
// Windows ESM: dynamic import of an absolute path must be a file:// URL
const mod = (rel) => import(pathToFileURL(path.join(root, rel)).href);
const { runPipelineJob } = await mod(path.join("src", "queues", "pipeline-job.js"));

// account credentials: .env is parsed here (bash `source` breaks on values
// containing shell metacharacters like `<`), argv wins over env
try {
  const envText = fs.readFileSync(path.join(process.cwd(), ".env"), "utf8");
  for (const line of envText.split("\n")) {
    const m = line.match(/^(TV_USER|TV_PASS)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
  }
} catch { /* no .env — fine */ }

const [url, usernameArg, passwordArg, depthArg] = process.argv.slice(2);
if (!url) {
  console.error("usage: node scripts/clone-v2.mjs <url> [username password] [maxRoutes]  (TV_USER/TV_PASS in .env are the default credentials)");
  process.exit(1);
}
// depth knob: maxRoutes (pages incl. seed); "max" = engine max 40, in-URL states 16
const maxRoutes = depthArg === "max" ? 40 : Number(depthArg) || 0;
// session reuse: reuse a prior job's verified session (NO second login —
// repeated logins kick the older concurrent session on Tradovate-style sites).
// Default = latest artifacts/exp-*/auth/session.json + sidecar; "fresh" = new login.
const reuseArg = process.env.CLONE_REUSE_SESSION !== undefined ? process.env.CLONE_REUSE_SESSION : "auto";
let storageStateFile = null;
let sessionSidecarFile = null;
if (reuseArg !== "fresh") {
  const roots = reuseArg === "auto" || !reuseArg ? "artifacts" : `artifacts/${reuseArg}`;
  if (reuseArg === "auto") {
    const dirs = fs.readdirSync("artifacts", { withFileTypes: true })
      .filter((d) => d.isDirectory() && /^exp-/.test(d.name))
      .map((d) => d.name)
      .sort()
      .reverse();
    for (const d of dirs) {
      const s = path.join("artifacts", d, "auth", "session.json");
      const side = path.join("artifacts", d, "auth", "session-storage.json");
      if (fs.existsSync(s)) { storageStateFile = s; if (fs.existsSync(side)) sessionSidecarFile = side; break; }
    }
  } else if (reuseArg && reuseArg !== "none") {
    // accept both shapes: artifacts/<job>/auth/session.json (engine-written)
    // and artifacts/<name>/session.json (captured externally)
    const candidates = [path.join(roots, "auth", "session.json"), path.join(roots, "session.json")];
    const sideCandidates = [path.join(roots, "auth", "session-storage.json"), path.join(roots, "session-storage.json")];
    for (let i = 0; i < candidates.length; i++) {
      if (fs.existsSync(candidates[i])) {
        storageStateFile = candidates[i];
        if (fs.existsSync(sideCandidates[i])) sessionSidecarFile = sideCandidates[i];
        break;
      }
    }
  }
}
const policy = maxRoutes
  ? {
      budgets: {
        maxRoutes,
        maxInUrlStates: 16,
        maxTotalTimeMs: Math.max(1800000, maxRoutes * 60000),
        maxTimePerPageMs: 180000,
      },
    }
  : null;
if (storageStateFile) console.log(`[clone-v2] session reuse: ${storageStateFile} (+sidecar: ${!!sessionSidecarFile}) — no second login`);
// credentials: argv wins, else the account env (never logged in plaintext)
const username = usernameArg || process.env.TV_USER || "";
const password = passwordArg || process.env.TV_PASS || "";

const t0 = Date.now();
console.log("[clone-v2] one-shot:", url, username ? "(with credentials)" : "");

try {
  const result = await runPipelineJob(
    // defaults policy budgets (900s / 30 routes) — heavy SPAs like trader.tradovate.com need the room
    { url, username, password, instructions: "", sessionId: "clone-v2", storageStateFile, sessionSidecarFile, ...(policy ? { policy } : {}) },
    {
      // live stage transitions — the same events the platform's /progress streams
      report: (status, data = {}) => console.log(`[clone-v2] stage: ${status}`, data.jobId ? `job=${data.jobId}` : ""),
      artifactsRoot: path.join(process.cwd(), "artifacts"),
    },
  );

  console.log(`[clone-v2] result: status=${result.status} passed=${result.passed} job=${result.jobId}`);
  console.log(`[clone-v2] exploration: pages=${result.manifest?.pages ?? 0} coverage=${JSON.stringify(result.manifest?.coverage ?? null)}`);
  console.log(`[clone-v2] reconstruction: ${result.reconstruction ? `passed=${result.reconstruction.passed} files=${result.reconstruction.pages} repairs=${result.reconstruction.repairs}` : "skipped"}`);
  console.log(`[clone-v2] verification: ${result.verification ? `passed=${result.verification.passed} stages=${(result.verification.stages || []).map((s) => s.stage + (s.passed ? ":ok" : ":fail")).join(",")}` : "skipped"}`);
  console.log(`[clone-v2] export: ${result.export ? (result.export.size ? `${(result.export.size / 1024).toFixed(0)} KB` : JSON.stringify(result.export)) : "none"}`);

  // ground-truth verification details (visual grade, flow matrix, slop) from disk
  const fs = await import("node:fs");
  const vp = path.join(result.artifactsDir, "_reference", "verification.json");
  try {
    const v = JSON.parse(fs.readFileSync(vp, "utf8"));
    const visual = (v.stages || []).find((s) => s.stage === "visual");
    const pix = (visual?.checks || []).find((c) => /pixel/i.test(c.name));
    console.log(`[clone-v2] visual: ${visual?.passed ? "PASS" : "FAIL"}${pix ? ` (${pix.detail})` : ""}`);
    const fp = path.join(result.artifactsDir, "reports", "flow-matrix.json");
    if (fs.existsSync(fp)) {
      const f = JSON.parse(fs.readFileSync(fp, "utf8"));
      let tot = 0, pass = 0;
      for (const fl of f.flows || []) for (const c of fl.cases || []) { tot++; if (c.result === "pass") pass++; }
      console.log(`[clone-v2] flowMatrix: ${pass}/${tot} cases, bugs=${(f.bugs || []).length}`);
    }
  } catch { /* verification details optional */ }

  console.log(`[clone-v2] project: ${result.artifactsDir}-project`);
  console.log(`[clone-v2] DONE in ${((Date.now() - t0) / 1000).toFixed(0)}s`);
} catch (e) {
  console.log("[clone-v2] FAILED:", String(e?.message || e).slice(0, 300));
  process.exit(1);
}
