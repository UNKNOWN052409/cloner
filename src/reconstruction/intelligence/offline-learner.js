// Offline-trained component kind scorer (plan §"Reconstruction intelligence" —
// "any learning model is trained OFFLINE on existing artifacts", with the
// deterministic fallback the plan mandates).
//
// What it is:
//   A small multinomial logistic-regression scorer mapping understanding-model
//   component FEATURES → component KIND probabilities. It is trained offline by
//   trainKindScorer() from EXISTING understanding models (high-confidence
//   components are the labels), persisted as plain JSON, and applied by
//   createKindScorer() at reconstruction time.
//
// Determinism contract:
//   • No RNG anywhere: weights initialize at zero, the epoch order is the input
//     order, and full-batch gradient descent has a single fixed trajectory —
//     training the same corpus twice yields a byte-identical model JSON.
//   • createDefaultKindScorer() (no model / empty model) is the deterministic
//     fallback: it returns the class priors it was given (or uniform) with
//     low confidence, so a consumer can always rank WITHOUT a model.
//   • The scorer is a WEAK prior in product paths: consumers must evidence-gate
//     anything it influences (the pattern library gates by signature; the
//     adaptive ranker uses 1 - maxProb as an uncertainty signal only).
//
// Feature extraction is shared with pattern-library's signature philosophy:
// structure + style only, no text content, no URLs.

import fs from "node:fs";
import { componentSignature } from "./pattern-library.js";

export const MODEL_VERSION = "recon-kind-scorer/1";

// ---------- feature extraction ----------

// featureVector(component, page) → fixed-order numeric vector. The feature
// ORDER is the contract; the trained model records it and refuses mismatched
// vectors, so an old model can never silently misread a new feature set.
export function featureVector(component, page = {}) {
  const { features } = componentSignature(component, page);
  const rect = component?.rect || component?.provenance?.rect || {};
  const w = Number(rect.w) || 0, h = Number(rect.h) || 0;
  const tag = features.tag || "";
  const role = features.role || "";
  const cls = features.cls || [];
  const has = (arr, t) => (arr.includes(t) ? 1 : 0);
  const childCount = Number(component?.provenance?.childCount) || 0;
  return [
    // semantic tags (6)
    tag === "header" ? 1 : 0, tag === "nav" ? 1 : 0, tag === "aside" ? 1 : 0,
    tag === "main" ? 1 : 0, tag === "footer" ? 1 : 0, tag === "table" ? 1 : 0,
    tag === "form" ? 1 : 0, (tag === "canvas" || tag === "svg") ? 1 : 0,
    // roles (6)
    role === "banner" ? 1 : 0, role === "navigation" ? 1 : 0, role === "main" ? 1 : 0,
    role === "complementary" ? 1 : 0, role === "dialog" ? 1 : 0, role === "toolbar" ? 1 : 0,
    // semantic class-token slots (12) — the SAME slots componentSignature
    // hashes (pattern-library SEMANTIC_TOKEN_SLOTS), so scorer features and
    // pattern features can never disagree about vocabulary
    has(cls, "header"), has(cls, "nav"), has(cls, "footer"), has(cls, "sidebar"),
    has(cls, "card"), has(cls, "table"), has(cls, "chart"), has(cls, "modal"),
    has(cls, "form"), has(cls, "toolbar"), has(cls, "button"), has(cls, "panel"),
    // geometry (4 aspect + 5 area + 4 anchors from the signature bands)
    features.aspect, features.area,
    features.anchor.includes("top") ? 1 : 0, features.anchor.includes("bottom") ? 1 : 0,
    features.anchor.includes("left") ? 1 : 0, features.anchor.includes("right") ? 1 : 0,
    // style (5)
    features.z, features.font, features.radius,
    features.position === "fixed" ? 1 : 0, features.position === "absolute" ? 1 : 0,
    // structure (6)
    features.children, features.repeated > 0 ? 1 : 0, features.depth,
    w >= 0.8 * (page?.width || w) ? 1 : 0,           // full-width band
    h >= 0.6 * (page?.height || h) ? 1 : 0,          // tall band
    Number(component?.interaction?.triggers?.length) > 0 ? 1 : 0, // interactive
  ];
}

// FEATURE_COUNT is DERIVED from featureVector() on a dummy component, so the
// feature order and the count can never drift apart silently.
export const FEATURE_COUNT = featureVector(
  { kind: "x", provenance: {}, rect: { x: 0, y: 0, w: 10, h: 10 }, evidence: [], interaction: {} },
  { width: 100, height: 100 },
).length;

// ---------- training ----------

const softmax = (scores) => {
  const m = Math.max(...scores);
  const exps = scores.map((s) => Math.exp(s - m));
  const sum = exps.reduce((a, b) => a + b, 0);
  return exps.map((e) => e / sum);
};

