// Playwright engine: cookies, launch fallback (bundled chromium → Edge → Chrome),
// per-page capture (DOM serialization, screenshots, asset sniffing, design tokens).
import fs from "node:fs";
import path from "node:path";
import { bus } from "./events.js";

let pwPromise = null;
async function pw() {
  if (!pwPromise) pwPromise = import("playwright");
  return pwPromise;
}

// ---- cookies -------------------------------------------------------------

export function loadCookies(file) {
  const text = fs.readFileSync(file, "utf8").trim();
  if (text.startsWith("[")) {
    // JSON export (EditThisCookie / devtools style)
    const arr = JSON.parse(text);
    return arr.map((c) => ({
      name: c.name,
      value: c.value,
      domain: c.domain || undefined,
      path: c.path || "/",
      expires: typeof c.expirationDate === "number" ? Math.floor(c.expirationDate) : c.expires === -1 ? -1 : undefined,
      httpOnly: !!c.httpOnly,
      secure: !!c.secure,
      sameSite: normSameSite(c.sameSite),
    }));
  }
  // Netscape format
  const out = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim() || line.startsWith("#")) continue;
    const [domain, flag, p, secure, expires, name, ...rest] = line.split("\t");
    if (rest.length === 0) continue;
    out.push({
      name,
      value: rest.join("\t"),
      domain: flag === "TRUE" ? "." + domain.replace(/^\./, "") : domain,
      path: p || "/",
      expires: Number(expires) || -1,
      secure: secure === "TRUE",
      httpOnly: false,
    });
  }
  return out;
}
function normSameSite(s) {
  const v = String(s || "").toLowerCase();
  if (v === "no_restriction" || v === "none") return "None";
  if (v === "lax") return "Lax";
  if (v === "strict") return "Strict";
  return undefined;
}

// ---- launch --------------------------------------------------------------

export async function launchBrowser(opts = {}) {
  const { chromium } = await pw();
  const headless = opts.headless !== false;
  const attempts = [
    () => chromium.launch({ headless, ...opts.launch }),
    () => chromium.launch({ headless, channel: "msedge" }),
    () => chromium.launch({ headless, channel: "chrome" }),
  ];
  let lastErr;
  for (const a of attempts) {
    try {
      return await a();
    } catch (e) {
      lastErr = e;
    }
  }
  throw new Error(`no browser could launch (tried bundled chromium, msedge, chrome): ${lastErr?.message}`);
}

export async function newContext(browser, { cookies, viewport, storage }) {
  const ctx = await browser.newContext({ viewport, ignoreHTTPSErrors: true, serviceWorkers: "allow" });
  if (cookies?.length) await ctx.addCookies(cookies);
  // SPA auth often lives in localStorage/sessionStorage (cookies alone don't restore it)
  if (storage && (storage.ls || storage.ss)) {
    const lines = [];
    for (const [k, v] of Object.entries(storage.ls || {})) lines.push(`try{localStorage.setItem(${JSON.stringify(k)},${JSON.stringify(v)})}catch(e){}`);
    for (const [k, v] of Object.entries(storage.ss || {})) lines.push(`try{sessionStorage.setItem(${JSON.stringify(k)},${JSON.stringify(v)})}catch(e){}`);
    await ctx.addInitScript(lines.join("\n"));
  }
  // force WebGL contexts to preserve their drawing buffer so charts/ladders can be
  // snapshotted via toDataURL at capture time (must run before the page creates contexts)
  await ctx.addInitScript(() => {
    try {
      const orig = HTMLCanvasElement.prototype.getContext;
      HTMLCanvasElement.prototype.getContext = function (type, ...rest) {
        if (/webgl/i.test(String(type))) {
          const opts = { ...(rest[0] || {}), preserveDrawingBuffer: true };
          return orig.call(this, type, opts, ...rest.slice(1));
        }
        return orig.call(this, type, ...rest);
      };
    } catch (e) {}
  });
  return ctx;
}

// ---- capture -------------------------------------------------------------

