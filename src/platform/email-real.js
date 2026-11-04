// REAL SMTP email (task G1.2 — no mocks in product paths).
//
// Product code talks to the REAL SMTP server named by env:
//   SMTP_HOST / SMTP_PORT / SMTP_FROM            — required (clean typed error when absent)
//   SMTP_USER / SMTP_PASS                        — optional (plain relays skip AUTH entirely)
//   SMTP_SECURE=1                                — implicit TLS on connect (e.g. port 465)
//   SMTP_TLS_INSECURE=1                          — accept self-signed certs (self-hosted relays/tests ONLY)
//   SMTP_TIMEOUT_MS                              — per-operation timeout, default 20000
//
// Transport: nodemailer when it is installed (optional dependency), otherwise a
// first-party raw SMTP client over node:net / node:tls implementing the full
// ESMTP conversation: greeting → EHLO → [STARTTLS upgrade] → [AUTH PLAIN|LOGIN]
// → MAIL FROM → RCPT TO → DATA (dot-stuffed) → QUIT. Multiline replies, server
// capability parsing and per-command timeouts are handled for real; there is no
// simulated or recorded path anywhere in this file.
//
// Delivery receipts land in the notification service (task 4.2.16): every
// terminal outcome is
//   1. written best-effort into the append-only delivery log the service
//      exposes to users (notification_deliveries — same table listDeliveries()
//      reads; channel='email', status='sent'|'failed'), attributed to the
//      calling user when one is known, and
//   2. emitted on the global event bus (src/events.js — the channel the
//      dashboard WS bridge consumes) as
//        email:delivered  receipt
//        email:failed     receipt
// and kept in a bounded in-memory ring, queryable via GET /api/email/receipts.
// A unreachable database never breaks a send — the delivery itself is the
// source of truth, exactly the auditSafe posture server.js uses for audit
// events.
//
// INTEGRATOR MOUNT LINES (server.js + package.json are integrator-owned):
//   import { createEmailRouter } from "./email-real.js";
//   app.use("/api/email", createEmailRouter());          // session-authenticated
//   (package.json) "test:real-email": "node scripts/test-real-email.mjs"
//   (dashboard push, one line in the existing bus bridge):
//   bus.on("email:delivered", (e) => broadcast({ type: "email:delivered", task: null, data: e }));
//
// Routes:
//   POST /api/email/send      { to, subject, text, html? }  → 200 receipt | 400 | 503 unconfigured | 502 delivery failure
//   GET  /api/email/receipts                                → recent receipts (newest first)
import net from "node:net";
import tls from "node:tls";
import os from "node:os";
import crypto from "node:crypto";
import express from "express";
import { bus } from "../events.js";
import { query as dbQuery } from "../database/client.js";
import { authRequired as defaultAuthRequired } from "../auth/auth-middleware.js";

// ---------------------------------------------------------------------------
// env configuration — the ONLY source of credentials; nothing is hardcoded
// ---------------------------------------------------------------------------

const truthy = (v) => /^(1|true|yes|on)$/i.test(String(v ?? ""));
const posInt = (v, dflt) => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : dflt;
};

export function smtpConfigFromEnv(env = process.env) {
  const host = String(env.SMTP_HOST || "").trim();
  const portRaw = String(env.SMTP_PORT || "").trim();
  const port = Number(portRaw);
  const from = String(env.SMTP_FROM || "").trim();
  const missing = [];
  if (!host) missing.push("SMTP_HOST");
  if (!portRaw || !Number.isInteger(port) || port <= 0 || port > 65535) missing.push("SMTP_PORT");
  if (!from) missing.push("SMTP_FROM");
  return {
    ok: missing.length === 0,
    missing,
    config: {
      host,
      port: Number.isInteger(port) ? port : 0,
      user: String(env.SMTP_USER || ""),
      pass: String(env.SMTP_PASS || ""),
      from,
      secure: truthy(env.SMTP_SECURE),
      tlsInsecure: truthy(env.SMTP_TLS_INSECURE),
      timeoutMs: posInt(env.SMTP_TIMEOUT_MS, 20000),
    },
  };
}

