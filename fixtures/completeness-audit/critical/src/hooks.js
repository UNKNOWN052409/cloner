// Fixture (critical case): one wired export, two unwired exports, one empty body.
// wiredHelper is imported by index.js; the others are referenced nowhere else.
export function wiredHelper() {
  return "used by index.js";
}

// seed:unwired-2
export function neverWiredHook2() {
  return 42;
}

// seed:empty-function
export const legacyHandler = () => {};
