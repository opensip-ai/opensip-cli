/**
 * Shared, renderer-agnostic helpers for the fitness results table.
 *
 * Used by BOTH the cli static view-model builder (`fit-done-view.ts`) and the
 * fitness live Ink view (`fit-runner-views.tsx`), which previously each kept a
 * byte-identical copy (flagged by graph:duplicated-function-body). Pure
 * functions with structural parameter types so cli-ui stays free of any
 * @opensip-tools dependency — contracts' `TableRow` structurally satisfies
 * `FitRowSortKey`, so callers pass a `TableRow` directly.
 */

/** The fields {@link sortFitRowPriority} reads off a fit results row. */
export interface FitRowSortKey {
  readonly status: 'PASS' | 'FAIL' | 'TIMEOUT';
  readonly warnings: number;
}

/**
 * Sort priority for the fit results table: timed-out checks first, then
 * failures, then checks carrying warnings, then clean checks. Lower sorts
 * earlier.
 */
export function sortFitRowPriority(r: FitRowSortKey): number {
  if (r.status === 'TIMEOUT') return 0;
  if (r.status === 'FAIL') return 1;
  if (r.warnings > 0) return 2;
  return 3;
}

/**
 * Parse the leading integer out of a "Validated" cell — e.g. `"171 files"` →
 * `171`, `"—"` → `0`. Used to compute the ignored-ratio tone/colour.
 */
export function parseValidatedCount(validated: string): number {
  if (validated === '—') return 0;
  const match = /^(\d+)/.exec(validated);
  return match ? Number.parseInt(match[1], 10) : 0;
}
