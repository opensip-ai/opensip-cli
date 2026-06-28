import { createHash } from 'node:crypto';

import { createSignal, defaultFingerprintStrategy } from '@opensip-cli/core';
import { describe, expect, it } from 'vitest';

import { messageHashFingerprintStrategy, resolveFingerprintStrategy } from '../fingerprint.js';

describe('messageHashFingerprintStrategy', () => {
  it('is sha256(filePath\\nruleId\\nmessage) — line-shift tolerant', () => {
    const signal = createSignal({
      source: 'osv-scanner',
      severity: 'high',
      ruleId: 'GHSA-1',
      message: 'Prototype pollution',
      code: { file: 'package-lock.json', line: 42 },
    });
    const expected = createHash('sha256')
      .update(`package-lock.json\nGHSA-1\nPrototype pollution`)
      .digest('hex');
    expect(messageHashFingerprintStrategy.fingerprint(signal)).toBe(expected);
  });

  it('ignores line/column so a shift does not re-key the baseline', () => {
    const base = {
      source: 'g',
      severity: 'high' as const,
      ruleId: 'R',
      message: 'm',
      code: { file: 'a.txt' },
    };
    const at10 = messageHashFingerprintStrategy.fingerprint(
      createSignal({ ...base, code: { file: 'a.txt', line: 10 } }),
    );
    const at99 = messageHashFingerprintStrategy.fingerprint(
      createSignal({ ...base, code: { file: 'a.txt', line: 99 } }),
    );
    expect(at10).toBe(at99);
  });
});

describe('resolveFingerprintStrategy', () => {
  it('defaults to message-hash and maps rule-location to the host default', () => {
    expect(resolveFingerprintStrategy(undefined)).toBe(messageHashFingerprintStrategy);
    expect(resolveFingerprintStrategy('message-hash')).toBe(messageHashFingerprintStrategy);
    expect(resolveFingerprintStrategy('rule-location')).toBe(defaultFingerprintStrategy);
  });
});
