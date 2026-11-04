// Vite build for the G2.1 dashboard (task G2.1) — compiles the Vue views in
// platform-ui/src into a standalone static app under platform-ui/dist/dashboard,
// served by the REAL platform static server (server.js `app.use("/ui", express.static(...))`)
// at /ui/dist/dashboard/index.html. No runtime CDN, no mock data.
//
// Build:  npx vite build --config scripts/vite.config-dashboard.mjs
import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  plugins: [vue()],
  base: "/ui/dist/dashboard/",
  root: path.join(here, "..", "platform-ui", "src", "dashboard"),
  build: {
    outDir: path.join(here, "..", "platform-ui", "dist", "dashboard"),
    emptyOutDir: true,
    rollupOptions: {
      input: path.join(here, "..", "platform-ui", "src", "dashboard", "index.html"),
      output: {
        entryFileNames: "main.js",
        chunkFileNames: "assets/[name]-[hash].js",
        assetFileNames: "assets/[name]-[hash][extname]",
      },
    },
  },
});
