// Vite build for the G2.2 admin panel (task G2.2 ui-admin) — compiles the Vue
// admin views (platform-ui/src/views/Admin*.vue + api/admin.ts) into a
// standalone static app under platform-ui/dist/admin, served by the REAL
// platform static server (server.js `app.use("/ui", express.static(...))`) at
// /ui/dist/admin/index.html. Mirrors vite.config-dashboard.mjs (G2.1).
//
// Build:  npx vite build --config scripts/vite.config-admin.mjs
import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  plugins: [vue()],
  base: "/ui/dist/admin/",
  root: path.join(here, "..", "platform-ui", "src", "admin"),
  build: {
    outDir: path.join(here, "..", "platform-ui", "dist", "admin"),
    emptyOutDir: true,
    rollupOptions: {
      input: path.join(here, "..", "platform-ui", "src", "admin", "index.html"),
      output: {
        entryFileNames: "main.js",
        chunkFileNames: "assets/[name]-[hash].js",
        assetFileNames: "assets/[name]-[hash][extname]",
      },
    },
  },
});
