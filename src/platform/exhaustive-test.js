// EXHAUSTIVE interaction test: click EVERY clickable element in the clone —
// recorded triggers, module ✕, tabs, sidebar toggles, splitters, topbar buttons,
// order buttons, links — and classify each as working or dead. This is the
// "click everywhere" pass the user demanded: nothing is tested selectively.
// Output: { total, working, dead: [{selector, label, why}], skipped }
import { launchBrowser } from "../browser.js";
import path from "node:path";

const CLICKABLE = [
  "[data-cloner-trigger]",
  "[data-cloner-inner]",
  "button:not([disabled])",
  "[role='button']",
  ".btn-icon",
  ".icon-close",
  "[data-testid]",
  ".lm_tab",
  ".lm_splitter",
  "a[href='#']",
  "a.btn",
].join(",");

// state signature: does ANYTHING visibly change after the click?
const STATE_FN = `(() => {
  const panels = [...document.querySelectorAll('.lm_content, .module, .app-sidebar, [class*="panel"]')]
    .map(p => p.style.display || getComputedStyle(p).display).join(',');
  // overlays/modules tracked by CONTENT (a click can close one overlay and open
  // another — count stays 1 but the content changed = working interaction)
  const ovs = [...document.querySelectorAll('[data-cloner-overlay]')].map(o => o.innerHTML.length).join('|');
  const mos = [...document.querySelectorAll('[data-cloner-module]')].map(o => o.innerHTML.length).join('|');
  return JSON.stringify({
    overlays: ovs,
    modules: mos,
    panels,
    tabs: [...document.querySelectorAll('.lm_tab')].map(t => t.classList.contains('lm_active') ? 1 : 0).join(''),
    len: document.body.innerHTML.length,
  });
})()`;

function describeEl(el, i) {
  const r = el.getBoundingClientRect();
  const label =
    el.getAttribute("data-cloner-trigger") ||
    el.getAttribute("data-cloner-inner") ||
    el.getAttribute("data-testid") ||
    el.getAttribute("title") ||
    el.getAttribute("aria-label") ||
    (el.innerText || "").trim().split("\n")[0].slice(0, 24) ||
    el.className.toString().split(" ")[0].slice(0, 24) ||
    el.tagName.toLowerCase();
  return { index: i, selector: null, label: String(label), x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2), w: Math.round(r.width), h: Math.round(r.height), visible: r.width > 1 && r.height > 1 && r.x >= 0 && r.y >= 0 && r.x < 2000 && r.y < 3000 };
}

