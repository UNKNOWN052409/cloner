// Offline auth fixture for the authenticated-session module
// (src/exploration/authenticated-session.js) and its test
// (scripts/test-auth-session.mjs).
//
// Routes (mode "plain", the default):
//   GET  /              public page
//   GET  /login         login form; POST /login sets a session cookie on success
//   GET  /dashboard     authed page 1 (302 -> /login without a session)
//   GET  /settings      authed page 2 (302 -> /login without a session)
//   GET  /logout        clears the session, back to /
//   POST /api/purchase  DECOY: the login page also renders a destructive-looking
//                       form posting here. The engine under test must never
//                       reach this route — the test asserts it never does.
// Mode "mfa": correct credentials land on a second step (OTP input + "Enter the
// verification code" text) instead of establishing a session — the needsHuman
// path. Wrong credentials behave exactly like the plain mode (re-rendered login
// form + "Invalid username or password", deliberately free of any mfa/otp/
// captcha wording so failed-login and MFA are distinguishable signals).
//
// Binds 127.0.0.1 on an OS-picked ephemeral port. No external network, no
// filesystem access, zero npm dependencies (node:http + node:crypto only).
//   fx.requests — [{ method, path, at }] log of every request received, used by
//                 the test to assert the destructive-action guard.
import http from "node:http";
import crypto from "node:crypto";

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function sidFrom(req) {
  const raw = req.headers.cookie || "";
  for (const part of raw.split(";")) {
    const idx = part.indexOf("=");
    if (idx === -1) continue;
    if (part.slice(0, idx).trim() === "sid") return part.slice(idx + 1).trim();
  }
  return null;
}

export function createAuthFixture({ username = "alice", password = "s3cret!42", mode = "plain" } = {}) {
  if (mode !== "plain" && mode !== "mfa") throw new Error(`auth fixture: unknown mode "${mode}"`);

  const sessions = new Map(); // sid -> username
  const requests = [];        // every request the server received

  const shell = (title, body) =>
    `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><title>${title}</title></head>` +
    `<body><header><h1>Arcadia Portal</h1></header><main>${body}</main></body></html>`;

  const loginPage = (error = "") =>
    shell(
      "Sign in · Arcadia Portal",
      `<h2>Sign in</h2>` +
      (error ? `<p class="error" role="alert">${error}</p>` : "") +
      // decoy destructive form: a real POST target that must never be hit
      `<form method="POST" action="/api/purchase" class="decoy-purchase">` +
      `<button type="submit">Buy subscription</button></form>` +
      `<form method="POST" action="/login" id="login-form">` +
      `<label for="username">Username</label>` +
      `<input type="text" id="username" name="username" autocomplete="username">` +
      `<label for="password">Password</label>` +
      `<input type="password" id="password" name="password" autocomplete="current-password">` +
      `<button type="submit">Sign in</button>` +
      `</form>`
    );

  const mfaPage = () =>
    shell(
      "Two-step verification · Arcadia Portal",
      `<h2>Two-step verification</h2>` +
      `<p>Enter the verification code from your authenticator app.</p>` +
      `<form method="POST" action="/login/mfa" id="mfa-form">` +
      `<label for="otp">Code</label>` +
      `<input type="text" id="otp" name="otp" inputmode="numeric" autocomplete="one-time-code">` +
      `<button type="submit">Verify code</button>` +
      `</form>`
    );

  const authedPage = (title, who, extra) =>
    shell(
      `${title} · Arcadia Portal`,
      `<header class="topbar"><div class="avatar" data-user="${who}">${who[0].toUpperCase()}</div>` +
      `<span class="who">${who}</span>` +
      `<a href="/logout" id="signout">Sign out</a></header>` +
      `<h1>${title}</h1><p>Welcome back, ${who}.</p>` +
      `<nav><a href="/settings">Account settings</a> <a href="/">Public home</a></nav>` +
      extra
    );

  const publicPage = (who) =>
    shell(
      "Arcadia Portal",
      `<p id="whoami">You are browsing as: ${who}</p>` +
      `<nav><a href="/login">Sign in</a> <a href="/dashboard">Dashboard</a> <a href="/settings">Settings</a></nav>`
    );

  async function handle(req, res) {
    const u = new URL(req.url, "http://127.0.0.1");
    const p = u.pathname;
    requests.push({ method: req.method, path: p, at: Date.now() });

    if (req.method === "GET" && p === "/") {
      const who = sessions.get(sidFrom(req) || "") || "guest";
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(publicPage(who));
      return;
    }

    if (req.method === "GET" && p === "/login") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(loginPage());
      return;
    }

    if (req.method === "POST" && p === "/login") {
      const form = new URLSearchParams(await readBody(req));
      if (form.get("username") === username && form.get("password") === password) {
        if (mode === "mfa") {
          // correct creds but a second step stands between here and a session
          res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
          res.end(mfaPage());
          return;
        }
        const sid = crypto.randomBytes(16).toString("hex");
        sessions.set(sid, form.get("username"));
        res.writeHead(302, {
          "set-cookie": `sid=${sid}; Path=/; HttpOnly; SameSite=Lax`,
          location: "/dashboard",
        });
        res.end();
        return;
      }
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(loginPage("Invalid username or password."));
      return;
    }

    if (req.method === "POST" && p === "/login/mfa") {
      // the engine under test must never submit the MFA step
      res.writeHead(400, { "content-type": "text/plain; charset=utf-8" });
      res.end("fixture: mfa step is not automatable");
      return;
    }

    if (req.method === "POST" && p === "/api/purchase") {
      // reached only if something wrongly clicked the decoy
      res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
      res.end("fixture: purchase recorded (this must never happen)");
      return;
    }

    const authed = sessions.get(sidFrom(req) || "");
    if ((p === "/dashboard" || p === "/settings") && !authed) {
      res.writeHead(302, { location: "/login" });
      res.end();
      return;
    }
    if (req.method === "GET" && p === "/dashboard") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(authedPage("Dashboard", authed, `<p class="metric" data-name="visits">Visits today: 128</p>`));
      return;
    }
    if (req.method === "GET" && p === "/settings") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(authedPage("Account settings", authed, `<p>Display name: ${authed}</p>`));
      return;
    }
    if (req.method === "GET" && p === "/logout") {
      const sid = sidFrom(req);
      if (sid) sessions.delete(sid);
      res.writeHead(302, { "set-cookie": "sid=; Path=/; HttpOnly; Max-Age=0", location: "/" });
      res.end();
      return;
    }

    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    res.end("fixture: not found");
  }

  const server = http.createServer((req, res) => {
    Promise.resolve(handle(req, res)).catch(() => {
      try {
        res.writeHead(500, { "content-type": "text/plain" });
        res.end("fixture handler error");
      } catch {}
    });
  });

  let base = null;
  return {
    requests,
    sessions,
    get base() { return base; },
    get port() { return server.address() ? server.address().port : null; },
    start() {
      return new Promise((resolve) => {
        server.listen(0, "127.0.0.1", () => {
          base = "http://127.0.0.1:" + server.address().port;
          resolve(base);
        });
      });
    },
    close() { return new Promise((resolve) => server.close(resolve)); },
  };
}

export async function startAuthFixture(opts) {
  const fx = createAuthFixture(opts);
  await fx.start();
  return fx;
}
