/**
 * The failure funnel for runtime-promotion authority refusals.
 *
 * WHY THIS IS A SEPARATE MODULE
 * This started life inside `runtime-promotion-authority-verification.ts`, which is the natural
 * home for the *policy*. But that module imports the manifest and root-authority machinery, and
 * the modules that raise these refusals (execution, retirement, owned identities) sit upstream of
 * it — so importing the funnel from there closed a cycle
 * (owned-identities → authority-verification → runtime-manifest → … → owned-identities).
 *
 * This module imports nothing but the kernel and the host catalog, so every raiser can depend on
 * it and the graph stays acyclic. Same shape as `runtime-promotion-journal-error.ts`.
 */

import { SystemError } from '@opensip-cli/core';

import { hostErrorCatalog } from '../../errors/host-error-catalog.js';

const SOURCE_UNVERIFIED = hostErrorCatalog.require('CLI.INIT.PROMOTION_SOURCE_UNVERIFIED');

/**
 * Raise the registered authority-verification refusal.
 *
 * Every refusal that funnels here means the same thing to the operator — the promotion source
 * could not be verified against its recorded authority — so they share one code and are told
 * apart by `metadata.condition` (D9). Before registration these were bare `Error`s, which
 * normalize to `SYSTEM_ERROR` (exposure `redacted`): a failure that decides whether the runtime
 * lease may be released reported to the user as "The operation failed."
 *
 * @throws {SystemError} always — an authority check refused.
 */
export function authorityUnverified(message: string, condition: string): never {
  throw new SystemError(message, {
    code: SOURCE_UNVERIFIED.code,
    definition: SOURCE_UNVERIFIED,
    metadata: { condition },
    diagnostic: condition,
  });
}
