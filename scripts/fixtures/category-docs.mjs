// Category fixture — documentation site (task 3.5.1).
//
// 7 routes joined by a <header> band + persistent docs sidebar:
//   "/"         docs landing     — card grid of guide tiles
//   "/guides"   guide index      — sidebar + article listing table
//   "/install"  installation     — sidebar + long-form article body
//   "/config"   configuration    — sidebar + article + backend table
//   "/deploy"   deployment       — sidebar + article + code block
//   "/api"      API reference    — sidebar + reference table
//   "/cli"      CLI reference    — sidebar + command table
//
// The sidebar is a real <aside> with a nav of many links on every docs page —
// the canonical docs-side evidence pattern (aside + side-region geometry). No
// credentials, no external hosts, zero deps.
import { sendHtml, reqUrl } from "./server.mjs";

const CSS = `
body{font-family:Georgia,'Times New Roman',serif;margin:0;color:#232936;background:#fbfbf9}
.docs-header{background:#20313f;color:#fff;padding:14px 28px;display:flex;justify-content:space-between;align-items:center}
.docs-header .brand{font-size:19px;font-weight:bold;letter-spacing:.4px}
.docs-header a{color:#bcd2e8;font-size:14px;text-decoration:none}
.docs-layout{display:flex;min-height:520px;max-width:1100px;margin:0 auto}
.docs-sidebar{width:230px;flex-shrink:0;background:#eef1ee;border-right:1px solid #d4d9d2;padding:18px 14px}
.docs-sidebar h2{font-size:13px;text-transform:uppercase;color:#5c6a60;margin:0 0 10px}
.docs-sidebar nav a{display:block;color:#2c4a33;font-size:14px;padding:5px 8px;text-decoration:none;border-radius:4px}
.docs-sidebar nav a:hover{background:#dde5da}
.docs-content{flex-grow:1;padding:26px 34px;max-width:760px}
.docs-content h1{font-size:27px;margin:0 0 14px}
.docs-content h2{font-size:20px;margin-top:24px}
.docs-content p{line-height:1.65;font-size:15px}
.docs-content code{background:#e7ebe6;padding:2px 5px;border-radius:3px;font-size:13px;font-family:Consolas,monospace}
.docs-content pre{background:#26312b;color:#d9e6dc;padding:14px;border-radius:6px;font-size:13px;overflow:auto}
.docs-content table{border-collapse:collapse;margin-top:12px;background:#fff}
.docs-content table td,.docs-content table th{border:1px solid #c4cbc2;padding:7px 13px;font-size:14px}
.guide-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:14px;margin-top:18px}
.guide-tile{background:#fff;border:1px solid #d9ddd4;border-radius:8px;padding:14px}
.guide-tile h3{font-size:15px;margin:0 0 6px}
.guide-tile p{font-size:13px;margin:0;color:#5a655c}
.docs-footer{border-top:1px solid #d4d9d2;color:#6b7568;font-size:13px;padding:14px 28px;text-align:center}
`;

const SIDEBAR = `<aside class="docs-sidebar" aria-label="Documentation navigation">
<h2>Documentation</h2>
<nav>
  <a href="/">Overview</a>
  <a href="/guides">Guides</a>
  <a href="/install">Installation</a>
  <a href="/config">Configuration</a>
  <a href="/deploy">Deployment</a>
  <a href="/api">API reference</a>
  <a href="/cli">CLI reference</a>
</nav>
</aside>`;

