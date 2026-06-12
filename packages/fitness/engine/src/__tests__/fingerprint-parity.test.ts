/**
 * PRE-DELETION ORACLE (ADR-0036, Phase 4 Task 4.1b).
 *
 * fitness's migration moves fingerprinting from COMPARE-time (the old gate
 * re-fingerprinted both envelopes through `DEFAULT_VIOLATION_IDENTITY`) to
 * SAVE-time (`fitnessFingerprintStrategy` stamps once, at envelope construction).
 * A subtle divergence (field order, message handling) would silently re-key the
 * baseline and flap the ratchet. This test pins that the NEW save-time
 * fingerprint equals the OLD compare-time identity BYTE-FOR-BYTE — it imports the
 * to-be-deleted `DEFAULT_VIOLATION_IDENTITY` ON PURPOSE as the oracle, and gates
 * Task 4.4 (do not delete gate.ts until this is green). Task 4.4 then re-points
 * this test to a frozen literal snapshot (the oracle is gone).
 */

import { createSignal, type Signal } from '@opensip-tools/core';
import { describe, expect, it } from 'vitest';

import { fitnessFingerprintStrategy } from '../baseline-strategy.js';
import { DEFAULT_VIOLATION_IDENTITY } from '../gate.js';

function sig(over: { filePath: string; ruleId: string; message: string; line?: number }): Signal {
  return {
    ...createSignal({
      source: 'fit',
      severity: 'high',
      ruleId: over.ruleId,
      message: over.message,
      code: { file: over.filePath, line: over.line ?? 1 },
    }),
  };
}

const CORPUS: readonly Signal[] = [
  sig({ filePath: 'src/a.ts', ruleId: 'no-any', message: 'Avoid any', line: 3 }),
  sig({ filePath: 'src/b.ts', ruleId: 'no-console', message: 'Remove console.log', line: 10 }),
  sig({ filePath: 'src/a.ts', ruleId: 'no-any', message: 'Avoid any', line: 99 }), // same as #1 but line differs
  sig({ filePath: 'pkg/c.tsx', ruleId: 'react-key', message: 'Missing key prop', line: 1 }),
];

describe('fitness fingerprint parity (save-time === compare-time oracle)', () => {
  it('the new save-time strategy equals the old DEFAULT_VIOLATION_IDENTITY byte-for-byte', () => {
    for (const s of CORPUS) {
      expect(fitnessFingerprintStrategy(s)).toBe(
        DEFAULT_VIOLATION_IDENTITY({ filePath: s.filePath, ruleId: s.ruleId, message: s.message }),
      );
    }
  });

  it('preserves line-shift tolerance: two signals differing only in line fingerprint identically', () => {
    const a = sig({ filePath: 'src/a.ts', ruleId: 'no-any', message: 'Avoid any', line: 3 });
    const b = sig({ filePath: 'src/a.ts', ruleId: 'no-any', message: 'Avoid any', line: 99 });
    expect(fitnessFingerprintStrategy(a)).toBe(fitnessFingerprintStrategy(b));
  });

  it('distinguishes a message change (the message IS in the identity)', () => {
    const a = sig({ filePath: 'src/a.ts', ruleId: 'no-any', message: 'Avoid any' });
    const b = sig({ filePath: 'src/a.ts', ruleId: 'no-any', message: 'Avoid the any type' });
    expect(fitnessFingerprintStrategy(a)).not.toBe(fitnessFingerprintStrategy(b));
  });
});