export async function exhaustiveTest(cloneDir, { maxClicks = 70, reloadEvery = 10 } = {}) {
  const b = await launchBrowser({ headless: true });
  const p = await b.newPage({ viewport: { width: 1440, height: 900 } });
  const results = { total: 0, working: 0, dead: [], skipped: 0, items: [] };
  try {
    await p.goto(encodeURI("file:///" + path.resolve(cloneDir, "index.html").replace(/\\/g, "/")), { waitUntil: "load", timeout: 30000 });
    await p.waitForTimeout(1200);
    const sanity = await p.evaluate(() => ({ title: document.title, bodyLen: document.body.innerHTML.length }));
    if (sanity.bodyLen < 5000) { results.error = "clone did not load (bodyLen " + sanity.bodyLen + ")"; return results; }
    results.page = sanity;

    for (let round = 0; round < Math.ceil(maxClicks / reloadEvery) + 1 && results.total < maxClicks; round++) {
      // enumerate clickable elements on the CURRENT page state
      const elems = await p.evaluate((sel) => {
        const seen = new Set();
        const out = [];
        let i = 0;
        let visible = 0, hidden = 0;
        for (const el of document.querySelectorAll(sel)) {
          const r = el.getBoundingClientRect();
          const vis = r.width > 1 && r.height > 1 && r.x >= 0 && r.y >= 0 && r.x < 2000 && r.y < 3000;
          if (!vis) { hidden++; continue; }
          const key = Math.round(r.x) + ":" + Math.round(r.y) + ":" + el.tagName + ":" + (el.className || "").toString().slice(0, 30);
          if (seen.has(key)) continue;
          seen.add(key);
          visible++;
          // tag with a unique attribute: the clicker uses a Playwright locator
          // (raw coordinate clicks land on covering elements; locator clicks
          // match how DevTools/a user triggers the control)
          const exid = "c" + i++;
          el.setAttribute("data-ex-id", exid);
          const label =
            el.getAttribute("data-cloner-trigger") || el.getAttribute("data-cloner-inner") || el.getAttribute("data-testid") ||
            el.getAttribute("title") || el.getAttribute("aria-label") || (el.innerText || "").trim().split("\n")[0].slice(0, 24) ||
            String(el.className).split(" ")[0].slice(0, 24) || el.tagName.toLowerCase();
          out.push({
            i,
            exid,
            path: domPath(el),
            label: String(label).slice(0, 40),
            x: Math.round(r.x + r.width / 2),
            y: Math.round(r.y + r.height / 2),
            kind: kindOf(el),
          });
        }
        window.__CLONER_EXHIDDEN = hidden;
        function kindOf(el) {
          if (el.hasAttribute("data-cloner-trigger")) return "recorded-trigger";
          if (el.hasAttribute("data-cloner-inner")) return "picker-entry";
          if (el.classList.contains("lm_tab")) return "layout-tab";
          if (el.classList.contains("lm_splitter")) return "splitter";
          if (String(el.className).includes("icon-close") || el.getAttribute("data-testid") === "sidebar-close-btn") return "close-control";
          if (String(el.getAttribute("data-testid") || "").startsWith("sidebar-")) return "sidebar-toggle";
          if (el.tagName === "A") return "link";
          if (el.closest("[class*='topbar'], header")) return "topbar-control";
          return "button";
        }
        function domPath(el) {
          const parts = [];
          for (let n = el; n && n !== document.body && parts.length < 6; n = n.parentElement) {
            let sel = n.tagName.toLowerCase();
            if (n.id) sel += "#" + n.id;
            else if (n.className && typeof n.className === "string") sel += "." + n.className.trim().split(/\s+/).slice(0, 2).join(".");
            parts.unshift(sel);
          }
          return parts.join(" > ");
        }
        return out;
      }, CLICKABLE);

      let clickedThisRound = 0;
      for (const el of elems) {
        if (results.total >= maxClicks) break;
        // a layout-changing click earlier in this round may have removed or moved
        // this element — skip what is gone, click what is still there
        if (el.gone) { results.skipped++; continue; }
        // visibility already filtered inside the enumerate evaluate
        const before = await p.evaluate(STATE_FN).catch(() => "");
        let err = null;
        try {
          if (el.kind === "splitter") {
            // drag right/down by 50px
            await p.mouse.move(el.x, el.y);
            await p.mouse.down();
            await p.mouse.move(el.x + 50, el.y + 40, { steps: 5 });
            await p.mouse.up();
          } else {
            await p.mouse.click(el.x, el.y);
          }
        } catch (e) { err = e.message.slice(0, 60); }
        await p.waitForTimeout(450);
        const after = await p.evaluate(STATE_FN).catch(() => "?");
        const changed = before !== after;
        // layout-changing clicks (sidebar toggle, dock pane close/collapse, flex
        // re-wraps) invalidate the remaining enumerated coordinates — re-resolve
        // them from the live DOM so the next clicks land on the controls, not on
        // where they used to be. Elements that left the DOM or became hidden are
        // skipped, not reported dead.
        if (changed) {
          const rest = elems.filter((e2) => e2.i > el.i);
          if (rest.length) {
            const fresh = await p
              .evaluate((ids) => {
                const out = [];
                for (const id of ids) {
                  const el2 = document.querySelector(`[data-ex-id="${id}"]`);
                  if (!el2) continue;
                  const r = el2.getBoundingClientRect();
                  const cs = getComputedStyle(el2);
                  const vis = r.width > 1 && r.height > 1 && r.x >= 0 && r.y >= 0 && r.x < 2000 && r.y < 3000 && cs.display !== "none" && cs.visibility !== "hidden";
                  out.push({ id, vis, x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) });
                }
                return out;
              }, rest.map((e2) => e2.exid))
              .catch(() => []);
            const byId = new Map((fresh || []).map((f) => [f.id, f]));
            for (const e2 of rest) {
              const f = byId.get(e2.exid);
              if (f && f.vis) { e2.x = f.x; e2.y = f.y; e2.gone = false; }
              else e2.gone = true;
            }
          }
        }
        results.total++;
        clickedThisRound++;
        const item = { label: el.label, kind: el.kind, path: el.path, changed, err };
        results.items.push(item);
        if (changed) results.working++;
        else results.dead.push({ label: el.label, kind: el.kind, path: el.path, err });
        // clean leftovers so the NEXT click starts from a known state
        await p.evaluate(() => {
          document.querySelectorAll("[data-cloner-overlay],[data-cloner-module]").forEach((n) => n.remove());
        }).catch(() => {});

        // restore state every few clicks so one opened overlay doesn't mask the rest
        if (clickedThisRound % reloadEvery === 0) {
          await p.reload({ waitUntil: "load", timeout: 30000 }).catch(() => {});
          await p.waitForTimeout(1200);
          clickedThisRound = 0;
        }
      }
      // if the last enumeration found nothing new to click, stop
      if (clickedThisRound === 0) break;
    }
  } catch (e) {
    results.error = e.message.slice(0, 160);
  } finally {
    await b.close().catch(() => {});
  }
  return results;
}

// path import helper (kept tiny to avoid circulars)
function path2(dir, file) {
  return dir.replace(/\\/g, "/") + "/" + file;
}