export function emailConfigured(env = process.env) {
  return smtpConfigFromEnv(env).ok;
}

// ---------------------------------------------------------------------------
// typed errors — every failure carries an SMTP stage + the server's response
// ---------------------------------------------------------------------------

export class EmailError extends Error {
  constructor(code, message, { stage = null, response = null } = {}) {
    super(message);
    this.name = "EmailError";
    this.code = code;
    this.stage = stage;
    this.response = response;
  }
}

const httpStatusFor = (code) =>
  code === "EMAIL_NOT_CONFIGURED" ? 503 :
  code === "INVALID_MESSAGE" || code === "INVALID_CONFIG" ? 400 : 502;

// ---------------------------------------------------------------------------
// MIME message builder (RFC 5322 + RFC 2047 + RFC 2045)
// ---------------------------------------------------------------------------

const extractAddress = (v) => {
  const s = String(v || "").trim();
  const m = s.match(/<([^<>]+)>/); // "Display Name <a@b>" → a@b
  const addr = (m ? m[1] : s).trim();
  if (!/^[^\s@,;<>]+@[^\s@,;<>]+\.[^\s@,;<>]+$/.test(addr)) {
    throw new EmailError("INVALID_MESSAGE", `invalid email address: ${JSON.stringify(String(v || ""))}`, { stage: "message" });
  }
  return addr;
};

const rfc2047Encode = (v) => {
  const s = String(v || "").replace(/[\r\n]+/g, " ");
  if (!/[^\x20-\x7e]/.test(s)) return s;
  // B-encoding only, chunked on base64 4-char boundaries so each encoded-word
  // decodes independently; folded at 75 octets per RFC 2047 §2.
  const b64 = Buffer.from(s, "utf8").toString("base64");
  const parts = [];
  for (let i = 0; i < b64.length; i += 64) parts.push(b64.slice(i, i + 64));
  return parts.map((p) => `=?UTF-8?B?${p}?=`).join("\r\n ");
};

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const pad2 = (n) => String(n).padStart(2, "0");
const rfc5322Date = (d = new Date()) =>
  `${DAYS[d.getUTCDay()]}, ${pad2(d.getUTCDate())} ${MONS[d.getUTCMonth()]} ${d.getUTCFullYear()} ` +
  `${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}:${pad2(d.getUTCSeconds())} +0000`;

const foldBase64Body = (b64) => b64.match(/.{1,76}/g)?.join("\r\n") ?? "";

// RFC 5321 §4.5.2 dot-stuffing: every payload line beginning with a "." gets a
// second dot, so a bare "." can only ever be the DATA terminator. Exported
// because it is a contract of the wire protocol (and unit-tested directly).
export function dotStuff(payload) {
  return payload.replace(/(^|\r\n)\./g, "$1..");
}

