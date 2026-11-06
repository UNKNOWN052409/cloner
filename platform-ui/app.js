// platform-ui app entry: route table + shared services.
//
// Shared services every page imports from here:
//   api(path, opts)      — same-origin JSON fetch, session-cookie auth
//                          (POST /api/auth/login sets the HttpOnly
//                          cloner_session cookie the platform resolves, per
//                          server.js localOrAuthed); Bearer never needed here.
//   wsSubscribe(fn)      — /ws event hookup. Every message the server
//                          broadcasts reaches subscribers as {type, task, data}.
//   wsJoin(taskId)       — send {type:"join",task} to scope the feed (or null
//                          to receive everything visible to this identity).
//   payloadOf(msg)       — unwrap the bus record: engine events arrive wrapped
//                          as {type, task, data:{type,data,t,job}} (events.js
//                          shape bridged by server.js broadcast), while
//                          job:status / task:done carry their payload directly.
//   esc / fmtTime / statusMeta — render helpers.

import { registerRoutes, start } from "./router.js";

registerRoutes([
  { page: 1, pattern: "/", title: "Projects", fragment: "dashboard.html", module: "dashboard.js" },
  { page: 2, pattern: "/new", title: "New Clone", fragment: "new-clone.html", module: "new-clone.js" },
  { page: 3, pattern: "/projects/:id/exploration", title: "Live Exploration", fragment: "exploration.html", module: "exploration.js" },
  { page: 4, pattern: "/projects/:id/intelligence", title: "Website Intelligence", fragment: "intelligence.html", module: "intelligence.js" },
  // pages 5-8 are standalone documents (data-ext anchors) — no hash routes.
]);

// ---------------- fetch wrapper ----------------
export class ApiError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

// Session token sidecar: HTTP auth is HEADER-ONLY by design (hunt G5.3 — no
// ?token= URLs, no Referer leaks), and the HttpOnly login cookie is resolved
// only on the localOrAuthed/WS surfaces — not by authRequired. The login
// response therefore carries the Bearer token for API calls, and api() attaches
// it from here. Kept in sessionStorage (per-tab, cleared on close — same
// sidecar pattern as the engine's authenticated sessions); never localStorage
// and never persisted beyond the session.
const TOKEN_KEY = "cloner_session_token";
let sessionToken = "";
try { sessionToken = sessionStorage.getItem(TOKEN_KEY) || ""; } catch { /* storage unavailable */ }
export function setSessionToken(token) {
  sessionToken = String(token || "");
  try {
    if (sessionToken) sessionStorage.setItem(TOKEN_KEY, sessionToken);
    else sessionStorage.removeItem(TOKEN_KEY);
  } catch { /* storage unavailable */ }
}

