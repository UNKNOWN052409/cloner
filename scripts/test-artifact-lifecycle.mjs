#!/usr/bin/env node
// Artifact lifecycle tests (task 4.0.5) — deterministic, no live external services.
//
//   Part A — per-org artifact roots (artifacts/<orgId>/<jobId>/) + legacy
//            artifacts/<jobId>/ still readable (resolveArtifactPath/exportV2Dir).
//   Part B — retention tiers: env RETENTION_DAYS honored, garbage/zero/negative
//            guarded to 15 (same contract as tasks.js sweepExpired), per-class
//            defaults (temp 1 / failed 7 / deleted 0), expiryFor math.
//   Part C — injectable-clock sweep: create → account → expire → sweep removes
//            ONLY expired org jobs (staged deletion), fresh + pinned kept,
//            legacy untouched, orphans reported; staging leftovers finalized;
//            org orphans removed only under orphanPolicy:"remove".
//   Part D — computeUsage(root) per-org + legacy accounting (4.0.4 quotas).
//   Part E — credential shred preserved: export integrity fail-closed before
//            any removal, post-export shred removes private/ + sensitive names,
//            site assets survive, sweep never resurrects them.
//   Part F — sweep runnable through the clone-queue adapter (memory backend).
//   Part G — PostgreSQL retention bookkeeping against the compose Postgres
//            (docker compose up -d postgres if needed): ONLY migration 014 is
//            applied on top of the pre-existing 001 baseline; SKIPs when the
//            DB is unreachable.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";

const results = [];
const check = (name, ok, detail = "") => {
  results.push(ok);
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
};
const skip = (name, detail = "") => console.log(`SKIP  ${name}${detail ? ` — ${detail}` : ""}`);

const watchdog = setTimeout(() => { console.log("FAIL  global timeout (90s)"); process.exit(1); }, 90_000);
watchdog.unref();

// determinism: the machine may carry RETENTION_DAYS — parts C/D/E/F rely on the
// per-class defaults, so neutralize it (Part B manipulates it explicitly; the
// original value is restored at exit).
const PREV_RETENTION = process.env.RETENTION_DAYS;
delete process.env.RETENTION_DAYS;

// isolated artifact base so the repo's real artifacts/ dir is never touched
const BASE = fs.mkdtempSync(path.join(os.tmpdir(), "cloner-artifacts-"));
const T0 = Date.parse("2026-01-01T00:00:00.000Z");
const DAY = 86_400_000;
const clockAt = (ms) => () => ms;

const {
  artifactPathFor, legacyArtifactPath, resolveArtifactPath, exportV2Dir,
  createOrgArtifactStore, writeLifecycle, readManifest,
  RETENTION_TIERS, retentionDaysFor, expiryFor, guardedEnvRetentionDays,
  planSweep, sweep, computeUsage, sha256File,
  shredJobCredentials, verifyExportIntegrity, finalizeExportV2, enqueueSweep,
  dbMarkExpired, dbPurgeExpired, dbUsageByOrg,
} = await import("../src/storage/artifact-lifecycle.js");

const { createCloneQueue } = await import("../src/queues/clone-queue.js");

