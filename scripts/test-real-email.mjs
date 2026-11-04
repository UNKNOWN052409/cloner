#!/usr/bin/env node
// REAL SMTP email test (task G1.2).
//
// SECTION A — REAL DELIVERY (env-driven):
//   When SMTP_HOST/SMTP_PORT/SMTP_FROM are present in the environment this
//   performs a genuine SMTP send through the configured relay, addressed to
//   SMTP_FROM itself (the documented self-test target), and asserts the
//   server's acceptance response. When the env is absent it SKIPS LOUDLY —
//   an explicit, unmistakable banner — because a product test cannot invent
//   credentials. No mock, no fixture, no recorded replay is ever involved.
//
// SECTION B — PROTOCOL EXERCISE AGAINST A LOCAL SMTP SIMULATOR:
//   Mocks are permitted ONLY inside test files as the remote-end simulator.
//   The simulator below is a real TCP server speaking the real SMTP wire
//   protocol (multiline EHLO capabilities, AUTH PLAIN/LOGIN, STARTTLS with a
//   runtime-generated self-signed certificate, dot-stuffed DATA), so the
//   PRODUCT code path (RawSmtpClient over node:net/node:tls) is exercised
//   end-to-end over real sockets. Asserts:
//     • unauthenticated relay: greeting → EHLO → MAIL/RCPT/DATA → 250, correct
//       RFC 5322 headers, base64 body decodes, dot-stuffing on the wire
//     • AUTH PLAIN chosen when advertised, AUTH LOGIN fallback for LOGIN-only
//       servers (credentials encoded exactly as sent)
//     • AUTH rejection → typed EmailError(AUTH_FAILED) + email:failed bus receipt
//     • RCPT rejection → typed EmailError(RCPT_REJECTED)
//     • STARTTLS upgrade with real TLS handshake (self-signed cert accepted
//       only via SMTP_TLS_INSECURE=1), re-EHLO inside TLS, delivery over TLS
//     • non-ASCII subject → RFC 2047 encoded-words; html → multipart/alternative
//     • env absent → emailConfigured()=false and sendEmail rejects
//       EMAIL_NOT_CONFIGURED with a pointing-at-env message (no silent mock)
//     • router leg: POST /api/email/send + GET /receipts through the real
//       express router with env as the credential source (set + restored)
//     • delivery receipts emitted on the notification bus (email:delivered /
//       email:failed) with full receipt payloads
// Prints PASS/FAIL lines, exits nonzero on any failure, closes everything it
// opened. Test-only credentials for the loopback simulator only — nothing
// hardcoded in product paths.
import fs from "node:fs";
import net from "node:net";
import tls from "node:tls";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const PROJECT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
process.chdir(PROJECT);

const { bus } = await import("../src/events.js");
const email = await import("../src/platform/email-real.js");
const { EmailError } = email;

