// WebSocket upgrade authentication + task-scope authorization (spec §6/§9).
//
// Upgrade path: an OPTIONAL token — `?token=` query param or cookie
// `cloner_session` — is validated against the PostgreSQL sessions table via
// auth-service.validateSession. A DB failure resolves to "unauthenticated"
// (the upgrade never crashes). Unauthenticated upgrades are allowed only from
// loopback — local dashboard API clients connect with no token and
// keep working through the server's "legacy" room; remote ones are refused
// with 401 during the handshake.
//
// Task scoping: DB task ids resolve ownership through
// task-repository.getTask(taskId, userId) — a non-null row means the user owns
// the task. v2 exploration jobs (exploration-runner registry) carry an owner
// ({ userId, orgId }) set by the API layer at enqueue time (4.0.12 quality
// gate): org-owned jobs are visible to current org members only, user-owned
// to their owner, and ownerless legacy entries keep the authenticated-users
// posture.
import * as exploration from "./exploration-runner.js";
import * as taskRepo from "../database/task-repository.js";
import { validateSession } from "../auth/auth-service.js";

// DB task ids are UUIDs (migrations/001-initial.sql); legacy task ids ("t…")
// and v2 job ids ("exp-…") live outside that namespace — querying them would
// make PostgreSQL throw on the uuid cast, so they are short-circuited here.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ACCESS_TTL_MS = 30_000;  // how long a (task, user) ownership verdict is trusted
const ACCESS_CACHE_MAX = 500;  // task entries kept before the oldest is dropped

const accessCache = new Map(); // taskId -> { at, users: Map<userId, boolean> }

// ---- upgrade authentication ------------------------------------------------

export function extractToken(req) {
  // 1. explicit ?token= query param  2. cookie `cloner_session`
  try {
    const qp = new URL(req.url || "/", "http://ws-auth.local").searchParams.get("token");
    if (qp) return qp;
  } catch { /* malformed url → fall through to the cookie */ }
  const header = req?.headers?.cookie;
  if (typeof header === "string") {
    for (const part of header.split(";")) {
      const eq = part.indexOf("=");
      if (eq < 0) continue;
      if (part.slice(0, eq).trim() !== "cloner_session") continue;
      const value = part.slice(eq + 1).trim();
      try { return decodeURIComponent(value); } catch { return value; }
    }
  }
  return null;
}

// Resolves { userId, role, email } for a valid session token, else null.
// NEVER throws: a PostgreSQL outage is treated as "unauthenticated".
export async function authenticateUpgrade(req) {
  const token = extractToken(req);
  if (!token) return null;
  try {
    const session = await validateSession(token);
    if (!session) return null;
    return { userId: session.userId, email: session.email, role: session.role };
  } catch {
    return null; // DB unavailable → unauthenticated, never crash the upgrade
  }
}

// ---- cookie-only authentication for HTTP surfaces ---------------------------
//
// G5.5 human-journey hunt: browser NAVIGATIONS (preview loads, iframe clones,
// image/favicon requests) cannot set an Authorization header — the same
// physical limitation that justifies the ?token=/cookie path on WS upgrades
// above. Surfaces that a human opens by URL (e.g. /preview/<id>/index.html)
// authenticate through the `cloner_session` cookie that POST /api/auth/login
// sets. Cookie-only on purpose: HTTP routes keep the G5.3 posture of NEVER
// accepting ?token= (query tokens leak into logs), so this must not reuse
// extractToken(), which still reads the query param for the WS path.
export function extractCookieToken(req) {
  const header = req?.headers?.cookie;
  if (typeof header !== "string") return null;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() !== "cloner_session") continue;
    const value = part.slice(eq + 1).trim();
    try { return decodeURIComponent(value); } catch { return value; }
  }
  return null;
}

// Resolves { userId, email, role } from the request's cloner_session cookie,
// else null. NEVER throws: a PostgreSQL outage is treated as
// "unauthenticated" (callers keep whatever legacy posture they had).
export async function authenticateCookie(req) {
  const token = extractCookieToken(req);
  if (!token) return null;
  try {
    const session = await validateSession(token);
    if (!session) return null;
    return { userId: session.userId, email: session.email, role: session.role };
  } catch {
    return null; // DB unavailable → unauthenticated, never crash the route
  }
}

