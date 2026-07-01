/**
 * Shared, renderer-agnostic helpers for the fitness results table.
 *
 * Used by the fitness live view (`fit-runner.tsx`) and static envelope
 * derivations (`envelope-view.ts`). Pure functions with structural parameter
 * types so fitness stays free of presentation-layer imports — contracts'
 * `TableRow` structurally satisfies `FitRowSortKey`, so callers pass a
 * `TableRow` directly.
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

export {
  formatValidatedCell as formatValidatedColumn,
  parseValidatedCellCount as parseValidatedCount,
} from '@opensip-cli/cli-ui';
