// Reconstruction intelligence layer (task 5.0 / G3.1) — public API barrel.
//
// Modules (see each file's header for the full contract):
//   pattern-library        persistent cross-clone component-pattern library
//                          (PG product backend, deterministic memory fallback),
//                          evidence-gated understanding boosts, hit-rate telemetry
//   offline-learner        deterministic offline-trained kind scorer
//                          (logistic regression on existing understanding models)
//   behavior-inference     declarative behavior descriptors from understanding
//                          models (tabs/accordion/carousel/modal/infinite-scroll/
//                          form) — evidence-only, nothing invented
//   adaptive-exploration   uncertainty/coverage-gap/info-gain candidate ranking,
//                          budgeted coverage maximizer (plateau detection),
//                          exploration-depth recommendations
//   benchmark-intelligence regression detection + trend summaries over the
//                          EXISTING multisite benchmark outputs (deterministic)
//
// visual-optimizer.js lives beside these modules but is owned by the visual
// intelligence task — import it directly, not through this barrel.

export * from "./pattern-library.js";
export * from "./offline-learner.js";
export * from "./behavior-inference.js";
export * from "./adaptive-exploration.js";
export * from "./benchmark-intelligence.js";