const MEDIA_HINT = /\.(png|jpe?g|webp|gif|svg|ico|avif|woff2?|ttf|otf|mp4|webm|m4a|mp3|js|mjs|json)(\?|$)/i;

export function attachSniffer(ctx, sink) {
  ctx.on("response", (res) => {
    try {
      const url = res.url();
      if (!/^https?:/i.test(url)) return;
      const type = res.headers()["content-type"] || "";
      const interesting =
        /image|font|video\/|audio\//i.test(type) ||
        /text\/css|javascript|ecmascript/i.test(type) ||
        // JSON: language/i18n packs, config and API data — the whole app data layer
        (/json/i.test(type) && !/event-stream/i.test(type)) ||
        MEDIA_HINT.test(url);
      if (interesting && !/\/favicon\.ico$/i.test(url)) sink.add(url);
    } catch {}
  });
}

// SPA modules mount progressively — wait until the DOM stops growing. For canvas
// apps (charts/terminals) require the canvases to actually be there: a "stable but
// empty" workspace would produce a degraded clone. expectCanvas: canvases were seen
// earlier in this session and MUST come back (used after the post-recording reload).
// Every probe below is hard-bounded (race against a timer) — an SPA with constant
// websocket/price-stream traffic can no longer stretch this phase into minutes.
const probeDeadline = (p, ms, fallback) =>
  Promise.race([p, new Promise((r) => setTimeout(() => r(fallback), ms))]);

async function waitForAppSettle(page, spaWaitMs = 15000, { expectCanvas = false } = {}) {
  const deadline = Date.now() + Math.max(5000, spaWaitMs);
  let prev = -1, stable = 0, maxCanvas = 0;
  while (Date.now() < deadline && stable < 3) {
    await page.waitForTimeout(1200);
    const len = await probeDeadline(
      page.evaluate(() => document.body.innerHTML.length).catch(() => prev), 5000, prev,
    );
    const canvasCount = await probeDeadline(
      page.evaluate(() => document.querySelectorAll("canvas").length).catch(() => 0), 5000, 0,
    );
    maxCanvas = Math.max(maxCanvas, canvasCount);
    const canvasReady = maxCanvas === 0 || canvasCount > 0;
    stable = len === prev && canvasReady ? stable + 1 : 0;
    prev = len;
  }
  if (maxCanvas > 0 || expectCanvas) {
    await page
      .waitForFunction(() => document.querySelectorAll("canvas").length > 0, undefined, { timeout: 10000 })
      .catch(() => bus.emit("log", { level: "warn", msg: "canvas modules did not remount — clone may be degraded" }));
    await page.waitForTimeout(600); // let the chart engine finish painting
  }
}

// auto-dismiss native JS dialogs (alert/confirm/beforeunload) — one unanswered
// dialog freezes every page.evaluate and used to hang runs for hours.
function guardDialogs(page) {
  page.on("dialog", (d) => d.dismiss().catch(() => {}));
}

