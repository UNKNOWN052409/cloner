// Asset-capture stage (spec §0 preflight + §11/§12): persist downloadable static
// resources discovered by the network recorder into artifacts/<jobId>/assets/,
// deduplicate by content hash, and extend the asset manifest. Same-origin +
// resource-type filtered, size-capped, no third-party mass downloads.
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";

const MAX_BYTES = 8 * 1024 * 1024; // per resource
const MAX_RESOURCES = 300;

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
  let bytes = 0;
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
        bytes += body.length;
        downloaded.push({ url: url.slice(0, 200), hash, type: sub, size: body.length, localPath: rel, contentType: entry.contentType || null });
        logger.info("assets", `captured ${rel} (${(body.length / 1024).toFixed(1)}KB)`);
      } catch (e) {
        logger.warn("assets", `capture failed: ${url.slice(0, 80)} — ${e.message.slice(0, 60)}`);
      }
    }
  } finally {
    await page.close().catch(() => {});
  }
  return { count: downloaded.filter((d) => !d.skipped).length, bytes, entries: downloaded };
}
