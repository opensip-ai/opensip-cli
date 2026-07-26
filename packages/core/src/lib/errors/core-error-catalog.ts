/**
 * `coreErrorCatalog` — the registered codes `@opensip-cli/core` owns (Plan 01 Wave 1).
 *
 * WHY THIS IS SEPARATE FROM `coreSystemErrorCatalog`
 * `coreSystemErrorCatalog` is the **legacy adapter**: `definitionFromLegacyCode` and
 * `fromNativeError` resolve against it, and `legacyFamilyCode` falls back into it. Moving
 * entries there — or merging this catalog into it — would change how every unregistered
 * legacy code in the workspace resolves, mid-migration, in ways no test pins. It stays
 * exactly as it is. New codes live here.
 *
 * WHY THE OWNER IS `opensip-cli.core` AND NOT THE PACKAGE NAME
 * Ruling D1 keys *substrate* catalog owners on the npm package name, which is what
 * `@opensip-cli/codebase` and `@opensip-cli/tree-sitter` do. Core is the exception: the
 * owner id `opensip-cli.core` is already published in the generated error-code index, and
 * re-keying it would break the one identity that is already public. Core therefore keeps
 * one owner identity across both of its catalogs.
 *
 * Definitions are grouped into per-domain modules under `definitions/` — not for taste, but
 * because ~80 documented definitions in one file exceeds the repository's own
 * `file-length-limit` hard bound, and the grouping is the same one the ledger uses.
 */

import {
  defineErrorCatalog,
  CORE_SYSTEM_ERROR_OWNER,
  ErrorDefinitionError,
  type ErrorDefinition,
} from '../error-definition.js';

import { configAndRuntimeDefinitions } from './definitions/config-and-runtime.js';
import { fileLockDefinitions } from './definitions/file-lock.js';
import { pluginCapabilityDefinitions } from './definitions/plugin-capability.js';
import { runtimeCoordinationDefinitions } from './definitions/runtime-coordination.js';
import { runtimeLeaseDefinitions } from './definitions/runtime-lease.js';
import { toolContractDefinitions } from './definitions/tool-contract.js';

type DefinitionGroup = Readonly<Record<string, Omit<ErrorDefinition, 'owner'>>>;

const DEFINITION_GROUPS = [
  runtimeCoordinationDefinitions,
  runtimeLeaseDefinitions,
  fileLockDefinitions,
  toolContractDefinitions,
  pluginCapabilityDefinitions,
  configAndRuntimeDefinitions,
] as const satisfies readonly DefinitionGroup[];

/**
 * The merged definition bag.
 *
 * Spread rather than a merge helper so TypeScript keeps the literal code union — that union
 * is what makes `coreErrorCatalog.require('CORE.LOCK.MALFORMED')` a compile-time-checked
 * call instead of a `string` lookup that fails at runtime. The cost is that a spread lets a
 * duplicate silently collapse, so the assertion below restores what the spread gives up.
 */
const mergedDefinitions = {
  ...runtimeCoordinationDefinitions,
  ...runtimeLeaseDefinitions,
  ...fileLockDefinitions,
  ...toolContractDefinitions,
  ...pluginCapabilityDefinitions,
  ...configAndRuntimeDefinitions,
};

/**
 * Refuse a code declared in two domain groups.
 *
 * Two owners of one code must be a loud conflict, and that has to hold *inside* an owner as
 * much as across owners — `defineErrorCatalog` cannot catch this one, because by the time it
 * runs the spread has already discarded the loser. Runs at module load, so a duplicate is a
 * failed import rather than a wrong definition served for the rest of the process.
 */
function assertNoDuplicateCodes(): void {
  const seen = new Set<string>();
  const duplicates: string[] = [];
  for (const group of DEFINITION_GROUPS) {
    for (const code of Object.keys(group)) {
      if (seen.has(code)) duplicates.push(code);
      seen.add(code);
    }
  }
  if (duplicates.length > 0) {
    // Sorted into a new array rather than in place: `toSorted` is ES2023 and this repo
    // compiles against ES2022, so the ergonomic fix does not typecheck here.
    const reported = [...duplicates].sort();
    throw new ErrorDefinitionError(
      `core error codes declared in more than one definition group: ${reported.join(', ')}`,
    );
  }
}

assertNoDuplicateCodes();

/** Every code core owns beyond the legacy adapter catalog. */
export const coreErrorCatalog = defineErrorCatalog(CORE_SYSTEM_ERROR_OWNER, mergedDefinitions);

/**
 * Every code the runtime-coordination substrate raises for a bounded, expected failure.
 *
 * WHY THIS IS EXPORTED
 * Consumers used to hard-code the literals (`packages/cli/src/commands/runtime-status-coordination.ts`,
 * `pre-action-hook.ts`, the init promotion commands). When Plan 01 split the two legacy codes
 * into seven honest ones, every one of those comparisons silently stopped matching — a dead
 * branch that no test failed on, because the tests hard-coded the same literals. Naming the
 * family here makes the next split a compile-time concern instead of a silent behaviour change.
 *
 * `TIMEOUT.*` codes are deliberately absent: timeouts are owned by the lock and lease wait
 * paths, and a consumer that wants them should say so.
 */
export const RUNTIME_COORDINATION_FAILURE_CODES: readonly string[] = Object.freeze([
  'CORE.RUNTIME_COORDINATION.BUSY',
  'CORE.RUNTIME_COORDINATION.CONFLICT',
  'CORE.RUNTIME_COORDINATION.CORRUPT_RECORD',
  'CORE.RUNTIME_COORDINATION.PROBE_FAILED',
  'CORE.RUNTIME_COORDINATION.RECLAIM_SKIPPED',
  'CORE.RUNTIME_COORDINATION.UNSAFE_STATE',
  'CORE.RUNTIME_LEASE.CAPACITY',
  'CORE.RUNTIME_LEASE.INHERITANCE_DENIED',
  'CORE.RUNTIME_RECOVERY.PROBE_FAILED',
  'CORE.RUNTIME_RECOVERY.REQUIRED',
  'SYSTEM.RUNTIME_COORDINATION.CAS_MISMATCH',
  'SYSTEM.RUNTIME_COORDINATION.EXISTS',
  'SYSTEM.RUNTIME_COORDINATION.INVALID_KEY',
  // Caller-contract violations. A consumer deciding "is this a bounded coordination failure"
  // wants these too: from the outside, "the lease refused me" is one situation regardless of
  // whether the cause was contention or a protocol misuse.
  'SYSTEM.RUNTIME_LEASE.AUTHORITY_SCOPE',
  'SYSTEM.RUNTIME_LEASE.DUPLICATE_WRITER',
  'SYSTEM.RUNTIME_LEASE.EMPTY_ACCESS',
  'SYSTEM.RUNTIME_LEASE.EXCLUSIVE_UPGRADE',
  'SYSTEM.RUNTIME_LEASE.INVALID_OWNER',
  'SYSTEM.RUNTIME_LEASE.OWNER_MISMATCH',
  'SYSTEM.RUNTIME_LEASE.REQUEST_LOST',
  'VALIDATION.RUNTIME_COORDINATION.INPUT',
]);

/** True when `code` is one of {@link RUNTIME_COORDINATION_FAILURE_CODES}. */
export function isRuntimeCoordinationFailureCode(code: string | undefined): boolean {
  return code !== undefined && RUNTIME_COORDINATION_FAILURE_CODES.includes(code);
}
