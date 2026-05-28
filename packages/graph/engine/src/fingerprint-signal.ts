/**
 * Stable fingerprint for a graph `Signal`. Used by gate compare/save
 * paths to identify findings across runs.
 *
 * Extracted into its own leaf module to break the file-level cycle
 * between `gate.ts` and `persistence/baseline-repo.ts`: the gate uses
 * `GraphBaselineRepo` (as a type) and the repo uses `fingerprintSignal`
 * (as a value). With the helper sitting below both files, neither
 * needs to import the other.
 */

import type { Signal } from '@opensip-tools/core';

export function fingerprintSignal(s: Signal): string {
  return `${s.ruleId}|${s.filePath}|${String(s.line ?? 0)}|${s.message}`;
}
