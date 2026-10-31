// DOM & visual intelligence (spec §9): per-element semantic + geometry +
// computed-style extraction (bounded sample), layout direction/grid/flex
// detection, repeated-component detection, fixed/sticky element detection.
// Runs inside the page — self-contained, no external deps.
export const DOM_EXTRACTOR_SCRIPT = `(() => {
  const MAX = 1200;
  const PROPS = ["display","position","flexDirection","justifyContent","alignItems","gap","gridTemplateColumns",
    "padding","margin","backgroundColor","color","fontFamily","fontSize","fontWeight","lineHeight",
    "border","borderRadius","opacity","overflow","zIndex"];
  const out = [];
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
      cls: String(el.className || "").slice(0, 80) || null,
      text: (el.children.length === 0 ? (el.innerText || "").trim().slice(0, 60) : "") || null,
      parent: null,
      children: el.children.length,
      rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
      layout: {
        display: cs.display,
        position: cs.position,
        flexDirection: cs.display.includes("flex") ? cs.flexDirection : null,
        gridTemplateColumns: cs.display.includes("grid") ? cs.gridTemplateColumns : null,
        justifyContent: cs.display.includes("flex") ? cs.justifyContent : null,
        alignItems: cs.display.includes("flex") ? cs.alignItems : null,
        gap: cs.gap !== "normal" ? cs.gap : null,
      },
      style: {
        padding: cs.padding, margin: cs.margin,
        backgroundColor: cs.backgroundColor, color: cs.color,
        fontFamily: cs.fontFamily.split(",")[0].replace(/["']/g, ""),
        fontSize: cs.fontSize, fontWeight: cs.fontWeight, lineHeight: cs.lineHeight,
        border: cs.borderTopWidth + " " + cs.borderTopStyle + " " + cs.borderTopColor,
        borderRadius: cs.borderRadius, opacity: cs.opacity,
        overflow: cs.overflow, zIndex: cs.zIndex,
      },
    };
    out.push(rec);
    if (cs.position === "fixed" && fixed.length < 20) fixed.push({ tag: rec.tag, cls: rec.cls, rect: rec.rect });
    if (cs.position === "sticky" && sticky.length < 20) sticky.push({ tag: rec.tag, cls: rec.cls });
    const sig = rec.tag + "|" + rec.cls;
    if (rec.cls) classSigCount[sig] = (classSigCount[sig] || 0) + 1;
  }
  // resolve parents by containment
  for (let a = 0; a < out.length; a++) {
    let best = null, bestArea = Infinity;
    const ra = { x: out[a].rect.x, y: out[a].rect.y, w: out[a].rect.w, h: out[a].rect.h };
    for (let b = 0; b < out.length; b++) {
      if (a === b) continue;
      const rb = out[b].rect;
      if (rb.x <= ra.x && rb.y <= ra.y && rb.x + rb.w >= ra.x + ra.w && rb.y + rb.h >= ra.y + ra.h && rb.w * rb.h < bestArea) {
        best = b; bestArea = rb.w * rb.h;
      }
    }
    out[a].parent = best;
  }
  // repeated components: same tag+class signature appearing >= 3 times
  const repeated = Object.entries(classSigCount).filter(([, n]) => n >= 3).sort((a, b) => b[1] - a[1]).slice(0, 12)
    .map(([sig, n]) => ({ signature: sig.slice(0, 60), count: n }));
  return { total, sampled: out.length, elements: out, repeated, fixed, sticky, sampledAt: new Date().toISOString() };
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
