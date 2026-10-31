// Page + project generation (spec §10): renders the component tree into clean,
// editable HTML with captured layout/styles in real CSS files, wires recorded
// interactions, maps assets, and preserves geometry — all verified on output.
import fs from "node:fs";
import path from "node:path";
import { buildRuntime } from "../../runtimeTemplate.js";

const SELF_CLOSE = new Set(["img", "br", "hr", "input", "meta", "link"]);

function esc(s) {
  return String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

// build per-element CSS rules (components.css) + collect geometry evidence
export function buildComponentCss(elements, layoutByIndex) {
  const rules = [];
  for (const el of elements) {
    const i = el.i;
    const st = el.style || {};
    const lay = layoutByIndex.get(i);
    const rect = el.rect || el.getBoundingClientRect?.() || null;
    const props = [];
    if (lay) {
      props.push(`display:${lay.kind === "flex" ? "flex" : lay.kind === "grid" ? "grid" : lay.display || "block"}`);
      if (lay.kind === "flex" && lay.flexDirection) props.push(`flex-direction:${lay.flexDirection}`);
      if (lay.gridTemplateColumns) props.push(`grid-template-columns:${lay.gridTemplateColumns}`);
      if (lay.gapPx) props.push(`gap:${lay.gapPx}px`);
      if (lay.justifyContent) props.push(`justify-content:${lay.justifyContent}`);
      if (lay.alignItems) props.push(`align-items:${lay.alignItems}`);
    }
    if (st.display && !lay) props.push(`display:${st.display}`);
    if (st.position && st.position !== "static") props.push(`position:${st.position}`);
    if (st.padding && st.padding !== "0px") props.push(`padding:${st.padding}`);
    if (st.margin && st.margin !== "0px") props.push(`margin:${st.margin}`);
    if (st.backgroundColor && st.backgroundColor !== "rgba(0, 0, 0, 0)") props.push(`background:${st.backgroundColor}`);
    if (st.color) props.push(`color:${st.color}`);
    if (st.fontFamily) props.push(`font-family:${st.fontFamily}`);
    if (st.fontSize) props.push(`font-size:${st.fontSize}`);
    if (st.fontWeight && st.fontWeight !== "400") props.push(`font-weight:${st.fontWeight}`);
    if (st.lineHeight && st.lineHeight !== "normal") props.push(`line-height:${st.lineHeight}`);
    if (st.border && !st.border.startsWith("0px")) props.push(`border:${st.border}`);
    if (st.borderRadius && st.borderRadius !== "0px") props.push(`border-radius:${st.borderRadius}`);
    if (st.opacity && st.opacity !== "1") props.push(`opacity:${st.opacity}`);
    if (st.overflow && st.overflow !== "visible") props.push(`overflow:${st.overflow}`);
    if (st.zIndex && st.zIndex !== "auto") props.push(`z-index:${st.zIndex}`);
    if (rect && rect.w > 2 && rect.h > 2) {
      if (rect.w) props.push(`width:${rect.w}px`);
      if (rect.h) props.push(`height:${rect.h}px`);
    }
    if (props.length) rules.push(`.cx-${i} { ${props.join("; ")}; }`);
  }
  return rules.join("\n");
}

function renderNode(node, cssCtx, depth) {
  if (!node || depth > 14) return "";
  const tag = /^(h[1-6]|p|nav|header|footer|main|section|aside|ul|ol|li|form|table|button|a|img|canvas|input|select|label|span|div|article|figure)$/.test(node.tag) ? node.tag : "div";
  const cls = `cx-${node._elementIndex ?? "x"}${node.cls ? " " + esc(node.cls.split(/\s+/)[0]) : ""}`;
  let attrs = `class="${cls}"`;
  if (node.role) attrs += ` role="${esc(node.role)}"`;
  if (node.ariaName) attrs += ` aria-label="${esc(node.ariaName)}"`;
  if (node.tag === "a") {
    let href = node.href || "#";
    if (cssCtx.routeFileMap && cssCtx.routeFileMap.has(new URL(href, "http://x").pathname)) {
      href = cssCtx.routeFileMap.get(new URL(href, "http://x").pathname);
    }
    attrs += ` href="${esc(href)}"`;
  }
  if (tag === "img") {
    // captured asset wins (offline-safe); else the original absolute URL
    // (works online); else a visible placeholder
    const local = cssCtx.assetByIndex?.get(node._elementIndex);
    const src = local || node.src || "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='120' height='80'%3E%3Crect width='100%25' height='100%25' fill='%23e5e7eb'/%3E%3Ctext x='50%25' y='54%25' text-anchor='middle' font-size='11' fill='%239ca3af'%3Eimg%3C/text%3E%3C/svg%3E";
    attrs += ` src="${esc(src)}"`;
    if (node.rect && node.rect.w > 2 && node.rect.h > 2) attrs += ` width="${node.rect.w}" height="${node.rect.h}"`;
  }
  if (node.tag === "input" && node.ariaName) attrs += ` placeholder="${esc(node.ariaName)}"`;
  if (node.dataClonerTrigger) attrs += ` data-cloner-trigger="${esc(node.dataClonerTrigger)}"`;
  // interaction wiring: the pipeline's interactionsByIndex maps EVERY captured
  // record resolved to a dom element (page-scoped) → its record id, so every
  // wired element gets data-replay-id — the runtime's second match layer after
  // the capture-time data-cloner-trigger attr. mN picker entries are marked
  // INSIDE captured overlay HTML after the DOM extraction, so they cannot be
  // wired here; their data-cloner-inner attrs are baked into the record html
  // and the runtime also falls back to structural paths for page elements.
  const wire = cssCtx.interactionsByIndex.get(node._elementIndex);
  if (wire) attrs += ` data-replay-id="${esc(wire)}"`;
  const indent = "  ".repeat(depth);
  if (SELF_CLOSE.has(tag)) return `${indent}<${tag} ${attrs} />`;
  const text = node.text ? esc(node.text) : "";
  const kids = (node.children || []).map((c) => renderNode(c, cssCtx, depth + 1)).join("\n");
  if (!kids && text) return `${indent}<${tag} ${attrs}>${text}</${tag}>`;
  return `${indent}<${tag} ${attrs}>\n${kids ? kids + "\n" : ""}${text ? indent + "  " + text + "\n" : ""}${indent}</${tag}>`;
}

export function generatePageHtml(page, componentTree, cssCtx) {
  const body = (componentTree.children || []).map((n) => renderNode(n, cssCtx, 2)).join("\n");
  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>${esc(page.url)}</title>
  <link rel="stylesheet" href="styles/tokens.css">
  <link rel="stylesheet" href="styles/layout.css">
  <link rel="stylesheet" href="styles/components.css">
</head>
<body>
${body}
  <script src="runtime/interactions.js"></script>
</body>
</html>
`;
}

// layout.css: global layout rules from the root containers (body, main, header)
export function buildLayoutCss(elements, layoutByIndex) {
  const lines = ["body { margin: 0; }"];
  for (const el of elements.slice(0, 5)) {
    const lay = layoutByIndex.get(el.i);
    if (!lay || lay.confidence < 0.5) continue;
    lines.push(`body > .cx-${el.i} { display: ${lay.kind === "flex" ? "flex" : lay.kind === "grid" ? "grid" : "block"}; min-height: 100vh; }`);
  }
  return lines.join("\n");
}

export function generateProject({ outDir, pageHtmls, tokensCssText, layoutCss, componentsCss, assetMap, assetRoot, interactionRecords = [] }) {
  const dirs = ["styles", "runtime", "public/assets"];
  for (const d of dirs) fs.mkdirSync(path.join(outDir, d), { recursive: true });
  fs.writeFileSync(path.join(outDir, "package.json"), JSON.stringify({
    name: "reconstructed-site", private: true, version: "0.1.0",
    scripts: { dev: "npx serve . -l 4175" },
  }, null, 2));
  fs.writeFileSync(path.join(outDir, "styles", "tokens.css"), tokensCssText);
  fs.writeFileSync(path.join(outDir, "styles", "layout.css"), layoutCss);
  fs.writeFileSync(path.join(outDir, "styles", "components.css"), componentsCss);
  fs.writeFileSync(path.join(outDir, "runtime", "interactions.js"), buildRuntime(interactionRecords));
  // assets copy with verified source resolution
  let copied = 0, failed = 0;
  for (const [url, localRel] of assetMap || []) {
    const src = path.resolve(assetRoot || artifactsAssetRoot(), localRel);
    if (!fs.existsSync(src)) { failed++; continue; }
    const dest = path.join(outDir, "public", "assets", path.basename(localRel));
    try {
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.copyFileSync(src, dest);
      if (!fs.existsSync(dest) || fs.statSync(dest).size === 0) throw new Error("copy produced empty file");
      copied++;
    } catch (e) {
      failed++;
      console.warn(`asset copy failed: ${localRel} — ${e.message.slice(0, 60)}`);
    }
  }
  // pages — p.file (pipeline-assigned, page-001 → index.html) wins; the route
  // fallback must not double-append .html to routes that already carry it
  const files = [];
  for (const p of pageHtmls) {
    const rel = p.file || (p.route === "/" ? "index.html" : p.route.replace(/^\//, "").replace(/\.html?$/i, "").replace(/[?&#]/g, "_") + ".html");
    const safe = rel.replace(/[^a-zA-Z0-9_./-]/g, "_");
    if (safe.includes("..")) { failed++; continue; }
    fs.writeFileSync(path.join(outDir, safe), p.html);
    const size = fs.statSync(path.join(outDir, safe)).size;
    files.push({ route: p.route, file: safe, size });
  }
  return { copied, failed, files };
}

function artifactsAssetRoot() {
  return path.join(process.cwd(), "artifacts");
}
