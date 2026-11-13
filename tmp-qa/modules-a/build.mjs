// QA-only harness bundler. Runs from the clone project dir:
//   node ../../tmp-qa/modules-a/build.mjs
import { fileURLToPath } from "node:url";
import path from "node:path";
import { createRequire } from "node:module";

const here = path.dirname(fileURLToPath(import.meta.url));
const project = path.resolve(here, "../../artifacts/tradovate-frontend-clone");
const require = createRequire(import.meta.url);
const esbuild = require(path.join(project, "node_modules/esbuild"));

esbuild.buildSync({
  entryPoints: [path.join(here, "harness.jsx")],
  bundle: true,
  outfile: path.join(here, "harness.js"),
  format: "iife",
  loader: { ".jsx": "jsx" },
  jsx: "automatic",
  nodePaths: [path.join(project, "node_modules")],
  define: { "process.env.NODE_ENV": '"development"' },
  logLevel: "info",
});

console.log("harness bundled:", path.join(here, "harness.js"));
