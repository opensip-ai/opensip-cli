import { DataStoreFactory, type DataStore } from '@opensip-tools/datastore';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { FitBaselineRepo } from '../../persistence/baseline-repo.js';

let datastore: DataStore;
let repo: FitBaselineRepo;

beforeEach(() => {
  datastore = DataStoreFactory.open({ backend: 'memory' });
  repo = new FitBaselineRepo(datastore);
});

afterEach(() => {
  datastore.close();
});

describe('FitBaselineRepo — save / load / exists', () => {
  it('save then load round-trips a payload', () => {
    const payload = { version: '2.1.0', runs: [] };
    repo.save(payload, 0);
    expect(repo.load()).toEqual(payload);
  });

  it('save replaces a prior baseline', () => {
    repo.save({ version: '2.1.0', n: 1 }, 0);
    repo.save({ version: '2.1.0', n: 2 }, 0);
    expect((repo.load() as { n: number }).n).toBe(2);
  });

  it('load returns null when no row exists', () => {
    expect(repo.load()).toBeNull();
  });

  it('exists returns false on empty store', () => {
    expect(repo.exists()).toBe(false);
  });

  it('exists returns true after save', () => {
    repo.save({}, 0);
    expect(repo.exists()).toBe(true);
  });

  it('save error branch propagates after datastore close', () => {
    datastore.close();
    expect(() => repo.save({}, 0)).toThrow();
  });

  it('load error branch propagates after datastore close', () => {
    datastore.close();
    expect(() => repo.load()).toThrow();
  });
});
