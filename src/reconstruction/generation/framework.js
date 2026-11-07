// Framework emitters (R-P0.22) — emit a REAL React/Vue project beside the
// static clone when the blueprint's output framework is react/vue.
//
// FIDELITY CONTRACT (v2 — the v1 skeleton emitter produced a black screen and
// was thrown away): the framework project must render the SAME pixels as the
// verified static clone. It therefore reuses the static clone's own artifacts:
//   • each captured page becomes one component whose body markup is the
//     generated page's own <body> inner HTML, carried through
//     dangerouslySetInnerHTML / v-html (markup is engine-generated and already
//     escaped — no conversion pass can lose structure or pixels);
//   • the clone's real stylesheets are imported verbatim (font/image urls
//     rewritten for the bundler);
//   • the clone's runtime scripts (interactions/app-state/streams) ship in
//     public/clone-runtime/ and are loaded as CLASSIC <script> tags after the
//     page mounts — the same execution order the static page has; the page's
//     inline scripts are replayed the same way;
//   • document.body.dataset.page is set per page so body[data-page="…"] rules
//     keep applying, and display:contents wrappers keep the clone's own
//     `body > …` / descendant selectors effective;
//   • NO app chrome (no nav bar): pixel parity with the static clone comes
//     first. Switch pages via the URL hash (#page-002), not a toolbar;
//   • the static clone ships in public/reference/ for side-by-side.
// Evidence-only: no invented markup. A page with no generated html is skipped.
import fs from "node:fs";
import path from "node:path";

const comp = (name) => name.replace(/[^a-zA-Z0-9]+(.)/g, (_, c) => c.toUpperCase()).replace(/^[0-9]/, "X$&");
const CSS_FILES = ["tokens.css", "layout.css", "components.css", "responsive.css", "workspace.css"];
const RUNTIME_PUBLIC = "clone-runtime"; // public/ subdir the runtime scripts load from

// body inner markup of one generated page (+ its data-page value)
function readPageMarkup(file) {
  if (!file || !fs.existsSync(file)) return null;
  const html = fs.readFileSync(file, "utf8");
  const bodyOpen = html.match(/<body([^>]*)>/i);
  if (!bodyOpen) return null;
  const start = bodyOpen.index + bodyOpen[0].length;
  const end = html.lastIndexOf("</body>");
  if (end < 0) return null;
  let inner = html.slice(start, end);
  // the engine's boot scripts at the end of body are replayed by the framework
  // app itself (inline snippets first, then src files) so ORDER is preserved
  const inlineScripts = [...inner.matchAll(/<script\b(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)].map((m) => m[1].trim()).filter(Boolean);
  const scriptSrcs = [...inner.matchAll(/<script\b[^>]*\bsrc="([^"]+)"/gi)].map((m) => m[1]);
  inner = inner.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "");
  const dp = /data-page="([^"]+)"/.exec(bodyOpen[1]);
  const inlineCss = [...html.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gi)].map((m) => m[1]).join("\n");
  return { inner: inner.trim(), dataPage: dp ? dp[1] : null, inlineCss, inlineScripts, scriptSrcs };
}

