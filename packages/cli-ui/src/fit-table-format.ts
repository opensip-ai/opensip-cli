/**
 * Shared, renderer-agnostic helpers for the fitness results table.
 *
 * Used by BOTH the cli static view-model builder (`fit-done-view.ts`) and the
 * shared live-run table (`live-run-table.tsx`), which previously each kept a
 * byte-identical copy (flagged by graph:duplicated-function-body). Pure
 * functions with structural parameter types so cli-ui stays free of any
 * @opensip-cli dependency — contracts' `TableRow` structurally satisfies
 * `FitRowSortKey`, so callers pass a `TableRow` directly.
 */

/** The fields {@link sortFitRowPriority} reads off a fit results row. */
export interface FitRowSortKey {
  readonly status: 'PASS' | 'FAIL' | 'TIMEOUT' | 'ERROR';
  readonly warnings: number;
}

/**
 * Sort priority for the fit results table: timed-out / errored checks first,
 * then failures, then checks carrying warnings, then clean checks. Lower sorts
 * earlier. (ERROR is the envelope-table status for a unit that threw — it sorts
 * with TIMEOUT, the prior plain-table's "couldn't complete" rung.)
 */
export function sortFitRowPriority(r: FitRowSortKey): number {
  if (r.status === 'TIMEOUT' || r.status === 'ERROR') return 0;
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

/**
 * Render a "Validated" table cell: item count with a singular/plural noun
 * (e.g. `450 → "450 files"`, `1 → "1 file"`, `0`/undefined → `"—"`). Shared by
 * the fit static view-model and live Ink view so both render the column
 * identically. `itemType` defaults to `"items"`.
 */
export function formatValidatedColumn(totalItems: number | undefined, itemType = 'items'): string {
  if (!totalItems) return '—';
  const singular = itemType.endsWith('s') ? itemType.slice(0, -1) : itemType;
  return totalItems === 1 ? `${totalItems} ${singular}` : `${totalItems} ${itemType}`;
}
