// Minimal static server for the toolbar fixture (fixture-toolbar.html).
// Usage: node scripts/serve-fixture.mjs [port]   (default 8123)
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const port = Number(process.argv[2]) || 8123;

http
  .createServer((req, res) => {
    const rel = decodeURIComponent(req.url.split("?")[0]).replace(/^\//, "") || "fixture-toolbar.html";
    const file = path.join(__dirname, rel);
    try {
      const body = fs.readFileSync(file);
      res.writeHead(200, { "content-type": file.endsWith(".css") ? "text/css" : "text/html" });
      res.end(body);
    } catch {
      res.writeHead(404);
      res.end("not found");
    }
  })
  .listen(port, "127.0.0.1", () => console.log(`fixture server on http://127.0.0.1:${port}/fixture-toolbar.html`));
