/**
 * Clean corpus, assembled from shapes human reviewers explicitly ACCEPTED
 * while triaging this shard:
 *
 *  1. `throw new RangeError(...)` / `throw new TypeError(...)` reduced from the
 *     real packages/targeting/src/bounded-resolve-inputs.ts. Reviewers rejected
 *     every one of these as a false positive — built-in JS errors carry no
 *     `code` parameter at all.
 *  2. A registered DOMAIN head (`VALIDATION`, a `legacyFamilyCode()` case) and
 *     a registered catalog head (`SYSTEM`, `packages/fitness/.../fitness-error-catalog.ts`).
 *  3. The preferred definition-first construction, where the code comes from a
 *     catalog rather than a literal.
 *  4. Boolean `||` composition — the single largest rejected class in the
 *     negative corpus (graph-java/walk.ts, targeting/bounded-resolve.ts,
 *     several checks-* predicates). Nothing here is an error fallback.
 *  5. Documentation prose naming an unregistered code. Comments are blanked
 *     before scanning, so `ERRORS.CONFIG.NOT_FOUND` written here is inert.
 */

import { SystemError, ValidationError, createToolError } from '@opensip-cli/core';

import { fitnessErrorCatalog } from './fitness-error-catalog.js';

const MAX_ENTRIES = 10_000;

export function assertBounded(limit: unknown, capped: boolean, walkCapped: boolean): number {
  if (typeof limit !== 'number') {
    throw new TypeError('limit must be a number');
  }
  if (!Number.isInteger(limit) || limit < 0 || limit > MAX_ENTRIES) {
    throw new RangeError(`limit must be an integer within [0, ${String(MAX_ENTRIES)}]`);
  }
  // Boolean outcome-flag merge, not a fallback default.
  const anyCapped = capped || walkCapped;
  return anyCapped ? Math.min(limit, MAX_ENTRIES) : limit;
}

export function rejectUnknownTarget(name: string): never {
  throw new ValidationError(`Unknown target '${name}'.`, {
    code: 'VALIDATION.TARGETS.UNKNOWN_TARGET',
  });
}

export function rejectConcurrentSession(): never {
  throw new SystemError('A fitness session is already in progress.', {
    code: 'FIT.FITNESS.SESSION_IN_PROGRESS',
  });
}

export function rejectMissingRecipe(name: string): never {
  throw createToolError(
    fitnessErrorCatalog.require('FIT.NOT_FOUND.RECIPE'),
    `Recipe '${name}' was not found.`,
  );
}