function cssBundleFrom(stylesDir) {
  return CSS_FILES.map((f) => {
    const p = path.join(stylesDir, f);
    if (!fs.existsSync(p)) return null;
    let css = fs.readFileSync(p, "utf8");
    // font/image urls: ../public/assets/x → /assets/x (Vite serves public/ at /)
    css = css.replace(/url\((["']?)\.\.\/public\/assets\//g, "url($1/assets/");
    css = css.replace(/url\((["']?)assets\//g, "url($1/assets/");
    // absolute live-site urls (unreachable offline) → none, so the clone never
    // requests the original site
    css = css.replace(/url\((["']?)https?:\/\/[^)"']+(["']?)\)/g, "none");
    return `/* ${f} (verbatim clone stylesheet) */\n${css}`;
  }).filter(Boolean).join("\n\n");
}

// runtime files actually referenced by the pages (in first-page order), plus
// any extra runtime/*.js the generator emitted
function runtimeFilesFor(pages, runtimeDir) {
  const referenced = [];
  for (const p of pages) for (const s of p.scriptSrcs) if (!referenced.includes(s)) referenced.push(s);
  const extras = fs.existsSync(runtimeDir) ? fs.readdirSync(runtimeDir).filter((f) => f.endsWith(".js")).sort().map((f) => `runtime/${f}`) : [];
  for (const e of extras) if (!referenced.includes(e)) referenced.push(e);
  return referenced;
}

// emitted once into the app: classic-script loader + per-mount boot
const BOOT_JS = `
// clone runtime boot: classic <script> injection preserves the static page's
// execution order and non-module semantics (state prep → behaviors)
window.__CLONER_RUNTIME_LOADED__ = {};
window.__CLONER_BOOT__ = function (dataPage) {
  if (dataPage) document.body.dataset.page = dataPage;
  var st = window.__CLONER_BOOT_STATE__ || (window.__CLONER_BOOT_STATE__ = { page: null });
  if (st.page === dataPage) return; // same page remount — runtime already booted
  st.page = dataPage;
  var files = window.__CLONER_PAGE_RUNTIME__[dataPage] || window.__CLONER_PAGE_RUNTIME__.__default__ || [];
  var inline = window.__CLONER_PAGE_INLINE__[dataPage] || [];
  for (var i = 0; i < inline.length; i++) {
    try { (0, eval)(inline[i]); } catch (e) { console.warn("[clone-boot] inline script failed", e); }
  }
  for (var j = 0; j < files.length; j++) {
    var src = files[j];
    if (window.__CLONER_RUNTIME_LOADED__[src]) { continue; }
    window.__CLONER_RUNTIME_LOADED__[src] = true;
    var s = document.createElement("script");
    s.src = "/${RUNTIME_PUBLIC}/" + src.replace(/^(\\.\\.\\/|\\.\\/|\\/)+/, "").replace(/^runtime\\//, "");
    s.async = false; // preserve order across the queue
    document.body.appendChild(s);
  }
};
`;

/**
 * Emit a framework project into <outDir>-framework/ (react|vue via Vite).
 * Renders the verified static clone's own markup — same pixels, real framework.
 */
export function emitFrameworkProject({ artifactsDir, outDir, framework, pageFiles, tokens, originalUrl, logger = null }) {
  const fw = String(framework || "static").toLowerCase();
  if (fw === "static" || !fw) return { ok: false, why: "framework=static — no emitter" };
  const isVue = fw.includes("vue") || fw.includes("nuxt");
  const isReact = !isVue && (fw.includes("react") || fw.includes("next"));
  if (!isVue && !isReact) return { ok: false, why: `no emitter for framework "${framework}"` };
  if (!fs.existsSync(outDir)) return { ok: false, why: "static clone dir missing — nothing to re-render" };

  const dir = outDir + "-framework";
  const slug = (originalUrl || "app").replace(/^https?:\/\//, "").replace(/[^a-z0-9]+/gi, "-").slice(0, 30) || "app";

  // ---- pages: one component per generated page file (verbatim body markup) ----
  const files = (pageFiles || []).filter((p) => p && p.file);
  const pages = [];
  for (const p of files) {
    const m = readPageMarkup(path.join(outDir, p.file));
    if (!m || !m.inner) continue;
    pages.push({ ...p, ...m, name: comp(p.pageId) + "Page" });
  }
  if (!pages.length) return { ok: false, why: "no generated page markup found" };

  fs.mkdirSync(path.join(dir, "src", "components"), { recursive: true });
  fs.mkdirSync(path.join(dir, "public", RUNTIME_PUBLIC), { recursive: true });

  // package.json
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify(
    isVue
      ? { name: slug + "-clone", private: true, version: "0.1.0", type: "module", scripts: { dev: "vite", build: "vite build", preview: "vite preview" }, dependencies: { vue: "^3.4.0" }, devDependencies: { "@vitejs/plugin-vue": "^5.0.0", vite: "^5.2.0" } }
      : { name: slug + "-clone", private: true, version: "0.1.0", type: "module", scripts: { dev: "vite", build: "vite build", preview: "vite preview" }, dependencies: { react: "^18.3.1", "react-dom": "^18.3.1" }, devDependencies: { "@vitejs/plugin-react": "^4.3.0", vite: "^5.2.0" } },
    null, 2,
  ));
  fs.writeFileSync(path.join(dir, "vite.config.js"),
    isVue
      ? `import vue from "@vitejs/plugin-vue";\nimport { defineConfig } from "vite";\nexport default defineConfig({ plugins: [vue()], publicDir: "public" });\n`
      : `import react from "@vitejs/plugin-react";\nimport { defineConfig } from "vite";\nexport default defineConfig({ plugins: [react()], publicDir: "public" });\n`);
  fs.writeFileSync(path.join(dir, "index.html"),
    `<!DOCTYPE html>\n<html lang="en">\n<head>\n  <meta charset="utf-8">\n  <title>${originalUrl} — ${fw} clone</title>\n</head>\n<body>\n  <div id="root"></div>\n  <script type="module" src="/src/main.${isVue ? "js" : "jsx"}"></script>\n</body>\n</html>\n`);

  // ---- styles: verbatim clone CSS + wrappers transparent for layout ----
  const stylesDir = path.join(outDir, "styles");
  const compat = [
    "/* framework-app compatibility: the clone's markup must lay out as if the",
    "   wrappers were not there (its CSS uses body-descendant + body> selectors) */",
    "#root, .clone-shell, .clone-host { display: contents; }",
  ].join("\n");
  fs.writeFileSync(path.join(dir, "src", "clone.css"), compat + "\n\n" + cssBundleFrom(stylesDir) + "\n");
  const extraCss = pages.filter((p) => p.inlineCss).map((p) => `/* ${p.pageId} inline styles */\n${p.inlineCss}`);
  if (extraCss.length) fs.writeFileSync(path.join(dir, "src", "page-inline.css"), extraCss.join("\n\n") + "\n");

  // ---- assets: captured assets + the runtime as classic scripts ----
  const assetsSrc = path.join(outDir, "public", "assets");
  if (fs.existsSync(assetsSrc)) fs.cpSync(assetsSrc, path.join(dir, "public", "assets"), { recursive: true });
  const runtimeSrc = path.join(outDir, "runtime");
  const runtimes = runtimeFilesFor(pages, runtimeSrc);
  for (const r of runtimes) {
    const from = path.join(outDir, r);
    if (fs.existsSync(from)) fs.copyFileSync(from, path.join(dir, "public", RUNTIME_PUBLIC, path.basename(r)));
  }
  // static clone reference (exclude a nested reference copy)
  fs.cpSync(outDir, path.join(dir, "public", "reference"), { recursive: true, filter: (s) => !s.includes(path.join("public", "reference")) });

  // per-page runtime + inline maps for the boot hook
  const runtimeMap = {};
  const inlineMap = {};
  for (const p of pages) {
    runtimeMap[p.dataPage || p.pageId] = p.scriptSrcs.length ? p.scriptSrcs : runtimes;
    inlineMap[p.dataPage || p.pageId] = p.inlineScripts || [];
  }
  fs.writeFileSync(path.join(dir, "src", "boot.js"),
    `window.__CLONER_PAGE_RUNTIME__ = ${JSON.stringify(runtimeMap)};\n` +
    `window.__CLONER_PAGE_INLINE__ = ${JSON.stringify(inlineMap)};\n` +
    BOOT_JS);

  // ---- components: verbatim markup, framework-owned boot ----
  if (isReact) {
    for (const p of pages) {
      fs.writeFileSync(path.join(dir, "src", "components", `${p.name}.jsx`),
        `import { useEffect } from "react";\n\n` +
        `// ${p.route || p.pageId} — verbatim markup from the verified static clone\n` +
        `// (engine-generated, already escaped: rendered through dangerouslySetInnerHTML\n` +
        `// so no conversion pass can lose structure or a single pixel)\n` +
        `const MARKUP = ${JSON.stringify(p.inner)};\n\n` +
        `export default function ${p.name}() {\n` +
        `  useEffect(() => {\n` +
        `    if (window.__CLONER_BOOT__) window.__CLONER_BOOT__(${JSON.stringify(p.dataPage || p.pageId)});\n` +
        `  }, []);\n` +
        `  return <div className="clone-host" dangerouslySetInnerHTML={{ __html: MARKUP }} />;\n` +
        `}\n`);
    }
    const imports = pages.map((p) => `import ${p.name} from "./components/${p.name}.jsx";`).join("\n");
    const switchCases = pages.map((p) => `    case ${JSON.stringify(p.pageId)}:\n    case ${JSON.stringify(p.route || "")}: return <${p.name} />;`).join("\n");
    fs.writeFileSync(path.join(dir, "src", "main.jsx"),
      `import React, { useEffect, useState } from "react";\nimport { createRoot } from "react-dom/client";\nimport "./boot.js";\nimport "./clone.css";\n` +
      (extraCss.length ? `import "./page-inline.css";\n` : ``) +
      `${imports}\n\n` +
      `const DEFAULT_PAGE = ${JSON.stringify(pages[0].dataPage || pages[0].pageId)};\n` +
      `const PAGES = {${pages.map((p) => ` ${JSON.stringify(p.dataPage || p.pageId)}: ${p.name}`).join(",")} };\n` +
      `function CurrentPage() {\n` +
      `  const [key, setKey] = useState(location.hash.slice(1) || DEFAULT_PAGE);\n` +
      `  useEffect(() => {\n` +
      `    const on = () => setKey(location.hash.slice(1) || DEFAULT_PAGE);\n` +
      `    window.addEventListener("hashchange", on);\n` +
      `    return () => window.removeEventListener("hashchange", on);\n` +
      `  }, []);\n` +
      `  const C = PAGES[key];\n  if (!C) {\n    switch (key) {\n` +
      switchCases + `\n` +
      `    default: return <div className="clone-missing">{"page " + key + " not in this clone"}</div>;\n    }\n  }\n` +
      `  return <C key={key} />;\n}\n` +
      `function App() { return <div className="clone-shell"><CurrentPage /></div>; }\n` +
      `createRoot(document.getElementById("root")).render(<App />);\n`);
  } else {
    for (const p of pages) {
      fs.writeFileSync(path.join(dir, "src", "components", `${p.name}.vue`),
        `<script setup>\nimport { onMounted } from "vue";\nconst markup = ${JSON.stringify(p.inner)};\nonMounted(() => {\n` +
        `  if (window.__CLONER_BOOT__) window.__CLONER_BOOT__(${JSON.stringify(p.dataPage || p.pageId)});\n});\n</script>\n\n` +
        `<template>\n  <div class="clone-host" v-html="markup" />\n</template>\n`);
    }
    const imports = pages.map((p) => `import ${p.name} from "./components/${p.name}.vue";`).join("\n");
    fs.writeFileSync(path.join(dir, "src", "main.js"),
      `import { createApp, h, ref } from "vue";\nimport "./boot.js";\nimport "./clone.css";\n` +
      (extraCss.length ? `import "./page-inline.css";\n` : ``) +
      `${imports}\n\n` +
      `const DEFAULT_PAGE = ${JSON.stringify(pages[0].dataPage || pages[0].pageId)};\n` +
      `const PAGES = {${pages.map((p) => ` ${JSON.stringify(p.dataPage || p.pageId)}: ${p.name}`).join(",")} };\n` +
      `const key = ref(location.hash.slice(1) || DEFAULT_PAGE);\n` +
      `window.addEventListener("hashchange", () => { key.value = location.hash.slice(1) || DEFAULT_PAGE; });\n` +
      `const App = { setup() { return () => h("div", { class: "clone-shell" }, [\n` +
      `  PAGES[key.value] ? h(PAGES[key.value], { key: key.value }) : h("div", { class: "clone-missing" }, "page " + key.value + " not in this clone"),\n` +
      `]); } };\ncreateApp(App).mount("#root");\n`);
  }

  fs.writeFileSync(path.join(dir, "README.md"),
    `# ${originalUrl} — ${isVue ? "Vue" : "React"} clone\n\n` +
    `Renders the **verified static clone's own markup** — same pixels, real framework.\n\n` +
    `- \`src/components/*\` — one component per captured page (verbatim body markup)\n` +
    `- \`src/clone.css\` — the clone's measured stylesheets, verbatim\n` +
    `- \`public/clone-runtime/*\` — the clone's behavior runtime, loaded as classic scripts per page\n` +
    `- \`public/reference/\` — the static clone, side-by-side\n\n` +
    `Pages: ${pages.map((p) => (p.route || p.pageId) + " (#" + (p.dataPage || p.pageId) + ")").join(", ")}\n\n` +
    `Run: \`npm install && npm run dev\` — switch pages with the URL hash.\n`);

  if (logger) logger.info("framework", `emitted ${isVue ? "vue" : "react"} project (${pages.length} verbatim-markup page components)`);
  return { ok: true, dir, framework: isVue ? "vue" : "react", files: pages.length + 8, components: pages.length, pages: pages.map((p) => p.pageId) };
}
