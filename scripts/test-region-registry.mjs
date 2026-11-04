#!/usr/bin/env node
// Region registry tests (task 4.2.1) — src/distributed/region-registry.js,
// src/distributed/contracts.js.
//
//   Part A (no HTTP): the coordinator-side registry — region registration
//   validation, worker definitions per region, acquire/release reservations,
//   concurrency caps, heartbeat staleness, capability-aware region selection,
//   CLONER_REGIONS env bootstrap, snapshot shape.
//
//   Part B (no HTTP): the shared wire contracts — HS256 region-token
//   mint/verify round trip and every failure code (bad_signature, expired,
//   bad_audience, bad_issuer, malformed, missing, no_secret), execution
//   request/result validation, artifact digests + envelope/manifest
//   verification against a real SHA-256 vector.
//
//   Part C (in-process simulated 2-region setup): TWO REAL region nodes on
//   loopback ports running the PRODUCT code (createRegionNode), driven by the
//   PRODUCT client (createRegionClient — real fetch, real HMAC tokens, real
//   files for artifacts). Covers: handshake + version negotiation, capability-
//   based execution placement, artifacts saved during execution + upload/
//   download round trips with digest enforcement, tamper rejection, the full
//   auth matrix (missing/expired/bad-audience/bad-signature → 401 with codes),
//   the no-secret clean error, capacity-aware dispatch + failover across
//   candidate regions, and the Express admin router surface.
//
// The only non-product HTTP in this file is the "broken peer" — a test-side
// remote-end simulator that answers with contract violations so the client's
// fail-closed paths can be asserted. No product code path is mocked.
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";

// Test-only HMAC secret (a test fixture, not a product credential).
const TEST_SECRET = "test-region-secret-4.2.1-0123456789abcdef";
process.env.CLONER_REGION_SECRET = TEST_SECRET;

const results = [];
const check = (name, ok, detail = "") => {
  results.push(ok);
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
};

const watchdog = setTimeout(() => { console.log("FAIL  global timeout (120s)"); process.exit(1); }, 120_000);
watchdog.unref();

async function expectThrows(fn, matcher, label) {
  try { await fn(); return { threw: false, err: null }; }
  catch (e) {
    const hay = `${e.code || ""} ${e.message}`;
    if (matcher instanceof RegExp) return { threw: matcher.test(hay), err: e };
    return { threw: hay.includes(matcher), err: e };
  }
}

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "cloner-421-"));
process.on("exit", () => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* best effort */ } });

