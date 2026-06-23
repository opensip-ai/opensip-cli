/**
 * yagni's fingerprint strategy for the host baseline/ratchet plane (ADR-0036).
 *
 * Stable identity: detector + normalized locations + symbol ids + evidence ids.
 */

import { createHash } from 'node:crypto';

import { readYagniMetadata } from './scoring/confidence.js';

import type { FingerprintStrategy } from '@opensip-cli/core';

function normalizedLocation(s: {
  readonly filePath: string;
  readonly line?: number;
  readonly column?: number;
}): string {
  const line = s.line ?? 0;
  const col = s.column ?? 0;
  return `${s.filePath}:${String(line)}:${String(col)}`;
}

/** yagni's baseline identity: sha256(detector|locations|symbolIds|evidenceIds). */
export const yagniFingerprintStrategy: FingerprintStrategy = (s) => {
  const meta = readYagniMetadata(s);
  const detector = meta?.detector ?? s.ruleId;
  const location = normalizedLocation(s);
  const symbolIds = meta?.evidence
    .map((e) => e.data?.qualifiedName)
    .filter((v): v is string => typeof v === 'string')
    .sort()
    .join(',');
  const evidenceIds = (meta?.evidence ?? [])
    .map((e) => e.id)
    .sort()
    .join(',');
  const payload = `${detector}|${location}|${symbolIds}|${evidenceIds}`;
  return createHash('sha256').update(payload).digest('hex');
};
