#!/usr/bin/env node
// Regional artifact replication tests (task 4.2.3) — real filesystem, real
// HTTP, real queue, real auth. Two region roots live in a tmp dir (the ask's
// "mock 2 roots in tmp": the roots themselves are the LOCAL replicas — product
// code runs unmodified against them; nothing in src/ is mocked).
//
//   Part A — region config: REPLICATION_REGIONS parsing (paths, geo coords,
//            defaults, duplicates, garbage → clean errors), disabled-when-absent,
//            REPLICATION_DELIVERY_VERIFY mode guard.
//   Part B — copy-on-complete: org-scoped artifact tree (built through the REAL
//            createOrgArtifactStore) replicated to 2 tmp roots; per-region SHA256
//            manifest written; replica verified by hashing what LANDED.
//   Part C — SHA256 manifest + verify: corrupt byte → corrupt[]; deleted file →
//            missing[]; stray file → extra[] (informational); manifest removed →
//            fail-closed; "stat" vs "hash" mode honesty (same-size mutation).
//   Part D — nearest-region selection: haversine ordering (London → Paris beats
//            New York/Mumbai), named-region override, coordinate-less regions
//            sort last, no hint → configured order.
//   Part E — delivery resolution (pure): first HEALTHY region in proximity order
//            wins; broken nearest region skipped with the reason in the chain;
//            all broken → ORIGIN fallback; no regions → origin (feature off).
//   Part F — delivery API over HTTP: real express + REAL authRequired +
//            REAL resolveTenantScope (the exact integrator mount contract) on an
//            ephemeral port; real users/orgs/memberships in the compose Postgres
//            (loud SKIP if unreachable); owner-gated org jobs, anonymous
//            ownerless delivery, X-Client-Region steering, ?meta=1 resolution
//            JSON, origin-fallback headers, traversal guard, remote-anonymous 401.
//   Part G — copy-on-complete wired to the REAL queue: attachReplicationToQueue
//            + a memory-backend job reaching "completed" replicates; "error"
//            jobs do not; detach stops it.
//
// Requires the compose PostgreSQL for Part F only: docker compose up -d postgres.
// Runtime-generated throwaway emails/passwords only; everything created is cleaned up.
process.env.PGCONNECT_TIMEOUT = process.env.PGCONNECT_TIMEOUT || "4";
delete process.env.CLONER_REDIS_URL;
delete process.env.REDIS_URL; // force the deterministic memory queue backend

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import http from "node:http";
import express from "express";

import { fileURLToPath } from "node:url";
const PROJECT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
process.chdir(PROJECT);

const results = [];
const check = (name, ok, detail = "") => {
  results.push(ok);
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
};

const watchdog = setTimeout(() => { console.log("FAIL  global timeout (120s)"); process.exit(1); }, 120_000);
watchdog.unref();

// isolated base so the repo's real artifacts/ dir is never touched
const BASE = fs.mkdtempSync(path.join(os.tmpdir(), "cloner-replication-"));
const REGION_ROOTS = {
  "eu-west": path.join(BASE, "regions", "eu-west"),
  "us-east": path.join(BASE, "regions", "us-east"),
  "ap-south": path.join(BASE, "regions", "ap-south"),
};
const TEST_ENV = {
  // two tmp roots for most parts; ap-south joins the geo part via its own env.
  // Coordinate syntax is name@lat:lon — the comma stays the REGION separator.
  REPLICATION_REGIONS: `eu-west@48.8566:2.3522=${REGION_ROOTS["eu-west"]};us-east@40.7128:-74.0060=${REGION_ROOTS["us-east"]}`,
};
process.on("exit", () => { try { fs.rmSync(BASE, { recursive: true, force: true }); } catch {} });

const {
  parseRegionsEnv, loadRegions, deliveryVerifyMode, haversineKm, orderRegionsByProximity,
  replicaDirFor, listTreeFiles, buildReplicationManifest, replicateOnComplete,
  verifyReplica, verifyAllRegions, replicationStatus, resolveDelivery,
  attachReplicationToQueue, createReplicationRouter, REPLICATION_MANIFEST_NAME, sha256Bytes,
} = await import("../src/storage/artifact-replication.js");

const { createOrgArtifactStore, sha256File } = await import("../src/storage/artifact-lifecycle.js");
const { authRequired } = await import("../src/auth/auth-middleware.js");
const { resolveTenantScope } = await import("../src/platform/tenant-scope.js");

const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...crypto.randomBytes(48)]); // real-ish binary asset

// build a realistic org-scoped artifact tree through the REAL lifecycle store
function seedJob({ orgId, jobId }) {
  const store = createOrgArtifactStore({ base: BASE, orgId, jobId, retentionClass: "completed" });
  store.writeJson("pages/page-1.json", { url: "https://fixture.local/", title: "Fixture", blocks: 12 });
  store.writeJson("graph/graph.json", { nodes: 3, edges: 2 });
  store.writeBinary("assets/logo.png", png);
  store.writeText("reports/verify.md", `# verify ${jobId}\nall stages passed\n`);
  return store.dir;
}

