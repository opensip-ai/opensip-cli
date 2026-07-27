/**
 * `@opensip-cli/codebase` error definitions (Plan 01 Task A.3 — first migrated package).
 *
 * WHY THIS PACKAGE OWNS CODES (ruling D1)
 * `codebase` is a substrate, not a Tool, so before `SubstrateErrorCatalogContribution`
 * existed its failures had no owner: a bare `TypeError` normalized at the CLI composition
 * root recorded the HOST as the owner of a failure the host never raised, and a legacy
 * family fallback erased the axes. Ownership is keyed on the package name, so `owner.id`
 * MUST equal `@opensip-cli/codebase`.
 *
 * WHY SO FEW CODES (ruling D9)
 * This substrate is deliberately a *total* function: `buildProjectInventory` never throws,
 * it degrades and reports bounded `coverage.reasonCodes`. The only codes here are for the
 * API boundary — values a caller supplied that cannot be processed at all. Everything the
 * filesystem or a host capability does wrong is degradation evidence, not an error code.
 *
 * D9 also forbids minting one code per branch: each definition below covers a
 * (responsibility x kind) cluster and carries the specific branch in the allowlisted
 * `metadata.condition` key rather than in the code itself.
 */

import { defineErrorCatalog } from '@opensip-cli/core';

/** Substrate catalogs are keyed on the npm package name (ruling D1). */
export const CODEBASE_ERROR_OWNER_ID = '@opensip-cli/codebase';

export const codebaseErrorCatalog = defineErrorCatalog(
  {
    id: CODEBASE_ERROR_OWNER_ID,
    displayName: '@opensip-cli/codebase',
    packageName: CODEBASE_ERROR_OWNER_ID,
  },
  {
    /**
     * The supplied configuration document cannot be canonically encoded, so no stable
     * evidence identity exists for it.
     *
     * Axes: the document reaches us from the one host config reader, and both known
     * conditions (a `bigint` scalar, a circular reference through YAML anchors) are
     * authored in the project's own configuration — hence `user` / `configuration` /
     * `public`: the message names the offending shape and the fix is an edit the user
     * can make. `never` retry because the same document always fails identically.
     *
     * `metadata.condition` is `bigint-scalar` or `circular-reference` (D9: one code for
     * the cluster, the branch travels in allowlisted metadata).
     */
    'CODEBASE.CONFIG.IDENTITY_UNENCODABLE': {
      code: 'CODEBASE.CONFIG.IDENTITY_UNENCODABLE',
      source: 'application',
      defaultResponsibility: 'user',
      kind: 'validation',
      retry: 'never',
      severity: 'error',
      exposure: 'public',
      exitClass: 'configuration',
      operatorAction:
        'Remove the circular reference or non-JSON (bigint) value from the project configuration document, then re-run.',
      stability: 'public',
      lifecycle: 'active',
      publicMetadataKeys: ['condition'],
    },
    /**
     * A caller passed an inventory input that cannot be used: a bound that is not a
     * positive finite number, or a `signal` that is not a real `AbortSignal`.
     *
     * Axes: `limits` / `deadlineMs` / `signal` are programmatic API inputs, not user
     * configuration, so the responsibility is `tool-author` and the exit class is `runtime`
     * rather than `configuration`. `public` exposure because the projected metadata is only
     * the field name and the rejected condition — never a path or a project value.
     *
     * This is the one place inventory REFUSES rather than degrades, and the reason is the
     * same for every field: an unusable input cannot be reinterpreted without inventing a
     * policy nobody asked for. Substituting the hard maximum for a garbage bound WIDENS the
     * walk the caller asked to narrow; ignoring an unusable `signal` makes a run that was
     * asked to be cancellable silently uncancellable. Refusing at the boundary destroys no
     * verdict, because no scan has started (ruling D7).
     *
     * `metadata.field` names the input; `metadata.condition` names why it was rejected —
     * one code for the (tool-author x validation) cluster, branches in metadata (D9).
     */
    'CODEBASE.INVENTORY.INPUT_INVALID': {
      code: 'CODEBASE.INVENTORY.INPUT_INVALID',
      source: 'application',
      defaultResponsibility: 'tool-author',
      kind: 'validation',
      retry: 'never',
      severity: 'error',
      exposure: 'public',
      exitClass: 'runtime',
      operatorAction:
        'Correct the named buildProjectInventory input: bounds must be positive finite numbers, and `signal` must be a real AbortSignal. Omit a bound to accept the built-in maximum.',
      stability: 'public',
      lifecycle: 'active',
      publicMetadataKeys: ['condition', 'field'],
    },
  },
);