// Builds the full DATA payload. Text parts travel as UTF-8 base64 bodies (safe
// through every relay, no bare CR/LF, no 8-bit dependency); dot-stuffing is
// applied by the transport at send time per RFC 5321 §4.5.2.
export function buildMessage({ from, to, subject, text, html, messageId }) {
  if (!from) throw new EmailError("INVALID_MESSAGE", "message missing From", { stage: "message" });
  if (!to || (Array.isArray(to) && to.length === 0)) {
    throw new EmailError("INVALID_MESSAGE", "message missing To", { stage: "message" });
  }
  if ((text == null || String(text) === "") && (html == null || String(html) === "")) {
    throw new EmailError("INVALID_MESSAGE", "message needs text or html body", { stage: "message" });
  }
  const toList = Array.isArray(to) ? to : [to];
  const domain = (from.match(/@([^\s>]+)/) || [null, "localhost"])[1];
  const mid = messageId || `<${crypto.randomUUID()}@${domain}>`;
  const headers = [
    `From: ${from}`,
    `To: ${toList.map(String).join(", ")}`,
    `Subject: ${rfc2047Encode(subject || "")}`,
    `Date: ${rfc5322Date()}`,
    `Message-ID: ${mid}`,
    "MIME-Version: 1.0",
  ];
  let body;
  if (html) {
    const boundary = `cloner-${crypto.randomUUID()}`;
    headers.push(`Content-Type: multipart/alternative; boundary="${boundary}"`);
    const part = (ct, payload) =>
      `--${boundary}\r\nContent-Type: ${ct}; charset=utf-8\r\nContent-Transfer-Encoding: base64\r\n\r\n` +
      `${foldBase64Body(Buffer.from(String(payload), "utf8").toString("base64"))}\r\n`;
    body =
      `This is a multi-part message in MIME format.\r\n` +
      part("text/plain", text ?? html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim()) +
      part("text/html", html) +
      `--${boundary}--`;
  } else {
    headers.push("Content-Type: text/plain; charset=utf-8");
    headers.push("Content-Transfer-Encoding: base64");
    body = foldBase64Body(Buffer.from(String(text), "utf8").toString("base64"));
  }
  return { payload: `${headers.join("\r\n")}\r\n\r\n${body}\r\n`, messageId: mid };
}

// ---------------------------------------------------------------------------
// raw SMTP client (product transport when nodemailer is not installed)
// ---------------------------------------------------------------------------

const expectOf = {
  greeting: [220],
  ehlo: [250],
  starttls: [220],
  auth: [235],
  mailFrom: [250],
  rcptTo: [250, 251],
  data: [354],
  dot: [250],
  quit: [221],
};

// SNI must not be set to an IP literal (RFC 6066) — omit for loopback/IP relays.
const sniName = (host) => (net.isIP(host) ? undefined : host);

class RawSmtpClient {
  constructor(cfg) {
    this.cfg = cfg;
    this.socket = null;
    this.buf = "";
    this.caps = new Set();
    this.secure = !!cfg.secure;
  }

  // one SMTP reply: array of {code, text} lines; terminated by "NNN " line
  _readReply(deadline) {
    return new Promise((resolve, reject) => {
      const fail = (e) => {
        cleanup();
        reject(e);
      };
      const onData = (chunk) => {
        this.buf += chunk.toString("utf8");
        let idx;
        const lines = [];
        while ((idx = this.buf.indexOf("\r\n")) !== -1) {
          const line = this.buf.slice(0, idx);
          this.buf = this.buf.slice(idx + 2);
          lines.push(line);
          if (/^\d{3} /.test(line)) {
            cleanup();
            resolve(lines);
            return;
          }
        }
      };
      const cleanup = () => {
        clearTimeout(timer);
        this.socket?.off("data", onData);
        this.socket?.off("error", onErr);
        this.socket?.off("close", onClose);
      };
      const onErr = (e) => fail(new EmailError("CONNECTION_ERROR", `socket error: ${e.message}`, { stage: "io" }));
      const onClose = () => fail(new EmailError("CONNECTION_CLOSED", "server closed the connection mid-reply", { stage: "io" }));
      const timer = setTimeout(() => fail(new EmailError("TIMEOUT", `timed out after ${this.cfg.timeoutMs}ms`, { stage: "io" })), Math.max(1, deadline - Date.now()));
      this.socket.on("data", onData);
      this.socket.on("error", onErr);
      this.socket.on("close", onClose);
    });
  }