export async function capturePage(page, url, { networkIdleMs = 6000, spaWaitMs = 15000, interactions = null } = {}) {
  bus.emit("page:goto", { url });
  guardDialogs(page);
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45000 });
  let idle = true;
  try {
    await page.waitForLoadState("networkidle", { timeout: networkIdleMs });
  } catch {
    idle = false;
  }
  // trigger lazy loading, then return to top
  await autoScroll(page);
  await waitForAppSettle(page, spaWaitMs);
  if (!idle) bus.emit("log", { level: "info", msg: "long-loading app — captured after DOM stabilized" });
  await page.waitForTimeout(400);

  const title = await page.title().catch(() => "");
  const finalUrl = page.url();

  const tokens = await probeDeadline(page.evaluate(designTokens), 6000, {}).catch(() => ({}));
  const stack = await probeDeadline(page.evaluate(detectStack), 6000, null).catch(() => null);
  const tokensV2 = await probeDeadline(page.evaluate(designTokensV2), 8000, null).catch(() => null);

  // PRISTINE-FIRST capture: mark triggers passively, screenshot and serialize the
  // workspace BEFORE the explorer touches anything — the clone is the app's real
  // state, and exploration mutations can never contaminate it. Recording then
  // clicks the pre-marked controls (pass 2 re-marks new ones; those records ride
  // the runtime's text-signature fallback since the pristine HTML is frozen).
  let preMarked = [];
  if (interactions) {
    try {
      const { markTriggers } = await import("./interactions.js");
      preMarked = (await markTriggers(page, { max: 100 })).marked || [];
    } catch (e) {
      bus.emit("log", { level: "warn", msg: `markTriggers failed: ${e.message.slice(0, 90)}` });
    }
  }
  const screenshot = await page.screenshot({ fullPage: true, timeout: 20000 }).catch(() => null);

  const html = await probeDeadline(page.evaluate(serializeEnhanced), 25000, null);
  if (!html) {
    // serialize never came back (frozen page) — one bounded retry on a fresh load,
    // WITHOUT interactions, so we never ship a dead/empty shell
    bus.emit("log", { level: "warn", msg: "serialize timed out — retrying capture without interactions…" });
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45000 }).catch(() => {});
    await waitForAppSettle(page, Math.min(spaWaitMs, 12000));
    preMarked = [];
    if (interactions) {
      try {
        const { markTriggers } = await import("./interactions.js");
        preMarked = (await markTriggers(page, { max: 100 })).marked || [];
      } catch {}
    }
  }
  const htmlFinal = html;
  // boot-shell guard: a real app page is never this small
  if (htmlFinal && htmlFinal.length < 8000) {
    bus.emit("log", { level: "warn", msg: `serialized DOM suspiciously small (${htmlFinal.length}B) — SPA may not have mounted; clone will be a boot shell` });
  }

  // NOW explore: clicks may mutate the workspace freely — the clone is already frozen
  let recordedInteractions = [];
  if (interactions) {
    try {
      const { recordInteractions } = await import("./interactions.js");
      recordedInteractions = await recordInteractions(page, {
        ...(interactions === true ? {} : interactions),
        preMarked,
      });
      // prune dead trigger attrs from the FROZEN html — attrs whose id produced no
      // record would be decorative buttons in the clone (spec: none allowed)
      if (htmlFinal && recordedInteractions.length) {
        const wired = new Set(recordedInteractions.map((r) => r.id));
        htmlFinal = htmlFinal.replace(/ data-cloner-trigger="(t\d+)"/g, (m, id) => (wired.has(id) ? m : ""));
      }
    } catch (e) {
      bus.emit("log", { level: "warn", msg: `interaction recording failed: ${e.message.slice(0, 90)}` });
    }
  }

  // sniffed video/audio URLs currently on the page (bounded probe)
  const passwordForm = await probeDeadline(
    page.evaluate(() => document.querySelectorAll('input[type="password"]').length > 0).catch(() => false),
    5000,
    false,
  );
  const media = await probeDeadline(
    page
      .evaluate(() =>
        [...document.querySelectorAll("video[src], video > source[src], audio[src], audio > source[src]")]
          .map((v) => new URL(v.src, location.href).href)
          .filter((u) => /^https?:/i.test(u)),
      )
      .catch(() => []),
    5000,
    [],
  );

  // F12-grade full-frontend snapshot via CDP (the exact channel DevTools uses):
  // every computed style, loaded font, image and canvas paint stored in one
  // self-contained .mhtml — open it in Chrome/Edge for the pixel-exact original
  const mhtml = await captureMhtmlSnapshot(page);

  return { title, finalUrl, screenshot, tokens, stack, tokensV2, html: htmlFinal, media, passwordForm, interactions: recordedInteractions, mhtml };
}