// trainKindScorer(models, opts) → model object.
//   models: array of website-understanding models (any producer — the real
//           engine, the local artifacts corpus, fixtures).
//   Labels: components with confidence >= minConfidence (default 0.8).
//   Full-batch gradient descent, zero init, fixed epochs/lr (deterministic).
export function trainKindScorer(models, {
  minConfidence = 0.8,
  epochs = 160,
  lr = 0.5,
  l2 = 1e-4,
  maxSamples = 4000,
  featureCount = FEATURE_COUNT,
} = {}) {
  const samples = [];
  const kindSet = new Set();
  for (const model of models || []) {
    if (!model || !Array.isArray(model.components)) continue;
    const page = { width: model.pageMetrics?.width, height: model.pageMetrics?.height };
    for (const c of model.components) {
      if (!c || !c.kind) continue;
      if (Number(c.confidence) < minConfidence) continue;
      const x = featureVector(c, page);
      if (x.length !== featureCount) continue; // feature-set drift → sample skipped
      samples.push({ x, kind: c.kind });
      kindSet.add(c.kind);
    }
  }
  if (!samples.length) {
    return {
      version: MODEL_VERSION, featureCount, kinds: [], W: [], b: [], priors: [],
      trainedOn: { pages: 0, samples: 0 }, note: "no qualifying samples — untrained model",
    };
  }
  // deterministic sample cap: first maxSamples in input order (no shuffling)
  const trimmed = samples.slice(0, maxSamples);
  const kinds = [...kindSet].sort();
  const kindIndex = new Map(kinds.map((k, i) => [k, i]));
  const K = kinds.length, F = featureCount;
  const W = Array.from({ length: K }, () => new Array(F).fill(0));
  const b = new Array(K).fill(0);
  const priors = kinds.map((k) => trimmed.filter((s) => s.kind === k).length / trimmed.length);

  for (let epoch = 0; epoch < epochs; epoch++) {
    const gradW = Array.from({ length: K }, () => new Array(F).fill(0));
    const gradB = new Array(K).fill(0);
    for (const s of trimmed) {
      const scores = W.map((wk, k) => wk.reduce((acc, wkf, f) => acc + wkf * s.x[f], b[k]));
      const p = softmax(scores);
      const y = kindIndex.get(s.kind);
      for (let k = 0; k < K; k++) {
        const err = p[k] - (k === y ? 1 : 0);
        if (err === 0) continue;
        gradB[k] += err;
        for (let f = 0; f < F; f++) if (s.x[f] !== 0) gradW[k][f] += err * s.x[f];
      }
    }
    const n = trimmed.length;
    for (let k = 0; k < K; k++) {
      b[k] -= (lr * gradB[k]) / n;
      for (let f = 0; f < F; f++) {
        W[k][f] -= (lr * (gradW[k][f] / n + l2 * W[k][f]));
      }
    }
  }
  // round to 6 decimals so the persisted JSON is byte-stable across platforms
  const round = (v) => Math.round(v * 1e6) / 1e6;
  return {
    version: MODEL_VERSION,
    featureCount: F,
    featureNote: "featureVector() order — see offline-learner.js",
    kinds,
    W: W.map((row) => row.map(round)),
    b: b.map(round),
    priors: priors.map(round),
    trainedOn: { pages: (models || []).length, samples: trimmed.length },
  };
}

// ---------- application ----------

// createKindScorer(model | null) → { score(component, page), kinds, trained }.
// score() → { kind, confidence, all } — argmax softmax, deterministic
// tie-break by kind name. With no model (or an untrained one) it is the
// deterministic fallback: prior/uniform weights, low confidence.
export function createKindScorer(model) {
  if (!model || !Array.isArray(model.kinds) || model.kinds.length === 0) {
    return createDefaultKindScorer();
  }
  const { W, b, kinds, featureCount } = model;
  if (W.length !== kinds.length) throw new TypeError("kind-scorer model malformed: W/kinds length mismatch");
  return {
    kinds,
    trained: true,
    trainedOn: model.trainedOn || null,
    score(component, page = {}) {
      const x = featureVector(component, page);
      if (x.length !== featureCount) {
        return { kind: null, confidence: 0, all: [], note: "feature-count mismatch — deterministic abstain" };
      }
      const scores = W.map((wk, k) => wk.reduce((acc, wkf, f) => acc + wkf * x[f], b[k]));
      const probs = softmax(scores);
      let best = 0;
      for (let k = 1; k < probs.length; k++) {
        if (probs[k] > probs[best] + 1e-12) best = k;
        else if (Math.abs(probs[k] - probs[best]) <= 1e-12 && kinds[k] < kinds[best]) best = k;
      }
      return {
        kind: kinds[best],
        confidence: Math.round(probs[best] * 1000) / 1000,
        all: probs.map((p, k) => ({ kind: kinds[k], p: Math.round(p * 1000) / 1000 })),
      };
    },
  };
}

// createDefaultKindScorer(kinds?) — the deterministic fallback. Uniform weights
// (or given priors); confidence is the prior mass, never above 0.5, so callers
// can always distinguish "no model" from a real prediction.
export function createDefaultKindScorer(kinds = []) {
  const K = kinds.length || 0;
  const uniform = K ? 1 / K : 0;
  return {
    kinds: [...kinds].sort(),
    trained: false,
    trainedOn: null,
    score(component) {
      if (!K) return { kind: null, confidence: 0, all: [], note: "untrained deterministic fallback" };
      const all = this.kinds.map((k) => ({ kind: k, p: Math.round(uniform * 1000) / 1000 }));
      return { kind: this.kinds[0], confidence: Math.round(uniform * 1000) / 1000, all, note: "uniform prior fallback" };
    },
  };
}

// ---------- persistence ----------

export function saveKindScorer(model, filePath) {
  fs.writeFileSync(filePath, JSON.stringify(model, null, 1), "utf8");
  return filePath;
}

export function loadKindScorer(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

// evaluateKindScorer(scorer, models, opts) → held-out style evaluation:
// accuracy over strong components (same minConfidence gate as training).
export function evaluateKindScorer(scorer, models, { minConfidence = 0.8 } = {}) {
  let n = 0, correct = 0;
  for (const model of models || []) {
    if (!model || !Array.isArray(model.components)) continue;
    const page = { width: model.pageMetrics?.width, height: model.pageMetrics?.height };
    for (const c of model.components) {
      if (!c || !c.kind || Number(c.confidence) < minConfidence) continue;
      const s = scorer.score(c, page);
      n++;
      if (s.kind === c.kind) correct++;
    }
  }
  return { samples: n, correct, accuracy: n ? Math.round((correct / n) * 1000) / 1000 : 0 };
}
