/**
 * The graph tool's built-in rule registry.
 *
 * Each rule contributes:
 *   - `slug` (the public ruleId, e.g. `graph:orphan-subtree`)
 *   - `severity` (the signal's level when it fires)
 *   - `phase`   (the implementation phase that activates the evaluator)
 *   - `evaluate(catalog)` (the pure-function rule body)
 *
 * Rules whose phase has not yet shipped (P4–P7 in the v0.1 PR) keep their
 * slug registered here so the catalog metadata, dashboard rollup, and
 * release-note enumeration can always see the full set. Their `evaluate`
 * method is a no-op until the phase ships.
 */

import { evaluateAlwaysThrowsBranch, RULE_ID as ALWAYS_THROWS_BRANCH } from './rules/always-throws-branch.js';
import { evaluateDuplicatedFunctionBody, RULE_ID as DUPLICATED_FUNCTION_BODY } from './rules/duplicated-function-body.js';
import { evaluateNoSideEffectPath, RULE_ID as NO_SIDE_EFFECT_PATH } from './rules/no-side-effect-path.js';
import { evaluateOrphanSubtree, RULE_ID as ORPHAN_SUBTREE } from './rules/orphan-subtree.js';
import { evaluateTestOnlyReachable, RULE_ID as TEST_ONLY_REACHABLE } from './rules/test-only-reachable.js';

import type { GraphFinding } from './types.js';
import type { Catalog } from '../catalog/types.js';

/** Implementation-phase tag for catalog metadata + release-note synthesis. */
export type RulePhase = 'P2' | 'P3' | 'P4' | 'P5' | 'P6';

export interface GraphRule {
  readonly slug: string;
  readonly severity: 'error' | 'warning';
  readonly phase: RulePhase;
  /**
   * True when the evaluator is wired up. Phase-stub rules return `[]`
   * regardless of catalog content; setting `active: false` lets renderers
   * surface the rule as "registered, not yet shipped".
   */
  readonly active: boolean;
  readonly evaluate: (catalog: Catalog) => readonly GraphFinding[];
}

export const GRAPH_RULES: readonly GraphRule[] = [
  {
    slug: DUPLICATED_FUNCTION_BODY,
    severity: 'warning',
    phase: 'P2',
    active: true,
    evaluate: evaluateDuplicatedFunctionBody,
  },
  {
    slug: ORPHAN_SUBTREE,
    severity: 'error',
    phase: 'P3',
    active: true,
    evaluate: evaluateOrphanSubtree,
  },
  {
    slug: NO_SIDE_EFFECT_PATH,
    severity: 'warning',
    phase: 'P4',
    active: false,
    evaluate: evaluateNoSideEffectPath,
  },
  {
    slug: TEST_ONLY_REACHABLE,
    severity: 'warning',
    phase: 'P5',
    active: false,
    evaluate: evaluateTestOnlyReachable,
  },
  {
    slug: ALWAYS_THROWS_BRANCH,
    severity: 'error',
    phase: 'P6',
    active: false,
    evaluate: evaluateAlwaysThrowsBranch,
  },
];

/** Run every active rule against a catalog. */
export function evaluateAllRules(catalog: Catalog): readonly GraphFinding[] {
  const out: GraphFinding[] = [];
  for (const rule of GRAPH_RULES) {
    if (!rule.active) continue;
    out.push(...rule.evaluate(catalog));
  }
  return out;
}
