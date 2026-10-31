// probe: parse the embedded __CLONER_INTERACTIONS array from a generated runtime
import fs from "node:fs";
const rt = fs.readFileSync(process.argv[2] || "artifacts/exp-mvweqx532j3d-project/runtime/interactions.js", "utf8");
const arrStart = rt.indexOf("[", rt.indexOf("window.__CLONER_INTERACTIONS = "));
let depth = 0, end = -1, inStr = false, esc = false;
for (let i = arrStart; i < rt.length; i++) {
  const c = rt[i];
  if (esc) { esc = false; continue; }
  if (c === "\\") { esc = true; continue; }
  if (c === '"') inStr = !inStr;
  if (inStr) continue;
  if (c === "[") depth++;
  if (c === "]") { depth--; if (depth === 0) { end = i; break; } }
}
const embedded = JSON.parse(rt.slice(arrStart, end + 1));
console.log("runtime records:", embedded.map((r) => `${r.id}:${r.kind}:${(r.text || "").slice(0, 16)}`).join(" | "));
console.log("html lengths:", embedded.map((r) => `${r.id}=${r.html.length}`).join(" "));