// ============ Part A: per-org roots + legacy readability ============
console.log("\n-- Part A: per-org artifact roots + legacy readability --");
{
  const store = createOrgArtifactStore({ base: BASE, orgId: "org-setup", jobId: "job-a1", retentionClass: "temp", clock: clockAt(T0) });
  check("A: store root is artifacts/<orgId>/<jobId>/", store.dir === path.join(BASE, "artifacts", "org-setup", "job-a1"), store.dir);
  check("A: artifact-store subdirs created (pages/states/assets/graph/reports/logs)",
    ["pages", "states", "assets", "graph", "reports", "logs"].every((d) => fs.existsSync(path.join(store.dir, d))));
  store.writeJson("pages/page.json", { url: "http://fixture.local/a" });
  check("A: writeJson lands inside the org-scoped root", fs.existsSync(path.join(store.dir, "pages", "page.json")));

  const m = readManifest(store.dir);
  check("A: manifest carries the lifecycle header (jobId/orgId/createdAt/retentionClass/expiresAt)",
    m?.lifecycle?.jobId === "job-a1" && m?.lifecycle?.orgId === "org-setup" &&
    m?.lifecycle?.retentionClass === "temp" && m?.lifecycle?.lifecycleState === "active" &&
    typeof m?.lifecycle?.expiresAt === "string", JSON.stringify(m?.lifecycle || null));
  check("A: temp class expires 1 day after creation", Date.parse(m.lifecycle.expiresAt) === T0 + DAY,
    `expiresAt=${m.lifecycle.expiresAt}`);

  // legacy path still readable
  const legacyJob = legacyArtifactPath("job-legacy", BASE);
  fs.mkdirSync(legacyJob, { recursive: true });
  fs.writeFileSync(path.join(legacyJob, "manifest.json"), JSON.stringify({ jobId: "job-legacy" }));
  const orgResolved = resolveArtifactPath("job-a1", { orgId: "org-setup", base: BASE });
  const legacyResolved = resolveArtifactPath("job-legacy", { orgId: "org-setup", base: BASE });
  const noScope = resolveArtifactPath("job-legacy", { base: BASE });
  check("A: org-scoped job resolves to the org root (scope=org)", orgResolved.scope === "org" && orgResolved.path === store.dir);
  check("A: unknown-to-org job falls back to the LEGACY root (scope=legacy) — legacy paths still readable",
    legacyResolved.scope === "legacy" && legacyResolved.path === legacyJob);
  check("A: no orgId given → legacy root resolves too", noScope.scope === "legacy");
  check("A: artifactPathFor requires orgId for new jobs", (() => { try { artifactPathFor("", "x"); return false; } catch { return true; } })());
  check("A: exportV2Dir drop-in resolves org first, legacy second",
    exportV2Dir("job-a1", { orgId: "org-setup", base: BASE }) === store.dir &&
    exportV2Dir("job-legacy", { orgId: "org-setup", base: BASE }) === legacyJob);
}

// ============ Part B: retention tiers + env guard ============
console.log("\n-- Part B: retention tiers + RETENTION_DAYS guard --");
{
  const prev = process.env.RETENTION_DAYS;
  try {
    delete process.env.RETENTION_DAYS;
    check("B: per-class defaults with no env — temp=1 failed=7 deleted=0 completed=env-guard",
      retentionDaysFor("temp") === 1 && retentionDaysFor("failed") === 7 && retentionDaysFor("deleted") === 0 && retentionDaysFor("completed") === 15,
      `completed=${retentionDaysFor("completed")}`);
    check("B: guardedEnvRetentionDays falls back to 15 when env unset", guardedEnvRetentionDays() === 15);

    for (const [val, expect] of [["30", 30], ["0", 15], ["-3", 15], ["garbage", 15], ["", 15]]) {
      process.env.RETENTION_DAYS = val;
      check(`B: RETENTION_DAYS="${val}" → ${expect} (guard mirrors tasks.js)`, guardedEnvRetentionDays() === expect, `got ${guardedEnvRetentionDays()}`);
    }

    check("B: explicit call-site days override the env tier", retentionDaysFor("completed", { days: 90 }) === 90);
    check("B: expiryFor math with injected clock (completed → env-guarded 15d with env unset)",
      expiryFor(T0, "completed", { clock: clockAt(T0) }) === new Date(T0 + 15 * DAY).toISOString());
    check("B: expiryFor honors an explicit days override (30d)",
      expiryFor(T0, "completed", { clock: clockAt(T0), days: 30 }) === new Date(T0 + 30 * DAY).toISOString());
    process.env.RETENTION_DAYS = "45";
    check("B: env RETENTION_DAYS=45 flows into expiryFor", Date.parse(expiryFor(T0, "completed", { clock: clockAt(T0) })) === T0 + 45 * DAY);
    check("B: RETENTION_TIERS exposed", JSON.stringify(RETENTION_TIERS) === JSON.stringify({ temp: 1, failed: 7, deleted: 0, completed: null }));
  } finally {
    if (prev === undefined) delete process.env.RETENTION_DAYS; else process.env.RETENTION_DAYS = prev;
  }
}

