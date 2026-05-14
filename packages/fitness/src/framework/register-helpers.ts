/**
 * @fileoverview Helper for registering checks with a namespace
 */

import type { Check } from './check-types.js';
import { defaultRegistry } from './registry.js';

/**
 * Register an array of checks with a namespace into the default registry.
 * @returns The number of checks registered.
 */
export function registerChecks(checks: Check[], namespace: string): number {
  let count = 0;
  for (const check of checks) {
    defaultRegistry.register(check, namespace);
    count++;
  }
  return count;
}
