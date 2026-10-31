// Asset manifest (spec §11, §12): classify + hash + deduplicate the downloaded
// assets, produce a machine-readable manifest, and classify download-vs-reconstruct.
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";

const TYPE_BY_DIR = { css: "stylesheet", js: "script", data: "data", fonts: "font", img: "image", media: "media", misc: "other" };

// download-vs-reconstruct classifier (spec §12)
export function classifyResource(entry) {
  const t = entry.type;
  if (t === "image" || t === "font" || t === "stylesheet" || t === "media") return "downloaded";
  if (t === "data") return "downloaded-extractable"; // JSON/i18n — downloaded + inspectable
  if (t === "script") return "downloaded-inert";     // app code kept but not executed in clone
  return "manual-review";
}

export function buildAssetManifest(outDir) {
  const assetsDir = path.join(outDir, "assets");
  const manifest = {
    generatedAt: new Date().toISOString(),
    total: 0, totalBytes: 0, byType: {}, deduplicated: 0, entries: [],
    // honest scope (phase 1): nothing persists live response bodies into
    // artifacts/<job>/assets/ yet — a 0 total means no asset files were
    // captured, not a scan failure (spec §12 asset capture lands later)
    scope: "phase 1: classifies asset FILES persisted under artifacts/<job>/assets/ only — live asset capture is not wired yet",
  };
  const byHash = new Map();
  if (!fs.existsSync(assetsDir)) return manifest;
  for (const dir of fs.readdirSync(assetsDir, { withFileTypes: true })) {
    if (!dir.isDirectory()) continue;
    const type = TYPE_BY_DIR[dir.name] || "other";
    manifest.byType[type] = manifest.byType[type] || { files: 0, bytes: 0 };
    for (const f of fs.readdirSync(path.join(assetsDir, dir.name))) {
      const full = path.join(assetsDir, dir.name, f);
      let size = 0, hash = null;
      try {
        const buf = fs.readFileSync(full);
        size = buf.length;
        hash = createHash("sha1").update(buf).digest("hex").slice(0, 20);
      } catch { continue; }
      manifest.total++;
      manifest.totalBytes += size;
      manifest.byType[type].files++;
      manifest.byType[type].bytes += size;
      if (byHash.has(hash)) {
        manifest.deduplicated++;
        manifest.entries.push({ file: "assets/" + dir.name + "/" + f, type, size, hash, duplicateOf: byHash.get(hash), classification: "duplicate" });
        continue;
      }
      byHash.set(hash, "assets/" + dir.name + "/" + f);
      manifest.entries.push({ file: "assets/" + dir.name + "/" + f, type, size, hash, classification: classifyResource({ type }) });
    }
  }
  return manifest;
}

// responsive layout-change detection (spec §10): compare per-viewport geometry
// fingerprints of the main containers. Returns { captures, layoutChanged } —
// layoutChanged must live in a plain object, not a property pinned on an Array
// (JSON.stringify drops it). The primary viewport is always restored afterwards.
export async function captureResponsive(page, viewports, screenshotManager, outDir, pageId) {
  const captures = [];
  const baseDir = path.join(outDir, "_reference", "responsive");
  fs.mkdirSync(baseDir, { recursive: true });
  const original = page.viewportSize();
  try {
    for (const vp of viewports) {
      await page.setViewportSize({ width: vp.width, height: vp.height });
      await page.waitForTimeout(900); // reflow + lazy re-render
      const geo = await page.evaluate(() => {
        const containers = [...document.querySelectorAll("body > div, main, [class*='container'], [class*='wrapper']")]
          .slice(0, 8).map((el) => {
            const r = el.getBoundingClientRect();
            const cs = getComputedStyle(el);
            return { cls: String(el.className).slice(0, 40), w: Math.round(r.width), h: Math.round(r.height), display: cs.display, flexDirection: cs.flexDirection || null, gridCols: cs.gridTemplateColumns || null };
          });
        return { innerWidth: innerWidth, innerHeight: innerHeight, containers };
      }).catch(() => null);
      const shotPath = path.join(baseDir, `${pageId}-${vp.name}.png`);
      const shot = await page.screenshot({ fullPage: false, timeout: 20000 }).catch(() => null);
      if (shot) fs.writeFileSync(shotPath, shot);
      captures.push({ viewport: vp.name, width: vp.width, height: vp.height, geometry: geo, screenshotRef: shot ? "_reference/responsive/" + path.basename(shotPath) : null });
    }
  } finally {
    if (original) await page.setViewportSize({ width: original.width, height: original.height }).catch(() => {});
  }
  // layout-change detection: compare first container widths across viewports
  const widths = captures.map((r) => r.geometry?.containers?.[0]?.w || 0);
  const layoutChanged = widths.length > 1 && new Set(widths).size > 1;
  return { captures, layoutChanged };
}
