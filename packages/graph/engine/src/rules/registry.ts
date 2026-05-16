/**
 * Rule registry.
 *
 * A plain readonly Rule[] — not a Registry singleton (PR-6). P4 wires
 * orphan-subtree; P5 adds the remaining four rules.
 */

import { orphanSubtreeRule } from './orphan-subtree.js';

import type { Rule } from '../types.js';

export const rules: readonly Rule[] = [
  orphanSubtreeRule,
];
