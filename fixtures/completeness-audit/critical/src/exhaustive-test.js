// Fixture: a TEST file shipped inside the product tree (src/) — the
// test-code-in-product detector must flag it. Its mock usage stays legal
// (basename makes it a test-tier file), so NO mock finding may appear here.
function mockTransport() {
  return { send: () => "simulated remote" };
}

export function runEverywhere() {
  return mockTransport().send();
}
