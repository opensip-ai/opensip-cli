import { compareByCodePoint } from '@opensip-cli/core';

/**
 * Deterministic UTF-16 code-unit string order for stable sorts.
 *
 * Shared across packages so body-hash detectors (yagni duplicate-body) and
 * human-facing orderings stay one implementation. The implementation lives in
 * `@opensip-cli/core` as `compareByCodePoint`; this thin alias keeps every
 * contracts consumer's import path unchanged.
 */
export const compareCodePoint = compareByCodePoint;

/** Alias used by some call sites that prefer a longer name. */
export const compareCodePointStrings = compareCodePoint;