// ============ Part A: region configuration ============
console.log("\n-- Part A: region configuration (REPLICATION_REGIONS) --");
{
  const parsed = parseRegionsEnv("eu-west@48.85:2.35=D:/r/eu; us-east@40.71:-74.00=D:/r/us , ap-south");
  check("A: parses paths + geo coordinates", parsed.length === 3 &&
    parsed[0].name === "eu-west" && parsed[0].root === "D:/r/eu" && parsed[0].lat === 48.85 && parsed[0].lon === 2.35 &&
    parsed[1].lat === 40.71 && parsed[1].lon === -74.0, JSON.stringify(parsed));
  check("A: path-less region defaults to <base>/replicas/<name>",
    loadRegions({ env: { REPLICATION_REGIONS: "ap-south" }, base: BASE }).regions[0].root === path.join(BASE, "replicas", "ap-south"));
  check("A: names are normalized (trimmed, lowercased)",
    parseRegionsEnv("  EU-West = D:/x ").map((r) => r.name).join() === "eu-west");
  check("A: duplicate region names collapse (first wins)",
    parseRegionsEnv("eu=D:/a,eu=D:/b").length === 1 && parseRegionsEnv("eu=D:/a,eu=D:/b")[0].root === "D:/a");
  check("A: empty env → disabled (clean no-op, not a crash)", loadRegions({ env: {}, base: BASE }).enabled === false);
  for (const bad of ["=D:/x", "BAD NAME=D:/x", "eu@99:0=D:/x", "eu@0.0.0=D:/x", "eu="]) {
    let threw = null;
    try { parseRegionsEnv(bad); } catch (e) { threw = e.message; }
    check(`A: rejects "${bad}" with a clean error`, !!threw, threw || "no error");
  }
  check("A: verify mode guard (bad REPLICATION_DELIVERY_VERIFY → clean error)",
    (() => { try { deliveryVerifyMode({ REPLICATION_DELIVERY_VERIFY: "yolo" }); return false; } catch (e) { return /not one of/.test(e.message); } })());
  check("A: verify mode defaults to hash", deliveryVerifyMode({}) === "hash" && deliveryVerifyMode({ REPLICATION_DELIVERY_VERIFY: "stat" }) === "stat");
}

// ============ Part B: copy-on-complete to 2 tmp roots ============
console.log("\n-- Part B: copy-on-complete to 2 tmp roots (SHA256 manifest) --");
let ORIGINS = {};
{
  ORIGINS.anon = path.join(BASE, "artifacts", "job-anon"); // legacy-scope origin tree
  fs.mkdirSync(path.join(ORIGINS.anon, "assets"), { recursive: true });
  fs.writeFileSync(path.join(ORIGINS.anon, "manifest.json"), JSON.stringify({ jobId: "job-anon", status: "completed" }));
  fs.writeFileSync(path.join(ORIGINS.anon, "index.html"), "<html><body>anon clone</body></html>");
  fs.writeFileSync(path.join(ORIGINS.anon, "assets", "logo.png"), png); // real binary asset for delivery checks

  ORIGINS.org = seedJob({ orgId: "org-repl", jobId: "job-org" });
  ORIGINS.orgFiles = listTreeFiles(ORIGINS.org);

  const res = replicateOnComplete({ jobId: "job-org", orgId: "org-repl", base: BASE, env: TEST_ENV, clock: () => Date.parse("2026-01-01T00:00:00Z") });
  check("B: both tmp roots received the replica (enabled, 0 failed)",
    res.enabled === true && res.replicated.length === 2 && res.failed.length === 0, JSON.stringify(res.replicated.map((r) => r.region)));
  for (const region of ["eu-west", "us-east"]) {
    const r = res.replicated.find((x) => x.region === region);
    check(`B: ${region} replica dir mirrors the org layout (<root>/<orgId>/<jobId>)`,
      r.dir === path.join(REGION_ROOTS[region], "org-repl", "job-org"), r.dir);
    const manifest = JSON.parse(fs.readFileSync(path.join(r.dir, REPLICATION_MANIFEST_NAME), "utf8"));
    const srcFiles = listTreeFiles(ORIGINS.org);
    check(`B: ${region} manifest carries replication:1 + job identity + fixed clock`,
      manifest.replication === 1 && manifest.jobId === "job-org" && manifest.orgId === "org-repl" &&
      manifest.region === region && manifest.replicatedAt === "2026-01-01T00:00:00.000Z" && manifest.originScope === "org");
    check(`B: ${region} manifest lists every source file with sha256 + size (manifest itself excluded)`,
      manifest.files.length === srcFiles.length &&
      manifest.files.every((f, i) => f.path === srcFiles[i].path && f.size === srcFiles[i].size && /^[0-9a-f]{64}$/.test(f.sha256)) &&
      !manifest.files.some((f) => f.path === REPLICATION_MANIFEST_NAME),
      `files=${manifest.files.length}`);
    check(`B: ${region} manifest digests match the SOURCE bytes`,
      manifest.files.every((f) => f.sha256 === sha256File(path.join(ORIGINS.org, f.path))));
    check(`B: ${region} replica verified by hashing what LANDED (verified.ok)`, r.verified?.ok === true && r.ok === true);
    check(`B: ${region} replica bytes on disk == origin bytes`,
      listTreeFiles(r.dir).reduce((n, f) => n + f.size, 0) === manifest.bytes && manifest.bytes > 0);
    // byte-for-byte content equality on the binary asset (a human would diff this)
    const copied = fs.readFileSync(path.join(r.dir, "assets", "logo.png"));
    check(`B: ${region} binary asset byte-identical to origin`, copied.equals(png));
  }
  // legacy-scope job replicates to <root>/<jobId>
  const resAnon = replicateOnComplete({ jobId: "job-anon", base: BASE, env: TEST_ENV });
  check("B: legacy-scope job mirrors the legacy layout (<root>/<jobId>)",
    resAnon.replicated.every((r) => r.dir === path.join(r.root, "job-anon")) && resAnon.failed.length === 0);
  check("B: re-replication is idempotent (no stale doubles, still verified)",
    (() => { const again = replicateOnComplete({ jobId: "job-org", orgId: "org-repl", base: BASE, env: TEST_ENV }); return again.failed.length === 0 && again.replicated.every((r) => r.verified?.ok === true); })());
}

