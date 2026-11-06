// Page + project generation (spec §10): renders the component tree into clean,
// editable HTML with captured layout/styles in real CSS files, wires recorded
// interactions, maps assets, and preserves geometry — all verified on output.
import fs from "node:fs";
import path from "node:path";
import { buildRuntime, withAdSlots } from "../../runtimeTemplate.js";
// Phase 3.4 integrations (wired by the integration agent):
import { extendRuntimeWorkspace } from "../docking-layout-builder.js"; // task 3.4.2
import { buildStreamRuntime } from "../data-stream-replayer.js"; // task 3.4.4
// multipage navigation: route→local-file href rewriting with the COMPLETE map
import { buildRouteFileMap, deriveAppOrigin, rewritePageLinks } from "./link-rewriter.js";
// font fidelity: measured families (dom.json typography) → captured font FILES
import { buildTokenFontFaces } from "../../assets/fonts-manifest.js";

const SELF_CLOSE = new Set(["img", "br", "hr", "input", "meta", "link"]);

function esc(s) {
  return String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

// build per-element CSS rules (components.css) + collect geometry evidence
// opts (additive): { scopeOf?: (el) => string } — element indexes restart at 0
// per page, so a multi-page build collides .cx-N rules across pages in the
// SHARED components.css (page-002's index-9 chart canvas would override
// page-001's index-9 dock root). The pipeline passes scopeOf to prefix each
// COLLIDING element's rule with a body[data-page] marker that generatePageHtml
// emits (scoped by the element's OWN page); non-colliding indexes keep the
// exact legacy output.
export function buildComponentCss(elements, layoutByIndex, opts = {}) {
  const scopeOf = typeof opts.scopeOf === "function" ? opts.scopeOf : null;
  // element indexes restart PER PAGE (allElements concatenates every page's
  // elements), so both the parent walk and the layout lookup must resolve
  // within the element's OWN page — a shared index map returns another page's
  // element (run 1: page-001's .cx-88 img got `left:-611px` derived against
  // page-017's element 85, landing the hero monitor 551px left of the
  // original). opts.pageOfElement (element object → pageId) and
  // opts.layoutByPage (pageId → Map(index → analyzeLayout row)) come from the
  // pipeline; standalone single-page callers keep the legacy index-only maps.
  const pageOfElement = opts.pageOfElement instanceof Map ? opts.pageOfElement : null;
  const layoutByPage = opts.layoutByPage instanceof Map ? opts.layoutByPage : null;
  const byPage = new Map(); // pageId → Map(index → el) for the parent walk
  for (const e of elements) {
    const key = (pageOfElement && pageOfElement.get(e)) || "_";
    if (!byPage.has(key)) byPage.set(key, new Map());
    byPage.get(key).set(e.i, e);
  }
  // positionOf(el) → the element's captured computed position. styles.json does
  // NOT carry `position` (dom-extractor.js records it on el.layout only), so the
  // legacy st.position read silently dropped EVERY fixed/absolute/relative value
  // (visual round-1 exp-mw59a16doczk: the fixed header-holder rendered in flow —
  // the whole page shifted +44px and the header content fell below its band).
  const positionOf = (e) => String(e?.style?.position || e?.layout?.position || "static");
  const rules = [];
  for (const el of elements) {
    const i = el.i;
    const st = el.style || {};
    // task 3.4.x fix: analyzeLayout misses elements (sampling/geometry edge cases);
    // the fallback `st.display` is ALSO missing because the extractor captures
    // display in `el.layout`, not `el.style` — so flex/grid containers collapsed
    // to block and their children stacked vertically (Tradovate layout drift).
    // Fall back to the element's OWN captured layout when analyzeLayout missed it.
    const ownLay = el.layout && el.layout.display && el.layout.display !== "block"
      ? {
          kind: el.layout.display.includes("flex") ? "flex" : el.layout.display.includes("grid") ? "grid" : el.layout.display,
          display: el.layout.display,
          flexDirection: el.layout.flexDirection || null,
          flexWrap: el.layout.flexWrap || null,
          gridTemplateColumns: el.layout.gridTemplateColumns || null,
          justifyContent: el.layout.justifyContent || null,
          alignItems: el.layout.alignItems || null,
          gapPx: el.layout.gap ? parseFloat(el.layout.gap) || null : null,
        }
      : null;
    const pageIdOfEl = pageOfElement ? pageOfElement.get(el) : null;
    const lay = (layoutByPage && pageIdOfEl ? (layoutByPage.get(pageIdOfEl)?.get(i) || null) : null)
      || layoutByIndex.get(i) || ownLay;
    const scoped = scopeOf ? scopeOf(el) : "";
    const rect = el.rect || el.getBoundingClientRect?.() || null;
    const props = [];
    if (lay) {
      props.push(`display:${lay.kind === "flex" ? "flex" : lay.kind === "grid" ? "grid" : lay.display || "block"}`);
      if (lay.kind === "flex" && lay.flexDirection) props.push(`flex-direction:${lay.flexDirection}`);
      if (lay.kind === "flex" && lay.flexWrap) props.push(`flex-wrap:${lay.flexWrap}`);
      if (lay.gridTemplateColumns) props.push(`grid-template-columns:${lay.gridTemplateColumns}`);
      if (lay.gapPx) props.push(`gap:${lay.gapPx}px`);
      if (lay.justifyContent) props.push(`justify-content:${lay.justifyContent}`);
      if (lay.alignItems) props.push(`align-items:${lay.alignItems}`);
    }
    if (st.display && !lay) props.push(`display:${st.display}`);
    if (st.textAlign) props.push(`text-align:${st.textAlign}`);
    const position = positionOf(el);
    if (position && position !== "static") props.push(`position:${position}`);
    // positioned offsets (same round-1 evidence): a fixed/absolute element with
    // no top/left collapses to its static-flow position, so the captured rect
    // MUST be turned into offsets. fixed elements' rects ARE viewport
    // coordinates (captures run at scroll 0) → top/left = rect directly; for
    // absolute elements the offset is relative to the nearest positioned
    // ancestor's captured rect — the same positioned-ancestor chain the clone
    // reproduces from the captured position values above. All inputs are
    // measured capture values; nothing is inferred from tag names.
    if ((position === "fixed" || position === "absolute") && rect && Number.isFinite(rect.x) && Number.isFinite(rect.y)) {
      let baseX = 0, baseY = 0; // fixed → initial containing block (viewport at scroll 0)
      if (position === "absolute") {
        const pageEls = byPage.get(pageIdOfEl || "_");
        const seen = new Set([i]);
        for (let p = el.parent; p != null && pageEls && pageEls.has(p) && !seen.has(p); p = pageEls.get(p).parent) {
          seen.add(p);
          const anc = pageEls.get(p);
          const apos = positionOf(anc);
          if (apos === "relative" || apos === "absolute" || apos === "fixed") {
            const ar = anc.rect || null;
            if (ar && Number.isFinite(ar.x) && Number.isFinite(ar.y)) { baseX = ar.x; baseY = ar.y; }
            break;
          }
        }
      }
      props.push(`left:${Math.round(rect.x - baseX)}px`, `top:${Math.round(rect.y - baseY)}px`);
    }
    if (st.padding && st.padding !== "0px") props.push(`padding:${st.padding}`);
    if (st.margin && st.margin !== "0px") props.push(`margin:${st.margin}`);
    if (st.backgroundColor && st.backgroundColor !== "rgba(0, 0, 0, 0)") props.push(`background:${st.backgroundColor}`);
    // task 3.4.x fix: lazy-loaded hero/carousel art is CSS background-image, not <img> —
    // without this the clone paints the capture-time fallback color (flat blue) instead
    // of the real art. Emit the captured URL; assetMap rewrites it to the downloaded copy.
    if (st.backgroundImage && st.backgroundImage !== "none") {
      const mapUrl = typeof opts.assetMap === "function" ? opts.assetMap : opts.assetMap instanceof Map ? (u) => opts.assetMap.get(u) : null;
      const mapped = st.backgroundImage.replace(/url\((['"]?)([^)'"]+)\1\)/g, (m, _q, u) => {
        if (typeof mapUrl !== "function") return m;
        const local = mapUrl(u);
        return local ? `url('${local}')` : m;
      });
      props.push(`background-image:${mapped.replace(/"/g, "'")}`);
    }
    if (st.color) props.push(`color:${st.color}`);
    if (st.fontFamily) props.push(`font-family:${st.fontFamily}`);
    if (st.fontSize) props.push(`font-size:${st.fontSize}`);
    if (st.fontWeight && st.fontWeight !== "400") props.push(`font-weight:${st.fontWeight}`);
    if (st.lineHeight && st.lineHeight !== "normal") props.push(`line-height:${st.lineHeight}`);
    if (st.border && !st.border.startsWith("0px")) props.push(`border:${st.border}`);
    if (st.borderRadius && st.borderRadius !== "0px") props.push(`border-radius:${st.borderRadius}`);
    if (st.opacity && st.opacity !== "1") props.push(`opacity:${st.opacity}`);
    // task 3.4.x fix: carousels position slides via transform (translate3d offscreen);
    // without emitting it every slide stacks vertically and paints the page solid blue
    if (st.transform && st.transform !== "none") props.push(`transform:${st.transform}`);
    if (st.overflow && st.overflow !== "visible") props.push(`overflow:${st.overflow}`);
    if (st.zIndex && st.zIndex !== "auto") props.push(`z-index:${st.zIndex}`);
    // capture-only background canvas hygiene (exp-mw5l1whwd178): the live app's
    // full-viewport chart/paint surface is captured as a fixed-position canvas —
    // in the clone it carries no handlers (the runtime binds only recorded
    // [data-cloner-trigger] controls), but sitting at a higher stacking level
    // than the workspace it swallows EVERY pointer event, so dock splitters/
    // tabs/panes are unhittable and the app-control wiring check fails
    // ("splitter drag resized panel: 697×131 → 697×131"). pointer-events:none
    // changes no rendering — it only stops the dead layer from hijacking
    // interaction. Canvases that carry a recorded trigger keep their hit area.
    if (el.tag === "canvas" && position === "fixed" && !el.dataClonerTrigger) props.push("pointer-events:none");
    if (rect && rect.w > 2 && rect.h > 2) {
      if (rect.w) props.push(`width:${rect.w}px`);
      if (rect.h) props.push(`height:${rect.h}px`);
    }
    if (props.length) rules.push(`${scoped}.cx-${i} { ${props.join("; ")}; }`);
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
    // routeFileMap here is the pipeline's PARTIAL per-page map (built
    // incrementally while the pages array fills — page-001 sees an empty one),
    // so this only pre-rewrites routes already processed. In-page fragment
    // hrefs are never route-matched (new URL("#x", base).pathname is "/" and
    // used to mis-route them to index.html); the hash survives real rewrites.
    // The COMPLETE rewrite runs in generateProject via link-rewriter.js.
    if (href && cssCtx.routeFileMap && !href.startsWith("#")) {
      try {
        const u = new URL(href, "http://x");
        const mapped = cssCtx.routeFileMap.get(u.pathname);
        if (mapped) href = mapped + (u.hash || "");
      } catch { /* unparseable href stays raw */ }
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
  // task 3.4.4: data-stream widget wiring — the pipeline's streamByIndex maps
  // detected live-data widget element indexes → "channel.key" targets; the
  // runtime/streams.js replayer applies the captured/synthetic sequence to them
  const streamTarget = cssCtx.streamByIndex?.get(node._elementIndex);
  if (streamTarget) attrs += ` data-stream-target="${esc(streamTarget)}"`;
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
<body data-page="${esc(page.pageId || "")}">
${body}
  <script src="runtime/interactions.js"></script>
${cssCtx.hasStreams ? '  <script src="runtime/streams.js"></script>\n' : ""}</body>
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

export function generateProject({ outDir, pageHtmls, tokensCssText, layoutCss, componentsCss, assetMap, assetRoot, interactionRecords = [], streamPlan = null, adConfig = null }) {
  const dirs = ["styles", "runtime", "public/assets"];
  for (const d of dirs) fs.mkdirSync(path.join(outDir, d), { recursive: true });
  fs.writeFileSync(path.join(outDir, "package.json"), JSON.stringify({
    name: "reconstructed-site", private: true, version: "0.1.0",
    scripts: { dev: "npx serve . -l 4175" },
  }, null, 2));
  // font fidelity: @font-face rules for the ORIGINAL's captured font files are
  // prepended to tokens.css BEFORE the :root font tokens — the CSS names
  // families that must actually exist locally, so every measured family
  // (dom.json typography) resolves to a real file instead of a Times fallback.
  // A measured family with no captured file gets the closest captured family
  // of the same class, recorded honestly in styles/fonts-manifest.json.
  const fontTokens = buildTokenFontFaces({ jobDir: assetRoot || artifactsAssetRoot(), tokensCssText, outDir });
  fs.writeFileSync(path.join(outDir, "styles", "tokens.css"), fontTokens.css + tokensCssText);
  fs.writeFileSync(path.join(outDir, "styles", "fonts-manifest.json"), JSON.stringify(fontTokens.manifest, null, 2));
  fs.writeFileSync(path.join(outDir, "styles", "layout.css"), layoutCss);
  fs.writeFileSync(path.join(outDir, "styles", "components.css"), componentsCss);
  // task 3.4.2: dock behaviors ride along with the replay runtime —
  // marker-guarded (idempotent) and a no-op on pages with no data-ws-* stamps
  fs.writeFileSync(path.join(outDir, "runtime", "interactions.js"), extendRuntimeWorkspace(buildRuntime(interactionRecords)));
  // task 3.4.4: embedded data-stream replayer — inert when no channels were planned
  fs.writeFileSync(path.join(outDir, "runtime", "streams.js"), buildStreamRuntime(streamPlan?.channelSpecs || []));
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
  // fallback must not double-append .html to routes that already carry it.
  // Trailing-slash directory routes ("/guide/") have an empty basename after
  // the extension strip — fall back to "index" so the slug is a real FILE name
  // (basename "guide/.html" is empty and un-writable, and ENOENT'd the whole
  // reconstruction on vite.dev), matching the pipeline-side slug logic.
  const files = [];
  // multipage navigation (the "1st page hi clone hota hai, kaam nahi karta" fix):
  // rewrite <a href> with the COMPLETE route→file picture — every explored route
  // that got a page file. The pipeline's per-page routeFileMap is built
  // incrementally, so page-001's nav links can only be fixed here. Explored
  // routes → relative sibling file (works from file:// and any static server);
  // internal unexplored routes and uncaptured in-page fragments → href="#"
  // + data-cloner-unexplored="true" (honest, visibly non-functional); external
  // http(s) links stay untouched. Contract: generation/link-rewriter.js.
  const routeToFile = buildRouteFileMap(pageHtmls);
  const fileSet = new Set((pageHtmls || []).map((p) => String(p.file || "").replace(/[^a-zA-Z0-9_./-]/g, "_")));
  const appOrigin = deriveAppOrigin(assetMap, pageHtmls);
  // local-file existence for href resolution — files only: "/" must fall
  // through to the route map (→ index.html) instead of matching the outDir
  // DIRECTORY itself, which would emit href="./" (serves the directory index
  // on a static server but opens a listing, not the page, from file://)
  const outDirExists = (rel) => { try { const p = path.join(outDir, rel); return fs.existsSync(p) && fs.statSync(p).isFile(); } catch { return false; } };
  let linksRewritten = 0, linksUnexplored = 0;
  for (const p of pageHtmls) {
    let rel = p.file;
    if (!rel) {
      if (p.route === "/") rel = "index.html";
      else {
        const base = p.route.replace(/^\//, "").replace(/\.html?$/i, "").replace(/[?&#]/g, "_").replace(/\/+$/, "");
        rel = (base || "index") + ".html";
      }
    }
    const safe = rel.replace(/[^a-zA-Z0-9_./-]/g, "_");
    if (safe.includes("..")) { failed++; continue; }
    // multipage nav rewrite runs on the page's own HTML BEFORE ad slots (ad
    // markup is not app navigation and must not be touched)
    const rw = rewritePageLinks(p.html, { routeToFile, fileSet, origin: appOrigin, currentRoute: p.route, currentFile: safe, outDirExists });
    linksRewritten += rw.rewritten;
    linksUnexplored += rw.unexplored;
    // task 4.5.5: ad-slot emission hook — adConfig is non-null ONLY for a clone
    // whose owner opted in (monetize) AND has official zones configured; null
    // leaves the page byte-identical to the pre-4.5.5 output
    const pageHtml = withAdSlots(rw.html, adConfig, { page: safe });
    fs.writeFileSync(path.join(outDir, safe), pageHtml);
    const size = fs.statSync(path.join(outDir, safe)).size;
    files.push({ route: p.route, file: safe, size, linksRewritten: rw.rewritten, linksUnexplored: rw.unexplored });
  }
  return { copied, failed, files, linksRewritten, linksUnexplored };
}

function artifactsAssetRoot() {
  return path.join(process.cwd(), "artifacts");
}
