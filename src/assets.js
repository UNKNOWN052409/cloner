// Asset downloader with a concurrency pool + CSS URL rewriting.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { bus } from "./events.js";

const EXT_BY_TYPE = {
  "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "image/gif": "gif",
  "image/svg+xml": "svg", "image/x-icon": "ico", "image/vnd.microsoft.icon": "ico", "image/avif": "avif",
  "text/css": "css", "font/woff2": "woff2", "font/woff": "woff", "font/ttf": "ttf", "font/otf": "otf",
  "application/font-woff2": "woff2", "application/font-woff": "woff", "application/x-font-ttf": "ttf",
  "video/mp4": "mp4", "video/webm": "webm", "video/quicktime": "mov", "audio/mpeg": "mp3", "audio/mp4": "m4a",
  // full-stack clones: app code + data (i18n/lang packs, API JSON)
  "text/javascript": "js", "application/javascript": "js", "application/x-javascript": "js", "text/ecmascript": "js",
  "application/json": "json", "text/json": "json",
};

function extFor(url, contentType) {
  if (contentType && EXT_BY_TYPE[contentType.split(";")[0].trim()]) return EXT_BY_TYPE[contentType.split(";")[0].trim()];
  const m = path.extname(new URL(url).pathname).toLowerCase();
  return /^\.[a-z0-9]{1,5}$/.test(m) ? m.slice(1) : "bin";
}

function subdirFor(ext) {
  if (["css"].includes(ext)) return "css";
  if (["js", "mjs"].includes(ext)) return "js";
  if (["json"].includes(ext)) return "data";
  if (["woff", "woff2", "ttf", "otf"].includes(ext)) return "fonts";
  if (["mp4", "webm", "mov", "mp3", "m4a"].includes(ext)) return "media";
  if (["html", "bin"].includes(ext)) return "misc";
  return "img";
}

export async function downloadAssets(urls, outDir, { concurrency = 16, timeoutMs = 15000, maxAssets = 400, referer, fetchImpl } = {}) {
  const unique = [...new Set(urls)].filter((u) => /^https?:\/\//i.test(u)).slice(0, maxAssets);
  const map = new Map(); // absolute url -> relative local path
  let done = 0;
  bus.emit("assets:start", { total: unique.length });

  async function worker(queue) {
    for (const url of queue) {
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          const rel = await downloadOne(url, outDir, { timeoutMs, referer, fetchImpl });
          if (rel) map.set(url, rel);
          break;
        } catch (e) {
          // burst rate-limits (CF 403/429) — back off once and retry.
          // FIX: 404s are dead links — do NOT burn a second attempt (the old code
          // retried every failure, logging each dead 404 twice and doubling sweep time)
          if (attempt === 0 && /HTTP (403|429)/.test(e.message)) {
            await new Promise((r) => setTimeout(r, 1200 + Math.random() * 800));
            continue;
          }
          bus.emit("log", { level: "warn", msg: `asset failed: ${short(url)} — ${e.message}` });
          break;
        }
      }
      done++;
      if (done % 10 === 0 || done === unique.length) bus.emit("assets:progress", { done, total: unique.length });
    }
  }
  const shards = Array.from({ length: Math.min(concurrency, unique.length || 1) }, () => []);
  unique.forEach((u, i) => shards[i % shards.length].push(u));
  await Promise.all(shards.map(worker));
  bus.emit("assets:done", { ok: map.size, total: unique.length });
  return map;
}

async function downloadOne(url, outDir, { timeoutMs, referer, fetchImpl } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const headers = {
      "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36",
      accept: "*/*",
      ...(referer ? { referer } : {}),
    };
    const res = fetchImpl
      ? await fetchImpl(url, headers, timeoutMs)
      : await fetch(url, { signal: ctrl.signal, redirect: "follow", headers });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const type = res.headers.get("content-type") || "";
    if (/html/.test(type)) return null; // don't save pages as assets
    const ext = extFor(url, type);
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > 80 * 1024 * 1024) throw new Error("too large");
    const name = hashName(url) + "." + ext;
    const dir = path.join(outDir, "assets", subdirFor(ext));
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, name), buf);
    return `assets/${subdirFor(ext)}/${name}`;
  } finally {
    clearTimeout(timer);
  }
}

function hashName(url) {
  return crypto.createHash("sha1").update(url).digest("hex").slice(0, 20);
}
function short(u) {
  try { return new URL(u).pathname.split("/").pop().slice(0, 60) || u.slice(0, 60); } catch { return u.slice(0, 60); }
}

// ---- URL rewriting -------------------------------------------------------

export function absoluteUrl(src, base) {
  try { return new URL(src, base).href; } catch { return null; }
}

