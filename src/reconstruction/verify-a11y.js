// Accessibility contract (split out of verify-flows.js): every interactive
// element needs an accessible name (aria-label / title / aria-labelledby / own
// text), images need alt, keyboard focus must be visible.
//
//   checkA11y(page, { file?, assetMap? })
//     → { violations: [{ severity, offender, rule, fix }],
//         offenders: { unnamed: ["<button #id .cls>", …], noAlt: [...] } }
//     The per-element scan the flow matrix's a11y-name-alt E-case replays;
//     `offenders` keeps the legacy desc-string format the flow-matrix evidence
//     uses. Text inside an aria-hidden="true" subtree names nothing to
//     assistive tech, so a control whose ONLY label is aria-hidden text is a
//     real violation — its visible text is still the honest fix source below.
//     Each violation carries a fix descriptor the repair executor applies
//     deterministically (kind a11y-name / a11y-alt, payload { file, locator,
//     value, source }), or null when nothing honest can be derived:
//       interactive without a name + visible text   → aria-label from that text
//       interactive without a name + no text at all → NO fix (no invented labels)
//       img without alt + assetMap records the alt  → that recorded alt
//       img without alt + descriptive filename      → alt from the filename words
//       img without alt + non-descriptive filename  → alt="" decorative + note
//
//   reportA11yViolations(c, report, res, cap) — wires a flow-matrix a11y E-case:
//   case evidence + per-offender bug entries (the exact contract verify-flows
//   carried before the split).
//
//   a11yFixActions(violations) — fixable violations → ordered repair-executor
//   actions. unfixedBugs(violations) — honest bug entries for the rest.
//
//   checkKeyboardFocus(page) — the keyboard-only focus case: Tab into the page
//   and require a visible focus ring (outline / box-shadow) on the focused
//   control.
//
// Offline by construction: a Playwright page over file:// clone pages only.
export const MAX_A11Y_SCAN = 300; // elements scanned per page — same cap as before the split
export const MAX_LABEL_LEN = 80;  // derived aria-label cap (visible text can be long)

// the in-page scan — one self-contained evaluate (module scope does not cross
// into the page); element rules identical to the pre-split runA11y body
const SCAN = (cap) => {
  const roles = new Set(["button", "link", "tab", "menuitem", "switch", "checkbox", "radio", "option"]);
  const desc = (el) => `<${el.tagName.toLowerCase()}${el.id ? " #" + el.id : ""}${typeof el.className === "string" && el.className ? " ." + el.className.split(/\s+/).slice(0, 2).join(".") : ""}>`;
  // the text assistive tech would name the control by — aria-hidden subtrees
  // are skipped because screen readers never read them
  const namingText = (el) => {
    let t = "";
    const walk = (n) => {
      if (n.nodeType === 3) { t += n.nodeValue; return; }
      if (n.nodeType !== 1) return;
      if (n.getAttribute("aria-hidden") === "true") return;
      for (const c of n.childNodes) walk(c);
    };
    walk(el);
    return t;
  };
  const named = (el) => {
    if (el.getAttribute("aria-label") || el.getAttribute("title")) return true;
    const ref = el.getAttribute("aria-labelledby");
    if (ref && document.getElementById(ref)?.textContent?.trim()) return true;
    if (namingText(el).trim()) return true;
    if (el.tagName.toLowerCase() === "input") {
      if (el.id && document.querySelector(`label[for="${el.id}"]`)) return true;
      if (el.closest("label")) return true;
      if (el.getAttribute("placeholder") || el.value) return true;
    }
    return false;
  };
  // deterministic file locator for the repair executor — ids first, then a
  // distinctive attribute plus the element's index among the same-tag elements
  // matching that attribute value, then the bare tag index (element order in
  // the generated file matches DOM order)
  const locate = (el) => {
    const tag = el.tagName.toLowerCase();
    const idxWhere = (pred) => [...document.querySelectorAll(tag)].filter(pred).indexOf(el);
    if (el.id) return { strategy: "id", tag, id: el.id };
    for (const a of ["data-cloner-trigger", "src", "href", "name"]) {
      const v = el.getAttribute(a);
      if (v) return { strategy: "attr", tag, attr: a, value: v, index: idxWhere((n) => n.getAttribute(a) === v) };
    }
    return { strategy: "path", tag, index: idxWhere(() => true) };
  };
  const out = { unnamed: [], noAlt: [] };
  for (const el of [...document.querySelectorAll("body *")].slice(0, cap)) {
    const tag = el.tagName.toLowerCase();
    const interactive = tag === "button" || tag === "select" || tag === "textarea" ||
      (tag === "input" && (el.getAttribute("type") || "text") !== "hidden") ||
      (tag === "a" && el.hasAttribute("href")) || el.hasAttribute("data-cloner-trigger") || roles.has(el.getAttribute("role") || "");
    if (interactive && !named(el)) {
      out.unnamed.push({
        d: desc(el),
        text: (el.textContent || "").replace(/\s+/g, " ").trim(), // visible text (aria-hidden included) — the fix source
        locator: locate(el),
      });
    }
    if (tag === "img" && !el.hasAttribute("alt")) {
      out.noAlt.push({ d: desc(el), src: el.getAttribute("src") || "", locator: locate(el) });
    }
  }
  return out;
};

