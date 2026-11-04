// GitHub publishing integration (task 4.1.8).
//
// REAL REST flow: create repo → push the export zip contents as a git tree
// (blobs → tree → commit → ref) → return the repo URL. Token via env
// (GITHUB_PUBLISH_TOKEN, never stored server-side beyond process env), API
// base via GITHUB_API_URL (defaults to the REAL https://api.github.com).
//
// NO MOCK BRANCH IN THIS MODULE: every HTTP call below goes to the configured
// REAL endpoint. The test suite (scripts/test-github-publish.mjs) simulates
// the REMOTE side only — a local http server speaking the GitHub REST v3
// shapes, pointed at via GITHUB_API_URL — exactly like test-stripe-real.mjs
// points billing at its Stripe-API-compatible gateway.
//
// Reuses the safety rules from github-publish-real.js (G1.1):
//   • sensitive/credential-named upload paths are refused BEFORE any network
//     call (isSensitiveName at every segment)
//   • delete-guard: pushes NEVER force-update a moved ref (409 on non-FF)
//
// Surface (all async, all real-HTTP):
//   ghApiBase() / ghToken()             — env config (clean errors when absent)
//   ghCreateRepo({ name, description, private })
//   ghPushTree({ owner, repo, branch, dir })  — dir → commit tree on branch
//   ghGetRepo(owner, repo)
//   ghRepoUrl(owner, repo)
//   publishProjectToGithub({ owner, repo, dir, private, branch })
//                                       → { htmlUrl, commitSha, files }
//   githubPublishRouter({ guard })      — INTEGRATOR MOUNT LINE:
//       import { githubPublishRouter } from "./github-publish.js";
//       app.use("/api/publish", githubPublishRouter({ guard: localOrAuthed("publish:task") }));
import fs from "node:fs";
import path from "node:path";
import { Router } from "express";
import { isSensitiveName } from "./exporter.js";

const REQUEST_TIMEOUT_MS = 20_000;

export function ghApiBase() {
  return (process.env.GITHUB_API_URL || "https://api.github.com").replace(/\/+$/, "");
}

export function ghToken() {
  const token = (process.env.GITHUB_PUBLISH_TOKEN || "").trim();
  if (!token) {
    const e = new Error("GitHub publishing requires GITHUB_PUBLISH_TOKEN (env) — set it and retry; nothing was simulated");
    e.status = 503;
    e.code = "GITHUB_TOKEN_MISSING";
    throw e;
  }
  return token;
}

export class GitHubPublishError extends Error {
  constructor(message, { status = null, endpoint = null, details = null } = {}) {
    super(message);
    this.name = "GitHubPublishError";
    this.status = status;
    this.endpoint = endpoint;
    this.details = details;
  }
}

async function ghFetch(method, endpointPath, { body, raw = false, accept = "application/vnd.github+json" } = {}) {
  const token = ghToken();
  const url = endpointPath.startsWith("http") ? endpointPath : ghApiBase() + endpointPath;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS);
  let res;
  try {
    res = await fetch(url, {
      method,
      headers: {
        "authorization": `Bearer ${token}`,
        "accept": accept,
        "content-type": "application/json",
        "user-agent": "cloner-platform",
        ...(body ? {} : { "content-length": "0" }),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: ctrl.signal,
    });
  } catch (e) {
    throw new GitHubPublishError(`GitHub API unreachable (${method} ${endpointPath}): ${e?.message || e}`, { endpoint: `${method} ${endpointPath}` });
  } finally {
    clearTimeout(timer);
  }
  const text = await res.text();
  if (raw || !res.headers.get("content-type")?.includes("application/json")) {
    if (!res.ok) throw new GitHubPublishError(`GitHub API ${res.status} on ${method} ${endpointPath}`, { status: res.status, endpoint: `${method} ${endpointPath}`, details: text.slice(0, 300) });
    return { status: res.status, data: text };
  }
  let json = null;
  try { json = JSON.parse(text); } catch { /* empty body */ }
  if (!res.ok) {
    const msg = json?.message || text.slice(0, 200);
    throw new GitHubPublishError(`GitHub API ${res.status} on ${method} ${endpointPath}: ${msg}`, { status: res.status, endpoint: `${method} ${endpointPath}`, details: json });
  }
  return { status: res.status, data: json };
}

