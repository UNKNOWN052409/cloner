// GitHub publishing — REAL GitHub REST v3 (task G1.1). No mock branch exists:
// every call below goes to the real GitHub API (https://api.github.com by
// default; GITHUB_API_URL may point at a real GitHub Enterprise Server install).
// Without GITHUB_PUBLISH_TOKEN every entry point throws one clean, actionable
// error naming the env var — nothing is simulated anywhere in this module.
//
// Capabilities (REST v3, the git data API):
//   1. createRepo            POST /user/repos
//   2. pushTree              blobs → tree → commit → ref (create or fast-forward)
//   3. setRepoVisibility     PATCH /repos/{owner}/{repo} { private }
// plus the read/delete helpers the self-test and the router need:
//      getAuthenticatedUser, getRepo, getRepoFile, deleteRepo.
//
// Safety, mirroring src/platform/exporter.js:
//   - every path slated for upload is checked with isSensitiveName() at EVERY
//     segment; anything credential-shaped (cookies.json, secrets/, .env,
//     storageState.json, …) fails the publish BEFORE a single network call.
//   - pushTree always parents onto the branch's current head and PATCHes with
//     force:false by default → remote changes are never silently overwritten.
//
// Integrator mount line (server.js is integrator-owned; additive):
//   import { githubPublishRouter } from "./github-publish-real.js";
//   app.use("/api/github", githubPublishRouter({ guard: localOrAuthed("publish:task") }));
import fs from "node:fs";
import path from "node:path";
import { Router } from "express";
import { isSensitiveName } from "./exporter.js";

export class GitHubPublishError extends Error {
  constructor(message, { status = null, endpoint = null, details = null } = {}) {
    super(message);
    this.name = "GitHubPublishError";
    this.status = status;         // upstream HTTP status, when the API answered
    this.endpoint = endpoint;     // method + path, e.g. "POST /user/repos"
    this.details = details;       // upstream response body when JSON
  }
}

// ── configuration ────────────────────────────────────────────────────────────
// Default is the REAL github.com API. GITHUB_API_URL exists for genuine
// GitHub Enterprise Server installs — pointing product code anywhere else is
// operator misconfiguration, not a supported mode.
export function apiBase() {
  const raw = (process.env.GITHUB_API_URL || "https://api.github.com").trim();
  return raw.replace(/\/+$/, "");
}

export function requireToken() {
  const token = (process.env.GITHUB_PUBLISH_TOKEN || "").trim();
  if (!token) {
    throw new GitHubPublishError(
      "GITHUB_PUBLISH_TOKEN is not set — GitHub publishing needs a classic personal access token " +
      "with the `repo` scope (and `delete_repo` only for scripts/test-real-github.mjs cleanup; " +
      "fine-grained tokens cannot delete repositories). Set it in the environment / .env. " +
      "Publishing is never mocked, so without a token it refuses to run.",
    );
  }
  return token;
}

// ── low-level REST client ────────────────────────────────────────────────────
const API_VERSION = "2022-11-28";
const UA = "cloner-platform/0.1 (github-publish-real)";
const TRANSIENT = new Set([502, 503, 504]);