// checkA11y(page, { file?, assetMap? }) → { violations, offenders } — see header
export async function checkA11y(page, opts = {}) {
  const file = opts.file || (String(page.url() || "").split("/").pop() || "index.html");
  const assetMap = opts.assetMap instanceof Map ? opts.assetMap
    : (opts.assetMap && typeof opts.assetMap === "object" ? new Map(Object.entries(opts.assetMap)) : new Map());
  const raw = await page.evaluate(SCAN, MAX_A11Y_SCAN);
  const violations = [];
  for (const v of raw.unnamed) {
    violations.push({ severity: "medium", offender: v.d, rule: "accessible-name", fix: nameFix(v, file) });
  }
  for (const v of raw.noAlt) {
    violations.push({ severity: "low", offender: v.d, rule: "image-alt", fix: altFix(v, file, assetMap) });
  }
  return { violations, offenders: { unnamed: raw.unnamed.map((v) => v.d), noAlt: raw.noAlt.map((v) => v.d) } };
}

// name fix — the element's own visible text (textContent, aria-hidden text
// included: that is exactly what sighted users see and what the aria-label
// should carry). Empty text → no fix: an invented label is a guess, not a repair.
function nameFix(v, file) {
  if (!v.text) return null;
  const value = v.text.slice(0, MAX_LABEL_LEN);
  return {
    kind: "a11y-name",
    payload: { file, locator: v.locator, value, source: "text" },
    note: `aria-label set from the element's visible text: "${value}"`,
  };
}

