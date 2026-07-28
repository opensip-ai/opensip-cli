/**
 * `opensip-cli` host error definitions (Plan 01 clean break).
 *
 * WHY THE HOST NEEDS ITS OWN CATALOG
 * The CLI raised 77 code literals with no catalog entry anywhere. They survived only because
 * `legacyFamilyCode` guessed axes from the first token of the code — `CONFIG.*` meant
 * "configuration error", `SYSTEM.*` meant "internal invariant" — and everything it did not
 * recognise became `UNKNOWN_FAILURE`. Deleting that guessing is the point of the clean break,
 * so every one of these had to become a real definition first.
 *
 * WHY 77 LITERALS BECOME 15 DEFINITIONS
 * Ruling D9: a definition is a (responsibility x kind) cluster, not a sentence. Eleven ways of
 * saying "this suite step names something that does not exist" have one audience, one exit
 * class and one fix — the distinguishing detail belongs in allowlisted `metadata.condition`,
 * where it is bounded and projectable, rather than in 11 codes an agent has to enumerate.
 *
 * Codes stay DISTINCT wherever a consumer actually branches on them. That is a real constraint
 * here: `init` treats an exclusive-lease timeout as retryable contention while a read timeout
 * is a degraded status read, and metadata is not branchable without parsing.
 *
 * OWNER
 * Keyed on the npm package name per ruling D1, like every other substrate catalog. The host is
 * not a Tool and has no tool UUID.
 */

import { defineErrorCatalog } from '@opensip-cli/core';

import { hostSurfacesDefinitions } from './definitions/host-surfaces.js';
import { hostWiringDefinitions } from './definitions/host-wiring.js';
import { initAndPolicyDefinitions } from './definitions/init-and-policy.js';
import { suiteAndRunsDefinitions } from './definitions/suite-and-runs.js';

/** Substrate catalogs are keyed on the npm package name (ruling D1). */
export const HOST_ERROR_OWNER_ID = 'opensip-cli';

/**
 * The user wrote something the host cannot use — in `opensip-cli.config.yml` or on the command
 * line. Public, because the message names the offending value and the fix is an edit.
 */

/**
 * Assembled from three definition modules.
 *
 * Spread rather than nested, so the literal code union survives for `.require()` to type-check
 * against — and because spread silently drops a duplicate key, `defineErrorCatalog`'s
 * one-head-per-catalog and duplicate-code checks are what catch a collision between modules.
 */
export const hostErrorCatalog = defineErrorCatalog(
  {
    id: HOST_ERROR_OWNER_ID,
    displayName: 'OpenSIP CLI host',
    packageName: HOST_ERROR_OWNER_ID,
  },
  {
    ...hostWiringDefinitions,
    ...suiteAndRunsDefinitions,
    ...initAndPolicyDefinitions,
    ...hostSurfacesDefinitions,
  },
);
