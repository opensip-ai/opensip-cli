/**
 * `@opensip-cli/tree-sitter` error definitions (Plan 01 Wave 1).
 *
 * A substrate catalog under ruling D1: the owner id is the npm package name, because this
 * package is not a Tool and has no tool UUID to key on. Two codes cover the whole surface —
 * the WASM runtime either came up or it did not.
 *
 * DEVIATION FROM THE LEDGER'S PROPOSED CODES, AND WHY
 * The ledger names these `TREE_SITTER.RUNTIME.INIT_FAILED` / `…NOT_INITIALIZED`. That head is
 * **unrepresentable**: `CODE_GRAMMAR` in `error-definition.ts` is
 * `^[A-Z][A-Z0-9]*(\.[A-Z][A-Z0-9_]*){2,}$`, which permits an underscore only *after* the
 * first segment — `defineErrorCatalog` rejects `TREE_SITTER.…` at module load. The head is
 * the failure family and families are single words; that is also what makes
 * `legacyFamilyCode` able to parse a head at all.
 *
 * These therefore follow the convention the first migrated package established:
 * head = failure family (`SYSTEM`, already mapped), domain = the subsystem (`TREE_SITTER`,
 * where underscores are legal), condition last — the same shape as
 * `VALIDATION.CODEBASE.CONFIG_IDENTITY_UNENCODABLE`.
 */

import { defineErrorCatalog } from '@opensip-cli/core';

/** Substrate catalogs are keyed on the npm package name (ruling D1). */
export const TREE_SITTER_ERROR_OWNER_ID = '@opensip-cli/tree-sitter';

export const treeSitterErrorCatalog = defineErrorCatalog(
  {
    id: TREE_SITTER_ERROR_OWNER_ID,
    displayName: 'tree-sitter runtime',
    packageName: TREE_SITTER_ERROR_OWNER_ID,
  },
  {
    /**
     * The tree-sitter WASM runtime or a grammar failed to initialise.
     *
     * `environment` responsibility: the causes are a missing or unreadable `.wasm` asset, a
     * Node build without the required WASM support, or a corrupted install — none of which
     * a user fixes by editing their configuration, and none of which is a tool-author bug.
     * `public` exposure because the actionable detail is the grammar name, not a path from
     * inside the user's project.
     */
    'SYSTEM.TREE_SITTER.INIT_FAILED': {
      code: 'SYSTEM.TREE_SITTER.INIT_FAILED',
      source: 'infrastructure',
      defaultResponsibility: 'environment',
      kind: 'I/O',
      retry: 'never',
      severity: 'error',
      exposure: 'public',
      exitClass: 'runtime',
      operatorAction:
        'The tree-sitter runtime could not be initialised. Reinstall opensip-cli; if it persists, report the run id and the named grammar.',
      stability: 'public',
      lifecycle: 'active',
      publicMetadataKeys: ['grammar', 'condition'],
    },

    /**
     * A parse was requested before the runtime was initialised.
     *
     * A caller-contract violation rather than an environment fault — the adapter must
     * `await` initialisation before parsing — so `tool-author` and `redacted`: no end user
     * can act on it.
     */
    'SYSTEM.TREE_SITTER.NOT_INITIALIZED': {
      code: 'SYSTEM.TREE_SITTER.NOT_INITIALIZED',
      source: 'application',
      defaultResponsibility: 'tool-author',
      kind: 'invariant',
      retry: 'never',
      severity: 'error',
      exposure: 'redacted',
      exitClass: 'runtime',
      operatorAction:
        'Initialise the tree-sitter runtime before parsing. Capture the run id and report a bug.',
      stability: 'public',
      lifecycle: 'active',
      publicMetadataKeys: ['grammar'],
    },
  },
);
