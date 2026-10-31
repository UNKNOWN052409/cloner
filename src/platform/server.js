// Cloner platform server: task API, persistent sessions, WebSocket progress,
// preview + element picker, verification, export. The engine (src/*.js) does the
// reverse engineering; this is the product shell around it.
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import express from "express";
import { WebSocketServer } from "ws";
import { fileURLToPath } from "node:url";
import { bus } from "../events.js";
import { loadConfig } from "../config.js";
import { cloneUrl } from "../cloneUrl.js";
import { validatePublicUrl } from "../security/url-guard.js";
import { loadCookies } from "../browser.js";
import * as exploration from "./exploration-runner.js";
import * as wsAuth from "./ws-auth.js";
import * as tasks from "./tasks.js";
import * as sessions from "./sessions.js";
import { exportTask, exportV2Task } from "./exporter.js";
import { verifyTask } from "./verify.js";
import { authRequired } from "../auth/auth-middleware.js";
import * as auth from "../auth/auth-service.js";
import * as taskRepo from "../database/task-repository.js";
import { migrate } from "../database/client.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export function startPlatform({ port = 4180 } = {}) {
  const app = express();
  app.use(express.json({ limit: "20mb" }));

  // ---- database migrations (run once at boot) ----
  migrate().catch((e) => console.error('[db] migration failed:', e.message));

  // ---- auth routes (spec §6) ----
  app.post('/api/auth/register', async (req, res) => {
    try {
      const { email, password } = req.body || {};
      const user = await auth.registerUser(email, password);
      res.json({ ok: true, userId: user.id, email: user.email });
    } catch (e) { res.status(400).json({ error: e.message.slice(0, 120) }); }
  });
  app.post('/api/auth/login', async (req, res) => {
    try {
      const { email, password } = req.body || {};
      const session = await auth.loginUser(email, password);
      res.json({ ok: true, token: session.token, userId: session.userId, email: session.email, expiresAt: session.expiresAt });
    } catch (e) { res.status(401).json({ error: e.message.slice(0, 120) }); }
  });
  app.post('/api/auth/logout', authRequired, async (req, res) => {
    const token = (req.headers.authorization || '').replace('Bearer ', '');
    await auth.revokeSession(token);
    res.json({ ok: true });
  });
  app.get('/api/auth/me', authRequired, (req, res) => {
    res.json({ userId: req.userId, email: req.userEmail, role: req.userRole });
  });

  // ---- static UI ----
  app.get("/", (_req, res) => res.sendFile(path.join(__dirname, "..", "..", "platform-ui", "index.html")));
  app.use("/ui", express.static(path.join(__dirname, "..", "..", "platform-ui")));
  // picker script injected into previews (element selection)
  const PICKER_JS = fs.readFileSync(path.join(__dirname, "..", "picker.js"), "utf8");

  // ---- tasks ----
  app.post("/api/tasks", async (req, res) => {
    const { url, username, password, cookies, storage, instructions, mode, pipeline } = req.body || {};
    if (!url || !/^https?:\/\//i.test(url)) return res.status(400).json({ error: "url required (http(s))" });
    const guard = await validatePublicUrl(url);
    if (!guard.ok) return res.status(400).json({ error: "url rejected: " + guard.error });
    // pipeline "v2" → exploration + reconstruction + verification (integrated)
    // pipeline "v1" or absent → legacy cloneUrl flow (backward compatible)
    if (pipeline === "v2") {
      const entry = exploration.queueExploration({ url, username, password, cookies, storage, instructions });
      res.json({ id: entry.tempId, status: entry.status, pipeline: "v2" });
      return;
    }
    const meta = tasks.createTask({ url, mode, username, password, cookies, storage, instructions });
    res.json(meta);
    runTask(meta.id).catch((e) => {
      tasks.updateTask(meta.id, { status: "error", error: String(e.message || e).slice(0, 300) }, "failed");
      bus.emit("log", { level: "warn", msg: `task ${meta.id} failed: ${e.message}` });
    });
  });
  app.get("/api/tasks", async (_req, res) => {
    // merge legacy tasks + exploration-runner jobs
    const legacy = tasks.listTasks();
    const jobs = exploration.listJobs();
    res.json([...legacy, ...jobs]);
  });

  // ---- exploration jobs (Phase 1 intelligence engine, spec §15) ----
  app.post("/api/jobs/explore", async (req, res) => {
    const { url, username, password, cookies, storage, policy } = req.body || {};
    if (!url || !/^https?:\/\//i.test(url)) return res.status(400).json({ error: "url required (http(s))" });
    const guard = await validatePublicUrl(url);
    if (!guard.ok) return res.status(400).json({ error: "url rejected: " + guard.error });
    if (policy !== undefined && (typeof policy !== "object" || policy === null || Array.isArray(policy))) return res.status(400).json({ error: "policy must be an object" });
    const entry = exploration.queueExploration({ url, username, password, cookies, storage, policy });
    res.json({ jobId: entry.tempId, status: entry.status });
  });
  app.get("/api/jobs", (_req, res) => res.json(exploration.listJobs()));
  app.get("/api/jobs/:jobId", (req, res) => {
    const job = exploration.getExplorationJob(req.params.jobId);
    if (!job) return res.status(404).json({ error: "job not found" });
    res.json(job);
  });
  app.get("/api/jobs/:jobId/artifacts/*", (req, res) => {
    const root = path.join(process.cwd(), "artifacts");
    const file = path.resolve(root, req.params.jobId, req.params[0] || "manifest.json");
    const jobRoot = path.resolve(root, req.params.jobId);
    // traversal guard: the resolved file must stay inside BOTH artifacts/ and
    // artifacts/<jobId>/ (a startsWith(root) check alone is bypassable by
    // ../-encoded paths into sibling directories like artifacts-leak/)
    const relRoot = path.relative(root, file);
    const relJob = path.relative(jobRoot, file);
    if (relRoot.startsWith("..") || path.isAbsolute(relRoot) || relJob.startsWith("..") || path.isAbsolute(relJob) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) return res.status(404).json({ error: "not found" });
    res.sendFile(file);
  });
  app.get("/api/tasks/:id", (req, res) => {
    // check legacy task store first, then exploration-runner (pipeline v2)
    const meta = tasks.loadTask(req.params.id);
    if (meta) return res.json(meta);
    const job = exploration.getExplorationJob(req.params.id);
    if (job) {
      return res.json({
        id: job.jobId, url: job.url, status: job.status,
        pipeline: "v2", artifactsDir: job.artifactsDir,
        reconstruction: job.reconstruction || null,
        verification: job.verification || null,
        history: job.history || [],
      });
    }
    return res.status(404).json({ error: "not found" });
  });
  app.delete("/api/tasks/:id", (req, res) => {
    sessions.release(req.params.id);
    tasks.deleteTask(req.params.id);
    res.json({ ok: true });
  });

  // ---- clone preview (with element picker injected) ----
  app.get("/preview/:id", (req, res) => res.redirect(`/preview/${req.params.id}/index.html`));
  app.get("/preview/:id/*", (req, res) => {
    const dir = tasks.outDir(req.params.id);
    const file = path.resolve(dir, req.params[0] || "index.html");
    if (!file.startsWith(path.resolve(dir))) return res.status(403).send("forbidden");
    if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) return res.status(404).send("not found yet");
    if (file.endsWith(".html")) {
      let html = fs.readFileSync(file, "utf8");
      html = html.replace(/<\/body>/i, `<script>${PICKER_JS}</script>`);
      res.type("html").send(html);
    } else res.sendFile(file);
  });

  // ---- chat / edit selected element (reuses engine edit flow) ----
  app.post("/api/tasks/:id/chat", async (req, res) => {
    const { selector, info = {}, instruction } = req.body || {};
    const file = req.body?.file || "index.html";
    if (!instruction) return res.status(400).json({ error: "instruction required" });
    const cfg = loadConfig();
    if (cfg.model.provider === "none" || !cfg.model.apiKey) return res.status(400).json({ error: "no vision model configured (Settings → API providers, phase 6)" });
    const target = path.join(tasks.outDir(req.params.id), file);
    if (!fs.existsSync(target)) return res.status(404).json({ error: "clone not ready" });
    try {
      const { routeChat } = await import("./model-router.js");
      const { EDIT_SYSTEM, EDIT_ELEMENT } = await import("../prompts.js");
      const html = fs.readFileSync(target, "utf8");
      const { out, provider } = await routeChat(
        cfg,
        [{ role: "system", content: EDIT_SYSTEM }, { role: "user", content: EDIT_ELEMENT({ file, fileContent: html, selector, info, instruction }) }],
        { maxTokens: 4000, timeoutMs: 280000 },
        "edit-element",
      );
      console.log(`[chat] edit via provider: ${provider}`);
      const patch = firstJson(out);
      if (!patch) throw new Error("model returned no JSON patch");
      let updated = html;
      if (patch.replaceHtml?.find && patch.replaceHtml?.html) updated = updated.replace(patch.replaceHtml.find, patch.replaceHtml.html);
      if (patch.removeSelector) updated = updated.replace(new RegExp(`<\\w+[^>]*${patch.removeSelector.replace(/[.#]/g, "\\$&")}[^>]*>[\\s\\S]*?</\\w+>`, "i"), "");
      if (patch.css) {
        fs.appendFileSync(path.join(tasks.outDir(req.params.id), "chat-fixes.css"), `\n/* ${new Date().toISOString()} — ${instruction.replace(/\*\//g, "")} */\n${patch.css}\n`);
        if (!updated.includes("chat-fixes.css")) updated = updated.replace(/<\/head>/i, `<link rel="stylesheet" href="chat-fixes.css"></head>`);
      }
      if (updated === html) throw new Error("empty patch");
      fs.writeFileSync(target, updated);
      broadcast({ type: "preview:reload", data: { task: req.params.id } });
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ error: e.message.slice(0, 200) });
    }
  });

  // ---- export ----
  app.post("/api/export/:id", async (req, res) => {
    try {
      // a v2 task created via POST /api/tasks is held under its temp handle —
      // resolve it to the real jobId before touching the artifacts tree
      const job = exploration.getExplorationJob(req.params.id);
      const id = job?.jobId || req.params.id;
      const isV2 = fs.existsSync(path.join(process.cwd(), 'artifacts', id, 'manifest.json'));
      const { zipPath, size } = isV2 ? await (async () => { const { exportV2Task } = await import('./exporter.js'); return exportV2Task(id); })() : await exportTask(req.params.id);
      sessions.release(req.params.id); // explicit finish → close the session
      res.json({ ok: true, download: `/api/export/${req.params.id}/download`, size });
    } catch (e) {
      res.status(500).json({ error: e.message.slice(0, 200) });
    }
  });
  app.get("/api/export/:id/download", (req, res) => {
    const zipPath = path.join(tasks.taskDir(req.params.id), "export.zip");
    if (!fs.existsSync(zipPath)) return res.status(404).json({ error: "export first" });
    res.download(zipPath, `clone-${req.params.id}.zip`);
  });

  // ---- sessions (inspection panel uses the persistent session) ----
  app.get("/api/sessions", (_req, res) => res.json(sessions.stats()));
  // provider router stats (multi-model usage, quota tracking — spec §12)
  app.get("/api/providers", async (_req, res) => {
    const { getProviders, usageStats } = await import("./model-router.js");
    const cfg = loadConfig();
    res.json({ providers: getProviders(cfg).map((p) => ({ name: p.name, provider: p.provider, model: p.model, capabilities: p.capabilities, hasKey: !!p.apiKey })), usage: usageStats() });
  });

  const server = http.createServer(app);

  // ---- WebSocket: authenticated upgrade + task-scoped rooms (spec §6/§9) ----
  // The upgrade validates an optional token (cookie `cloner_session` or
  // ?token=) against the sessions table. Unauthenticated upgrades are refused
  // with 401 UNLESS they come from loopback — the local dashboard
  // (platform-ui) connects with no token and keeps working through the
  // "legacy" room. Authenticated sockets join their `user:<id>` room instead.
  const wss = new WebSocketServer({
    server,
    path: "/ws",
    verifyClient: (info, cb) => {
      wsAuth.authenticateUpgrade(info.req).then((identity) => {
        if (!identity && !wsAuth.isLoopback(info.req.socket?.remoteAddress)) {
          cb(false, 401, "Unauthorized"); // remote + no valid token → refuse the handshake
          return;
        }
        info.req.wsIdentity = identity; // null for the legacy loopback dashboard
        cb(true);
      });
    },
  });
  const sockets = new Set();
  wss.on("connection", (ws, req) => {
    const identity = req?.wsIdentity || null; // { userId, role, email } | null
    ws.identity = identity;
    ws.rooms = new Set();
    if (identity) ws.rooms.add(`user:${identity.userId}`);
    else ws.rooms.add("legacy"); // unauthenticated LOCAL only — remote ones never get here
    sockets.add(ws);
    // catchup replay: unchanged (full ring buffer) for the legacy dashboard;
    // scoped to tasks the identity may access for authenticated sockets
    wsAuth.scopedCatchup(bus.catchUp(), identity)
      .then((data) => { try { ws.send(JSON.stringify({ type: "catchup", data })); } catch {} })
      .catch(() => {});
    ws.on("close", () => sockets.delete(ws));
    ws.on("message", (raw) => {
      try {
        const msg = JSON.parse(raw.toString());
        if (msg.type === "join" && msg.task) {
          if (!identity) { ws.taskId = msg.task; return; } // legacy dashboard: unchanged
          // authenticated: subscribe only to tasks this identity may access
          // (defense in depth — the emit-side gate below is authoritative)
          wsAuth.canAccessTask(msg.task, identity)
            .then((ok) => { if (ok) ws.taskId = msg.task; })
            .catch(() => {});
        }
      } catch {}
    });
  });

  // Scoped broadcast. Task identity: v1 events carry msg.task; v2 (exploration)
  // events are tagged inside the wrapped bus payload (data.job) or data.task.
  // A task event fans out ONLY to sockets authorized for it — the owner's
  // `user:<id>` room (all authenticated rooms for v2 exploration jobs, which
  // are per-process and single-tenant) plus the legacy loopback room.
  // Unknown-owner tasks → legacy room only (fail closed for authenticated
  // fan-out; the local dashboard is unaffected). Events without a task id
  // broadcast to everyone, as before.
  async function broadcast(msg) {
    let gate = null;
    try {
      const taskId = msg?.task || msg?.data?.job || msg?.data?.task || msg?.data?.taskId || null;
      if (taskId) {
        if (wsAuth.isExplorationTask(taskId)) {
          gate = (ws) => ws.rooms.has("legacy") || !!ws.identity;
        } else {
          const users = [...new Set([...sockets].filter((s) => s.identity).map((s) => s.identity.userId))];
          const allowed = await wsAuth.authorizedUserIds(taskId, users);
          gate = (ws) => ws.rooms.has("legacy") || (ws.identity && allowed.has(ws.identity.userId));
        }
      }
    } catch {
      gate = (ws) => ws.rooms.has("legacy"); // unexpected failure → legacy room only
    }
    for (const ws of sockets) {
      try {
        if (gate && !gate(ws)) continue;
        if (!ws.taskId || !msg.task || ws.taskId === msg.task) ws.send(JSON.stringify(msg));
      } catch {}
    }
  }
  // engine progress → WS (tagged with the running task) + server-side console
  // (stdout is the only place errors survive when no WS client is attached)
  const T0 = Date.now();
  const at = () => `+${((Date.now() - T0) / 1000).toFixed(1)}s`;
  for (const evt of ["step", "log", "tabs:found", "assets:progress", "assets:done", "page:goto", "run:done", "run:error", "polish:round"]) {
    bus.on(evt, (e) => {
      broadcast({ type: evt, task: currentTaskId || null, data: e });
      // events.js wraps payloads as {type, data, t} — read from e.data
      const d = e?.data || {};
      if (evt === "step") console.log(`[${at()}][${currentTaskId || "-"}] ${d.status || ""} ${d.msg || d.id || ""}`);
      else if (evt === "log") console.log(`[${at()}][${currentTaskId || "-"}] ${d.level === "warn" ? "WARN" : "·"} ${d.msg || ""}`);
      else if (evt === "run:error") console.error(`[${at()}][${currentTaskId || "-"}] RUN ERROR ${d.error || ""}`);
    });
  }
  let currentTaskId = null;

  // ---- task runner: engine pipeline + verification, wired to the task ----
  async function runTask(id) {
    const meta = tasks.loadTask(id);
    if (!meta) return;
    currentTaskId = id;
    tasks.updateTask(id, { status: "running" }, "clone started");
    const priv = path.join(tasks.taskDir(id), "private");
    const cookiesFile = fs.existsSync(path.join(priv, "cookies.json")) ? path.join(priv, "cookies.json") : null;
    const storageFile = fs.existsSync(path.join(priv, "storage.json")) ? JSON.parse(fs.readFileSync(path.join(priv, "storage.json"), "utf8")) : undefined;
    const out = tasks.outDir(id);
    const cookies = meta.hasCookies ? loadCookies(cookiesFile) : null;
    const cfg = loadConfig();
    // vision polish ON by default (model router handles providers); a task can opt out
    if (meta.noPolish) cfg.polish = { enabled: false };
    await cloneUrl(meta.url, cfg, out, { cookies, storage: storageFile, interactions: { waitMs: 800, max: 56, triggerMax: 140, budgetMs: 170000 } });
    tasks.updateTask(id, { status: "verifying" }, "clone complete — verifying");
    const artifacts = {};
    for (const f of ["index.html", "snapshot.mhtml", "exploration.md", "exploration.json", "design-tokens.json", "cloner-runtime.js", "clone.json"]) {
      const fp = path.join(out, f);
      if (fs.existsSync(fp)) artifacts[f.replace(".md", "").replace(".json", "").replace(".html", "").replace(".mhtml", "").replace(".js", "")] = f;
    }
    if (fs.existsSync(path.join(out, "scaffold"))) artifacts.scaffold = "scaffold/";
    const verification = await verifyTask(out);
    tasks.updateTask(id, { status: verification.passed ? "done" : "done", artifacts, verification }, `verification ${verification.passed ? "passed" : "completed with failures"}`);
    broadcast({ type: "task:done", task: id, data: { verification: verification.passed } });
  }

  // retention sweep (15-day default) on boot + hourly
  const removed = tasks.sweepExpired();
  if (removed.length) console.log(`[retention] removed ${removed.length} expired task(s)`);
  setInterval(() => tasks.sweepExpired(), 3600_000).unref();

  return new Promise((resolve) => {
    // broadcast is exposed additively so tests can drive the production emit path
    server.listen(port, () => resolve({ server, wss, port, broadcast }));
  });
}

function firstJson(text) {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const c = fenced ? fenced[1] : text;
  const s = c.indexOf("{");
  for (let e = c.lastIndexOf("}"); e > s; e = c.lastIndexOf("}", e - 1)) {
    try { return JSON.parse(c.slice(s, e + 1)); } catch {}
  }
  return null;
}
