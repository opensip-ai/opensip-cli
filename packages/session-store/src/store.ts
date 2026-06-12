/**
 * Session id / filename runtime helpers.
 *
 * Moved out of `@opensip-cli/contracts` (audit 2026-05-29, contracts
 * split) so contracts carries no runtime. The `StoredSession` type stays
 * in contracts as the cross-tool contract surface.
 */

import { randomUUID } from 'node:crypto';

/** Generate a unique session ID */
export function generateSessionId(): string {
  return randomUUID();
}

/** Sanitize a string for use in a filename — strip path separators and special chars */
export function sanitizeForFilename(s: string): string {
  return s.replaceAll('..', '-').replaceAll(/[/\\:*?"<>|.]/g, '-');
}