function docsShell(title, body) {
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><title>${title}</title>
<style>${CSS}</style></head><body>
<header class="docs-header"><div class="brand">Marshlight Docs</div><a href="/api">API</a></header>
<div class="docs-layout">
${SIDEBAR}
<article class="docs-content">
${body}
</article>
</div>
<footer class="docs-footer">Marshlight v2.4 documentation · last updated March 2026</footer>
</body></html>`;
}

const GUIDE_TILES = ["Getting started", "Local development", "Environment variables", "Static assets", "Middleware", "Error handling"]
  .map((t, n) => `<div class="guide-tile"><h3>${t}</h3><p>Chapter ${n + 1} — the short path from zero to a running Marshlight app.</p></div>`)
  .join("\n");

const PAGES = {
  "/": docsShell(
    "Marshlight Docs — Overview",
    `<h1>Marshlight documentation</h1>
<p>Marshlight is a lightweight framework for building document pipelines. Start with the guide tiles below, then dive into the reference tables.</p>
<div class="guide-grid">
${GUIDE_TILES}
</div>`,
  ),
  "/guides": docsShell(
    "Guides — Marshlight Docs",
    `<h1>Guides</h1>
<p>Task-oriented walkthroughs, ordered the way most teams adopt them.</p>
<table><tr><th>Guide</th><th>Reading time</th><th>Level</th></tr>
<tr><td><a href="/install">Installation</a></td><td>6 min</td><td>beginner</td></tr>
<tr><td><a href="/config">Configuration</a></td><td>9 min</td><td>intermediate</td></tr>
<tr><td><a href="/deploy">Deployment</a></td><td>12 min</td><td>advanced</td></tr>
</table>`,
  ),
  "/install": docsShell(
    "Installation — Marshlight Docs",
    `<h1>Installation</h1>
<p>Marshlight ships as a single package. Install it with your usual package manager, then run the init command to scaffold a project.</p>
<pre><code>npm install marshlight
npx marshlight init my-pipeline</code></pre>
<h2>Requirements</h2>
<p>Node 20 or newer. The pipeline worker needs roughly 300&nbsp;MB of memory per document job, and the CLI expects write access to the project directory.</p>
<h2>Next steps</h2>
<p>Move on to <a href="/config">configuration</a> to wire in your storage backend, or read the deployment guide when you are ready to publish.</p>`,
  ),
  "/config": docsShell(
    "Configuration — Marshlight Docs",
    `<h1>Configuration</h1>
<p>Every Marshlight project reads a single config file, <code>marshlight.config.js</code>. Defaults are sensible for local files; most teams override the storage backend first.</p>
<h2>Storage backends</h2>
<table><tr><th>Backend</th><th>Use case</th><th>Setup</th></tr>
<tr><td>local-fs</td><td>single machine</td><td>none</td></tr>
<tr><td>s3-compatible</td><td>team archives</td><td>endpoint + bucket</td></tr>
<tr><td>ssh-remote</td><td>staging servers</td><td>host + key path</td></tr>
</table>
<h2>Worker options</h2>
<p>The <code>workers</code> option caps parallel document jobs; the default of 2 keeps memory use predictable. See <a href="/deploy">deployment</a> for production sizing.</p>`,
  ),
  "/deploy": docsShell(
    "Deployment — Marshlight Docs",
    `<h1>Deployment</h1>
<p>A Marshlight deployment is a long-running worker plus a static dashboard. The worker consumes the queue; the dashboard reports run status.</p>
<h2>Container image</h2>
<pre><code>FROM node:22-alpine
RUN npm i -g marshlight
CMD ["marshlight", "worker"]</code></pre>
<h2>Health checks</h2>
<p>Expose <code>/healthz</code> on the worker; it returns 200 once the storage backend answers a round trip. Deployment guides for each backend live in the reference section.</p>`,
  ),
  "/api": docsShell(
    "API reference — Marshlight Docs",
    `<h1>API reference</h1>
<p>The programmatic surface is small: four calls cover the full document lifecycle.</p>
<table><tr><th>Call</th><th>Arguments</th><th>Returns</th></tr>
<tr><td>pipeline.create</td><td>name, options</td><td>Pipeline</td></tr>
<tr><td>pipeline.run</td><td>document</td><td>RunResult</td></tr>
<tr><td>pipeline.status</td><td>runId</td><td>Status</td></tr>
<tr><td>pipeline.cancel</td><td>runId</td><td>boolean</td></tr>
</table>
<p>All calls are asynchronous and accept an abort signal. See the CLI reference for the command-line equivalents.</p>`,
  ),
  "/cli": docsShell(
    "CLI reference — Marshlight Docs",
    `<h1>CLI reference</h1>
<p>The <code>marshlight</code> command mirrors the API surface one-to-one.</p>
<table><tr><th>Command</th><th>Flags</th><th>Effect</th></tr>
<tr><td>marshlight init</td><td>name</td><td>scaffold a project</td></tr>
<tr><td>marshlight run</td><td>--watch</td><td>run the pipeline once</td></tr>
<tr><td>marshlight worker</td><td>--concurrency</td><td>start a queue worker</td></tr>
</table>
<p>Every command accepts <code>--config</code> to point at a non-default configuration file.</p>`,
  ),
};

export const docsCategorySite = {
  name: "category-docs",
  category: "documentation",
  entry: "/",
  handle(req, res) {
    const p = PAGES[reqUrl(req).pathname];
    if (p) {
      sendHtml(res, p);
      return;
    }
    res.writeHead(404, { "content-type": "text/plain" });
    res.end("category-docs fixture: not found");
  },
};
