import { SystemError } from '@opensip-cli/core';

import { canonicalParsedJson } from './canonical-json.js';

/**
 * Return canonical JSON bytes contributed by one array item, including its
 * leading comma when the array already contains an item.
 */
export function canonicalArrayItemBytes(value: unknown, existingLength: number): number {
  return Buffer.byteLength(canonicalJson(value), 'utf8') + (existingLength === 0 ? 0 : 1);
}

/** Return the canonical JSON byte length of one stored evidence value. */
export function measureCanonicalJsonBytes(value: unknown): number {
  return Buffer.byteLength(canonicalJson(value), 'utf8');
}

/** Build inclusion and truncation facts for one bounded collection. */
export function evidenceInclusion(
  total: number,
  included: number,
): {
  readonly total: number;
  readonly included: number;
  readonly truncated: boolean;
} {
  return {
    total,
    included,
    truncated: included < total,
  };
}

function canonicalJson(value: unknown): string {
  const ordinary = JSON.stringify(value);
  if (ordinary === undefined) {
    throw new SystemError('Stored parent Run evidence is not JSON serializable.', {
      code: 'SYSTEM.RUN_READ.EVIDENCE_NOT_SERIALIZABLE',
    });
  }
  return canonicalParsedJson(JSON.parse(ordinary) as unknown);
}
