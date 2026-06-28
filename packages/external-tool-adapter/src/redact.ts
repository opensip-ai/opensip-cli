/**
 * @fileoverview Secret redaction for secret-scanner parsers (ADR-0091 / ADR-0092).
 *
 * A secret scanner (gitleaks) captures the live credential (`Secret`) and the
 * surrounding match region (`Match`). Neither may EVER reach `Signal.message`,
 * `Signal.metadata` in raw form, or any egress payload. A parser stores only a
 * {@link redactSecret} PREVIEW (or {@link secretHash}) so a finding stays
 * identifiable without leaking the value.
 *
 * Pure functions; `redactSecret` provably never returns the raw string.
 */

import { createHash } from 'node:crypto';

/**
 * Mask a secret to a short, non-reversible PREVIEW: the first 4 characters plus
 * an ellipsis (`'AKIA…'`). A value of length `<= 4` collapses to just `'…'`, so
 * the full raw secret is NEVER returned. Empty/undefined → `''`.
 */
export function redactSecret(raw: string | undefined | null): string {
  if (raw === undefined || raw === null) return '';
  const s = String(raw);
  if (s.length === 0) return '';
  if (s.length <= 4) return '…';
  return `${s.slice(0, 4)}…`;
}

/**
 * A stable, non-reversible identity for a secret: the first 12 hex chars of its
 * SHA-256. Useful when two findings must be told apart without storing any part
 * of the value. Empty/undefined → `''`.
 */
export function secretHash(raw: string | undefined | null): string {
  if (raw === undefined || raw === null || raw.length === 0) return '';
  return createHash('sha256').update(String(raw)).digest('hex').slice(0, 12);
}
