/**
 * Rule registry.
 *
 * Built on the kernel's unified `Registry<T>` with
 * `duplicatePolicy: 'warn-first-wins'` — re-registering the same rule
 * slug keeps the incumbent and emits a structured warning.
 *
 * v0.2 ships with six built-in rules; runtime rule loading is
 * deferred to v0.3 per DEC-6. The `rules` export is a snapshot
 * (in registration order) used by `orchestrate` and `graph` CLI
 * commands.
 */

import { Registry, type Registerable } from '@opensip-tools/core';

import { alwaysThrowsBranchRule } from './always-throws-branch.js';
import { duplicatedFunctionBodyRule } from './duplicated-function-body.js';
import { highBlastFunctionRule } from './high-blast-function.js';
import { noSideEffectPathRule } from './no-side-effect-path.js';
import { orphanSubtreeRule } from './orphan-subtree.js';
import { testOnlyReachableRule } from './test-only-reachable.js';

import type { Rule } from '../types.js';

interface RegisterableRule extends Registerable {
  readonly id: string;     // same as rule.slug
  readonly name: string;   // same as rule.slug
  readonly rule: Rule;
}

const registry = new Registry<RegisterableRule>({
  module: 'graph:rules',
  duplicatePolicy: 'warn-first-wins',
  evtPrefix: 'graph.rule.registry',
});

// Seed built-in rules. They register in fixed order; the array
// snapshot below preserves that ordering for orchestrate / CLI.
for (const rule of [
  orphanSubtreeRule,
  duplicatedFunctionBodyRule,
  noSideEffectPathRule,
  testOnlyReachableRule,
  alwaysThrowsBranchRule,
  highBlastFunctionRule,
] as const) {
  registry.register({ id: rule.slug, name: rule.slug, rule });
}

/**
 * Snapshot of every registered rule, in registration order.
 * Consumers (orchestrate, graph CLI, test conformance) read this
 * array; the registry stays internal until v0.3 ships runtime rule
 * loading.
 */
export const rules: readonly Rule[] = registry.getAll().map((r) => r.rule);
