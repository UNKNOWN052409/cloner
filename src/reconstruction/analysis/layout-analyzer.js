// Layout analyzer (spec §4 — highest priority): infers per-container layout CSS
// from CAPTURED geometry + computed styles, with a confidence score. No guessing
// from tag names: flex/grid comes from the captured display property, sizes from
// the captured bounding boxes, gaps measured from sibling distance.
export function analyzeLayout(elements, rectMap) {
  const byIndex = new Map(elements.map((e) => [e.i, e]));
  const layout = {};
  for (const el of elements) {
    if (!el.layout) continue;
    const children = elements.filter((e) => e.parent === el.i);
    if (children.length < 2) { layout[el.i] = null; continue; }
    const rects = children.map((c) => ({ i: c.i, r: rectMap.get(c.i) })).filter((x) => x.r);
    if (rects.length < 2) { layout[el.i] = null; continue; }
    // orientation evidence: do child boxes share rows (horizontal) or columns?
    const sameRow = rects.filter((x, i2) => i2 > 0 && Math.abs(x.r.y - rects[0].r.y) < Math.max(8, rects[0].r.height * 0.25)).length;
    const horizontal = sameRow >= Math.ceil(rects.length * 0.6);
    const display = el.layout.display || "";
    const isFlex = display.includes("flex");
    const isGrid = display.includes("grid");
    let confidence = 0.4; // base: rects measured
    if (isFlex || isGrid) confidence += 0.4;        // declared layout captured
    if (horizontal !== null) confidence += 0.1;      // geometry agrees
    const gaps = [];
    const sorted = [...rects].sort((a, b) => (horizontal ? a.r.x - b.r.x : a.r.y - b.r.y));
    for (let g = 1; g < sorted.length; g++) {
      const a = sorted[g - 1].r, b = sorted[g].r;
      gaps.push(Math.round(horizontal ? b.x - (a.x + a.width) : b.y - (a.y + a.height)));
    }
    const gap = gaps.length ? Math.max(0, Math.round(gaps.reduce((s, g) => s + g, 0) / gaps.length)) : 0;
    const sizesMatch = el.layout.gridTemplateColumns && isGrid;
    if (isGrid && sizesMatch) confidence += 0.1;
    layout[el.i] = {
      kind: isGrid ? "grid" : isFlex ? "flex" : horizontal ? "row" : "column",
      horizontal,
      gapPx: gap,
      flexDirection: el.layout.flexDirection || (horizontal ? "row" : "column"),
      gridTemplateColumns: el.layout.gridTemplateColumns || null,
      justifyContent: el.layout.justifyContent || null,
      alignItems: el.layout.alignItems || null,
      confidence: Math.min(1, +confidence.toFixed(2)),
      uncertain: confidence < 0.6,
    };
  }
  return layout;
}

// token builder (spec §5): normalize captured values into a token layer with
// EXACT original values (hex where possible) — no redesign, no substitutions.
// pageRootStyle (G4.1, additive): { backgroundColor, color, fontFamily,
// fontSize } computed from the live body (html fallback) — the element loop
// samples `body *`, so without it the body rule inherited the most frequent
// ELEMENT background (nginx's black banner → all-black clone). Transparent
// root backgrounds arrive as null and fall back to the legacy var() defaults.
export function buildTokens(designTokensJson, stylesElements, pageRootStyle = null) {
  const toHex = (rgb) => {
    const m = String(rgb || "").match(/rgba?\(\s*(\d+)[,\s]+(\d+)[,\s]+(\d+)(?:[,\s/]+([\d.]+%?)\s*)?\)/);
    if (!m) return null;
    // fully transparent — not a real color; mapping it to #000000 turned
    // clone backgrounds black (the 81% pixel-diff class of bug)
    if (m[4] !== undefined && Number(m[4]) === 0) return null;
    return "#" + [m[1], m[2], m[3]].map((n) => Number(n).toString(16).padStart(2, "0")).join("").toLowerCase();
  };
  const colors = new Map(), bgs = new Map(), fonts = new Map(), sizes = new Map(), spacing = new Map(), radii = new Map();
  const bump = (map, value) => { if (value) map.set(value, (map.get(value) || 0) + 1); };
  // non-hex fallback must also exclude fully-transparent colors (rgba(...,0))
  const realColor = (v) => {
    const s = String(v || "");
    const m = s.match(/rgba?\(([^)]*)\)/i);
    if (!m) return v || null;
    const parts = m[1].split(/[\s,/]+/).filter(Boolean);
    if (parts.length >= 4 && Number(parts[3]) === 0) return null; // alpha 0 → invisible
    return v;
  };
  for (const el of stylesElements || []) {
    const s = el.style || {};
    bump(colors, toHex(s.color) || realColor(s.color));
    bump(bgs, toHex(s.backgroundColor) || realColor(s.backgroundColor));
    bump(fonts, s.fontFamily);
    bump(sizes, s.fontSize);
  }
  for (const [v, n] of designTokensJson?.colors || []) bump(colors, toHex(v) || v);
  for (const [v, n] of designTokensJson?.backgrounds || []) bump(bgs, toHex(v) || v);
  for (const [v, n] of designTokensJson?.radii || []) bump(radii, v);
  for (const [v, n] of designTokensJson?.spacing || []) bump(spacing, v);
  // [value, count] pairs — the honest measured data (verification's HEX stage
  // consumes this shape; tokensCss destructures below)
  const top = (m, n = 10) => [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, n);
  const bodyBackground = pageRootStyle ? toHex(pageRootStyle.backgroundColor) || realColor(pageRootStyle.backgroundColor) : null;
  const bodyColor = pageRootStyle ? toHex(pageRootStyle.color) || realColor(pageRootStyle.color) : null;
  return {
    colors: top(colors), backgrounds: top(bgs),
    fonts: top(fonts, 4), fontSizes: top(sizes, 8),
    spacing: top(spacing, 8), radii: top(radii, 6),
    bodyBackground, bodyColor,
    sourceEvidence: { stylesElements: (stylesElements || []).length, designTokens: !!designTokensJson, pageRootStyle: !!pageRootStyle },
  };
}

export function tokensCss(tokens) {
  const lines = [":root {"];
  tokens.colors?.forEach(([c], i) => lines.push(`  --color-${i + 1}: ${c};`));
  tokens.backgrounds?.forEach(([c], i) => lines.push(`  --bg-${i + 1}: ${c};`));
  tokens.fontSizes?.forEach(([c], i) => lines.push(`  --fs-${i + 1}: ${c};`));
  tokens.radii?.forEach(([c], i) => lines.push(`  --radius-${i + 1}: ${c};`));
  lines.push(`  --font-primary: ${tokens.fonts?.[0]?.[0] || "system-ui, sans-serif"};`);
  if (tokens.fonts?.[1]) lines.push(`  --font-secondary: ${tokens.fonts[1][0]};`);
  lines.push("}");
  // the body rule uses the page root's OWN measured background/color when the
  // exploration captured them (G4.1) — when the body is transparent (the common
  // marketing-page case), default to WHITE, never the element-frequency winner:
  // a hero's 60+ colored elements win that vote and paint the whole canvas blue
  // (Tradovate solid-blue clone bug — same class as the nginx black-banner bug)
  const bg = tokens.bodyBackground ? tokens.bodyBackground : "#fff";
  const fg = tokens.bodyColor ? tokens.bodyColor : "var(--color-1, #111)";
  lines.push(`body { margin: 0; background: ${bg}; color: ${fg}; font-family: var(--font-primary); }`);
  return lines.join("\n");
}
