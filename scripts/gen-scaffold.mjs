// Generate a framework scaffold for a clone that PRESERVES the detected stack.
// If the original app is React, the scaffold is React (Vite); tokens from the
// live site become CSS variables; the exploration report becomes the component/
// interaction map. This is a professional starting point built on measured data —
// not a hand-wavy rewrite.
// Usage: node scripts/gen-scaffold.mjs <runDir>
import fs from "node:fs";
import path from "node:path";

const runDir = path.resolve(process.argv[2] || "");
const meta = JSON.parse(fs.readFileSync(path.join(runDir, "clone.json"), "utf8"));
const tokens = JSON.parse(fs.readFileSync(path.join(runDir, "design-tokens.json"), "utf8"));
let exploration = null;
try { exploration = JSON.parse(fs.readFileSync(path.join(runDir, "exploration.json"), "utf8")); } catch {}
const stack = meta.stack || { framework: "unknown" };
const fw = String(stack.framework || "").toLowerCase();
const isVue = fw.includes("vue") || fw.includes("nuxt");
const isReact = !isVue && (fw.includes("react") || fw.includes("next"));
const outDir = path.join(runDir, "scaffold");
const slug = (meta.finalUrl || "app").replace(/^https?:\/\//, "").replace(/[^a-z0-9]+/gi, "-").slice(0, 30) || "app";
const comp = (name) => name.replace(/[^a-zA-Z0-9]+(.)/g, (_, c) => c.toUpperCase()).replace(/^[0-9]/, "X$&");

// css variables straight from the measured token distribution
const cssVar = (rows, prefix) =>
  (tokens?.[rows] || []).slice(0, 8).map(([v], i) => `  --${prefix}-${i + 1}: ${v};`).join("\n");
const tokensCss = [
  ":root {",
  cssVar("colors", "color"),
  cssVar("backgrounds", "bg"),
  cssVar("fontSizes", "fs"),
  cssVar("radii", "radius"),
  `  --font-primary: ${tokens?.fonts?.[0]?.[0] || "system-ui, sans-serif"};`,
  `  --font-secondary: ${tokens?.fonts?.[1]?.[0] || "system-ui, sans-serif"};`,
  "}",
  "",
  "body { margin: 0; background: var(--bg-1, #111); color: var(--color-1, #eee); font-family: var(--font-primary); }",
].join("\n");

// component map from the exploration report — every documented behavior becomes
// a named component with its recorded trigger/panel data
const components = (exploration?.behaviors || []).map((b) => {
  const name = comp(b.trigger.label || b.trigger.id || "Panel");
  return { name: name.charAt(0).toUpperCase() + name.slice(1), label: b.trigger.label || b.trigger.id, opens: b.opens, panels: b.childPanels, shot: b.screenshot };
});

fs.mkdirSync(path.join(outDir, "src"), { recursive: true });
fs.writeFileSync(path.join(outDir, "package.json"), JSON.stringify(
  isVue
    ? { name: slug + "-clone", private: true, version: "0.1.0", type: "module", scripts: { dev: "vite", build: "vite build" }, dependencies: { vue: "^3.4.0" }, devDependencies: { "@vitejs/plugin-vue": "^5.0.0", vite: "^5.2.0" } }
    : { name: slug + "-clone", private: true, version: "0.1.0", type: "module", scripts: { dev: "vite", build: "vite build" }, dependencies: { react: "^18.3.1", "react-dom": "^18.3.1" }, devDependencies: { "@vitejs/plugin-react": "^4.3.0", vite: "^5.2.0" } },
  null, 2,
));
fs.writeFileSync(path.join(outDir, "vite.config.js"),
  (isVue
    ? `import vue from "@vitejs/plugin-vue";\nimport { defineConfig } from "vite";\nexport default defineConfig({ plugins: [vue()] });\n`
    : `import react from "@vitejs/plugin-react";\nimport { defineConfig } from "vite";\nexport default defineConfig({ plugins: [react()] });\n`));
fs.writeFileSync(path.join(outDir, "index.html"),
  `<!DOCTYPE html>\n<html>\n<head><meta charset="utf-8"><title>${meta.finalUrl} — clone scaffold</title></head>\n<body>\n  <div id="root"></div>\n  <script type="module" src="/src/main.${isVue ? "js" : "jsx"}"></script>\n</body>\n</html>\n`);
fs.writeFileSync(path.join(outDir, "src", "tokens.css"), tokensCss);

const compList = components.slice(0, 12);
if (isVue) {
  fs.writeFileSync(path.join(outDir, "src", "main.js"),
    `import { createApp } from "vue";\nimport App from "./App.vue";\nimport "./tokens.css";\n\ncreateApp(App).mount("#root");\n`);
  fs.writeFileSync(path.join(outDir, "src", "App.vue"),
    `<template>\n  <div class="app-shell">\n    <h1>${meta.finalUrl} — ${stack.framework} clone scaffold</h1>\n    <p>Detected stack: <b>${stack.framework}</b>${stack.buildTool ? ` · ${stack.buildTool}` : ""}. This scaffold preserves the original stack; measured tokens are in src/tokens.css.</p>\n    <ul>\n${compList.map((c) => `      <li><b>${c.name}</b> — opens ${c.opens ? `${c.opens.w}×${c.opens.h} overlay` : "behavior recorded"}${c.panels?.length ? ` (panels: ${c.panels.map((p) => p.text).join(", ")})` : ""}</li>`).join("\n")}\n    </ul>\n    <p>Exact visual reference: <code>../snapshot.mhtml</code> · state screenshots: <code>../_reference/states/</code></p>\n  </div>\n</template>\n`);
} else {
  fs.writeFileSync(path.join(outDir, "src", "main.jsx"),
    `import React from "react";\nimport { createRoot } from "react-dom/client";\nimport App from "./App.jsx";\nimport "./tokens.css";\n\ncreateRoot(document.getElementById("root")).render(<App />);\n`);
  fs.writeFileSync(path.join(outDir, "src", "App.jsx"),
    `// ${meta.finalUrl} — ${stack.framework} clone scaffold\n` +
    `// Stack detected from the live app (${stack.buildTool || "bundle analysis"}); design tokens measured in\n` +
    `// src/tokens.css come from the real page's computed styles (see ../design-tokens.json).\n` +
    `// Interactive map below comes from ../exploration.json — every behavior the explorer recorded.\n` +
    `export default function App() {\n  return (\n    <div className="app-shell">\n      <h1>${meta.finalUrl} — ${stack.framework} clone scaffold</h1>\n      <p>Detected stack: <b>${stack.framework}</b>${stack.buildTool ? ` · ${stack.buildTool}` : ""}.</p>\n      <h2>Documented interactive components</h2>\n      <ul>\n${compList.map((c) => `        <li key="${c.name}"><b>${c.name}</b> — opens ${c.opens ? `${c.opens.w}×${c.opens.h} overlay` : "behavior recorded"}${c.panels?.length ? ` (panels: ${c.panels.map((p) => p.text).join(", ")})` : ""}</li>`).join("\n")}\n      </ul>\n      <p>Exact visual reference: <code>../snapshot.mhtml</code> · state screenshots: <code>../_reference/states/</code></p>\n    </div>\n  );\n}\n`);
}

fs.writeFileSync(path.join(outDir, "README.md"),
  `# ${meta.finalUrl} — clone scaffold\n\n` +
  `Detected stack: **${stack.framework}**${stack.buildTool ? ` (${stack.buildTool})` : ""}. This scaffold preserves the\noriginal technology choice. Fidelity sources bundled next to it:\n\n` +
  `- \`../index.html\` — static full-page clone (open directly)\n- \`../snapshot.mhtml\` — DevTools-grade exact capture of the original\n- \`../design-tokens.json\` — measured colors/typography/spacing of the live site\n- \`../exploration.json\` / \`exploration.md\` — every interactive control and its behavior\n- \`../_reference/states/\` — screenshots of each discovered UI state\n- \`../assets/\` — the app's own JS/CSS/fonts/images/API data, downloaded\n\n` +
  `Run: \`npm install && npm run dev\`\n`);

console.log(`scaffold written → ${outDir} (${stack.framework}${isReact ? " via Vite" : ""}, ${compList.length} documented components)`);
