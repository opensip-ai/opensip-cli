/**
 * graph:test-only-reachable
 *
 * P5 rule. Fires when every path from any inferred entry point to a
 * function passes only through test files. Requires the entry-point
 * inferencer scheduled for P5; stubbed here so the rule slug is
 * registered in the catalog.
 */

import type { Catalog } from '../../catalog/types.js';
import type { GraphFinding } from '../types.js';

export const RULE_ID = 'graph:test-only-reachable';

export function evaluateTestOnlyReachable(_catalog: Catalog): readonly GraphFinding[] {
  // P5: walk inTestFile reachability across the callers index.
  return [];
}
