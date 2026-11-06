// Asset-capture stage (spec §0 preflight + §11/§12): persist downloadable static
// resources discovered by the network recorder into artifacts/<jobId>/assets/,
// deduplicate by content hash, and extend the asset manifest. Same-origin +
// resource-type filtered, size-capped, no third-party mass downloads.
//
// Font fidelity (this wave): font FILES are captured from two sources —
//   1. network.json responses (woff/woff2/ttf/otf) the page actually fetched;
//   2. @font-face src URLs parsed out of the captured CSS bodies (a weight the
//      page never renders is declared in CSS but never fetched — that file must
//      still land in the clone or those weights fall back to a default serif).
// Both land under assets/fonts/ with the same hash dedupe, and a fonts manifest
// { family, weight, style, file, format } is written to
// assets/fonts/fonts-manifest.json — reconstruction reads it to emit @font-face
// rules mapping the MEASURED families (dom.json typography) to real files.
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { parseFontFaceRules, FONT_EXT_RE, formatFromExt } from "../assets/fonts-manifest.js";

const MAX_BYTES = 8 * 1024 * 1024; // per resource
const MAX_RESOURCES = 300;
const MAX_FONTS = 48; // @font-face-discovered downloads on top of the network set

const STATIC_TYPE = /image\/|font\/|text\/css|application\/font|application\/x-font|audio\/|video\//i;
const STATIC_EXT = /\.(png|jpe?g|webp|gif|svg|ico|avif|woff2?|ttf|otf|eot|css|mp4|webm|mp3)(\?|$)/i;

function extFrom(url, contentType) {
  const fromUrl = (url.split("?")[0].match(/\.([a-z0-9]{2,5})$/i) || [])[1];
  if (fromUrl) return fromUrl.toLowerCase();
  const ct = (contentType || "").split(";")[0].trim();
  const map = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "image/svg+xml": "svg", "image/gif": "gif", "image/x-icon": "ico", "font/woff2": "woff2", "font/woff": "woff", "font/ttf": "ttf", "text/css": "css", "video/mp4": "mp4", "video/webm": "webm", "audio/mpeg": "mp3" };
  return map[ct] || "bin";
}