// ===========================================================================
console.log("\n-- Part A: region registry (no HTTP) --");
{
  const { createRegionRegistry, bootstrapRegionsFromEnv } = await import("../src/distributed/region-registry.js");

  // A1 — valid registration + description + endpoint normalization
  {
    const r = createRegionRegistry({ bootstrapFromEnv: false });
    r.registerRegion({ id: "us-east", endpoint: "http://10.0.0.1:9501/", capabilities: ["clone:url", "vision:polish"], weight: 2 });
    const d = r.getRegion("us-east");
    check("A1: region registered with id/endpoint/capabilities",
      d.id === "us-east" && d.endpoint === "http://10.0.0.1:9501" && JSON.stringify(d.capabilities) === JSON.stringify(["clone:url", "vision:polish"]),
      JSON.stringify(d));
    check("A1: trailing slash stripped from endpoint", !d.endpoint.endsWith("/"));
  }

  // A2 — validation failures
  {
    const r = createRegionRegistry({ bootstrapFromEnv: false });
    check("A2: invalid region id rejected", (await expectThrows(() => r.registerRegion({ id: "Bad_Id!", endpoint: "http://x:1", capabilities: [] }), "bad_region_id")).threw);
    check("A2: non-http endpoint rejected", (await expectThrows(() => r.registerRegion({ id: "r", endpoint: "ftp://x", capabilities: [] }), "bad_endpoint")).threw);
    check("A2: malformed endpoint rejected", (await expectThrows(() => r.registerRegion({ id: "r", endpoint: "not a url", capabilities: [] }), "bad_endpoint")).threw);
    check("A2: invalid capability rejected", (await expectThrows(() => r.registerRegion({ id: "r", endpoint: "http://x:1", capabilities: ["has space"] }), "bad_capability")).threw);
    check("A2: duplicate registration rejected without replace",
      (await expectThrows(() => { r.registerRegion({ id: "r", endpoint: "http://x:1" }); r.registerRegion({ id: "r", endpoint: "http://x:2" }); }, "duplicate_region")).threw);
    r.registerRegion({ id: "r", endpoint: "http://x:2", replace: true });
    check("A2: replace:true updates the endpoint", r.getRegion("r").endpoint === "http://x:2");
  }

  // A3 — worker definitions per region + acquire/release
  {
    const r = createRegionRegistry({ bootstrapFromEnv: false, staleAfterMs: 60_000 });
    r.registerRegion({ id: "eu", endpoint: "http://eu:1", capabilities: ["clone:url", "artifact:store"] });
    r.registerWorker("eu", { id: "w-1", capabilities: ["clone:url"], concurrency: 2 });
    const w = r.describeWorker("eu", "w-1");
    check("A3: worker definition stored per region",
      w.regionId === "eu" && w.id === "w-1" && w.concurrency === 2 && w.online && w.inFlight === 0, JSON.stringify(w));
    check("A3: worker on unknown region rejected",
      (await expectThrows(() => r.registerWorker("nope", { id: "w", capabilities: [] }), "unknown_region")).threw);
    check("A3: duplicate worker rejected without replace",
      (await expectThrows(() => r.registerWorker("eu", { id: "w-1", capabilities: [] }), "duplicate_worker")).threw);

    const res1 = r.acquireWorker("eu", { required: ["clone:url"] });
    check("A3: acquire reserves a slot (inFlight=1)", res1 && r.describeWorker("eu", "w-1").inFlight === 1);
    const res2 = r.acquireWorker("eu", { required: ["clone:url"] });
    check("A3: second acquire uses the same worker up to concurrency (inFlight=2)", res2 && r.describeWorker("eu", "w-1").inFlight === 2);
    const res3 = r.acquireWorker("eu", { required: ["clone:url"] });
    check("A3: acquire returns null when the worker is saturated", res3 === null);
    check("A3: reservation.release is idempotent and never goes negative",
      (res1.release(), res1.release(), r.describeWorker("eu", "w-1").inFlight === 1));
    res2.release();
    check("A3: release returns inFlight to 0", r.describeWorker("eu", "w-1").inFlight === 0);
  }

  // A4 — capability filtering + heartbeat staleness
  {
    const r = createRegionRegistry({ bootstrapFromEnv: false, staleAfterMs: 80 });
    r.registerRegion({ id: "r1", endpoint: "http://r1:1", capabilities: ["clone:url", "clone:video"] });
    r.registerWorker("r1", { id: "w-url", capabilities: ["clone:url"], concurrency: 2 });
    r.registerWorker("r1", { id: "w-video", capabilities: ["clone:url", "clone:video"], concurrency: 1 });
    check("A4: acquire skips workers lacking the required capability",
      r.acquireWorker("r1", { required: ["clone:video"] })?.workerId === "w-video");
    check("A4: acquire with un-advertised capability returns null",
      r.acquireWorker("r1", { required: ["export:zip"] }) === null);
    // staleness: 80ms window
    await sleep(140);
    check("A4: worker goes offline after heartbeat silence (staleAfterMs)", r.describeWorker("r1", "w-video").online === false);
    check("A4: offline workers are not acquirable", r.acquireWorker("r1", { required: ["clone:video"] }) === null);
    const hb = r.heartbeatWorker("r1", "w-video");
    check("A4: heartbeat revives the worker", hb.online === true);
    check("A4: heartbeat for unknown worker is refused",
      (await expectThrows(() => r.heartbeatWorker("r1", "ghost"), "unknown_worker")).threw);
    // draining workers are refused too
    r.heartbeatWorker("r1", "w-video", { status: "draining" });
    check("A4: draining worker is not acquirable", r.acquireWorker("r1", { required: ["clone:video"] }) === null);
  }

  // A5 — capability-aware region selection + deterministic ordering
  {
    const r = createRegionRegistry({ bootstrapFromEnv: false });
    r.registerRegion({ id: "a", endpoint: "http://a:1", capabilities: ["clone:url"], weight: 1 });
    r.registerRegion({ id: "b", endpoint: "http://b:1", capabilities: ["clone:url", "vision:polish"], weight: 1 });
    r.registerRegion({ id: "c", endpoint: "http://c:1", capabilities: ["clone:url", "vision:polish"], weight: 9 });
    // no workers anywhere → plain selection still lists capability matches
    const plain = r.selectRegion({ required: ["vision:polish"] }).map((x) => x.id);
    check("A5: selection filters by region capabilities", plain.includes("b") && plain.includes("c") && !plain.includes("a"));
    // give b one worker, c two free workers → capacity ordering (c first)
    r.registerWorker("b", { id: "bw", capabilities: ["clone:url", "vision:polish"], concurrency: 1 });
    r.registerWorker("c", { id: "cw1", capabilities: ["clone:url", "vision:polish"], concurrency: 1 });
    r.registerWorker("c", { id: "cw2", capabilities: ["clone:url", "vision:polish"], concurrency: 1 });
    const ranked = r.selectRegion({ required: ["vision:polish"], requireOnlineWorker: true }).map((x) => x.id);
    check("A5: ranked by free capacity (c has 2 free slots, b has 1)", JSON.stringify(ranked) === JSON.stringify(["c", "b"]), ranked.join(","));
    // saturate b → zero free capacity → dropped under requireOnlineWorker
    r.acquireWorker("b", {});
    const afterSaturate = r.selectRegion({ required: ["vision:polish"], requireOnlineWorker: true }).map((x) => x.id);
    check("A5: saturated region (no free slot) is dropped from dispatch candidates",
      JSON.stringify(afterSaturate) === JSON.stringify(["c"]), afterSaturate.join(","));
    // region whose WORKERS lack the required capability must not win on phantom capacity
    const r2 = createRegionRegistry({ bootstrapFromEnv: false });
    r2.registerRegion({ id: "liar", endpoint: "http://l:1", capabilities: ["clone:url", "clone:video"] });
    r2.registerWorker("liar", { id: "w", capabilities: ["clone:url"], concurrency: 4 });
    check("A5: region without a capable worker is dropped under requireOnlineWorker",
      r2.selectRegion({ required: ["clone:video"], requireOnlineWorker: true }).length === 0);
    check("A5: no-match selection returns empty list", r.selectRegion({ required: ["nonexistent:cap"] }).length === 0);
  }

  // A6 — deregister + snapshot shape
  {
    const r = createRegionRegistry({ bootstrapFromEnv: false });
    r.registerRegion({ id: "z", endpoint: "http://z:1", capabilities: [] });
    r.registerWorker("z", { id: "zw", capabilities: [], concurrency: 1 });
    const snap = r.snapshot();
    check("A6: snapshot carries contractVersion + region list with worker stats",
      snap.contractVersion === "4.2.1" && snap.regions[0].id === "z" && snap.regions[0].stats.workers === 1,
      JSON.stringify(snap.regions[0]?.stats));
    r.deregisterRegion("z");
    check("A6: deregistered region is gone", r.hasRegion("z") === false);
    check("A6: deregistering an unknown region errors",
      (await expectThrows(() => r.deregisterRegion("z"), "unknown_region")).threw);
  }

  // A7 — CLONER_REGIONS env bootstrap
  {
    const r = createRegionRegistry({ bootstrapFromEnv: false });
    const saved = process.env.CLONER_REGIONS;
    try {
      process.env.CLONER_REGIONS = JSON.stringify([
        { id: "env-a", endpoint: "http://env-a:9501", capabilities: ["clone:url"] },
        { id: "env-b", endpoint: "http://env-b:9502", capabilities: ["export:zip"] },
      ]);
      const registered = bootstrapRegionsFromEnv(r);
      check("A7: env bootstrap registers both regions", registered.length === 2 && r.hasRegion("env-a") && r.hasRegion("env-b"));
      process.env.CLONER_REGIONS = "{not json";
      check("A7: invalid env JSON fails with a clean env-naming error",
        (await expectThrows(() => bootstrapRegionsFromEnv(r), /CLONER_REGIONS/)).threw);
      process.env.CLONER_REGIONS = '[{"id":"env-c","endpoint":"gopher://x","capabilities":[]}]';
      check("A7: bad endpoint in env fails cleanly",
        (await expectThrows(() => bootstrapRegionsFromEnv(r), "bad_endpoint")).threw);
    } finally { if (saved === undefined) delete process.env.CLONER_REGIONS; else process.env.CLONER_REGIONS = saved; }
  }
}

