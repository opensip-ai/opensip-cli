// @fitness-ignore-file batch-operation-limits -- iterates bounded collection (registered rules + getAll() returning the rule list per RunScope)
/**
 * Rule registry — per-RunScope.
 *
 * Each `RunScope` owns its own rule registry (Item 1 / D7). The graph
 * tool's `contributeScope` hook constructs a fresh registry per CLI
 * invocation and attaches it to `scope.graph.rules`. The registry is
 * seeded with the six built-in rules at construction.
 *
 * Built on the kernel's unified `Registry<T>` with
 * `duplicatePolicy: 'warn-first-wins'` — re-registering the same rule
 * slug keeps the incumbent and emits a structured warning.
 *
 * v0.2 shipped with six built-in rules; runtime rule loading is
 * deferred to v0.3 per DEC-6. The legacy `rules` array export was a
 * process-level snapshot read by `orchestrate`/`graph` CLI commands;
 * it's gone. Callers now use the `currentRules()` helper.
 */

import { Registry, currentScope, type Registerable } from '@opensip-tools/core';

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

/** Built-in rule list, in fixed registration order — preserved across
 *  reconstruction so callers that depend on snapshot ordering keep
 *  their semantics. */
const BUILT_IN_RULES: readonly Rule[] = [
  orphanSubtreeRule,
  duplicatedFunctionBodyRule,
  noSideEffectPathRule,
  testOnlyReachableRule,
  alwaysThrowsBranchRule,
  highBlastFunctionRule,
];

/**
 * Per-RunScope rule registry. Wraps the kernel `Registry<T>` with
 * built-in seeding at construction.
 */
export class GraphRulesRegistry {
  private readonly inner = new Registry<RegisterableRule>({
    module: 'graph:rules',
    duplicatePolicy: 'warn-first-wins',
    evtPrefix: 'graph.rule.registry',
  });

  constructor() {
    for (const rule of BUILT_IN_RULES) {
      this.inner.register({ id: rule.slug, name: rule.slug, rule });
    }
  }

  getAll(): readonly Rule[] {
    return this.inner.getAll().map((r) => r.rule);
  }
}

/** Factory used by the graph tool's `contributeScope` hook. */
export function createRulesRegistry(): GraphRulesRegistry {
  return new GraphRulesRegistry();
}

/**
 * Read the current scope's graph rule registry. Throws when no scope
 * is active or when the graph subscope is missing.
 *
 * @throws {Error} When called outside `runWithScope(...)`, or when the
 *   active scope has no graph subscope.
 */
function currentRulesRegistry(): GraphRulesRegistry {
  const scope = currentScope();
  if (!scope) {
    throw new Error(
      'graph: currentRulesRegistry() called outside a RunScope. ' +
        'Wrap the call site in runWithScope (production: pre-action-hook handles ' +
        'this; tests: use makeTestScope + graphTool.contributeScope).',
    );
  }
  if (!scope.graph) {
    throw new Error(
      'graph: scope.graph is missing. The graph tool must be registered and ' +
        'its contributeScope hook must run before rule reads.',
    );
  }
  return scope.graph.rules;
}

/**
 * Snapshot of every registered rule in the current scope, in
 * registration order. Replaces the prior module-level `rules` export.
 */
export function currentRules(): readonly Rule[] {
  return currentRulesRegistry().getAll();
}
