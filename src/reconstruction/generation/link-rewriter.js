// Multipage navigation rewriting — the honest route→local-file contract.
//
// WHY THIS EXISTS: the user complaint "1st page hi clone hota hai, kaam nahi
// karta, image jaisa hai" — generated pages kept the original site's absolute
// hrefs ("/api", "/guides"), so every nav link led nowhere once the project
// was served statically or opened from disk. Root cause: the pipeline builds
// cssCtx.routeFileMap INCREMENTALLY while the pages array is still filling
// (src/reconstruction/reconstruction-pipeline.js, per-page loop) — page-001
// renders with an EMPTY map, later pages with a PARTIAL one — and
// generateProject() receives no route map at all. This helper completes the
// rewrite where the full route→file picture IS available: generateProject's
// own pageHtmls input (one entry per explored route with DOM evidence, each
// carrying its deterministic .html file name).
//
// Contract (mirrors the coverage rule: unexplored stays VISIBLY
// non-functional, never silently dead):
//   • href → explored route      → rewritten to the sibling page's file as a
//                                  RELATIVE path (works from file:// and any
//                                  static server mount point), fragment kept
//   • href → internal UNexplored → href="#" + data-cloner-unexplored="true"
//   • in-page fragment anchors   → "#" + data-cloner-unexplored="true"
//                                  (no id attributes are emitted on the clone,
//                                  so no captured in-page target exists)
//   • external http(s) / protocol-relative, and non-navigation schemes
//     (mailto:, tel:, javascript:, data:, …) → left untouched
//   • hrefs that already resolve to a local file (renderNode's partial map,
//     the repair loop's fallback shell "index.html" link, stylesheet paths) →
//     left as-is
import path from "node:path";

const UNEXPLORED_ATTR = "data-cloner-unexplored=\"true\"";
// non-navigation schemes are never rewritten (they carry no route semantics)
const NON_NAV_SCHEME_RE = /^(javascript|mailto|tel|sms|data|blob|ftp|file):/i;
const ABSOLUTE_URL_RE = /^https?:\/\//i;

// canonical route key: query/hash dropped, trailing slashes dropped, a
// trailing "index.html" (with its slash) dropped — so "/catalogue/x/",
// "/catalogue/x/index.html" and "/catalogue/x" all collapse to the same key.
// Root stays "/". Mirrors the pipeline's slug logic (route → file name) which
// also strips .html and trailing slashes, so manifest-style pathnames
// ("/a/b/index.html") and bare pathnames ("/a/b") map to the same file.
export function canonicalRoute(input) {
  let p = String(input ?? "").split("?")[0].split("#")[0];
  if (!p) return "/";
  if (!p.startsWith("/")) p = "/" + p;
  p = p.replace(/\/+$/, "");
  p = p.replace(/\/index\.html?$/i, "");
  p = p.replace(/\/+$/, "");
  return p || "/";
}

// complete route→file map from the project's own page entries
// pageEntries: [{ route: "/api", file: "api.html" }, …] — the map generateProject
// can build for itself even when the pipeline passed none.
export function buildRouteFileMap(pageEntries) {
  const map = new Map();
  for (const p of pageEntries || []) {
    if (!p || !p.route || !p.file) continue;
    const key = canonicalRoute(p.route);
    if (key && !map.has(key)) map.set(key, String(p.file));
  }
  return map;
}