export async function api(path, { method = "GET", body } = {}) {
  const headers = body !== undefined ? { "content-type": "application/json" } : {};
  if (sessionToken) headers.authorization = "Bearer " + sessionToken;
  let res;
  try {
    res = await fetch(path, {
      method,
      credentials: "same-origin",
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new ApiError(0, "network error — platform API unreachable");
  }
  let data = null;
  try { data = await res.json(); } catch { /* non-JSON body (404 HTML etc.) */ }
  if (!res.ok) throw new ApiError(res.status, (data && data.error) || "HTTP " + res.status);
  return data;
}

// ---------------- /ws hookup ----------------
let sock = null;
let wantTask = null;
let backoff = 800;
let retryTimer = null;
const subs = new Set();

function sbSet(text, color) {
  const sb = document.getElementById("sb-ws");
  if (!sb) return;
  sb.innerHTML = '<i class="dot" style="background:' + color + '"></i>events: ' + text;
}

function scheduleReconnect() {
  if (retryTimer || !subs.size) return;
  retryTimer = setTimeout(() => { retryTimer = null; connect(); }, backoff);
  backoff = Math.min(backoff * 2, 15000);
}

function sendJoin() {
  if (sock && sock.readyState === 1 && wantTask) {
    try { sock.send(JSON.stringify({ type: "join", task: wantTask })); } catch { /* socket closing */ }
  }
}

function connect() {
  if (sock && sock.readyState <= 1) return;
  sbSet("connecting", "var(--status-pending)");
  let s;
  try {
    s = new WebSocket((location.protocol === "https:" ? "wss://" : "ws://") + location.host + "/ws");
  } catch {
    return scheduleReconnect();
  }
  sock = s;
  s.onopen = () => { backoff = 800; sbSet("live", "var(--status-ok)"); sendJoin(); };
  s.onmessage = (ev) => {
    let msg;
    try { msg = JSON.parse(ev.data); } catch { return; }
    if (msg && msg.type === "catchup") {
      const events = (msg.data && msg.data.events) || [];
      for (const fn of subs) { try { fn({ type: "catchup", data: events }); } catch { /* listener error */ } }
      return;
    }
    for (const fn of subs) { try { fn(msg); } catch { /* listener error */ } }
  };
  s.onclose = () => { sock = null; sbSet("reconnecting", "var(--status-pending)"); scheduleReconnect(); };
  s.onerror = () => { /* onclose fires next and drives the retry */ };
}

export function wsSubscribe(fn) {
  subs.add(fn);
  connect();
  return () => subs.delete(fn);
}

export function wsJoin(taskId) {
  wantTask = taskId || null;
  connect();
  sendJoin();
}

// Engine events are wrapped; job:status / task:done are not.
export function payloadOf(msg) {
  const d = msg && msg.data;
  if (d && typeof d === "object" && "data" in d && "t" in d) return d.data;
  return d;
}

// ---------------- render helpers ----------------
export function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// UTC HH:MM:SS — stable for tests and log-style scanning.
export function fmtTime(iso) {
  const d = iso ? new Date(iso) : null;
  return d && !Number.isNaN(d.getTime()) ? d.toISOString().slice(11, 19) : "—";
}

export function statusMeta(status) {
  const s = String(status || "queued");
  if (["running", "exploring", "reconstructing", "verifying"].includes(s)) return { cls: "run", label: s };
  if (["done", "completed", "completed_with_limitations", "exported"].includes(s)) return { cls: "ok", label: s };
  if (["error", "failed", "cancelled"].includes(s)) return { cls: "err", label: s };
  return { cls: "warn", label: s }; // queued / pending / unknown — shown as-is
}

// ---------------- auth chip ----------------
async function bootAuth() {
  const chip = document.getElementById("auth-chip");
  if (!chip) return;
  try {
    const me = await api("/api/auth/me");
    chip.innerHTML =
      '<span class="who mono">' + esc(me.email || me.userId || "") + " · " + esc(me.role || "user") + "</span>" +
      '<button class="btn ghost" id="btn-signout" type="button">Sign out</button>';
    chip.querySelector("#btn-signout").addEventListener("click", async () => {
      try { await api("/api/auth/logout", { method: "POST" }); } catch { /* already invalid */ }
      setSessionToken(""); // header-only session dies with the token sidecar too
      bootAuth();
    });
  } catch (e) {
    if (e.status === 401) setSessionToken(""); // stale sidecar — clear and show the sign-in form
    const note = e.status === 401 ? "not signed in" : "session check failed — " + esc(String(e.message).slice(0, 80));
    chip.innerHTML =
      '<span class="who">' + note + "</span>" +
      '<details><summary>Sign in</summary><div class="auth-pop">' +
      '<form id="login-form" class="stack">' +
      '<div class="field"><label for="li-email">Email</label><input id="li-email" name="email" type="email" autocomplete="username" required></div>' +
      '<div class="field"><label for="li-pass">Password</label><input id="li-pass" name="password" type="password" autocomplete="current-password" required></div>' +
      '<button class="btn primary" type="submit">Sign in</button>' +
      '<div class="form-err" hidden></div>' +
      '<div class="hint">Loopback callers work without signing in — the platform keeps its local-operator posture.</div>' +
      "</form></div></details>";
    const form = chip.querySelector("#login-form");
    form.addEventListener("submit", async (ev) => {
      ev.preventDefault();
      const out = form.querySelector(".form-err");
      out.hidden = true;
      try {
        const res = await api("/api/auth/login", {
          method: "POST",
          body: { email: form.email.value, password: form.password.value },
        });
        setSessionToken(res.token || ""); // authRequired is header-only — carry the Bearer for API calls
        bootAuth();
      } catch (err) {
        out.textContent = String(err.message || "sign-in failed").slice(0, 140);
        out.hidden = false;
      }
    });
  }
}

// ---------------- boot ----------------
// NOT awaited at the top level: app.js is statically imported by every page
// module, so a top-level await here would deadlock the module graph
// (app.js TLA → router → import(pages/x.js) → import(app.js) — the cycle can
// never unwind). Fire-and-forget keeps evaluation synchronous.
const outlet = document.getElementById("view");
start(outlet)
  .catch((e) => {
    outlet.innerHTML =
      '<div class="state error"><div class="big">The shell failed to start</div><div>' +
      esc(String(e && e.message || e)) + "</div></div>";
  })
  .finally(() => bootAuth());
