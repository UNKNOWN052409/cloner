// Builds the VERSIONED DETERMINISTIC FIXTURE SET under scripts/fixtures/tradovate/artifacts/
// from a REAL exploration run against the tradovate fixture server (not live
// Tradovate — never was, never will be; see server.mjs for the synthetic-data
// contract).
//
// What "deterministic" means here, honestly:
//   - the SERVED pages and the market-data math are pure functions (server.mjs);
//   - the snapshot is a PINNED capture of one exploration run: volatile fields
//     (job id, wall-clock timestamps, per-run timings, the server port, captured
//     quote values at their capture-time sequence numbers) are normalized or
//     frozen at build time. Regenerating the snapshot re-captures; consumers
//     (the benchmark) therefore assert against capture-RELATIVE facts (channel
//     keys, ordering, structure), never absolute per-run values.
//
// Usage: node scripts/fixtures/tradovate/build-snapshot.mjs
import fs from "node:fs";
import path from "node:path";
import url from "node:url";
import { runExplorationJob } from "../../../src/pipeline/exploration-pipeline.js";
import { startTradovateFixtureServer } from "./server.mjs";

const HERE = path.dirname(url.fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "../../..");
const OUT = path.join(HERE, "artifacts");
const CANON_BASE = "http://fixture.local";
const FIXED_JOB_ID = "tradovate-fixture";
const FIXED_TS = "1970-01-01T00:00:00.000Z";

const rewriteUrls = (s) => String(s).replace(/(https?|wss?):\/\/127\.0\.0\.1:\d+/g, CANON_BASE);
const normalizeObj = (v) => {
  if (typeof v === "string") return rewriteUrls(v);
  if (Array.isArray(v)) return v.map(normalizeObj);
  if (v && typeof v === "object") {
    const out = {};
    for (const k of Object.keys(v)) out[k] = normalizeObj(v[k]);
    return out;
  }
  return v;
};
// volatile keys removed wherever they appear (timings, request ids, wall clock)
const VOLATILE_KEYS = new Set(["generatedAt", "startedAt", "finishedAt", "timestamp", "requestId", "navigationMs", "screenshotMs", "domExtractionMs"]);
const stripVolatile = (v) => {
  if (Array.isArray(v)) return v.map(stripVolatile);
  if (v && typeof v === "object") {
    const out = {};
    for (const k of Object.keys(v)) if (!VOLATILE_KEYS.has(k)) out[k] = stripVolatile(v[k]);
    return out;
  }
  return v;
};
const writeJson = (rel, obj) => {
  const fp = path.join(OUT, rel);
  fs.mkdirSync(path.dirname(fp), { recursive: true });
  fs.writeFileSync(fp, JSON.stringify(stripVolatile(normalizeObj(obj)), null, 2));
};
const copyFile = (rel, src) => {
  const fp = path.join(OUT, rel);
  fs.mkdirSync(path.dirname(fp), { recursive: true });
  fs.copyFileSync(src, fp);
};

console.log("[1] starting tradovate fixture server…");
const fx = await startTradovateFixtureServer();
console.log("    base:", fx.base);

let artifactsDir = null;
try {
  console.log("[2] running a REAL exploration job against the fixture…");
  const tmpRoot = path.join(ROOT, "artifacts", "tradovate-snapshot-build");
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  const job = await runExplorationJob({
    url: fx.base + "/",
    artifactsRoot: "artifacts",
    jobId: "tradovate-baseline",
    config: { policy: { budgets: { maxRoutes: 3, maxStatesPerPage: 8, maxInteractionsPerState: 12 } } },
  });
  artifactsDir = job.artifactsDir;
  console.log("    artifacts:", artifactsDir, "status:", job.manifest.status);

  console.log("[3] normalizing + writing the versioned snapshot…");
  fs.rmSync(OUT, { recursive: true, force: true });
  fs.mkdirSync(OUT, { recursive: true });

  // manifest — pinned identity + honest normalization note
  const manifest = JSON.parse(fs.readFileSync(path.join(artifactsDir, "manifest.json"), "utf8"));
  const pinned = {
    ...stripVolatile(normalizeObj(manifest)),
    jobId: FIXED_JOB_ID,
    startedAt: FIXED_TS,
    finishedAt: FIXED_TS,
    schemaVersion: manifest.schemaVersion || "1.0.0",
    _snapshot: {
      note: "versioned deterministic fixture — pinned exploration capture of the synthetic tradovate fixture (scripts/fixtures/tradovate/server.mjs). Volatile fields (job id, wall clock, per-run timings, request ids, ports) are normalized or stripped by build-snapshot.mjs; regenerate with: node scripts/fixtures/tradovate/build-snapshot.mjs",
      builtFromJobId: manifest.jobId,
    },
  };
  writeJson("manifest.json", pinned);

  // root-level evidence the pipeline + verification consume
  for (const rel of ["exploration.json", "graph/routes.json", "graph/states.json", "graph/transitions.json", "states/index.json", "assets/manifest.json"]) {
    const src = path.join(artifactsDir, rel);
    if (fs.existsSync(src)) writeJson(rel, JSON.parse(fs.readFileSync(src, "utf8")));
  }

  // per-page evidence (the shaped JSON snapshots the ask names)
  const pagesRoot = path.join(artifactsDir, "pages");
  for (const pageId of fs.readdirSync(pagesRoot)) {
    const pageDir = path.join(pagesRoot, pageId);
    if (!fs.statSync(pageDir).isDirectory()) continue;
    for (const f of fs.readdirSync(pageDir)) {
      const src = path.join(pageDir, f);
      if (f.endsWith(".json")) writeJson(`pages/${pageId}/${f}`, JSON.parse(fs.readFileSync(src, "utf8")));
      else copyFile(`pages/${pageId}/${f}`, src); // screenshot-viewport.png
    }
  }

  // interaction-state HTML the replay records are built from
  const statesRoot = path.join(artifactsDir, "states");
  if (fs.existsSync(statesRoot)) {
    for (const pageId of fs.readdirSync(statesRoot)) {
      const d = path.join(statesRoot, pageId);
      if (!fs.statSync(d).isDirectory()) continue;
      for (const f of fs.readdirSync(d)) {
        const html = fs.readFileSync(path.join(d, f), "utf8");
        const fp = path.join(OUT, "states", pageId, f);
        fs.mkdirSync(path.dirname(fp), { recursive: true });
        fs.writeFileSync(fp, rewriteUrls(html));
      }
    }
  }

  const pageIds = fs.readdirSync(path.join(OUT, "pages")).filter((d) => fs.statSync(path.join(OUT, "pages", d)).isDirectory());
  console.log("    pages:", pageIds.join(", "));
  for (const pid of pageIds) {
    const files = fs.readdirSync(path.join(OUT, "pages", pid)).join(", ");
    console.log(`    ${pid}: ${files}`);
  }
  console.log("[4] snapshot written to scripts/fixtures/tradovate/artifacts/");
} finally {
  await fx.close();
}
console.log("DONE");
