// Layout DEFECT detection — split verbatim out of layout-analyzer.js
// (2026-11-07): the measure/token half stays in layout-analyzer.js, this file
// owns the defect-detection half and re-exports its surface through
// layout-analyzer.js so every consumer keeps its import path.

// ===========================================================================
// LAYOUT DEFECT DETECTION — the header-gap / horizontal-clip class of defects
// (empty header band, horizontally clipped nav, collapsed sections), FOUND
// from measured evidence and turned into planner-consumable detections so the
// repair loop FIXES them instead of only reporting a pixel diff.
//
// Evidence contract: every detection's numbers come from (1) the original
// capture's artifacts (pages/<id>/dom.json rects, pages/<id>/styles.json
// computed styles, pages/<id>/geometry.json containers, the viewport
// screenshot's own pixels) or (2) a live Playwright measurement of the
// rendered clone loaded over file:// — never from invented styling.
// ===========================================================================
import fs from "node:fs";
import path from "node:path";

// header/nav identity — the same vocabulary blueprint.js:93 already uses, so
// "header" means here what the rest of the engine means by it.
const HEADER_RE = /^(header|topbar|navbar|site-header|site-nav|main-nav|nav)/i;
export const isHeaderElement = (el) => el?.tag === "header" || HEADER_RE.test(String(el?.cls || ""));

// A header shorter than this in the ORIGINAL capture is not a real header
// band; a section shorter than this is not a section worth comparing.
export const HEADER_MIN_CONTENT_PX = 16;
export const SECTION_MIN_HEIGHT_PX = 80;
export const MAX_SECTIONS_PER_PAGE = 12;
// The clone may be this much SHORTER than the original section before it
// counts as collapsed (taller/wrapped clones are noise, not this defect).
export const COLLAPSE_TOLERANCE = 0.25;
// Horizontal overflow must exceed this many px to be real (subpixel noise).
export const OVERFLOW_TOLERANCE_PX = 2;
// A clone header is "collapsed" when it renders at ≤ 4px or ≤ 20% of the
// original's captured height — height ~0, not just a few px of drift.
export const HEADER_COLLAPSE_RATIO = 0.2;
// The original screenshot's header band counts as "showing content" when at
// least this fraction of sampled pixels differ from the band's dominant color.
export const HEADER_CONTENT_FLOOR = 0.05;

// pngSize(buf) → { w, h } | null — IHDR parse only (no decode). The viewport
// screenshot IS the capture viewport at DPR 1 (exploration-pipeline.js:316-321
// screenshots at fullPage:false, capture runs deviceScaleFactor 1 — same
// 1:1 mapping visual-fidelity-analyzer.js:9-12 relies on), so its dimensions
// are the original viewport without needing any PNG library.
export function pngSize(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 24 || buf.readUInt32BE(12) !== 0x49484452) return null;
  return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
}

// normColor(v) → "#rrggbb" | lowercase verbatim | null — same transparent
// semantics as normalizeColor (visual-fidelity-analyzer.js:67-90): alpha 0 and
// "transparent" map to null, never to #000000. Local copy on purpose: this
// module must stay importable by pure consumers (website-understanding.js),
// while visual-fidelity-analyzer pulls the browser in.
export function normColor(v) {
  const s = String(v ?? "").trim();
  if (!s) return null;
  const m = s.match(/rgba?\(\s*(\d+)[,\s]+(\d+)[,\s]+(\d+)(?:[,\s/]+([\d.]+%?)\s*)?\)/i);
  if (m) {
    if (m[4] !== undefined && Number(m[4]) === 0) return null;
    return "#" + [m[1], m[2], m[3]].map((n) => Number(n).toString(16).padStart(2, "0")).join("").toLowerCase();
  }
  if (/^#[0-9a-f]{3,8}$/i.test(s)) {
    const hex = s.toLowerCase();
    if (hex.length === 4) return "#" + [...hex.slice(1)].map((c) => c + c).join("");
    if (hex.length === 9) return parseInt(hex.slice(7, 9), 16) === 0 ? null : hex.slice(0, 7);
    return hex.slice(0, 7);
  }
  return s.toLowerCase() === "transparent" ? null : s.toLowerCase();
}
export const isRealBg = (v) => normColor(v) !== null;

