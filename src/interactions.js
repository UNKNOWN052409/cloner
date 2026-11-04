// Interaction recorder + APP EXPLORER: clicks EVERY safe interactive control
// (budget-bounded), snapshots what each one opens, screenshots every discovered
// state, and writes an exploration report documenting behavior — what opens, how
// big, which entries a picker contains. The clone is generated AFTER the app is
// understood, not from the homepage alone.
//
// v3 hardening:
// - LEAF-FIRST marking: containers (div.btn-group) can no longer swallow their real
//   buttons via the "child" reject — icons-only controls (icon-plus) get recorded.
// - PRIORITY exploration: pickers/menus/add/notifications first, unknown last.
// - Records are NEVER dropped: inner/module records survive even when the outer
//   overlay extract fails (old bug: 14 picker entries captured → all lost).
// - Everything bounded: overall budgetMs deadline + per-click deadlines.
// - EXPLORATION REPORT: exploration.json + exploration.md + _reference/states/*.png
import fs from "node:fs";
import path from "node:path";
import { bus } from "./events.js";

const DANGEROUS = /(buy|sell|flatten|reverse|order|submit|confirm|logout|log\s?out|sign\s?out|close|remove|delete|cancel|deposit|withdraw|transfer|place|send|exit|cxl\b)/i;

// Styled-HTML capture for overlays/modules: the clone page does NOT carry the
// source app's stylesheet (hidden replay UI is absent from the static DOM
// capture), so replayed overlays/modules would render as raw unstyled text.
// This bakes computed styles into the captured HTML, making every replay
// self-contained.
//
// Runs on a DETACHED CLONE parked off-screen — the live page is never mutated
// (inlining styles on the live element would change the app's own layout for
// every later recording step). Computed styles still resolve on the clone
// because it IS in the document while being styled; it is removed immediately
// after serialization. ROOT: positioning is neutralized (the replay wrapper
// owns placement from the recorded box) so page-absolute offsets never
// double-offset.
const STYLED_HTML_SRC = `
  (root) => {
    if (!root || root.nodeType !== 1) return null;
    const clone = root.cloneNode(true);
    // park off-screen so computed styles resolve; the real page never changes
    clone.setAttribute("style", "position:fixed;top:-10000px;left:-10000px;visibility:hidden;pointer-events:none;");
    document.body.appendChild(clone);
    const PROPS = ["boxSizing","display","position","top","right","bottom","left","zIndex",
      "width","height","minWidth","minHeight","maxWidth","maxHeight",
      "marginTop","marginRight","marginBottom","marginLeft",
      "paddingTop","paddingRight","paddingBottom","paddingLeft",
      "borderTop","borderRight","borderBottom","borderLeft","borderRadius",
      "background","backgroundColor","backgroundImage","backgroundSize","backgroundRepeat",
      "boxShadow","color","fontFamily","fontSize","fontWeight","fontStyle","lineHeight",
      "textAlign","textTransform","letterSpacing","whiteSpace","textOverflow","textDecoration",
      "opacity","overflow","gap","rowGap","columnGap","flexDirection","flexWrap","alignItems","justifyContent",
      "flex","flexBasis","flexGrow","flexShrink","gridTemplateColumns","gridTemplateRows",
      "transform","cursor","objectFit","verticalAlign","alignSelf","order"];
    // NOTE: "visibility" is deliberately NOT baked — it inherits from the parked
    // clone's hidden state and would freeze "hidden" into every descendant.
    const walk = (el, isRoot) => {
      const cs = getComputedStyle(el);
      for (const p of PROPS) { try { el.style[p] = cs[p]; } catch (e) {} }
      if (isRoot) {
        el.style.position = "relative";
        el.style.top = "0px"; el.style.right = "auto"; el.style.bottom = "auto"; el.style.left = "0px";
        el.style.margin = "0px";
        el.style.visibility = "visible";
        el.style.pointerEvents = ""; // clear the parking guard — replay must be clickable
      }
      for (const k of el.children) walk(k, false);
    };
    try { walk(clone, true); } catch (e) {}
    const html = clone.outerHTML;
    clone.remove();
    return html;
  }
`;

// snapshot canvases inside a subtree → dataURL imgs (charts render in clones)
const SNAP_CANVASES_SRC = `
  (root) => {
    for (const c of root.querySelectorAll("canvas")) {
      try {
        const r = c.getBoundingClientRect();
        if (r.width < 2 || r.height < 2) { c.remove(); continue; }
        const img = document.createElement("img");
        img.src = c.toDataURL("image/png");
        img.alt = "captured canvas";
        const cs = getComputedStyle(c);
        for (const p of ["display","position","inset","top","right","bottom","left","width","height",
          "minWidth","minHeight","maxWidth","maxHeight","margin","verticalAlign","transform",
          "zIndex","borderRadius","objectFit","opacity","visibility"]) img.style[p] = cs[p];
        img.setAttribute("data-cloner-snap", "1");
        c.replaceWith(img);
      } catch (e) {}
    }
  }
`;

// dismiss onboarding popups/toasts that would intercept every click
async function dismissPopups(page) {
  await withDeadline(page
    .evaluate(() => {
      const hide = (el) => { try { el.style.setProperty("display", "none", "important"); } catch (e) {} };
      for (const el of document.querySelectorAll(
        '[class*="popup"],[class*="toast"],[class*="walkthrough"],[class*="walkme"],[class*="coach-mark"],[class*="coachmark"],[class*="tooltip"],[class*="callout"],[class*="banner"],[class*="hint"]',
      )) {
        try {
          const cs = getComputedStyle(el);
          const r = el.getBoundingClientRect();
          if (cs.display === "none" || cs.visibility === "hidden" || r.width < 20) continue;
          if (cs.position !== "fixed" && cs.position !== "absolute") continue;
          const closer =
            el.querySelector('[data-testid="close-button"],[class*="icon-close"],[class*="close-button"],[aria-label="Close"],[aria-label="close"]') ||
            (el.matches('[class*="icon-close"],[data-testid="close-button"]') ? el : null);
          if (closer) closer.click();
          else hide(el);
        } catch (e) {}
      }
      for (const el of document.querySelectorAll("div,i,button,a")) {
        try {
          const cs = getComputedStyle(el);
          if (cs.position !== "fixed" || cs.display === "none" || cs.visibility === "hidden") continue;
          const r = el.getBoundingClientRect();
          if (r.width < 40 || r.height < 20) continue;
          if (r.width > innerWidth * 0.6 || r.height > innerHeight * 0.6) continue;
          if (el.querySelector('[class*="icon-close"],[data-testid="close-button"]') && !el.closest("form")) hide(el);
        } catch (e) {}
      }
    }), 8000, "dismissPopups").catch(() => {});
}