// True for 127.0.0.0/8, ::1 and IPv4-mapped IPv6 loopback forms.
export function isLoopback(address) {
  if (!address) return false;
  let a = String(address).toLowerCase();
  if (a.startsWith("::ffff:")) a = a.slice(7);
  return a === "::1" || a.startsWith("127.");
}

// ---- task-scope authorization ----------------------------------------------

// True when the exploration-runner registry knows this id (jobId or tempId
// alias). The registry is per-process and single-tenant → its tasks are public
// to authenticated users.
export function isExplorationTask(taskId) {
  if (!taskId || typeof taskId !== "string") return false;
  try { return !!exploration.getExplorationJob(taskId); } catch { return false; }
}

// Memoized ownership verdict for one (task, user) pair via the task repository.
async function userCanAccess(taskId, userId) {
  if (!taskId || !userId) return false;
  const now = Date.now();
  let entry = accessCache.get(taskId);
  if (!entry || now - entry.at > ACCESS_TTL_MS) {
    entry = { at: now, users: new Map() };
    if (accessCache.size >= ACCESS_CACHE_MAX) { // bound: drop the oldest task entry
      const oldest = accessCache.keys().next().value;
      if (oldest !== undefined) accessCache.delete(oldest);
    }
    accessCache.set(taskId, entry);
  }
  if (entry.users.has(userId)) return entry.users.get(userId);
  let ok = false;
  let cacheable = true;
  try {
    if (isExplorationTask(taskId)) {
      // 4.0.12 quality gate: registry jobs carry an owner ({ userId, orgId })
      // — org-owned jobs are visible only to CURRENT org members (re-checked
      // live), user-owned only to that user, platform-admin sees everything.
      // Ownerless legacy entries keep the authenticated-users posture.
      ok = await exploration.identityCanAccessJob(taskId, { userId, role: undefined });
      cacheable = !ok; // only positive verdicts are cached — a membership
                       // revocation must take effect immediately
    } else if (UUID_RE.test(taskId)) ok = !!(await taskRepo.getTask(taskId, userId));
    else {
      // G5.1 hunt fix (BUG #10): v1 file-store tasks (id "t<base36>", NOT a
      // UUID) fell through every branch → canAccessTask returned false for
      // EVERY v1 task → a signed-in owner's WS "join" was silently ignored
      // and the owner received ZERO live events for their own task
      // (reproduced: g55 "WebSocket: B receives live events for HIS OWN
      // task — 0 event(s)"). Resolve through the file store and check the
      // owner exactly like the HTTP surface does.
      const { loadTask } = await import("./tasks.js");
      const meta = loadTask(taskId);
      ok = !!meta && (meta.userId === userId || (meta.userId === "local" && false)); // "local" tasks stay loopback-dashboard territory
      cacheable = !ok;
    }
  } catch {
    ok = false;        // DB unavailable → fail closed for this user …
    cacheable = false; // …and re-check once the DB is back
  }
  if (cacheable) entry.users.set(userId, ok);
  return ok;
}

// Per-identity access check (used for client "join" subscriptions).
export async function canAccessTask(taskId, identity) {
  if (!identity?.userId) return false;
  return userCanAccess(taskId, identity.userId);
}

// Set of userIds (from the given candidates) authorized for a task. Registry
// tasks resolve through identityCanAccessJob (owner-aware, 4.0.12); DB tasks
// are checked against the task repository.
export async function authorizedUserIds(taskId, userIds) {
  const out = new Set();
  if (!taskId || !Array.isArray(userIds) || !userIds.length) return out;
  if (isExplorationTask(taskId)) {
    const verdicts = await Promise.all(userIds.map((u) => userCanAccess(taskId, u)));
    userIds.forEach((u, i) => { if (verdicts[i]) out.add(u); });
    return out;
  }
  const verdicts = await Promise.all(userIds.map((u) => userCanAccess(taskId, u)));
  userIds.forEach((u, i) => { if (verdicts[i]) out.add(u); });
  return out;
}

// Catchup replay scoping: unchanged (full ring buffer) for the legacy
// dashboard; for authenticated sockets buffered events tagged with a job id
// are kept only when that identity may access the job. Untagged (global)
// events always pass.
export async function scopedCatchup(catchup, identity) {
  if (!catchup || !identity) return catchup;
  const events = Array.isArray(catchup.events) ? catchup.events : [];
  const keep = [];
  for (const evt of events) {
    if (!evt?.job || (await canAccessTask(evt.job, identity))) keep.push(evt);
  }
  return { ...catchup, events: keep };
}
