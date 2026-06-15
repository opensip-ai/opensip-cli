/**
 * @fileoverview Helper for registering checks with a namespace
 */

import { currentCheckRegistry } from './scope-registry.js';

import type { Check } from './check-types.js';

/**
 * Register an array of checks with a namespace into the current scope's
 * check registry.
 * @returns The number of checks registered.
 */
export function registerChecks(checks: Check[], namespace: string): number {
  const registry = currentCheckRegistry();
  let count = 0;
  for (const check of checks) {
    registry.register(check, namespace);
    count++;
  }
  return count;
}
