/**
 * graph:no-side-effect-path
 *
 * P4 rule. Fires when a function's entire transitive callee tree has zero
 * side effects (the 8-kind taxonomy from spec Appendix A). Requires the
 * side-effect detector that lands in P4; for P0–P3 this evaluator is a
 * no-op so the catalog still records the slug as a registered rule.
 */

import type { Catalog } from '../../catalog/types.js';
import type { GraphFinding } from '../types.js';

export const RULE_ID = 'graph:no-side-effect-path';

export function evaluateNoSideEffectPath(_catalog: Catalog): readonly GraphFinding[] {
  // P4: walk transitive callees and check directSideEffects on each.
  return [];
}
