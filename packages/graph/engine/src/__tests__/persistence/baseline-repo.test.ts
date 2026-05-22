import { createSignal, type Signal } from '@opensip-tools/core';
import { DataStoreFactory, type DataStore } from '@opensip-tools/datastore';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { GraphBaselineRepo } from '../../persistence/baseline-repo.js';

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

let datastore: DataStore;
let repo: GraphBaselineRepo;

beforeEach(() => {
  datastore = DataStoreFactory.open({ backend: 'memory' });
  repo = new GraphBaselineRepo(datastore);
});

afterEach(() => {
  datastore.close();
});

describe('GraphBaselineRepo', () => {
  it('exists() returns false on a fresh store', () => {
    expect(repo.exists()).toBe(false);
  });

  it('save then loadFingerprints round-trips and dedupes + sorts', () => {
    repo.save([
      sig({ ruleId: 'r', message: 'b', filePath: 'b.ts' }),
      sig({ ruleId: 'r', message: 'a', filePath: 'a.ts' }),
      sig({ ruleId: 'r', message: 'a', filePath: 'a.ts' }),
    ]);
    const fps = repo.loadFingerprints();
    expect(fps).toHaveLength(2);
    expect(fps[0]?.localeCompare(fps[1] ?? '')).toBeLessThan(0);
  });

  it('save with empty signal set still marks baseline as saved', () => {
    repo.save([]);
    expect(repo.exists()).toBe(true);
    expect(repo.loadFingerprints()).toHaveLength(0);
  });

  it('save error branch propagates after datastore close', () => {
    datastore.close();
    expect(() => repo.save([])).toThrow();
  });

  it('loadFingerprints error branch propagates after datastore close', () => {
    datastore.close();
    expect(() => repo.loadFingerprints()).toThrow();
  });
});