  async _command(stage, line, accepts = [250]) {
    const deadline = Date.now() + this.cfg.timeoutMs;
    if (line !== null) await this._write(line, deadline);
    const lines = await this._readReply(deadline);
    const code = Number(lines[0].slice(0, 3));
    if (!accepts.includes(code)) {
      const stageCode = { greeting: "GREETING_REJECTED", ehlo: "EHLO_FAILED", starttls: "STARTTLS_FAILED", auth: "AUTH_FAILED", mailFrom: "MAIL_FROM_REJECTED", rcptTo: "RCPT_REJECTED", data: "DATA_REJECTED", dot: "SEND_REJECTED", quit: "QUIT_FAILED" }[stage] || "SMTP_ERROR";
      throw new EmailError(stageCode, `${stage} rejected with ${code}`, { stage, response: lines.join("\n") });
    }
    return { code, lines };
  }

  _write(line, deadline) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new EmailError("TIMEOUT", "socket write timed out", { stage: "io" })), Math.max(1, deadline - Date.now()));
      this.socket.write(line.endsWith("\r\n") ? line : line + "\r\n", (err) => {
        clearTimeout(timer);
        err ? reject(new EmailError("CONNECTION_ERROR", `write failed: ${err.message}`, { stage: "io" })) : resolve();
      });
    });
  }

  _connect() {
    return new Promise((resolve, reject) => {
      const onError = (e) => reject(new EmailError("CONNECT_FAILED", `cannot reach SMTP ${this.cfg.host}:${this.cfg.port} — ${e.message}`, { stage: "connect" }));
      const base = this.cfg.secure
        ? tls.connect({ host: this.cfg.host, port: this.cfg.port, servername: sniName(this.cfg.host), rejectUnauthorized: !this.cfg.tlsInsecure })
        : net.connect({ host: this.cfg.host, port: this.cfg.port });
      const timer = setTimeout(() => { base.destroy(); reject(new EmailError("TIMEOUT", `connect timed out after ${this.cfg.timeoutMs}ms`, { stage: "connect" })); }, this.cfg.timeoutMs);
      base.once(this.cfg.secure ? "secureConnect" : "connect", () => {
        clearTimeout(timer);
        base.off("error", onError);
        this.socket = base;
        resolve(base);
      });
      base.once("error", onError);
    });
  }

  async _upgradeTls() {
    const raw = this.socket;
    raw.removeAllListeners("data");
    raw.removeAllListeners("error");
    raw.removeAllListeners("close");
    this.buf = "";
    const upgraded = await new Promise((resolve, reject) => {
      const tlsSocket = tls.connect({ socket: raw, servername: sniName(this.cfg.host), rejectUnauthorized: !this.cfg.tlsInsecure });
      const timer = setTimeout(() => { tlsSocket.destroy(); reject(new EmailError("TIMEOUT", "TLS handshake timed out", { stage: "starttls" })); }, this.cfg.timeoutMs);
      tlsSocket.once("secureConnect", () => { clearTimeout(timer); resolve(tlsSocket); });
      tlsSocket.once("error", (e) => { clearTimeout(timer); reject(new EmailError("STARTTLS_FAILED", `TLS handshake failed: ${e.message}`, { stage: "starttls" })); });
    });
    this.socket = upgraded;
    this.secure = true;
  }

  _parseCaps(lines) {
    this.caps = new Set();
    this.authMechanisms = [];
    for (const line of lines) {
      const rest = line.slice(4);
      const kw = rest.split(/\s+/)[0]?.toUpperCase();
      if (kw) this.caps.add(kw);
      if (kw === "AUTH" || kw.startsWith("AUTH=")) {
        // e.g. "250-AUTH PLAIN LOGIN XOAUTH2" or the legacy "250-AUTH=PLAIN LOGIN"
        this.authMechanisms = rest.replace(/^AUTH=?/i, "").trim().toUpperCase().split(/\s+/).filter(Boolean);
      }
    }
  }

  async _ehlo() {
    let ehloName = os.hostname() || "[127.0.0.1]";
    if (!/^[A-Za-z0-9.\-]+$/.test(ehloName)) ehloName = "[127.0.0.1]";
    const r = await this._command("ehlo", `EHLO ${ehloName}`, expectOf.ehlo);
    this._parseCaps(r.lines);
    return r;
  }

  async _auth() {
    const user = this.cfg.user, pass = this.cfg.pass;
    if (!user || !pass) return null; // relay allows unauthenticated sending
    const mechs = this.authMechanisms || [];
    const tryPlain = async () => {
      await this._command("auth", "AUTH PLAIN " + Buffer.from(`\0${user}\0${pass}`).toString("base64"), expectOf.auth);
      return "PLAIN";
    };
    const tryLogin = async () => {
      await this._command("auth", "AUTH LOGIN", [334, 235]);
      await this._command("auth", Buffer.from(user).toString("base64"), [334, 235]);
      await this._command("auth", Buffer.from(pass).toString("base64"), expectOf.auth);
      return "LOGIN";
    };
    const advertised = mechs.length > 0;
    if (advertised && mechs.includes("PLAIN")) {
      try { return await tryPlain(); }
      catch (e) {
        if (e.code !== "AUTH_FAILED" || !mechs.includes("LOGIN")) throw e;
      }
    }
    if (advertised && !mechs.includes("PLAIN") && !mechs.includes("LOGIN")) {
      // capability names only — unknown mechanism, still attempt PLAIN then LOGIN
      try { return await tryPlain(); } catch (e) {
        if (e.code !== "AUTH_FAILED") throw e;
      }
    }
    return await tryLogin(); // LOGIN advertised, or nothing advertised (try it)
  }

  async send(message) {
    await this._connect();
    try {
      await this._command("greeting", null, expectOf.greeting);
      await this._ehlo();
      if (!this.secure && this.caps.has("STARTTLS")) {
        await this._command("starttls", "STARTTLS", expectOf.starttls);
        await this._upgradeTls();
        await this._ehlo(); // capability list restarts inside TLS
      }
      const authMethod = await this._auth();
      await this._command("mailFrom", `MAIL FROM:<${extractAddress(this.cfg.from)}>`, expectOf.mailFrom);
      for (const rcpt of message.to) {
        await this._command("rcptTo", `RCPT TO:<${extractAddress(rcpt)}>`, expectOf.rcptTo);
      }
      await this._command("data", "DATA", expectOf.data);
      const stuffed = dotStuff(message.payload);
      await this._write(stuffed + ".\r\n", Date.now() + this.cfg.timeoutMs);
      const done = await this._command("dot", null, expectOf.dot);
      try { await this._command("quit", "QUIT", expectOf.quit); } catch { /* best effort */ }
      return { response: done.lines.join("\n"), authMethod };
    } finally {
      try { this.socket?.destroy(); } catch {}
      this.socket = null;
    }
  }
}