// DevTools-style full-frontend store. Page.captureSnapshot("mhtml") serializes the
// RENDERED page (computed styles already resolved by Chrome) exactly as the
// browser sees it — no CSS-URL chasing can break it. Used as the exact-fidelity
// companion artifact next to the editable HTML clone.
export async function captureMhtmlSnapshot(page) {
  let cdp = null;
  try {
    cdp = await page.context().newCDPSession(page);
    const snap = await Promise.race([
      cdp.send("Page.captureSnapshot", { format: "mhtml" }),
      new Promise((_, rej) => setTimeout(() => rej(new Error("captureSnapshot deadline 25s")), 25000)),
    ]);
    const data = snap?.data || null;
    if (data) bus.emit("log", { level: "info", msg: `full-frontend snapshot captured (mhtml ${(data.length / 1024 / 1024).toFixed(1)}MB)` });
    return data;
  } catch (e) {
    bus.emit("log", { level: "warn", msg: `mhtml snapshot failed: ${String(e?.message || e).slice(0, 70)}` });
    return null;
  } finally {
    if (cdp) await cdp.detach().catch(() => {});
  }
}

async function autoScroll(page) {
  await probeDeadline(
    page.evaluate(async () => {
      await new Promise((resolve) => {
        let total = 0;
        const step = Math.max(400, innerHeight * 0.8);
        const t = setInterval(() => {
          scrollBy(0, step);
          total += step;
          if (total >= Math.min(document.body?.scrollHeight || 0, 20000) || total > 60000) {
            clearInterval(t);
            scrollTo(0, 0);
            resolve();
          }
        }, 120);
      });
    }),
    45000,
    null,
  ).catch(() => {});
}

// Runs inside the page in ONE synchronous pass right before serialization:
// 1. canvas/WebGL → <img> snapshot (charts, order ladders, visualizations)
// 2. shadow roots → declarative <template shadowrootmode> (web components keep rendering)
// 3. images that never loaded → neutral placeholder block (no broken icons)
// 4. strip scripts/base/no-js, then serialize
function serializeEnhanced() {
  // 1. canvases → snapshots
  for (const c of document.querySelectorAll("canvas")) {
    try {
      const r = c.getBoundingClientRect();
      if (r.width < 2 || r.height < 2) { c.remove(); continue; }
      const img = document.createElement("img");
      img.src = c.toDataURL("image/png");
      img.alt = "captured canvas";
      const cs = getComputedStyle(c);
      for (const p of ["display", "position", "inset", "top", "right", "bottom", "left", "width", "height",
        "minWidth", "minHeight", "maxWidth", "maxHeight", "margin", "verticalAlign", "transform",
        "zIndex", "borderRadius", "objectFit", "opacity", "visibility", "pointerEvents"]) {
        img.style[p] = cs[p];
      }
      if (cs.position === "static" && (!img.style.width || img.style.width === "auto")) img.style.width = r.width + "px";
      if (cs.position === "static" && (!img.style.height || img.style.height === "auto")) img.style.height = r.height + "px";
      img.setAttribute("data-cloner-snap", "1");
      c.replaceWith(img);
    } catch (e) { /* tainted canvas — leave as-is */ }
  }
  // 2. shadow roots → declarative templates (recursively; TreeWalker doesn't cross shadow boundaries)
  const attachShadows = (root) => {
    for (const el of root.querySelectorAll("*")) {
      if (el.shadowRoot) {
        try {
          const t = document.createElement("template");
          t.setAttribute("shadowrootmode", "open");
          t.innerHTML = el.shadowRoot.innerHTML;
          el.prepend(t);
          attachShadows(el.shadowRoot);
        } catch (e) {}
      }
    }
  };
  attachShadows(document);
  // 3. never-loaded images → hatch placeholder (keeps layout size, kills broken icon)
  for (const img of document.images) {
    try {
      if (img.hasAttribute("data-cloner-snap")) continue;
      if ((img.getAttribute("src") || "").startsWith("data:")) continue; // data URLs can't 404
      if (img.complete && img.naturalWidth > 0) continue;
      const r = img.getBoundingClientRect();
      if (r.width < 4 || r.height < 4) continue;
      img.style.background = "repeating-linear-gradient(45deg,#e6e8ef 0 6px,#f3f4f8 6px 12px)";
      img.style.objectFit = img.style.objectFit || "contain";
      img.removeAttribute("src");
      img.removeAttribute("srcset");
    } catch (e) {}
  }
  // 4. serialize (self-contained — page.evaluate can't see other module functions)
  const clone = document.documentElement.cloneNode(true);
  clone.querySelectorAll("script, noscript").forEach((n) => n.remove());
  clone.querySelectorAll("base").forEach((n) => n.remove());
  const cls = (clone.getAttribute("class") || "").replace(/\bno-js\b/g, "").trim();
  if (cls) clone.setAttribute("class", cls);
  else clone.removeAttribute("class");
  clone.querySelectorAll("img").forEach((img) => {
    if (img.getAttribute("loading") === "lazy") img.removeAttribute("loading");
  });
  return "<!DOCTYPE html>\n" + clone.outerHTML;
}