async function once(method, endpointPath, { body, token, timeoutMs = 30000 } = {}) {
  const url = endpointPath.startsWith("http")
    ? endpointPath
    : `${apiBase()}${endpointPath.startsWith("/") ? endpointPath : `/${endpointPath}`}`;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  let res;
  try {
    res = await fetch(url, {
      method,
      signal: ac.signal,
      headers: {
        "Accept": "application/vnd.github+json",
        "X-GitHub-Api-Version": API_VERSION,
        "User-Agent": UA,
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
        ...(token ? { "Authorization": `Bearer ${token}` } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch (e) {
    const reason = e?.name === "AbortError" ? `timed out after ${timeoutMs}ms` : (e?.cause?.code || e?.code || e?.message);
    throw new GitHubPublishError(`GitHub API request failed (${method} ${url}): ${reason}`, { endpoint: `${method} ${endpointPath}` });
  } finally {
    clearTimeout(timer);
  }
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* non-JSON body (e.g. plain errors) */ }
  return { status: res.status, headers: res.headers, json, text };
}

// GitHub REST client with one automatic retry on transient 5xx/network hiccups
// and precise, human-actionable error mapping (401 token, 403 scopes/rate
// limit, 404 missing, 409 empty repo, 422 validation).
export async function githubRequest(method, endpointPath, opts = {}) {
  const { token, ...rest } = opts;
  let r = await once(method, endpointPath, { ...rest, token });
  if (TRANSIENT.has(r.status)) {
    await new Promise((ok) => setTimeout(ok, 1500));
    r = await once(method, endpointPath, { ...rest, token });
  }
  if (r.status >= 200 && r.status < 300) return r;

  const gh = r.json?.message || r.text?.slice(0, 200) || "(no body)";
  const endpoint = `${method} ${endpointPath}`;
  if (r.status === 401) {
    throw new GitHubPublishError(
      `GitHub rejected the credential (401) — GITHUB_PUBLISH_TOKEN is expired, revoked or malformed. Regenerate it at https://github.com/settings/tokens. Upstream said: ${gh}`,
      { status: 401, endpoint, details: r.json },
    );
  }
  if (r.status === 403 && r.headers?.get("x-ratelimit-remaining") === "0") {
    const reset = Number(r.headers.get("x-ratelimit-reset") || 0);
    const when = reset ? new Date(reset * 1000).toISOString() : "unknown";
    throw new GitHubPublishError(
      `GitHub rate limit exhausted (403, x-ratelimit-remaining=0, resets ${when}) on ${endpoint}. Authenticated publishing gets 5000 req/h.`,
      { status: 403, endpoint, details: r.json },
    );
  }
  if (r.status === 403) {
    throw new GitHubPublishError(
      `GitHub denied the operation (403) on ${endpoint} — the token's scopes/permissions are insufficient (publishing needs the classic \`repo\` scope; deleting needs \`delete_repo\`). Upstream said: ${gh}`,
      { status: 403, endpoint, details: r.json },
    );
  }
  if (r.status === 404) {
    throw new GitHubPublishError(
      `GitHub returned 404 on ${endpoint} — the repo/branch/path does not exist or the token cannot see it. Upstream said: ${gh}`,
      { status: 404, endpoint, details: r.json },
    );
  }
  if (r.status === 409) {
    // GET /git/ref/heads/<branch> on a repo with zero commits answers 409
    throw new GitHubPublishError(gh, { status: 409, endpoint, details: r.json });
  }
  if (r.status === 422) {
    throw new GitHubPublishError(
      `GitHub rejected the payload (422) on ${endpoint}: ${gh}`,
      { status: 422, endpoint, details: r.json },
    );
  }
  throw new GitHubPublishError(`GitHub API error ${r.status} on ${endpoint}: ${gh}`, { status: r.status, endpoint, details: r.json });
}

// ── accounts & repos ─────────────────────────────────────────────────────────
export async function getAuthenticatedUser() {
  const token = requireToken();
  const r = await githubRequest("GET", "/user", { token });
  return { login: r.json.login, id: r.json.id, html_url: r.json.html_url };
}

export async function getRepo(owner, repo) {
  const token = requireToken();
  const r = await githubRequest("GET", `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`, { token });
  return r.json;
}

// POST /user/repos. With allowExisting:true a 422 "name already exists" is
// resolved by returning the existing repo (existing:true) instead of failing.
export async function createRepo({ name, description = "", private: isPrivate = true, allowExisting = false } = {}) {
  const token = requireToken();
  if (!name || typeof name !== "string" || !/^[A-Za-z0-9._-]+$/.test(name)) {
    throw new GitHubPublishError(`invalid repository name ${JSON.stringify(name)} — allowed: letters, digits, '.', '_', '-'`);
  }
  try {
    const r = await githubRequest("POST", "/user/repos", {
      token,
      body: { name, description, private: !!isPrivate, has_issues: false, has_wiki: false, auto_init: false },
    });
    return { ...r.json, created: true };
  } catch (e) {
    const already = e.status === 422 && JSON.stringify(e.details?.errors || e.details || "").includes("already exists");
    if (allowExisting && already) {
      const who = (await getAuthenticatedUser()).login;
      return { ...(await getRepo(who, name)), existing: true };
    }
    if (already) {
      throw new GitHubPublishError(
        `repository "${name}" already exists on this account (422) — pass allowExisting:true to publish into it, or pick another name`,
        { status: 422, endpoint: "POST /user/repos", details: e.details },
      );
    }
    throw e;
  }
}

export async function setRepoVisibility({ owner, repo, visibility } = {}) {
  const token = requireToken();
  if (visibility !== "public" && visibility !== "private") {
    throw new GitHubPublishError(`visibility must be "public" or "private", got ${JSON.stringify(visibility)}`);
  }
  const r = await githubRequest("PATCH", `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`, {
    token,
    body: { private: visibility === "private" },
  });
  return r.json;
}

// DELETE /repos/{owner}/{repo} — destructive; requires an explicit confirm
// string so a stray call cannot wipe a real repository.
export async function deleteRepo({ owner, repo, confirm } = {}) {
  const token = requireToken();
  if (confirm !== "delete") {
    throw new GitHubPublishError(`deleteRepo refuses to run without { confirm: "delete" } (destructive)`);
  }
  const r = await githubRequest("DELETE", `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`, { token });
  return r.status === 204;
}

// GET /repos/{owner}/{repo}/contents/<path>?ref= → { path, content(Buffer), sha, encoding }
export async function getRepoFile({ owner, repo, filePath, ref } = {}) {
  const token = requireToken();
  const q = ref ? `?ref=${encodeURIComponent(ref)}` : "";
  const enc = filePath.split("/").map(encodeURIComponent).join("/");
  const r = await githubRequest("GET", `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/contents/${enc}${q}`, { token });
  if (r.json?.type !== "file") throw new GitHubPublishError(`${filePath} is not a file on GitHub (type=${r.json?.type})`);
  return {
    path: r.json.path,
    sha: r.json.sha,
    size: r.json.size,
    content: Buffer.from(r.json.content || "", "base64"),
  };
}

// ── file handling ────────────────────────────────────────────────────────────
const BINARY_EXT = /\.(png|jpe?g|gif|webp|avif|ico|bmp|woff2?|ttf|eot|otf|mp4|webm|mp3|pdf|zip|gz|wasm)$/i;

// Normalize one virtual path: forward slashes, no leading "/", no "..", no
// empty segments, no drive letters. Every segment is run through
// isSensitiveName() — credential-shaped trees are refused before upload.
export function normalizeUploadPath(p) {
  const raw = String(p ?? "").trim().replace(/\\/g, "/");
  if (!raw || raw === "." ) throw new GitHubPublishError("upload path is empty");
  if (raw.startsWith("/") || /^[A-Za-z]:/.test(raw)) {
    throw new GitHubPublishError(`upload path must be repo-relative, got ${JSON.stringify(raw)}`);
  }
  const clean = raw.replace(/^\.\//, ""); // "./a.txt" → "a.txt"; "../" and "/" stay rejected
  const segments = clean.split("/");
  if (segments.some((s) => !s || s === "." || s === "..")) {
    throw new GitHubPublishError(`upload path must not contain "..", "." or empty segments, got ${JSON.stringify(String(p))}`);
  }
  const offender = segments.find((s) => isSensitiveName(s));
  if (offender) {
    throw new GitHubPublishError(
      `refusing to publish credential/session-named path "${clean}" (segment "${offender}" matches the exporter's sensitive-name rules)`,
    );
  }
  return segments.join("/");
}

// { path, content } → { path, encoding: "utf-8" | "base64", content }
export function normalizeUploadFile(f) {
  if (!f || typeof f !== "object" || !f.path) throw new GitHubPublishError("each file needs { path, content | contentBase64 }");
  const p = normalizeUploadPath(f.path);
  if (typeof f.contentBase64 === "string") return { path: p, encoding: "base64", content: f.contentBase64 };
  if (Buffer.isBuffer(f.content)) return { path: p, encoding: "base64", content: f.content.toString("base64") };
  if (typeof f.content === "string") return { path: p, encoding: "utf-8", content: f.content };
  throw new GitHubPublishError(`file ${p}: provide content (string|Buffer) or contentBase64`);
}

// Walk a REAL directory into normalized files. Default mode mirrors the
// exporter's stageClean: sensitive entries and the standard non-shippable dirs
// (node_modules, .git, private, export-staging) are skipped and reported in
// `excluded`. With skipSensitive:false the walk is fail-closed instead — the
// first credential-shaped entry ABORTS the publish (exporter verifyStagedTree
// semantics), and a final re-verify over the produced list stays as
// defense-in-depth in both modes.
export function collectFilesFromDir(dir, { skipSensitive = true } = {}) {
  const files = [];
  const excluded = [];
  if (!fs.existsSync(dir)) throw new GitHubPublishError(`directory to publish does not exist: ${dir}`);
  if (!fs.statSync(dir).isDirectory()) throw new GitHubPublishError(`not a directory: ${dir}`);
  const walk = (cur) => {
    for (const e of fs.readdirSync(cur, { withFileTypes: true })) {
      const abs = path.join(cur, e.name);
      if (isSensitiveName(e.name)) {
        if (!skipSensitive) {
          throw new GitHubPublishError(
            `export-style fail-closed: refusing to publish — credential/session-named entry "${path.relative(dir, abs).split(path.sep).join("/")}"`,
          );
        }
        excluded.push(path.relative(dir, abs).split(path.sep).join("/"));
        continue;
      }
      if (e.name === "node_modules" || e.name === ".git" || e.name === "export-staging") {
        excluded.push(path.relative(dir, abs).split(path.sep).join("/"));
        continue;
      }
      if (e.isDirectory()) { walk(abs); continue; }
      if (!e.isFile()) continue;
      const rel = path.relative(dir, abs).split(path.sep).join("/");
      if (BINARY_EXT.test(e.name)) {
        files.push({ path: rel, encoding: "base64", content: fs.readFileSync(abs).toString("base64") });
      } else {
        files.push({ path: rel, encoding: "utf-8", content: fs.readFileSync(abs, "utf8") });
      }
    }
  };
  walk(dir);
  if (!skipSensitive) {
    const offenders = files.filter((f) => {
      try { normalizeUploadPath(f.path); return false; } catch { return true; }
    });
    if (offenders.length) {
      throw new GitHubPublishError(`credential/session-named entries reached staging: ${offenders.map((o) => o.path).join(", ")}`);
    }
  }
  return { files, excluded };
}

// ── git data push ────────────────────────────────────────────────────────────
const refPath = (branch) =>
  `git/refs/heads/${String(branch).replace(/^refs\/heads\//, "").split("/").map(encodeURIComponent).join("/")}`;

// Resolve the parent commit for `branch` on {owner,repo}:
//   branch exists            → { sha: head, tree: headCommit.tree.sha, exists: true }
//   repo empty (no commits)  → null  (409 "Git Repository is empty" from the API)
//   repo has commits, branch missing → head of the DEFAULT branch, exists:false
async function resolveBase(owner, repo, branch, token) {
  try {
    const ref = await githubRequest("GET", `/${refPath(branch)}`, { token });
    const sha = ref.json.object.sha;
    const commit = await githubRequest("GET", `/git/commits/${encodeURIComponent(sha)}`, { token });
    return { sha, tree: commit.json.tree.sha, exists: true };
  } catch (e) {
    if (e.status === 409) return null; // empty repository — first commit ever
    if (e.status !== 404) throw e;
    const meta = await githubRequest("GET", `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`, { token });
    const def = meta.json.default_branch || "main";
    try {
      const ref = await githubRequest("GET", `/${refPath(def)}`, { token });
      const sha = ref.json.object.sha;
      const commit = await githubRequest("GET", `/git/commits/${encodeURIComponent(sha)}`, { token });
      return { sha, tree: commit.json.tree.sha, exists: false, fromDefaultBranch: def };
    } catch (e2) {
      if (e2.status === 409) return null;
      throw e2;
    }
  }
}

export async function pushTree({ owner, repo, branch = "main", files, message = "publish", force = false } = {}) {
  const token = requireToken();
  if (!Array.isArray(files) || !files.length) throw new GitHubPublishError("pushTree needs at least one file");
  const norm = files.map(normalizeUploadFile);

  // 1. blobs (deduped by content, small concurrent pool — real REST, one call per blob)
  const byContent = new Map();
  const blobs = new Array(norm.length);
  const chunk = 5;
  for (let i = 0; i < norm.length; i += chunk) {
    await Promise.all(norm.slice(i, i + chunk).map(async (f, j) => {
      const key = `${f.encoding}:${f.content}`;
      if (!byContent.has(key)) {
        const r = await githubRequest("POST", `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/git/blobs`, {
          token, body: { content: f.content, encoding: f.encoding },
        });
        byContent.set(key, r.json.sha);
      }
      blobs[i + j] = { path: f.path, sha: byContent.get(key) };
    }));
  }

  // 2. tree (base_tree only when a parent commit exists — omit for the first commit)
  const base = await resolveBase(owner, repo, branch, token);
  const treeBody = { tree: blobs.map((b) => ({ path: b.path, mode: "100644", type: "blob", sha: b.sha })) };
  if (base) treeBody.base_tree = base.tree;
  const tree = await githubRequest("POST", `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/git/trees`, {
    token, body: treeBody,
  });

  // 3. commit
  const commit = await githubRequest("POST", `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/git/commits`, {
    token,
    body: { message, tree: tree.json.sha, parents: base ? [base.sha] : [] },
  });

  // 4. ref — create missing branch, else fast-forward update (force only when asked)
  if (!base || !base.exists) {
    try {
      await githubRequest("POST", `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/git/refs`, {
        token, body: { ref: `refs/heads/${branch}`, sha: commit.json.sha },
      });
    } catch (e) {
      if (e.status !== 422) throw e; // branch appeared concurrently → fall through to PATCH
      await githubRequest("PATCH", `/${refPath(branch)}`, { token, body: { sha: commit.json.sha, force: false } });
    }
  } else {
    await githubRequest("PATCH", `/${refPath(branch)}`, {
      token, body: { sha: commit.json.sha, force: !!force },
    });
  }

  return {
    owner, repo, branch,
    commitSha: commit.json.sha,
    treeSha: tree.json.sha,
    blobCount: new Set(blobs.map((b) => b.sha)).size,
    fileCount: norm.length,
    parentSha: base?.sha ?? null,
    html_url: `https://github.com/${owner}/${repo}/commit/${commit.json.sha}`,
  };
}

// ── top-level product entry points ───────────────────────────────────────────
// owner defaults to the authenticated user; pass owner to publish under an org.
export async function publishToGitHub({
  name, description = "", visibility = "private", branch = "main",
  commitMessage = "publish via cloner platform", files, dir, owner,
} = {}) {
  requireToken(); // env-absent is the FIRST failure surfaced — before any fs/network work
  let normalized;
  let excluded = [];
  if (files) normalized = files.map(normalizeUploadFile);
  else if (dir) {
    const collected = collectFilesFromDir(dir);
    normalized = collected.files;
    excluded = collected.excluded;
    if (excluded.length) console.warn(`[github-publish] excluded credential/non-shippable entries: ${excluded.join(", ")}`);
  } else throw new GitHubPublishError("publishToGitHub needs `files` or `dir`");

  if (!name) throw new GitHubPublishError("publishToGitHub needs a repository `name`");
  const who = owner || (await getAuthenticatedUser()).login;
  const repo = await createRepo({ name, description, private: visibility !== "public" });
  const push = await pushTree({ owner: who, repo: name, branch, files: normalized, message: commitMessage });
  await setRepoVisibility({ owner: who, repo: name, visibility });
  return {
    owner: who, repo: name, visibility, branch,
    commitSha: push.commitSha, parentSha: push.parentSha,
    html_url: `https://github.com/${who}/${name}`,
    default_branch: branch,
    excluded,
  };
}

// Publish a finished task's reconstructed site. v2 exploration jobs keep their
// runnable tree in artifacts/<id>-project (see exporter.exportV2Task); legacy
// v1 tasks live in platform-data out/<id>. The collected tree is filtered the
// same way exports are — private/, cookies, .env … never reach GitHub.
export async function publishTaskToGitHub({
  taskId, repoName, description = "Cloned site reconstructed by the cloner platform",
  visibility = "private", branch = "main", commitMessage,
} = {}) {
  requireToken(); // env-absent is the FIRST failure surfaced — before any fs/network work
  const v2Dir = path.join(process.cwd(), "artifacts", `${taskId}-project`);
  const v2Evidence = path.join(process.cwd(), "artifacts", taskId, "manifest.json");
  let dir;
  if (fs.existsSync(path.join(v2Dir, "index.html")) && fs.existsSync(v2Evidence)) dir = v2Dir;
  else {
    const { outDir } = await import("./tasks.js");
    if (fs.existsSync(outDir(taskId))) dir = outDir(taskId);
    else {
      const e = new GitHubPublishError(
        `task "${taskId}" has no publishable tree — looked for artifacts/${taskId}-project/index.html (v2) and the v1 output dir. Run the clone first.`,
      );
      e.taskNotFound = true; // router maps this to 404
      throw e;
    }
  }
  const name = repoName || `cloner-${String(taskId).toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^[-._]+|[-._]+$/g, "").slice(0, 90) || "project"}`;
  return publishToGitHub({ name, description, visibility, branch, commitMessage: commitMessage || `cloner publish: task ${taskId}`, dir });
}

// ── integrator router (server.js is integrator-owned — mount additively) ─────
//   app.use("/api/github", githubPublishRouter({ guard: localOrAuthed("publish:task") }));
export function githubPublishRouter({ guard } = {}) {
  const router = Router();
  router.get("/status", (_req, res) => {
    const token = (process.env.GITHUB_PUBLISH_TOKEN || "").trim();
    res.json({ configured: !!token, endpoint: apiBase(), deleteScopeNote: "delete_repo needed only for cleanup scripts" });
  });
  const authed = guard || ((_req, res) => {
    res.status(403).json({ error: "publish surface mounted without a guard — githubPublishRouter({ guard }) must be given the platform auth middleware" });
  });
  router.post("/publish/:taskId", authed, async (req, res) => {
    try {
      const out = await publishTaskToGitHub({
        taskId: req.params.taskId,
        repoName: req.body?.repoName,
        visibility: req.body?.visibility || "private",
        branch: req.body?.branch || "main",
        commitMessage: req.body?.commitMessage,
      });
      res.json({ ok: true, ...out, excluded: out.excluded });
    } catch (e) {
      const status = e instanceof GitHubPublishError
        ? (e.taskNotFound ? 404 : e.status ? 502 : 503) // 404 unknown task · 502 upstream GitHub answered · 503 local config refused
        : 500;
      res.status(status).json({ error: e.message, upstream: e.status ?? null, details: e.details ?? null });
    }
  });
  return router;
}
