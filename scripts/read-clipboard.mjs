// UTF-8-safe clipboard reader: writes clipboard to stdout as UTF-8.
// (Get-Clipboard -Raw through execFileSync mangles non-ASCII due to console codepage)
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = path.join(os.tmpdir(), "clip-" + Date.now() + ".txt");
execFileSync("powershell", [
  "-NoProfile", "-NonInteractive", "-Command",
  `$t = Get-Clipboard -Raw; [IO.File]::WriteAllText('${tmp.replace(/'/g, "''")}', $t, [Text.Encoding]::UTF8)`,
], { timeout: 20000, windowsHide: true });
const text = fs.readFileSync(tmp, "utf8");
fs.rmSync(tmp, { force: true });
process.stdout.write(text);
