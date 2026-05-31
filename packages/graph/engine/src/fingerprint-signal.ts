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

/**
 * Stable identity key for a Signal: `ruleId | filePath | line | column`.
 *
 * Deliberately excludes `message`. A fingerprint is an *identity*, and
 * several rules embed run-varying values in their message text — e.g.
 * `graph:high-blast-function` reports the blast radius score, which
 * shifts whenever the call graph changes transitively anywhere in the
 * repo, even when this finding's underlying condition is unchanged.
 * Hashing the message made the same logical finding fingerprint
 * differently across runs, so the gate reported it as simultaneously
 * "resolved" (old text) and "new" (new text) — a spurious regression.
 *
 * `ruleId + location` uniquely identifies a finding: a given rule fires
 * at most once per occurrence, and `column` disambiguates multiple
 * occurrences (e.g. arrow functions) sharing a line. Note: changing
 * this format invalidates previously saved baselines — the next
 * `--gate-save` re-baselines with the new key.
 */
export function fingerprintSignal(s: Signal): string {
  return `${s.ruleId}|${s.filePath}|${String(s.line ?? 0)}|${String(s.column ?? 0)}`;
}
