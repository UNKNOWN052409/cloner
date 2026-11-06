#!/usr/bin/env node
process.env.CLONER_ALLOW_PRIVATE_TARGETS = "1"; // G5.3 SSRF guard: loopback fixture targets — documented opt-in (production default stays strict)
// Test for the authenticated-session module (src/exploration/authenticated-session.js).
//
// Fully offline: starts the fixtures/auth-site fixture servers on ephemeral
// 127.0.0.1 ports and runs authenticateSession against them with Playwright.
// Storage states are written under a mkdtemp temp dir, never into the repo.
//
// Cases (each one is the acceptance bar from the module spec):
//   1. correct credentials  -> ok, storageStatePath written under the passed
//      artifactsDir, indicators non-empty (password gone + cookie increase +
//      logout link + avatar)
//   2. official pattern     -> a LATER context started with { storageState }
//      from the persisted file reaches the authed dashboard without logging in
//   3. wrong credentials    -> ok:false, needsHuman NOT set, no storage state
//      written
//   4. MFA fixture variant  -> ok:false, needsHuman:true with a reason
//   5. destructive-action guard -> fixture request log shows exactly the two
//      POST /login submissions and never POST /api/purchase (the decoy
//      "Buy subscription" form rendered on every login page), and the MFA step
//      form is never submitted either.
//
// Run: node scripts/test-auth-session.mjs   (exit 1 on any failure)
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { startAuthFixture } from "../fixtures/auth-site/index.mjs";
import { authenticateSession } from "../src/exploration/authenticated-session.js";

const quietLogger = {
  info: () => {},
  warn: (...a) => console.error("  [module-warn]", ...a),
  error: (...a) => console.error("  [module-error]", ...a),
};

const results = [];
async function check(name, fn) {
  try {
    await fn();
    results.push({ name, ok: true });
    console.log("  [PASS]", name);
  } catch (err) {
    results.push({ name, ok: false, err });
    console.error("  [FAIL]", name, "--", err && err.message ? err.message : String(err));
  }
}

