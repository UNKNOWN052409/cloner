// Fixture (critical case): a product file stuffed with every seeded violation.
// seed:mock-import — mock import in a PRODUCT path (illegal here).
import { fakeGateway } from "./mock-gateway.js";
import fs from "node:fs"; // legal builtin import

// Fixture comment only: this module pretends to be real billing glue.
// seed:todo — TODO marker in product code.
// TODO: wire the real payment gateway before shipping
// seed:hack — HACK annotation in product code.
// HACK: bypassing validation because it is easier for now

// seed:not-implemented — declared not-implemented.
export function chargeCard(amount) {
  throw new Error("not implemented yet");
}

// seed:stub-return — placeholder return annotated as stub.
export function getBalance() {
  // stub until the ledger lands
  return null;
}

// seed:unwired — exported but referenced nowhere outside this file.
export function neverWiredHook() {
  return fs.readFileSync("/dev/null", "utf8");
}
