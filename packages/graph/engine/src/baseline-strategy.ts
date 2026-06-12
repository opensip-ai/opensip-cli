/**
 * @fileoverview graph's fingerprint strategy for the host baseline/ratchet plane
 * (ADR-0036).
 *
 * Stable identity key for a Signal: `ruleId | filePath | line | column`.
 *
 * Deliberately excludes `message`. A fingerprint is an *identity*, and several
 * rules embed run-varying values in their message text — e.g.
 * `graph:duplicated-function-body` reports how many other functions share the
 * same body, a count that shifts whenever a duplicate is added or removed
 * anywhere in the repo, even when this finding's underlying condition is
 * unchanged. Hashing the message made the same logical finding fingerprint
 * differently across runs, so the gate reported it as simultaneously "resolved"
 * (old text) and "new" (new text) — a spurious regression.
 *
 * `ruleId + location` uniquely identifies a finding: a given rule fires at most
 * once per occurrence, and `column` disambiguates multiple occurrences (e.g.
 * arrow functions) sharing a line. This is a **git-trackable consumer-repo
 * artifact** (`graph-baseline-export` JSON), so the format is byte-preserved from
 * the pre-ADR-0036 `fingerprintSignal`; graph declares its own strategy (rather
 * than inheriting the identical host default) so the byte contract is local +
 * independently tested. Changing this format invalidates previously saved
 * baselines — the next `--gate-save` re-baselines with the new key.
 */

import type { FingerprintStrategy } from '@opensip-cli/core';

/** graph's byte-preserved baseline identity: `ruleId|filePath|line|column`. */
export const graphFingerprintStrategy: FingerprintStrategy = (s) =>
  `${s.ruleId}|${s.filePath}|${String(s.line ?? 0)}|${String(s.column ?? 0)}`;
