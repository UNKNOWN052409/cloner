// Vision-model polish: compare original screenshot vs rendered clone, apply targeted fixes.
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { bus } from "./events.js";
import { renderCloneScreenshot } from "./browser.js";
import { VisionClient, imagePart } from "./vision.js";
import { POLISH_SYSTEM, POLISH } from "./prompts.js";

// Downscale a screenshot for the vision model (full-page shots are huge and slow models down).
function shrinkForModel(src) {
  const out = src.replace(/\.png$/, ".model.jpg");
  try {
    execFileSync("ffmpeg", ["-y", "-i", src, "-vf", "scale=w=900:h=1400:force_original_aspect_ratio=decrease", "-q:v", "7", out], { stdio: "ignore", timeout: 30000 });
    return fs.existsSync(out) ? out : src;
  } catch {
    return src;
  }
}

export async function runPolish(browser, cfg, outDir, pageMeta, viewport) {
  const client = new VisionClient(cfg);
  const shotPath = path.join(outDir, "_reference", "page-1.png");
  const fixesCss = path.join(outDir, "clone-fixes.css");
  if (!fs.existsSync(shotPath)) {
    bus.emit("step", { id: "polish", status: "skip", msg: "no reference screenshot" });
    return;
  }
  bus.emit("step", { id: "polish", status: "start", msg: `vision polish (${cfg.model.provider}/${cfg.model.model})` });

  // Wall-clock budget for the whole polish pass (G5.5 human-journey finding:
  // with a dead vision relay the 280s per-call timeout × rounds × configured
  // providers stalled a FINISHED clone for many minutes — the human sees
  // "start vision polish" and nothing else. Polish is best-effort decoration;
  // when the budget runs out the pass degrades to a warn and the clone
  // completes. CLONER_POLISH_BUDGET_MS=0 disables the budget (old behavior).
  const budgetMs = Number(process.env.CLONER_POLISH_BUDGET_MS ?? 120000);
  const deadline = budgetMs > 0 ? Date.now() + budgetMs : Infinity;
  let appliedCss = "";
  try {
    for (let round = 1; round <= (cfg.polish.rounds || 1); round++) {
      if (Date.now() > deadline) {
        bus.emit("step", { id: "polish", status: "skip", msg: `polish budget (${Math.round(budgetMs / 1000)}s) exhausted — skipping remaining round(s)` });
        break;
      }
      const cloneShot = await renderCloneScreenshot(browser, path.join(outDir, pageMeta.file), viewport);
      if (!cloneShot) throw new Error("clone render failed");
      const clonePath = path.join(outDir, "_reference", `clone-r${round}.png`);
      fs.writeFileSync(clonePath, cloneShot);

      const original = await imagePart(shrinkForModel(shotPath));
      const clone = await imagePart(shrinkForModel(clonePath));
      // stream the response: long non-streaming calls die on CF 524 (100s origin timeout)
      let streamed = "";
      const out = await client.chat(
        [
          { role: "system", content: POLISH_SYSTEM },
          {
            role: "user",
            content: [
              original,
              clone,
              { type: "text", text: POLISH(pageMeta.tokens || {}) + (appliedCss ? `\n\nCSS ALREADY APPLIED (do not repeat):\n${appliedCss.slice(0, 4000)}` : "") },
            ],
          },
        ],
        {
          maxTokens: 2500,
          onDelta: (d) => {
            streamed += d;
            if (streamed.length % 800 < d.length) bus.emit("model:progress", { chars: streamed.length });
          },
          // a single hanging call must not outlive the pass budget — bound it
          // to what remains (G5.5: dead relay + 280s per call stalled clones)
          timeoutMs: Math.max(1000, Math.min(280000, deadline - Date.now())),
        },
      );

      const css = extractSection(out, "CSS");
      const htmlFixes = extractSection(out, "HTML");
      let didSomething = false;

      if (css && css.trim().length > 10 && !/^\/\*\s*(no|none)/i.test(css.trim())) {
        appliedCss += "\n" + css;
        fs.writeFileSync(fixesCss, "/* cloner polish pass */\n" + appliedCss);
        ensureCssLink(path.join(outDir, pageMeta.file), "clone-fixes.css");
        didSomething = true;
        bus.emit("polish:round", { round, cssChars: css.length });
      }
      if (htmlFixes) {
        const applied = applyHtmlFixes(path.join(outDir, pageMeta.file), htmlFixes);
        if (applied) {
          didSomething = true;
          bus.emit("polish:round", { round, htmlFixes: applied });
        }
      }
      if (!didSomething) {
        bus.emit("step", { id: "polish", status: "done", msg: `round ${round}: no further fixes suggested` });
        break;
      }
      if (round === (cfg.polish.rounds || 1)) {
        bus.emit("step", { id: "polish", status: "done", msg: `${round} round(s) applied` });
      }
    }
  } catch (e) {
    bus.emit("log", { level: "warn", msg: `polish failed: ${e.message}` });
    bus.emit("step", { id: "polish", status: "warn", msg: e.message.slice(0, 120) });
  }
}

function extractSection(text, name) {
  const m = text.match(new RegExp(`---\\s*${name}\\s*---\\s*\\n?([\\s\\S]*?)(?=\\n---\\s*[A-Z]+\\s*---|$)`, "i"));
  return m ? m[1].trim() : null;
}

function ensureCssLink(htmlPath, cssFile) {
  let html = fs.readFileSync(htmlPath, "utf8");
  if (html.includes(cssFile)) return;
  html = html.replace(/<\/head>/i, `  <link rel="stylesheet" href="${cssFile}">\n</head>`);
  fs.writeFileSync(htmlPath, html);
}

function applyHtmlFixes(htmlPath, jsonText) {
  try {
    const m = jsonText.match(/\[[\s\S]*\]/);
    if (!m) return 0;
    const fixes = JSON.parse(m[0]);
    let html = fs.readFileSync(htmlPath, "utf8");
    let applied = 0;
    for (const f of fixes.slice(0, 20)) {
      if (!f.selector) continue;
      try {
        if (f.action === "remove") {
          const re = buildOuterRe(html, f.selector);
          if (re) { html = html.replace(re, ""); applied++; }
        } else if (f.action === "replace" && f.html) {
          const re = buildOuterRe(html, f.selector);
          if (re) { html = html.replace(re, f.html); applied++; }
        }
      } catch {}
    }
    fs.writeFileSync(htmlPath, html);
    return applied;
  } catch {
    return 0;
  }
}

// crude but practical: locate first occurrence of a tag matching a simple selector (#id, .class, tag)
function buildOuterRe(html, selector) {
  const s = selector.trim();
  let tag = "[a-z0-9]+";
  let id = null;
  let cls = null;
  const idm = s.match(/#([a-zA-Z0-9_-]+)/);
  if (idm) id = idm[1];
  const clm = s.match(/\.([a-zA-Z0-9_-]+)/);
  if (clm) cls = clm[1];
  const tm = s.match(/^([a-zA-Z][a-zA-Z0-9-]*)/);
  if (tm) tag = tm[1];
  const pattern = `<${tag}\\b[^>]*${id ? `id=["']${id}["']` : cls ? `class=["'][^"']*\\b${cls}\\b[^"']*["']` : ""}[^>]*>([\\s\\S]*?)</${tag}>`;
  const re = new RegExp(pattern, "i");
  return re.test(html) ? re : null;
}