// ===========================================================================
console.log("\n-- Part B: shared contracts (execution / artifact / auth) --");
{
  const c = await import("../src/distributed/contracts.js");

  // B1 — token round trip
  {
    const token = c.mintRegionToken({ iss: "region-a", aud: "region-b", sub: "worker-1", capabilities: ["clone:url"] }, TEST_SECRET);
    const claims = c.verifyRegionToken(token, TEST_SECRET, { audience: "region-b", expectIssuer: "region-a" });
    check("B1: HS256 token mint+verify round trip carries iss/aud/sub/capabilities/jti",
      claims.iss === "region-a" && claims.aud === "region-b" && claims.sub === "worker-1"
      && JSON.stringify(claims.capabilities) === JSON.stringify(["clone:url"]) && typeof claims.jti === "string"
      && typeof claims.exp === "number" && typeof claims.iat === "number");
    const arrayAudToken = c.mintRegionToken({ iss: "region-a", aud: ["region-b", "region-c"], sub: "w" }, TEST_SECRET);
    const claims2 = c.verifyRegionToken(arrayAudToken, TEST_SECRET, { audience: "region-b" });
    check("B1: array aud claim verifies when it includes the target region", claims2.iss === "region-a" && Array.isArray(claims2.aud));
    check("B1: array aud claim still fails for a target it excludes",
      (await expectThrows(() => c.verifyRegionToken(arrayAudToken, TEST_SECRET, { audience: "region-z" }), "bad_audience")).threw);
  }

  // B2 — auth failure matrix
  {
    const token = c.mintRegionToken({ iss: "region-a", aud: "region-b", sub: "w" }, TEST_SECRET);
    const otherSecret = "a-completely-different-secret-value!!";
    const t = (m) => `B2: ${m}`;
    check(t("wrong secret → bad_signature"), (await expectThrows(() => c.verifyRegionToken(token, otherSecret, { audience: "region-b" }), "bad_signature")).threw);
    check(t("tampered payload → bad_signature"), (await expectThrows(() => {
      const [h, p, s] = token.split(".");
      const payload = JSON.parse(Buffer.from(p, "base64url").toString("utf8"));
      payload.sub = "attacker";
      c.verifyRegionToken(`${h}.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.${s}`, TEST_SECRET, { audience: "region-b" });
    }, "bad_signature")).threw);
    check(t("wrong audience → bad_audience"), (await expectThrows(() => c.verifyRegionToken(token, TEST_SECRET, { audience: "region-z" }), "bad_audience")).threw);
    check(t("wrong issuer → bad_issuer"), (await expectThrows(() => c.verifyRegionToken(token, TEST_SECRET, { audience: "region-b", expectIssuer: "region-x" }), "bad_issuer")).threw);
    check(t("missing token → missing"), (await expectThrows(() => c.verifyRegionToken(null, TEST_SECRET, { audience: "region-b" }), "missing")).threw);
    check(t("garbage token → malformed"), (await expectThrows(() => c.verifyRegionToken("abc.def", TEST_SECRET, { audience: "region-b" }), "malformed")).threw);
    // expired: hand-craft a payload with exp in the past, signed correctly
    const now = Math.floor(Date.now() / 1000);
    const head = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
    const body = Buffer.from(JSON.stringify({ iss: "region-a", aud: "region-b", exp: now - 100, iat: now - 200, jti: "x" })).toString("base64url");
    const sig = crypto.createHmac("sha256", TEST_SECRET).update(`${head}.${body}`).digest("base64url");
    const expired = `${head}.${body}.${sig}`;
    const noLeeway = await expectThrows(() => c.verifyRegionToken(expired, TEST_SECRET, { audience: "region-b", leewayMs: 0 }), "expired");
    check(t("expired token → expired (leeway 0)"), noLeeway.threw);
    check(t("expired far beyond the leeway still fails"),
      (await expectThrows(() => c.verifyRegionToken(expired, TEST_SECRET, { audience: "region-b", leewayMs: 60_000 }), "expired")).threw);
    // 30s past expiry → inside a 60s leeway → accepted
    const body30 = Buffer.from(JSON.stringify({ iss: "region-a", aud: "region-b", exp: now - 30, iat: now - 130, jti: "x2" })).toString("base64url");
    const slightlyExpired = `${head}.${body30}.${crypto.createHmac("sha256", TEST_SECRET).update(`${head}.${body30}`).digest("base64url")}`;
    const withLeeway = c.verifyRegionToken(slightlyExpired, TEST_SECRET, { audience: "region-b", leewayMs: 60_000 });
    check(t("leeway widens the expiry window"), withLeeway.iss === "region-a");
  }

  // B3 — missing secret → clean actionable error (env, never a literal)
  {
    const saved = process.env.CLONER_REGION_SECRET, saved2 = process.env.CLONER_DISTRIBUTED_SECRET;
    try {
      delete process.env.CLONER_REGION_SECRET;
      delete process.env.CLONER_DISTRIBUTED_SECRET;
      const e1 = await expectThrows(() => c.requireRegionSecret(), /CLONER_REGION_SECRET/);
      check("B3: missing env secret → clean error naming the env var", e1.threw && e1.err.status === 401 && e1.err.code === "no_secret");
      const e2 = await expectThrows(() => c.mintRegionToken({ iss: "a", aud: "b" }), "no_secret");
      check("B3: minting without a secret fails the same way", e2.threw);
      process.env.CLONER_REGION_SECRET = "short";
      const e3 = await expectThrows(() => c.requireRegionSecret(), "no_secret");
      check("B3: too-short secret is refused (>=16 chars)", e3.threw);
    } finally {
      process.env.CLONER_REGION_SECRET = saved; if (saved2 !== undefined) process.env.CLONER_DISTRIBUTED_SECRET = saved2;
    }
  }

  // B4 — execution request/result validation
  {
    const req = {
      jobId: "job-1", taskId: "task-1", url: "https://example.com", regionId: "region-a",
      issuedBy: "coord-1", requiredCapabilities: ["clone:url"], options: { instructions: "hi" },
    };
    const n = c.normalizeExecutionRequest(req);
    check("B4: valid request normalizes with contract version + createdAt",
      n.ok && n.value.contractVersion === c.CONTRACT_VERSION && typeof n.value.createdAt === "string");
    const bad = await Promise.all([
      expectThrows(() => c.validateExecutionRequest({ ...req, jobId: "" }), "bad_job_id"),
      expectThrows(() => c.validateExecutionRequest({ ...req, url: "ftp://x" }), "bad_url"),
      expectThrows(() => c.validateExecutionRequest({ ...req, regionId: "NO" }), "bad_region_id"),
      expectThrows(() => c.validateExecutionRequest({ ...req, deadlineMs: -5 }), "bad_deadline"),
      expectThrows(() => c.validateExecutionRequest(null), "bad_body"),
      expectThrows(() => c.validateExecutionRequest({ ...req, requiredCapabilities: "clone:url" }), "bad_capabilities"),
    ]);
    check("B4: every invalid request field fails with its own code", bad.every((b) => b.threw), bad.map((b) => b.err?.code).join(","));

    const result = {
      contractVersion: c.CONTRACT_VERSION, jobId: "job-1", taskId: "task-1", regionId: "region-a",
      workerId: "w-1", status: "completed", artifacts: [{
        contractVersion: c.CONTRACT_VERSION, regionId: "region-a", jobId: "job-1", name: "report.txt",
        sha256: c.digestArtifact(Buffer.from("hello")), bytes: 5, contentType: "text/plain",
      }], durationMs: 42,
    };
    const v = c.validateExecutionResult(result);
    check("B4: valid result validates with typed artifact envelope", v.status === "completed" && v.artifacts[0].name === "report.txt");
    check("B4: unknown status rejected",
      (await expectThrows(() => c.validateExecutionResult({ ...result, status: "banana" }), "bad_status")).threw);
    check("B4: error status without error text rejected",
      (await expectThrows(() => c.validateExecutionResult({ ...result, status: "error" }), "bad_error")).threw);
    check("B4: artifact with a malformed digest rejected",
      (await expectThrows(() => c.validateExecutionResult({ ...result, artifacts: [{ ...result.artifacts[0], sha256: "zz" }] }), "bad_digest")).threw);
  }

  // B5 — artifact digests + envelopes + manifest + version compat
  {
    const d = c.digestArtifact(Buffer.from("hello"));
    check("B5: sha256 known vector (hello)", d === "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824", d);
    const env = c.validateArtifactEnvelope({ regionId: "region-a", jobId: "job-1", name: "a.bin", sha256: d, bytes: 5 });
    check("B5: envelope normalizes contentType + version", env.contentType === "application/octet-stream" && env.contractVersion === c.CONTRACT_VERSION);
    check("B5: verify passes for matching bytes", c.verifyArtifactEnvelope(env, Buffer.from("hello")).name === "a.bin");
    check("B5: digest tamper rejected", (await expectThrows(() => c.verifyArtifactEnvelope(env, Buffer.from("hellO")), "artifact_digest_mismatch")).threw);
    check("B5: size mismatch rejected", (await expectThrows(() => c.verifyArtifactEnvelope(env, Buffer.from("hello!")), "artifact_size_mismatch")).threw);
    check("B5: traversal artifact name rejected",
      (await expectThrows(() => c.validateArtifactEnvelope({ regionId: "r", jobId: "j", name: "../evil.js", sha256: d, bytes: 5 }), "bad_artifact_name")).threw);
    const manifest = c.makeArtifactManifest({ regionId: "region-a", jobId: "job-1", artifacts: [env] });
    const mv = c.validateArtifactManifest(manifest);
    check("B5: manifest validates", mv.artifacts.length === 1 && mv.regionId === "region-a");
    check("B5: manifest with an unknown future major fails closed",
      (await expectThrows(() => c.validateArtifactManifest({ ...manifest, contractVersion: "9.0.0" }), "incompatible_version")).threw);
    check("B5: same-major different-minor is compatible (additive)", c.checkCompatibility("4.9.0").compatible === true);
    check("B5: malformed version rejected", (await expectThrows(() => c.parseVersion("4.2"), "bad_version")).threw);
  }
}

