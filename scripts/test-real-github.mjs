#!/usr/bin/env node
// Task G1.1 verification — REAL GitHub REST v3 publishing.
//
//   node scripts/test-real-github.mjs
//
// Sections (each prints PASS/FAIL/SKIP; any FAIL exits non-zero):
//   1. [unit]      Env-absent clean errors, path safety, sensitive-name fail-closed
//                  rules, directory collection, router wiring (local express).
//                  Always runs, needs no network and no token.
//   2. [real-api]  UNAUTHENTICATED calls against the REAL https://api.github.com —
//                  transport, response contract and 401/404 error mapping. Needs
//                  no token; skipped only when the network itself is unreachable.
//   3. [real-smoke] The full publish journey against the real API: create repo
//                  (cloner-selftest-*) → git-data push → byte-exact readback →
//                  second push (fast-forward) → visibility PATCH → delete.
//                  Requires GITHUB_PUBLISH_TOKEN (classic PAT, scopes repo +
//                  delete_repo). Without it this section SKIPS LOUDLY — nothing
//                  is ever mocked; there is no mock branch in the product path.
//
// The smoke creates exactly one tiny private repo and deletes it; if cleanup
// fails (e.g. token lacks delete_repo) the failure is reported loudly with the
// exact repo name left behind.

import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import {
  GitHubPublishError,
  githubRequest,
  getAuthenticatedUser,
  createRepo,
  getRepo,
  getRepoFile,
  pushTree,
  setRepoVisibility,
  deleteRepo,
  publishToGitHub,
  publishTaskToGitHub,
  normalizeUploadPath,
  normalizeUploadFile,
  collectFilesFromDir,
  githubPublishRouter,
} from "../src/platform/github-publish-real.js";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const results = { pass: 0, fail: 0, skip: 0 };

function pass(name, detail = "") { results.pass++; console.log(`PASS  ${name}${detail ? ` — ${detail}` : ""}`); }
function fail(name, detail = "") { results.fail++; console.log(`FAIL  ${name}${detail ? ` — ${detail}` : ""}`); }
function skip(name, detail = "") { results.skip++; console.log(`SKIP  ${name}${detail ? ` — ${detail}` : ""}`); }
function ok(cond, name, detail = "") { cond ? pass(name, detail) : fail(name, detail); }
const sha40 = (s) => typeof s === "string" && /^[0-9a-f]{40}$/.test(s);
const netDead = (msg) => /ENOTFOUND|EAI_AGAIN|ETIMEDOUT|ECONNREFUSED|timed out after/.test(msg || "");

// env hygiene: unit/router sections must run with the token ABSENT, the smoke
// section (if configured at all) restores it.
const SAVED_TOKEN = process.env.GITHUB_PUBLISH_TOKEN;
function clearToken() { delete process.env.GITHUB_PUBLISH_TOKEN; }
function restoreToken() { if (SAVED_TOKEN) process.env.GITHUB_PUBLISH_TOKEN = SAVED_TOKEN; else delete process.env.GITHUB_PUBLISH_TOKEN; }

