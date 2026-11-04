// Fixture: the mock module referenced by billing-stub.js. Its content itself is
// inert — the violation is importing it from a PRODUCT file, which the scanner
// must catch via the specifier.
export const fakeGateway = {};