// ============ Part C: SHA256 manifest + verify honesty ============
console.log("\n-- Part C: SHA256 manifest + verify --");
{
  const okAll = verifyAllRegions({ jobId: "job-org", orgId: "org-repl", base: BASE, env: TEST_ENV });
  check("C: verifyAllRegions → both regions ok (hash mode)", okAll.length === 2 && okAll.every((v) => v.ok && v.manifestOk && v.mode === "hash"));

  const eu = replicaDirFor(REGION_ROOTS["eu-west"], { orgId: "org-repl", jobId: "job-org" });
  const victim = path.join(eu, "reports", "verify.md");
  const original = fs.readFileSync(victim);
  fs.writeFileSync(victim, Buffer.from(original.toString().replace("passed", "FAILED"))); // same-ish size content mutation
  const vCorrupt = verifyReplica({ jobId: "job-org", orgId: "org-repl", root: REGION_ROOTS["eu-west"], base: BASE, mode: "hash" });
  check("C: content mutation detected as corrupt[] with sha256 mismatch, ok=false",
    vCorrupt.ok === false && vCorrupt.corrupt.length === 1 && /sha256/.test(vCorrupt.corrupt[0].reason) && vCorrupt.missing.length === 0,
    JSON.stringify(vCorrupt.corrupt));
  const vStat = verifyReplica({ jobId: "job-org", orgId: "org-repl", root: REGION_ROOTS["eu-west"], base: BASE, mode: "stat" });
  check("C: honest mode difference — stat cannot see a same-size mutation (documented), hash can",
    vStat.ok === true && vCorrupt.ok === false);
  fs.writeFileSync(victim, original);
  check("C: restored file verifies clean again",
    verifyReplica({ jobId: "job-org", orgId: "org-repl", root: REGION_ROOTS["eu-west"], base: BASE, mode: "hash" }).ok === true);

  const asset = path.join(eu, "assets", "logo.png");
  const assetBytes = fs.readFileSync(asset);
  fs.rmSync(asset);
  const vMissing = verifyReplica({ jobId: "job-org", orgId: "org-repl", root: REGION_ROOTS["eu-west"], base: BASE, mode: "hash" });
  check("C: deleted file → missing[], ok=false", vMissing.missing.includes("assets/logo.png") && vMissing.ok === false);
  const vStatMissing = verifyReplica({ jobId: "job-org", orgId: "org-repl", root: REGION_ROOTS["eu-west"], base: BASE, mode: "stat" });
  check("C: stat mode still catches a deleted file (size check)", vStatMissing.ok === false && vStatMissing.missing.length === 1);
  fs.writeFileSync(asset, assetBytes);

  fs.writeFileSync(path.join(eu, "stray.txt"), "not in the manifest");
  const vExtra = verifyReplica({ jobId: "job-org", orgId: "org-repl", root: REGION_ROOTS["eu-west"], base: BASE, mode: "hash" });
  check("C: unlisted stray file → extra[] (informational, content promise still held)",
    vExtra.extra.includes("stray.txt") && vExtra.ok === true);
  fs.rmSync(path.join(eu, "stray.txt"));

  fs.rmSync(path.join(eu, REPLICATION_MANIFEST_NAME));
  const vNoManifest = verifyReplica({ jobId: "job-org", orgId: "org-repl", root: REGION_ROOTS["eu-west"], base: BASE, mode: "hash" });
  check("C: manifest removed → fail-closed (manifestOk=false, ok=false)",
    vNoManifest.manifestOk === false && vNoManifest.ok === false);
  const res = replicateOnComplete({ jobId: "job-org", orgId: "org-repl", base: BASE, env: TEST_ENV }); // re-replicate restores
  check("C: re-replication after manifest loss restores + verifies", res.replicated.every((r) => r.verified?.ok === true));
  check("C: unknown region name → clean not-ok result",
    verifyReplica({ jobId: "x", region: "mars", base: BASE, env: TEST_ENV }).ok === false);
}