// "assets/hero-banner.png?v=2" → { base: "hero-banner.png", words: ["hero", "banner"] }
function stemWords(src) {
  const base = String(src || "").split(/[?#]/)[0].split("/").pop() || "";
  const words = base.replace(/\.[a-z0-9]+$/i, "").split(/[-_.\s]+/).filter(Boolean);
  return { base, words };
}

// alt fix, most-trusted source first: a recorded original alt from assetMap
// ({ "assets/x.png": { alt: "…" } } — plain string values are remap PATHS, not
// alts, and are ignored), then the image filename's own words, then alt=""
// decorative with an honest note.
function altFix(v, file, assetMap) {
  const { base, words } = stemWords(v.src);
  const bare = String(v.src || "").replace(/^\.\//, "");
  for (const key of [v.src, bare, "/" + bare, base]) {
    const rec = key ? assetMap.get(key) : null;
    const alt = rec && typeof rec === "object" && typeof rec.alt === "string" ? rec.alt.trim() : null;
    if (alt) {
      return { kind: "a11y-alt", payload: { file, locator: v.locator, value: alt, source: "assetmap" }, note: `alt set from the recorded original alt for ${v.src || base}: "${alt}"` };
    }
  }
  if (words.length && !words.every((w) => /^\d+$/.test(w))) {
    const alt = words.join(" ");
    return { kind: "a11y-alt", payload: { file, locator: v.locator, value: alt, source: "filename" }, note: `alt derived from the image filename ${base}: "${alt}"` };
  }
  return {
    kind: "a11y-alt",
    payload: { file, locator: v.locator, value: "", source: "decorative" },
    note: `no recorded alt and filename "${base || v.src || "(none)"}" carries no descriptive words — alt="" marks the image decorative; confirm manually`,
  };
}

// wire a flow-matrix a11y-name-alt E-case from a checkA11y result — the exact
// case evidence + per-offender bug contract verify-flows carried pre-split
// (cap = MAX_CONSOLE there; offenders/bug evidence slice the same way)
export function reportA11yViolations(c, report, res, cap = 5) {
  const unnamed = res.offenders.unnamed;
  const noAlt = res.offenders.noAlt;
  c.evidence.detail = `${unnamed.length} interactive element(s) without an accessible name, ${noAlt.length} image(s) without alt`;
  c.result = unnamed.length || noAlt.length ? "fail" : "pass";
  if (c.result !== "fail") return;
  c.evidence.offenders = { unnamed: unnamed.slice(0, cap), noAlt: noAlt.slice(0, cap) };
  if (unnamed.length) report.bugs.push({ severity: "medium", case: c.id, what: "interactive element without an accessible name (label/aria-label/text)", evidence: { offenders: unnamed.slice(0, cap) } });
  if (noAlt.length) report.bugs.push({ severity: "low", case: c.id, what: "image without an alt attribute", evidence: { offenders: noAlt.slice(0, cap) } });
}

// fixable violations → ordered repair-executor actions with deterministic ids
// (the repair history must be reproducible); priority mirrors the planner's
// severity-first ordering (medium names before low alts)
export function a11yFixActions(violations) {
  return violations
    .filter((v) => v.fix)
    .map((v, i) => ({
      id: `a11y-${String(i + 1).padStart(2, "0")}-${v.fix.kind}`,
      kind: v.fix.kind,
      target: v.offender,
      payload: { ...v.fix.payload },
      severity: v.severity,
      confidence: 0.9,
      priority: v.severity === "medium" ? 0.9 : 0.6,
      reason: v.fix.note,
    }));
}

// the honest residue — violations with no derivable fix stay reported, not
// swept: an unnamed control with no text at all gets no invented label
export function unfixedBugs(violations) {
  return violations.filter((v) => !v.fix).map((v) => ({
    severity: v.severity,
    case: "a11y-repair",
    what: v.rule === "accessible-name"
      ? "interactive element without an accessible name — no visible text to derive a label from, left unfixed (no invented labels)"
      : "image without an alt attribute — no recorded alt and no derivable name, left unfixed",
    evidence: { offender: v.offender, rule: v.rule },
  }));
}

// keyboard-only focus — Tab once from the body and require a visible focus
// ring (outline / box-shadow) on the control that received focus; the flow
// matrix's keyboard-focus E-case consumes the result (moved + visible)
export async function checkKeyboardFocus(page) {
  await page.evaluate(() => document.body.focus()).catch(() => {});
  await page.keyboard.press("Tab");
  return page.evaluate(() => {
    const el = document.activeElement;
    if (!el || el === document.body) return { moved: false };
    const cs = getComputedStyle(el);
    return {
      moved: true, tag: el.tagName.toLowerCase(),
      name: (el.getAttribute("aria-label") || el.textContent || el.getAttribute("data-cloner-trigger") || "").trim().slice(0, 40),
      visible: (cs.outlineStyle !== "none" && parseFloat(cs.outlineWidth) > 0) || (cs.boxShadow && cs.boxShadow !== "none"),
    };
  });
}
