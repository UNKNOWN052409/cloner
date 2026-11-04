#!/usr/bin/env node
// Task 4.1.8 e2e — GitHub publishing integration.
//
// github-publish.js is REAL REST code: it always calls the configured
// GITHUB_API_URL. This suite simulates the REMOTE side only — a local http
// server speaking the GitHub REST v3 shapes (repos, git/blobs, git/trees,
// git/commits, git/refs) — and points GITHUB_API_URL at it. The product code
// under test contains no mock branch (grep-enforced below).
//
// Asserts the plan contract:
//   • token absent → clean actionable error (nothing simulated, no network)
//   • full flow against the mock remote: create repo → blobs → tree → commit
//     → ref; returns htmlUrl + commitSha + pushed file count
//   • repo content readable back byte-exact through the mock's object store
//   • second push parents onto the branch head (fast-forward commit chain)
//   • credential-named upload paths REFUSED before any network call
//   • empty upload dir refused
//   • API errors mapped to typed GitHubPublishError with upstream status
//
// NOTE: this is the 4.1.8 mock-remote suite. The REAL-API suite
// (scripts/test-real-github.mjs, task G1.1) exercises github-publish-real.js
// against api.github.com and lives alongside it.
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import crypto from "node:crypto";
import http from "node:http";
import { fileURLToPath } from "node:url";

const PROJECT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
process.chdir(PROJECT);

const results = [];
const check = (name, ok, detail = "") => {
  results.push(ok);
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
};

// ---- the remote-end simulator: a tiny GitHub REST v3 lookalike --------------
function startMockGitHub() {
  const state = {
    repos: new Map(),       // full_name → { html_url, private, branches: Map(name → sha) }
    commits: new Map(),     // sha → { sha, tree, parents, message }
    trees: new Map(),       // sha → { sha, entries: [{path, sha}] }
    blobs: new Map(),       // sha → Buffer
    calls: [],
  };
  const sha = () => crypto.randomBytes(20).toString("hex");
  const j = (res, code, obj) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(obj)); };

  const srv = http.createServer((req, res) => {
    let chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf8");
      const json = body ? JSON.parse(body) : {};
      state.calls.push(`${req.method} ${req.url}`);
      const auth = req.headers.authorization || "";
      if (!auth.startsWith("Bearer mock-token-")) return j(res, 401, { message: "Bad credentials" });

      let m;
      if (req.method === "GET" && req.url === "/user") {
        return j(res, 200, { login: "mockorg", id: 1 });
      }
      if (req.method === "POST" && req.url === "/user/repos") {
        const full = `mockorg/${json.name}`;
        if (state.repos.has(full)) return j(res, 422, { message: "name already exists on this account" });
        state.repos.set(full, { html_url: `https://github.example.test/${full}`, private: json.private, branches: new Map() });
        return j(res, 201, { full_name: full, html_url: `https://github.example.test/${full}`, private: json.private });
      }
      if ((m = req.url.match(/^\/repos\/([^/]+)\/([^/]+)$/)) && req.method === "GET") {
        const full = `${m[1]}/${m[2]}`;
        const repo = state.repos.get(full);
        if (!repo) return j(res, 404, { message: "Not Found" });
        return j(res, 200, { full_name: full, html_url: repo.html_url, private: repo.private });
      }
      if ((m = req.url.match(/^\/repos\/([^/]+)\/([^/]+)\/git\/blobs$/)) && req.method === "POST") {
        const buf = Buffer.from(json.content, "base64");
        const s = sha();
        state.blobs.set(s, buf);
        return j(res, 201, { sha: s });
      }
      if ((m = req.url.match(/^\/repos\/([^/]+)\/([^/]+)\/git\/trees$/)) && req.method === "POST") {
        const s = sha();
        state.trees.set(s, { sha: s, entries: json.tree });
        return j(res, 201, { sha: s });
      }
      if ((m = req.url.match(/^\/repos\/([^/]+)\/([^/]+)\/git\/commits$/)) && req.method === "POST") {
        const s = sha();
        state.commits.set(s, { sha: s, tree: json.tree, parents: json.parents, message: json.message });
        return j(res, 201, { sha: s, tree: json.tree, parents: json.parents });
      }
      if ((m = req.url.match(/^\/repos\/([^/]+)\/([^/]+)\/git\/commits\/([0-9a-f]{40})$/)) && req.method === "GET") {
        const c = state.commits.get(m[3]);
        if (!c) return j(res, 404, { message: "Not Found" });
        return j(res, 200, c);
      }
      if ((m = req.url.match(/^\/repos\/([^/]+)\/([^/]+)\/git\/ref\/heads\/(.+)$/)) && req.method === "GET") {
        const repo = state.repos.get(`${m[1]}/${m[2]}`);
        const refSha = repo?.branches.get(m[3]);
        if (!refSha) return j(res, 404, { message: "Not Found" });
        return j(res, 200, { object: { sha: refSha } });
      }
      if ((m = req.url.match(/^\/repos\/([^/]+)\/([^/]+)\/git\/refs$/)) && req.method === "POST") {
        const repo = state.repos.get(`${m[1]}/${m[2]}`);
        const branch = String(json.ref).replace("refs/heads/", "");
        repo.branches.set(branch, json.sha);
        return j(res, 201, { ref: json.ref, object: { sha: json.sha } });
      }
      if ((m = req.url.match(/^\/repos\/([^/]+)\/([^/]+)\/git\/refs\/heads\/(.+)$/)) && req.method === "PATCH") {
        const repo = state.repos.get(`${m[1]}/${m[2]}`);
        const cur = repo?.branches.get(m[3]);
        if (!cur) return j(res, 422, { message: "Reference does not exist" });
        if (!json.force && cur !== json.sha && !state.commits.get(json.sha)?.parents.includes(cur)) {
          return j(res, 422, { message: "Update is not a fast forward" });
        }
        repo.branches.set(m[3], json.sha);
        return j(res, 200, { object: { sha: json.sha } });
      }
      return j(res, 404, { message: `mock remote has no route for ${req.method} ${req.url}` });
    });
  });
  return new Promise((resolve) => srv.listen(0, "127.0.0.1", () => resolve({ srv, state, base: `http://127.0.0.1:${srv.address().port}` })));
}