function designTokens() {
  const cs = (el) => (el ? getComputedStyle(el) : null);
  const pick = (el, p) => (cs(el) ? cs(el)[p] : null);
  const body = document.body;
  const h1 = document.querySelector("h1,h2");
  const btn = [...document.querySelectorAll("a,button,input[type=submit]")].find(
    (e) => e.offsetParent && pick(e, "backgroundColor") !== "rgba(0, 0, 0, 0)",
  );
  return {
    url: location.href,
    title: document.title,
    bodyBg: pick(body, "backgroundColor"),
    bodyColor: pick(body, "color"),
    bodyFont: pick(body, "fontFamily"),
    headingFont: h1 ? `${pick(h1, "fontFamily")} | ${pick(h1, "fontSize")} ${pick(h1, "fontWeight")}` : null,
    buttonBg: pick(btn, "backgroundColor"),
    buttonColor: pick(btn, "color"),
    accentSample: pick(document.querySelector("a"), "color"),
  };
}

// identify the frontend stack so the clone preserves the original technology
// choices (React → React, Vue → Vue …). Runtime fiber/props keys are the
// reliable signal; meta tags and globals cover the meta-frameworks.
function detectStack() {
  const w = window;
  const out = { framework: "unknown", buildTool: null, signals: {} };
  try {
    // React attaches fiber keys to RENDERED elements — they don't necessarily sit
    // on the mount node's first child, so sample a spread of elements
    const sample = [...document.querySelectorAll("body *")].slice(0, 60);
    const hasReact = sample.some((el) => Object.keys(el).some((k) => k.startsWith("__reactFiber$") || k.startsWith("__reactProps$")));
    if (hasReact || w.__REACT_DEVTOOLS_GLOBAL_HOOK__?.renderers?.size) {
      out.framework = "React";
      out.signals.reactFiber = true;
    }
    if (w.__NEXT_DATA__ || document.querySelector("#__next")) { out.framework = "Next.js (React)"; out.signals.next = true; }
    if (w.__NUXT__ || document.querySelector("[data-v-app], #__nuxt")) { out.framework = out.framework === "React" ? "React" : "Nuxt (Vue)"; out.signals.vue = true; }
    else if (keys.some((k) => k.startsWith("__vue__")) || w.__VUE__) { out.framework = "Vue"; out.signals.vue = true; }
    const ngv = document.querySelector("[ng-version]");
    if (ngv) { out.framework = "Angular " + ngv.getAttribute("ng-version"); out.signals.angular = true; }
    if (w.jQuery?.fn?.jquery) { out.signals.jquery = w.jQuery.fn.jquery; if (out.framework === "unknown") out.framework = "jQuery " + w.jQuery.fn.jquery; }
    if (w.__SVELTE__) { out.framework = "Svelte"; out.signals.svelte = true; }
    const scripts = [...document.scripts].map((s) => s.src || "");
    if (scripts.some((s) => /chunk|vendor|runtime\./.test(s))) out.buildTool = "webpack-style chunked bundles";
    if (scripts.some((s) => /\/@vite\/|\.vite\//.test(s))) out.buildTool = "vite";
    // source availability: are .js maps published? (frameworks rarely ship source;
    // when they do, the cloner downloads and inspects it — see assets/data)
    out.signals.scriptBundles = scripts.filter(Boolean).length;
  } catch {}
  return out;
}

// fidelity tokens for image-to-code work: the EXACT color/typography/spacing
// distribution of the live page (frequency-ranked, not a sample of one node)
function designTokensV2() {
  const freq = { colors: {}, backgrounds: {}, fonts: {}, fontSizes: {}, spacing: {}, radii: {} };
  try {
    const els = document.querySelectorAll("body *");
    const step = Math.max(1, Math.floor(els.length / 3500));
    for (let i = 0; i < els.length; i += step) {
      const el = els[i];
      const cs = getComputedStyle(el);
      if (cs.color) freq.colors[cs.color] = (freq.colors[cs.color] || 0) + 1;
      if (cs.backgroundColor && cs.backgroundColor !== "rgba(0, 0, 0, 0)") freq.backgrounds[cs.backgroundColor] = (freq.backgrounds[cs.backgroundColor] || 0) + 1;
      const f = (cs.fontFamily || "").split(",")[0].replace(/["']/g, "");
      if (f) freq.fonts[f] = (freq.fonts[f] || 0) + 1;
      if (cs.fontSize) freq.fontSizes[cs.fontSize] = (freq.fontSizes[cs.fontSize] || 0) + 1;
      if (cs.margin && cs.margin !== "0px") freq.spacing[cs.margin] = (freq.spacing[cs.margin] || 0) + 1;
      if (cs.borderRadius && cs.borderRadius !== "0px") freq.radii[cs.borderRadius] = (freq.radii[cs.borderRadius] || 0) + 1;
    }
  } catch {}
  const top = (o, n = 12) => Object.entries(o).sort((a, b) => b[1] - a[1]).slice(0, n);
  return {
    colors: top(freq.colors),
    backgrounds: top(freq.backgrounds),
    fonts: top(freq.fonts, 6),
    fontSizes: top(freq.fontSizes, 10),
    spacing: top(freq.spacing, 12),
    radii: top(freq.radii, 8),
  };
}

// discover same-site tabs to clone (nav + visible links). Same registrable domain
// counts as same-site (e.g. trader.x.com + www.x.com clone into one output).
export async function discoverTabs(page, registrable, max) {
  const links = await probeDeadline(
    page
      .evaluate((registrable) => {
        const norm = (u) => {
          const x = new URL(u, location.href);
          x.hash = "";
          if (x.pathname.endsWith("/index.html")) x.pathname = x.pathname.slice(0, -"index.html".length);
          if (x.pathname.length > 1 && x.pathname.endsWith("/")) x.pathname = x.pathname.slice(0, -1);
          x.search = "";
          return x.href.replace(/\/$/, "");
        };
        const sameSite = (host) => host === registrable || host.endsWith("." + registrable);
        const seen = new Set([norm(location.href)]);
        const out = [];
        const links = [...document.querySelectorAll("a[href]")]
          .filter((a) => a.offsetParent || a.closest("nav,header"))
          .map((a) => a.href);
        for (const href of links) {
          try {
            const u = new URL(href, location.href);
            if (!sameSite(u.hostname)) continue;
            if (/\.(png|jpe?g|pdf|zip|svg|mp4|webm|woff2?|css|js)(\?|$)/i.test(u.pathname)) continue;
            const s = norm(href);
            if (!seen.has(s)) {
              seen.add(s);
              out.push(s);
            }
          } catch {}
        }
        // prefer nav-like short paths first
        out.sort((a, b) => a.split("/").length - b.split("/").length || a.length - b.length);
        return out;
      }, registrable)
      .catch(() => []),
    8000,
    [],
  );
  return links.slice(0, max - 1);
}

// render a local clone for polish comparison
export async function renderCloneScreenshot(browser, htmlPath, viewport) {
  const ctx = await browser.newContext({ viewport });
  const page = await ctx.newPage();
  await page.goto("file:///" + htmlPath.replace(/\\/g, "/"), { waitUntil: "networkidle", timeout: 20000 }).catch(() => {});
  await page.waitForTimeout(700);
  const shot = await page.screenshot({ fullPage: true }).catch(() => null);
  await ctx.close();
  return shot;
}