// classify one candidate trigger: {ok, prio, why}
// prio 0 = menu/picker/add-style controls (most valuable), 3 = everything else
// container check happens inside: an element whose class is a *group/toolbar*
// wrapper (btn-group, btn-toolbar, context-toolbar) is never a trigger itself.
const CLASSIFY_SRC = `
  (args) => {
    const dangerous = new RegExp(args.dangerousSrc, "i");
    const idOff = args.idOffset || 0;
    const keep = args.onlyIds ? new Set(args.onlyIds) : null;
    // wrapper patterns: match but never mark — their children are the real controls
    const WRAPPER = /(^|\\s|-)(btn-group|btn-toolbar|toolbar|menu-bar|menubar|context-toolbar|button-group|input-group|tab-bar|nav)(\\s|$)/i;
    const GROUPY = /(group|toolbar|bar|container|wrapper|row|stack)$/i;

    const all = [
      ...document.querySelectorAll(
        'button, [role="button"], [role="tab"], [role="menuitem"], a.btn, [class*="btn"]:not(a[href]), [class*="toggle"]:not(a[href]), [class*="dropdown-trigger"], [class*="toolbar"] [class*="btn"], [class*="toolbar"] [class*="icon"]',
      ),
    ];
    // leaf-first: deepest elements first, so a marked container can never reject a
    // real button below it (the old document-order bug that killed icon-plus).
    // Ties keep original document order (idx) — comparator stays consistent.
    const cands = all.filter((el) => {
      // a bare glyph (div.icon.icon-plus inside .btn-icon) only matters as its
      // parent's click target — mark the CONTROL (carries title/aria-label) instead
      const glyphy = /(^|\\s)(icon|icon-[a-z0-9-]+)(\\s|$)/i.test(String(el.className || "")) && !/[lvac]?btn/i.test(String(el.className || ""));
      if (!glyphy) return true;
      const owner = el.parentElement && el.parentElement.closest('button,[role="button"],[class*="btn"]');
      return !owner;
    }).map((el, idx) => ({ el, idx }));
    cands.sort((x, y) => depth(y.el) - depth(x.el) || x.idx - y.idx);
    function depth(el) { let d = 0; for (let n = el; n && n !== document.body; n = n.parentElement) d++; return d; }

    const rej = { small: 0, href: 0, form: 0, dangerous: 0, inModal: 0, closeIcon: 0, closeClass: 0, wrapper: 0, child: 0, unrecorded: 0 };
    const marked = [];
    for (let pos = 0; pos < cands.length; pos++) {
      const el = cands[pos].el;
      const idx = cands[pos].idx;
      const r = el.getBoundingClientRect();
      if (r.width < 4 || r.height < 4) { rej.small++; continue; }
      // anchor-BUTTONS (href="#" / empty) are app controls, not navigation — keep
      if (el.tagName === "A" && el.getAttribute("href") && !/^(#|javascript:)?$/i.test(el.getAttribute("href").trim())) { rej.href++; continue; }
      if (el.closest("form")) { rej.form++; continue; }
      const cls = String(el.className || "");
      const label = (el.getAttribute("title") || el.getAttribute("aria-label") || el.getAttribute("data-tooltip") || el.getAttribute("data-test") || el.getAttribute("data-testid") || "");
      const txt = ((el.innerText || "").trim() + " " + cls + " " + label);
      if (dangerous.test(txt)) { rej.dangerous++; continue; }
      if (el.closest('[class*="modal"],[class*="dialog"],[class*="popup"],[role="dialog"]')) { rej.inModal++; continue; }
      if (el.querySelector('[class*="icon-close"],[class*="icon-minus"],[class*="icon-collapse"],[class*="trash"],[class*="icon-minimize"],[class*="icon-popout"],[class*="icon-expand"]')) { rej.closeIcon++; continue; }
      if (/close|collapse|minimize|popout|undock|gear|settings|trash|remove|delete/i.test(cls)) { rej.closeClass++; continue; }
      // WRAPPER/GROUPY containers: never mark, never count as child-reject
      if (WRAPPER.test(cls) || (GROUPY.test(cls) && el.querySelector('[class*="btn"],[class*="icon"],button,[role="button"]'))) { rej.wrapper++; continue; }
      if (el.parentElement && el.parentElement.closest("[data-cloner-trigger]")) { rej.child++; continue; }
      const id = "t" + (idOff + idx);
      if (keep && !keep.has(id)) { rej.unrecorded++; continue; }
      if (marked.length >= args.max) continue;
      el.setAttribute("data-cloner-trigger", id);
      // priority: pickers/menus/add-controls first; icon-only-with-label next; rest last
      const inner = (el.innerText || "").trim();
      let prio = 3;
      if (/plus|add|menu|dropdown|picker|new|create|more|ellipsis|kebab|chevron|caret|notif|bell|inbox|message|account|profile|help|panel|search|ticker|balance|settings/i.test(cls + " " + label)) prio = 0;
      else if (!inner && (label || el.getAttribute("data-testid"))) prio = 1; // icon-only with accessible name/testid
      else if (inner && inner.length <= 24) prio = 2;
      marked.push({ id, text: (label || inner).trim().slice(0, 40), prio, w: Math.round(r.width), h: Math.round(r.height) });
    }
    marked.sort((a, b) => a.prio - b.prio);
    return { marked, total: all.length, rej };
  }
`;