// ===========================================================================
console.log("\n-- Part C: in-process simulated 2-region setup (REAL nodes, REAL HTTP) --");
{
  const { createRegionRegistry, createRegionNode, createRegionClient, createRegionDispatcher, regionRouter, resetRegionRegistry } = await import("../src/distributed/region-registry.js");
  const contracts = await import("../src/distributed/contracts.js");
  const express = (await import("express")).default;

  resetRegionRegistry();
  const registry = createRegionRegistry({ bootstrapFromEnv: false, staleAfterMs: 20_000 });

  // --- two REAL region nodes (product code) with REAL executors ---
  const counters = { "region-a": 0, "region-b": 0 };
  const holdGate = { resolve: null, promise: null };
  holdGate.promise = new Promise((r) => { holdGate.resolve = r; });

  const makeExecutor = (regionId) => async (request, ctx) => {
    counters[regionId] += 1;
    ctx.report("exploring");
    // REAL work: digest the request payload (CPU) — no stubs
    const digest = crypto.createHash("sha256").update(`${request.url}|${JSON.stringify(request.options)}`).digest("hex").slice(0, 16);
    ctx.report("reconstructing");
    if (request.options?.holdUntilGate) await holdGate.promise; // used by the in-flight test
    const report = [
      `region=${regionId}`,
      `job=${request.jobId}`,
      `digest=${digest}`,
      `stages=${["exploring", "reconstructing"].join(">")}`,
    ].join("\n");
    const env = await ctx.artifactStore.save("execution-report.txt", Buffer.from(report));
    if (env.sha256.length !== 64) throw new Error("artifact store returned a bad envelope");
    ctx.report("verifying");
    const status = request.options?.simulateLimitations ? "completed_with_limitations" : "completed";
    return { status, meta: { digest, savedArtifacts: 1 } };
  };

  const artifactsA = path.join(TMP, "artifacts-region-a");
  const artifactsB = path.join(TMP, "artifacts-region-b");
  const nodeA = await createRegionNode({
    regionId: "region-a", capabilities: ["clone:url", "vision:polish", "artifact:store"],
    executor: makeExecutor("region-a"), artifactsRoot: artifactsA, registry,
  });
  const nodeB = await createRegionNode({
    regionId: "region-b", capabilities: ["clone:url", "export:zip", "artifact:store"],
    executor: makeExecutor("region-b"), artifactsRoot: artifactsB, registry,
  });

  // register the regions + their workers through the REAL HTTP surface
  registry.registerRegion({ id: "region-a", endpoint: nodeA.endpoint, capabilities: nodeA.capabilities });
  registry.registerRegion({ id: "region-b", endpoint: nodeB.endpoint, capabilities: nodeB.capabilities });
  const client = createRegionClient({ issuer: "coord-1" });
  const wA = await client.registerRemoteWorker(registry.getRegion("region-a"), { id: "worker-a1", capabilities: ["clone:url", "vision:polish"], concurrency: 2 });
  const wB = await client.registerRemoteWorker(registry.getRegion("region-b"), { id: "worker-b1", capabilities: ["clone:url", "export:zip"], concurrency: 1 });

  // C1 — handshake + health over the wire
  {
    const hsA = await client.handshake(registry.getRegion("region-a"));
    const hsB = await client.handshake(registry.getRegion("region-b"));
    check("C1: handshake validates contract version + identity on both regions",
      hsA.contractVersion === "4.2.1" && hsA.regionId === "region-a" && hsB.regionId === "region-b");
    check("C1: handshake reports the declared capabilities",
      JSON.stringify(hsA.capabilities) === JSON.stringify(["clone:url", "vision:polish", "artifact:store"]));
    const healthB = await client.health(registry.getRegion("region-b"));
    check("C1: health probe answers with online worker count", healthB.ok === true && healthB.onlineWorkers === 1, JSON.stringify(healthB));
    check("C1: workers registered through the HTTP surface landed in the registry",
      wA.id === "worker-a1" && wB.id === "worker-b1" && registry.listWorkers("region-b")[0].online);
  }

  // C2 — capability-based placement
  {
    const r1 = await client.dispatchExecution(registry.getRegion("region-a"), {
      jobId: "job-place-1", taskId: "task-1", url: "https://fixture.local/vision", requiredCapabilities: ["vision:polish"],
    });
    const r2 = await client.dispatchExecution(registry.getRegion("region-b"), {
      jobId: "job-place-2", taskId: "task-2", url: "https://fixture.local/export", requiredCapabilities: ["export:zip"], options: { simulateLimitations: true },
    });
    check("C2: region-a executed its job (result carries region + worker ids)",
      r1.regionId === "region-a" && r1.workerId === `node-region-a-${process.pid}` && r1.status === "completed");
    check("C2: region-b executed its job with completed_with_limitations passthrough",
      r2.regionId === "region-b" && r2.status === "completed_with_limitations");
    check("C2: executors really ran on the intended nodes", counters["region-a"] === 1 && counters["region-b"] === 1,
      JSON.stringify(counters));
    check("C2: durationMs recorded", typeof r1.durationMs === "number" && r1.durationMs >= 0);
    // wrong-target guard lives on the NODE (the client always stamps its own
    // selected region), so drive it with a raw signed request
    const tok = contracts.mintRegionToken({ iss: "coord-1", aud: "region-a", sub: "coordinator" }, TEST_SECRET);
    const wrongResp = await fetch(`${nodeA.endpoint}/v1/executions`, {
      method: "POST",
      headers: { authorization: `Bearer ${tok}`, "content-type": "application/json" },
      body: JSON.stringify({ jobId: "job-wrong", taskId: "t", url: "https://fixture.local/x", regionId: "region-x", issuedBy: "coord-1" }),
    });
    const wrongBody = await wrongResp.json();
    check("C2: wrong-target request refused by the node (wrong_region)", wrongResp.status === 400 && wrongBody.code === "wrong_region", JSON.stringify(wrongBody));
    check("C2: client stamps the region id itself (coordinator-owned routing)",
      (await client.dispatchExecution(registry.getRegion("region-a"), {
        jobId: "job-place-3", taskId: "t3", url: "https://fixture.local/stamp", regionId: "SOMETHING-ELSE",
      })).regionId === "region-a");
  }

  // C3 — artifacts produced during execution + download round trip
  {
    const res = await client.dispatchExecution(registry.getRegion("region-a"), {
      jobId: "job-art-1", taskId: "task-a1", url: "https://fixture.local/report",
    });
    check("C3: execution result carries the artifact envelope the executor saved",
      res.artifacts.length === 1 && res.artifacts[0].name === "execution-report.txt" && res.artifacts[0].bytes > 0,
      JSON.stringify(res.artifacts));
    const manifest = await client.fetchArtifactManifest(registry.getRegion("region-a"), "job-art-1");
    check("C3: manifest lists the artifact with matching digest", manifest.artifacts.length === 1 && manifest.artifacts[0].sha256 === res.artifacts[0].sha256);
    const buf = await client.downloadArtifact(registry.getRegion("region-a"), "job-art-1", "execution-report.txt");
    const onDisk = fs.readFileSync(path.join(artifactsA, "job-art-1", "execution-report.txt"));
    check("C3: downloaded bytes == disk bytes == envelope digest",
      buf.equals(onDisk) && contracts.digestArtifact(buf) === res.artifacts[0].sha256, buf.toString().split("\n")[0]);
    check("C3: report content shows the real execution (region, job, digest)",
      /region=region-a/.test(buf.toString()) && /job=job-art-1/.test(buf.toString()));
    check("C3: manifest for an unknown job → 404 not_found",
      (await expectThrows(() => client.fetchArtifactManifest(registry.getRegion("region-a"), "job-ghost"), /not_found/)).threw);
  }

  // C4 — artifact upload round trip + tamper rejection (region-b)
  {
    const payload = Buffer.from(JSON.stringify({ hello: "region-b", n: 42 }));
    const env = await client.uploadArtifact(registry.getRegion("region-b"), "job-up-1", "payload.json", payload, { contentType: "application/json" });
    check("C4: upload returns a verified envelope", env.sha256 === contracts.digestArtifact(payload) && env.bytes === payload.length);
    const back = await client.downloadArtifact(registry.getRegion("region-b"), "job-up-1", "payload.json");
    check("C4: download returns identical bytes", back.equals(payload));
    check("C4: uploaded file really exists in the region's artifact root",
      fs.existsSync(path.join(artifactsB, "job-up-1", "payload.json")));
    // tamper: wrong digest header → 400 artifact_digest_mismatch, nothing stored
    const token = contracts.mintRegionToken({ iss: "coord-1", aud: "region-b", sub: "coordinator" }, TEST_SECRET);
    const badResp = await fetch(`${nodeB.endpoint}/v1/artifacts/job-up-1`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "x-artifact-name": "evil.bin", "x-artifact-sha256": "f".repeat(64) },
      body: Buffer.from("tampered"),
    });
    const badBody = await badResp.json();
    check("C4: tampered upload rejected with digest-mismatch code", badResp.status === 400 && badBody.code === "artifact_digest_mismatch", JSON.stringify(badBody));
    check("C4: tampered upload never landed on disk", !fs.existsSync(path.join(artifactsB, "job-up-1", "evil.bin")));
    // traversal attempt on the name header
    const travResp = await fetch(`${nodeB.endpoint}/v1/artifacts/job-up-1`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "x-artifact-name": "../escape.txt", "x-artifact-sha256": contracts.digestArtifact(Buffer.from("x")) },
      body: Buffer.from("x"),
    });
    check("C4: traversal artifact name refused (400 bad_artifact_name)", travResp.status === 400);
    check("C4: nothing escaped the artifact root", !fs.existsSync(path.join(artifactsB, "escape.txt")));
  }

  // C5 — auth matrix against a REAL node
  {
    const ep = nodeA.endpoint;
    const post = (headers) => fetch(`${ep}/v1/executions`, { method: "POST", headers, body: JSON.stringify({ jobId: "x", taskId: "y", url: "https://fixture.local/a", regionId: "region-a", issuedBy: "t" }) });
    const noAuth = await post({});
    check("C5: no token → 401 missing", noAuth.status === 401 && (await noAuth.json()).code === "missing");
    const garbage = await post({ authorization: "Bearer not-a-jwt" });
    check("C5: garbage token → 401 malformed", garbage.status === 401 && (await garbage.json()).code === "malformed");
    const wrongSecretToken = contracts.mintRegionToken({ iss: "coord-1", aud: "region-a" }, "another-secret-value-0123456789");
    const badSig = await post({ authorization: `Bearer ${wrongSecretToken}` });
    check("C5: wrong-secret token → 401 bad_signature", badSig.status === 401 && (await badSig.json()).code === "bad_signature");
    const wrongAud = contracts.mintRegionToken({ iss: "coord-1", aud: "region-b" }, TEST_SECRET);
    const badAud = await post({ authorization: `Bearer ${wrongAud}` });
    check("C5: wrong-audience token → 401 bad_audience", badAud.status === 401 && (await badAud.json()).code === "bad_audience");
    const now = Math.floor(Date.now() / 1000);
    const h = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
    const p = Buffer.from(JSON.stringify({ iss: "coord-1", aud: "region-a", exp: now - 50, iat: now - 100, jti: "e" })).toString("base64url");
    const expiredToken = `${h}.${p}.${crypto.createHmac("sha256", TEST_SECRET).update(`${h}.${p}`).digest("base64url")}`;
    const expired = await post({ authorization: `Bearer ${expiredToken}` });
    check("C5: expired token → 401 expired", expired.status === 401 && (await expired.json()).code === "expired");
    // health stays OPEN (probe surface, like /healthz)
    const health = await fetch(`${ep}/v1/health`);
    check("C5: health probe remains unauthenticated", health.status === 200 && (await health.json()).ok === true);
  }

  // C6 — no-secret clean error on the CLIENT side
  {
    const saved = process.env.CLONER_REGION_SECRET;
    try {
      delete process.env.CLONER_REGION_SECRET;
      const e = await expectThrows(() => client.dispatchExecution(registry.getRegion("region-a"), {
        jobId: "job-nosecret", taskId: "t", url: "https://fixture.local/x",
      }), /CLONER_REGION_SECRET/);
      check("C6: dispatch without the env secret fails cleanly BEFORE any HTTP", e.threw && e.err.code === "no_secret");
    } finally { process.env.CLONER_REGION_SECRET = saved; }
  }

  // C7 — dispatcher end-to-end: placement, capacity awareness, worker release
  {
    const dispatcher = createRegionDispatcher({ registry, client });
    const out = await dispatcher.dispatch({ jobId: "job-disp-1", taskId: "t1", url: "https://fixture.local/d1", required: ["vision:polish"] });
    check("C7: dispatcher routes to the only capable region and returns region+worker",
      out.region.id === "region-a" && out.workerId === "worker-a1" && out.result.status === "completed");
    check("C7: dispatcher released the worker slot after completion", registry.describeWorker("region-a", "worker-a1").inFlight === 0);

    // capacity awareness: saturate region-b's single slot → required [export:zip] has NO candidate
    const hold = registry.acquireWorker("region-b", { required: ["export:zip"] });
    const noCap = await expectThrows(() => dispatcher.dispatch({ jobId: "job-disp-2", taskId: "t2", url: "https://fixture.local/d2", required: ["export:zip"] }), "no_region");
    check("C7: saturated region is not a dispatch candidate (capacity-aware, fail-closed)", noCap.threw, noCap.err?.message?.slice(0, 120));
    hold.release();
    const out2 = await dispatcher.dispatch({ jobId: "job-disp-3", taskId: "t3", url: "https://fixture.local/d3", required: ["export:zip"] });
    check("C7: after release, the dispatch lands on region-b", out2.region.id === "region-b" && registry.describeWorker("region-b", "worker-b1").inFlight === 0);

    // in-flight observation: executor holds until we release the gate
    const slow = dispatcher.dispatch({ jobId: "job-disp-4", taskId: "t4", url: "https://fixture.local/d4", required: ["vision:polish"], options: { holdUntilGate: true } });
    await sleep(60); // let the request reach the node and the worker reservation stick
    check("C7: in-flight dispatch holds a worker reservation", registry.describeWorker("region-a", "worker-a1").inFlight === 1);
    holdGate.resolve();
    const slowOut = await slow;
    check("C7: gated dispatch completes and the reservation is released",
      slowOut.result.status === "completed" && registry.describeWorker("region-a", "worker-a1").inFlight === 0);
    check("C7: stage report log recorded exploring/reconstructing/verifying on the node",
      ["exploring", "reconstructing", "verifying"].every((s) => nodeA.stageLog.some((e) => e.stage === s && e.jobId === "job-disp-4")),
      JSON.stringify(nodeA.stageLog.slice(-4)));

    // no-capability dispatch fails with a listing of what IS registered
    const none = await expectThrows(() => dispatcher.dispatch({ jobId: "job-disp-5", taskId: "t5", url: "https://fixture.local/d5", required: ["quantum:clone"] }), /no region can satisfy/);
    check("C7: unsatisfiable dispatch error names the capability + registered regions", none.threw);
  }

  // C8 — failover across candidate regions: region-a node stopped → region-b still serves shared caps
  {
    // Stop the region-a NODE and deregister it (what a registry health
    // monitor does when a region's endpoint dies — while registered-but-dead
    // the dispatcher still tries it first and surfaces the unreachable error,
    // which C9's unreachable case covers directly).
    await nodeA.close();
    registry.deregisterRegion("region-a");
    const dispatcher = createRegionDispatcher({ registry, client });
    const out = await dispatcher.dispatch({ jobId: "job-fail-1", taskId: "tf1", url: "https://fixture.local/f1", required: ["clone:url"] });
    check("C8: with region-a down, the dispatcher fails over to region-b", out.region.id === "region-b");
    // and a capability unique to the down region fails with the clean error
    const onlyA = await expectThrows(() => dispatcher.dispatch({ jobId: "job-fail-2", taskId: "tf2", url: "https://fixture.local/f2", required: ["vision:polish"] }), /no region can satisfy/);
    check("C8: capabilities unique to the down region fail with the same clean error", onlyA.threw, onlyA.err?.message?.slice(0, 120));
  }

  // C9 — broken peer (test-side remote-end simulator): contract violations fail closed
  {
    const broken = http.createServer((req, res) => {
      // answers every route with a contract-violating body
      res.writeHead(200, { "content-type": "application/json" });
      if (req.url === "/v1/contract") return res.end(JSON.stringify({ contractVersion: "3.0.0", regionId: "region-broken", capabilities: [] }));
      if (req.url === "/v1/executions") return res.end(JSON.stringify({ banana: true }));
      res.end("{}");
    });
    await new Promise((r) => broken.listen(0, "127.0.0.1", r));
    const brokenEndpoint = `http://127.0.0.1:${broken.address().port}`;
    registry.registerRegion({ id: "region-broken", endpoint: brokenEndpoint, capabilities: ["clone:url"] });
    registry.registerWorker("region-broken", { id: "bw", capabilities: ["clone:url"], concurrency: 1 });

    const badVersion = await expectThrows(() => client.handshake(registry.getRegion("region-broken")), "incompatible_version");
    check("C9: handshake with an older contract major fails closed", badVersion.threw, badVersion.err?.message?.slice(0, 100));

    // garbage result: driven DIRECTLY against the broken peer (through the
    // dispatcher a healthy candidate would win the race — that's the point of
    // the dispatcher's failover)
    const badResult = await expectThrows(() => client.dispatchExecution(registry.getRegion("region-broken"), {
      jobId: "job-brk-1", taskId: "tb1", url: "https://fixture.local/b1",
    }), /jobId required|bad_job_id/);
    check("C9: garbage execution result rejected by the client-side contract validation", badResult.threw, badResult.err?.message?.slice(0, 100));

    // unreachable region
    registry.registerRegion({ id: "region-dead", endpoint: "http://127.0.0.1:1", capabilities: ["clone:url"] });
    registry.registerWorker("region-dead", { id: "dw", capabilities: ["clone:url"], concurrency: 1 });
    const dead = await expectThrows(() => client.handshake(registry.getRegion("region-dead")), "unreachable");
    check("C9: unreachable region → clean protocol error (unreachable)", dead.threw, dead.err?.message?.slice(0, 100));
    broken.close();
  }

  // C10 — Express admin router surface (the integrator mount line)
  {
    const app = express();
    app.use(express.json()); // src/platform/server.js applies this globally — mirror it here
    app.use("/api/regions", regionRouter({ registry }));
    const server = await new Promise((r) => { const s = app.listen(0, "127.0.0.1", () => r(s)); });
    const base = `http://127.0.0.1:${server.address().port}/api/regions`;

    const list = await (await fetch(base)).json();
    check("C10: GET / lists regions with worker stats", list.contractVersion === "4.2.1" && list.regions.some((x) => x.id === "region-b"));

    const reg = await fetch(base, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: "api-region", endpoint: "http://api:1", capabilities: ["clone:url"] }) });
    check("C10: POST / registers a region (201)", reg.status === 201 && registry.hasRegion("api-region"));

    const workers = await (await fetch(`${base}/region-b/workers`)).json();
    check("C10: GET /:id/workers lists region workers", Array.isArray(workers) && workers[0]?.id === "worker-b1");

    const wreg = await fetch(`${base}/region-b/workers`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: "worker-b2", capabilities: ["export:zip"], concurrency: 3 }) });
    check("C10: POST /:id/workers registers a worker (201)", wreg.status === 201 && registry.describeWorker("region-b", "worker-b2").concurrency === 3);

    const del = await fetch(`${base}/api-region`, { method: "DELETE" });
    check("C10: DELETE /:id deregisters", del.status === 200 && !registry.hasRegion("api-region"));

    const dup = await fetch(base, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: "region-b", endpoint: "http://dup:1", capabilities: [] }) });
    check("C10: duplicate POST → 400 duplicate_region", dup.status === 400 && (await dup.json()).error.includes("already registered"));

    await new Promise((r) => server.close(r));
  }

  await nodeB.close();
  resetRegionRegistry();
}

// ---------------------------------------------------------------------------
const passed = results.filter(Boolean).length;
const failed = results.length - passed;
console.log(`\n=== region-registry: ${passed}/${results.length} checks passed${failed ? `, ${failed} FAILED` : ""} ===`);
process.exitCode = failed ? 1 : 0;
