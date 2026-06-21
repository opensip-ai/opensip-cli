// @eq/single — the single-package repo: ONE package at the repo root holds the
// whole logical graph. The three logical "packages" collapse into this one, so
// the former cross-package imports become RELATIVE intra-package imports. The
// FUNCTION call graph (appRun -> helpFmt -> baseValue + localPad; baseValue
// self-recursive) is identical to the multi-package layouts; only the package
// ATTRIBUTION collapses to a single bucket.
//
// `baseValue` self-recursive leaf (the same logical node as core.baseValue).

export function baseValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    const head = value[0];
    return baseValue(head);
  }
  return value;
}