// AUTH capability handling lives in _parseCaps (this.authMechanisms) and _auth;
// no prototype patching — the client reads the real EHLO reply it received.

// ---------------------------------------------------------------------------
// nodemailer fast path — used only when the optional dependency is installed
// ---------------------------------------------------------------------------

let _nodemailer; // undefined = not probed yet, null = not installed
async function loadNodemailer() {
  if (_nodemailer !== undefined) return _nodemailer;
  try { _nodemailer = await import("nodemailer"); } catch { _nodemailer = null; }
  return _nodemailer;
}

async function sendViaNodemailer(nodemailer, cfg, message, toList) {
  const transport = nodemailer.createTransport({
    host: cfg.host,
    port: cfg.port,
    secure: cfg.secure,
    auth: cfg.user && cfg.pass ? { user: cfg.user, pass: cfg.pass } : undefined,
    connectionTimeout: cfg.timeoutMs,
    greetingTimeout: cfg.timeoutMs,
    socketTimeout: cfg.timeoutMs,
    tls: { rejectUnauthorized: !cfg.tlsInsecure },
  });
  const info = await transport.sendMail({
    from: cfg.from,
    to: toList,
    subject: message.subject,
    text: message.text || undefined,
    html: message.html || undefined,
  });
  return { response: info.response || "accepted", messageId: info.messageId || message.messageId, transport: "nodemailer" };
}