export async function ghGetAuthenticatedUser() {
  const { data } = await ghFetch("GET", "/user");
  return data;
}

export async function ghGetRepo(owner, repo) {
  const { data } = await ghFetch("GET", `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`);
  return data;
}

export async function ghCreateRepo({ name, description = "", private: isPrivate = true, allowExisting = false } = {}) {
  if (!name || !/^[A-Za-z0-9._-]{1,100}$/.test(name)) {
    throw new GitHubPublishError(`invalid repo name "${name}"`, { status: 400 });
  }
  try {
    const { data } = await ghFetch("POST", "/user/repos", { body: { name, description, private: !!isPrivate, auto_init: false } });
    return data;
  } catch (e) {
    if (e.status === 422 && allowExisting) {
      const me = await ghGetAuthenticatedUser();
      return ghGetRepo(me.login, name);
    }
    throw e;
  }
}

// ── upload-path safety (same rules as exporter.js / github-publish-real.js) ──
export function normalizeUploadPath(p) {
  const clean = String(p || "").replace(/\\/g, "/").replace(/^\/+/, "");
  if (!clean || clean.includes("..")) throw new GitHubPublishError(`refusing unsafe upload path "${p}"`, { status: 400 });
  for (const segment of clean.split("/")) {
    if (isSensitiveName(segment)) {
      throw new GitHubPublishError(`refusing to publish credential-named path "${clean}" (segment "${segment}")`, { status: 400 });
    }
  }
  return clean;
}

export function collectUploadFiles(dir) {
  const out = [];
  (function walk(rel) {
    for (const ent of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) {
      if (ent.name === "private" || ent.name === "export-staging" || ent.name === "node_modules") continue;
      const r = rel ? rel + "/" + ent.name : ent.name;
      if (ent.isDirectory()) walk(r);
      else if (ent.isFile()) out.push(r);
    }
  })("");
  return out.sort();
}

// Push a directory as a commit tree onto a branch. Fast-forward only: the
// commit parents onto the branch's CURRENT head (or is a root commit for a
// new/empty repo) and the ref update sends the expected old sha — GitHub
// rejects non-fast-forward updates with 422, so remote history is never
// overwritten (delete-guard).
export async function ghPushTree({ owner, repo, branch = "main", dir } = {}) {
  if (!dir || !fs.existsSync(dir)) throw new GitHubPublishError(`upload dir not found: ${dir}`, { status: 400 });
  const files = collectUploadFiles(dir);
  if (!files.length) throw new GitHubPublishError("upload dir is empty — nothing to publish", { status: 400 });

  // safety FIRST: refuse credential-shaped trees before any network call
  for (const f of files) normalizeUploadPath(f);

  // 1. base commit (null → root commit)
  let baseSha = null;
  const refRes = await ghFetch("GET", `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/git/ref/heads/${encodeURIComponent(branch)}`).catch((e) => {
    if (e.status === 404) return { status: 404, data: null };
    throw e;
  });
  if (refRes.status === 200 && refRes.data?.object?.sha) baseSha = refRes.data.object.sha;
  let baseTreeSha = null;
  let baseCommitTree = null;
  if (baseSha) {
    const commit = (await ghFetch("GET", `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/git/commits/${baseSha}`)).data;
    baseCommitTree = commit.tree?.sha || null;
  }

  // 2. blobs (base64, real git data API)
  const treeEntries = [];
  for (const rel of files) {
    const content = fs.readFileSync(path.join(dir, rel));
    const blob = (await ghFetch("POST", `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/git/blobs`, {
      body: { content: content.toString("base64"), encoding: "base64" },
    })).data;
    treeEntries.push({ path: normalizeUploadPath(rel), mode: "100644", type: "blob", sha: blob.sha });
  }

  // 3. tree (parented on the base tree so unchanged blobs stay shared)
  const treeBody = baseCommitTree ? { base_tree: baseCommitTree, tree: treeEntries } : { tree: treeEntries };
  const tree = (await ghFetch("POST", `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/git/trees`, { body: treeBody })).data;

  // 4. commit + 5. ref (expected old sha → non-FF is refused server-side)
  const commit = (await ghFetch("POST", `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/git/commits`, {
    body: { message: `Publish cloner export (${files.length} files)`, tree: tree.sha, parents: baseSha ? [baseSha] : [] },
  })).data;
  if (baseSha) {
    await ghFetch("PATCH", `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/git/refs/heads/${encodeURIComponent(branch)}`, {
      body: { sha: commit.sha, force: false },
    });
  } else {
    await ghFetch("POST", `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/git/refs`, {
      body: { ref: `refs/heads/${branch}`, sha: commit.sha },
    });
  }
  return { commitSha: commit.sha, treeSha: tree.sha, files, baseSha };
}