// Passive: mark candidate triggers with data-cloner-trigger ids (no clicking).
export async function markTriggers(page, { max = 60, onlyIds = null, idOffset = 0 } = {}) {
  let res = null;
  let lastErr = null;
  for (let attempt = 0; attempt < 3 && !res; attempt++) {
    try {
      // call the page function at evaluate time: (SRC)(args) — compiled with an
      // "args" parameter so the reference resolves inside the evaluate scope
      res = await withDeadline(
        page.evaluate(new Function("args", "return (" + CLASSIFY_SRC + ")(args)"), {
          dangerousSrc: DANGEROUS.source,
          max,
          idOffset,
          onlyIds: onlyIds ? [...onlyIds] : null,
        }),
        10000,
        "markTriggers",
      );
    } catch (e) {
      lastErr = e;
      await page.waitForTimeout(1200).catch(() => {});
    }
  }
  if (!res) {
    bus.emit("log", { level: "warn", msg: `markTriggers failed after retries: ${String(lastErr?.message || "").slice(0, 90)}` });
    return { marked: [], total: 0, rej: {} };
  }
  bus.emit("log", {
    level: "info",
    msg: `trigger candidates: ${res.total} raw → ${res.marked.length} marked | rejects: ${JSON.stringify(res.rej)}`,
  });
  return res;
}

// run a promise with a hard wall-clock deadline (Promise.race) — nothing inside
// the browser can stall the pipeline beyond `ms` anymore.
function withDeadline(p, ms, what) {
  let t;
  const guard = new Promise((_, rej) => {
    t = setTimeout(() => rej(new Error(`${what} deadline ${ms}ms exceeded`)), ms);
  });
  return Promise.race([p, guard]).finally(() => clearTimeout(t));
}

// find the largest visible modal-ish overlay (the newly-opened picker/dialog),
// mark it live, and report how many clickable entries it contains
async function locateOverlay(page) {
  return withDeadline(
    page
      .evaluate(() => {
        const visible = (el) => {
          const r = el.getBoundingClientRect();
          const cs = getComputedStyle(el);
          return r.width > 80 && r.height > 40 && cs.display !== "none" && cs.visibility !== "hidden" && parseFloat(cs.opacity || "1") > 0.1;
        };
        const overlays = [
          ...document.querySelectorAll(
            '[class*="modal"],[class*="dropdown"],[class*="popup"],[class*="popover"],[class*="menu"],[class*="dialog"],[class*="picker"],[role="dialog"],[role="menu"],[role="listbox"]',
          ),
        ].filter(visible);
        if (!overlays.length) return { found: false, entries: 0 };
        let target = overlays[0];
        let bestArea = 0;
        for (const el of overlays) {
          const r = el.getBoundingClientRect();
          const a = r.width * r.height;
          if (a > bestArea) { bestArea = a; target = el; }
        }
        target.setAttribute("data-cloner-live", "1");
        const root = document.querySelector('[data-cloner-live="1"]');
        const entries = root
          ? [...root.querySelectorAll('a,[role="button"],[role="menuitem"],[class*="item"],li')].filter((el) => {
              const r = el.getBoundingClientRect();
              const t = (el.innerText || "").trim().split("\\n")[0];
              return r.width > 40 && r.height > 25 && t && t.length <= 40;
            }).length
          : 0;
        return { found: true, entries };
      })
      .catch(() => ({ found: false, entries: 0 })),
    8000,
    "locateOverlay",
  );
}

// extract the live-marked overlay html (with inner marks baked in)
async function extractOverlay(page) {
  return withDeadline(
    page
      .evaluate(new Function(
        "return (" + SNAP_CANVASES_SRC + ")(document.querySelector('[data-cloner-live=\"1\"]') || document.body)," +
        " (function () { const t = document.querySelector('[data-cloner-live=\"1\"]'); if (!t) return null; const r = t.getBoundingClientRect();" +
        " const out = { html: ((" + STYLED_HTML_SRC + ")(t) || t.outerHTML).slice(0, 200000), box: { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) } };" +
        " t.removeAttribute('data-cloner-live'); return out; })()",
      ))
      .catch(() => null),
    10000,
    "extractOverlay",
  );
}

// mark clickable entries inside the live (open) picker overlay — ids use a session
// counter so multiple pickers never collide on the same id
async function markInnerItems(page, skipTexts, counterOffset) {
  return withDeadline(
    page
      // playwright evaluate takes EXACTLY ONE argument — the old two-arg call threw
      // "Too many arguments", the .catch swallowed it, and inner capture silently
      // never ran (the missing "picker entries marked" logs)
      .evaluate(({ skip, offset }) => {
        const root = document.querySelector('[data-cloner-live="1"]');
        if (!root) return [];
        const out = [];
        const seen = new Set();
        for (const el of root.querySelectorAll('a,[role="button"],[role="menuitem"],[class*="item"],li')) {
          const r = el.getBoundingClientRect();
          const t = (el.innerText || "").trim().split("\\n")[0];
          if (r.width < 40 || r.height < 25 || !t || t.length > 40) continue;
          if (seen.has(t) || skip.indexOf(t) >= 0) continue;
          if (el.parentElement && el.parentElement.closest("[data-cloner-inner]")) continue;
          const id = "m" + (offset + out.length);
          el.setAttribute("data-cloner-inner", id);
          seen.add(t);
          out.push({ id, text: t.slice(0, 30) });
          if (out.length >= 14) break;
        }
        return out;
      }, { skip: [...skipTexts], offset: counterOffset })
      .catch((e) => {
        bus.emit("log", { level: "warn", msg: `markInnerItems failed: ${String(e?.message || e).slice(0, 70)}` });
        return [];
      }),
    8000,
    "markInnerItems",
  );
}

