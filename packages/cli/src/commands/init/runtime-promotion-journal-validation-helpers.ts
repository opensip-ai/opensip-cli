/** Primitive and normalized-input validators shared by the journal codec. */

import {
  RUNTIME_PROMOTION_AUTHORED_MODES,
  RUNTIME_PROMOTION_CACHE_KEY_PATTERN,
  RUNTIME_PROMOTION_CONFLICT_POLICIES,
  RUNTIME_PROMOTION_DIGEST_PATTERN,
  RUNTIME_PROMOTION_JOURNAL_CAPS,
  RUNTIME_PROMOTION_LANGUAGES,
  RUNTIME_PROMOTION_OWNED_SLOT_NAMES,
  RUNTIME_PROMOTION_OWNERSHIP_ID_PATTERN,
  RUNTIME_PROMOTION_SAFE_BASENAME_PATTERN,
  RUNTIME_PROMOTION_SOURCE_CLASSIFICATIONS,
  RuntimePromotionJournalValidationError,
} from './runtime-promotion-journal-types.js';
import {
  runtimePromotionOwnedBasename,
  runtimePromotionOwnershipId,
} from './runtime-promotion-owned-identities.js';

export function journalFailure(message: string): never {
  throw new RuntimePromotionJournalValidationError(message);
}

export function journalObject(value: unknown, field: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    journalFailure(`${field} must be a plain object`);
  }
  const prototype = Object.getPrototypeOf(value) as unknown;
  if (prototype !== Object.prototype && prototype !== null) {
    journalFailure(`${field} must be a plain object`);
  }
  return value as Record<string, unknown>;
}

export function journalKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
  field: string,
): void {
  const actual = Object.keys(value);
  if (actual.length !== expected.length || expected.some((key) => !actual.includes(key))) {
    journalFailure(`${field} has unknown or missing fields`);
  }
}

export function journalInteger(
  value: unknown,
  field: string,
  maximum: number,
  minimum = 0,
): number {
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value < minimum ||
    value > maximum
  ) {
    journalFailure(`${field} must be an integer from ${minimum} through ${maximum}`);
  }
  return value;
}

export function journalChoice<T extends string>(
  value: unknown,
  values: readonly T[],
  field: string,
): T {
  if (typeof value !== 'string' || !(values as readonly string[]).includes(value)) {
    journalFailure(`${field} is unsupported`);
  }
  return value as T;
}

export function journalPattern(value: unknown, expected: RegExp, field: string): string {
  if (typeof value !== 'string' || !expected.test(value)) {
    journalFailure(`${field} is invalid`);
  }
  return value;
}

function nullablePattern(value: unknown, expected: RegExp, field: string): string | null {
  return value === null ? null : journalPattern(value, expected, field);
}

export function isSafeRuntimePromotionBasename(value: string): boolean {
  return (
    Buffer.byteLength(value, 'utf8') <= RUNTIME_PROMOTION_JOURNAL_CAPS.maxBasenameBytes &&
    RUNTIME_PROMOTION_SAFE_BASENAME_PATTERN.test(value)
  );
}

export function isRuntimePromotionDigest(value: string): boolean {
  return RUNTIME_PROMOTION_DIGEST_PATTERN.test(value);
}

export function validateSource(value: unknown): void {
  const source = journalObject(value, 'source');
  journalKeys(source, ['classification', 'cacheKey', 'generationDigest', 'markerSha256'], 'source');
  const classification = journalChoice(
    source.classification,
    RUNTIME_PROMOTION_SOURCE_CLASSIFICATIONS,
    'source.classification',
  );
  const cacheKey = nullablePattern(
    source.cacheKey,
    RUNTIME_PROMOTION_CACHE_KEY_PATTERN,
    'source.cacheKey',
  );
  const generation = nullablePattern(
    source.generationDigest,
    RUNTIME_PROMOTION_DIGEST_PATTERN,
    'source.generationDigest',
  );
  const marker = nullablePattern(
    source.markerSha256,
    RUNTIME_PROMOTION_DIGEST_PATTERN,
    'source.markerSha256',
  );
  if (classification === 'none' && (cacheKey !== null || generation !== null || marker !== null)) {
    journalFailure('a none source cannot carry cache identity');
  }
  if (
    classification === 'generation-bound' &&
    (cacheKey === null || generation === null || marker === null)
  ) {
    journalFailure('a generation-bound source requires cache, generation, and marker identity');
  }
  if (
    classification === 'path-only' &&
    (cacheKey === null || generation !== null || marker === null)
  ) {
    journalFailure('a path-only source requires cache and marker identity');
  }
  if (classification === 'legacy' && (cacheKey === null || generation !== null)) {
    journalFailure('a legacy source requires a cache key without generation identity');
  }
}

