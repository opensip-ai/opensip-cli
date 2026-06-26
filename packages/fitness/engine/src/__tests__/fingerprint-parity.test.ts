/**
 * FINGERPRINT GOLDEN (ADR-0036, Phase 4 Task 4.1b → 4.4).
 *
 * fitness's migration moved fingerprinting from COMPARE-time (the old gate
 * re-fingerprinted through `DEFAULT_VIOLATION_IDENTITY`) to SAVE-time
 * (`fitnessFingerprintStrategy` stamps once). This test originally compared the
 * new strategy against the old oracle byte-for-byte (the migration safety net);
 * Task 4.4 deleted `gate.ts` (and the oracle), so it is now re-pointed to a
 * FROZEN golden snapshot of the expected `sha256(filePath\nruleId\nmessage)`
 * digests — the same bytes the old oracle produced. A change to the digest format
 * re-keys every saved baseline, so the golden must move deliberately.
 */

import { createSignal, type Signal } from '@opensip-cli/core';
import { describe, expect, it } from 'vitest';

import { fitnessFingerprintStrategy } from '../baseline-strategy.js';

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
  sig({
    filePath: 'src/a.ts',
    ruleId: 'no-any',
    message: 'Avoid any',
    line: 3,
  }),
  sig({
    filePath: 'src/b.ts',
    ruleId: 'no-console',
    message: 'Remove console.log',
    line: 10,
  }),
  sig({
    filePath: 'src/a.ts',
    ruleId: 'no-any',
    message: 'Avoid any',
    line: 99,
  }), // same as #1 but line differs
  sig({
    filePath: 'pkg/c.tsx',
    ruleId: 'react-key',
    message: 'Missing key prop',
    line: 1,
  }),
];

// Frozen golden: sha256(filePath\nruleId\nmessage) — byte-identical to the
// pre-ADR-0036 DEFAULT_VIOLATION_IDENTITY oracle (deleted in Task 4.4).
const GOLDEN: Readonly<Record<string, string>> = {
  'src/a.ts|no-any|Avoid any': 'cbba653f7a24c5f4a25dd7e31ebf822922917ee7ea64b5c05138ed92ea147f17',
  'src/b.ts|no-console|Remove console.log':
    'f5ecda0d835f729e94f475e9523a6a2e4083a5e380e5b325c59a8c9f2610e10d',
  'pkg/c.tsx|react-key|Missing key prop':
    'f4596b6ed8e659468d75f0fd49e92fc4652bee242128a2eea8bc4384bcb9fefd',
};

describe('fitness fingerprint golden (byte-preserved from the deleted oracle)', () => {
  it('matches the frozen sha256(filePath\\nruleId\\nmessage) golden', () => {
    for (const s of CORPUS) {
      const golden = GOLDEN[`${s.filePath}|${s.ruleId}|${s.message}`];
      expect(golden, `no golden for ${s.ruleId}`).toBeDefined();
      expect(fitnessFingerprintStrategy.fingerprint(s)).toBe(golden);
    }
  });

  it('preserves line-shift tolerance: two signals differing only in line fingerprint identically', () => {
    const a = sig({
      filePath: 'src/a.ts',
      ruleId: 'no-any',
      message: 'Avoid any',
      line: 3,
    });
    const b = sig({
      filePath: 'src/a.ts',
      ruleId: 'no-any',
      message: 'Avoid any',
      line: 99,
    });
    expect(fitnessFingerprintStrategy.fingerprint(a)).toBe(
      fitnessFingerprintStrategy.fingerprint(b),
    );
  });

  it('distinguishes a message change (the message IS in the identity)', () => {
    const a = sig({
      filePath: 'src/a.ts',
      ruleId: 'no-any',
      message: 'Avoid any',
    });
    const b = sig({
      filePath: 'src/a.ts',
      ruleId: 'no-any',
      message: 'Avoid the any type',
    });
    expect(fitnessFingerprintStrategy.fingerprint(a)).not.toBe(
      fitnessFingerprintStrategy.fingerprint(b),
    );
  });
});