const results = [];
const check = (name, ok, detail = "") => {
  results.push(ok);
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- env save/restore ----------
// Save the caller's SMTP env up front (Section A READS it — nothing is deleted
// here); the router leg (L8) clears + replaces + restores inside its own block
// so it can never leak into Section A or the caller's shell.
const ENV_KEYS = ["SMTP_HOST", "SMTP_PORT", "SMTP_USER", "SMTP_PASS", "SMTP_FROM", "SMTP_SECURE", "SMTP_TLS_INSECURE", "SMTP_TIMEOUT_MS"];
const envSaved = {};
for (const k of ENV_KEYS) envSaved[k] = process.env[k];
const clearEnvKeys = () => { for (const k of ENV_KEYS) delete process.env[k]; };
const restoreEnv = () => { for (const k of ENV_KEYS) { if (envSaved[k] === undefined) delete process.env[k]; else process.env[k] = envSaved[k]; } };

// ===========================================================================
// SECTION A — REAL SMTP DELIVERY (env present) or LOUD SKIP (env absent)
// ===========================================================================
let realSendRan = false;
try {
  const envCfg = email.smtpConfigFromEnv();
  if (!envCfg.ok) {
    console.log("SKIP  [REAL SMTP SEND] — required env missing: " + envCfg.missing.join(", "));
    console.log("SKIP  Set SMTP_HOST, SMTP_PORT, SMTP_FROM (and SMTP_USER/SMTP_PASS when the relay");
    console.log("SKIP  requires auth) in the environment, then re-run: node scripts/test-real-email.mjs");
    console.log("SKIP  The real-send leg is intentionally skipped; product paths stay env-only (no mocks).");
  } else {
    realSendRan = true;
    console.log(`[real] sending via ${envCfg.config.host}:${envCfg.config.port} (secure=${envCfg.config.secure}) from/to ${envCfg.config.from}`);
    const receipt = await email.sendEmail({
      to: envCfg.config.from, // documented self-test target: the sender's own address
      subject: `cloner real-smtp-email self-test ${new Date().toISOString()}`,
      text: "REAL SMTP delivery self-test from cloner (task G1.2).\nIf you can read this in the relay's inbox, the platform's email path works end to end.",
    });
    check("REAL SMTP send accepted by server", receipt.ok === true && receipt.response != null,
      `transport=${receipt.transport} response=${String(receipt.response).slice(0, 120)} durationMs=${receipt.durationMs}`);
    check("REAL receipt carries messageId + response", typeof receipt.messageId === "string" && receipt.messageId.includes("@"),
      `messageId=${receipt.messageId}`);
  }
} catch (e) {
  check("REAL SMTP send (env present)", false, `${e.code || ""}: ${e.message}`.slice(0, 220));
}

// ===========================================================================
// SECTION B — SMTP wire-protocol simulator (test-only remote-end stand-in)
// ===========================================================================

function startSmtpSim(behavior = {}) {
  return new Promise((resolve, reject) => {
    const state = {
      port: 0, connections: 0, ehloCount: 0, tlsUpgraded: 0, dataOverTls: false,
      authSeen: null, authenticated: false, lastData: null, lastRawPayload: null,
      server: null,
    };
    const server = net.createServer((socket) => {
      state.connections++;
      let sock = socket;
      let buf = "";
      let tlsDone = false;
      let collecting = false;
      let rawLines = [];
      let dataLines = [];
      let loginStage = 0; // 0=not in login, 1=awaiting user, 2=awaiting pass
      let loginCreds = {};
      const mechs = behavior.authMechs || []; // [] | ["PLAIN"] | ["LOGIN"] | both
      const write = (s) => { try { sock.write(s); } catch {} };
      const authLine = mechs.length ? `250-AUTH ${mechs.join(" ")}\r\n` : "";
      write(`220 sim.test ESMTP ready\r\n`);

      const finishData = () => {
        collecting = false;
        state.lastData = dataLines.join("\r\n") + "\r\n";
        state.lastRawPayload = rawLines.join("\r\n") + "\r\n";
        state.dataOverTls = tlsDone;
        write(`250 2.0.0 Ok: queued as SIM${state.connections}\r\n`);
      };

      const handle = (line) => {
        if (collecting) {
          if (line === ".") return finishData();
          rawLines.push(line);
          dataLines.push(line.startsWith("..") ? line.slice(1) : line); // un-dot-stuff
          return;
        }
        if (loginStage === 1) { loginCreds.user = Buffer.from(line, "base64").toString("utf8"); loginStage = 2; return write("334 UGFzc3dvcmQ6\r\n"); }
        if (loginStage === 2) {
          loginCreds.pass = Buffer.from(line, "base64").toString("utf8");
          loginStage = 0;
          if (behavior.rejectAuthWith) return write(`${behavior.rejectAuthWith}\r\n`);
          state.authSeen = { mech: "LOGIN", ...loginCreds };
          state.authenticated = true;
          return write("235 2.7.0 Authentication successful\r\n");
        }
        const verb = (line.split(/[\s:]/)[0] || "").toUpperCase();
        switch (verb) {
          case "EHLO":
          case "HELO":
            state.ehloCount++;
            write(`250-sim.test greets you\r\n${(!tlsDone && behavior.advertiseStarttls) ? "250-STARTTLS\r\n" : ""}${authLine}250 SIZE 35882577\r\n`);
            return;
          case "STARTTLS":
            if (!behavior.advertiseStarttls || tlsDone) return write("502 5.5.1 STARTTLS not available\r\n");
            return sock.write("220 2.0.0 Ready to start TLS\r\n", () => {
              const tlsSocket = new tls.TLSSocket(sock, { isServer: true, secureContext: behavior.secureContext });
              tlsSocket.once("secure", () => { tlsDone = true; state.tlsUpgraded++; });
              sock.removeAllListeners("data");
              sock.removeAllListeners("error");
              sock = tlsSocket;
              sock.on("data", onData);
              sock.on("error", () => {});
            });
          case "AUTH": {
            if (behavior.rejectAuthWith) return write(`${behavior.rejectAuthWith}\r\n`);
            if (/^AUTH PLAIN\b/i.test(line)) {
              const blob = Buffer.from(line.slice("AUTH PLAIN ".length).trim(), "base64").toString("utf8");
              const parts = blob.split("\0"); // \0authzid\0authcid\0passwd
              state.authSeen = { mech: "PLAIN", user: parts[1] ?? "", pass: parts[2] ?? "" };
              state.authenticated = true;
              return write("235 2.7.0 Authentication successful\r\n");
            }
            if (/^AUTH LOGIN\b/i.test(line)) { loginStage = 1; return write("334 VXNlcm5hbWU6\r\n"); }
            return write("504 5.5.4 Unrecognized authentication type\r\n");
          }
          case "MAIL":
            if (behavior.enforceAuth && !state.authenticated) return write("530 5.7.0 Authentication required\r\n");
            return write("250 2.1.0 Ok\r\n");
          case "RCPT":
            if (behavior.rejectRcptWith) return write(`${behavior.rejectRcptWith}\r\n`);
            return write("250 2.1.5 Ok\r\n");
          case "DATA":
            collecting = true; rawLines = []; dataLines = [];
            return write("354 End data with <CR><LF>.<CR><LF>\r\n");
          case "QUIT":
            write("221 2.0.0 Bye\r\n");
            return sock.end();
          case "RSET":
            state.authenticated = false;
            return write("250 2.0.0 Ok\r\n");
          default:
            return write("502 5.5.2 Command not implemented\r\n");
        }
      };
      const onData = (chunk) => {
        buf += chunk.toString("utf8");
        let idx;
        while ((idx = buf.indexOf("\r\n")) !== -1) {
          const line = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          try { handle(line); } catch (e) { write("421 4.3.0 Internal simulator error\r\n"); }
          if (sock.destroyed) return;
        }
      };
      socket.on("data", onData);
      socket.on("error", () => {});
    });
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      state.port = server.address().port;
      state.server = server;
      resolve(state);
    });
  });
}