export function validateInputs(value: unknown): void {
  const inputs = journalObject(value, 'inputs');
  journalKeys(inputs, ['conflict', 'authoredMode', 'languages', 'languageExplicit'], 'inputs');
  journalChoice(inputs.conflict, RUNTIME_PROMOTION_CONFLICT_POLICIES, 'inputs.conflict');
  journalChoice(inputs.authoredMode, RUNTIME_PROMOTION_AUTHORED_MODES, 'inputs.authoredMode');
  if (!Array.isArray(inputs.languages) || inputs.languages.length === 0) {
    journalFailure('inputs.languages must be a nonempty canonical list');
  }
  const languages = inputs.languages as unknown[];
  const canonical = RUNTIME_PROMOTION_LANGUAGES.filter((language) => languages.includes(language));
  if (
    canonical.length !== languages.length ||
    canonical.some((language, index) => languages[index] !== language)
  ) {
    journalFailure('inputs.languages must be unique and in canonical order');
  }
  if (typeof inputs.languageExplicit !== 'boolean') {
    journalFailure('inputs.languageExplicit must be boolean');
  }
}

export function validatePlan(value: unknown): number {
  const plan = journalObject(value, 'plan');
  journalKeys(plan, ['authoredDigest', 'replayDigest', 'mutationCount'], 'plan');
  journalPattern(plan.authoredDigest, RUNTIME_PROMOTION_DIGEST_PATTERN, 'plan.authoredDigest');
  journalPattern(plan.replayDigest, RUNTIME_PROMOTION_DIGEST_PATTERN, 'plan.replayDigest');
  return journalInteger(
    plan.mutationCount,
    'plan.mutationCount',
    RUNTIME_PROMOTION_JOURNAL_CAPS.maxAuthoredMutations,
  );
}

export function validateOwned(value: unknown, operationId: string): void {
  const owned = journalObject(value, 'owned');
  journalKeys(owned, RUNTIME_PROMOTION_OWNED_SLOT_NAMES, 'owned');
  const basenames = new Set<string>();
  const ownershipIds = new Set<string>();
  for (const name of RUNTIME_PROMOTION_OWNED_SLOT_NAMES) {
    const slot = journalObject(owned[name], `owned.${name}`);
    journalKeys(slot, ['basename', 'ownershipId'], `owned.${name}`);
    if (typeof slot.basename !== 'string' || !isSafeRuntimePromotionBasename(slot.basename)) {
      journalFailure(`owned.${name}.basename is unsafe`);
    }
    if (slot.basename !== runtimePromotionOwnedBasename(operationId, name)) {
      journalFailure(`owned.${name}.basename is not bound to this operation`);
    }
    const ownershipId = journalPattern(
      slot.ownershipId,
      RUNTIME_PROMOTION_OWNERSHIP_ID_PATTERN,
      `owned.${name}.ownershipId`,
    );
    if (ownershipId !== runtimePromotionOwnershipId(operationId, name)) {
      journalFailure(`owned.${name}.ownershipId is not bound to this operation`);
    }
    if (basenames.has(slot.basename) || ownershipIds.has(ownershipId)) {
      journalFailure('owned slots must have unique basenames and ownership identities');
    }
    basenames.add(slot.basename);
    ownershipIds.add(ownershipId);
  }
}