// ============ Part D: nearest-region selection ============
console.log("\n-- Part D: nearest-region selection (haversine) --");
{
  const three = parseRegionsEnv(`eu-west@48.8566:2.3522=${REGION_ROOTS["eu-west"]};us-east@40.7128:-74.0060=${REGION_ROOTS["us-east"]};ap-south@19.0760:72.8777=${REGION_ROOTS["ap-south"]}`)
    .map((r) => ({ ...r, root: path.resolve(r.root) }));
  const london = orderRegionsByProximity(three, { lat: 51.5074, lon: -0.1278 }).map((r) => r.name);
  check("D: London client → Paris (eu-west) is nearest, then New York, then Mumbai",
    JSON.stringify(london) === JSON.stringify(["eu-west", "us-east", "ap-south"]), london.join(" > "));
  const dParis = haversineKm(51.5074, -0.1278, 48.8566, 2.3522);
  const dMumbai = haversineKm(51.5074, -0.1278, 19.076, 72.8777);
  check("D: haversine sanity — Paris≈344km from London, Mumbai≈7190km", Math.abs(dParis - 344) < 15 && Math.abs(dMumbai - 7190) < 60,
    `paris=${dParis.toFixed(0)}km mumbai=${dMumbai.toFixed(0)}km`);
  check("D: named region overrides distance (client asks us-east)",
    orderRegionsByProximity(three, { region: "US-East", lat: 51.5074, lon: -0.1278 })[0].name === "us-east");
  check("D: named region not configured → falls back to distance order",
    orderRegionsByProximity(three, { region: "mars", lat: 51.5, lon: -0.1 })[0].name === "eu-west");
  const geoless = [...three, { name: "z-late", root: path.join(BASE, "regions", "z"), lat: null, lon: null }];
  check("D: coordinate-less region sorts last under a geo hint",
    orderRegionsByProximity(geoless, { lat: 51.5, lon: -0.1 }).map((r) => r.name).slice(-1)[0] === "z-late");
  check("D: no client hint → configured order preserved",
    JSON.stringify(orderRegionsByProximity(three, {}).map((r) => r.name)) === JSON.stringify(["eu-west", "us-east", "ap-south"]));
}

