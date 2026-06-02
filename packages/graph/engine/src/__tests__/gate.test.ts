/**
 * Tests for gate baseline save / compare (v2 — SQLite-backed).
 */

import { createSignal } from '@opensip-tools/core';
import { DataStoreFactory, type DataStore } from '@opensip-tools/datastore';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { compareToBaseline, fingerprintSignal, saveBaseline } from '../gate.js';
import { GraphBaselineRepo } from '../persistence/baseline-repo.js';

import type { Signal } from '@opensip-tools/core';

function sig(over: { ruleId: string; message: string; filePath: string; line?: number }): Signal {
  return createSignal({
    source: 'graph',
    severity: 'low',
    category: 'quality',
    ruleId: over.ruleId,
    message: over.message,
    code: { file: over.filePath, line: over.line ?? 1, column: 0 },
  });
}

describe('gate fingerprintSignal', () => {
  it('builds rule|file|line|column identifier', () => {
    const s = sig({ ruleId: 'graph:orphan-subtree', message: 'foo is unreachable', filePath: 'src/a.ts', line: 7 });
    expect(fingerprintSignal(s)).toBe('graph:orphan-subtree|src/a.ts|7|0');
  });

  it('treats missing line/column as 0', () => {
    const s = sig({ ruleId: 'r', message: 'm', filePath: 'src/a.ts' });
    const noLoc: Signal = { ...s, line: undefined, column: undefined };
    expect(fingerprintSignal(noLoc)).toBe('r|src/a.ts|0|0');
  });

  it('is stable across a changed message at the same location', () => {
    // Regression guard: rules like graph:duplicated-function-body embed
    // run-varying counts in their message. The fingerprint must not
    // change when only the message text does, or the gate flips a stable
    // finding between "resolved" and "new".
    const base = { ruleId: 'graph:duplicated-function-body', filePath: 'src/a.ts', line: 7 };
    const before = sig({ ...base, message: 'f has the same body as 3 other functions.' });
    const after = sig({ ...base, message: 'f has the same body as 5 other functions.' });
    expect(fingerprintSignal(after)).toBe(fingerprintSignal(before));
  });
});

describe('gate stability against volatile rule messages', () => {
  let datastore: DataStore;
  let repo: GraphBaselineRepo;

  beforeEach(() => {
    datastore = DataStoreFactory.open({ backend: 'memory' });
    repo = new GraphBaselineRepo(datastore);
  });

  afterEach(() => {
    datastore.close();
  });

  it('does not flag a regression when only a finding message changes', () => {
    const base = { ruleId: 'graph:duplicated-function-body', filePath: 'src/a.ts', line: 7 };
    saveBaseline([sig({ ...base, message: 'same body as 3 other functions.' })], repo);
    // Same finding, message text drifted because the graph changed elsewhere.
    const result = compareToBaseline(
      [sig({ ...base, message: 'same body as 5 other functions.' })],
      repo,
    );
    expect(result.degraded).toBe(false);
    expect(result.newSignals).toHaveLength(0);
    expect(result.resolvedFingerprints).toHaveLength(0);
  });
});

describe('saveBaseline / compareToBaseline (SQLite-backed)', () => {
  let datastore: DataStore;
  let repo: GraphBaselineRepo;

  beforeEach(() => {
    datastore = DataStoreFactory.open({ backend: 'memory' });
    repo = new GraphBaselineRepo(datastore);
  });

  afterEach(() => {
    datastore.close();
  });

  it('save then compare reports clean when current matches', () => {
    const signals = [
      sig({ ruleId: 'graph:orphan-subtree', message: 'foo', filePath: 'src/a.ts', line: 1 }),
      sig({ ruleId: 'graph:orphan-subtree', message: 'bar', filePath: 'src/b.ts', line: 2 }),
    ];
    saveBaseline(signals, repo);
    const result = compareToBaseline(signals, repo);
    expect(result.degraded).toBe(false);
    expect(result.newSignals).toHaveLength(0);
    expect(result.resolvedFingerprints).toHaveLength(0);
  });

  it('flags new signals as degraded', () => {
    const original = [sig({ ruleId: 'graph:orphan-subtree', message: 'foo', filePath: 'src/a.ts', line: 1 })];
    saveBaseline(original, repo);
    const drift = [
      ...original,
      sig({ ruleId: 'graph:orphan-subtree', message: 'newOne', filePath: 'src/c.ts', line: 3 }),
    ];
    const result = compareToBaseline(drift, repo);
    expect(result.degraded).toBe(true);
    expect(result.newSignals).toHaveLength(1);
    expect(result.newSignals[0]?.message).toBe('newOne');
  });

  it('records resolved fingerprints (signals in baseline but not in current)', () => {
    const original = [
      sig({ ruleId: 'r', message: 'a', filePath: 'src/a.ts', line: 1 }),
      sig({ ruleId: 'r', message: 'b', filePath: 'src/b.ts', line: 2 }),
    ];
    saveBaseline(original, repo);
    const fewer = [original[0]] as readonly Signal[];
    const result = compareToBaseline(fewer, repo);
    expect(result.degraded).toBe(false);
    expect(result.resolvedFingerprints).toHaveLength(1);
    expect(result.resolvedFingerprints[0]).toContain('src/b.ts');
  });

  it('throws ValidationError when baseline does not exist', () => {
    expect(() => compareToBaseline([], repo)).toThrow(/Graph baseline not found/);
  });

  it('save replaces previous baseline atomically', () => {
    saveBaseline(
      [sig({ ruleId: 'r', message: 'old', filePath: 'src/x.ts' })],
      repo,
    );
    const replacement = [sig({ ruleId: 'r', message: 'new', filePath: 'src/y.ts' })];
    saveBaseline(replacement, repo);
    const fps = repo.loadFingerprints();
    expect(fps).toHaveLength(1);
    expect(fps[0]).toContain('src/y.ts');
  });

  it('save then compare against an empty current set marks every baseline entry resolved', () => {
    const signals = [
      sig({ ruleId: 'r', message: 'a', filePath: 'src/a.ts', line: 1 }),
      sig({ ruleId: 'r', message: 'b', filePath: 'src/b.ts', line: 2 }),
    ];
    saveBaseline(signals, repo);
    const result = compareToBaseline([], repo);
    expect(result.degraded).toBe(false);
    expect(result.resolvedFingerprints).toHaveLength(2);
  });

  it('save with no signals produces an empty-but-saved baseline (existence marker present)', () => {
    saveBaseline([], repo);
    expect(repo.exists()).toBe(true);
    expect(repo.loadFingerprints()).toHaveLength(0);
    // Subsequent regression is detected as "new"
    const drift = [sig({ ruleId: 'r', message: 'a', filePath: 'src/a.ts' })];
    const result = compareToBaseline(drift, repo);
    expect(result.degraded).toBe(true);
    expect(result.newSignals).toHaveLength(1);
  });

  it('exists() returns false on a fresh store (never saved)', () => {
    expect(repo.exists()).toBe(false);
  });
});
