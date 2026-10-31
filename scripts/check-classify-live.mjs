// Verify the glyph filter works when CLASSIFY_SRC is compiled exactly the way
// interactions.js compiles it (real import of the module's own string).
import { chromium } from "playwright";
import fs from "node:fs";

const text = fs.readFileSync(new URL("../src/interactions.js", import.meta.url), "utf8");
const start = text.indexOf("`", text.indexOf("const CLASSIFY_SRC"));
const end = text.indexOf("`;", start);
// evaluate the template literal exactly as the module does
const CLASSIFY_SRC = eval("`" + text.slice(start + 1, end) + "`");
const classify = new Function("args", "return (" + CLASSIFY_SRC + ")(args)");

const b = await chromium.launch();
const p = await b.newPage();
await p.goto("http://127.0.0.1:8123/fixture-toolbar.html");
const res = await p.evaluate(classify, { dangerousSrc: "(buy|sell|close)", max: 60, onlyIds: null });
console.log("marked:", res.marked.map((x) => x.id + ":" + x.text).join(" | "));
console.log("rejects:", JSON.stringify(res.rej));
await b.close();
