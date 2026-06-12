import { describe, expect, it } from 'vitest';

import { createSignal, type Signal } from '../../types/signal.js';
import { defaultFingerprintStrategy, stampFingerprints } from '../fingerprint-strategy.js';

function sig(overrides: Partial<Signal> = {}): Signal {
  return {
    ...createSignal({
      source: 'test',
      severity: 'high',
      ruleId: 'rule-x',
      message: 'msg',
      code: { file: 'src/a.ts', line: 12, column: 3 },
    }),
    ...overrides,
  };
}

describe('defaultFingerprintStrategy', () => {
  it('is ruleId|filePath|line|column', () => {
    expect(defaultFingerprintStrategy(sig())).toBe('rule-x|src/a.ts|12|3');
  });

  it('defaults missing line/column to 0', () => {
    expect(defaultFingerprintStrategy(sig({ line: undefined, column: undefined }))).toBe(
      'rule-x|src/a.ts|0|0',
    );
  });

  it('excludes the message (identity, not content)', () => {
    const a = defaultFingerprintStrategy(sig({ message: 'count: 3' }));
    const b = defaultFingerprintStrategy(sig({ message: 'count: 7' }));
    expect(a).toBe(b);
  });
});

describe('stampFingerprints', () => {
  it('stamps each signal via the strategy', () => {
    const out = stampFingerprints([sig(), sig({ ruleId: 'rule-y' })], defaultFingerprintStrategy);
    expect(out.map((s) => s.fingerprint)).toEqual(['rule-x|src/a.ts|12|3', 'rule-y|src/a.ts|12|3']);
  });

  it('is idempotent — leaves an already-stamped signal unchanged', () => {
    const pre = sig({ fingerprint: 'preset' });
    const [out] = stampFingerprints([pre], defaultFingerprintStrategy);
    expect(out).toBe(pre);
    expect(out.fingerprint).toBe('preset');
  });

  it('uses the provided strategy, not the default', () => {
    const [out] = stampFingerprints([sig()], (s) => `custom:${s.ruleId}`);
    expect(out.fingerprint).toBe('custom:rule-x');
  });
});
