// Fixture (warnings-only): every finding here is warning/info tier, so the
// audit exit code must stay 0 even though findings exist.
// seed:xxx — XXX annotation in product code.
// XXX: quick path, revisit later
// seed:hack-warn — HACK annotation in product code.
// HACK: relies on cache timing

// seed:unwired-warn — exported but referenced nowhere.
export function orphanHook() {
  return true;
}

function emptyHandler() {}
