import { describe, expect, it } from 'vitest';

import { createSignal, type Signal } from '../../types/signal.js';
import {
  contentHashFallbackFingerprintStrategy,
  defaultFingerprintStrategy,
  defineFingerprintStrategy,
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

describe('defineFingerprintStrategy', () => {
  it('rejects empty id', () => {
    expect(() =>
      defineFingerprintStrategy({
        id: '  ',
        version: 1,
        fingerprint: () => 'x',
      }),
    ).toThrow(/id/i);
  });

  it('rejects non-positive version', () => {
    expect(() =>
      defineFingerprintStrategy({
        id: 'x',
        version: 0,
        fingerprint: () => 'x',
      }),
    ).toThrow(/version/i);
  });
});

describe('defaultFingerprintStrategy', () => {
  it('has stable id and version', () => {
    expect(defaultFingerprintStrategy.id).toBe('opensip.default.rule-file-line-col');
    expect(defaultFingerprintStrategy.version).toBe(1);
  });

  it('is ruleId|filePath|line|column', () => {
    expect(defaultFingerprintStrategy.fingerprint(sig())).toBe('rule-x|src/a.ts|12|3');
  });

  it('defaults missing line/column to 0', () => {
    expect(
      defaultFingerprintStrategy.fingerprint(sig({ line: undefined, column: undefined })),
    ).toBe('rule-x|src/a.ts|0|0');
  });

  it('excludes the message (identity, not content)', () => {
    const a = defaultFingerprintStrategy.fingerprint(sig({ message: 'count: 3' }));
    const b = defaultFingerprintStrategy.fingerprint(sig({ message: 'count: 7' }));
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
    const custom = defineFingerprintStrategy({
      id: 'test.custom',
      version: 1,
      fingerprint: (s) => `custom:${s.ruleId}`,
    });
    const [out] = stampFingerprints([sig()], custom);
    expect(out.fingerprint).toBe('custom:rule-x');
  });
});

describe('fileLevelFingerprintStrategy (for whole-file / synthetic findings)', () => {
  it('is ruleId|filePath only', () => {
    expect(fileLevelFingerprintStrategy.fingerprint(sig({ line: 99, column: 9 }))).toBe(
      'rule-x|src/a.ts',
    );
  });

  it('distinguishes different rules on the same file (unlike default 0|0 collision)', () => {
    const a = fileLevelFingerprintStrategy.fingerprint(
      sig({ ruleId: 'r1', line: undefined, column: undefined }),
    );
    const b = fileLevelFingerprintStrategy.fingerprint(
      sig({ ruleId: 'r2', line: undefined, column: undefined }),
    );
    expect(a).not.toBe(b);
    expect(a).toBe('r1|src/a.ts');
    expect(b).toBe('r2|src/a.ts');
  });
});

describe('contentHashFallbackFingerprintStrategy', () => {
  it('falls back to default shape when line or col is present', () => {
    expect(contentHashFallbackFingerprintStrategy.fingerprint(sig())).toBe('rule-x|src/a.ts|12|3');
  });

  it('uses file+short-hash when line/col absent, differentiating messages', () => {
    const a = contentHashFallbackFingerprintStrategy.fingerprint(
      sig({ line: undefined, column: undefined, message: 'foo' }),
    );
    const b = contentHashFallbackFingerprintStrategy.fingerprint(
      sig({ line: undefined, column: undefined, message: 'bar' }),
    );
    expect(a).toMatch(/^rule-x\|src\/a\.ts\|[0-9a-f]{8}$/);
    expect(b).toMatch(/^rule-x\|src\/a\.ts\|[0-9a-f]{8}$/);
    expect(a).not.toBe(b);
  });
});