// selectorOf(i, tag, cls) — the clone-side fix target: the generator's
// per-element class `.cx-<i>` (project-generator.js:103), so a fix lands on
// the exact reconstructed element. tag/cls are kept in the signature for
// call-site readability.
export const selectorOf = (i, tag, cls) => `.cx-${i}`;

// buildDetections(original, measured) → detection[]
//   original: { header, band, sections, hadHorizontalOverflow }  (artifact side)
//   measured: { header, overflow, sections }                     (clone render side)
// Pure and deterministic — unit-testable without a browser. Each detection:
//   { defect, kind, selector, region, evidence, suggestedFix, severity,
//     confidence, refs, measured }
// (`defect` is the ask-facing name, `kind` the planner-facing alias.)
// `measured` carries the raw numbers the planner needs to build concrete fix
// descriptors (and its gates) — the planner maps, this function only reports.
export function buildDetections(original, measured) {
  const out = [];
  const H = original.header;
  const bandContentful = !!original.band && original.band.contentPct >= HEADER_CONTENT_FLOOR;
  if (H && bandContentful) {
    const c = measured.header || { found: false };
    if (c.found) {
      const origH = Number(H.rect?.h) || 0;
      if (origH > 0 && c.h <= Math.max(4, origH * HEADER_COLLAPSE_RATIO)) {
        const bgPart = isRealBg(H.bg) ? ` + background: ${H.bg}` : "";
        out.push({
          defect: "layout-header-collapsed",
          kind: "layout-header-collapsed", // planner-consumable alias (planRepairs reads .kind)
          selector: c.matchedBy || selectorOf(H.i, H.tag, H.cls),
          region: "header",
          evidence: `original header <${H.tag}${H.cls ? ` class="${H.cls}"` : ""}> captured at ${origH}px tall with a contentful band (${(original.band.contentPct * 100).toFixed(1)}% non-background pixels in screenshot rows 0–${origH}); the clone renders the same element ${c.h}px tall`,
          suggestedFix: `min-height: ${Math.round(origH)}px${bgPart} on ${c.matchedBy || selectorOf(H.i)} (values measured from the original capture)`,
          severity: 0.95,
          confidence: 0.9,
          refs: [H.i],
          measured: { originalH: origH, cloneH: c.h, originalBg: isRealBg(H.bg) ? H.bg : null, contentPct: original.band.contentPct },
        });
      }
      // unstyled fires only for a header that HAS real height but lost its
      // background — when the header is collapsed the backgroundless state is
      // a consequence of zero height, and the collapsed fix already carries
      // the captured background (emitting both would plan two repairs for one
      // symptom and the executor's keep-if-improved loop would revert the
      // second one and hard-stop the plan).
      else if (isRealBg(H.bg) && !isRealBg(c.bg)) {
        out.push({
          defect: "layout-header-unstyled",
          kind: "layout-header-unstyled", // planner-consumable alias
          selector: c.matchedBy || selectorOf(H.i, H.tag, H.cls),
          region: "header",
          evidence: `original header captured backgroundColor ${H.bg}; the clone renders the same element backgroundless (${c.bg}) while the original screenshot band shows content`,
          suggestedFix: `background-color: ${H.bg} on ${c.matchedBy || selectorOf(H.i)} (token override, !important — autoRemediate precedent, verify.js:459)`,
          severity: 0.85,
          confidence: 0.85,
          refs: [H.i],
          measured: { originalBg: H.bg, cloneBg: c.bg, contentPct: original.band.contentPct },
        });
      }
    }
  }
  // (b) horizontal overflow — the nav-clipping class. The page-level content
  // overflow shows up on BOTH scroll roots (html and body measure the same
  // overflowing content), and Chromium only locks the viewport when BOTH carry
  // overflow-x:hidden (verified: html-only or body-only leaves scrollX
  // movable; html,body collapses the root scroll area) — so ONE root defect is
  // emitted whose selector covers the measured roots, e.g. "html, body". Each
  // inner header/nav container that measures overflow is flagged separately
  // with isScrollRoot: false. The gate (original had no horizontal scroll) is
  // measured on the artifact side and re-checked by the planner.
  const overflowList = measured.overflow || [];
  const roots = overflowList.filter((o) => o.label === "body" || o.label === "html");
  const gateOk = !original.hadHorizontalOverflow;
  if (roots.length) {
    const rootSel = [...roots].sort((a, b) => (a.label === "html" ? -1 : 1) - (b.label === "html" ? -1 : 1)).map((o) => o.selector).join(", ");
    const numbers = roots.map((o) => `${o.label} scrollWidth ${o.scrollWidth} > clientWidth ${o.clientWidth}`).join("; ");
    const widest = Math.max(...roots.map((o) => o.scrollWidth));
    out.push({
      defect: "layout-overflow-x",
      kind: "layout-overflow-x", // planner-consumable alias
      selector: rootSel,
      region: "root",
      evidence: `page-level horizontal overflow in the clone (${numbers}, +${Math.max(...roots.map((o) => o.scrollWidth - o.clientWidth))}px); original capture ${original.hadHorizontalOverflow ? "overflowed horizontally too" : `had no horizontal overflow (widest captured element ends at ${original.maxRightPx}px of a ${original.viewportW}px viewport)`}`,
      suggestedFix: gateOk
        ? `overflow-x: hidden on ${rootSel} (the measured scroll roots — both required, a single-root rule does not lock the viewport)`
        : "none — the original scrolls horizontally too, clipping would diverge from the original",
      severity: 0.7,
      confidence: 0.9,
      refs: roots.flatMap((o) => (o.i != null ? [o.i] : [])),
      measured: {
        scrollWidth: widest, clientWidth: roots[0].clientWidth,
        overflowPx: widest - roots[0].clientWidth,
        originalHadNoOverflow: gateOk,
        isScrollRoot: true,
      },
    });
  }
  for (const o of overflowList) {
    if (o.label === "body" || o.label === "html") continue; // roots reported once, above
    out.push({
      defect: "layout-overflow-x",
      kind: "layout-overflow-x", // planner-consumable alias
      selector: o.selector,
      region: o.label,
      evidence: `${o.label}: scrollWidth ${o.scrollWidth} > clientWidth ${o.clientWidth} (+${o.scrollWidth - o.clientWidth}px horizontal overflow in the clone); original capture ${original.hadHorizontalOverflow ? "overflowed horizontally too" : `had no horizontal overflow (widest captured element ends at ${original.maxRightPx}px of a ${original.viewportW}px viewport)`}`,
      suggestedFix: gateOk
        ? "none at container level — inner overflow originates in the container's content width; the bounded repair is root scroll containment"
        : "none — the original scrolls horizontally too, clipping would diverge from the original",
      severity: 0.7,
      confidence: 0.9,
      refs: o.i != null ? [o.i] : [],
      measured: {
        scrollWidth: o.scrollWidth, clientWidth: o.clientWidth,
        overflowPx: o.scrollWidth - o.clientWidth,
        originalHadNoOverflow: gateOk,
        isScrollRoot: false,
      },
    });
  }
  // (c) collapsed sections — original captured height vs clone rendered height.
  for (const s of measured.sections || []) {
    const orig = (original.sections || []).find((x) => x.i === s.i);
    if (!orig || s.found === false || !Number.isFinite(s.h)) continue;
    const origH = Number(orig.rect?.h) || 0;
    if (origH < SECTION_MIN_HEIGHT_PX) continue;
    const ratio = s.h / origH;
    if (ratio >= 1 - COLLAPSE_TOLERANCE) continue;
    out.push({
      defect: "layout-collapsed-section",
      kind: "layout-collapsed-section", // planner-consumable alias
      selector: s.matchedBy || selectorOf(orig.i, orig.tag, orig.cls),
      region: `section:${selectorOf(orig.i, orig.tag, orig.cls)}`,
      evidence: `original section ${selectorOf(orig.i)} (<${orig.tag}${orig.cls ? ` class="${orig.cls}"` : ""}>) captured ${origH}px tall; the clone renders it ${s.h}px (${Math.round((1 - ratio) * 100)}% collapsed)`,
      suggestedFix: `min-height: ${Math.round(origH)}px on ${s.matchedBy || selectorOf(orig.i)} (never a fixed height — cannot clip real content)`,
      severity: +Math.min(1, (1 - ratio) * 2).toFixed(2),
      confidence: 0.9,
      refs: [orig.i],
      measured: { originalH: origH, cloneH: s.h, ratio: +ratio.toFixed(3) },
    });
  }
  return out;
}

