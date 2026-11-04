// Fixture: LEGAL mock usage — this is a test file, and under the no-mocks
// mandate mocks live here (standing in for the REMOTE third-party side).
// The scanner must produce ZERO findings for this file.
import { fakeGateway } from "../src/mock-gateway.js";

function mockTransport() {
  return { send: () => "simulated remote" };
}

const MOCK_ENDPOINTS = { billing: fakeGateway };

export function simulateRemote() {
  const t = mockTransport();
  return t.send() + Object.keys(MOCK_ENDPOINTS).length;
}
