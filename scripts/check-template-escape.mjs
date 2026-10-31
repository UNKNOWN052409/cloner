// Reproduce how the module's template literal evaluates the glyph-filter line.
import fs from "node:fs";
const src = fs.readFileSync(new URL("../src/interactions.js", import.meta.url), "utf8");
const start = src.indexOf("`", src.indexOf("const CLASSIFY_SRC"));
const end = src.indexOf("`;", start);
// Evaluate template-literal escape sequences exactly as JS does:
const body = src.slice(start + 1, end);
const evaluated = body.replace(/\\(.)/g, (_, c) => {
  const map = { n: "\n", t: "\t", s: "s", "\\": "\\", "`": "`", $: "$", 0: "\0" };
  return map[c] ?? c;
});
const line = evaluated.split("\n").find((l) => l.includes("glyphy"));
console.log("Module-evaluated glyph line:");
console.log(line.trim());
// What does the regex actually test now?
const m = line.match(/\/(.+?)\/i\.test/);
if (m) {
  const re = new RegExp(m[1], "i");
  console.log("\nregex source as evaluated:", m[1]);
  console.log("test 'icon icon-plus':", re.test("icon icon-plus"));
  console.log("test 'btn btn-icon':", re.test("btn btn-icon"));
  console.log("test '':", re.test(""));
}