// ============ Part C: planSweep + staged sweep (injectable clock) ============
console.log("\n-- Part C: sweep removes only expired, legacy untouched (injectable clock) --");
{
  // create: expired org job, fresh org job, pinned expired job, org orphan, legacy dirs
  createOrgArtifactStore({ base: BASE, orgId: "org-alpha", jobId: "job-exp", retentionClass: "temp", clock: clockAt(T0) });
  fs.writeFileSync(path.join(artifactPathFor("org-alpha", "job-exp", BASE), "pages", "page.json"), "{}");
  createOrgArtifactStore({ base: BASE, orgId: "org-alpha", jobId: "job-fresh", retentionClass: "completed", clock: clockAt(T0) });
  const pinned = createOrgArtifactStore({ base: BASE, orgId: "org-alpha", jobId: "job-pin", retentionClass: "temp", clock: clockAt(T0) });
  pinned.pin("legal hold");
  fs.mkdirSync(path.join(BASE, "artifacts", "org-alpha", "orphan-job"), { recursive: true }); // no manifest
  fs.mkdirSync(path.join(BASE, "artifacts", "job-legacy-no-manifest"), { recursive: true });  // legacy orphan
  // legacy manifest-bearing dir that IS expired — must stay untouched by default
  fs.mkdirSync(path.join(BASE, "artifacts", "job-legacy-manifest"), { recursive: true });
  fs.writeFileSync(path.join(BASE, "artifacts", "job-legacy-manifest", "manifest.json"),
    JSON.stringify({ lifecycle: { jobId: "job-legacy-manifest", retentionClass: "temp", lifecycleState: "active", expiresAt: new Date(T0 + DAY).toISOString() } }));
  fs.writeFileSync(path.join(BASE, "artifacts", "job-legacy-manifest", "evidence.txt"), "old evidence");

  const T1 = T0 + 3 * DAY; // expires the temp jobs (incl. Part A's job-a1 — also temp class)
  const plan = planSweep({ base: BASE, clock: clockAt(T1) });
  const alphaExpiredIds = plan.expired.filter((e) => e.orgId === "org-alpha").map((e) => e.jobId).sort();
  check("C: plan marks ONLY job-exp expired among ORG-ALPHA jobs at T0+3d", alphaExpiredIds.join(",") === "job-exp", alphaExpiredIds.join(","));
  check("C: legacy manifest-bearing expired dir is KNOWN expired but gated behind allowLegacy",
    plan.expired.some((e) => e.jobId === "job-legacy-manifest" && e.scope === "legacy-manifest"));
  check("C: fresh + pinned kept with reasons",
    plan.kept.some((k) => k.dir.endsWith("job-fresh")) && plan.kept.some((k) => k.dir.endsWith("job-pin") && k.reason.includes("pinned")));
  check("C: orphan detection — org orphan + legacy orphan reported",
    plan.orphans.some((o) => o.scope === "org" && o.dir.endsWith("orphan-job")) &&
    plan.orphans.some((o) => o.scope === "legacy" && o.dir.endsWith("job-legacy-no-manifest")));

  // execute=false → no mutation
  sweep({ base: BASE, clock: clockAt(T1), execute: false });
  check("C: plan-only sweep mutates nothing", fs.existsSync(artifactPathFor("org-alpha", "job-exp", BASE)));

  const res = sweep({ base: BASE, clock: clockAt(T1), execute: true });
  check("C: sweep executed removes every expired org job (job-exp + Part A's expired temp job-a1) and nothing else",
    res.executed.map((e) => e.jobId).sort().join(",") === "job-a1,job-exp", JSON.stringify(res.executed));
  check("C: expired job dir gone", !fs.existsSync(artifactPathFor("org-alpha", "job-exp", BASE)));
  check("C: default sweep skips the legacy manifest dir and reports it untouched",
    !res.executed.some((e) => e.jobId === "job-legacy-manifest") &&
    res.legacyUntouched.some((d) => d.endsWith("job-legacy-manifest")),
    JSON.stringify(res.legacyUntouched));
  check("C: fresh job, pinned job, legacy dirs and orphans all intact",
    fs.existsSync(artifactPathFor("org-alpha", "job-fresh", BASE)) &&
    fs.existsSync(artifactPathFor("org-alpha", "job-pin", BASE)) &&
    fs.existsSync(path.join(BASE, "artifacts", "job-legacy-manifest", "evidence.txt")) &&
    fs.existsSync(path.join(BASE, "artifacts", "job-legacy-no-manifest")) &&
    fs.existsSync(path.join(BASE, "artifacts", "org-alpha", "orphan-job")));
  check("C: sweep is idempotent (second run executes nothing)",
    sweep({ base: BASE, clock: clockAt(T1), execute: true }).executed.length === 0);

  // interrupted sweep: leftover in staging is finalized by the next sweep
  const stageRoot = path.join(BASE, "artifacts", ".lifecycle-staging");
  const leftover = path.join(stageRoot, "job-interrupted.999.123");
  fs.mkdirSync(leftover, { recursive: true });
  fs.writeFileSync(path.join(leftover, "partial.bin"), "x");
  const fin = sweep({ base: BASE, clock: clockAt(T1), execute: true });
  check("C: interrupted-write leftover inside staging is finalized by the next sweep",
    fin.executed.some((e) => e.stage === "staged-finalized" && e.dir === leftover) && !fs.existsSync(leftover),
    JSON.stringify(fin.executed));

  // orphan removal is explicit and org-only
  const orphanRes = sweep({ base: BASE, clock: clockAt(T1), execute: true, orphanPolicy: "remove" });
  check("C: orphanPolicy=remove removes ORG orphans only, legacy orphan never touched",
    orphanRes.executed.some((e) => e.stage === "orphan-removed" && e.dir.endsWith("orphan-job")) &&
    !fs.existsSync(path.join(BASE, "artifacts", "org-alpha", "orphan-job")) &&
    fs.existsSync(path.join(BASE, "artifacts", "job-legacy-no-manifest")));
  // allowLegacy opt-in sweeps a manifest-bearing legacy dir that is expired
  const legacyRes = sweep({ base: BASE, clock: clockAt(T1), execute: true, allowLegacy: true });
  check("C: allowLegacy opt-in removes the expired manifest-bearing legacy dir",
    legacyRes.executed.some((e) => e.jobId === "job-legacy-manifest") && !fs.existsSync(path.join(BASE, "artifacts", "job-legacy-manifest")));
  check("C: legacy orphan STILL untouched even with allowLegacy",
    fs.existsSync(path.join(BASE, "artifacts", "job-legacy-no-manifest")));
}