// ============ Part E: delivery resolution (pure) ============
console.log("\n-- Part E: delivery resolution — nearest healthy region wins --");
{
  const d = resolveDelivery({ jobId: "job-org", orgId: "org-repl", file: "assets/logo.png", client: { lat: 51.5074, lon: -0.1278 }, base: BASE, env: TEST_ENV });
  check("E: healthy nearest replica serves (served=replica, eu-west, verified=true)",
    d.served === "replica" && d.region === "eu-west" && d.verified === true && d.fallback === false && d.exists === true, d.region);
  check("E: resolution records the decision chain", d.chain.length === 1 && d.chain[0].picked === true && d.chain[0].region === "eu-west");

  // break eu-west → next-nearest (us-east) serves, with the rejection on record
  const euLogo = path.join(d.dir, "assets", "logo.png");
  const euLogoBytes = fs.readFileSync(euLogo);
  fs.writeFileSync(euLogo, Buffer.concat([euLogoBytes.subarray(0, 10), Buffer.from([0, 0, 0]), euLogoBytes.subarray(13)]));
  const d2 = resolveDelivery({ jobId: "job-org", orgId: "org-repl", file: "assets/logo.png", client: { lat: 51.5074, lon: -0.1278 }, base: BASE, env: TEST_ENV });
  check("E: broken nearest region is SKIPPED — us-east serves instead",
    d2.served === "replica" && d2.region === "us-east" && d2.verified === true, d2.region);
  check("E: chain shows the eu-west rejection reason",
    d2.chain[0].region === "eu-west" && d2.chain[0].picked === false && /verify failed/.test(d2.chain[0].reason), d2.chain[0].reason);
  check("E: served bytes are the HEALTHY replica's, not the corrupted one",
    fs.readFileSync(d2.filePath).equals(euLogoBytes));

  // break us-east too → origin fallback
  const usDir = replicaDirFor(REGION_ROOTS["us-east"], { orgId: "org-repl", jobId: "job-org" });
  fs.writeFileSync(path.join(usDir, "assets", "logo.png"), Buffer.from("corrupted!"));
  const d3 = resolveDelivery({ jobId: "job-org", orgId: "org-repl", file: "assets/logo.png", client: { lat: 51.5074, lon: -0.1278 }, base: BASE, env: TEST_ENV });
  check("E: all replicas broken → ORIGIN fallback (fallback=true, reason recorded)",
    d3.served === "origin" && d3.fallback === true && /origin fallback/.test(d3.reason || "") && d3.exists === true, d3.reason);
  check("E: origin-served bytes are the original bytes", fs.readFileSync(d3.filePath).equals(euLogoBytes));
  fs.writeFileSync(euLogo, euLogoBytes);      // restore eu-west → replica delivery resumes
  const d4 = resolveDelivery({ jobId: "job-org", orgId: "org-repl", file: "assets/logo.png", client: { lat: 51.5074, lon: -0.1278 }, base: BASE, env: TEST_ENV });
  check("E: recovery — one healthy region restored → replica delivery resumes",
    d4.served === "replica" && d4.region === "eu-west");
  fs.writeFileSync(path.join(usDir, "assets", "logo.png"), euLogoBytes); // restore us-east too

  check("E: verify=off skips integrity checks (manifest presence only)",
    resolveDelivery({ jobId: "job-org", orgId: "org-repl", file: "manifest.json", base: BASE, env: TEST_ENV, verifyMode: "off" }).verified === false);
  check("E: no regions configured → origin with enabled=false semantics",
    (() => { const r = resolveDelivery({ jobId: "job-anon", file: "manifest.json", base: BASE, env: { REPLICATION_REGIONS: "" } }); return r.served === "origin" && r.fallback === false && !r.region; })());
  check("E: missing file inside a replica → exists=false (caller 404s)",
    resolveDelivery({ jobId: "job-org", orgId: "org-repl", file: "nope/ghost.bin", base: BASE, env: TEST_ENV }).exists === false);
  check("E: status() reports per-region replicated + healthy regions",
    (() => { const s = replicationStatus({ jobId: "job-org", orgId: "org-repl", base: BASE, env: TEST_ENV, deep: true }); return s.regions.length === 2 && s.regions.every((r) => r.replicated && r.verify?.ok) && JSON.stringify(s.healthy) === JSON.stringify(["eu-west", "us-east"]) && s.origin.exists; })());
}

