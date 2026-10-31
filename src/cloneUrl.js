// URL → clone pipeline. DOM is ground truth; vision model only polishes.
import fs from "node:fs";
import path from "node:path";
import { bus } from "./events.js";
import { loadCookies, launchBrowser, newContext, attachSniffer, capturePage, discoverTabs, renderCloneScreenshot } from "./browser.js";
import { downloadAssets, rewriteHtml, captureCss, finalizeCssRewrite } from "./assets.js";
import { runPolish } from "./polish.js";
import { buildRuntime } from "./runtimeTemplate.js";

export async function cloneUrl(url, cfg, outDir, opts = {}) {
  const crawl = cfg.crawl;
  // opts.cookies: file path (CLI) OR an already-parsed cookie array (platform)
  const cookieIsArray = Array.isArray(opts.cookies);
  bus.emit("step", {
    id: "cookies",
    status: "start",
    msg: opts.cookies ? `loading cookies: ${cookieIsArray ? `${opts.cookies.length} pre-parsed` : path.basename(opts.cookies)}` : "no cookies (public session)",
  });

  let cookies = [];
  if (opts.cookies) {
    cookies = cookieIsArray ? opts.cookies : loadCookies(opts.cookies);
    bus.emit("step", { id: "cookies", status: "done", msg: `${cookies.length} cookies loaded` });
  } else {
    bus.emit("step", { id: "cookies", status: "skip" });
  }

  fs.mkdirSync(outDir, { recursive: true });
  const shotDir = path.join(outDir, "_reference");
  fs.mkdirSync(shotDir, { recursive: true });

  let headless = opts.headless !== false;
  let browser, ctx, page, sniffed;

  async function openSession() {
    if (browser) await browser.close().catch(() => {});
    browser = await launchBrowser({ headless, launch: { args: ["--disable-blink-features=AutomationControlled"] } });
    ctx = await newContext(browser, { cookies, viewport: crawl.viewport, storage: opts.storage });
    sniffed = new Set();
    attachSniffer(ctx, sniffed);
    page = await ctx.newPage();
  }
  await openSession();

  // --- main page ---
  bus.emit("step", { id: "open", status: "start", msg: `opening ${url}` });
  // interaction recording on the main page only (safe controls → captured overlays);
  // outDir flows in so the explorer can save state screenshots + the exploration report
  const interactionOpts =
    opts.interactions === false
      ? null
      : { ...(opts.interactions === true || opts.interactions == null ? {} : opts.interactions), outDir };
  const main = await capturePage(page, url, { ...crawl, interactions: interactionOpts });
  // Cloudflare / bot-challenge → retry headful (a visible browser window may appear)
  if (isChallenge(main)) {
    bus.emit("step", { id: "open", status: "start", msg: "bot challenge detected — retrying with a visible browser window…" });
    headless = false;
    await openSession();
    const retried = await capturePage(page, url, { ...crawl, networkIdleMs: 12000, interactions: interactionOpts });
    main.interactions = retried.interactions;
    main.title = retried.title; main.finalUrl = retried.finalUrl; main.tokens = retried.tokens; main.html = retried.html; main.screenshot = retried.screenshot; main.media = retried.media; main.passwordForm = retried.passwordForm; main.mhtml = retried.mhtml; main.stack = retried.stack; main.tokensV2 = retried.tokensV2;
  }
  const origin = new URL(main.finalUrl).origin;
  bus.emit("step", {
    id: "open",
    status: "done",
    msg: `${main.title || origin}${main.passwordForm ? " (login form detected)" : ""}`,
  });
  if (main.passwordForm) bus.emit("log", { level: "warn", msg: "page contains a login form — if clone shows a login screen, cookies may be invalid/expired" });

  // --- discover tabs (same registrable domain, e.g. trader.x.com + www.x.com) ---
  bus.emit("step", { id: "tabs", status: "start", msg: "discovering tabs…" });
  const host = new URL(main.finalUrl).hostname;
  const registrable = host.split(".").slice(-2).join(".");
  const links = await discoverTabs(page, registrable, crawl.maxPages);
  // seeded routes (SPA pages without <a href> links) go first
  const seeded = (opts.seeds || []).filter((s) => {
    try {
      const h = new URL(s).hostname;
      return (h === registrable || h.endsWith("." + registrable)) && s !== main.finalUrl;
    } catch { return false; }
  });
  const allLinks = [...new Set([...seeded, ...links])].slice(0, crawl.maxPages - 1);
  const pages = [{ url: main.finalUrl, title: main.title || "index", html: main.html, tokens: main.tokens }];
  bus.emit("tabs:found", { tabs: [url, ...allLinks] });
  bus.emit("step", { id: "tabs", status: "done", msg: `${allLinks.length + 1} tab(s) to clone${seeded.length ? ` (${seeded.length} seeded)` : ""}` });

  // --- capture remaining tabs (2 at a time) ---
  for (let i = 0; i < allLinks.length; i += 2) {
    const batch = allLinks.slice(i, i + 2);
    const results = await Promise.all(
      batch.map(async (link, j) => {
        const p = await ctx.newPage();
        try {
          const cap = await capturePage(p, link, crawl);
          return { url: cap.finalUrl, title: cap.title || `page-${i + j + 2}`, html: cap.html, tokens: cap.tokens };
        } catch (e) {
          bus.emit("log", { level: "warn", msg: `tab failed: ${link} — ${e.message}` });
          return null;
        } finally {
          await p.close();
        }
      }),
    );
    pages.push(...results.filter(Boolean));
  }
  // dedupe pages that resolved to the same normalized URL
  const norm = (u) => {
    try {
      const x = new URL(u);
      x.hash = "";
      if (x.pathname.endsWith("/index.html")) x.pathname = x.pathname.slice(0, -"index.html".length);
      if (x.pathname.length > 1 && x.pathname.endsWith("/")) x.pathname = x.pathname.slice(0, -1);
      x.search = "";
      return x.href.replace(/\/$/, "");
    } catch { return u; }
  };
  const seenPages = new Set();
  const uniquePages = pages.filter((p) => {
    const n = norm(p.url);
    if (seenPages.has(n)) return false;
    seenPages.add(n);
    return true;
  });
  pages.length = 0;
  pages.push(...uniquePages);

  // browser-context fetch (carries cookies + real TLS/headers) — needed for CDNs that 403 plain fetches
  const fetchImpl = async (url, headers, timeoutMs) => {
    const r = await ctx.request.get(url, { headers, timeout: timeoutMs, maxRedirects: 5 });
    return {
      ok: r.ok(),
      status: r.status(),
      headers: { get: (k) => (r.headers()[k.toLowerCase()] ?? null) },
      arrayBuffer: async () => r.body(),
    };
  };

  // --- save reference screenshots ---
  bus.emit("step", { id: "capture", status: "done", msg: `${pages.length} page(s) captured` });
  for (let i = 0; i < pages.length; i++) {
    if (pages[i]._shot) continue; // not used, screenshots come from main loop
  }

  // re-take screenshots of each page for reference? main page already has one.
  if (main.screenshot) fs.writeFileSync(path.join(shotDir, "page-1.png"), main.screenshot);

  // --- assets ---
  bus.emit("step", { id: "assets", status: "start", msg: "downloading assets…" });
  const urlMap = new Map();

  // stylesheets: capture + rewrite (also collects nested urls)
  const cssUrls = [...sniffed].filter((u) => /\.css(\?|$)/i.test(u));
  for (const main2 of pages) {
    const doc = main2.html || "";
    for (const m of doc.matchAll(/<link[^>]+rel=["']stylesheet["'][^>]*>/gi)) {
      const href = m[0].match(/href=["']([^"']+)["']/i)?.[1];
      if (href) {
        try {
          const abs = new URL(href, main2.url).href;
          if (/^https?:/i.test(abs)) cssUrls.push(abs);
        } catch {}
      }
    }
  }

  const extraUrls = new Set();
  const cssFiles = []; // {file, cssUrl} for the post-download rewrite pass
  // FIX: CSS files download in parallel (old code was serial — 60 CSS × seconds each)
  await Promise.all(
    [...new Set(cssUrls)].slice(0, 60).map(async (cssUrl) => {
      try {
        const res = await captureCss(cssUrl, outDir, urlMap, { fetchImpl });
        if (!res) return;
        (res?.extraUrls || []).forEach((u) => extraUrls.add(u));
        if (res?.relPath) cssFiles.push({ file: res.relPath, cssUrl });
      } catch (e) {
        bus.emit("log", { level: "warn", msg: `css failed: ${cssUrl.slice(0, 80)} — ${e.message}` });
      }
    }),
  );
  // one more pass for assets referenced from inside CSS
  for (const u of [...extraUrls]) {
    if (!urlMap.has(u)) urlMap.set(u, null); // placeholder so rewriteHtml knows we tried
  }
  const mediaUrls = new Set([...sniffed, ...pages.flatMap((p) => p.media || [])]);
  const assetMap = await downloadAssets([...mediaUrls, ...extraUrls], outDir, {
    // browser-context fetches look like a bot burst at high concurrency — CDNs rate-limit them
    concurrency: fetchImpl ? Math.min(crawl.concurrency, 6) : crawl.concurrency,
    timeoutMs: crawl.timeoutMs,
    maxAssets: crawl.maxAssets,
    referer: origin,
    fetchImpl,
  });
  for (const [k, v] of assetMap) urlMap.set(k, v);
  urlMap.forEach((v, k) => { if (v === null) urlMap.delete(k); });
  await finalizeCssRewrite(cssFiles, outDir, urlMap);

  // repair sweep: anything still referenced but missing locally gets a slower retry.
  // catches JS-injected assets and cached assets the network sniffer never saw.
  {
    const leftover = new Set();
    for (const p of pages) {
      for (const m of (p.html || "").matchAll(/\s(?:src|href|poster|xlink:href)="(https?:\/\/[^"]+)"/g)) {
        const u = m[1].split(" ")[0];
        if (!/\.(svg|png|jpe?g|webp|gif|avif|ico|mp4|webm|mp3|m4a|woff2?|ttf|otf|css|js|mjs|json)(\?|#|$)/i.test(u.split("#")[0])) continue;
        if (!urlMap.has(u)) leftover.add(u);
      }
    }
    for (const { file, cssUrl } of cssFiles) {
      const full = path.join(outDir, file);
      if (!fs.existsSync(full)) continue;
      const css = fs.readFileSync(full, "utf8");
      for (const m of css.matchAll(/url\((['"]?)([^)'"]+)\1\)/g)) {
        if (/^data:/i.test(m[2])) continue;
        try {
          // already-rewritten refs resolve back to their original URL (present in urlMap) and are skipped
          const abs = new URL(m[2], cssUrl).href;
          if (!urlMap.has(abs)) leftover.add(abs);
        } catch {}
      }
    }
    if (leftover.size) {
      bus.emit("log", { level: "info", msg: `repair sweep: ${leftover.size} asset(s) retrying` });
      const sweepStart = Date.now();
      const more = await downloadAssets([...leftover], outDir, {
        concurrency: 6, timeoutMs: crawl.timeoutMs, maxAssets: crawl.maxAssets, referer: origin, fetchImpl,
      });
      for (const [k, v] of more) urlMap.set(k, v);
      await finalizeCssRewrite(cssFiles, outDir, urlMap);
      bus.emit("log", { level: "info", msg: `repair sweep done in ${((Date.now() - sweepStart) / 1000).toFixed(1)}s (ok: ${more.size}/${leftover.size})` });
    }
  }
  bus.emit("step", { id: "assets", status: "done", msg: `${urlMap.size} assets local` });
  await ctx.close().catch(() => {});

  // --- assemble pages ---
  bus.emit("step", { id: "assemble", status: "start", msg: "writing clone…" });
  for (let i = 0; i < pages.length; i++) {
    const p = pages[i];
    let html = p.html || "<!DOCTYPE html><html><head></head><body><!-- capture failed --></body></html>";
    html = rewriteHtml(html, p.url, urlMap, origin);
    if (i > 0) html = rewriteLinks(html, p.url, pages, origin);
    const name = i === 0 ? "index.html" : `page-${i + 1}.html`;
    fs.writeFileSync(path.join(outDir, name), html);
    p.file = name;
  }
  // F12-grade exact snapshot of the original page (DevTools' own capture channel)
  if (main.mhtml) {
    fs.writeFileSync(path.join(outDir, "snapshot.mhtml"), main.mhtml);
    bus.emit("log", { level: "info", msg: "snapshot.mhtml written — open in Chrome/Edge for the pixel-exact original" });
  }
  // stack detection + fidelity tokens: what the app is built with and its exact
  // color/typography/spacing distribution — the clone preserves both
  if (main.stack) bus.emit("log", { level: "info", msg: `stack detected: ${main.stack.framework}${main.stack.buildTool ? " · " + main.stack.buildTool : ""}` });
  fs.writeFileSync(path.join(outDir, "design-tokens.json"), JSON.stringify(main.tokensV2 || {}, null, 2));
  fs.writeFileSync(
    path.join(outDir, "clone.json"),
    JSON.stringify(
      {
        mode: "url",
        source: url,
        finalUrl: main.finalUrl,
        generatedAt: new Date().toISOString(),
        stack: main.stack || null,
        pages: pages.map((p, i) => ({ file: p.file, title: p.title, url: p.url, screenshot: i === 0 ? "_reference/page-1.png" : null })),
        mhtml: main.mhtml ? "snapshot.mhtml" : null,
        tokens: main.tokens,
      },
      null,
      2,
    ),
  );
  bus.emit("step", { id: "assemble", status: "done", msg: `${pages.length} page(s), ${urlMap.size} assets → ${path.basename(outDir)}` });

  // interaction replay runtime (recorded overlays → clickable in the clone)
  if (main.interactions?.length) {
    fs.writeFileSync(path.join(outDir, "cloner-runtime.js"), buildRuntime(main.interactions));
    const idxPath = path.join(outDir, "index.html");
    let idxHtml = fs.readFileSync(idxPath, "utf8");
    if (!idxHtml.includes("cloner-runtime.js")) {
      idxHtml = idxHtml.replace(/<\/body>/i, '<script src="cloner-runtime.js"></script></body>');
      fs.writeFileSync(idxPath, idxHtml);
    }
    bus.emit("step", { id: "runtime", status: "done", msg: `${main.interactions.length} interactive overlay(s) wired to triggers` });
  }

  // --- polish with vision model ---
  if (cfg.model.provider !== "none" && cfg.polish.enabled !== false && pages[0].file) {
    await runPolish(browser, cfg, outDir, pages[0], crawl.viewport);
  } else {
    bus.emit("step", { id: "polish", status: "skip", msg: cfg.polish.enabled === false ? "polish disabled (--no-polish)" : "no vision model configured" });
  }

  await browser.close().catch(() => {});
  bus.emit("run:done", { outDir, pages: pages.length, assets: urlMap.size });
  return { outDir, pages };
}

// rewrite internal links between cloned pages so navigation works inside the clone
function rewriteLinks(html, pageUrl, pages, origin) {
  for (let i = 0; i < pages.length; i++) {
    if (!pages[i].file || pages[i].url === pageUrl) continue;
    const target = new RegExp(`(href=["'])${escapeRe(pages[i].url)}(["'])`, "gi");
    html = html.replace(target, `$1${pages[i].file}$2`);
    // also match without trailing slash variations / query-less forms
    const bare = pages[i].url.replace(/\?.*$/, "");
    if (bare !== pages[i].url) {
      html = html.replace(new RegExp(`(href=["'])${escapeRe(bare)}(["'])`, "gi"), `$1${pages[i].file}$2`);
    }
  }
  return html;
}
function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function isChallenge(cap) {
  const t = (cap.title || "").toLowerCase();
  return /just a moment|attention required|verify you are human|access denied/.test(t) || (cap.html || "").slice(0, 4000).includes("cf-challenge");
}
