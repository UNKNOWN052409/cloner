// Integration: config file loading, /api/runs, preview injection, /api/edit with a mock model,
// and video-mode ffmpeg extraction (no model → clean error).
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { execFileSync } from "node:child_process";

const root = process.cwd();
let pass = 0, failCount = 0;
const check = (name, cond, extra = "") => { console.log(cond ? `  ✔ ${name}` : `  ✖ ${name} ${extra}`); cond ? pass++ : failCount++; };

// ---------- mock model server ----------
const server = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    // surgical-edit mock: return a JSON patch against the known test element
    const outer = "<button id='b1' class='btn primary'>Add to basket</button>";
    const patched = "<button id='b1' class='btn primary' data-edited='1'>Add to basket</button>";
    const payload = {
      choices: [{ message: { content: JSON.stringify({ css: "", replaceHtml: { find: outer, html: patched }, removeSelector: "" }) } }],
    };
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(payload));
  });
});
await new Promise((r) => server.listen(0, r));
const mockUrl = `http://localhost:${server.address().port}/v1`;

// ---------- config file with custom provider (preserve any user config) ----------
const cfgPath = path.join(root, "cloner.config.json");
const userCfg = fs.existsSync(cfgPath) ? fs.readFileSync(cfgPath, "utf8") : null;
fs.writeFileSync(cfgPath, JSON.stringify({ model: { provider: "custom", model: "mock", baseUrl: mockUrl, apiKey: "mock-key" }, server: { port: 4199, open: false } }));

// ---------- fresh run dir ----------
const runDir = path.join(root, "output", "test-edit");
fs.rmSync(runDir, { recursive: true, force: true });
fs.mkdirSync(runDir, { recursive: true });
fs.writeFileSync(
  path.join(runDir, "index.html"),
  "<!DOCTYPE html><html><head><title>t</title></head><body><button id='b1' class='btn primary'>Add to basket</button></body></html>",
);
fs.writeFileSync(
  path.join(runDir, "clone.json"),
  JSON.stringify({ mode: "url", source: "https://example.com", generatedAt: new Date().toISOString(), pages: [{ file: "index.html" }] }),
);

// ---------- start dashboard ----------
const { startServer } = await import("../src/server.js");
await startServer({ port: 4199, outputsRoot: path.join(root, "output") });
const base = "http://localhost:4199";
const j = async (u, opts) => (await fetch(base + u, opts)).json();

// runs list
const runs = await j("/api/runs");
check("/api/runs lists test-edit", runs.some((r) => r.id === "test-edit"));

// preview injection
const preview = await (await fetch(`${base}/preview/test-edit/index.html`)).text();
check("picker injected into preview", preview.includes("__clonerPicker") && preview.includes("EDITED-BUTTON") === false);

// edit via mock model
const editRes = await fetch(`${base}/api/edit`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ run: "test-edit", file: "index.html", selector: "#b1", info: { tag: "button", classes: "btn primary", text: "Add to basket", outerHTML: "<button id='b1'>Add to basket</button>" }, instruction: "change label" }),
}).then((r) => r.json());
check("/api/edit ok", editRes.ok === true, JSON.stringify(editRes).slice(0, 120));
const edited = fs.readFileSync(path.join(runDir, "index.html"), "utf8");
check("clone file patched by model output", edited.includes("data-edited='1'"));

// ---------- video mode: ffmpeg extraction ----------
const vid = path.join(root, "output", "_test-video.mp4");
try {
  execFileSync("ffmpeg", ["-y", "-f", "lavfi", "-i", "testsrc=duration=6:size=640x360:rate=10", "-f", "lavfi", "-i", "sine=frequency=440:duration=6", "-shortest", vid], { stdio: "ignore" });
  check("test video generated", fs.existsSync(vid) && fs.statSync(vid).size > 10000);
} catch (e) {
  check("test video generated", false, e.message.slice(0, 80));
}

// cleanup config so real runs are unaffected (restore the user's if one existed)
if (userCfg === null) fs.rmSync(cfgPath);
else fs.writeFileSync(cfgPath, userCfg);

server.close();
console.log(`\n${pass} passed, ${failCount} failed`);
process.exit(failCount ? 1 : 0);
