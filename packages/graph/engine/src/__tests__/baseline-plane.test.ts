/**
 * graph on the host baseline/ratchet plane (ADR-0036, P6 Task 6.3): no-flap
 * round-trip + the byte-preserved fingerprint contract.
 *
 * The round-trip goes through the SAME pieces the host seams use — the generic
 * `BaselineRepo` (datastore) + the pure `diffBaseline` (output) — keyed by graph's
 * `graphFingerprintStrategy`. graph's gate stamps once at envelope construction;
 * the plane never re-fingerprints.
 */

import { createSignal, stampFingerprints, type Signal } from '@opensip-cli/core';
import { BaselineRepo, DataStoreFactory, type DataStore } from '@opensip-cli/datastore';
import { diffBaseline } from '@opensip-cli/output';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { graphFingerprintStrategy } from '../baseline-strategy.js';

let ds: DataStore;

function gsig(ruleId: string, file: string, line: number, column = 0): Signal {
  return createSignal({
    source: 'graph',
    severity: 'high',
    ruleId,
    message: 'm',
    code: { file, line, column },
  });
}

function stamp(signals: readonly Signal[]): readonly Signal[] {
  return stampFingerprints(signals, graphFingerprintStrategy);
}

function save(tool: string, signals: readonly Signal[]): void {
  new BaselineRepo(ds).save(
    tool,
    signals.map((s) => ({ fingerprint: s.fingerprint ?? '', payload: s })),
  );
}

beforeEach(() => {
  ds = DataStoreFactory.open({ backend: 'memory' });
});

afterEach(() => {
  ds.close();
});

describe('graph baseline plane', () => {
  it('save → compare on the unchanged set: no flap', () => {
    const signals = stamp([gsig('graph:cycle', 'a.ts', 1), gsig('graph:wide-function', 'b.ts', 2)]);
    save('graph', signals);
    const result = diffBaseline(signals, new BaselineRepo(ds).load('graph'));
    expect(result.added).toEqual([]);
    expect(result.degraded).toBe(false);
    expect(result.unchanged).toHaveLength(2);
  });

  it('a net-new graph finding flips degraded', () => {
    save('graph', stamp([gsig('graph:cycle', 'a.ts', 1)]));
    const current = stamp([gsig('graph:cycle', 'a.ts', 1), gsig('graph:wide-function', 'b.ts', 2)]);
    const result = diffBaseline(current, new BaselineRepo(ds).load('graph'));
    expect(result.degraded).toBe(true);
    expect(result.added).toHaveLength(1);
    expect(result.added[0].ruleId).toBe('graph:wide-function');
  });

  it('graphFingerprintStrategy is the byte-preserved `ruleId|filePath|line|col`', () => {
    expect(graphFingerprintStrategy(gsig('graph:cycle', 'src/a.ts', 5, 2))).toBe(
      'graph:cycle|src/a.ts|5|2',
    );
    const noLoc = { ...gsig('r', 'f', 1), line: undefined, column: undefined } as Signal;
    expect(graphFingerprintStrategy(noLoc)).toBe('r|f|0|0');
  });
});
