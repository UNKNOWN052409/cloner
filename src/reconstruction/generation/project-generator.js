// Page + project generation (spec §10): renders the component tree into clean,
// editable HTML with captured layout/styles, wires recorded interactions via the
// replay runtime, copies mapped assets, and emits a Vite-agnostic static build.
import fs from "node:fs";
import { buildRuntime } from "../../runtimeTemplate.js";
import path from "node:path";

const SELF_CLOSE = new Set(["img", "br", "hr", "input", "meta", "link"]);

function esc(s) {
  return String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

// one element → HTML with generated class + captured inline style subset
function renderNode(node, layoutByIndex, styleByIndex, assetMap, interactionsByIndex, depth, routeFileMap) {
  if (!node || depth > 14) return "";
  const tag = /^(h[1-6]|p|nav|header|footer|main|section|aside|ul|ol|li|form|table|button|a|img|canvas|input|select|label|span|div|article|figure)$/.test(node.tag) ? node.tag : "div";
  const cls = `cx-${node._elementIndex ?? "x"}${node.cls ? " " + esc(node.cls.split(/\s+/)[0]) : ""}`;
  const styleBits = [];
  const st = styleByIndex.get(node._elementIndex);
  if (st) {
    if (st.backgroundColor && st.backgroundColor !== "rgba(0, 0, 0, 0)") styleBits.push(`background:${st.backgroundColor}`);
    if (st.color) styleBits.push(`color:${st.color}`);
    if (st.fontFamily) styleBits.push(`font-family:${st.fontFamily}`);
    if (st.fontSize) styleBits.push(`font-size:${st.fontSize}`);
    if (st.fontWeight && st.fontWeight !== "400") styleBits.push(`font-weight:${st.fontWeight}`);
    if (st.padding && st.padding !== "0px") styleBits.push(`padding:${st.padding}`);
    if (st.borderRadius && st.borderRadius !== "0px") styleBits.push(`border-radius:${st.borderRadius}`);
  }
  const lay = layoutByIndex.get(node._elementIndex);
  if (lay) {
    styleBits.push(`display:${lay.kind === "flex" ? "flex" : lay.kind === "grid" ? "grid" : "block"}`);
    if (lay.kind === "flex") styleBits.push(`flex-direction:${lay.flexDirection === "row" || lay.horizontal ? "row" : "column"}`);
    if (lay.gapPx) styleBits.push(`gap:${lay.gapPx}px`);
    if (lay.justifyContent) styleBits.push(`justify-content:${lay.justifyContent}`);
    if (lay.alignItems) styleBits.push(`align-items:${lay.alignItems}`);
  }
  let attrs = `class="${cls}"`;
  if (styleBits.length) attrs += ` style="${esc(styleBits.join(";"))}"`;
  if (node.role) attrs += ` role="${esc(node.role)}"`;
  if (node.ariaName) attrs += ` aria-label="${esc(node.ariaName)}"`;
  if (node.tag === "a") {
    let href = node.href || "#";
    if (routeFileMap && routeFileMap.has(new URL(href, "http://x").pathname)) href = routeFileMap.get(new URL(href, "http://x").pathname);
    attrs += ` href="${esc(href)}"`;
  }
  // asset-mapped images
  if (tag === "img" && node._assetSrc) attrs += ` src="${esc(node._assetSrc)}"`;
  // recorded interactions: replay hook
  const wire = interactionsByIndex.get(node._elementIndex);
  if (wire) attrs += ` data-replay-id="${esc(wire)}"`;
  const indent = "  ".repeat(depth);
  if (SELF_CLOSE.has(tag)) return `${indent}<${tag} ${attrs} />`;
  const text = node.text ? esc(node.text) : "";
  const kids = (node.children || []).map((c) => renderNode(c, layoutByIndex, styleByIndex, assetMap, interactionsByIndex, depth + 1, routeFileMap)).join("\n");
  if (!kids && text) return `${indent}<${tag} ${attrs}>${text}</${tag}>`;
  return `${indent}<${tag} ${attrs}>\n${kids ? kids + "\n" : ""}${text ? indent + "  " + text + "\n" : ""}${indent}</${tag}>`;
}

export function generatePageHtml(page, componentTree, layoutByIndex, styleByIndex, assetMap, interactionsByIndex, routeFileMap = null) {
  const flat = [];
  const walk = (nodes) => nodes.forEach((n) => { flat.push(n); walk(n.children || []); });
  walk(componentTree.children || []);
  // map assets: images whose captured box matches a captured asset URL are naive;
  // the asset mapper passes url→local and the dom extractor records cls hints —
  // images without a mapped src get a neutral placeholder box
  const body = (componentTree.children || []).map((n) => renderNode(n, layoutByIndex, styleByIndex, assetMap, interactionsByIndex, 2)).join("\n");
  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>${esc(page.url)}</title>
  <link rel="stylesheet" href="/styles/tokens.css">
  <link rel="stylesheet" href="/styles/layout.css">
  <link rel="stylesheet" href="/styles/components.css">
</head>
<body>
${body}
  <script src="/runtime/interactions.js"></script>
</body>
</html>
`;
}

export function generateProject({ outDir, pages, tokens, tokensCss, pageHtmls, assetsEntries, explorationReport, interactionRecords = [] }) {
  fs.mkdirSync(path.join(outDir, "styles"), { recursive: true });
  fs.mkdirSync(path.join(outDir, "runtime"), { recursive: true });
  fs.mkdirSync(path.join(outDir, "public", "assets"), { recursive: true });
  fs.writeFileSync(path.join(outDir, "package.json"), JSON.stringify({
    name: "reconstructed-site", private: true, version: "0.1.0",
    scripts: { dev: "npx serve . -l 4175", start: "npx serve . -l 4175" },
  }, null, 2));
  fs.writeFileSync(path.join(outDir, "styles", "tokens.css"), tokensCss);
  // assets copy
  let copied = 0;
  for (const a of assetsEntries || []) {
    if (!a.localPath) continue;
    const src = path.resolve(outDir, "..", "..", a.localPath);
    const destDir = path.join(outDir, "public", "assets", a.type || "other");
    try {
      fs.mkdirSync(destDir, { recursive: true });
      fs.copyFileSync(src, path.join(destDir, path.basename(a.localPath)));
      copied++;
    } catch {}
  }
  // pages
  for (const p of pageHtmls) {
    const rel = p.route === "/" ? "index.html" : p.route.replace(/^\//, "").replace(/[?&#]/g, "_") + ".html";
    const safe = rel.replace(/[^a-zA-Z0-9_./-]/g, "_");
    fs.writeFileSync(path.join(outDir, safe), p.html);
    p.file = safe;
  }
  // interaction replay runtime from the proven template (recorded overlays)
  fs.writeFileSync(path.join(outDir, "runtime", "interactions.js"), buildRuntime(interactionRecords));

  return { copied, files: pageHtmls.map((p) => ({ route: p.route, file: p.file, size: p.file ? fs.statSync(path.join(outDir, p.file)).size : 0 })) };
}