// ============ Part F: delivery API over real HTTP + real auth ============
console.log("\n-- Part F: delivery API (real express + real auth + real PG) --");
let pgUp = false;
{
  const { query, closePool } = await import("../src/database/client.js");
  try { await query("SELECT 1"); pgUp = true; } catch { pgUp = false; }

  if (!pgUp) {
    console.log("SKIP  Part F — PostgreSQL unreachable (start with: docker compose up -d postgres). Parts A–E above are DB-free and ran.");
  } else {
    // baseline tables (same bootstrap the other platform suites use)
    await query(`CREATE TABLE IF NOT EXISTS _migrations (id TEXT PRIMARY KEY, applied_at TIMESTAMPTZ DEFAULT now())`);
    for (const file of ["001-initial.sql", "011-org-members.sql"]) {
      const applied = await query("SELECT 1 FROM _migrations WHERE id = $1", [file]);
      if (!applied.rows.length) {
        await query(fs.readFileSync(path.join(PROJECT, "src", "database", "migrations", file), "utf8"));
        await query("INSERT INTO _migrations (id) VALUES ($1) ON CONFLICT DO NOTHING", [file]);
        console.log(`[db] applied: ${file}`);
      }
    }
    const auth = await import("../src/auth/auth-service.js");
    const orgs = await import("../src/platform/org-service.js");
    const uniq = () => crypto.randomBytes(5).toString("hex");
    const password = "R3pl-" + uniq() + "!x";
    const mkUser = async () => { const email = `repl-${uniq()}@fixture.local`; return { ...(await auth.registerUser(email, password)), email, password }; };
    const owner = await mkUser(), member = await mkUser(), outsider = await mkUser();
    const login = async (u) => (await auth.loginUser(u.email, password)).token;
    const ownerToken = await login(owner), memberToken = await login(member), outsiderToken = await login(outsider);

    const org = await orgs.createOrg({ userId: owner.id, name: "Repl Test " + uniq(), slug: "repl-" + uniq() });
    const invite = await orgs.inviteMember({ orgId: org.org.id, actorId: owner.id, email: member.email, role: "member" });
    await orgs.acceptInvitation(invite.token, member.id);

    // register the org job in the REAL queue registry so owner-gating has a real
    // owner (same mechanics the pipeline uses; no crawl — the artifacts tree is
    // seeded directly through the real lifecycle store)
    const { getCloneQueue } = await import("../src/queues/clone-queue.js");
    const qF = getCloneQueue();
    qF.enqueue({
      jobId: "job-orgapi", owner: { userId: owner.id, orgId: org.org.id },
      payload: { url: "https://fixture.local/api" },
      run: async ({ entry, report }) => { entry.status = "completed"; report("completed"); },
    });
    await qF.whenIdle();

    // org-scoped job owned by the org + ownerless legacy job
    ORIGINS.orgApi = seedJob({ orgId: org.org.id, jobId: "job-orgapi" });
    fs.writeFileSync(path.join(ORIGINS.orgApi, "pages", "page-2.json"), JSON.stringify({ url: "https://fixture.local/2" }));
    replicateOnComplete({ jobId: "job-orgapi", orgId: org.org.id, base: BASE, env: TEST_ENV });
    replicateOnComplete({ jobId: "job-anon", base: BASE, env: TEST_ENV });

    const app = express();
    app.use(express.json());
    // the EXACT integrator mount contract (server.js is integrator-owned)
    app.use("/api/replication", createReplicationRouter({ authRequired, tenantScope: resolveTenantScope, base: BASE, env: TEST_ENV }));
    const server = http.createServer(app);
    const port = await new Promise((r) => server.listen(0, () => r(server.address().port)));
    const url = (p) => `http://127.0.0.1:${port}${p}`;
    const get = async (p, { headers = {} } = {}) => {
      const res = await fetch(url(p), { headers });
      const buf = Buffer.from(await res.arrayBuffer()); // byte-faithful (binary assets round-trip)
      let body = null; const text = buf.toString("utf8");
      try { body = JSON.parse(text); } catch { body = text; }
      return { status: res.status, headers: res.headers, body, buf };
    };
    const bearer = (t) => ({ authorization: `Bearer ${t}` });

    // 1) anonymous loopback, ownerless job, no hint → first configured region
    const r1 = await get("/api/replication/deliver/job-anon");
    check("F: ownerless job delivered anonymously (loopback) from the first configured region",
      r1.status === 200 && (r1.headers.get("x-served-from") || "").startsWith("replica:eu-west"), `${r1.status} ${r1.headers.get("x-served-from")}`);
    check("F: default file is the replica manifest.json and bytes match",
      (() => { const eu = replicaDirFor(REGION_ROOTS["eu-west"], { jobId: "job-anon" }); return r1.buf.equals(fs.readFileSync(path.join(eu, "manifest.json"))); })());

    // 2) geo hint steers to Paris; meta=1 returns the resolution JSON
    const r2 = await get(`/api/replication/deliver/job-anon/assets/logo.png?lat=51.5074&lon=-0.1278&meta=1`);
    check("F: ?meta=1 resolution — nearest region chosen by coordinates, verified",
      r2.status === 200 && r2.body.served === "replica" && r2.body.region === "eu-west" && r2.body.verified === true && r2.body.fallback === false,
      JSON.stringify(r2.body));
    const r2b = await get(`/api/replication/deliver/job-anon/assets/logo.png?lat=51.5074&lon=-0.1278`);
    check("F: bytes served over HTTP match the origin asset exactly", r2b.buf.equals(png) && (r2b.headers.get("content-length") || "") !== "");
    check("F: X-Served-From names the replica region",
      (r2b.headers.get("x-served-from") || "") === "replica:eu-west", r2b.headers.get("x-served-from"));

    // 3) region steering via header
    const r3 = await get("/api/replication/deliver/job-anon/manifest.json", { headers: { "x-client-region": "us-east" } });
    check("F: X-Client-Region header steers delivery (us-east pinned)",
      r3.status === 200 && (r3.headers.get("x-served-from") || "") === "replica:us-east", r3.headers.get("x-served-from"));

    // 4) broken nearest region → next region serves, chain explains why
    const euAnon = replicaDirFor(REGION_ROOTS["eu-west"], { jobId: "job-anon" });
    const idxHtml = path.join(euAnon, "index.html");
    fs.writeFileSync(idxHtml, "<html><body>TAMPERED</body></html>");
    const r4 = await get("/api/replication/deliver/job-anon/index.html?lat=51.5074&lon=-0.1278");
    check("F: corrupted eu-west replica → us-east serves over HTTP",
      r4.status === 200 && (r4.headers.get("x-served-from") || "") === "replica:us-east", r4.headers.get("x-served-from"));
    const r4m = await get("/api/replication/deliver/job-anon/index.html?lat=51.5074&lon=-0.1278&meta=1");
    check("F: meta chain records the eu-west rejection",
      r4m.body.chain[0].region === "eu-west" && r4m.body.chain[0].picked === false && /verify failed/.test(r4m.body.chain[0].reason));
    fs.writeFileSync(idxHtml, "<html><body>anon clone</body></html>");

    // 5) both regions broken → origin fallback with explicit headers
    fs.rmSync(path.join(euAnon, REPLICATION_MANIFEST_NAME));
    const usAnon = replicaDirFor(REGION_ROOTS["us-east"], { jobId: "job-anon" });
    fs.rmSync(path.join(usAnon, REPLICATION_MANIFEST_NAME));
    const r5 = await get("/api/replication/deliver/job-anon/manifest.json");
    check("F: all replicas gone → origin fallback (X-Replication-Fallback: 1)",
      r5.status === 200 && (r5.headers.get("x-served-from") || "") === "origin" && r5.headers.get("x-replication-fallback") === "1");
    replicateOnComplete({ jobId: "job-anon", base: BASE, env: TEST_ENV }); // restore replicas

    // 6) misses: unknown job, unknown file, traversal
    check("F: unknown job → 404", (await get("/api/replication/deliver/job-ghost")).status === 404);
    check("F: unknown file inside a known job → 404", (await get("/api/replication/deliver/job-anon/nope.bin")).status === 404);
    const trav = await get("/api/replication/deliver/job-anon/%2e%2e%2f%2e%2e%2fsecret.txt");
    check("F: ../-encoded traversal → 404 (contained, nothing outside the tree served)", trav.status === 404);

    // 7) org-owned job: owner ok, member ok, outsider 404, anonymous 404
    const orgBase = "/api/replication/deliver/job-orgapi";
    check("F: org owner (Bearer) delivers the org job",
      (await get(`${orgBase}/pages/page-1.json`, { headers: bearer(ownerToken) })).status === 200);
    check("F: org member (Bearer) delivers the org job",
      (await get(`${orgBase}/pages/page-1.json`, { headers: bearer(memberToken) })).status === 200);
    check("F: outsider (Bearer) gets 404 — no existence leak",
      (await get(`${orgBase}/pages/page-1.json`, { headers: bearer(outsiderToken) })).status === 404);
    check("F: anonymous caller on an OWNED job → 404 (fail closed)",
      (await get(`${orgBase}/pages/page-1.json`)).status === 404);
    check("F: invalid token → 401 (real authRequired enforces)",
      (await get(`${orgBase}/pages/page-1.json`, { headers: { authorization: "Bearer not-a-real-token" } })).status === 401);

    // 8) status route (owner) + tenant scoping via X-Org-Id
    const s1 = await get(`/api/replication/status/job-orgapi?deep=1`, { headers: bearer(ownerToken) });
    check("F: status (owner, deep) → 2 replicated regions, verify.ok each, origin exists",
      s1.status === 200 && s1.body.regions.length === 2 && s1.body.regions.every((r) => r.replicated && r.verify?.ok) && s1.body.origin.exists === true,
      JSON.stringify(s1.body.regions?.map?.((r) => r.region)));
    const s2 = await get(`/api/replication/status/job-orgapi`, { headers: { ...bearer(memberToken), "x-org-id": org.org.id } });
    check("F: member + X-Org-Id resolves the tenant scope and sees the status",
      s2.status === 200 && s2.body.regions.length === 2);
    check("F: outsider + X-Org-Id → 403 cross-tenant denial (real resolveTenantScope)",
      (await get(`/api/replication/status/job-orgapi`, { headers: { ...bearer(outsiderToken), "x-org-id": org.org.id } })).status === 403);

    // 9) remote anonymous → 401 (isLoopback injected false = remote simulator)
    const remoteApp = express();
    remoteApp.use("/api/replication", createReplicationRouter({ authRequired, base: BASE, env: TEST_ENV, isLoopback: () => false }));
    const remoteServer = http.createServer(remoteApp);
    const rport = await new Promise((r) => remoteServer.listen(0, () => r(remoteServer.address().port)));
    const rRemote = await fetch(`http://127.0.0.1:${rport}/api/replication/deliver/job-anon`);
    check("F: REMOTE anonymous caller → 401 authentication required", rRemote.status === 401);
    remoteServer.close();

    // 10) bad verify mode env → clean 400 on delivery (no crash)
    const badApp = express();
    badApp.use("/api/replication", createReplicationRouter({ base: BASE, env: { ...TEST_ENV, REPLICATION_DELIVERY_VERIFY: "yolo" } }));
    const badServer = http.createServer(badApp);
    const bport = await new Promise((r) => badServer.listen(0, () => r(badServer.address().port)));
    const rBad = await fetch(`http://127.0.0.1:${bport}/api/replication/deliver/job-anon`);
    check("F: bad REPLICATION_DELIVERY_VERIFY → clean 400, not a crash", rBad.status === 400);
    badServer.close();

    await new Promise((r) => server.close(r));
  }
  try { await closePool?.(); } catch {}
}