// ============ Part D: computeUsage (4.0.4 quotas) ============
console.log("\n-- Part D: computeUsage per-org accounting --");
{
  const u = computeUsage(path.join(BASE, "artifacts"));
  const orgBytes = Object.values(u.orgs).reduce((s, v) => s + v.bytes, 0);
  check("D: totals equal org + legacy sums", u.bytes > 0 && u.files > 0 && u.bytes === orgBytes + u.legacy.bytes, `bytes=${u.bytes} orgs=${orgBytes} legacy=${u.legacy.bytes}`);
  check("D: org-alpha bucket has the two remaining jobs",
    u.orgs["org-alpha"]?.jobs === 2 && u.orgs["org-alpha"].files > 0, JSON.stringify(u.orgs["org-alpha"] || null));
  check("D: legacy bucket counted (manifest-bearing legacy job was swept; no-manifest orphan remains)",
    u.legacy.files > 0, JSON.stringify(u.legacy));
  check("D: computeUsage on a missing root returns zeroed shape", (() => {
    const z = computeUsage(path.join(BASE, "no-such-root"));
    return z.bytes === 0 && z.files === 0 && Object.keys(z.orgs).length === 0;
  })());
}

// ============ Part E: credential shred preserved + export integrity ============
console.log("\n-- Part E: shred guarantee + fail-closed export integrity --");
{
  const store = createOrgArtifactStore({ base: BASE, orgId: "org-beta", jobId: "job-shred", retentionClass: "completed", clock: clockAt(T0) });
  const dir = store.dir;
  fs.mkdirSync(path.join(dir, "private"), { recursive: true });
  fs.writeFileSync(path.join(dir, "private", "cookies.json"), "[session cookie placeholders — never real credentials]");
  fs.writeFileSync(path.join(dir, "private", "storage.json"), "{}");
  fs.mkdirSync(path.join(dir, "pages"), { recursive: true });
  fs.writeFileSync(path.join(dir, "pages", "index.html"), "<html>clone</html>");
  fs.writeFileSync(path.join(dir, "assets", "analytics.js"), "console.log(1)"); // site asset — must survive
  fs.writeFileSync(path.join(dir, "session-state.json"), "{}"); // sensitive-named data file

  // fail-closed: integrity failure → NOTHING removed
  let threw = null;
  try { finalizeExportV2({ jobDir: dir, zipPath: path.join(dir, "missing.zip") }); } catch (e) { threw = String(e.message); }
  check("E: missing ZIP → finalizeExportV2 throws, working files preserved",
    threw?.includes("export integrity check failed (missing)") && fs.existsSync(path.join(dir, "private", "cookies.json")),
    threw || "no throw");
  fs.writeFileSync(path.join(dir, "export.zip"), "");
  let threw2 = null;
  try { finalizeExportV2({ jobDir: dir, zipPath: path.join(dir, "export.zip") }); } catch (e) { threw2 = String(e.message); }
  check("E: zero-byte ZIP → fail-closed too (mirrors exporter.js zip validation)",
    threw2?.includes("(empty") && fs.existsSync(path.join(dir, "private", "cookies.json")), threw2 || "no throw");

  // real export → integrity verified THEN shredded
  fs.writeFileSync(path.join(dir, "export.zip"), Buffer.from("PK\x03\x04 fake zip body"));
  const out = finalizeExportV2({ jobDir: dir, zipPath: path.join(dir, "export.zip") });
  check("E: real ZIP passes verifyExportIntegrity with a sha256", out.integrity.ok && /^[a-f0-9]{64}$/.test(out.integrity.sha256));
  check("E: sha256 matches sha256File", out.integrity.sha256 === sha256File(path.join(dir, "export.zip")));
  check("E: post-export shred removed private/ AND the sensitive-named data file",
    !fs.existsSync(path.join(dir, "private")) && !fs.existsSync(path.join(dir, "session-state.json")),
    JSON.stringify(out.shred.removed));
  check("E: clone evidence + site assets survive the shred",
    fs.existsSync(path.join(dir, "pages", "index.html")) && fs.existsSync(path.join(dir, "assets", "analytics.js")));
  check("E: manifest records exportSha256 + credentialsShreddedAt",
    readManifest(dir).lifecycle.exportSha256 === out.integrity.sha256 && typeof readManifest(dir).lifecycle.credentialsShreddedAt === "string");

  // retention sweep afterwards cannot resurrect credentials (they are gone) and
  // does not delete the exported job before its expiry
  const sweepRes = sweep({ base: BASE, clock: clockAt(T0 + DAY), execute: true });
  check("E: sweep after export keeps the fresh exported job and removes nothing sensitive",
    !sweepRes.executed.some((e) => e.jobId === "job-shred") && !fs.existsSync(path.join(dir, "private")));
  // expired sweep of the exported job also never brings credentials back
  sweep({ base: BASE, clock: clockAt(T0 + 60 * DAY), execute: true });
  check("E: after the exported job expires it is swept (and no credential files remain)", !fs.existsSync(dir));
}

