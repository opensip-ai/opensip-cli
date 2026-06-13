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
    // Unique per-fingerprint id (no more colliding 'sig_resolved' for all resolved items)
    expect(resolved.id).toBe('resolved:legacy');
    // Best-effort parse of default fp form not applicable here; ruleId gets a stable 'resolved' marker
    expect(resolved.ruleId).toBe('resolved');
    expect(resolved.message).toContain('payload unavailable');
    expect(resolved.metadata?.originalFingerprint).toBe('legacy');
  });

  it('synthetic for default-fp resolved row reconstructs identity fields', () => {
    const fp = 'my-rule|/abs/path/src/foo.ts|42|7';
    const [resolved] = diffBaseline([], [row(fp, null)]).resolved;
    expect(resolved.ruleId).toBe('my-rule');
    expect(resolved.filePath).toBe('/abs/path/src/foo.ts');
    expect(resolved.code?.line).toBe(42);
    expect(resolved.code?.column).toBe(7);
    expect(resolved.id).toBe(`resolved:${fp}`);
  });

  it('throws when a current signal is not fingerprint-stamped (plane never fingerprints)', () => {
    const unstamped = createSignal({ source: 's', severity: 'high', ruleId: 'r', message: 'm' });
    expect(() => diffBaseline([unstamped], [])).toThrow(/no fingerprint/);
  });
});