// ============ Part G: copy-on-complete wired to the real queue ============
console.log("\n-- Part G: copy-on-complete via attachReplicationToQueue (real queue) --");
{
  // attachReplicationToQueue reads the REAL process env (production wiring) —
  // point it at the two tmp roots for the duration of this part
  const PREV_ENV = process.env.REPLICATION_REGIONS;
  process.env.REPLICATION_REGIONS = TEST_ENV.REPLICATION_REGIONS;
  try {
  const { getCloneQueue } = await import("../src/queues/clone-queue.js");
  const queue = getCloneQueue();
  check("G: queue backend is memory (deterministic; REDIS_URL unset)", queue.backend === "memory", queue.backend);

  const logs = [];
  const detach = attachReplicationToQueue(queue, { base: BASE, log: (m) => logs.push(m) });

  // completed job → replicated to BOTH regions
  seedJob({ orgId: "org-qrepl", jobId: "job-qok" });
  queue.enqueue({
    jobId: "job-qok", owner: { userId: null, orgId: "org-qrepl" },
    payload: { url: "https://fixture.local/ok" },
    run: async ({ entry, report }) => { entry.status = "completed"; report("completed"); },
  });
  await queue.whenIdle();
  const waitFor = async (fn, ms = 8000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (fn()) return true; await new Promise((r) => setTimeout(r, 100)); } return fn(); };
  const landed = await waitFor(() => ["eu-west", "us-east"].every((region) =>
    fs.existsSync(path.join(replicaDirFor(REGION_ROOTS[region], { orgId: "org-qrepl", jobId: "job-qok" }), REPLICATION_MANIFEST_NAME))));
  check("G: terminal 'completed' through the REAL queue → both regions populated", landed,
    logs.find((l) => l.includes("job-qok")) || "no replication log");

  // error job → NOT replicated
  seedJob({ orgId: "org-qrepl", jobId: "job-qerr" });
  queue.enqueue({
    jobId: "job-qerr", owner: { userId: null, orgId: "org-qrepl" },
    payload: { url: "https://fixture.local/err" },
    run: async ({ entry, report }) => { entry.status = "error"; report("error"); },
  });
  await queue.whenIdle();
  await new Promise((r) => setTimeout(r, 400));
  check("G: terminal 'error' job is NOT replicated",
    !fs.existsSync(path.join(replicaDirFor(REGION_ROOTS["eu-west"], { orgId: "org-qrepl", jobId: "job-qerr" }), REPLICATION_MANIFEST_NAME)));

  // detach → no further replication
  detach();
  seedJob({ orgId: "org-qrepl", jobId: "job-qpost" });
  queue.enqueue({
    jobId: "job-qpost", owner: { userId: null, orgId: "org-qrepl" },
    payload: { url: "https://fixture.local/post" },
    run: async ({ entry, report }) => { entry.status = "completed"; report("completed"); },
  });
  await queue.whenIdle();
  await new Promise((r) => setTimeout(r, 400));
  check("G: detach() stops replication wiring",
    !fs.existsSync(path.join(replicaDirFor(REGION_ROOTS["eu-west"], { orgId: "org-qrepl", jobId: "job-qpost" }), REPLICATION_MANIFEST_NAME)));
  } finally {
    if (PREV_ENV === undefined) delete process.env.REPLICATION_REGIONS;
    else process.env.REPLICATION_REGIONS = PREV_ENV;
  }
}

