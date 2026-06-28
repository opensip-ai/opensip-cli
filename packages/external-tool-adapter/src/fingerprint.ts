/**
 * @fileoverview The adapter fingerprint strategy map (ADR-0091 §4.5).
 *
 * Scanner output is line-volatile (dependency manifests and IaC files shift line
 * numbers constantly), so the adapter DEFAULT is `message-hash`
 * (`sha256(filePath\nruleId\nmessage)`) — line-shift tolerant — not the host
 * default (`ruleId|filePath|line|col`), which would churn baselines on every
 * unrelated edit. The strategy is stamped WORKER-SIDE when the envelope is built
 * (the host ratchet only reads `signal.fingerprint`; `synthesizeExternalTool`
 * drops `fingerprintStrategy`, so the host never reads it off the synthetic Tool).
 *
 * Byte-identical hash shape to fitness's `message-hash`; a distinct id keeps the
 * adapter family's baseline meta self-describing (ADR-0075).
 */

import { createHash } from 'node:crypto';

import { defaultFingerprintStrategy, defineFingerprintStrategy } from '@opensip-cli/core';

import type { FingerprintStrategyChoice } from './types.js';
import type { FingerprintStrategy } from '@opensip-cli/core';

/** `sha256(filePath\nruleId\nmessage)` — the adapter default (line-shift tolerant). */
export const messageHashFingerprintStrategy: FingerprintStrategy = defineFingerprintStrategy({
  id: 'external-tool-adapter.sha256-file-rule-message',
  version: 1,
  fingerprint: (s) =>
    createHash('sha256').update(`${s.filePath}\n${s.ruleId}\n${s.message}`).digest('hex'),
});

/**
 * Resolve a {@link FingerprintStrategyChoice} to a concrete `FingerprintStrategy`.
 * `'message-hash'` (default) → {@link messageHashFingerprintStrategy};
 * `'rule-location'` → the host default (`ruleId|filePath|line|col`), for the rare
 * scanner with stable line anchors.
 */
export function resolveFingerprintStrategy(
  choice: FingerprintStrategyChoice | undefined,
): FingerprintStrategy {
  return choice === 'rule-location' ? defaultFingerprintStrategy : messageHashFingerprintStrategy;
}
