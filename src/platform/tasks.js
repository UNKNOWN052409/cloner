// Task manager: create/list/read tasks, per-task artifact directory, history.
// SECURITY: raw credentials are NEVER persisted — task.json records only that
// they were provided. Cookie/storage session files live in the task dir during
// the task and are deleted at export (see exporter.js).
import fs from "node:fs";
import path from "node:path";

const ROOT = path.join(process.cwd(), "platform-data");

export function taskDir(id) {
  return path.join(ROOT, id);
}
export function outDir(id) {
  return path.join(ROOT, id, "out");
}

export function createTask({ url, mode = "url", username, password, cookies, storage, instructions = "", userId = "local" }) {
  const id = "t" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const dir = taskDir(id);
  fs.mkdirSync(path.join(dir, "out"), { recursive: true });
  fs.mkdirSync(path.join(dir, "private"), { recursive: true }); // session files — excluded from export
  if (cookies) fs.writeFileSync(path.join(dir, "private", "cookies.json"), typeof cookies === "string" ? cookies : JSON.stringify(cookies));
  if (storage) fs.writeFileSync(path.join(dir, "private", "storage.json"), typeof storage === "string" ? storage : JSON.stringify(storage));
  const meta = {
    id,
    userId: String(userId || "local").slice(0, 64), // per-user stub — stored for the auth phase, not used for isolation yet
    url,
    mode,
    status: "queued", // queued | running | verifying | done | error | exported
    createdAt: new Date().toISOString(),
    instructions: String(instructions || "").slice(0, 4000),
    credentials: username && password ? "provided" : null, // never store the values
    hasCookies: !!cookies,
    hasStorage: !!storage,
    artifacts: {},     // populated by the runner (files + sizes)
    verification: null, // three-step verification results
    history: [{ at: new Date().toISOString(), event: "created" }],
  };
  saveTask(meta);
  return meta;
}

export function loadTask(id) {
  try { return JSON.parse(fs.readFileSync(path.join(taskDir(id), "task.json"), "utf8")); } catch { return null; }
}
export function saveTask(meta) {
  fs.writeFileSync(path.join(taskDir(meta.id), "task.json"), JSON.stringify(meta, null, 2));
}
// shred a task's credential/session files immediately (spec §10) — private/ only;
// the clone tree (out/) is never touched. Returns true when something was removed.
export function purgeCredentials(id) {
  const s = path.join(taskDir(id), "private");
  if (!fs.existsSync(s)) return false;
  fs.rmSync(s, { recursive: true, force: true });
  return true;
}

export function updateTask(id, patch, event = null) {
  const meta = loadTask(id);
  if (!meta) return null;
  const prevStatus = meta.status;
  Object.assign(meta, patch);
  // PURGE_CREDS_ON_DONE=1 → session files die the moment a task finishes (done|error)
  if (
    patch.status && patch.status !== prevStatus && (patch.status === "done" || patch.status === "error") &&
    process.env.PURGE_CREDS_ON_DONE === "1"
  ) {
    if (purgeCredentials(id)) {
      meta.credentialsPurged = true;
      meta.history.push({ at: new Date().toISOString(), event: "credentials purged (PURGE_CREDS_ON_DONE)" });
    }
  }
  if (event) meta.history.push({ at: new Date().toISOString(), event });
  if (meta.history.length > 200) meta.history = meta.history.slice(-200);
  saveTask(meta);
  return meta;
}
export function listTasks() {
  try {
    return fs
      .readdirSync(ROOT)
      .filter((d) => fs.existsSync(path.join(ROOT, d, "task.json")))
      .map((d) => loadTask(d))
      .sort((a, b) => (b.createdAt || "").localeCompare(a.createdAt || ""));
  } catch { return []; }
}
export function deleteTask(id) {
  const s = path.join(taskDir(id), "private");
  if (fs.existsSync(s)) fs.rmSync(s, { recursive: true, force: true });
  fs.rmSync(taskDir(id), { recursive: true, force: true });
}

// retention sweep — temporary project files expire after N days (default 15).
// RETENTION_DAYS is honored but guarded: garbage/zero/negative values fall back to 15
// (Number("")===0 would otherwise purge everything).
export function sweepExpired(days) {
  const env = Number(process.env.RETENTION_DAYS);
  const d = Number.isFinite(days) && days > 0 ? days : Number.isFinite(env) && env > 0 ? env : 15;
  const cutoff = Date.now() - d * 86400_000;
  const removed = [];
  for (const t of listTasks()) {
    try {
      if (new Date(t.createdAt).getTime() < cutoff) { deleteTask(t.id); removed.push(t.id); }
    } catch {}
  }
  return removed;
}