// ============ Part H: failure modes ============
console.log("\n-- Part H: failure modes (no regions, missing origin) --");
{
  const noEnv = { REPLICATION_REGIONS: "" };
  const r = replicateOnComplete({ jobId: "job-anon", base: BASE, env: noEnv });
  check("H: no regions configured → documented no-op (enabled=false, nothing written)",
    r.enabled === false && /no regions configured/.test(r.reason) && r.replicated.length === 0);
  let threw = null;
  try { replicateOnComplete({ jobId: "job-never-existed", base: BASE, env: TEST_ENV }); } catch (e) { threw = e.message; }
  check("H: missing origin tree → clean error naming the job + path", /no artifact tree for job "job-never-existed"/.test(threw || ""), threw);
  let threw2 = null;
  try { resolveDelivery({ jobId: null }); } catch (e) { threw2 = e.message; }
  check("H: resolveDelivery without jobId → clean error", /jobId is required/.test(threw2 || ""));
  check("H: sha256Bytes sanity (matches crypto.digest)",
    sha256Bytes(Buffer.from("cloner")) === crypto.createHash("sha256").update("cloner").digest("hex"));
}

// ---------- summary ----------
const failed = results.filter((x) => !x).length;
console.log(`\n${"=".repeat(78)}\n${results.length - failed}/${results.length} checks passed${failed ? ` — ${failed} FAILED` : " — ALL GREEN"}`);
process.exit(failed ? 1 : 0);