const closeSim = (sim) => new Promise((r) => {
  try { sim.server.closeAllConnections?.(); } catch {}
  try { sim.server.close(() => r()); } catch { r(); }
  setTimeout(r, 300).unref();
});

const baseCfg = (sim, extra = {}) => ({
  host: "127.0.0.1", port: sim.port, from: "cloner-sender@example.com",
  user: "", pass: "", secure: false, tlsInsecure: false, timeoutMs: 8000, ...extra,
});
const baseMsg = (over = {}) => ({
  to: "rcpt@example.com", subject: "sim leg", text: "hello from the cloner email test\n", ...over,
});

// ---------- bus receipt capture (the notification channel) ----------
const busDelivered = [];
const busFailed = [];
const onDelivered = (e) => busDelivered.push(e.data);
const onFailed = (e) => busFailed.push(e.data);
bus.on("email:delivered", onDelivered);
bus.on("email:failed", onFailed);

let sim1;
try {
  // ---------- L1: unauthenticated plain relay, content + dot-stuffing ----------
  sim1 = await startSmtpSim({ authMechs: [] });
  const r1 = await email.sendEmail(baseMsg({
    subject: "L1 plain relay",
    text: "line one\n.leading dot line\nlast line\n",
  }), baseCfg(sim1));
  check("L1 delivery accepted (250 response)", r1.ok === true && /queued/.test(r1.response), r1.response);
  check("L1 transport is raw-smtp", r1.transport === "raw-smtp", r1.transport);
  check("L1 RFC 5322 headers present", ["From:", "To:", "Subject:", "Date:", "Message-ID:", "MIME-Version: 1.0"].every((h) => sim1.lastData.includes(h)),
    "From/To/Subject/Date/Message-ID/MIME-Version");
  check("L1 envelope matches message", sim1.lastData.includes("From: cloner-sender@example.com") && sim1.lastData.includes("To: rcpt@example.com"), "");
  const bodyMatch = sim1.lastData.split("\r\n\r\n")[1] || "";
  const decoded = Buffer.from(bodyMatch.replace(/\r\n/g, ""), "base64").toString("utf8");
  check("L1 base64 body round-trips", decoded.includes("line one") && decoded.includes(".leading dot line") && decoded.includes("last line"),
    JSON.stringify(decoded.slice(0, 90)));
  // base64 bodies can never start with "." (alphabet has no dot), so the wire
  // transform is verified directly on the exported product function, plus the
  // DATA terminator handling is proven by the send completing without a hang.
  const stuffed = email.dotStuff("top\r\n.leading\r\n..double\r\n.");
  check("L1 dot-stuffing transform (RFC 5321 §4.5.2)", stuffed === "top\r\n..leading\r\n...double\r\n..",
    JSON.stringify(stuffed));
  check("L1 Message-ID domain from SMTP_FROM", /Message-ID: <.+@example\.com>/.test(sim1.lastData), "");

  // ---------- L2: AUTH PLAIN when advertised ----------
  const sim2 = await startSmtpSim({ authMechs: ["PLAIN", "LOGIN"], enforceAuth: true });
  const r2 = await email.sendEmail(baseMsg({ subject: "L2 auth plain" }), baseCfg(sim2, { user: "alice", pass: "s3cret-test" }));
  check("L2 AUTH PLAIN used + accepted", r2.ok === true && sim2.authSeen?.mech === "PLAIN" && sim2.authSeen?.user === "alice" && sim2.authSeen?.pass === "s3cret-test",
    `authSeen=${JSON.stringify(sim2.authSeen?.mech)}`);
  await closeSim(sim2);

  // ---------- L3: AUTH LOGIN fallback on LOGIN-only servers ----------
  const sim3 = await startSmtpSim({ authMechs: ["LOGIN"], enforceAuth: true });
  const r3 = await email.sendEmail(baseMsg({ subject: "L3 auth login" }), baseCfg(sim3, { user: "bob", pass: "hunter2-test" }));
  check("L3 AUTH LOGIN fallback works", r3.ok === true && sim3.authSeen?.mech === "LOGIN" && sim3.authSeen?.user === "bob" && sim3.authSeen?.pass === "hunter2-test",
    `authSeen=${JSON.stringify(sim3.authSeen?.mech)}`);
  await closeSim(sim3);

  // ---------- L4: AUTH rejection → typed error + failed receipt ----------
  const sim4 = await startSmtpSim({ authMechs: ["PLAIN", "LOGIN"], rejectAuthWith: "535 5.7.8 Error: authentication failed" });
  let l4err = null;
  try { await email.sendEmail(baseMsg({ subject: "L4 reject" }), baseCfg(sim4, { user: "eve", pass: "bad" })); }
  catch (e) { l4err = e; }
  check("L4 AUTH rejection → EmailError(AUTH_FAILED)", l4err instanceof EmailError && l4err.code === "AUTH_FAILED" && l4err.stage === "auth",
    `${l4err?.code || "no error"} / ${String(l4err?.response || "").slice(0, 60)}`);
  check("L4 email:failed receipt on notification bus", busFailed.some((r) => r.errorCode === "AUTH_FAILED" && r.subject === "L4 reject"), "");
  await closeSim(sim4);

  // ---------- L5: RCPT rejection → typed error ----------
  const sim5 = await startSmtpSim({ authMechs: [], rejectRcptWith: "550 5.1.1 <rcpt@example.com>: Recipient address rejected" });
  let l5err = null;
  try { await email.sendEmail(baseMsg({ subject: "L5 rcpt reject" }), baseCfg(sim5)); }
  catch (e) { l5err = e; }
  check("L5 RCPT rejection → EmailError(RCPT_REJECTED)", l5err instanceof EmailError && l5err.code === "RCPT_REJECTED" && l5err.stage === "rcptTo",
    `${l5err?.code || "no error"} / ${String(l5err?.response || "").slice(0, 60)}`);
  await closeSim(sim5);

  // ---------- L6: STARTTLS upgrade with a real TLS handshake ----------
  let sim6 = null;
  let certDir = null;
  try {
    certDir = fs.mkdtempSync(path.join(os.tmpdir(), "smtp-sim-cert-"));
    const keyP = path.join(certDir, "key.pem"), crtP = path.join(certDir, "crt.pem");
    execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", keyP, "-out", crtP, "-days", "2", "-subj", "/CN=sim.test"], { stdio: "pipe" });
    const secureContext = tls.createSecureContext({ key: fs.readFileSync(keyP), cert: fs.readFileSync(crtP) });
    sim6 = await startSmtpSim({ authMechs: ["PLAIN", "LOGIN"], advertiseStarttls: true, enforceAuth: true, secureContext });
    const r6 = await email.sendEmail(baseMsg({ subject: "L6 starttls" }), baseCfg(sim6, { user: "carol", pass: "tls-test", tlsInsecure: true }));
    check("L6 STARTTLS upgraded (TLS handshake done)", r6.ok === true && sim6.tlsUpgraded === 1, `tlsUpgraded=${sim6.tlsUpgraded}`);
    check("L6 re-EHLO inside TLS (2 EHLOs, auth over TLS)", sim6.ehloCount === 2 && sim6.authSeen?.user === "carol", `ehloCount=${sim6.ehloCount}`);
    check("L6 DATA arrived over the TLS session", sim6.dataOverTls === true && sim6.lastData?.includes("Subject: L6 starttls"), "");
  } catch (e) {
    check("L6 STARTTLS leg (openssl cert + TLS)", false, String(e?.message || e).slice(0, 160));
  }
  if (sim6) await closeSim(sim6);
  if (certDir) { try { fs.rmSync(certDir, { recursive: true, force: true }); } catch {} }

  // ---------- L7: RFC 2047 subject + multipart/alternative ----------
  const sim7 = await startSmtpSim({ authMechs: [] });
  await email.sendEmail(baseMsg({
    subject: "克隆 done ✓ Ünicode",
    text: "plain alt",
    html: "<html><body><h1>克隆 done</h1></body></html>",
  }), baseCfg(sim7));
  const data7 = sim7.lastData;
  check("L7 non-ASCII subject → RFC 2047 encoded-words", /=\?UTF-8\?B\?/.test(data7) && !/[^\x00-\x7f]/.test(data7.split("\r\n\r\n")[0]), "headers are pure ASCII");
  check("L7 html → multipart/alternative with base64 parts", data7.includes("multipart/alternative") && data7.includes("Content-Transfer-Encoding: base64") && data7.includes("boundary="), "");
  const htmlB64 = (data7.match(/Content-Type: text\/html; charset=utf-8\r\nContent-Transfer-Encoding: base64\r\n\r\n([A-Za-z0-9+/=\r\n]+)\r\n--/) || [])[1] || "";
  const htmlDecoded = Buffer.from(htmlB64.replace(/\r\n/g, ""), "base64").toString("utf8");
  check("L7 html part decodes back", htmlDecoded.includes("<h1>克隆 done</h1>"), JSON.stringify(htmlDecoded.slice(0, 60)));
  await closeSim(sim7);

  // ---------- L8: router leg — real express router, env as credential source ----
  clearEnvKeys(); // L9 below asserts the unconfigured behavior, so start clean
  const sim8 = await startSmtpSim({ authMechs: ["PLAIN", "LOGIN"], enforceAuth: true });
  process.env.SMTP_HOST = "127.0.0.1";
  process.env.SMTP_PORT = String(sim8.port);
  process.env.SMTP_USER = "router-user";
  process.env.SMTP_PASS = "router-pass";
  process.env.SMTP_FROM = "router@example.com";
  process.env.SMTP_TIMEOUT_MS = "8000";
  const { default: expressMod } = await import("express");
  const app = expressMod();
  app.use(expressMod.json());
  const fakeAuth = (req, _res, next) => { req.userId = "router-test-user"; next(); };
  app.use("/api/email", email.createEmailRouter({ authRequired: fakeAuth }));
  const httpServer = app.listen(0, "127.0.0.1");
  await new Promise((r) => httpServer.once("listening", r));
  const httpPort = httpServer.address().port;
  const httpCall = (method, p, body) => new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port: httpPort, path: p, method,
      headers: { "content-type": "application/json" } }, (res) => {
      let raw = ""; res.on("data", (c) => (raw += c)); res.on("end", () => resolve({ status: res.statusCode, json: JSON.parse(raw || "{}") }));
    });
    req.on("error", reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
  const sent = await httpCall("POST", "/api/email/send", { to: "rcpt@example.com", subject: "L8 router send", text: "via router\n" });
  check("L8 POST /api/email/send → 200 + receipt", sent.status === 200 && sent.json.receipt?.ok === true && sent.json.receipt.transport === "raw-smtp",
    `status=${sent.status} response=${String(sent.json.receipt?.response || "").slice(0, 60)}`);
  check("L8 router used env credentials (AUTH PLAIN)", sim8.authSeen?.user === "router-user" && sim8.authSeen?.mech === "PLAIN", "");
  const recs = await httpCall("GET", "/api/email/receipts");
  check("L8 GET /api/email/receipts lists the send", recs.status === 200 && recs.json.receipts?.some((r) => r.subject === "L8 router send" && r.ok), `count=${recs.json.receipts?.length}`);
  const bad = await httpCall("POST", "/api/email/send", { subject: "no to" });
  check("L8 missing 'to' → 400 typed error", bad.status === 400 && bad.json.code === "INVALID_MESSAGE", `status=${bad.status}`);
  const badBody = await httpCall("POST", "/api/email/send", { to: "rcpt@example.com", subject: "no body" });
  check("L8 missing body → 400 typed error", badBody.status === 400, `status=${badBody.status}`);
  await closeSim(sim8);
  await new Promise((r) => httpServer.close(r));
  // restore env
  for (const k of ENV_KEYS) { if (envSaved[k] === undefined) delete process.env[k]; else process.env[k] = envSaved[k]; }

  // ---------- L9: env absent → honest EMAIL_NOT_CONFIGURED, nothing sent ----
  // This leg owns its env: clear (then restore) so the assertion holds
  // regardless of what the CALLER put in the environment.
  clearEnvKeys();
  check("L9 emailConfigured() false without env", email.emailConfigured() === false, "");
  let l9err = null;
  try { await email.sendEmail(baseMsg({ subject: "L9 unconfigured" })); }
  catch (e) { l9err = e; }
  check("L9 sendEmail rejects EMAIL_NOT_CONFIGURED (no mock fallback)", l9err instanceof EmailError && l9err.code === "EMAIL_NOT_CONFIGURED" &&
    /SMTP_HOST/.test(l9err.message), `${l9err?.code || "no error"}: ${String(l9err?.message || "").slice(0, 100)}`);
  check("L9 failed receipt recorded for unconfigured send", busFailed.some((r) => r.errorCode === "EMAIL_NOT_CONFIGURED" && r.transport === "none"), "");
  restoreEnv();

  // ---------- L10: notification bus carried delivery receipts ----------
  check("L10 email:delivered receipts on notification bus", busDelivered.length >= 6 &&
    busDelivered.every((r) => r.ok && r.to && r.receiptId && r.ts && typeof r.durationMs === "number"),
    `delivered=${busDelivered.length} failed=${busFailed.length}`);

  // ---------- L11: delivery receipt persisted into the notification service's
  // append-only delivery log (notification_deliveries — the table 4.2.16's
  // listDeliveries() reads back). Real DB required; when PostgreSQL is down
  // this leg reports SKIP (the in-memory ring + bus are the fallbacks).
  try {
    const dbmod = await import("../src/database/client.js");
    await dbmod.query("SELECT 1");
    const email11 = `real-email-${Date.now()}@test.local`;
    const user11 = (await dbmod.query(
      "INSERT INTO users (email, password_hash) VALUES ($1, $2) RETURNING id",
      [email11, "x"], // password_hash NOT NULL — value unused, row deleted below
    )).rows[0].id;
    const sim11 = await startSmtpSim({ authMechs: [] });
    const r11 = await email.sendEmail(baseMsg({ subject: "L11 notification-log receipt" }), baseCfg(sim11), { userId: user11 });
    // persistence is best-effort async (never blocks the send) — poll briefly
    let row = null;
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline) {
      const q = await dbmod.query(
        "SELECT event, channel, status, recipient, subject, detail FROM notification_deliveries WHERE user_id = $1 AND event = 'email.custom'",
        [user11]);
      if (q.rows.length) { row = q.rows[0]; break; }
      await sleep(100);
    }
    check("L11 receipt persisted into notification_deliveries", !!row && row.channel === "email" && row.status === "sent" &&
      row.detail?.receiptId === r11.receiptId && row.subject === "L11 notification-log receipt",
      row ? `event=${row.event} status=${row.status} receiptId=${row.detail?.receiptId?.slice(0, 8)}…` : "no row appeared within 3s");
    await closeSim(sim11);
    await dbmod.query("DELETE FROM users WHERE id = $1", [user11]); // cascades the delivery row
    try { await dbmod.closePool(); } catch {}
  } catch (e) {
    const down = /ECONNREFUSED|ETIMEDOUT|does not exist/i.test(String(e?.message || ""));
    if (down) console.log("SKIP  L11 notification-log persistence — PostgreSQL unreachable: " + String(e.message).slice(0, 100));
    else check("L11 notification-log persistence leg", false, String(e?.stack || e).split("\n")[0].slice(0, 200));
  }
} catch (e) {
  check("no unexpected crash in Section B", false, String(e?.stack || e).split("\n").slice(0, 3).join(" | ").slice(0, 300));
} finally {
  bus.off("email:delivered", onDelivered);
  bus.off("email:failed", onFailed);
  restoreEnv();
  if (sim1) await closeSim(sim1);
}

const fails = results.filter((r) => !r).length;
console.log(`\n${fails ? "RESULT: FAIL" : "RESULT: PASS"}  (${results.length - fails}/${results.length} checks passed${realSendRan ? ", real SMTP send exercised" : ", real-send leg SKIPPED (no SMTP env)"})`);
process.exit(fails ? 1 : 0);
