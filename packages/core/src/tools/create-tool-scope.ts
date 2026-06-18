/**
 * createToolScope — factory for a tool's per-run subscope slot.
 *
 * Replaces the repeated scope-augmentation + contributeScope ceremony: the tool
 * declares one factory; the host installs the slot via contributeScope.
 */

import type { RunScope } from '../lib/run-scope.js';
import type { ScopeContribution } from '../lib/scope-types.js';

/** A namespaced per-run subscope factory for one tool slot. */
export function createToolScope<const K extends keyof ScopeContribution>(input: {
  readonly slot: K;
  readonly create: () => NonNullable<ScopeContribution[K]>;
}): {
  readonly contributeScope: () => ScopeContribution;
  readonly applyInTests: (scope: RunScope) => void;
} {
  return {
    contributeScope: () => ({ [input.slot]: input.create() }),
    applyInTests: (scope: RunScope) => {
      Object.assign(scope, { [input.slot]: input.create() });
    },
  };
}
