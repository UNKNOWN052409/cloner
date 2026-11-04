#!/usr/bin/env node
// Task 4.2.11 — Capacity dashboards API test.
//
// Per the ask: SEED metrics, ASSERT aggregates + endpoint responses.
//
//   1. engine validation: sample normalization (negative → 0, region label
//      sanitization, string/float coercion), empty-sample defaults
//   2. seeded aggregates against the REAL compose PostgreSQL (migration 042):
//      per-region utilization avg/peak/current, bucketed queue-depth history,
//      cost-per-job rollups (overall / per-region / per-status), stale rows
//      excluded, zero-slot region reports utilization 0 (no capacity ≠ full)
//   3. LIVE capture: captureLiveSample() reads the REAL clone-queue registry
//      (queued → pending, running → busy) — stub jobs that actually run on the
//      memory backend move the captured sample in both directions
//   4. endpoints over a REAL express app on an ephemeral port with the REAL
//      auth middleware + real DB: 401 anonymous, 403 member, 200 admin;
//      overview/regions/queue-depth/costs/samples match the seeded aggregates;
//      POST /samples + POST /costs ingest and the next GET reflects them;
//      POST /prune removes stale rows; GET /capture stores a live sample
//
// Runtime-generated throwaway passwords only — nothing hardcoded. If compose
// PostgreSQL is unreachable the test prints a SKIP line and exits 0.
import crypto from "node:crypto";
import http from "node:http";
import path from "node:path";
import express from "express";
import { fileURLToPath } from "node:url";

const PROJECT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
process.chdir(PROJECT); // cwd-pinned modules (artifacts/, platform-data/)