// ---------------------------------------------------------------------------
// public API — sendEmail + receipts ring + notification bus emissions
// ---------------------------------------------------------------------------

const RECEIPTS_CAP = 200;
const receipts = [];

export function listRecentReceipts(limit = 50) {
  return receipts.slice(0, Math.max(0, Math.min(limit, receipts.length)));
}

// Best-effort write into the notification service's append-only delivery log
// (notification-delivery.js task 4.2.16 reads it back via listDeliveries).
// status/detail are constrained by that table's CHECKs; nothing here can break
// a send — a DB outage degrades to the bus + in-memory ring only.
async function persistReceiptToNotificationLog(receipt, userId) {
  if (receipt.errorCode === "EMAIL_NOT_CONFIGURED") return; // nothing was sent — nothing to log
  try {
    await dbQuery(
      `INSERT INTO notification_deliveries (user_id, event, channel, status, recipient, subject, detail)
       VALUES ($1, $2, 'email', $3, $4, $5, $6)`,
      [
        userId || null,
        "email.custom",
        receipt.ok ? "sent" : "failed",
        Array.isArray(receipt.to) ? receipt.to.join(", ") : (receipt.to || null),
        receipt.subject || null,
        JSON.stringify({
          receiptId: receipt.receiptId,
          messageId: receipt.messageId ?? null,
          from: receipt.from ?? null,
          response: receipt.response ?? null,
          transport: receipt.transport ?? null,
          stage: receipt.stage ?? null,
          durationMs: receipt.durationMs ?? null,
          errorCode: receipt.errorCode ?? null,
          error: receipt.error ?? null,
        }),
      ],
    );
  } catch { /* best-effort — see header */ }
}

function recordReceipt(receipt, delivered, userId = null) {
  receipts.unshift(receipt);
  if (receipts.length > RECEIPTS_CAP) receipts.length = RECEIPTS_CAP;
  persistReceiptToNotificationLog(receipt, userId); // async, never awaited by the send path
  // events.js emit() already wraps payloads as {type, data, t, job} — pass the
  // receipt itself, so bus listeners (and the WS bridge) read e.data.receiptId.
  bus.emit(delivered ? "email:delivered" : "email:failed", receipt);
  bus.emit("log", {
    level: delivered ? "info" : "warn",
    msg: `[email] ${delivered ? "delivered" : "FAILED"} to ${receipt.to} (${receipt.durationMs}ms, ${receipt.transport})` +
      (delivered ? ` — ${String(receipt.response || "").slice(0, 120)}` : ` — ${receipt.errorCode}: ${String(receipt.error || "").slice(0, 160)}`),
  });
}

/**
 * Send a REAL email through the SMTP server from env (or cfgOverride).
 * @param {{to: string|string[], subject: string, text?: string, html?: string}} message
 * @param {object|null} cfgOverride full SMTP config (host/port/from/user/pass/secure/...);
 *        when null the env is the source of truth (product default).
 * @param {{userId?: string|null}} opts when userId is known (router callers pass
 *        req.userId) the delivery receipt is attributed in the notification
 *        service's per-user delivery history.
 * @returns receipt { ok, receiptId, to, from, subject, messageId, response, transport, durationMs, ts }
 */
