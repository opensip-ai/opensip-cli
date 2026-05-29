/**
 * Runtime shape validation for third-party `tool` exports — the
 * untrusted boundary where `discoverAndRegisterToolPackages` imports
 * an arbitrary npm package and inspects whatever it exports.
 *
 * Verifies the minimal contract the registry depends on: a
 * `metadata.id` string (used for dedupe + listing) and the two
 * required members (`register` function, `commands` array).
 * `initialize` and `contributeScope` stay optional per the Tool interface.
 */

import type { Tool } from '@opensip-tools/core';

export function isValidTool(value: unknown): value is Tool {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as { metadata?: unknown; register?: unknown; commands?: unknown };
  if (typeof candidate.metadata !== 'object' || candidate.metadata === null) return false;
  if (typeof (candidate.metadata as { id?: unknown }).id !== 'string') return false;
  if (typeof candidate.register !== 'function') return false;
  if (!Array.isArray(candidate.commands)) return false;
  return true;
}