async function pickerStillOpen(page) {
  return withDeadline(
    page.evaluate(() => !!document.querySelector('[data-cloner-live="1"]')),
    4000,
    "pickerStillOpen",
  ).catch(() => false);
}

// close a just-added module (its own ✕, else JS remove — the serialize happens on
// this same live DOM so leftovers would leak; marker keeps track)
async function closeAddedModules(page) {
  await withDeadline(page
    .evaluate(() => {
      for (const added of document.querySelectorAll('[data-cloner-added="1"]')) {
        try {
          const closer = added.querySelector('[data-testid="close-button"],[class*="icon-close"],[class*="close-button"]');
          if (closer) closer.click();
          added.removeAttribute("data-cloner-added");
        } catch (e) {}
      }
    }), 6000, "closeAddedModules.click").catch(() => {});
  await page.waitForTimeout(350);
  await withDeadline(page
    .evaluate(() => {
      for (const added of document.querySelectorAll('[data-cloner-added="1"]')) {
        try { added.remove(); } catch (e) {}
      }
    }), 6000, "closeAddedModules.remove").catch(() => {});
}

// DEDICATED MODULE-PICKER PASS: the "+" toolbar button opens the app's module
// picker (Market Analyzer, Orders, Options Chain, Code Editor, Chat, …) — the
// richest interaction in trading apps. Generic exploration is variance-prone
// (toggle open/closed, timing), so this pass guarantees: picker opens → EVERY
// entry is clicked → each module panel is captured → picker record wired to the
// pre-marked "+" trigger so the clone's + button opens the real picker.
async function pickerPass(page, { waitMs, deadline, statesDir, behaviors, seenSigs, results }) {
  const addId = await page
    .evaluate(() => {
      const el =
        document.querySelector('[title="Add module"][data-cloner-trigger]') ||
        document.querySelector('[aria-label="Add module"][data-cloner-trigger]') ||
        document.querySelector('.btn-icon[data-cloner-trigger][class*="icon-plus"]');
      return el ? el.getAttribute("data-cloner-trigger") : null;
    })
    .catch(() => null);
  if (!addId) return 0;
  const sel = `[data-cloner-trigger="${addId}"]`;
  await page.evaluate(() => { document.querySelectorAll("[data-cloner-overlay]").forEach((n) => n.remove()); }).catch(() => {});
  await page.click(sel, { timeout: 4000 }).catch(() => {});
  await page.waitForTimeout(waitMs + 400);
  let located = await locateOverlay(page);
  if (!located.found) {
    // toggle may have closed it — one more click
    await page.click(sel, { timeout: 3000 }).catch(() => {});
    await page.waitForTimeout(waitMs);
    located = await locateOverlay(page);
    if (!located.found) return 0;
  }
  const counter = { n: 0 };
  // ATOMIC mark+extract in ONE evaluate: marking entries and grabbing the picker
  // html separately loses marks to React re-renders between the two calls — this
  // way the overlay record ships with ALL wired entries, guaranteed.
  const marked = await withDeadline(
    page.evaluate((base) => {
      const root = document.querySelector('[data-cloner-live="1"]');
      if (!root) return { items: [], html: null };
      const out = [];
      const seen = new Set();
      for (const el of root.querySelectorAll('a,[role="button"],[role="menuitem"],[class*="item"],li')) {
        const r = el.getBoundingClientRect();
        const txt = (el.innerText || "").trim().split("\n")[0];
        if (r.width < 40 || r.height < 25 || !txt || txt.length > 40) continue;
        if (seen.has(txt)) continue;
        if (el.parentElement && el.parentElement.closest("[data-cloner-inner]")) continue;
        const id = "m" + (base + out.length);
        el.setAttribute("data-cloner-inner", id);
        seen.add(txt);
        out.push({ id, text: txt.slice(0, 30) });
        if (out.length >= 14) break;
      }
      const box = root.getBoundingClientRect();
      // bake computed styles onto a detached clone — the live page is never
      // mutated; helper body is INLINED literally because this evaluate body
      // never sees Node-side constants
      const styledRoot = (function captureStyledClone(src) {
        const clone = src.cloneNode(true);
        clone.setAttribute("style", "position:fixed;top:-10000px;left:-10000px;visibility:hidden;pointer-events:none;");
        document.body.appendChild(clone);
        const PROPS = ["boxSizing","display","position","top","right","bottom","left","zIndex",
          "width","height","minWidth","minHeight","maxWidth","maxHeight",
          "marginTop","marginRight","marginBottom","marginLeft",
          "paddingTop","paddingRight","paddingBottom","paddingLeft",
          "borderTop","borderRight","borderBottom","borderLeft","borderRadius",
          "background","backgroundColor","backgroundImage","backgroundSize","backgroundRepeat",
          "boxShadow","color","fontFamily","fontSize","fontWeight","fontStyle","lineHeight",
          "textAlign","textTransform","letterSpacing","whiteSpace","textOverflow","textDecoration",
          "opacity","overflow","gap","rowGap","columnGap","flexDirection","flexWrap","alignItems","justifyContent",
          "flex","flexBasis","flexGrow","flexShrink","gridTemplateColumns","gridTemplateRows",
          "transform","cursor","objectFit","verticalAlign","alignSelf","order"];
        const walk = (el, isRoot) => {
          const cs = getComputedStyle(el);
          for (const p of PROPS) { try { el.style[p] = cs[p]; } catch (e) {} }
          if (isRoot) {
            el.style.position = "relative";
            el.style.top = "0px"; el.style.right = "auto"; el.style.bottom = "auto"; el.style.left = "0px";
            el.style.margin = "0px";
            el.style.visibility = "visible";
            el.style.pointerEvents = "";
          }
          for (const k of el.children) walk(k, false);
        };
        try { walk(clone, true); } catch (e) {}
        const html = clone.outerHTML;
        clone.remove();
        return html;
      })(root);
      const html = (styledRoot || root.outerHTML).slice(0, 200000);
      root.removeAttribute("data-cloner-live");
      return { items: out, html, box: { x: Math.round(box.left), y: Math.round(box.top), w: Math.round(box.width), h: Math.round(box.height) } };
    }, counter.n),
    10000,
    "pickerMarkExtract",
  ).catch(() => ({ items: [], html: null }));
  counter.n += marked.items.length;
  let items = marked.items;
  const pickerCap = marked.html ? { html: marked.html, box: marked.box } : null;
  located = await locateOverlay(page);
  if (!located.found) {
    await page.click(sel, { timeout: 4000 }).catch(() => {});
    await page.waitForTimeout(waitMs);
    located = await locateOverlay(page);
  }
  const innerRecords = await captureInner(
    page,
    waitMs,
    async () => {
      await page.click(sel, { timeout: 4000 }).catch(() => {});
      await page.waitForTimeout(waitMs);
      return (await locateOverlay(page)).found;
    },
    counter,
    deadline,
    items,
  );
  results.push(...innerRecords);
  const cap = pickerCap && pickerCap.html && pickerCap.html.length > 300 ? pickerCap : await extractOverlay(page);
  let added = innerRecords.length;
  if (cap && cap.html && cap.html.length > 300) {
    results.push({ id: addId, text: "Add module", kind: "overlay", html: cap.html, box: cap.box });
    added++;
  }
  behaviors.push({
    trigger: { id: addId, label: "Add module (picker)" },
    opens: cap?.box ? { kind: "overlay", x: cap.box.x, y: cap.box.y, w: cap.box.w, h: cap.box.h } : null,
    childPanels: innerRecords.map((r) => ({ text: r.text, kind: r.kind, x: r.box?.x, y: r.box?.y, w: r.box?.w, h: r.box?.h })),
    screenshot: null,
  });
  if (statesDir) {
    const shot = path.join(statesDir, `picker-${addId}.png`);
    await page.screenshot({ path: shot, timeout: 8000 }).catch(() => {});
    if (fs.existsSync(shot)) behaviors[behaviors.length - 1].screenshot = path.relative(statesDir, shot).replace(/\\/g, "/");
  }
  seenSigs.add("add module");
  seenSigs.add("");
  await page.keyboard.press("Escape").catch(() => {});
  await page.evaluate(() => { document.querySelectorAll("[data-cloner-overlay]").forEach((n) => n.remove()); }).catch(() => {});
  bus.emit("log", { level: "info", msg: `module picker pass: ${added} record(s) — ${innerRecords.map((r) => r.text).slice(0, 6).join(", ")}` });
  return added;
}