export async function sendEmail(message, cfgOverride = null, opts = {}) {
  const userId = opts.userId || null;
  const started = Date.now();
  const cfgInfo = cfgOverride ? { ok: true, config: cfgOverride, missing: [] } : smtpConfigFromEnv();
  if (!cfgInfo.ok) {
    const err = new EmailError("EMAIL_NOT_CONFIGURED",
      `SMTP is not configured — set ${cfgInfo.missing.join(", ")} in the environment (see .env.example). No email was sent.`,
      { stage: "config" });
    const receipt = { ok: false, receiptId: crypto.randomUUID(), to: message?.to ?? null, from: null, subject: message?.subject ?? null, messageId: null, response: null, transport: "none", durationMs: 0, ts: new Date().toISOString(), errorCode: err.code, error: err.message };
    recordReceipt(receipt, false);
    throw err;
  }
  const cfg = cfgInfo.config;
  try {
    const toList = (Array.isArray(message.to) ? message.to : [message.to]).map(String);
    if (toList.length === 0) throw new EmailError("INVALID_MESSAGE", "message needs at least one recipient", { stage: "message" });
    const { payload, messageId } = buildMessage({ from: cfg.from, to: toList, subject: message.subject, text: message.text, html: message.html });
    let result;
    const nodemailer = await loadNodemailer();
    if (nodemailer) {
      result = await sendViaNodemailer(nodemailer, cfg, message, toList);
    } else {
      const client = new RawSmtpClient(cfg);
      const r = await client.send({ payload, to: toList, subject: message.subject });
      result = { response: r.response, messageId, transport: "raw-smtp", authMethod: r.authMethod };
    }
    const receipt = {
      ok: true,
      receiptId: crypto.randomUUID(),
      to: toList,
      from: cfg.from,
      subject: String(message.subject || ""),
      messageId: result.messageId,
      response: result.response,
      transport: result.transport,
      authMethod: result.authMethod || (cfg.user ? "provided" : "none"),
      durationMs: Date.now() - started,
      ts: new Date().toISOString(),
    };
    recordReceipt(receipt, true, userId);
    return receipt;
  } catch (e) {
    const err = e instanceof EmailError ? e : new EmailError("SMTP_ERROR", String(e?.message || e), { stage: "send" });
    const receipt = {
      ok: false,
      receiptId: crypto.randomUUID(),
      to: Array.isArray(message?.to) ? message.to : (message?.to ? [String(message.to)] : []),
      from: cfg.from || null,
      subject: String(message?.subject || ""),
      messageId: null,
      response: err.response || null,
      stage: err.stage,
      transport: "raw-smtp",
      durationMs: Date.now() - started,
      ts: new Date().toISOString(),
      errorCode: err.code,
      error: err.message,
    };
    recordReceipt(receipt, false, userId);
    throw err;
  }
}

// ---------------------------------------------------------------------------
// router — mounted by the integrator (mount line at the top of this file)
// ---------------------------------------------------------------------------

export function createEmailRouter({ authRequired = defaultAuthRequired } = {}) {
  const router = express.Router();
  const wrap = (fn) => (req, res) => {
    fn(req, res).catch((e) => {
      const status = e instanceof EmailError ? httpStatusFor(e.code) : 500;
      res.status(status).json({
        error: String(e?.message || "internal error").slice(0, 300),
        code: e?.code || "INTERNAL",
        stage: e?.stage || null,
      });
    });
  };

  router.post("/send", authRequired, wrap(async (req, res) => {
    const { to, subject, text, html } = req.body || {};
    if (!to) return res.status(400).json({ error: "field 'to' is required", code: "INVALID_MESSAGE" });
    if (!subject) return res.status(400).json({ error: "field 'subject' is required", code: "INVALID_MESSAGE" });
    if (!text && !html) return res.status(400).json({ error: "provide 'text' and/or 'html' body", code: "INVALID_MESSAGE" });
    const receipt = await sendEmail({ to, subject, text, html }, null, { userId: req.userId || null });
    res.status(200).json({ ok: true, receipt });
  }));

  router.get("/receipts", authRequired, wrap(async (_req, res) => {
    res.json({ ok: true, receipts: listRecentReceipts(100) });
  }));

  return router;
}
