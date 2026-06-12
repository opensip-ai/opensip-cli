import { createSignal, type Signal } from '@opensip-cli/core';
import { sql } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  BaselineRepo,
  DataStoreFactory,
  requireDrizzleDataStore,
  type DataStore,
} from '../index.js';

let ds: DataStore;
let repo: BaselineRepo;

function sig(ruleId: string, file: string): Signal {
  return createSignal({ source: 's', severity: 'high', ruleId, message: 'm', code: { file } });
}

beforeEach(() => {
  ds = DataStoreFactory.open({ backend: 'memory' });
  repo = new BaselineRepo(ds);
});

afterEach(() => {
  ds.close();
});

describe('BaselineRepo', () => {
  it('migrations dropped the old per-tool baseline tables, kept the generic pair (0006+0007)', () => {
    const rows = requireDrizzleDataStore(ds).db.all<{ name: string }>(
      sql`SELECT name FROM sqlite_master WHERE type='table'`,
    );
    const names = new Set(rows.map((r) => r.name));
    expect(names.has('tool_baseline_entries')).toBe(true);
    expect(names.has('tool_baseline_meta')).toBe(true);
    expect(names.has('fit_baseline')).toBe(false);
    expect(names.has('graph_baseline_signals')).toBe(false);
    expect(names.has('graph_baseline_meta')).toBe(false);
  });

  it('round-trips fingerprint + full Signal payload', () => {
    const payload = sig('rule-a', 'src/a.ts');
    repo.save('graph', [{ fingerprint: 'fp-a', payload }]);
    const rows = repo.load('graph');
    expect(rows).toHaveLength(1);
    expect(rows[0].fingerprint).toBe('fp-a');
    expect(rows[0].payload?.ruleId).toBe('rule-a');
    expect(rows[0].payload?.filePath).toBe('src/a.ts');
  });

  it('exists/capturedAt reflect the saved marker', () => {
    expect(repo.exists('graph')).toBe(false);
    expect(repo.capturedAt('graph')).toBeUndefined();
    repo.save('graph', [{ fingerprint: 'fp', payload: sig('r', 'f') }]);
    expect(repo.exists('graph')).toBe(true);
    expect(typeof repo.capturedAt('graph')).toBe('number');
  });

  it('an empty save is a valid saved state (exists, no rows)', () => {
    repo.save('graph', []);
    expect(repo.exists('graph')).toBe(true);
    expect(repo.load('graph')).toEqual([]);
  });

  it('save replaces the prior baseline atomically', () => {
    repo.save('graph', [{ fingerprint: 'old', payload: sig('r', 'f') }]);
    repo.save('graph', [{ fingerprint: 'new', payload: sig('r2', 'f2') }]);
    expect(repo.load('graph').map((r) => r.fingerprint)).toEqual(['new']);
  });

  it('dedupes by fingerprint (last wins) and sorts deterministically', () => {
    repo.save('graph', [
      { fingerprint: 'b', payload: sig('rb', 'fb') },
      { fingerprint: 'a', payload: sig('ra1', 'fa') },
      { fingerprint: 'a', payload: sig('ra2', 'fa') }, // duplicate fingerprint
    ]);
    const rows = repo.load('graph');
    expect(rows.map((r) => r.fingerprint)).toEqual(['a', 'b']);
    expect(rows.find((r) => r.fingerprint === 'a')?.payload?.ruleId).toBe('ra2'); // last won
  });

  it('scopes rows per tool — tools never see each other', () => {
    repo.save('graph', [{ fingerprint: 'g', payload: sig('rg', 'fg') }]);
    repo.save('fitness', [{ fingerprint: 'f', payload: sig('rf', 'ff') }]);
    expect(repo.load('graph').map((r) => r.fingerprint)).toEqual(['g']);
    expect(repo.load('fitness').map((r) => r.fingerprint)).toEqual(['f']);
    expect(repo.exists('simulation')).toBe(false);
  });
});
