/**
 * Rule registry.
 *
 * A plain readonly Rule[] — not a Registry singleton (PR-6). v0.2
 * ships with five built-in rules; runtime rule loading is deferred
 * to v0.3 per DEC-6.
 */

import { alwaysThrowsBranchRule } from './always-throws-branch.js';
import { duplicatedFunctionBodyRule } from './duplicated-function-body.js';
import { highBlastFunctionRule } from './high-blast-function.js';
import { noSideEffectPathRule } from './no-side-effect-path.js';
import { orphanSubtreeRule } from './orphan-subtree.js';
import { testOnlyReachableRule } from './test-only-reachable.js';

import type { Rule } from '../types.js';

export const rules: readonly Rule[] = [
  orphanSubtreeRule,
  duplicatedFunctionBodyRule,
  noSideEffectPathRule,
  testOnlyReachableRule,
  alwaysThrowsBranchRule,
  highBlastFunctionRule,
];
