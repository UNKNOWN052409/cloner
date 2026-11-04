// Component-tree builder (spec §3): converts the extracted element list into a
// semantic, named component hierarchy — shell, nav, header, main sections,
// repeated groups, controls — with stable fallback names for uncertain nodes.
export function buildComponentTree(dom, pageId) {
  const els = dom.elements || [];
  if (!els.length) return { name: pageId + "-empty", kind: "empty", children: [], evidence: "no elements" };
  const byIndex = new Map(els.map((e, i) => [i, { ...e, __i: i, children: [] }]));
  // G4.1 self-reverse (vite.dev): the extractor resolves parents by geometric
  // containment (src/intelligence/dom-extractor.js), and real-world DOMs carry
  // equal-rect element pairs (overlay wrappers, styled twins) — each then
  // "contains" the other, forming a parent cycle. The old loop dropped every
  // cycle member from roots, so the ENTIRE subtree became unreachable and the
  // page rendered as an empty shell (99.69% pixel drift). Deterministic repair:
  // elect the smallest-index member of each cycle as the root (capture order),
  // ignore that one parent link, and the whole cycle hangs beneath it.
  // Non-cyclic inputs produce byte-identical output — this only changes inputs
  // that previously yielded an empty tree.
  const onCycle = new Set();
  for (const start of els) {
    const startParent = start.parent;
    if (startParent === null || startParent === undefined || !byIndex.has(startParent)) continue;
    const seen = new Set([start.i]);
    let cur = els[startParent];
    let returned = false;
    while (cur && cur.parent !== null && cur.parent !== undefined && byIndex.has(cur.parent)) {
      if (cur.i === start.i) { returned = true; break; } // back to start after ≥1 hop — start is on a cycle
      if (seen.has(cur.i)) break;                        // entered a cycle that does not include start
      seen.add(cur.i);
      cur = els[cur.parent];
    }
    if (returned || (cur && cur.i === start.i)) onCycle.add(start.i);
  }
  const cycleRoots = new Set();
  const done = new Set();
  for (const i of onCycle) {
    if (done.has(i)) continue;
    const members = [];
    const seen = new Set();
    let cur = els[i];
    while (cur && !seen.has(cur.i) && cur.parent !== null && cur.parent !== undefined && byIndex.has(cur.parent)) {
      seen.add(cur.i);
      members.push(cur.i);
      cur = els[cur.parent];
    }
    for (const m of members) done.add(m);
    if (members.length) cycleRoots.add(Math.min(...members));
  }
  const roots = [];
  for (const el of els) {
    const node = byIndex.get(el.__i ?? els.indexOf(el));
    if (!node) continue;
    const p = el.parent;
    if (cycleRoots.has(el.i)) roots.push(node); // elected root: parent link ignored
    else if (p !== null && p !== undefined && byIndex.has(p)) byIndex.get(p).children.push(node);
    else roots.push(node);
  }
  // semantic naming
  let counter = {};
  const nameOf = (node, depth) => {
    const cls = (node.cls || "").split(/\s+/).filter(Boolean);
    const semantic =
      node.tag === "nav" || node.role === "navigation" ? "Nav" :
      node.tag === "header" ? "Header" :
      node.tag === "footer" ? "Footer" :
      node.tag === "main" ? "Main" :
      node.tag === "aside" ? "Sidebar" :
      node.tag === "form" ? "Form" :
      node.tag === "table" ? "Table" :
      node.tag === "canvas" ? "ChartRegion" :
      /^h[1-6]$/.test(node.tag) ? "Heading" :
      /modal|dialog/i.test(node.cls || "") ? "Modal" :
      /card/i.test(node.cls || "") ? "Card" :
      /btn|button/i.test(node.cls || "") || node.tag === "button" ? "Button" :
      null;
    if (semantic) {
      counter[semantic] = (counter[semantic] || 0) + 1;
      return counter[semantic] > 1 ? `${semantic}${counter[semantic]}` : semantic;
    }
    const base = (cls[0] || node.tag).replace(/[^a-zA-Z0-9]/g, "").replace(/^[^a-zA-Z]/, "") || "Region";
    const name = base.charAt(0).toUpperCase() + base.slice(1);
    counter[name] = (counter[name] || 0) + 1;
    return counter[name] > 1 ? `${name}${counter[name]}` : name;
  };
  const decorate = (node, depth) => ({
    name: nameOf(node, depth),
    tag: node.tag,
    cls: node.cls,
    role: node.role,
    ariaName: node.ariaName,
    dataClonerTrigger: node.dataClonerTrigger || null,
    href: node.href || null,
    src: node.src || null,
    text: node.text,
    rect: node.rect,
    layout: node.layout,
    style: node.style,
    repeated: null, // filled by the repeated-group pass
    children: node.children.map((c) => decorate(c, depth + 1)).slice(0, 60),
    _elementIndex: node.__i,
  });
  const tree = roots.map((r) => decorate(r, 0));
  // repeated-group pass: same class signature with >= 3 siblings
  const byParent = new Map();
  const walk = (nodes) => {
    const sigs = {};
    for (const n of nodes) {
      const sig = (n.cls || "").trim();
      if (sig) sigs[sig] = (sigs[sig] || 0) + 1;
    }
    for (const [sig, n] of Object.entries(sigs)) {
      if (n >= 3) {
        const group = nodes.filter((x) => (x.cls || "").trim() === sig);
        for (const g of group) g.repeated = { group: sig.slice(0, 50), siblings: n };
      }
    }
    nodes.forEach((n) => walk(n.children));
  };
  walk(tree);
  return { name: pageId + "-root", kind: "root", children: tree };
}

// flatten to a render order (parents before children)
export function flattenTree(tree) {
  const out = [];
  const walk = (nodes, depth) => {
    for (const n of nodes) { out.push({ ...n, depth }); walk(n.children, depth + 1); }
  };
  walk(tree.children || [tree], 0);
  return out;
}