// readJsonOr(file) → parsed | null — missing or malformed evidence is honest
// absence for this analyzer, never a zero and never a throw.
const readJsonOr = (file) => {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return null; }
};

// resolveCloneFile(cloneDir, pageId) — the generated project's file for a
// captured page. page-001 → index.html is the generator's own mapping
// (project-generator.js:244, verify.js measureFidelity:568); other pages fall
// back to the per-page file when one exists.
export function resolveCloneFile(cloneDir, pageId) {
  const m = /^page-(\d+)$/.exec(String(pageId));
  if (m && Number(m[1]) === 1 && fs.existsSync(path.join(cloneDir, "index.html"))) return "index.html";
  for (const rel of [`pages/${pageId}.html`, `${pageId}.html`]) {
    if (fs.existsSync(path.join(cloneDir, rel))) return rel;
  }
  return null;
}

// originalEvidence(pageDir, viewportW) → { header, sections, hadHorizontalOverflow, maxRightPx }
// Header/section identity and the original's horizontal-scroll state come from
// the capture's own dom.json + geometry.json + styles.json records.
function originalEvidence(pageDir, viewportW) {
  const dom = readJsonOr(path.join(pageDir, "dom.json"));
  const geom = readJsonOr(path.join(pageDir, "geometry.json"));
  const styles = readJsonOr(path.join(pageDir, "styles.json"));
  const els = Array.isArray(dom?.elements) ? dom.elements : [];
  const bgByIndex = new Map((Array.isArray(styles?.elements) ? styles.elements : []).map((e) => [e.i, e.style || {}]));
  const maxRightPx = els.reduce((mx, e) => (e.rect && e.rect.x >= 0 && e.rect.w > 0 && e.rect.x < viewportW
    ? Math.max(mx, e.rect.x + e.rect.w) : mx), 0);
  const headerEl = els.find((e) => isHeaderElement(e) && e.rect && e.rect.h >= HEADER_MIN_CONTENT_PX) || null;
  const header = headerEl && {
    i: headerEl.i, tag: headerEl.tag, cls: headerEl.cls || "",
    selector: selectorOf(headerEl.i, headerEl.tag, headerEl.cls),
    rect: headerEl.rect,
    bg: normColor(bgByIndex.get(headerEl.i)?.backgroundColor ?? null),
  };
  const sections = (Array.isArray(geom?.containers) ? geom.containers : [])
    .filter((c) => c.rect && c.rect.h >= SECTION_MIN_HEIGHT_PX && c.rect.w >= viewportW * 0.5 && c.i !== headerEl?.i)
    .slice(0, MAX_SECTIONS_PER_PAGE)
    .map((c) => ({ i: c.i, tag: c.tag, cls: c.cls || "", selector: selectorOf(c.i, c.tag, c.cls), rect: c.rect }));
  return { header, sections, hadHorizontalOverflow: maxRightPx > viewportW + OVERFLOW_TOLERANCE_PX, maxRightPx };
}

