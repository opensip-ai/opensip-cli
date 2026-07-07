import { describe, expect, it } from 'vitest';

import { createSignal, type Signal } from '../../types/signal.js';
import {
  contentHashFallbackFingerprintStrategy,
  defaultFingerprintStrategy,
  defineFingerprintStrategy,
  fileLevelFingerprintStrategy,
  OCCURRENCE_ORDINAL_SEPARATOR,
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

describe('stampFingerprints occurrence-ordinal disambiguation (ADR-0036 amendment)', () => {
  /** A strategy that maps every signal to the same base — forces a collision. */
  const constant = defineFingerprintStrategy({
    id: 'test.constant',
    version: 1,
    fingerprint: () => 'H',
  });

  it('leaves unique bases unsuffixed (no collision → byte-identical)', () => {
    const out = stampFingerprints([sig(), sig({ ruleId: 'rule-y' })], defaultFingerprintStrategy);
    expect(out.map((s) => s.fingerprint)).toEqual(['rule-x|src/a.ts|12|3', 'rule-y|src/a.ts|12|3']);
    for (const s of out) expect(s.fingerprint).not.toContain(OCCURRENCE_ORDINAL_SEPARATOR);
  });

  it('keeps the first of a collision group bare and suffixes the second', () => {
    const out = stampFingerprints([sig(), sig()], constant);
    expect(out.map((s) => s.fingerprint)).toEqual(['H', `H${OCCURRENCE_ORDINAL_SEPARATOR}1`]);
  });

  it('assigns ordinals in array order for three identical bases (determinism)', () => {
    const out = stampFingerprints([sig(), sig(), sig()], constant);
    expect(out.map((s) => s.fingerprint)).toEqual([
      'H',
      `H${OCCURRENCE_ORDINAL_SEPARATOR}1`,
      `H${OCCURRENCE_ORDINAL_SEPARATOR}2`,
    ]);
  });

  it('suffixes only the colliding group, leaving an interleaved singleton bare', () => {
    // strategy keys on ruleId: two "dup" share a base, the "solo" is a singleton.
    const byRule = defineFingerprintStrategy({
      id: 'test.by-rule',
      version: 1,
      fingerprint: (s) => s.ruleId,
    });
    const out = stampFingerprints(
      [sig({ ruleId: 'dup' }), sig({ ruleId: 'solo' }), sig({ ruleId: 'dup' })],
      byRule,
    );
    expect(out.map((s) => s.fingerprint)).toEqual([
      'dup',
      'solo',
      `dup${OCCURRENCE_ORDINAL_SEPARATOR}1`,
    ]);
  });

  it('excludes pre-stamped signals from grouping (idempotency preserved)', () => {
    const pre = sig({ fingerprint: 'H' });
    const [preOut, freshOut] = stampFingerprints([pre, sig()], constant);
    // the pre-stamped signal is returned untouched by identity
    expect(preOut).toBe(pre);
    expect(preOut.fingerprint).toBe('H');
    // the lone un-stamped signal is a singleton among un-stamped signals → bare
    expect(freshOut.fingerprint).toBe('H');
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