// The app's own origin, used to distinguish same-origin absolute links from
// genuinely external ones. Page titles are definitional: generatePageHtml sets
// <title> to the page's full captured URL, so every generated page votes for
// the app origin. Asset URLs (assetMap keys) can include CDNs, so they only
// vote when no title evidence exists.
export function deriveAppOrigin(assetMap, pageHtmls = []) {
  const votes = new Map();
  const add = (origin, weight) => {
    if (!origin) return;
    votes.set(origin, (votes.get(origin) || 0) + weight);
  };
  for (const p of pageHtmls || []) {
    const m = /<title>\s*(https?:\/\/[^<\s]+)/i.exec(String(p?.html || ""));
    if (m) { try { add(new URL(m[1]).origin, 10); } catch {} }
  }
  if (votes.size) return [...votes.entries()].sort((a, b) => b[1] - a[1])[0][0];
  const entries = assetMap instanceof Map ? [...assetMap.keys()]
    : (assetMap || []).map((e) => (Array.isArray(e) ? e[0] : e?.url)).filter(Boolean);
  for (const u of entries) {
    if (/^https?:\/\//i.test(String(u))) { try { add(new URL(String(u)).origin, 1); } catch {} }
  }
  if (votes.size) return [...votes.entries()].sort((a, b) => b[1] - a[1])[0][0];
  return null;
}

function attrEscape(v) {
  return String(v).replace(/"/g, "%22");
}

// Classify ONE href value against the project's route/file picture.
// ctx: { routeToFile: Map, fileSet: Set<string>, origin: string|null,
//        currentRoute: string, currentFile: string,
//        outDirExists?: (rel)=>boolean }
// Returns { kind: "keep" | "local" | "unexplored", href, fragment? }
//   keep       → leave the anchor byte-identical
//   local      → href should become ctx-supplied concrete local target
//   unexplored → href should become "#" + data-cloner-unexplored
export function classifyHref(rawHref, ctx) {
  const href = String(rawHref ?? "");
  if (href === "") return { kind: "keep", href };
  if (NON_NAV_SCHEME_RE.test(href)) return { kind: "keep", href };
  if (href.startsWith("#")) return { kind: "unexplored", href }; // in-page anchor: no captured target exists
  if (href.startsWith("//")) return { kind: "keep", href };      // protocol-relative external

  let url = null;
  try {
    url = new URL(href, "http://recon.invalid" + (ctx.currentRoute || "/"));
  } catch {
    return { kind: "keep", href };
  }
  const hash = url.hash || "";

  // planned page files (may not be written YET when this page is processed) +
  // already-materialized non-page files (styles/, runtime/, public/) both count
  // as resolvable local targets
  const existsLocal = (rel) =>
    (ctx.fileSet && ctx.fileSet.has(rel)) ||
    (typeof ctx.outDirExists === "function" ? ctx.outDirExists(rel) : false);

  if (ABSOLUTE_URL_RE.test(href)) {
    // true absolute URL: a CONFIRMED different origin is external and stays
    // untouched, even when its path coincides with an explored route. With a
    // known origin, same-origin links classify strictly (route map → local,
    // else unexplored). Unknown origin (no title/asset evidence): only a path
    // that matches an explored route is treated as the app's own absolute
    // self-link; anything else stays untouched.
    if (ctx.origin && url.origin !== ctx.origin) return { kind: "keep", href };
    const file = ctx.routeToFile.get(canonicalRoute(url.pathname));
    if (file) return { kind: "local", href: file, fragment: hash };
    if (ctx.origin) return { kind: "unexplored", href };
    return { kind: "keep", href };
  }

  // site-absolute ("/api") or relative ("api.html", "./x", "../x") —
  // filesystem resolution from the current page's directory FIRST (renderNode's
  // partial rewrite and the repair shell's "index.html" land here), then the
  // route map via the URL-resolved pathname (deep relative links like
  // "catalogue/category/books_1/index.html" resolve to their explored route).
  const pathPart = href.split("#")[0];
  const rel = path.posix.normalize(path.posix.join(path.posix.dirname(ctx.currentFile || "index.html") || ".", pathPart));
  if (!rel.startsWith("..") && existsLocal(rel)) {
    return { kind: "local", href: rel, fragment: hash };
  }
  const file = ctx.routeToFile.get(canonicalRoute(url.pathname));
  if (file) return { kind: "local", href: file, fragment: hash };
  return { kind: "unexplored", href };
}

// Rewrite every <a href="…"> in one page's HTML.
// Returns { html, rewritten, unexplored }.
export function rewritePageLinks(html, ctx) {
  let rewritten = 0;
  let unexplored = 0;
  const out = String(html ?? "").replace(/<a\b([^>]*)>/gi, (tag, attrs) => {
    const hrefM = attrs.match(/href\s*=\s*(?:"([^"]*)"|'([^']*)')/i);
    if (!hrefM) return tag;
    const raw = hrefM[1] !== undefined ? hrefM[1] : hrefM[2];
    const d = classifyHref(raw, ctx);
    if (d.kind === "keep") return tag;
    if (d.kind === "local") {
      const val = attrEscape(d.href + (d.fragment || ""));
      if (val === String(raw)) return tag; // already correct — byte-identical
      rewritten++;
      return `<a${attrs.replace(hrefM[0], `href="${val}"`)}>`;
    }
    unexplored++;
    const marker = /data-cloner-unexplored/i.test(attrs) ? "" : " " + UNEXPLORED_ATTR;
    return `<a${attrs.replace(hrefM[0], `href="#"${marker}`)}>`;
  });
  return { html: out, rewritten, unexplored };
}
