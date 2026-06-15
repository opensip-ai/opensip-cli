import { describe, expect, it } from 'vitest';

import { createSignal, type Signal } from '../../types/signal.js';
import {
  contentHashFallbackFingerprintStrategy,
  defaultFingerprintStrategy,
  fileLevelFingerprintStrategy,
  stampFingerprints,
} from '../fingerprint-strategy.js';

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

describe('fileLevelFingerprintStrategy (for whole-file / synthetic findings)', () => {
  it('is ruleId|filePath only', () => {
    expect(fileLevelFingerprintStrategy(sig({ line: 99, column: 9 }))).toBe('rule-x|src/a.ts');
  });

  it('distinguishes different rules on the same file (unlike default 0|0 collision)', () => {
    const a = fileLevelFingerprintStrategy(
      sig({ ruleId: 'r1', line: undefined, column: undefined }),
    );
    const b = fileLevelFingerprintStrategy(
      sig({ ruleId: 'r2', line: undefined, column: undefined }),
    );
    expect(a).not.toBe(b);
    expect(a).toBe('r1|src/a.ts');
    expect(b).toBe('r2|src/a.ts');
  });
});

describe('contentHashFallbackFingerprintStrategy', () => {
  it('falls back to default shape when line or col is present', () => {
    expect(contentHashFallbackFingerprintStrategy(sig())).toBe('rule-x|src/a.ts|12|3');
  });

  it('uses file+short-hash when line/col absent, differentiating messages', () => {
    const a = contentHashFallbackFingerprintStrategy(
      sig({ line: undefined, column: undefined, message: 'foo' }),
    );
    const b = contentHashFallbackFingerprintStrategy(
      sig({ line: undefined, column: undefined, message: 'bar' }),
    );
    expect(a).toMatch(/^rule-x\|src\/a\.ts\|[0-9a-f]{8}$/);
    expect(b).toMatch(/^rule-x\|src\/a\.ts\|[0-9a-f]{8}$/);
    expect(a).not.toBe(b);
  });
});
