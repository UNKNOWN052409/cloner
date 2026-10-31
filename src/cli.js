// CLI: url | image | video modes + always-on live dashboard.
import path from "node:path";
import fs from "node:fs";
import { spawn } from "node:child_process";
import { loadConfig } from "./config.js";
import { bus } from "./events.js";
import { startServer } from "./server.js";
import { cloneUrl } from "./cloneUrl.js";
import { cloneImage } from "./cloneImage.js";
import { cloneVideo } from "./cloneVideo.js";

function usage() {
  console.log(`
  cloner — universal frontend cloner

  USAGE
    cloner <url> [options]            clone a site (logs in with cookies if given)
    cloner image <file.png>           screenshot → code (Stitch-style)
    cloner video <file.mp4>           demo video → understand UI + narration → clone
    cloner serve                      dashboard only

  OPTIONS
    -c, --cookies <file>              cookies: JSON array or Netscape .txt export
    -s, --storage <file>              {ls:{}, ss:{}} localStorage/sessionStorage export (SPA logins)
        --seed <url,url,…>            extra same-site pages to clone (SPA routes without <a> links)
    -o, --out <dir>                   output dir (default: output/<run>)
    -p, --pages <n>                   max tabs to clone (default 5)
    -m, --model <provider[[:/]model]> anthropic | openai | custom | none
                                      e.g. --model openai, --model custom:glm-4v (needs cloner.config.json baseUrl)
        --no-polish                   skip vision polish pass
        --no-interactions             don't record/replay click interactions (dialogs, menus)
        --fast                        speed mode: skip polish, tighter waits (~3 min full clone)
        --headed                      run the capture browser with a visible window (bypasses many bot checks)
        --no-ui                       don't open the live dashboard
        --port <n>                    dashboard port (default 4173)
    -h, --help
  `);
}

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "-c" || a === "--cookies") args.cookies = argv[++i];
    else if (a === "-s" || a === "--storage") args.storage = argv[++i];
    else if (a === "--seed") args.seeds = String(argv[++i]).split(",").map((s) => s.trim()).filter(Boolean);
    else if (a === "-o" || a === "--out") args.out = argv[++i];
    else if (a === "-p" || a === "--pages") args.pages = parseInt(argv[++i], 10);
    else if (a === "-m" || a === "--model") args.model = argv[++i];
    else if (a === "--no-polish") args.noPolish = true;
    else if (a === "--no-interactions") args.noInteractions = true;
    else if (a === "--fast") args.fast = true;
    else if (a === "--headed") args.headed = true;
    else if (a === "--no-ui") args.noUi = true;
    else if (a === "--port") args.port = parseInt(argv[++i], 10);
    else if (a === "-h" || a === "--help") args.help = true;
    else if (a === "serve") args.serveOnly = true;
    else args._.push(a);
  }
  return args;
}

export async function main(argv) {
  const args = parseArgs(argv);
  if (args.help || (!args._.length && !args.serveOnly)) {
    usage();
    if (args.help || !args.serveOnly) return;
  }

  // ---- model override ----
  const overrides = {};
  if (args.model) {
    const [provider, model] = args.model.split(/[:/](?=[a-z0-9])/i);
    overrides.model = { provider };
    if (model) overrides.model.model = model;
  }
  if (args.noPolish) overrides.polish = { enabled: false };
  if (args.fast) overrides.polish = { enabled: false };
  if (args.fast) overrides.crawl = { networkIdleMs: 3500, spaWaitMs: 12000 };
  if (args.pages) overrides.crawl = { ...(overrides.crawl || {}), maxPages: args.pages };
  const cfg = loadConfig(overrides);

  // ---- console mirror of live steps (each line stamped with elapsed seconds) ----
  const T0 = Date.now();
  const at = () => `+${((Date.now() - T0) / 1000).toFixed(1)}s`;
  const ICONS = { start: "◔", done: "✔", skip: "—", warn: "▲", running: "◔" };
  for (const evt of ["step", "log", "tabs:found", "run:done", "run:error"]) {
    bus.on(evt, ({ type, data }) => {
      if (type === "step") console.log(`  [${at()}] ${ICONS[data.status] || "•"} ${data.msg || data.id}`);
      else if (type === "log") console.log(`  [${at()}]   ${data.level === "warn" ? "▲" : "·"} ${data.msg}`);
      else if (type === "tabs:found") console.log(`  [${at()}]   tabs: ${data.tabs.length}`);
    });
  }

  // ---- dashboard ----
  const outputsRoot = path.join(process.cwd(), "output");
  fs.mkdirSync(outputsRoot, { recursive: true });
  let dash = null;
  if (!args.noUi) {
    dash = await startServer({ port: args.port || cfg.server.port, outputsRoot });
    const url = `http://localhost:${dash.port}`;
    console.log(`  ◉ dashboard: ${url}`);
    if (cfg.server.open && !args.serveOnly) {
      try { spawn("cmd", ["/c", "start", "", url], { detached: true, stdio: "ignore" }).unref(); } catch {}
    }
  }

  if (args.serveOnly) {
    console.log("  dashboard running — Ctrl+C to stop");
    return;
  }

  // ---- run ----
  const mode = /^https?:\/\//i.test(args._[0]) ? "url" : args._[0];
  const source = mode === "url" ? args._[0] : args._[1];
  if (!source) { usage(); return; }

  const slug =
    mode === "url"
      ? safeSlug(new URL(source).hostname) + "-" + stamp()
      : safeSlug(path.basename(source, path.extname(source))) + "-" + stamp();
  const outDir = args.out ? path.resolve(args.out) : path.join(outputsRoot, slug);

  bus.runMeta = { mode, source, outDir, runId: path.basename(outDir) };
  console.log(`\n  cloner — mode: ${mode}  →  ${outDir}\n`);

  const t0 = Date.now();
  try {
    if (mode === "url") {
      const storage = args.storage && fs.existsSync(args.storage) ? JSON.parse(fs.readFileSync(args.storage, "utf8")) : undefined;
      if (args.fast) overrides.polish = { enabled: false };
      const interactionOpts = args.noInteractions
        ? false
        : args.fast
          ? { waitMs: 800, max: 16, triggerMax: 60, budgetMs: 60000 }
          : { waitMs: 800, max: 56, triggerMax: 140, budgetMs: 170000 }; // deep exploration, budget-bounded
      await cloneUrl(source, cfg, outDir, { cookies: args.cookies, storage, seeds: args.seeds, headless: !args.headed, interactions: interactionOpts });
    } else if (mode === "image") {
      await cloneImage(path.resolve(source), cfg, outDir, {});
    } else if (mode === "video") {
      await cloneVideo(path.resolve(source), cfg, outDir, {});
    } else {
      usage();
      return;
    }
    const secs = ((Date.now() - t0) / 1000).toFixed(1);
    console.log(`\n  ✔ done in ${secs}s — open dashboard: http://localhost:${dash?.port || cfg.server.port}`);
    if (dash) console.log("    (server stays alive — Ctrl+C to exit)");
    else process.exit(0);
  } catch (e) {
    bus.emit("run:error", { error: e.message });
    console.error(`\n  ✖ ${e.message}`);
    if (dash) console.error("    (dashboard still running — Ctrl+C to exit)");
    else throw e;
  }
}

function safeSlug(s) {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "clone";
}
function stamp() {
  const d = new Date();
  return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}-${String(d.getHours()).padStart(2, "0")}${String(d.getMinutes()).padStart(2, "0")}${String(d.getSeconds()).padStart(2, "0")}`;
}