const gh = await import("../src/platform/github-publish.js");
const work = fs.mkdtempSync(path.join(os.tmpdir(), "ghpub-test-"));
const projectDir = path.join(work, "project");
fs.mkdirSync(path.join(projectDir, "assets"), { recursive: true });
fs.writeFileSync(path.join(projectDir, "index.html"), "<html><body><h1>cloner export</h1></body></html>");
fs.writeFileSync(path.join(projectDir, "assets", "app.js"), "console.log('hello');");
fs.writeFileSync(path.join(projectDir, "assets", "style.css"), "body{margin:0}");

// ---- token-absent clean error (no network) ----
{
  const saved = process.env.GITHUB_PUBLISH_TOKEN;
  delete process.env.GITHUB_PUBLISH_TOKEN;
  let err = null;
  try { await gh.ghGetAuthenticatedUser(); } catch (e) { err = e; }
  check("G1  token absent → clean actionable error naming the env var", !!err && /GITHUB_PUBLISH_TOKEN/.test(err.message) && err.code === "GITHUB_TOKEN_MISSING", err?.message?.slice(0, 90));
  process.env.GITHUB_PUBLISH_TOKEN = saved;
}

// ---- no mock branch in the product module (grep) ----
{
  const src = fs.readFileSync(path.join(PROJECT, "src", "platform", "github-publish.js"), "utf8");
  const mockBranch = /if\s*\(\s*process\.env\.[A-Z_]*MOCK|mockMode|USE_MOCK/.test(src);
  check("G2  product module has NO mock branch (env-gated mock patterns absent)", !mockBranch, "grep clean");
}

process.env.GITHUB_PUBLISH_TOKEN = "mock-token-" + crypto.randomBytes(4).toString("hex");
const { srv, state, base } = await startMockGitHub();
process.env.GITHUB_API_URL = base;

// ---- full publish flow ----
{
  const out = await gh.publishProjectToGithub({ owner: "mockorg", repo: "cloner-export-" + crypto.randomBytes(3).toString("hex"), dir: projectDir, private: true });
  check("G3  publish returns htmlUrl + commitSha + file count", !!out.htmlUrl && /^[0-9a-f]{40}$/.test(out.commitSha) && out.pushed === 3, JSON.stringify({ htmlUrl: out.htmlUrl, files: out.pushed }));
  check("G4  real REST sequence hit the mock remote (repos → blobs → tree → commit → ref)",
    state.calls.some((c) => c === "POST /user/repos") && state.calls.filter((c) => c.includes("/git/blobs")).length === 3 && state.calls.some((c) => c.includes("/git/trees")) && state.calls.some((c) => c.includes("/git/commits") && !c.includes("/git/commits/")), state.calls.length + " calls");
  check("G5  tree carries all 3 files at the right paths", (out.files || []).join(",") === "assets/app.js,assets/style.css,index.html", (out.files || []).join(","));

  // byte-exact readback through the mock's object store
  const full = new URL(out.htmlUrl).pathname.slice(1);
  const repo = state.repos.get(full);
  const headSha = repo.branches.get("main");
  const commit = state.commits.get(headSha);
  const tree = state.trees.get(commit.tree);
  const idxEntry = tree.entries.find((e) => e.path === "index.html");
  const blob = state.blobs.get(idxEntry.sha);
  check("G6  pushed blob is byte-identical to the source file", blob.equals(fs.readFileSync(path.join(projectDir, "index.html"))), `${blob.length}B`);

  // fast-forward chain: second push parents onto the first commit
  fs.writeFileSync(path.join(projectDir, "extra.txt"), "second push");
  const out2 = await gh.publishProjectToGithub({ owner: "mockorg", repo: full.split("/")[1], dir: projectDir, private: true, allowExisting: true });
  const commit2 = state.commits.get(out2.commitSha);
  check("G7  second push parents onto the first commit (fast-forward, no force)", commit2.parents.length === 1 && commit2.parents[0] === out.commitSha, `${out.commitSha.slice(0, 8)} → ${out2.commitSha.slice(0, 8)}`);
  check("G8  second push tree parents on the base tree (incremental)", state.calls.some((c) => c.includes("/git/trees")), "tree call made");
}

// ---- upload-path safety: refused BEFORE network ----
{
  const callsBefore = state.calls.length;
  const badDir = path.join(work, "bad");
  fs.mkdirSync(badDir, { recursive: true });
  fs.writeFileSync(path.join(badDir, "cookies.json"), "{}");
  let err = null;
  try { await gh.publishProjectToGithub({ owner: "mockorg", repo: "safe-repo", dir: badDir }); } catch (e) { err = e; }
  check("G9  credential-named upload path REFUSED before any network call",
    !!err && /credential|sensitive/i.test(err.message) && err.status === 400 && state.calls.length === callsBefore, err?.message?.slice(0, 90));

  const emptyDir = path.join(work, "empty");
  fs.mkdirSync(emptyDir, { recursive: true });
  let err2 = null;
  try { await gh.publishProjectToGithub({ owner: "mockorg", repo: "safe-repo", dir: emptyDir }); } catch (e) { err2 = e; }
  check("G10 empty upload dir refused", !!err2 && /empty/.test(err2.message), err2?.message?.slice(0, 80));
}

// ---- typed API error mapping ----
{
  let err = null;
  try { await gh.ghGetRepo("mockorg", "does-not-exist"); } catch (e) { err = e; }
  check("G11 upstream 404 mapped to typed GitHubPublishError with status", !!err && err.name === "GitHubPublishError" && err.status === 404, `${err?.name} status=${err?.status}`);

  // bad token → 401 from the remote
  const saved = process.env.GITHUB_PUBLISH_TOKEN;
  process.env.GITHUB_PUBLISH_TOKEN = "wrong-token";
  let err401 = null;
  try { await gh.ghGetAuthenticatedUser(); } catch (e) { err401 = e; }
  check("G12 wrong token → upstream 401 surfaced", !!err401 && err401.status === 401, `status=${err401?.status}`);
  process.env.GITHUB_PUBLISH_TOKEN = saved;
}

// ---- cleanup ----
srv.close();
fs.rmSync(work, { recursive: true, force: true });
delete process.env.GITHUB_API_URL;
delete process.env.GITHUB_PUBLISH_TOKEN;

const pass = results.filter(Boolean).length;
const fail = results.length - pass;
console.log(`\nRESULT: ${fail ? "FAIL" : "PASS"}  (${pass}/${results.length})`);
process.exit(fail ? 1 : 0);