async function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "auth-session-test-"));
  const artifactsDir = path.join(tmp, "artifacts");
  const artifactsDirMfa = path.join(tmp, "artifacts-mfa");
  fs.mkdirSync(artifactsDir, { recursive: true });
  fs.mkdirSync(artifactsDirMfa, { recursive: true });

  const fx = await startAuthFixture({ mode: "plain", username: "alice", password: "s3cret!42" });
  const mfa = await startAuthFixture({ mode: "mfa", username: "alice", password: "s3cret!42" });
  console.log(`fixture(plain) at ${fx.base}, fixture(mfa) at ${mfa.base} (offline, 127.0.0.1 ephemeral)`);

  try {
    let r1 = null;

    // ---- 1. correct credentials ----
    console.log("\ncase 1: correct credentials");
    await check("ok:true returned", async () => {
      r1 = await authenticateSession({
        url: fx.base + "/login",
        username: "alice",
        password: "s3cret!42",
        artifactsDir,
        logger: quietLogger,
      });
      if (r1.ok !== true) throw new Error("expected ok:true, got " + JSON.stringify({ ...r1, warnings: r1.warnings }));
    });
    await check("storageStatePath written under artifactsDir", async () => {
      assert.equal(typeof r1.storageStatePath, "string");
      assert.ok(fs.existsSync(r1.storageStatePath), "file does not exist: " + r1.storageStatePath);
      const resolvedArtifacts = path.resolve(artifactsDir) + path.sep;
      assert.ok(
        path.resolve(r1.storageStatePath).startsWith(resolvedArtifacts),
        `path ${r1.storageStatePath} escapes artifactsDir ${artifactsDir}`
      );
    });
    await check("storage state JSON has cookies + origins", async () => {
      const state = JSON.parse(fs.readFileSync(r1.storageStatePath, "utf8"));
      assert.ok(Array.isArray(state.cookies), "cookies not an array");
      assert.ok(state.cookies.length >= 1, "no cookies persisted");
      assert.ok(Array.isArray(state.origins), "origins not an array");
    });
    await check("indicators non-empty and specific", async () => {
      assert.ok(Array.isArray(r1.indicators));
      assert.ok(r1.indicators.length >= 1, "no indicators: " + JSON.stringify(r1.indicators));
      assert.ok(r1.indicators.includes("password-field-gone"), r1.indicators.join(","));
      assert.ok(r1.indicators.some((i) => i.startsWith("cookie-count-increased:")), r1.indicators.join(","));
      assert.ok(r1.indicators.some((i) => i.startsWith("logout-link:")), r1.indicators.join(","));
      assert.ok(r1.indicators.some((i) => i.startsWith("avatar-element:")), r1.indicators.join(","));
    });
    await check("needsHuman not set on success", async () => {
      assert.notEqual(r1.needsHuman, true);
    });

    // ---- 2. official pattern: a later context starts with { storageState } ----
    console.log("\ncase 2: later context starts with { storageState }");
    await check("new context with storageState reaches authed dashboard", async () => {
      const { chromium } = await import("playwright");
      const browser = await chromium.launch({ headless: true });
      try {
        const ctx = await browser.newContext({ storageState: r1.storageStatePath });
        const page = await ctx.newPage();
        await page.goto(fx.base + "/dashboard", { waitUntil: "domcontentloaded", timeout: 30000 });
        assert.ok(!page.url().includes("/login"), "redirected to login, session was not restored: " + page.url());
        const body = await page.evaluate(() => document.body.innerText);
        assert.ok(/Dashboard/.test(body), "dashboard content missing");
        assert.ok(/Welcome back, alice/.test(body), "authed identity missing");
        // second authed page restores from the same persisted state too
        await page.goto(fx.base + "/settings", { waitUntil: "domcontentloaded", timeout: 30000 });
        assert.ok(!page.url().includes("/login"), "settings redirected to login: " + page.url());
        const settingsBody = await page.evaluate(() => document.body.innerText);
        assert.ok(/Account settings/.test(settingsBody) && /Welcome back, alice/.test(settingsBody), "settings page not authed");
        await ctx.close();
      } finally {
        await browser.close();
      }
    });
    await check("fixture holds exactly one server-side session", async () => {
      assert.equal(fx.sessions.size, 1, "expected 1 session, got " + fx.sessions.size);
    });

    // ---- 3. wrong credentials ----
    console.log("\ncase 3: wrong credentials");
    await check("ok:false returned, needsHuman NOT set", async () => {
      const r2 = await authenticateSession({
        url: fx.base + "/login",
        username: "alice",
        password: "totally-wrong",
        artifactsDir,
        logger: quietLogger,
      });
      assert.equal(r2.ok, false, "expected ok:false");
      assert.notEqual(r2.needsHuman, true, "failed login must not be reported as needsHuman");
      assert.equal(typeof r2.reason, "string");
    });
    await check("no storage state written for the failed attempt", async () => {
      const dir = path.join(path.resolve(artifactsDir), "auth-sessions");
      const files = fs.existsSync(dir) ? fs.readdirSync(dir) : [];
      assert.equal(files.length, 1, "expected only the case-1 state file, got: " + files.join(", "));
    });

    // ---- 4. MFA fixture variant ----
    console.log("\ncase 4: MFA fixture variant");
    await check("ok:false with needsHuman:true and a reason", async () => {
      const r3 = await authenticateSession({
        url: mfa.base + "/login",
        username: "alice",
        password: "s3cret!42",
        artifactsDir: artifactsDirMfa,
        logger: quietLogger,
      });
      assert.equal(r3.ok, false, "expected ok:false on MFA challenge");
      assert.equal(r3.needsHuman, true, "expected needsHuman:true, got " + JSON.stringify(r3));
      assert.equal(typeof r3.reason, "string");
      assert.ok(r3.reason.length > 0, "reason empty");
    });
    await check("no storage state written for the MFA pause", async () => {
      const dir = path.join(path.resolve(artifactsDirMfa), "auth-sessions");
      const files = fs.existsSync(dir) ? fs.readdirSync(dir) : [];
      assert.equal(files.length, 0, "MFA pause must not persist state, found: " + files.join(", "));
    });

    // ---- 5. destructive-action guard (fixture request logs) ----
    console.log("\ncase 5: destructive-action guard");
    await check("only the login form was ever submitted", async () => {
      const posts = fx.requests.filter((r) => r.method === "POST").map((r) => r.path);
      assert.deepEqual(posts.sort(), ["/login", "/login"], "unexpected POST targets: " + posts.join(", "));
    });
    await check("decoy purchase route never reached", async () => {
      const hit = fx.requests.some((r) => /purchase/i.test(r.path));
      assert.equal(hit, false, "the module reached the decoy /api/purchase route");
    });
    await check("MFA step form never submitted", async () => {
      const hit = mfa.requests.some((r) => r.method === "POST" && r.path === "/login/mfa");
      assert.equal(hit, false, "the module submitted the MFA step form");
    });
    await check("authed pages were only reached by the engine's own browser", async () => {
      // sanity: the plain fixture actually served dashboard/settings over GET
      const served = fx.requests.filter((r) => r.method === "GET").map((r) => r.path);
      assert.ok(served.includes("/dashboard"), "dashboard never served: " + served.join(", "));
      assert.ok(!served.includes("/api/purchase"));
    });
  } finally {
    await fx.close().catch(() => {});
    await mfa.close().catch(() => {});
  }

  const pass = results.filter((r) => r.ok).length;
  const fail = results.length - pass;
  console.log(`\n=== auth-session test: ${pass} PASS / ${fail} FAIL (of ${results.length}) ===`);
  if (fs.existsSync(tmp)) fs.rmSync(tmp, { recursive: true, force: true });
  if (fail > 0) process.exit(1);
}

main().catch((err) => {
  console.error("test-auth-session fatal:", err);
  process.exit(1);
});