// TOPBAR PASS: the .app-controls strip (add-module, trade, search, notifications,
// balance, settings) — each control's overlay is captured explicitly and recorded
// against its PRE-MARKED trigger id, so the clone's topbar is fully wired.
async function topbarPass(page, { waitMs, deadline, statesDir, behaviors, results, seenSigs, counter }) {
  const controls = await page
    .evaluate(() =>
      [...document.querySelectorAll(".app-controls .btn-wrap")].map((w) => {
        const marked = w.querySelector("[data-cloner-trigger]") || (w.hasAttribute("data-cloner-trigger") ? w : null);
        const clickable = marked || w.querySelector("a, button, [role=button]") || w;
        const r = clickable.getBoundingClientRect();
        return {
          id: marked ? marked.getAttribute("data-cloner-trigger") : null,
          cls: String(w.className).slice(0, 60),
          x: Math.round(r.x + r.width / 2),
          y: Math.round(r.y + r.height / 2),
        };
      }).filter((c) => c.id),
    )
    .catch(() => []);
  bus.emit("log", { level: "info", msg: `topbar pass: ${controls.length} control(s) with pre-marked triggers` });
  for (const c of controls) {
    if (Date.now() > deadline) break;
    if (results.some((r) => r.id === c.id)) continue;
    const label = (c.cls.match(/add-module|trade|search|notification|balance|settings|account/) || ["topbar-control"])[0];
    try {
      await page.click(`[data-cloner-trigger="${c.id}"]`, { timeout: 3000 }).catch(() => {});
      await page.waitForTimeout(waitMs + 200);
      const located = await locateOverlay(page);
      let cap = located.found ? await extractOverlay(page) : null;
      let innerRecords = [];
      if (located.found && located.entries >= 5) {
        innerRecords = await captureInner(page, waitMs, async () => {
          await page.click(`[data-cloner-trigger="${c.id}"]`, { timeout: 3000 }).catch(() => {});
          await page.waitForTimeout(waitMs);
          return (await locateOverlay(page)).found;
        }, counter, deadline);
      }
      if (innerRecords.length) results.push(...innerRecords);
      if (!cap) cap = located.found ? await extractOverlay(page) : null;
      if (cap && cap.html && cap.html.length > 300) {
        results.push({ id: c.id, text: label, kind: "overlay", html: cap.html, box: cap.box });
        behaviors.push({
          trigger: { id: c.id, label },
          opens: { kind: "overlay", x: cap.box.x, y: cap.box.y, w: cap.box.w, h: cap.box.h },
          childPanels: innerRecords.map((r) => ({ text: r.text, kind: r.kind, x: r.box?.x, y: r.box?.y, w: r.box?.w, h: r.box?.h })),
          screenshot: null,
        });
        if (statesDir) {
          const shot = path.join(statesDir, `topbar-${c.id}-${label}.png`);
          await page.screenshot({ path: shot, timeout: 8000 }).catch(() => {});
          if (fs.existsSync(shot)) behaviors[behaviors.length - 1].screenshot = path.relative(statesDir, shot).replace(/\\/g, "/");
        }
        seenSigs.add(label);
        bus.emit("log", { level: "info", msg: `topbar captured: ${label} → overlay ${cap.box.w}x${cap.box.h}` });
      }
      // close whatever opened
      await page.keyboard.press("Escape").catch(() => {});
      await page.evaluate(() => { document.querySelectorAll("[data-cloner-overlay],[data-cloner-module]").forEach((n) => n.remove()); }).catch(() => {});
      await page.waitForTimeout(250);
    } catch (e) {
      bus.emit("log", { level: "warn", msg: `topbar control ${c.id} failed: ${e.message.slice(0, 60)}` });
    }
  }
}