// Rewrite src/href/poster/srcset/style url(...) in serialized HTML using urlMap.
export function rewriteHtml(html, pageUrl, urlMap, origin) {
  let out = html;
  // crossorigin="anonymous" makes local file:// / localhost CSS load fail CORS
  // (origin is "null" from file://) — the whole clone renders unstyled. Strip it.
  out = out.replace(/\s+crossorigin(=["']?[\w-]*["']?)?/gi, "");
  // integrity hashes no longer match after any local rewrite — strip too
  out = out.replace(/\s+integrity(=["'][^"']*["'])?/gi, "");
  // srcset first (contains multiple srcs that also match src regex otherwise)
  out = out.replace(/\ssrcset\s*=\s*"([^"]*)"/gi, (m, v) => {
    const parts = v.split(",").map((c) => {
      const [u, d] = c.trim().split(/\s+/);
      const abs = absoluteUrl(u, pageUrl);
      const local = abs && urlMap.get(abs);
      return (local || u) + (d ? " " + d : "");
    });
    return ` srcset="${parts.join(", ")}"`;
  });
  out = out.replace(/\s(src|href|poster|xlink:href)\s*=\s*"(#|javascript:|data:|mailto:|tel:)[^"]*"/gi, (m) => m);
  out = out.replace(/\s(src|href|poster|xlink:href)\s*=\s*"([^"]*)"/gi, (m, attr, v) => {
    const abs = absoluteUrl(v, pageUrl);
    const local = abs && urlMap.get(abs);
    if (local) return ` ${attr}="${local}"`;
    // keep same-site links as-is, kill external navigation
    if (attr === "href" && abs && !abs.startsWith(origin)) return ` ${attr}="#"`;
    return m;
  });
  // inline styles with url()
  out = out.replace(/url\((['"]?)([^)'"]+)\1\)/gi, (m, q, v) => {
    const abs = absoluteUrl(v, pageUrl);
    const local = abs && urlMap.get(abs);
    return local ? `url(${q}${local}${q})` : m;
  });
  return out;
}

// url() inside a CSS file resolves relative to the CSS file's own directory —
// rebase the out-root-relative asset path accordingly.
function relTo(cssFile, assetFile) {
  const cssDir = path.posix.dirname(cssFile);
  let rel = path.posix.relative(cssDir, assetFile);
  if (!rel.startsWith(".")) rel = "./" + rel;
  return rel.replace(/\\/g, "/");
}

// Second pass: after all assets are downloaded, re-resolve url() refs inside
// CSS files that were captured before their fonts/images existed in the map.
export async function finalizeCssRewrite(cssFiles, outDir, urlMap) {
  for (const { file, cssUrl } of cssFiles) {
    const full = path.join(outDir, file);
    if (!fs.existsSync(full)) continue;
    let css = fs.readFileSync(full, "utf8");
    const next = css.replace(/url\((['"]?)([^)'"]+)\1\)/gi, (m, q, v) => {
      if (/^data:/i.test(v)) return m;
      const abs = absoluteUrl(v, cssUrl);
      if (!abs) return m;
      const mapped = urlMap.get(abs);
      return mapped ? `url(${q}${relTo(file, mapped)}${q})` : m;
    });
    if (next !== css) fs.writeFileSync(full, next);
  }
}

// Download CSS, rewrite nested url()/@import, save locally. Returns {relPath, cssText}
export async function captureCss(cssUrl, outDir, urlMap, { fetchImpl } = {}, visited = new Set(), depth = 0) {
  if (urlMap.has(cssUrl)) return { relPath: urlMap.get(cssUrl) };
  const rel = await downloadOne(cssUrl, outDir, { timeoutMs: 15000, referer: cssUrl, fetchImpl });
  if (!rel) return null;
  urlMap.set(cssUrl, rel);
  const file = path.join(outDir, rel);
  let css = fs.readFileSync(file, "utf8");
  const extra = [];
  css = await rewriteCssText(css, cssUrl, outDir, urlMap, extra, visited, depth, rel);
  fs.writeFileSync(file, css);
  return { relPath: rel, extraUrls: extra };
}

async function rewriteCssText(css, baseUrl, outDir, urlMap, extraUrls, visited, depth, cssRelPath) {
  // @import
  css = css.replace(/@import\s+(?:url\()?['"]?([^'")\s]+)['"]?\)?[^;]*;/gi, (m, v) => {
    const abs = absoluteUrl(v, baseUrl);
    if (!abs || visited.has(abs) || depth > 2) return "";
    visited.add(abs);
    extraUrls.push(abs);
    const mapped = urlMap.get(abs);
    if (mapped) return `@import "${relTo(cssRelPath, mapped)}";`;
    return m; // will be re-captured by caller afterwards if needed
  });
  // url() refs
  css = css.replace(/url\((['"]?)([^)'"]+)\1\)/gi, (m, q, v) => {
    if (/^data:/i.test(v)) return m;
    const abs = absoluteUrl(v, baseUrl);
    if (!abs) return m;
    extraUrls.push(abs);
    const mapped = urlMap.get(abs);
    if (mapped) return `url(${q}${relTo(cssRelPath, mapped)}${q})`;
    return m;
  });
  return css;
}
