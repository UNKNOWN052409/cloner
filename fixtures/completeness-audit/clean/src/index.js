// Fixture consumer for the clean module: every export above is wired here.
import { deliver, readState, labelFor, report, degraded } from "./clean-module.js";

function run() {
  deliver("x");
  readState("state.json");
  labelFor({ count: 1 });
  const minimalRes = { status() { return { json() {} }; } };
  report(minimalRes, {});
  degraded(minimalRes);
}

run();
