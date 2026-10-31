// Live dashboard: progress feed, run browser, side-by-side compare, element-picker edit chat.
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import express from "express";
import { WebSocketServer } from "ws";
import { fileURLToPath } from "node:url";
import { bus } from "./events.js";
import { loadConfig } from "./config.js";
import { VisionClient, hasVision } from "./vision.js";
import { EDIT_SYSTEM, EDIT_ELEMENT } from "./prompts.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PICKER_JS = fs.readFileSync(path.join(__dirname, "picker.js"), "utf8");

export function startServer({ port = 4173, outputsRoot }) {
  const app = express();
  app.use(express.json({ limit: "2mb" }));
  // never cache the dashboard itself — UI iterations should show up on plain refresh
  app.use((req, res, next) => {
    if (req.path === "/" || req.path.startsWith("/static") || req.path.startsWith("/preview")) {
      res.set("cache-control", "no-cache, no-store, must-revalidate");
    }
    next();
  });

  app.get("/", (_req, res) => res.sendFile(path.join(__dirname, "..", "dashboard", "index.html")));
  app.use("/static", express.static(path.join(__dirname, "..", "dashboard")));

  // list runs
  app.get("/api/runs", (_req, res) => {
    const runs = [];
    try {
      for (const d of fs.readdirSync(outputsRoot)) {
        const metaFile = path.join(outputsRoot, d, "clone.json");
        if (fs.existsSync(metaFile)) {
          try {
            const meta = JSON.parse(fs.readFileSync(metaFile, "utf8"));
            runs.push({ id: d, ...meta });
          } catch {}
        }
      }
    } catch {}
    runs.sort((a, b) => (b.generatedAt || "").localeCompare(a.generatedAt || ""));
    res.json(runs);
  });

  // preview with picker injected
  app.get("/preview/:run/*", (req, res) => {
    const runDir = path.join(outputsRoot, req.params.run);
    let rel = req.params[0] || "index.html";
    let file = path.resolve(runDir, rel);
    if (!file.startsWith(path.resolve(runDir))) return res.status(403).send("forbidden");
    if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      file = path.join(runDir, "index.html");
      if (!fs.existsSync(file)) return res.status(404).send("not found");
    }
    if (file.endsWith(".html")) {
      let html = fs.readFileSync(file, "utf8");
      if (rel === "index.html" || rel.endsWith(".html")) {
        html = html.replace(/<\/body>/i, `<script>${PICKER_JS}</script>`);
      }
      res.type("html").send(html);
    } else {
      res.sendFile(file);
    }
  });
  app.get("/preview/:run", (req, res) => res.redirect(`/preview/${req.params.run}/index.html`));

  // live catch-up for late dashboard joins
  app.get("/api/events", (_req, res) => res.json(bus.catchUp()));

  // edit selected element via model
  app.post("/api/edit", async (req, res) => {
    const { run, file = "index.html", selector, info = {}, instruction } = req.body || {};
    if (!run || !instruction) return res.status(400).json({ error: "run + instruction required" });
    const cfg = loadConfig();
    if (!hasVision(cfg)) return res.status(400).json({ error: "no vision model configured (set OPENAI_API_KEY / ANTHROPIC_API_KEY or cloner.config.json)" });
    const runDir = path.join(outputsRoot, run);
    const target = path.resolve(runDir, file);
    if (!target.startsWith(path.resolve(runDir)) || !fs.existsSync(target)) return res.status(404).json({ error: "file not found" });

    try {
      const client = new VisionClient(cfg);
      const html = fs.readFileSync(target, "utf8");
      if (html.length > 800_000) return res.status(413).json({ error: "file too large for inline edit" });
      bus.emit("edit:start", { run, file, instruction });
      // surgical edit: model returns a small JSON patch (css / html replace / remove) — never a full-file
      // rewrite, which is too slow for large pages and dies on proxy timeouts.
      const out = await client.chat(
        [
          { role: "system", content: EDIT_SYSTEM },
          { role: "user", content: EDIT_ELEMENT({ file, fileContent: html, selector, info, instruction }) },
        ],
        { maxTokens: 4000, timeoutMs: 280000 },
      );
      const patch = extractJson(out);
      if (!patch || typeof patch !== "object") throw new Error("model did not return a valid JSON patch");
      let updated = html;

      if (patch.replaceHtml?.find && patch.replaceHtml?.html) {
        const needle = patch.replaceHtml.find;
        if (!updated.includes(needle)) throw new Error("model's find-snippet not present in file");
        updated = updated.replace(needle, patch.replaceHtml.html);
      }
      if (patch.removeSelector) {
        const re = new RegExp(`<${tagOf(patch.removeSelector)}\\b[^>]*>[\\s\\S]*?</${tagOf(patch.removeSelector)}>`, "i");
        updated = updated.replace(re, "");
      }
      if (patch.css && patch.css.trim()) {
        const cssFile = path.join(runDir, "edit-overrides.css");
        fs.appendFileSync(cssFile, `\n/* ${new Date().toISOString()} — ${instruction.replace(/\*\//g, "")} */\n${patch.css.trim()}\n`);
        if (!updated.includes("edit-overrides.css")) {
          updated = updated.replace(/<\/head>/i, `  <link rel="stylesheet" href="edit-overrides.css">\n</head>`);
        }
      }
      if (updated === html) throw new Error("model returned an empty patch");
      fs.writeFileSync(target, updated);
      bus.emit("edit:done", { run, file, instruction });
      broadcast({ type: "preview:reload", data: { run } });
      res.json({ ok: true, applied: { css: !!patch.css, html: !!patch.replaceHtml, remove: !!patch.removeSelector } });
    } catch (e) {
      bus.emit("edit:fail", { run, error: e.message });
      res.status(500).json({ error: e.message });
    }
  });

  // ask anything about the current clone (chat, no edit)
  app.post("/api/ask", async (req, res) => {
    const { run, question } = req.body || {};
    if (!hasVision(loadConfig())) return res.status(400).json({ error: "no vision model configured" });
    const runDir = path.join(outputsRoot, run);
    const html = fs.readFileSync(path.join(runDir, "index.html"), "utf8").slice(0, 200_000);
    const client = new VisionClient(loadConfig());
    const answer = await client.chat([
      { role: "system", content: "You are a helpful assistant embedded in a cloner dashboard. Answer briefly about the cloned page based on its HTML." },
      { role: "user", content: `HTML:\n\`\`\`\n${html}\n\`\`\`\n\nQuestion: ${question}` },
    ], { maxTokens: 1500 });
    res.json({ answer });
  });

  const server = http.createServer(app);
  const wss = new WebSocketServer({ server, path: "/ws" });
  const sockets = new Set();
  function broadcast(msg) {
    for (const ws of sockets) {
      try { ws.send(JSON.stringify(msg)); } catch {}
    }
  }
  wss.on("connection", (ws) => {
    sockets.add(ws);
    ws.send(JSON.stringify({ type: "catchup", data: bus.catchUp() }));
    ws.on("close", () => sockets.delete(ws));
  });
  for (const evt of ["step", "log", "tabs:found", "assets:start", "assets:progress", "assets:done", "page:goto", "model:progress", "transcript", "brief", "polish:round", "run:done", "edit:start", "edit:done", "edit:fail"]) {
    bus.on(evt, (e) => broadcast(e));
  }

  return new Promise((resolve) => {
    server.listen(port, () => resolve({ server, port, broadcast }));
  });
}

// extract the first JSON object from a model response (tolerates fences/prose)
function extractJson(text) {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1] : text;
  const start = candidate.indexOf("{");
  if (start < 0) return null;
  for (let end = candidate.lastIndexOf("}"); end > start; end = candidate.lastIndexOf("}", end - 1)) {
    try {
      return JSON.parse(candidate.slice(start, end + 1));
    } catch {}
  }
  return null;
}

function tagOf(selector) {
  const m = String(selector).trim().match(/^([a-zA-Z][a-zA-Z0-9-]*)/);
  return m ? m[1] : "[a-z0-9]+";
}
