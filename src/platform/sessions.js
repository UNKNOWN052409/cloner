// Persistent browser session pool.
// One long-lived headless browser per task session — no start/stop churn per
// interaction. Sessions survive until: the user finishes/exports the task, or
// 30 minutes of inactivity elapse. Sessions are isolated per task id (and per
// user id when auth lands in a later phase).
import { launchBrowser, newContext } from "../browser.js";

const SESSIONS = new Map(); // sessionId -> { browser, ctx, page, lastUsed, meta }
const IDLE_MS = 30 * 60 * 1000; // 30-minute inactivity timeout (spec §7)

export async function acquire(sessionId, { viewport, cookies, storage } = {}) {
  let s = SESSIONS.get(sessionId);
  if (s) {
    try {
      if (s.browser.isConnected()) { s.lastUsed = Date.now(); return s; }
    } catch {}
    release(sessionId); // crashed — recover below
  }
  const browser = await launchBrowser({ headless: true });
  const ctx = await newContext(browser, { cookies, viewport: viewport || { width: 1440, height: 900 }, storage });
  const page = await ctx.newPage();
  s = { browser, ctx, page, lastUsed: Date.now(), meta: { createdAt: new Date().toISOString() } };
  SESSIONS.set(sessionId, s);
  return s;
}

export function get(sessionId) {
  const s = SESSIONS.get(sessionId);
  if (s) s.lastUsed = Date.now();
  return s || null;
}

export function release(sessionId) {
  const s = SESSIONS.get(sessionId);
  if (!s) return false;
  SESSIONS.delete(sessionId);
  try { s.browser.close().catch(() => {}); } catch {}
  return true;
}

export function stats() {
  return { active: SESSIONS.size, ids: [...SESSIONS.keys()] };
}

// inactivity sweep — releases browser resources when sessions expire
setInterval(() => {
  const now = Date.now();
  for (const [id, s] of SESSIONS) {
    if (now - s.lastUsed > IDLE_MS) {
      release(id);
      try { console.log(`[sessions] released idle session ${id}`); } catch {}
    }
  }
}, 60_000).unref();

process.on("exit", () => { for (const id of [...SESSIONS.keys()]) release(id); });