// while a menu/picker overlay is open: click each entry, and snapshot what it
// produces — an added module panel or a child dialog. preItems: entries already
// marked by the caller (pickerPass) — skip re-marking.
async function captureInner(page, waitMs, reopen, counter, deadline, preItems = null) {
  const records = [];
  const done = new Set();
  let items = preItems || (await (async () => {
    const marked = await markInnerItems(page, done, counter.n);
    counter.n += marked.length;
    if (marked.length) bus.emit("log", { level: "info", msg: `picker entries marked inside overlay: ${marked.length}` });
    return marked;
  })());
  if (!items.length) return records;

  let guard = 0;
  while (items.length && guard < 24) {
    if (Date.now() > deadline) { bus.emit("log", { level: "warn", msg: "inner capture budget exhausted — stopping" }); break; }
    guard++;
    const it = items.shift();
    done.add(it.text);

    const before = await withDeadline(page
      .evaluate(() =>
        [...document.querySelectorAll('[class*="module"],[class*="panel"],[class*="window"],[class*="grid-item"]')]
          .filter((el) => {
            const r = el.getBoundingClientRect();
            const cs = getComputedStyle(el);
            return r.width > 250 && r.height > 140 && cs.display !== "none" && cs.visibility !== "hidden";
          })
          .map((el) => el.outerHTML.length + "@" + Math.round(el.getBoundingClientRect().left) + "," + Math.round(el.getBoundingClientRect().top))
          .join("|"),
      ), 6000, "captureInner.before")
      .catch(() => "");

    await page.click(`[data-cloner-inner="${it.id}"]`, { timeout: 3000 }).catch(async () => {
      // picker entries re-render/animate — one retry after a settle beats skipping
      await page.waitForTimeout(700);
      await page.click(`[data-cloner-inner="${it.id}"]`, { timeout: 3000 }).catch((e2) =>
        bus.emit("log", { level: "warn", msg: `inner click failed ${it.id}: ${e2.message.slice(0, 60)}` }),
      );
    });
    await page.waitForTimeout(waitMs);

    const cap = await withDeadline(page
      .evaluate(new Function(
        "return (" + SNAP_CANVASES_SRC + ")(document.body), (function (before) {" +
        " const keys = new Set((before || '').split('|'));" +
        " const panels = [...document.querySelectorAll('[class*=\"module\"],[class*=\"panel\"],[class*=\"window\"],[class*=\"grid-item\"]')]" +
        "  .filter(el => { const r = el.getBoundingClientRect(); const cs = getComputedStyle(el); return r.width > 250 && r.height > 140 && cs.display !== 'none' && cs.visibility !== 'hidden' && !keys.has(el.outerHTML.length + '@' + Math.round(r.left) + ',' + Math.round(r.top)); });" +
        " if (panels.length) { const t = panels[panels.length - 1]; t.setAttribute('data-cloner-added','1'); const r = t.getBoundingClientRect();" +
        "  return { kind: 'module', html: ((" + STYLED_HTML_SRC + ")(t) || t.outerHTML).slice(0, 180000), box: { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) } }; }" +
        " const overlays = [...document.querySelectorAll('[class*=\"modal\"],[class*=\"dialog\"],[role=\"dialog\"],[class*=\"picker\"],[class*=\"popup\"]')]" +
        "  .filter(el => { const r = el.getBoundingClientRect(); const cs = getComputedStyle(el); return r.width > 300 && r.height > 200 && cs.display !== 'none' && cs.visibility !== 'hidden' && !keys.has(el.outerHTML.length + '@' + Math.round(r.left) + ',' + Math.round(r.top)); });" +
        " if (overlays.length) { const t = overlays[overlays.length - 1]; const r = t.getBoundingClientRect();" +
        "  return { kind: 'overlay', html: ((" + STYLED_HTML_SRC + ")(t) || t.outerHTML).slice(0, 120000), box: { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) } }; }" +
        " return null; })(" + JSON.stringify(before) + ")",
      )), 12000, "captureInner.cap")
      .catch(() => null);

    if (cap && cap.html && cap.html.length > 300) {
      records.push({ id: it.id, text: it.text, kind: cap.kind, html: cap.html, box: cap.box });
      bus.emit("log", { level: "info", msg: `inner captured: ${it.id} "${it.text}" → ${cap.kind} ${cap.box.w}x${cap.box.h}` });
    }

    // restore: close added modules; dismiss child overlays with Escape
    await closeAddedModules(page);
    if (cap && cap.kind === "overlay") {
      await page.keyboard.press("Escape").catch(() => {});
      await page.waitForTimeout(250);
    }

    // re-locate the picker (React re-renders wipe our live marker); reopen via the
    // trigger if the app closed it — then re-mark the remaining entries
    let located = await locateOverlay(page);
    if (!(located.found && located.entries >= 5)) {
      const ok = reopen ? await reopen() : false;
      located = ok ? await locateOverlay(page) : { found: false };
    }
    if (!(located.found && located.entries >= 5)) {
      bus.emit("log", { level: "info", msg: "picker gone after entry — inner capture done" });
      break;
    }
    items = await markInnerItems(page, done, counter.n);
    counter.n += items.length;
  }
  return records;
}