const results = [];
const check = (name, ok, detail = "") => {
  results.push(ok);
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail !== "" ? ` — ${detail}` : ""}`);
};
const approx = (a, b, eps = 0.002) => Math.abs(Number(a) - Number(b)) <= eps;

const watchdog = setTimeout(() => { console.log("FAIL  global timeout (120s)"); process.exit(1); }, 120_000);
watchdog.unref();

// ---------- imports AFTER chdir ----------
const { migrate, query, closePool } = await import("../src/database/client.js");
const auth = await import("../src/auth/auth-service.js");
const { authRequired } = await import("../src/auth/auth-middleware.js");
const { createCapacityAnalytics, captureLiveSample } = await import("../src/observability/capacity-analytics.js");
const { capacityRouter } = await import("../src/platform/routes-capacity.js");
const { createCloneQueue } = await import("../src/queues/clone-queue.js");
const { createMetricsRegistry } = await import("../src/platform/metrics-registry.js");

// ---------- PostgreSQL reachability (compose instance) ----------
try {
  await query("SELECT 1");
} catch (e) {
  console.log(`SKIP  test-capacity-analytics — compose PostgreSQL unreachable (${String(e?.code || e?.message || e).slice(0, 80)}); start it with: docker compose up -d postgres`);
  process.exit(0);
}
await migrate(); // applies 042-capacity-metrics.sql (forward-only, idempotent)

// ---------- deterministic clock: pinned NOW on a minute boundary ----------
// Buckets floor to 60s — a minute-aligned NOW puts every seeded sample in its
// own bucket, so history row counts and values are exactly assertable.
const NOW = Math.floor(Date.now() / 60_000) * 60_000;
const at = (offsetSec) => new Date(NOW + offsetSec * 1000);

// test-owned regions: cleaned before and after so aggregates are exact. The
// regionless aggregates (totals, overall cost, global history) span EVERY
// region in the window, so the test wipes the whole capacity tables (dev
// compose DB; these tables are written only by this feature) rather than
// just its own region names — otherwise leftover rows from an earlier partial
// run land inside the next run's window and double-count.
const RUN = Date.now().toString(36) + crypto.randomBytes(2).toString("hex");
const USE = `cap-use-${RUN}`, EUW = `cap-euw-${RUN}`, APS = `cap-aps-${RUN}`, EVIL = `cap-evil-${RUN}`;

async function wipeCapacityTables() {
  await query("DELETE FROM capacity_samples");
  await query("DELETE FROM capacity_job_costs");
}
await wipeCapacityTables();

// engine with the pinned clock — every window/ingest ts is deterministic
const analytics = createCapacityAnalytics({ clock: () => NOW });

// =====================================================================
// 1. engine validation (no DB)
// =====================================================================
console.log("\n== engine: sample normalization ==");
{
  const s = analytics._normalizeSample({
    region: "us East\n<script>alert(1)</script>",
    workerSlots: "4", busySlots: -5, queueDepth: "7", activeJobs: 2.9,
    jobsCompleted: -1, jobsFailed: null, ts: 1234567890,
  });
  check("region sanitized to bounded label alphabet", s.region === "us_East__script_alert_1___script_", JSON.stringify(s.region));
  check("string numbers coerced to ints", s.workerSlots === 4 && s.queueDepth === 7, `slots=${s.workerSlots} depth=${s.queueDepth}`);
  check("negatives clamped to 0", s.busySlots === 0 && s.jobsCompleted === 0, `busy=${s.busySlots} done=${s.jobsCompleted}`);
  check("floats floored / null → 0", s.activeJobs === 2 && s.jobsFailed === 0, `active=${s.activeJobs} failed=${s.jobsFailed}`);
  check("epoch-ms ts parsed", s.ts.getTime() === 1234567890, String(s.ts.getTime()));
  const blank = analytics._normalizeSample({});
  check("empty sample → safe defaults", blank.region === "unknown" && blank.queueDepth === 0 && blank.workerSlots === 0, JSON.stringify(blank));
}

// =====================================================================
// 2. seed + aggregate asserts (REAL DB, migration 042 tables)
// =====================================================================
console.log("\n== seeded aggregates: utilization, queue depth history, cost per job ==");
{
  await analytics.recordSamples([
    // USE (4 slots): utilization 0.5, 1, 0.25, 1 → avg 0.6875, peak 1, current 1
    { region: USE, ts: at(-300), workerSlots: 4, busySlots: 2, queueDepth: 3, activeJobs: 2, jobsCompleted: 2, jobsFailed: 0 },
    { region: USE, ts: at(-240), workerSlots: 4, busySlots: 4, queueDepth: 6, activeJobs: 4, jobsCompleted: 1, jobsFailed: 0 },
    { region: USE, ts: at(-180), workerSlots: 4, busySlots: 1, queueDepth: 2, activeJobs: 1, jobsCompleted: 3, jobsFailed: 1 },
    { region: USE, ts: at(-120), workerSlots: 4, busySlots: 4, queueDepth: 8, activeJobs: 4, jobsCompleted: 0, jobsFailed: 0 },
    // EUW (2 slots): 0, 1 → avg 0.5, peak 1
    { region: EUW, ts: at(-300), workerSlots: 2, busySlots: 0, queueDepth: 1, activeJobs: 0, jobsCompleted: 1, jobsFailed: 0 },
    { region: EUW, ts: at(-180), workerSlots: 2, busySlots: 2, queueDepth: 4, activeJobs: 2, jobsCompleted: 2, jobsFailed: 0 },
    // APS: zero slots — no capacity, utilization must be 0 (not 1)
    { region: APS, ts: at(-120), workerSlots: 0, busySlots: 0, queueDepth: 0, activeJobs: 0, jobsCompleted: 0, jobsFailed: 0 },
    // STALE (30 min old): excluded from the 10-min window
    { region: USE, ts: at(-1800), workerSlots: 4, busySlots: 4, queueDepth: 99, activeJobs: 4, jobsCompleted: 0, jobsFailed: 0 },
  ]);
  await analytics.recordJobCost({ region: USE, jobId: "j1", costUsd: 2, status: "completed", ts: at(-240) });
  await analytics.recordJobCost({ region: USE, jobId: "j2", costUsd: 3, status: "completed", ts: at(-180) });
  await analytics.recordJobCost({ region: USE, jobId: "j3", costUsd: 4, status: "completed", ts: at(-120) });
  await analytics.recordJobCost({ region: USE, jobId: "j4", costUsd: 3, status: "completed", ts: at(-60) });
  await analytics.recordJobCost({ region: USE, jobId: "j5", costUsd: 2, status: "error", ts: at(-90) });
  await analytics.recordJobCost({ region: EUW, jobId: "j6", costUsd: 5, status: "completed", ts: at(-150) });
  await analytics.recordJobCost({ region: EUW, jobId: "j7", costUsd: 7, status: "completed", ts: at(-150) });
  await analytics.recordJobCost({ region: USE, jobId: "stale", costUsd: 99, status: "completed", ts: at(-1800) }); // excluded

  const snap = await analytics.getCapacitySnapshot({ windowMs: 600_000, bucketMs: 60_000 });

  check("snapshot carries window metadata", !!snap.window?.from && !!snap.window?.to && snap.window?.bucketMs === 60_000, JSON.stringify(snap.window));
  check("stale rows excluded from the 10-min window", snap.regions.every((r) => r.queueDepthPeak !== 99) && snap.cost.byRegion.every((r) => r.maxCostUsd !== 99),
    `peaks=${snap.regions.map((r) => r.queueDepthPeak).join(",")}`);

  const use = snap.regions.find((r) => r.region === USE);
  check("USE: utilization avg = 0.6875 (rounded 0.688)", approx(use.utilizationAvg, 0.6875, 0.001), `avg=${use.utilizationAvg}`);
  check("USE: utilization peak 1 / current 1", use.utilizationPeak === 1 && use.utilizationCurrent === 1, `peak=${use.utilizationPeak} cur=${use.utilizationCurrent}`);
  check("USE: queue depth peak 8 / current 8", use.queueDepthPeak === 8 && use.queueDepthCurrent === 8, `peak=${use.queueDepthPeak} cur=${use.queueDepthCurrent}`);
  check("USE: sample deltas 6 done / 1 failed, success 0.857", use.jobsCompleted === 6 && use.jobsFailed === 1 && approx(use.successRate, 6 / 7), `done=${use.jobsCompleted} fail=${use.jobsFailed} rate=${use.successRate}`);
  check("USE: 4 in-window samples counted", use.samples === 4, `samples=${use.samples}`);

  const euw = snap.regions.find((r) => r.region === EUW);
  check("EUW: utilization avg 0.5 / peak 1", approx(euw.utilizationAvg, 0.5) && euw.utilizationPeak === 1, `avg=${euw.utilizationAvg} peak=${euw.utilizationPeak}`);

  const aps = snap.regions.find((r) => r.region === APS);
  check("APS: zero-slot region reports utilization 0 (no capacity ≠ full)", aps && aps.utilizationAvg === 0 && aps.utilizationPeak === 0, JSON.stringify(aps && { avg: aps.utilizationAvg, peak: aps.utilizationPeak }));

  check("totals: 9 done / 1 failed / success 0.9 across regions",
    snap.totals.jobsCompleted === 9 && snap.totals.jobsFailed === 1 && approx(snap.totals.successRate, 0.9),
    JSON.stringify({ done: snap.totals.jobsCompleted, fail: snap.totals.jobsFailed, rate: snap.totals.successRate }));

  // queue-depth history: minute buckets, ordered, one sample per bucket → avg == peak
  const h = snap.queueDepthHistory.history;
  const useHist = h.filter((x) => x.region === USE);
  check("history: 4 USE buckets (one per seeded minute)", useHist.length === 4, useHist.map((x) => x.bucket).join(","));
  check("history: rows ordered ascending by bucket", h.every((x, i) => i === 0 || h[i - 1].bucket <= x.bucket));
  check("history: buckets floor-aligned to 60s", useHist.every((x) => new Date(x.bucket).getTime() % 60_000 === 0));
  check("history: USE depths 3,6,2,8 (avg == peak per single-sample bucket)",
    JSON.stringify(useHist.map((x) => [x.avgDepth, x.peakDepth])) === JSON.stringify([[3, 3], [6, 6], [2, 2], [8, 8]]),
    JSON.stringify(useHist.map((x) => [x.avgDepth, x.peakDepth])));
  check("history: stale depth-99 bucket absent", !h.some((x) => x.peakDepth === 99));

  // cost per job
  const c = snap.cost;
  check("cost: overall 7 jobs / 26 total / avg 3.714 / max 7",
    c.overall.jobs === 7 && approx(c.overall.totalCostUsd, 26) && approx(c.overall.avgCostPerJobUsd, 26 / 7) && c.overall.maxCostUsd === 7,
    JSON.stringify(c.overall));
  check("cost: costPerJob alias = avg 3.714 over 7 jobs", approx(c.costPerJob.usd, 26 / 7) && c.costPerJob.jobs === 7, JSON.stringify(c.costPerJob));
  const useCost = c.byRegion.find((r) => r.region === USE);
  check("cost: USE byRegion 5 jobs (incl. error) / total 14 / avg 2.8 / max 4",
    useCost && useCost.jobs === 5 && approx(useCost.totalCostUsd, 14) && approx(useCost.avgCostPerJobUsd, 2.8) && useCost.maxCostUsd === 4, JSON.stringify(useCost));
  const statuses = Object.fromEntries(c.byStatus.map((s) => [s.status, s]));
  check("cost: byStatus completed 6 jobs / 24 total, error 1 job / 2 total",
    statuses.completed?.jobs === 6 && approx(statuses.completed?.totalCostUsd, 24) && statuses.error?.jobs === 1 && approx(statuses.error?.totalCostUsd, 2),
    JSON.stringify(c.byStatus));

  // region filter narrows the whole snapshot
  const onlyEuw = await analytics.getCapacitySnapshot({ windowMs: 600_000, region: EUW });
  check("region filter: snapshot scoped to one region", onlyEuw.regions.length === 1 && onlyEuw.regions[0].region === EUW && onlyEuw.cost.overall.jobs === 2, `regions=${onlyEuw.regions.length} jobs=${onlyEuw.cost.overall.jobs}`);
}

// =====================================================================
// 3. LIVE capture from the real clone-queue + worker heartbeats
// =====================================================================
console.log("\n== live capture: real queue registry + worker heartbeats ==");
{
  const queue = createCloneQueue({ maxConcurrent: 1, redisUrl: "" }); // memory backend, no Redis probe
  const registry = createMetricsRegistry();
  registry.recordWorkerHeartbeat("cap-worker-1", { active: 0, memoryMb: 128 });

  const idleSample = captureLiveSample({ region: "default", queue, registry });
  check("idle capture: empty queue → depth 0 / busy 0", idleSample.queueDepth === 0 && idleSample.busySlots === 0,
    JSON.stringify({ depth: idleSample.queueDepth, busy: idleSample.busySlots, slots: idleSample.workerSlots }));

  // one running stub (occupies the single slot, status mutated the way the
  // real pipeline does) + one queued → depth 1, running 1. Poll for the
  // expected live state instead of racing a fixed sleep: a busy event loop can
  // legitimately delay either timer, and the feature under test is that
  // captureLiveSample reads the REAL registry state, not timer scheduling.
  let ran = 0;
  queue.enqueue({ payload: { url: "http://cap-fixture.local/" }, run: async ({ entry: e }) => { if (e) e.status = "running"; await new Promise((r) => setTimeout(r, 250)); if (e) e.status = "completed"; ran += 1; return {}; } });
  queue.enqueue({ payload: { url: "http://cap-fixture.local/2" }, run: async ({ entry: e }) => { if (e) e.status = "running"; if (e) e.status = "completed"; ran += 1; return {}; } });

  let busySample = null;
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 15));
    const s = captureLiveSample({ region: "default", queue, registry });
    if (s.queueDepth === 1 && s.busySlots === 1 && s.activeJobs === 1) { busySample = s; break; }
  }
  const observed = JSON.stringify(queue.listJobs().map((j) => j.status));
  check("busy capture: queued entry → depth 1, running entry → busy 1 / active 1",
    !!busySample && busySample.queueDepth === 1 && busySample.busySlots === 1 && busySample.activeJobs === 1,
    busySample ? JSON.stringify({ depth: busySample.queueDepth, busy: busySample.busySlots, active: busySample.activeJobs, slots: busySample.workerSlots }) : `never reached — statuses=${observed}`);
  check("busy capture: worker heartbeat provisions the slot", (busySample?.workerSlots ?? 0) >= 1, `slots=${busySample?.workerSlots}`);

  await queue.whenIdle();
  const afterSample = captureLiveSample({ region: "default", queue, registry });
  check("capture returns to zero after the real lifecycle finishes", afterSample.queueDepth === 0 && afterSample.activeJobs === 0 && afterSample.busySlots === 0,
    JSON.stringify({ depth: afterSample.queueDepth, active: afterSample.activeJobs, busy: afterSample.busySlots }));
  check("stub jobs actually ran", ran === 2, `ran=${ran}`);

  const stored = await analytics.recordSample(captureLiveSample({ region: "default", queue, registry }));
  check("live sample persists through the real engine", !!stored.id && stored.region === "default" && stored.queueDepth === 0 && stored.utilization === 0, JSON.stringify(stored));
}

// =====================================================================
// 4. endpoints over a REAL express app (real auth + real DB)
// =====================================================================
console.log("\n== endpoints: 401 / 403 / 200 + aggregate payloads over HTTP ==");
{
  const mkUser = async (tag) => {
    const email = `cap-test-${tag}-${RUN}@test.local`;
    const password = crypto.randomBytes(12).toString("base64url"); // never logged, never stored in this file
    await auth.registerUser(email, password);
    const login = await auth.loginUser(email, password);
    return { email, token: login.token, userId: login.userId };
  };
  const member = await mkUser("member");
  const admin = await mkUser("adminroot");
  await query("UPDATE users SET role = 'admin' WHERE id = $1", [admin.userId]); // no admin-registration route by design
  check("seed: admin + member sessions via the real auth service", !!member.token && !!admin.token);

  const app = express();
  app.use(express.json({ limit: "1mb" }));
  app.use("/api/capacity", capacityRouter({ analytics, authRequired })); // REAL middleware + pinned-clock engine
  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;
  console.log(`capacity test app on :${port}`);

  async function api(token, method, p, body) {
    const res = await fetch(`http://127.0.0.1:${port}${p}`, {
      method,
      headers: {
        ...(body ? { "content-type": "application/json" } : {}),
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch {}
    return { status: res.status, json, text };
  }

  try {
    // ---------- authorization ----------
    const anon = await api(null, "GET", "/api/capacity/overview");
    check("auth: overview without token → 401", anon.status === 401, `status=${anon.status}`);
    const memberDenied = [];
    for (const [m, p] of [["GET", "/api/capacity/overview"], ["GET", "/api/capacity/regions"], ["GET", "/api/capacity/queue-depth"], ["GET", "/api/capacity/costs"], ["GET", `/api/capacity/samples/${USE}`], ["POST", "/api/capacity/samples"], ["POST", "/api/capacity/costs"], ["GET", "/api/capacity/capture"]]) {
      const r = await api(member.token, m, p, m === "POST" ? { region: USE } : undefined);
      if (r.status !== 403) memberDenied.push(`${m} ${p} → ${r.status}`);
    }
    check("authz: member gets 403 on all 8 capacity routes (server-side guard)", memberDenied.length === 0, memberDenied.join("; ") || "all 403");

    // ---------- overview: seeded aggregates surface over HTTP ----------
    const ov = await api(admin.token, "GET", "/api/capacity/overview?windowMs=600000&bucketMs=60000");
    check("overview: 200 JSON", ov.status === 200 && !!ov.json?.totals, `status=${ov.status}`);
    const use = ov.json.regions.find((r) => r.region === USE);
    check("overview: seeded utilization avg 0.688 / peak 1 for USE", !!use && approx(use.utilizationAvg, 0.6875, 0.001) && use.utilizationPeak === 1, use && JSON.stringify({ avg: use.utilizationAvg, peak: use.utilizationPeak }));
    check("overview: cost-per-job aggregate 3.714 over 7 jobs", approx(ov.json.cost?.costPerJob?.usd, 26 / 7) && ov.json.cost?.costPerJob?.jobs === 7, JSON.stringify(ov.json.cost?.costPerJob));
    check("overview: queue-depth history present + ordered", (ov.json.queueDepthHistory?.history || []).length >= 7 && ov.json.queueDepthHistory.history.every((x, i, a) => i === 0 || a[i - 1].bucket <= x.bucket), `buckets=${ov.json.queueDepthHistory?.history?.length}`);
    check("overview: totals match seeds", ov.json.totals?.jobsCompleted === 9 && ov.json.totals?.jobsFailed === 1, JSON.stringify(ov.json.totals));

    // ---------- slices ----------
    const regions = await api(admin.token, "GET", "/api/capacity/regions?windowMs=600000");
    check("regions: the 3 seeded regions listed", regions.status === 200 && regions.json.regions.length === 3, regions.json.regions.map((r) => r.region).join(","));
    const qd = await api(admin.token, "GET", "/api/capacity/queue-depth?windowMs=600000&bucketMs=60000");
    check("queue-depth: windowed endpoint returns the exact bucketed series", qd.status === 200 && (qd.json.history || []).length === 7 && qd.json.window?.bucketMs === 60_000, `rows=${qd.json.history?.length}`);
    const costs = await api(admin.token, "GET", "/api/capacity/costs?windowMs=600000");
    check("costs: endpoint returns the cost rollups", costs.status === 200 && approx(costs.json.cost?.overall?.totalCostUsd, 26) && costs.json.cost?.byRegion?.length === 2, JSON.stringify(costs.json.cost?.overall));
    const raw = await api(admin.token, "GET", `/api/capacity/samples/${USE}?limit=3&windowMs=600000`);
    check("samples: drill-down returns newest-first bounded rows", raw.status === 200 && raw.json.samples.length === 3 && raw.json.samples[0].ts >= raw.json.samples[2].ts, `n=${raw.json.samples.length}`);

    // ---------- ingest ----------
    const post1 = await api(admin.token, "POST", "/api/capacity/samples", { region: USE, ts: at(-30).toISOString(), workerSlots: 4, busySlots: 4, queueDepth: 10, activeJobs: 4, jobsCompleted: 0, jobsFailed: 0 });
    check("ingest: POST /samples 201 + stored", post1.status === 201 && !!post1.json?.samples?.id, `status=${post1.status}`);
    const ov2 = await api(admin.token, "GET", "/api/capacity/overview?windowMs=600000&bucketMs=60000");
    const use2 = ov2.json.regions.find((r) => r.region === USE);
    check("ingest: next overview reflects the new sample (current depth 10, util 1)", use2.queueDepthCurrent === 10 && use2.utilizationCurrent === 1, JSON.stringify({ depth: use2.queueDepthCurrent, util: use2.utilizationCurrent }));

    const postMany = await api(admin.token, "POST", "/api/capacity/samples", { samples: [
      { region: EUW, ts: at(-20).toISOString(), workerSlots: 2, busySlots: 2, queueDepth: 5, activeJobs: 2 },
      { region: APS, ts: at(-20).toISOString(), workerSlots: 1, busySlots: 1, queueDepth: 0, activeJobs: 1 },
    ] });
    check("ingest: batch POST /samples stores 2", postMany.status === 201 && postMany.json.count === 2, `count=${postMany.json?.count}`);

    const badRegion = await api(admin.token, "POST", "/api/capacity/samples", { region: `${EVIL} <script>x</script>\n`, ts: at(-10).toISOString(), workerSlots: 1, busySlots: 0, queueDepth: 0 });
    check("ingest: hostile region label sanitized before storage", badRegion.status === 201 && badRegion.json.samples.region.startsWith("cap-evil-") && !badRegion.json.samples.region.includes("<"), JSON.stringify(badRegion.json.samples?.region));

    const tooMany = await api(admin.token, "POST", "/api/capacity/samples", { samples: Array.from({ length: 501 }, (_, i) => ({ region: USE, ts: at(-10).toISOString(), workerSlots: 1, queueDepth: i })) });
    check("ingest: >500 samples rejected with 400", tooMany.status === 400, `status=${tooMany.status}`);
    const badSample = await api(admin.token, "POST", "/api/capacity/samples", { samples: [null] });
    check("ingest: non-object sample → 400", badSample.status === 400, `status=${badSample.status}`);
    const notFoundRegion = await api(admin.token, "GET", "/api/capacity/nonsense");
    check("router: unknown capacity route → 404 (no catch-all)", notFoundRegion.status === 404, `status=${notFoundRegion.status}`);

    const costIn = await api(admin.token, "POST", "/api/capacity/costs", { region: USE, jobId: "j8", costUsd: 6.5, status: "completed", ts: at(-15).toISOString() });
    check("ingest: POST /costs 201 + stored", costIn.status === 201 && approx(costIn.json.cost?.costUsd, 6.5), JSON.stringify(costIn.json.cost));
    const costs2 = await api(admin.token, "GET", "/api/capacity/costs?windowMs=600000");
    check("ingest: cost aggregate moved (total 32.5 over 8 jobs)", approx(costs2.json.cost?.overall?.totalCostUsd, 32.5) && costs2.json.cost.overall.jobs === 8, JSON.stringify(costs2.json.cost?.overall));
    const costNoAmount = await api(admin.token, "POST", "/api/capacity/costs", { region: USE });
    check("ingest: cost without costUsd → 400", costNoAmount.status === 400, `status=${costNoAmount.status}`);

    // ---------- prune ----------
    await analytics.recordSample({ region: USE, ts: at(-2400), workerSlots: 4, busySlots: 4, queueDepth: 77, activeJobs: 4 });
    await analytics.recordJobCost({ region: USE, jobId: "stale2", costUsd: 50, ts: at(-2400) });
    const beforePrune = await api(admin.token, "GET", "/api/capacity/queue-depth?windowMs=3600000&bucketMs=60000");
    check("prune: stale depth-77 bucket visible before prune", (beforePrune.json.history || []).some((x) => x.peakDepth === 77));
    const pruned = await api(admin.token, "POST", "/api/capacity/prune?olderThanMs=900000");
    check("prune: endpoint reports real removals", pruned.status === 200 && pruned.json.samplesRemoved >= 1 && pruned.json.costsRemoved >= 1, JSON.stringify(pruned.json));
    const afterPrune = await api(admin.token, "GET", "/api/capacity/queue-depth?windowMs=3600000&bucketMs=60000");
    check("prune: stale bucket gone after prune", !(afterPrune.json.history || []).some((x) => x.peakDepth === 77));

    // ---------- live capture endpoint ----------
    const captured = await api(admin.token, "GET", "/api/capacity/capture?region=default");
    check("capture: GET /capture stores a REAL live sample", captured.status === 201 && !!captured.json?.sample?.id && captured.json.sample.region === "default", JSON.stringify(captured.json.sample || captured.json));
    check("capture: live numbers are sane non-negative ints", Number.isInteger(captured.json.sample?.queueDepth) && Number.isInteger(captured.json.sample?.workerSlots) && typeof captured.json.sample?.utilization === "number", JSON.stringify({ depth: captured.json.sample?.queueDepth, slots: captured.json.sample?.workerSlots, util: captured.json.sample?.utilization }));
  } finally {
    server.close();
  }
}

// =====================================================================
// cleanup: wipe the capacity tables so the dev DB is left as found
// =====================================================================
await wipeCapacityTables();
console.log("\n(cleanup: capacity tables wiped)");

const passed = results.filter(Boolean).length;
const failed = results.length - passed;
console.log(`\n==== capacity-analytics: ${passed}/${results.length} checks passed${failed ? `, ${failed} FAILED` : ""} ====`);
await closePool().catch(() => {});
process.exit(failed ? 1 : 0);
