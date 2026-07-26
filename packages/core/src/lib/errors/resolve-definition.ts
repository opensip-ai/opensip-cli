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
 *
 * WHY IT ALSO CONSULTS THE PER-RUN REGISTRY
 * Core's catalog is not the whole registry. Substrate packages (`@opensip-cli/codebase`,
 * `@opensip-cli/tree-sitter`) and every loaded Tool own codes too, and those are only knowable
 * per invocation — which is exactly what `RunScope` is for. Without this, a substrate- or
 * tool-registered code hits the same silent demotion core's codes used to: it looks migrated
 * and behaves unknown. Reaching the registry through `currentScope()` is the sanctioned way to
 * read per-run state; there is deliberately no process-global catalog map.
 */

import { ambientStore } from '../ambient-store.js';
import { definitionFromLegacyCode, type ErrorDefinition } from '../error-definition.js';

import { coreErrorCatalog } from './core-error-catalog.js';

/**
 * The only part of the ambient scope this module needs.
 *
 * Declared structurally rather than importing `RunScope`: naming that type would pull the
 * registry → tools → baseline graph back into the error kernel and close a type cycle. `RunScope`
 * satisfies this shape, so `ambientStore` hands back the same store under a narrower lens.
 *
 * Everything is optional because this is read while a failure is already in flight — see
 * `fromRunRegistry`.
 */
interface AmbientErrorCatalogLookup {
  readonly tools?: {
    getErrorCatalogIndex: () => { readonly byCode: ReadonlyMap<string, ErrorDefinition> };
  };
}

/**
 * Look the code up in the per-invocation aggregate (substrates + loaded tools).
 *
 * Every failure is defensive: this runs while something has ALREADY gone wrong, so a missing
 * scope, an un-populated registry, or a registry that throws on a colliding catalog must all
 * degrade to "not found" rather than replace the original failure with a different one.
 */
function fromRunRegistry(code: string): ErrorDefinition | undefined {
  try {
    return ambientStore<AmbientErrorCatalogLookup>()
      .getStore()
      ?.tools?.getErrorCatalogIndex()
      .byCode.get(code);
  } catch {
    return undefined;
  }
}

/**
 * Resolve a code string to its definition.
 *
 * Registered codes win — core's first, then the per-run registry. Everything else keeps the
 * documented legacy behaviour and the terminal `UNKNOWN_FAILURE`. The function stays TOTAL: a
 * hostile or unknown code must never throw here (ruling D11).
 */
export function resolveDefinitionForCode(code: string): ErrorDefinition {
  const registered = coreErrorCatalog.get(code) ?? fromRunRegistry(code);
  if (registered !== undefined) return registered;
  return definitionFromLegacyCode(code);
}
