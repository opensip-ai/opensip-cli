import type { FactBinding } from './task.js';

/** Build one response-derived, single-match fact binding for a later strategy step. */
export function factBinding(
  field: FactBinding['$fact']['field'],
  match: FactBinding['$fact']['match'],
  stepId: string,
): FactBinding {
  return { $fact: { field, match, select: 'only', stepId } };
}