// one exploration pass over the live page. Returns records; never throws.
async function explorePass(page, { max, waitMs, triggerMax, deadline, label, seenSigs, behaviors, statesDir, preMarked = null, idOffset = 0 }) {
  const results = [];
  // pass 1 with preMarked: the caller already marked (and serialized) the pristine
  // DOM — reuse those exact ids so runtime records match the frozen HTML. Pass 2
  // re-marks fresh controls with an id offset (their records ride the runtime's
  // text-signature fallback since the pristine HTML is already frozen).
  let marked;
  if (preMarked) {
    marked = preMarked;
  } else {
    marked = (await markTriggers(page, { max: triggerMax, idOffset })).marked || [];
  }
  if (!marked.length) return results;

  const innerCounter = { n: 0 };
  for (const m of marked.slice(0, max)) {
    if (Date.now() > deadline) {
      bus.emit("log", { level: "warn", msg: `${label}: interaction budget exhausted — ${results.length} record(s) so far` });
      break;
    }
    const sig = (m.text || "").trim().toLowerCase();
    if (sig && seenSigs.has(sig)) continue; // same control already recorded this session
    const sel = `[data-cloner-trigger="${m.id}"]`;
    try {
      const opened = await withDeadline(
        page
          .evaluate((s) => {
            const el = document.querySelector(s);
            if (!el) return { found: false, visible: false };
            el.scrollIntoView({ block: "center" });
            // visibility probe (same basics Playwright's actionability check waits
            // for): an earlier trigger's click can legitimately hide this one
            // (e.g. a pane collapse display:none's its sibling ✕ button) — the
            // click could only ever burn its full timeout, so report it instead.
            const r = el.getBoundingClientRect();
            const cs = getComputedStyle(el);
            return {
              found: true,
              visible: r.width > 0 && r.height > 0 && cs.display !== "none" && cs.visibility !== "hidden",
            };
          }, sel),
        5000,
        "explorePass.scroll",
      ).catch(() => false);
      if (!opened || !opened.found) continue;
      if (!opened.visible) {
        bus.emit("log", { level: "info", msg: `trigger ${m.id} hidden by a previous interaction — skipped (no click timeout)` });
        continue;
      }
      await page.click(sel, { timeout: 3000 }).catch((e) =>
        bus.emit("log", { level: "warn", msg: `click failed on ${m.id}: ${e.message.slice(0, 70)}` }),
      );
      await page.waitForTimeout(waitMs);

      const located = await locateOverlay(page);
      let cap = null;
      const innerRecords = [];
      if (located.found && located.entries >= 5) {
        // menu/picker with real content — go one level deep; reopen the picker if
        // the app closes it between entry clicks
        const reopen = async () => {
          try {
            await page.click(sel, { timeout: 3000 });
            await page.waitForTimeout(waitMs);
            const again = await locateOverlay(page);
            return again.found;
          } catch (e) {
            return false;
          }
        };
        innerRecords.push(...(await captureInner(page, waitMs, reopen, innerCounter, deadline)));
        cap = await extractOverlay(page);
      } else if (located.found) {
        cap = await extractOverlay(page);
      }

      // FIX (lost-records bug): push inner records FIRST, gated on their own success —
      // the outer overlay extract failing must not take 14 module captures with it.
      if (innerRecords.length) results.push(...innerRecords);

      // cleanup leftovers so nothing leaks into the serialized clone
      await withDeadline(page
        .evaluate(() => {
          const modalish =
            '[class*="modal"],[class*="fade"],[class*="backdrop"],[class*="overlay"],[class*="dropdown"],[class*="popup"],[class*="popover"],[class*="dialog"],[class*="picker"],[role="dialog"],[role="menu"],[role="listbox"]';
          for (const el of document.querySelectorAll(modalish)) {
            try {
              const cs = getComputedStyle(el);
              if (cs.display === "none" || cs.visibility === "hidden") continue;
              const pos = cs.position;
              if (pos !== "fixed" && pos !== "absolute") continue;
              const r = el.getBoundingClientRect();
              if (pos === "fixed" || r.height > innerHeight * 0.6) el.remove();
            } catch (e) {}
          }
        }), 6000, "explorePass.cleanup")
        .catch(() => {});

      if (cap && cap.html && cap.html.length > 300) {
        results.push({ id: m.id, text: m.text, kind: "overlay", html: cap.html, box: cap.box });
        // mark this control as recorded only if the overlay looks the same as a
        // previous one for this text — different size/shape overlays are new content
        const dupOfPrev = results.some(
          (r, i) =>
            i < results.length - 1 &&
            (r.text || "").trim().toLowerCase() === sig &&
            r.kind === "overlay" &&
            Math.abs(r.box.w - cap.box.w) < 40 &&
            Math.abs(r.box.h - cap.box.h) < 40,
        );
        if (!dupOfPrev) seenSigs.add(sig);
        bus.emit("log", { level: "info", msg: `interaction captured: ${m.id} "${m.text || ""}" → overlay ${cap.box.w}x${cap.box.h}` });
      }

      // EXPLORATION: document what this control does + screenshot the state —
      // every button/menu/notification behavior lands in the exploration report
      if ((cap && cap.html && cap.html.length > 300) || innerRecords.length) {
        behaviors.push({
          trigger: { id: m.id, label: (m.text || sig || "").slice(0, 60) },
          opens: cap?.box ? { kind: "overlay", x: cap.box.x, y: cap.box.y, w: cap.box.w, h: cap.box.h } : null,
          childPanels: innerRecords.map((r) => ({ text: r.text, kind: r.kind, x: r.box?.x, y: r.box?.y, w: r.box?.w, h: r.box?.h })),
          screenshot: null,
        });
        if (statesDir) {
          const slug = String(m.text || sig || m.id).replace(/[^a-z0-9]+/gi, "-").slice(0, 28) || m.id;
          const shot = path.join(statesDir, `${m.id}-${slug}.png`);
          await page.screenshot({ path: shot, timeout: 8000 }).catch(() => {});
          if (fs.existsSync(shot)) behaviors[behaviors.length - 1].screenshot = path.relative(statesDir, shot).replace(/\\/g, "/");
        }
      }
    } catch (e) {
      bus.emit("log", { level: "warn", msg: `interaction failed on ${m.id}: ${e.message.slice(0, 80)}` });
    }
  }
  return results;
}

