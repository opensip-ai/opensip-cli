/**
 * graph:always-throws-branch
 *
 * P6 rule. Fires on a branch within a function where every reachable path
 * throws. Requires the per-function control-flow analyzer scheduled for P6;
 * stubbed here so the slug is registered.
 */

import type { Catalog } from '../../catalog/types.js';
import type { GraphFinding } from '../types.js';

export const RULE_ID = 'graph:always-throws-branch';

export function evaluateAlwaysThrowsBranch(_catalog: Catalog): readonly GraphFinding[] {
  // P6: per-function CFG over the function body.
  return [];
}
