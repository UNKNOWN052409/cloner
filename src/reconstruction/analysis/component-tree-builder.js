// Component-tree builder (spec §3): converts the extracted element list into a
// semantic, named component hierarchy — shell, nav, header, main sections,
// repeated groups, controls — with stable fallback names for uncertain nodes.
export function buildComponentTree(dom, pageId) {
  const els = dom.elements || [];
  if (!els.length) return { name: pageId + "-empty", kind: "empty", children: [], evidence: "no elements" };
  const byIndex = new Map(els.map((e, i) => [i, { ...e, __i: i, children: [] }]));
  const roots = [];
  for (const el of els) {
    const node = byIndex.get(el.__i ?? els.indexOf(el));
    if (!node) continue;
    const p = el.parent;
    if (p !== null && p !== undefined && byIndex.has(p)) byIndex.get(p).children.push(node);
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
