/**
 * @fileoverview fitness's fingerprint strategy for the host baseline/ratchet
 * plane (ADR-0036).
 *
 * fitness's identity is `sha256(filePath\nruleId\nmessage)` — it INCLUDES the
 * message but EXCLUDES line/column, so an unrelated line-shift (code added above
 * a finding) does not re-key the baseline and flap the ratchet. This is the
 * opposite policy from graph's location-based key (which excludes message because
 * several graph rules embed run-varying counts in their message), and both are
 * correct for their domain (ADR-0036: per-tool strategy, not a global algorithm).
 *
 * Byte-preserved from the pre-ADR-0036 `DEFAULT_VIOLATION_IDENTITY`
 * (`gate.ts`), now keyed off the `Signal` (the plane's currency) instead of a
 * `GateViolation` — the same three fields `extractViolationsFromEnvelope` read.
 * A `fingerprint-parity.test.ts` pins byte-equality against that oracle before
 * the old gate is deleted.
 */

import { createHash } from 'node:crypto';

import type { FingerprintStrategy } from '@opensip-tools/core';

/** fitness's message-hash baseline identity: `sha256(filePath\nruleId\nmessage)`. */
export const fitnessFingerprintStrategy: FingerprintStrategy = (s) =>
  createHash('sha256').update(`${s.filePath}\n${s.ruleId}\n${s.message}`).digest('hex');