// record interactions in TWO passes on the live page:
//  pass 1 — top-priority controls (pickers, add-buttons, menus) + the rest
//  pass 2 — re-mark and catch controls that only APPEARED because of pass-1
//           clicks (toolbars that reveal options, tabs that mount panes)
// The caller serializes the SAME live DOM afterwards (no reload), so every
// data-cloner-* attribute written here is exactly what the runtime replays.
// PRISTINE-FIRST mode: the caller pre-marks the pristine DOM and serializes it
// BEFORE this recorder runs — pass 1 replays those exact ids; the live DOM may
// be mutated freely afterwards without ever contaminating the frozen clone.
export async function recordInteractions(page, { max = 14, waitMs = 1100, triggerMax = 60, budgetMs = 100000, outDir = null, preMarked = null } = {}) {
  const deadline = Date.now() + budgetMs;
  await dismissPopups(page);
  const statesDir = outDir ? path.join(outDir, "_reference", "states") : null;
  if (statesDir) { try { fs.mkdirSync(statesDir, { recursive: true }); } catch {} }
  const behaviors = []; // exploration report: what each control opens

  const seenSigs = new Set(); // dedupe: one record per unique control text
  let results = [];
  // picker pass FIRST (pristine mode only): guarantees the + module picker and all
  // its tabs are captured before the generic exploration spends the budget
  if (preMarked) {
    try {
      const n = await pickerPass(page, { waitMs, deadline, statesDir, behaviors, seenSigs, results });
      if (n) bus.emit("log", { level: "info", msg: `picker pass captured ${n} record(s)` });
    } catch (e) {
      bus.emit("log", { level: "warn", msg: `picker pass failed: ${e.message.slice(0, 80)}` });
    }
    // topbar pass: capture every .app-controls strip overlay (trade, search,
    // notifications, balance, settings) against its pre-marked trigger id
    try {
      await topbarPass(page, { waitMs, deadline, statesDir, behaviors, results, seenSigs, counter: { n: 0 } });
    } catch (e) {
      bus.emit("log", { level: "warn", msg: `topbar pass failed: ${e.message.slice(0, 80)}` });
    }
  }
  try {
    results.push(...(await explorePass(page, { max, waitMs, triggerMax, deadline, label: "pass1", seenSigs, behaviors, statesDir, preMarked })));
  } catch (e) {
    bus.emit("log", { level: "warn", msg: `interaction pass1 failed: ${e.message.slice(0, 80)}` });
  }

  // pass 2: only if budget remains — catches newly-revealed controls (ids offset
  // by 500 so they never collide with pass-1 records; the pristine HTML doesn't
  // carry their attrs, so they replay via the runtime's text-signature fallback)
  if (Date.now() < deadline - 15000) {
    try {
      await dismissPopups(page);
      const before = results.length;
      results.push(...(await explorePass(page, { max: Math.min(max, 10), waitMs: Math.min(waitMs, 900), triggerMax, deadline, label: "pass2", seenSigs, behaviors, statesDir, idOffset: 500 })));
      if (results.length > before) {
        bus.emit("log", { level: "info", msg: `pass2 discovered ${results.length - before} additional interaction(s)` });
      }
    } catch (e) {
      bus.emit("log", { level: "warn", msg: `interaction pass2 failed: ${e.message.slice(0, 80)}` });
    }
  }

  // EXPLORATION REPORT — machine + human readable behavior documentation
  if (outDir && behaviors.length) {
    try {
      fs.writeFileSync(path.join(outDir, "exploration.json"), JSON.stringify({ generatedAt: new Date().toISOString(), statesDir: "_reference/states", behaviors }, null, 2));
      const md = [
        "# App exploration report",
        "",
        `Recorded behavior of ${behaviors.length} interactive control(s) — clone runtime replays every one of these.`,
        "",
        "| Trigger | Opens | Discovered panels / entries | State screenshot |",
        "|---|---|---|---|",
        ...behaviors.map(
          (b) =>
            `| ${b.trigger.label || b.trigger.id} | ${b.opens ? `overlay ${b.opens.w}×${b.opens.h}` : "—"} | ${b.childPanels.length ? b.childPanels.map((c) => `${c.text} (${c.w}×${c.h})`).join(", ") : "—"} | ${b.screenshot ? `\`_reference/${b.screenshot.replace(/^_reference\//, "")}\`` : "—"} |`,
        ),
      ].join("\n");
      fs.writeFileSync(path.join(outDir, "exploration.md"), md);
      bus.emit("log", { level: "info", msg: `exploration report: ${behaviors.length} behavior(s) documented + ${behaviors.filter((b) => b.screenshot).length} state screenshot(s)` });
    } catch (e) {
      bus.emit("log", { level: "warn", msg: `exploration report failed: ${e.message.slice(0, 70)}` });
    }
  }

  // clear any stuck overlay + prune pass-2-only marks that have no record so the
  // serialized DOM doesn't carry dead trigger attributes
  await page.keyboard.press("Escape").catch(() => {});
  await page.mouse.click(8, 300).catch(() => {});
  await page.waitForTimeout(300);
  try {
    const recorded = new Set(results.map((r) => r.id));
    await withDeadline(page.evaluate((ids) => {
      const set = new Set(ids); // arrives as an Array over the wire — .has() needs a Set
      for (const el of document.querySelectorAll("[data-cloner-trigger],[data-cloner-inner]")) {
        const id = el.getAttribute("data-cloner-trigger") || el.getAttribute("data-cloner-inner");
        if (!set.has(id)) { el.removeAttribute("data-cloner-trigger"); el.removeAttribute("data-cloner-inner"); }
      }
    }, [...recorded]), 6000, "recordInteractions.prune");
  } catch (e) {
    bus.emit("log", { level: "warn", msg: `prune failed: ${String(e?.message || e).slice(0, 70)}` });
  }

  bus.emit("step", { id: "interactions", status: results.length ? "done" : "skip", msg: results.length ? `${results.length} interaction(s) recorded (2-pass)` : "no overlays found" });
  return results;
}