export async function captureAssets(context, networkEntries, store, logger, { max = MAX_RESOURCES } = {}) {
  const page = await context.newPage();
  const downloaded = [];
  const byHash = new Map();
  const relByUrl = new Map();       // full url → localPath already fetched this run
  const fontFaceRules = [];         // { family, weight, style, srcs } from captured CSS
  const fontFaceEntries = [];       // manifest entries with family/weight/style from the rules
  const networkFontFiles = [];      // main-loop font captures (family-unknown until matched)
  let bytes = 0;
  let fontsManifest = null;
  try {
    for (const entry of networkEntries) {
      if (downloaded.length >= max) break;
      if (entry.phase !== "response" || entry.status !== 200) continue;
      const url = entry.url;
      const isStatic = STATIC_TYPE.test(entry.contentType || "") || STATIC_EXT.test(url.split("?")[0]);
      if (!isStatic) continue;
      try {
        const res = await page.request.get(url, { timeout: 15000 });
        if (!res.ok()) continue;
        const body = await res.body();
        if (!body || body.length > MAX_BYTES) continue;
        const hash = createHash("sha1").update(body).digest("hex").slice(0, 20);
        if (byHash.has(hash)) {
          downloaded.push({ url: url.slice(0, 200), hash, duplicateOf: byHash.get(hash), skipped: "duplicate" });
          continue;
        }
        const ext = extFrom(url, entry.contentType);
        const sub = /png|jpe?g|webp|gif|svg|ico|avif/.test(ext) ? "images" : /woff2?|ttf|otf|eot/.test(ext) ? "fonts" : ext === "css" ? "css" : /mp4|webm|mp3/.test(ext) ? "media" : "other";
        const rel = `assets/${sub}/${hash}.${ext}`;
        const abs = path.join(store.dirs.root, rel);
        fs.mkdirSync(path.dirname(abs), { recursive: true });
        fs.writeFileSync(abs, body);
        byHash.set(hash, rel);
        relByUrl.set(url, rel);
        bytes += body.length;
        downloaded.push({ url: url.slice(0, 200), hash, type: sub, size: body.length, localPath: rel, contentType: entry.contentType || null });
        if (sub === "fonts") networkFontFiles.push({ hash, rel, url, bytes: body.length });
        // font-fidelity discovery: @font-face rules hide inside captured CSS —
        // parse them while the body is in hand (styles.json holds computed
        // styles only, so captured stylesheets are the CSS evidence here)
        if (sub === "css" || /text\/css/i.test(entry.contentType || "")) {
          const rules = parseFontFaceRules(body.toString("utf8"), url);
          if (rules.length) logger.info("assets", `@font-face: ${rules.length} rule(s) discovered in ${rel}`);
          fontFaceRules.push(...rules);
        }
        logger.info("assets", `captured ${rel} (${(body.length / 1024).toFixed(1)}KB)`);
      } catch (e) {
        logger.warn("assets", `capture failed: ${url.slice(0, 80)} — ${e.message.slice(0, 60)}`);
      }
    }
    // @font-face src downloads: the browser only fetches weights it renders;
    // declared-but-unfetched font files are downloaded here so the clone can
    // cover every declared weight. First downloadable src wins (woff2 usually).
    const claimedHashes = new Set();
    const seenSrcUrls = new Set();
    for (const rule of fontFaceRules) {
      if (claimedHashes.size >= MAX_FONTS) break;
      for (const src of rule.srcs) {
        if (!FONT_EXT_RE.test(src.ext || "")) continue;   // data:/unknown formats skipped honestly
        if (seenSrcUrls.has(src.url)) continue;
        seenSrcUrls.add(src.url);
        const format = src.format || formatFromExt(src.ext);
        try {
          const already = relByUrl.get(src.url);
          let rel = already || null;
          let size = 0;
          if (rel) {
            size = fs.statSync(path.join(store.dirs.root, rel)).size;
          } else {
            const res = await page.request.get(src.url, { timeout: 15000 });
            if (!res.ok()) continue;
            const body = await res.body();
            if (!body || body.length > MAX_BYTES) continue;
            const hash = createHash("sha1").update(body).digest("hex").slice(0, 20);
            size = body.length;
            if (byHash.has(hash)) {
              rel = byHash.get(hash); // same file already captured from the network
            } else {
              rel = `assets/fonts/${hash}.${src.ext}`;
              fs.mkdirSync(path.dirname(path.join(store.dirs.root, rel)), { recursive: true });
              fs.writeFileSync(path.join(store.dirs.root, rel), body);
              byHash.set(hash, rel);
              bytes += size;
              downloaded.push({ url: src.url.slice(0, 200), hash, type: "fonts", size, localPath: rel, contentType: null });
            }
          }
          fontFaceEntries.push({ family: rule.family, weight: rule.weight, style: rule.style, file: rel, format, source: "font-face", url: src.url.slice(0, 200), bytes: size });
          claimedHashes.add(rel);
          break; // this rule is satisfied by its first downloadable src
        } catch (e) {
          logger.warn("assets", `@font-face src capture failed: ${src.url.slice(0, 80)} — ${e.message.slice(0, 60)}`);
        }
      }
    }
    // network-only font files no @font-face rule claimed: recorded with an
    // honest family: null — a guessed family would poison the token mapping
    const networkOnly = networkFontFiles
      .filter((f) => !claimedHashes.has(f.rel))
      .map((f) => ({ family: null, weight: null, style: null, file: f.rel, format: formatFromExt(f.rel), source: "network", url: f.url.slice(0, 200), bytes: f.bytes }));
    fontsManifest = {
      generatedAt: new Date().toISOString(),
      note: "font FILES captured during exploration: network responses (woff/woff2/ttf/otf) + @font-face src URLs parsed from captured CSS. Reconstruction maps the measured families (dom.json typography) to these files and emits @font-face into styles/tokens.css; substitutions are recorded, never silent.",
      fonts: fontFaceEntries,
      networkOnly,
      counts: { fontFaces: fontFaceEntries.length, networkOnly: networkOnly.length, rulesDiscovered: fontFaceRules.length },
    };
    store.writeJson("assets/fonts/fonts-manifest.json", fontsManifest);
    if (fontFaceEntries.length || networkOnly.length) {
      logger.info("assets", `fonts manifest: ${fontFaceEntries.length} @font-face file(s), ${networkOnly.length} network-only file(s)`);
    }
  } finally {
    await page.close().catch(() => {});
  }
  return { count: downloaded.filter((d) => !d.skipped).length, bytes, entries: downloaded, fonts: fontsManifest };
}
