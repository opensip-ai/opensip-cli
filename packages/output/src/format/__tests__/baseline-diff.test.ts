import { createSignal, type Signal } from '@opensip-cli/core';
import { describe, expect, it } from 'vitest';

import { diffBaseline, type BaselineDiffRow } from '../baseline-diff.js';

function sig(fingerprint: string, ruleId = 'r'): Signal {
  return { ...createSignal({ source: 's', severity: 'high', ruleId, message: 'm' }), fingerprint };
}

function row(fingerprint: string, payload: Signal | null = sig(fingerprint)): BaselineDiffRow {
  return { fingerprint, payload };
}

describe('diffBaseline', () => {
  it('buckets added / resolved / unchanged by fingerprint', () => {
    const current = [sig('a'), sig('b')]; // a unchanged, b added
    const baseline = [row('a'), row('c')]; // a unchanged, c resolved
    const result = diffBaseline(current, baseline);
    expect(result.added.map((s) => s.fingerprint)).toEqual(['b']);
    expect(result.unchanged.map((s) => s.fingerprint)).toEqual(['a']);
    expect(result.resolved.map((s) => s.fingerprint)).toEqual(['c']);
  });

  it('degraded iff added is non-empty', () => {
    expect(diffBaseline([sig('a')], [row('a')]).degraded).toBe(false);
    expect(diffBaseline([sig('x')], [row('a')]).degraded).toBe(true);
    expect(diffBaseline([], [row('a')]).degraded).toBe(false); // only resolved → not degraded
  });

  it('reconstructs resolved findings from the stored payload (full object)', () => {
    const baseline = [row('gone', sig('gone', 'rule-gone'))];
    const [resolved] = diffBaseline([], baseline).resolved;
    expect(resolved.ruleId).toBe('rule-gone');
    expect(resolved.fingerprint).toBe('gone');
  });

  it('falls back to a synthetic Signal when a resolved row has a null payload', () => {
    const [resolved] = diffBaseline([], [row('legacy', null)]).resolved;
    expect(resolved.fingerprint).toBe('legacy');
    expect(resolved.ruleId).toBe('unknown');
    expect(resolved.message).toContain('payload unavailable');
  });

  it('throws when a current signal is not fingerprint-stamped (plane never fingerprints)', () => {
    const unstamped = createSignal({ source: 's', severity: 'high', ruleId: 'r', message: 'm' });
    expect(() => diffBaseline([unstamped], [])).toThrow(/no fingerprint/);
  });
});