// analyzeLayoutDefects(artifactsDir, cloneDir, opts?) →
//   { pages: [{ pageId, viewport, defects, measured, warnings }], defects, warnings }
// opts: { page?, browser?, headless?, viewport? } — a Playwright page may be
// injected (the repair loop already holds one); otherwise a headless browser
// is launched here and always closed. The clone is loaded from file:// ONLY.
export async function analyzeLayoutDefects(artifactsDir, cloneDir, opts = {}) {
  const pagesDir = path.join(artifactsDir, "pages");
  const pageIds = fs.existsSync(pagesDir)
    ? fs.readdirSync(pagesDir).filter((id) => fs.existsSync(path.join(pagesDir, id, "dom.json")))
    : [];
  const report = { pages: [], defects: [], warnings: [] };
  if (!pageIds.length) { report.warnings.push(`${artifactsDir}/pages holds no dom.json captures — nothing to analyze`); return report; }

  const owned = opts.page ? null : await (opts.browser || (await import("../../browser.js")).launchBrowser)({ headless: opts.headless !== false });
  let page = opts.page || null;
  try {
    for (const pageId of pageIds) {
      const pageDir = path.join(pagesDir, pageId);
      const warnings = [];
      const cloneFile = resolveCloneFile(cloneDir, pageId);
      if (!cloneFile) { warnings.push(`no generated file for ${pageId} in ${cloneDir} — page skipped`); report.pages.push({ pageId, defects: [], warnings }); continue; }
      const shotBuf = fs.existsSync(path.join(pageDir, "screenshot-viewport.png")) ? fs.readFileSync(path.join(pageDir, "screenshot-viewport.png")) : null;
      const viewport = pngSize(shotBuf) || opts.viewport || { w: 1440, h: 900 };
      if (!shotBuf) warnings.push("no screenshot-viewport.png — header-band content check skipped, header identity still compared");
      const orig = originalEvidence(pageDir, viewport.w);

      if (!page) page = await owned.newPage({ viewport: { width: viewport.w, height: viewport.h }, deviceScaleFactor: 1 });
      else await page.setViewportSize({ width: viewport.w, height: viewport.h }).catch(() => {});

      // original header band content: decode the capture screenshot on a canvas
      // (same in-page decode pattern as pixelDiff, visual-fidelity-analyzer.js:299)
      // and measure how much of the header band differs from its dominant color.
      let band = null;
      if (shotBuf && orig.header && orig.header.rect) {
        const dataUrl = "data:image/png;base64," + shotBuf.toString("base64");
        band = await page.evaluate(async ({ dataUrl, rect }) => {
          const img = new Image();
          await new Promise((res, rej) => { img.onload = res; img.onerror = () => rej(new Error("png decode failed")); img.src = dataUrl; });
          const w = Math.max(1, Math.min(img.width - Math.max(0, rect.x || 0), rect.w || 1));
          const y0 = Math.max(0, Math.min(img.height - 1, rect.y || 0));
          const h = Math.max(1, Math.min(img.height - y0, rect.h || 1));
          const c = document.createElement("canvas");
          c.width = w; c.height = h;
          const ctx = c.getContext("2d", { willReadFrequently: true });
          ctx.drawImage(img, Math.max(0, rect.x || 0), y0, w, h, 0, 0, w, h);
          const d = ctx.getImageData(0, 0, w, h).data;
          const counts = new Map();
          let total = 0;
          for (let py = 0; py < h; py += 8) {
            for (let px = 0; px < w; px += 8) {
              const i = (py * w + px) * 4;
              const key = `${d[i] >> 3},${d[i + 1] >> 3},${d[i + 2] >> 3}`;
              counts.set(key, (counts.get(key) || 0) + 1);
              total++;
            }
          }
          const [dominant, n] = [...counts.entries()].sort((a, b) => b[1] - a[1])[0] || ["0,0,0", 1];
          const [dr, dg, db] = dominant.split(",").map((v) => Number(v) * 8 + 4);
          let differing = 0;
          for (let py = 0; py < h; py += 8) {
            for (let px = 0; px < w; px += 8) {
              const i = (py * w + px) * 4;
              if (Math.max(Math.abs(d[i] - dr), Math.abs(d[i + 1] - dg), Math.abs(d[i + 2] - db)) > 24) differing++;
            }
          }
          return { contentPct: +((differing / total).toFixed(3)), dominantShare: +(n / total).toFixed(3) };
        }, { dataUrl, rect: orig.header.rect }).catch(() => null);
        if (!band) warnings.push("header band decode failed — content check treated as absent");
      }

      // render the clone and measure the same regions live (file:// only)
      const url = "file:///" + path.join(cloneDir, cloneFile).replace(/\\/g, "/");
      await page.goto(url, { waitUntil: "load", timeout: 30000 });
      await page.waitForTimeout(600); // same settle as measureFidelity (verify.js:581)
      const measured = await page.evaluate(({ header, sections }) => {
        const sig = (e) => String(e.className || "").split(/\s+/).filter((c) => c && !/^cx-\d+$/.test(c))[0] || "";
        const selFor = (el) => {
          const cx = [...el.classList].find((c) => /^cx-\d+$/.test(c));
          return cx ? `.${cx}` : `${el.tagName.toLowerCase()}${sig(el) ? "." + sig(el) : ""}`;
        };
        const find = (p) => {
          const byCx = document.querySelector(`.cx-${p.i}`);
          if (byCx && byCx.tagName.toLowerCase() === p.tag) return { el: byCx, matchedBy: `.cx-${p.i}` };
          const hit = [...document.querySelectorAll(p.tag)].find((e) => sig(e) === (p.cls || "").split(/\s+/)[0]);
          return hit ? { el: hit, matchedBy: selFor(hit) } : { el: null, matchedBy: null };
        };
        const out = { header: { found: false }, overflow: [], sections: [] };
        if (header) {
          const f = find(header);
          out.header = f.el
            ? { found: true, matchedBy: f.matchedBy, h: Math.round(f.el.getBoundingClientRect().height), bg: getComputedStyle(f.el).backgroundColor }
            : { found: false };
        }
        const containers = [["html", document.documentElement], ["body", document.body]];
        for (const el of document.querySelectorAll("header, nav")) containers.push([`<${el.tagName.toLowerCase()}>`, el]);
        for (const [label, el] of containers) {
          if (!el || el.scrollWidth <= el.clientWidth + 2) continue;
          const probe = header && find(header).el === el ? header : null;
          out.overflow.push({ label, selector: selFor(el), scrollWidth: el.scrollWidth, clientWidth: el.clientWidth, i: probe ? probe.i : null });
        }
        for (const s of sections) {
          const f = find(s);
          out.sections.push({ i: s.i, found: !!f.el, h: f.el ? Math.round(f.el.getBoundingClientRect().height) : null, matchedBy: f.matchedBy });
        }
        return out;
      }, { header: orig.header, sections: orig.sections });

      const original = { ...orig, band, viewportW: viewport.w };
      const defects = buildDetections(original, measured);
      report.pages.push({ pageId, viewport, defects, measured, warnings });
      report.defects.push(...defects);
      report.warnings.push(...warnings.map((w) => `${pageId}: ${w}`));
    }
  } finally {
    if (owned) await owned.close().catch(() => {});
  }
  return report;
}