export function ghRepoUrl(owner, repo) {
  return `${ghApiBase().replace("api.", "")}/${owner}/${repo}`;
}

export async function publishProjectToGithub({ owner, repo, dir, private: isPrivate = true, branch = "main", allowExisting = false } = {}) {
  // safety BEFORE the network: refuse empty/credential-shaped trees before a
  // single REST call is made (a repo must never be created for an upload that
  // will fail the sensitive-name gate)
  if (!dir || !fs.existsSync(dir)) throw new GitHubPublishError(`upload dir not found: ${dir}`, { status: 400 });
  const preflightFiles = collectUploadFiles(dir);
  if (!preflightFiles.length) throw new GitHubPublishError("upload dir is empty — nothing to publish", { status: 400 });
  for (const f of preflightFiles) normalizeUploadPath(f);

  const created = await ghCreateRepo({ name: repo, private: isPrivate, allowExisting });
  const full = created?.full_name?.split("/") || [owner, repo];
  const push = await ghPushTree({ owner: full[0], repo: full[1], branch, dir });
  const htmlUrl = created?.html_url || ghRepoUrl(full[0], full[1]);
  return { htmlUrl, commitSha: push.commitSha, files: push.files, pushed: push.files.length };
}

export function githubPublishRouter({ guard } = {}) {
  const router = Router();
  const g = guard || ((req, res, next) => {
    if (req.userRole === "admin") return next();
    res.status(403).json({ ok: false, error: "guard required" });
  });
  router.use(g);
  router.use((req, res, next) => {
    // small JSON payloads only
    express.json({ limit: "64kb" })(req, res, next);
  });

  router.get("/status", async (_req, res) => {
    const configured = !!(process.env.GITHUB_PUBLISH_TOKEN || "").trim();
    res.json({ ok: true, configured, apiBase: ghApiBase() });
  });

  router.get("/me", async (_req, res) => {
    try {
      res.json({ ok: true, user: await ghGetAuthenticatedUser() });
    } catch (e) {
      res.status(e.status || 502).json({ ok: false, error: String(e?.message || e).slice(0, 200) });
    }
  });

  router.post("/publish", async (req, res) => {
    try {
      const { owner, repo, dir, private: isPrivate, branch } = req.body || {};
      if (!owner || !repo || !dir) return res.status(400).json({ ok: false, error: "owner, repo and dir are required" });
      const out = await publishProjectToGithub({ owner, repo, dir, private: isPrivate !== false, branch: branch || "main", allowExisting: req.body?.allowExisting === true });
      res.json({ ok: true, ...out });
    } catch (e) {
      res.status(e.status || 502).json({ ok: false, error: String(e?.message || e).slice(0, 300) });
    }
  });

  return router;
}
import express from "express";
