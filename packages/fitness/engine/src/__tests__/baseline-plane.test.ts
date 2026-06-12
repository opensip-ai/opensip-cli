/**
 * fitness on the host baseline/ratchet plane (ADR-0036, P6 Task 6.4): no-flap
 * round-trip + the message-hash strategy contract (line-shift tolerance).
 *
 * fitness does NOT import `@opensip-tools/output` (tools never do — only the
 * composition root consumes `diffBaseline`). So no-flap is proven structurally:
 * the stamped current fingerprint set, saved via the generic `BaselineRepo` and
 * reloaded, is byte-identical — so the host diff would yield `added=[]`,
 * `resolved=[]` (the diff itself is unit-tested in `@opensip-tools/output`).
 */

import { createHash } from 'node:crypto';

import { createSignal, stampFingerprints, type Signal } from '@opensip-tools/core';
import { BaselineRepo, DataStoreFactory, type DataStore } from '@opensip-tools/datastore';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { fitnessFingerprintStrategy } from '../baseline-strategy.js';

let ds: DataStore;

function fsig(ruleId: string, file: string, message: string, line = 1): Signal {
  return createSignal({ source: 'fit', severity: 'high', ruleId, message, code: { file, line } });
}

function stamp(signals: readonly Signal[]): Signal[] {
  return stampFingerprints(signals, fitnessFingerprintStrategy);
}

function fingerprintSet(signals: readonly Signal[]): Set<string> {
  return new Set(signals.map((s) => s.fingerprint ?? ''));
}

function save(signals: readonly Signal[]): void {
  new BaselineRepo(ds).save(
    'fitness',
    signals.map((s) => ({ fingerprint: s.fingerprint ?? '', payload: s })),
  );
}

beforeEach(() => {
  ds = DataStoreFactory.open({ backend: 'memory' });
});

afterEach(() => {
  ds.close();
});

describe('fitness baseline plane', () => {
  it('save → reload: the baseline fingerprint set equals the current set (no flap)', () => {
    const signals = stamp([
      fsig('no-any', 'a.ts', 'Avoid any'),
      fsig('no-console', 'b.ts', 'No console'),
    ]);
    save(signals);
    const loaded = fingerprintSet(new BaselineRepo(ds).load('fitness').map((r) => r.payload!));
    expect(loaded).toEqual(fingerprintSet(signals));
  });

  it('a net-new fitness finding is not in the saved set (would flip degraded)', () => {
    const base = stamp([fsig('no-any', 'a.ts', 'Avoid any')]);
    save(base);
    const baseline = fingerprintSet(new BaselineRepo(ds).load('fitness').map((r) => r.payload!));
    const netNew = stamp([fsig('no-console', 'b.ts', 'No console')])[0];
    expect(baseline.has(netNew.fingerprint ?? '')).toBe(false);
  });

  it('fitnessFingerprintStrategy is sha256(filePath\\nruleId\\nmessage)', () => {
    const s = fsig('no-any', 'src/a.ts', 'Avoid any');
    const expected = createHash('sha256').update('src/a.ts\nno-any\nAvoid any').digest('hex');
    expect(fitnessFingerprintStrategy(s)).toBe(expected);
  });

  it('preserves line-shift tolerance: two signals differing only in line share a fingerprint', () => {
    const a = fsig('no-any', 'src/a.ts', 'Avoid any', 3);
    const b = fsig('no-any', 'src/a.ts', 'Avoid any', 99);
    expect(fitnessFingerprintStrategy(a)).toBe(fitnessFingerprintStrategy(b));
  });
});