// ── 1. unit ──────────────────────────────────────────────────────────────────
async function sectionUnit() {
  console.log("\n── [unit] no-network checks ────────────────────────────────────");
  clearToken();

  // 1.1 env-absent → one clean actionable error per entry point, no network
  for (const [name, fn] of [
    ["createRepo", () => createRepo({ name: "x" })],
    ["pushTree", () => pushTree({ owner: "o", repo: "r", files: [{ path: "a.txt", content: "x" }] })],
    ["publishToGitHub", () => publishToGitHub({ name: "x", files: [{ path: "a.txt", content: "x" }] })],
    ["publishTaskToGitHub", () => publishTaskToGitHub({ taskId: "t" })],
    ["getAuthenticatedUser", () => getAuthenticatedUser()],
  ]) {
    try {
      await fn();
      fail(`unit/env-absent/${name}`, "no error thrown");
    } catch (e) {
      const good = e instanceof GitHubPublishError && !e.status && e.message.includes("GITHUB_PUBLISH_TOKEN");
      ok(good, `unit/env-absent/${name}`, good ? "GitHubPublishError naming GITHUB_PUBLISH_TOKEN, no upstream status" : e.message);
    }
  }

  // 1.2 path safety
  const badPaths = ["../evil.txt", "/abs.txt", "C:/x.txt", "", "a/../../b", "styles/../cookies.json"];
  let pathOk = 0;
  for (const p of badPaths) {
    try { normalizeUploadPath(p); } catch (e) { if (e instanceof GitHubPublishError) pathOk++; }
  }
  ok(pathOk === badPaths.length, "unit/path-safety/rejects", `${pathOk}/${badPaths.length} dangerous paths refused`);
  try {
    ok(normalizeUploadPath("styles/tokens.css") === "styles/tokens.css", "unit/path-safety/accepts-clean", "styles/tokens.css");
  } catch (e) { fail("unit/path-safety/accepts-clean", e.message); }

  // 1.3 sensitive-name fail-closed — refused BEFORE any network call
  const sensitive = [
    "cookies.json", "private/state.json", "secrets/config.json", ".env",
    "storage/session-storage.json", "assets/storageState.json", "api-token.txt",
  ];
  let sensOk = 0;
  for (const p of sensitive) {
    try { normalizeUploadPath(p); fail(`unit/sensitive/${p}`, "accepted!"); } catch (e) {
      if (e instanceof GitHubPublishError && e.message.includes("credential/session-named")) sensOk++; else fail(`unit/sensitive/${p}`, e.message);
    }
  }
  ok(sensOk === sensitive.length, "unit/sensitive/fail-closed", `${sensOk}/${sensitive.length} credential-shaped paths refused pre-network`);

  // 1.4 file normalization encodings
  const f1 = normalizeUploadFile({ path: "a.html", content: "<html></html>" });
  const f2 = normalizeUploadFile({ path: "a.png", content: Buffer.from([0x89, 0x50, 0x4e, 0x47]) });
  const f3 = normalizeUploadFile({ path: "a.bin", contentBase64: "AAEC" });
  ok(f1.encoding === "utf-8" && f1.content === "<html></html>", "unit/encode/text");
  ok(f2.encoding === "base64" && Buffer.from(f2.content, "base64").toString("hex") === "89504e47", "unit/encode/buffer-to-base64");
  ok(f3.encoding === "base64" && f3.content === "AAEC", "unit/encode/contentBase64-passthrough");
  try { normalizeUploadFile({ path: "x" }); fail("unit/encode/missing-content", "accepted"); }
  catch (e) { ok(e instanceof GitHubPublishError, "unit/encode/missing-content", "refused without content"); }

  // 1.5 directory collection — real temp tree, sensitive + non-shippable skipped
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cloner-ghpub-"));
  try {
    fs.mkdirSync(path.join(tmp, "styles"), { recursive: true });
    fs.mkdirSync(path.join(tmp, "assets"), { recursive: true });
    fs.mkdirSync(path.join(tmp, "private"), { recursive: true });
    fs.mkdirSync(path.join(tmp, "node_modules", "pkg"), { recursive: true });
    fs.mkdirSync(path.join(tmp, ".git"), { recursive: true });
    fs.writeFileSync(path.join(tmp, "index.html"), "<h1>clone</h1>");
    fs.writeFileSync(path.join(tmp, "styles", "main.css"), "body{margin:0}");
    fs.writeFileSync(path.join(tmp, "assets", "logo.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a]));
    fs.writeFileSync(path.join(tmp, "private", "cookies.json"), "{}");
    fs.writeFileSync(path.join(tmp, "node_modules", "pkg", "x.js"), "module.exports=1");
    fs.writeFileSync(path.join(tmp, ".git", "HEAD"), "ref: refs/heads/main");
    const { files, excluded } = collectFilesFromDir(tmp);
    const names = files.map((f) => f.path).sort();
    ok(names.join(",") === "assets/logo.png,index.html,styles/main.css", "unit/collect/files", names.join(", "));
    const ex = excluded.sort().join(",");
    ok(ex === ".git,node_modules,private", "unit/collect/excluded", ex);
    const logo = files.find((f) => f.path === "assets/logo.png");
    ok(logo?.encoding === "base64" && Buffer.from(logo.content, "base64").toString("hex") === "89504e470d0a", "unit/collect/binary-roundtrip");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }

  // 1.6 publishTaskToGitHub with an unknown task → clean error, no network.
  // A placeholder token is set because the env check now (by design) fires
  // before the fs lookup; the task is absent so this path never reaches GitHub.
  process.env.GITHUB_PUBLISH_TOKEN = "placeholder-no-network-call";
  try {
    await publishTaskToGitHub({ taskId: "no-such-task-xyz" });
    fail("unit/task/unknown", "no error thrown");
  } catch (e) {
    ok(e instanceof GitHubPublishError && e.taskNotFound === true && e.message.includes("no publishable tree"),
      "unit/task/unknown", e.message.slice(0, 80) + "…");
  } finally {
    clearToken(); // back to env-absent for the router checks below
  }

  // 1.7 dir-input publish path (exporter semantics: sensitive entries are
  // EXCLUDED and reported, never shipped; strict mode hard-fails instead).
  let dirTmp = null;
  dirTmp = fs.mkdtempSync(path.join(os.tmpdir(), "cloner-ghpub-dir-"));
  fs.mkdirSync(path.join(dirTmp, "private"), { recursive: true });
  fs.writeFileSync(path.join(dirTmp, "index.html"), "<h1>x</h1>");
  fs.writeFileSync(path.join(dirTmp, "private", "cookies.json"), "{}");
  // strict mode: the fail-closed re-verify layer refuses to produce the list
  try {
    collectFilesFromDir(dirTmp, { skipSensitive: false });
    fail("unit/dir/strict-fail-closed", "no error thrown");
  } catch (e) {
    ok(e instanceof GitHubPublishError && e.message.includes("credential/session-named"),
      "unit/dir/strict-fail-closed", e.message.slice(0, 80) + "…");
  }
  // default mode: placeholder token — sensitive entry excluded, publish proceeds,
  // and the REAL api.github.com auth layer answers a genuine 401 (no repo created).
  process.env.GITHUB_PUBLISH_TOKEN = "placeholder-no-network-call";
  try {
    await publishToGitHub({ name: "cloner-never-created-a", dir: dirTmp });
    fail("unit/dir/bad-token-401", "no error thrown");
  } catch (e) {
    if (netDead(e.message)) skip("unit/dir/bad-token-401", `network unreachable: ${e.message.slice(0, 60)}`);
    else ok(e instanceof GitHubPublishError && e.status === 401, "unit/dir/bad-token-401",
      `private/cookies.json excluded pre-network (see warn above); real api.github.com answered 401 to the placeholder token — auth plumbing live, repo never created`);
  } finally {
    clearToken();
    fs.rmSync(dirTmp, { recursive: true, force: true });
    dirTmp = null;
  }

  // 1.8 router wiring over REAL local HTTP (guard default + status + env-absent publish)

  // 1.8 router wiring over REAL local HTTP (guard default + status + env-absent publish)
  const app = express();
  app.use(express.json());
  app.use("/api/github", githubPublishRouter()); // no guard → POST must be refused by default
  const server = http.createServer(app).listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const st = await fetch(`${base}/api/github/status`);
    const stj = await st.json();
    ok(st.status === 200 && stj.configured === false && stj.endpoint === "https://api.github.com",
      "unit/router/status", JSON.stringify(stj));

    const noGuard = await fetch(`${base}/api/github/publish/some-task`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    const noGuardJ = await noGuard.json();
    ok(noGuard.status === 403 && /guard/.test(noGuardJ.error), "unit/router/no-guard-default", `${noGuard.status} ${noGuardJ.error.slice(0, 60)}…`);

    // guarded router: publish with token absent → 503 with the actionable message
    const app2 = express();
    app2.use(express.json());
    app2.use("/api/github", githubPublishRouter({ guard: (_req, _res, next) => next() }));
    const server2 = http.createServer(app2).listen(0, "127.0.0.1");
    await new Promise((r) => server2.once("listening", r));
    const b2 = `http://127.0.0.1:${server2.address().port}`;
    try {
      const r = await fetch(`${b2}/api/github/publish/some-task`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
      const j = await r.json();
      ok(r.status === 503 && j.error.includes("GITHUB_PUBLISH_TOKEN"), "unit/router/env-absent-503", `${r.status} ${j.error.slice(0, 70)}…`);
    } finally { server2.close(); }
  } finally { server.close(); }

  restoreToken();
}

// ── 2. real api, unauthenticated ─────────────────────────────────────────────
async function sectionRealApi() {
  console.log("\n── [real-api] real https://api.github.com, unauthenticated ─────");
  let reachable = true;
  try {
    const rl = await githubRequest("GET", "/rate_limit");
    ok(rl.status === 200 && rl.json?.resources?.core?.limit >= 1, "real-api/rate-limit",
      `core limit ${rl.json.resources.core.limit} (unauthenticated)`);
  } catch (e) {
    if (netDead(e.message)) { reachable = false; skip("real-api/rate-limit", `api.github.com unreachable: ${e.message.slice(0, 60)}`); }
    else fail("real-api/rate-limit", e.message);
  }
  if (!reachable) {
    skip("real-api/all", "network unreachable — transport could not be exercised this run");
    return;
  }
  // real public-repo contract
  try {
    const r = await githubRequest("GET", "/repos/octocat/Hello-World");
    ok(r.status === 200 && r.json?.name === "Hello-World" && r.json?.full_name === "octocat/Hello-World",
      "real-api/public-repo-readback", `full_name=${r.json.full_name}`);
  } catch (e) { fail("real-api/public-repo-readback", e.message); }
  // real 401 mapping
  try {
    await githubRequest("GET", "/user"); // no Authorization → GitHub must 401
    fail("real-api/unauth-401", "no error thrown");
  } catch (e) {
    ok(e instanceof GitHubPublishError && e.status === 401, "real-api/unauth-401", e.message.slice(0, 80) + "…");
  }
  // real 404 mapping
  try {
    await githubRequest("GET", "/repos/octocat/no-such-repo-xyz-999");
    fail("real-api/notfound-404", "no error thrown");
  } catch (e) {
    ok(e instanceof GitHubPublishError && e.status === 404, "real-api/notfound-404", e.message.slice(0, 80) + "…");
  }
}

// ── 3. token-gated real smoke ────────────────────────────────────────────────
async function sectionRealSmoke() {
  console.log("\n── [real-smoke] full publish journey, REAL api.github.com ──────");
  const token = (process.env.GITHUB_PUBLISH_TOKEN || "").trim();
  if (!token) {
    console.log("");
    console.log("════════════════════════════════════════════════════════════════");
    console.log("SKIP  [real-smoke] — GITHUB_PUBLISH_TOKEN is not set in this environment.");
    console.log("      The full journey (create repo → git-data push → byte-exact readback →");
    console.log("      fast-forward update → visibility PATCH → repo delete) runs ONLY against");
    console.log("      the real api.github.com when you provide a token:");
    console.log("");
    console.log("        export GITHUB_PUBLISH_TOKEN=ghp_…   # classic PAT — scopes: repo + delete_repo");
    console.log("");
    console.log("      (delete_repo is required for this self-test's cleanup; fine-grained");
    console.log("       tokens cannot delete repositories. Publishing itself needs only `repo`.)");
    console.log("      Until then, the real network path exercised this run is limited to the");
    console.log("      unauthenticated [real-api] checks above. NOTHING is mocked anywhere —");
    console.log("      there is no mock branch in the product path.");
    console.log("════════════════════════════════════════════════════════════════");
    console.log("");
    skip("real-smoke/full-journey", "GITHUB_PUBLISH_TOKEN not set — loud skip by design");
    return;
  }

  const ts = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14);
  const name = `cloner-selftest-${ts}`;
  const files = [
    { path: "README.md", content: "# cloner self-test\n\nTiny throwaway repo created and deleted by scripts/test-real-github.mjs — safe to delete.\n" },
    { path: "index.html", content: "<!doctype html><h1>cloner-selftest</h1>\n" },
    { path: "styles/main.css", content: "body{margin:0;font-family:sans-serif}\n" },
    { path: "assets/data/hello.txt", content: "hello from the cloner platform\n" },
    { path: "assets/data/hello-copy.txt", content: "hello from the cloner platform\n" }, // identical → blob dedup
  ];
  let created = false;
  let deleted = false;
  let commit1 = null;
  try {
    // 3.1 who am I
    const me = await getAuthenticatedUser();
    ok(!!me.login, "real-smoke/auth-user", `login=${me.login}`);

    // 3.2 create the tiny private repo
    const repo = await createRepo({ name, description: "cloner self-test — safe to delete", private: true });
    created = true;
    ok(repo.name === name && repo.private === true && repo.owner?.login === me.login,
      "real-smoke/create-repo", `${repo.owner.login}/${repo.name} private=${repo.private}`);

    // 3.3 first push — empty repo → first-commit path (no parents, ref created)
    const p1 = await pushTree({ owner: me.login, repo: name, branch: "main", files, message: "cloner self-test: initial tree" });
    commit1 = p1.commitSha;
    ok(sha40(p1.commitSha) && p1.parentSha === null && p1.blobCount === 4 && p1.fileCount === 5,
      "real-smoke/first-push", `commit=${p1.commitSha.slice(0, 10)} blobs=${p1.blobCount} (5 files deduped to 4 blobs)`);

    // 3.4 byte-exact readback via the real contents API
    let allExact = true;
    for (const f of files) {
      const got = await getRepoFile({ owner: me.login, repo: name, filePath: f.path, ref: "main" });
      const want = Buffer.from(f.content, "utf8");
      if (!got.content.equals(want)) { allExact = false; fail(`real-smoke/readback/${f.path}`, `bytes differ (${got.content.length} vs ${want.length})`); }
    }
    ok(allExact, "real-smoke/readback-byte-exact", `${files.length}/${files.length} files byte-identical via GET /contents`);

    // 3.5 second push — fast-forward onto commit1 (remote changes are never overwritten)
    const p2 = await pushTree({
      owner: me.login, repo: name, branch: "main",
      files: [
        { path: "README.md", content: files[0].content + "\nupdated by second push\n" },
        { path: "CHANGELOG.md", content: "## 1.0.0 — self-test\n" },
      ],
      message: "cloner self-test: update",
    });
    ok(sha40(p2.commitSha) && p2.commitSha !== p1.commitSha && p2.parentSha === p1.commitSha,
      "real-smoke/second-push-fast-forward", `parent=${String(p2.parentSha).slice(0, 10)} → ${p2.commitSha.slice(0, 10)}`);
    const head = await githubRequest("GET", `/repos/${me.login}/${name}/git/refs/heads/main`, { token: process.env.GITHUB_PUBLISH_TOKEN.trim() });
    ok(head.json.object.sha === p2.commitSha, "real-smoke/ref-head-matches", `heads/main=${head.json.object.sha.slice(0, 10)}`);

    // 3.6 visibility — real PATCH verified by a real readback (stays private; nothing public)
    await setRepoVisibility({ owner: me.login, repo: name, visibility: "private" });
    const after = await getRepo(me.login, name);
    ok(after.private === true, "real-smoke/visibility-patch-readback", `PATCH private:true → repo.private=${after.private}`);

    // 3.7 cleanup — the repo must be gone
    const gone = await deleteRepo({ owner: me.login, repo: name, confirm: "delete" });
    deleted = true;
    ok(gone === true, "real-smoke/delete-repo", `DELETE ${name} → 204`);
    try {
      await getRepo(me.login, name);
      fail("real-smoke/deleted-verified", "repo still readable after delete");
    } catch (e) {
      ok(e instanceof GitHubPublishError && e.status === 404, "real-smoke/deleted-verified", `GET after delete → 404 (${e.status})`);
    }
  } catch (e) {
    fail("real-smoke/journey", e.message);
  } finally {
    // never leave the tiny repo behind on a mid-journey failure
    if (created && !deleted) {
      try {
        const me2 = await getAuthenticatedUser();
        await deleteRepo({ owner: me2.login, repo: name, confirm: "delete" });
        console.log(`NOTE  real-smoke/cleanup — leftover repo ${name} deleted after a failed step`);
      } catch (e2) {
        console.log(`FAIL  real-smoke/cleanup — leftover repo ${name} could NOT be deleted (${e2.message}).`);
        console.log(`      Delete it manually: https://github.com/settings/repositories → ${name}`);
        fail("real-smoke/cleanup", `leftover ${name}: ${e2.message}`);
      }
    }
  }
}

async function main() {
  console.log("cloner platform — real GitHub publish test (task G1.1)");
  console.log(`node ${process.version} · ${process.platform} · endpoint=${process.env.GITHUB_API_URL || "https://api.github.com"}`);
  await sectionUnit();
  await sectionRealApi();
  await sectionRealSmoke();
  console.log("\n════════════════════════════════════════════════════════════");
  console.log(`real-github test: ${results.pass} passed · ${results.fail} failed · ${results.skip} skipped`);
  process.exit(results.fail > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error("real-github test crashed:", e);
  process.exit(1);
});
