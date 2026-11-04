// Deterministic robust statistics shared by the ops-intelligence modules.
// Pure functions over finite numeric arrays; every function tolerates
// unsorted input and ignores non-finite values. No RNG anywhere.

// Sort a copy, drop non-finite values. Only numbers and numeric strings
// count as values — null/undefined/""/booleans are ABSENT, never coerced to
// zero (Number(null) === 0 would silently fabricate a data point). Exported
// so callers can reproduce orderings (determinism contract).
export function sortedFinite(values) {
  return (Array.isArray(values) ? values : [])
    .filter((v) => {
      if (typeof v === "number") return Number.isFinite(v);
      if (typeof v === "string") return v.trim() !== "" && Number.isFinite(Number(v));
      return false;
    })
    .map((v) => Number(v))
    .sort((a, b) => a - b);
}

// Median of finite values; [] → NaN (callers treat NaN as "no data").
export function median(values) {
  const s = sortedFinite(values);
  const n = s.length;
  if (!n) return NaN;
  const mid = Math.floor(n / 2);
  return n % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

// Type-7 quantile (the R/NumPy default linear interpolation): deterministic
// and reproducible. p ∈ [0, 1]; empty → NaN.
export function quantile(values, p) {
  const s = sortedFinite(values);
  const n = s.length;
  if (!n) return NaN;
  const prob = Math.min(1, Math.max(0, Number(p)));
  if (n === 1) return s[0];
  const h = (n - 1) * prob;
  const lo = Math.floor(h);
  const hi = Math.ceil(h);
  if (lo === hi) return s[lo];
  return s[lo] + (h - lo) * (s[hi] - s[lo]);
}

// MAD (median absolute deviation) — scale-free dispersion; [] → NaN.
export function medianAbsoluteDeviation(values) {
  const s = sortedFinite(values);
  if (!s.length) return NaN;
  const m = median(s);
  return median(s.map((v) => Math.abs(v - m)));
}