// ============ Part F: sweep runnable through the queue adapter ============
console.log("\n-- Part F: sweep via the clone-queue adapter (memory backend) --");
{
  createOrgArtifactStore({ base: BASE, orgId: "org-gamma", jobId: "job-q1", retentionClass: "temp", clock: clockAt(T0) });
  createOrgArtifactStore({ base: BASE, orgId: "org-gamma", jobId: "job-q2", retentionClass: "completed", clock: clockAt(T0) });

  const q = createCloneQueue({ redisUrl: "" });
  await q.ready;
  const statuses = [];
  q.on("status", (e) => statuses.push(e.status));
  const entry = enqueueSweep(q, { base: BASE, clock: clockAt(T0 + 2 * DAY) });
  check("F: enqueueSweep returns a queue entry synchronously (sweepPayload carries the wire contract)",
    typeof entry.tempId === "string" && entry.sweepPayload?.kind === "artifact-sweep" && entry.sweepPayload.execute === true,
    JSON.stringify(entry.sweepPayload || null));
  await q.whenIdle();
  check("F: sweep job ran to completion through the adapter", entry.status === "completed", `status=${entry.status}`);
  check("F: status trail flowed through the queue (queued → sweeping → swept → completed)",
    statuses.includes("queued") && statuses.includes("sweeping") && statuses.includes("swept") && statuses.includes("completed"),
    statuses.join(" → "));
  check("F: adapter-driven sweep removed only the expired org job",
    !fs.existsSync(artifactPathFor("org-gamma", "job-q1", BASE)) &&
    fs.existsSync(artifactPathFor("org-gamma", "job-q2", BASE)));

  // plan-only sweep through the adapter mutates nothing
  const fresh = createOrgArtifactStore({ base: BASE, orgId: "org-gamma", jobId: "job-q3", retentionClass: "temp", clock: clockAt(T0) });
  const q2 = createCloneQueue({ redisUrl: "" });
  await q2.ready;
  const dry = enqueueSweep(q2, { base: BASE, clock: clockAt(T0 + 2 * DAY), execute: false });
  await q2.whenIdle();
  check("F: execute=false payload → dry-run sweep leaves jobs in place",
    dry.sweepPayload.execute === false && fs.existsSync(fresh.dir));
  await q.close(); await q2.close();
}

