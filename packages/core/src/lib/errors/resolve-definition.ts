/**
 * One resolver for "code string → `ErrorDefinition`" (Plan 01 Wave 1).
 *
 * WHY THIS EXISTS
 * `definitionFromLegacyCode` resolves against `coreSystemErrorCatalog` and nothing else. That
 * was complete while core owned exactly one catalog. It stopped being complete the moment
 * Wave 1 registered ~80 codes in `coreErrorCatalog`: a caller writing
 * `new ConfigurationError(msg, { code: 'CORE.RUNTIME_RECOVERY.REQUIRED' })` — a code that IS
 * registered — got `CORE.SYSTEM.UNKNOWN_FAILURE`, because the head `CORE` is not in
 * `legacyFamilyCode`'s switch and the code is not in the legacy catalog. Severity `fatal`,
 * exposure `operator-only`, and an exit code of 1 where the condition means 2.
 *
 * In other words, registering a code without teaching the resolver about it manufactures a
 * NEW instance of the exact demotion this plan exists to remove — and silently, since the
 * code looks correct at every call site. This was caught by a CLI exit-code test, not by
 * review.
 *
 * WHY IT IS A SEPARATE MODULE
 * `definitionFromLegacyCode` lives in `error-definition.ts`, which `coreErrorCatalog` imports.
 * Teaching it about the catalog directly would be a cycle. This module imports both and is
 * imported by the consumers, so the graph stays acyclic without a mutable registration slot —
 * this repository does not do module-level mutable state.
 */

import { definitionFromLegacyCode, type ErrorDefinition } from '../error-definition.js';

import { coreErrorCatalog } from './core-error-catalog.js';

/**
 * Resolve a code string to its definition.
 *
 * Registered codes win; everything else keeps the documented legacy behaviour, including the
 * family fallback and the terminal `UNKNOWN_FAILURE`. The function stays TOTAL: a hostile or
 * unknown code must never throw here (ruling D11), because this runs while something has
 * already failed.
 */
export function resolveDefinitionForCode(code: string): ErrorDefinition {
  const registered = coreErrorCatalog.get(code);
  if (registered !== undefined) return registered;
  return definitionFromLegacyCode(code);
}
