#!/usr/bin/env node
// Platform entry: node bin/platform.js [--port 4180]
import { startPlatform } from "../src/platform/server.js";

const port = Number(process.argv.includes("--port") ? process.argv[process.argv.indexOf("--port") + 1] : process.env.PORT || 4180);
startPlatform({ port }).then(({ port: p }) => {
  console.log(`\n  ◉ cloner platform: http://localhost:${p}`);
  console.log("    persistent browser sessions active · 30-min idle timeout · 15-day task retention");
  console.log("    (Ctrl+C stops the platform and closes all sessions)\n");
});
