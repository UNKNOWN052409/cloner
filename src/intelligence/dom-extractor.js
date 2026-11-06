// DOM & visual intelligence (spec §9): per-element semantic + geometry +
// computed-style extraction (bounded sample), layout direction/grid/flex
// detection, repeated-component detection, fixed/sticky element detection.
// Runs inside the page — self-contained, no external deps.
export const DOM_EXTRACTOR_SCRIPT = `(() => {
  const MAX = 1200;
  const PROPS = ["display","position","flexDirection","justifyContent","alignItems","gap","gridTemplateColumns",
    "padding","margin","backgroundColor","backgroundImage","color","fontFamily","fontSize","fontWeight","lineHeight",
    "border","borderRadius","opacity","overflow","zIndex","transform"];
  const out = [];
  const sources = []; // record index → source element (real-DOM parent resolution)
  const els = [...document.querySelectorAll("body *")];
  const total = els.length;
  const step = Math.max(1, Math.floor(els.length / MAX));
  const classSigCount = {};
  let fixed = [], sticky = [];
  for (let i = 0; i < els.length && out.length < MAX; i += step) {
    const el = els[i];
    const r = el.getBoundingClientRect();
    if (r.width < 2 && r.height < 2) continue;
    const cs = getComputedStyle(el);
    const rec = {
      i: out.length,
      tag: el.tagName.toLowerCase(),
      role: el.getAttribute("role") || null,
      ariaName: el.getAttribute("aria-label") || null,
      id: el.id || null,
      dataClonerTrigger: el.getAttribute("data-cloner-trigger") || null,
      href: el.tagName === "A" ? (el.getAttribute("href") || null) : null,
      src: el.tagName === "IMG" ? (el.currentSrc || el.getAttribute("src") || null) : null,
      cls: String(el.className || "").slice(0, 80) || null,
      text: (el.children.length === 0 ? (el.innerText || "").trim().slice(0, 60) : "") || null,
      parent: null,
      children: el.children.length,
      rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
      layout: {
        display: cs.display,
        position: cs.position,
        flexDirection: cs.display.includes("flex") ? cs.flexDirection : null,
        // flex-wrap capture (visual round-1 exp-mw59a16doczk fix): MUI Grid
        // containers are display:flex; flex-wrap:wrap — without the captured
        // wrap the generator emits a plain flex row, every item lands on ONE
        // row and the row overflows the viewport (measured: clone document
        // scrollWidth 5494px vs the original's 1440px — the D-grade pixel diff)
        flexWrap: cs.display.includes("flex") ? cs.flexWrap : null,
        gridTemplateColumns: cs.display.includes("grid") ? cs.gridTemplateColumns : null,
        justifyContent: cs.display.includes("flex") ? cs.justifyContent : null,
        alignItems: cs.display.includes("flex") ? cs.alignItems : null,
        gap: cs.gap !== "normal" ? cs.gap : null,
      },
      style: {
        padding: cs.padding, margin: cs.margin,
        backgroundColor: cs.backgroundColor, color: cs.color,
        backgroundImage: cs.backgroundImage && cs.backgroundImage !== "none" ? cs.backgroundImage.slice(0, 300) : null,
        fontFamily: cs.fontFamily.split(",")[0].replace(/["']/g, ""),
        fontSize: cs.fontSize, fontWeight: cs.fontWeight, lineHeight: cs.lineHeight,
        // text-align capture (same round-1 evidence): the header nav sits
        // flush-right inside its container via text-align:right and section
        // headings are centered — without the captured value the clone
        // left-aligns both (measured: original nav rect x=590 (right edge
        // flush with its 150..1290 container), clone rendered it at x=150)
        textAlign: cs.textAlign && cs.textAlign !== "start" ? cs.textAlign : null,
        border: cs.borderTopWidth + " " + cs.borderTopStyle + " " + cs.borderTopColor,
        borderRadius: cs.borderRadius, opacity: cs.opacity,
        overflow: cs.overflow, zIndex: cs.zIndex,
        transform: cs.transform && cs.transform !== "none" ? cs.transform : null,
      },
    };
    out.push(rec);
    sources.push(el);
    if (cs.position === "fixed" && fixed.length < 20) fixed.push({ tag: rec.tag, cls: rec.cls, rect: rec.rect });
    if (cs.position === "sticky" && sticky.length < 20) sticky.push({ tag: rec.tag, cls: rec.cls });
    const sig = rec.tag + "|" + rec.cls;
    if (rec.cls) classSigCount[sig] = (classSigCount[sig] || 0) + 1;
  }
  // resolve parents from the REAL DOM (nearest sampled ancestor), not geometric
  // containment: transform-positioned subtrees (swiper wrappers translated
  // -2000px+ offscreen) have screen rects OUTSIDE their true parents, so
  // containment assigned children to wrong containers and the reconstruction
  // scattered carousels/headers across the document (Tradovate tree-scatter bug).
  const idxOfEl = new Map();
  for (let a = 0; a < out.length; a++) idxOfEl.set(sources[a], a);
  for (let a = 0; a < out.length; a++) {
    let p = sources[a] ? sources[a].parentElement : null;
    let parent = null;
    while (p && p !== document.body) {
      if (idxOfEl.has(p)) { parent = idxOfEl.get(p); break; }
      p = p.parentElement;
    }
    out[a].parent = parent;
  }
  // repeated components: same tag+class signature appearing >= 3 times
  const repeated = Object.entries(classSigCount).filter(([, n]) => n >= 3).sort((a, b) => b[1] - a[1]).slice(0, 12)
    .map(([sig, n]) => ({ signature: sig.slice(0, 60), count: n }));
  // G4.1 self-reverse (nginx.org): the element loop samples 'body *' — body
  // and html THEMSELVES are never captured, so the token builder had no real
  // page background and picked the most frequent non-transparent ELEMENT bg
  // (nginx's 1440×29 black banner) for the body rule, rendering the whole
  // clone black vs the original's white page (96.9% pixel drift). Capture the
  // page-root computed styles separately (transparent bg → null so callers
  // fall back to their own default instead of mapping alpha-0 to a color).
  const rootStyleOf = (el) => {
    try {
      if (!el) return null;
      const cs = getComputedStyle(el);
      const transparent = (v) => {
        const m = String(v || "").match(/rgba?\(([^)]*)\)/i);
        if (!m) return false;
        const parts = m[1].split(/[\s,/]+/).filter(Boolean);
        return parts.length >= 4 && Number(parts[3]) === 0;
      };
      return {
        backgroundColor: transparent(cs.backgroundColor) ? null : cs.backgroundColor,
        color: transparent(cs.color) ? null : cs.color,
        fontFamily: String(cs.fontFamily || "").split(",")[0].replace(/["']/g, ""),
        fontSize: cs.fontSize,
      };
    } catch { return null; }
  };
  return { total, sampled: out.length, elements: out, repeated, fixed, sticky, bodyStyle: rootStyleOf(document.body), htmlStyle: rootStyleOf(document.documentElement), sampledAt: new Date().toISOString() };
})()`;

// typography analysis from the sampled elements (fonts, sizes, weights, line-heights)
export function analyzeTypography(elements) {
  const agg = {};
  for (const el of elements) {
    if (!el.style?.fontFamily) continue;
    const key = el.style.fontFamily + " | " + el.style.fontSize + " | w" + el.style.fontWeight;
    agg[key] = (agg[key] || 0) + 1;
  }
  return Object.entries(agg).sort((a, b) => b[1] - a[1]).slice(0, 10)
    .map(([k, n]) => { const [font, size, weight] = k.split(" | "); return { font, size, weight, occurrences: n }; });
}