// ============ Part G: PostgreSQL retention bookkeeping (compose PG) ============
console.log("\n-- Part G: PostgreSQL retention bookkeeping (compose Postgres) --");
let pgOk = false;
let pgClient = null;
try {
  const { default: pg } = await import("pg");
  pgClient = new pg.Client({
    host: process.env.PGHOST || "127.0.0.1",
    port: Number(process.env.PGPORT || 5433),
    database: process.env.PGDATABASE || "cloner",
    user: process.env.PGUSER || "cloner",
    password: process.env.PGPASSWORD || "cloner_dev_password",
    connectionTimeoutMillis: 3000,
  });
  await pgClient.connect();
  pgOk = true;
} catch (e) {
  skip("G: PostgreSQL part", `compose Postgres unreachable (${String(e?.message || e).slice(0, 120)}) — start it with: docker compose up -d postgres`);
}

if (pgOk) {
  let testUserId = null;
  try {
    // apply ONLY the pre-existing 001 baseline (idempotent) + MY migration 014 —
    // the full ordered run over 002..013 belongs to the integrator.
    for (const file of ["001-initial.sql", "014-artifact-retention.sql"]) {
      const sql = fs.readFileSync(path.join(process.cwd(), "src", "database", "migrations", file), "utf8");
      await pgClient.query(sql);
      await pgClient.query(`INSERT INTO _migrations (id) VALUES ($1) ON CONFLICT (id) DO NOTHING`, [file]);
      console.log(`  [db] applied: ${file}`);
    }
    check("G: migration 014 applied additively (artifacts lifecycle columns exist)",
      (await pgClient.query(`SELECT column_name FROM information_schema.columns WHERE table_name='artifacts' AND column_name IN ('org_id','lifecycle_state','retention_class','expires_at','deleted_at','pinned','path')`)).rows.length === 7);

    // fixture rows (dummy hash — not a credential)
    const email = `artifact-lifecycle-test-${Date.now()}@example.invalid`;
    testUserId = (await pgClient.query(
      `INSERT INTO users (email, password_hash) VALUES ($1, $2) RETURNING id`,
      [email, crypto.randomUUID()])).rows[0].id;
    const taskId = (await pgClient.query(
      `INSERT INTO tasks (user_id, source_url) VALUES ($1, $2) RETURNING id`,
      [testUserId, "http://fixture.local/lifecycle"])).rows[0].id;

    const T_DB = Date.parse("2026-03-01T00:00:00.000Z");
    const iso = (ms) => new Date(ms).toISOString();
    // artifacts.org_id is a UUID column — the DB part uses real UUIDs (the
    // filesystem layer accepts any org string; the layers are independent)
    const orgA = crypto.randomUUID();
    const orgB = crypto.randomUUID();
    const ins = (path_, orgId, expiresAt, pinned = false) =>
      pgClient.query(
        `INSERT INTO artifacts (task_id, stage, artifact_type, storage_key, org_id, path, size_bytes, retention_class, expires_at, pinned)
         VALUES ($1,'exploration','page',$2,$3,$4,100,'temp',$5,$6) RETURNING id`,
        [taskId, path_, orgId, path_, expiresAt, pinned]);
    const aExpired = (await ins("alpha/job-expired/pages/a.png", orgA, iso(T_DB - 2 * DAY))).rows[0].id;
    const aFresh   = (await ins("alpha/job-fresh/pages/b.png", orgA, iso(T_DB + 30 * DAY))).rows[0].id;
    const aPinned  = (await ins("beta/job-pinned/pages/c.png", orgB, iso(T_DB - 2 * DAY), true)).rows[0].id;
    const aLegacy  = (await ins("job-legacy/pages/d.png", null, iso(T_DB - 2 * DAY))).rows[0].id;

    // dbMarkExpired with the injected clock: expired rows are STAGED (not deleted).
    // Scoped to THIS test's task so parallel runs sharing the compose DB don't interfere.
    const marked = await dbMarkExpired({ clock: clockAt(T_DB), client: pgClient, taskId });
    const markedIds = marked.map((r) => r.id).sort();
    check("G: dbMarkExpired (injected clock) stages exactly the expired, unpinned rows",
      markedIds.join(",") === [aExpired, aLegacy].sort().join(","), markedIds.join(","));
    check("G: staged rows are lifecycle_state='expired', NOT yet tombstoned",
      (await pgClient.query(`SELECT deleted_at FROM artifacts WHERE id = $1`, [aExpired])).rows[0].deleted_at === null);

    // dbPurgeExpired tombstones them (deleted_at set by the injected clock)
    const purged = await dbPurgeExpired({ clock: clockAt(T_DB + DAY), client: pgClient, taskId });
    check("G: dbPurgeExpired tombstones the staged rows with deleted_at",
      purged.map((r) => r.id).sort().join(",") === markedIds.join(",") &&
      (await pgClient.query(`SELECT lifecycle_state, deleted_at FROM artifacts WHERE id = $1`, [aExpired])).rows[0].lifecycle_state === "purged");

    check("G: fresh + pinned rows untouched by the DB sweep",
      (await pgClient.query(`SELECT lifecycle_state, deleted_at FROM artifacts WHERE id = ANY($1)`, [[aFresh, aPinned]]))
        .rows.every((r) => r.lifecycle_state === "active" && r.deleted_at === null));

    const usage = await dbUsageByOrg({ client: pgClient });
    const alphaUsage = usage.find((u) => u.orgId === orgA);
    const betaUsage = usage.find((u) => u.orgId === orgB);
    check("G: dbUsageByOrg groups retained artifacts per org (purged rows excluded)",
      alphaUsage?.artifacts === 1 && alphaUsage.bytes === 100 && betaUsage?.artifacts === 1,
      JSON.stringify(usage));
    check("G: two-stage DB sweep is idempotent (second pass touches nothing)",
      (await dbMarkExpired({ clock: clockAt(T_DB + 2 * DAY), client: pgClient, taskId })).length === 0 &&
      (await dbPurgeExpired({ clock: clockAt(T_DB + 2 * DAY), client: pgClient, taskId })).length === 0);
  } catch (e) {
    check("G: PostgreSQL part completed", false, String(e?.message || e));
  } finally {
    if (testUserId) { try { await pgClient.query(`DELETE FROM users WHERE id = $1`, [testUserId]); } catch {} }
    try { await pgClient.end(); } catch {}
  }
} else {
  skip("G: migration 014 application", "PostgreSQL unreachable — SKIP (compose Postgres not running)");
  skip("G: dbMarkExpired/dbPurgeExpired/dbUsageByOrg", "PostgreSQL unreachable — SKIP");
}

// ============ result ============
fs.rmSync(BASE, { recursive: true, force: true });
if (PREV_RETENTION === undefined) delete process.env.RETENTION_DAYS; else process.env.RETENTION_DAYS = PREV_RETENTION;
const fails = results.filter((r) => !r).length;
console.log(`\nRESULT: ${fails ? "FAIL" : "PASS"}  (${results.length - fails}/${results.length} checks passed)`);
process.exit(fails ? 1 : 0);
