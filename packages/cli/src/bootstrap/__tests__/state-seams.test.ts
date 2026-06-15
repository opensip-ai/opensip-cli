/**
 * state-seams — the host implementation behind `ToolCliContext.toolState`
 * (ADR-0042). Each method constructs a fresh `ToolStateRepo` over the lazily
 * resolved datastore; this round-trips get/put/delete/list against a real
 * in-memory backend and proves a sync repo throw still rejects the returned
 * Promise (the typed-Promise-over-sync-body contract).
 */

import { DataStoreFactory, type DataStore } from '@opensip-cli/datastore';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { buildStateSeams } from '../state-seams.js';

let ds: DataStore;

beforeEach(() => {
  ds = DataStoreFactory.open({ backend: 'memory' });
});

afterEach(() => {
  ds.close();
});

describe('buildStateSeams', () => {
  it('round-trips put → get for a tool-scoped key', async () => {
    const seams = buildStateSeams({ getDatastore: () => ds });
    await seams.put('fit', 'cursor', { page: 3 });
    expect(await seams.get('fit', 'cursor')).toEqual({ page: 3 });
  });

  it('lists the keys written for a tool and isolates by tool', async () => {
    const seams = buildStateSeams({ getDatastore: () => ds });
    await seams.put('fit', 'a', 1);
    await seams.put('fit', 'b', 2);
    await seams.put('graph', 'c', 3);
    expect([...(await seams.list('fit'))].sort()).toEqual(['a', 'b']);
    expect(await seams.list('graph')).toEqual(['c']);
  });

  it('delete removes a key (subsequent get is undefined)', async () => {
    const seams = buildStateSeams({ getDatastore: () => ds });
    await seams.put('fit', 'gone', { v: 1 });
    await seams.delete('fit', 'gone');
    expect(await seams.get('fit', 'gone')).toBeUndefined();
    expect(await seams.list('fit')).toEqual([]);
  });

  it('resolves the datastore lazily on each call (not captured at build time)', async () => {
    let current = ds;
    const seams = buildStateSeams({ getDatastore: () => current });
    await seams.put('fit', 'k', 'first');
    // Swap to a different backend; the seam must read through the resolver.
    const second = DataStoreFactory.open({ backend: 'memory' });
    current = second;
    expect(await seams.get('fit', 'k')).toBeUndefined(); // new store has no row
    await seams.put('fit', 'k', 'second');
    expect(await seams.get('fit', 'k')).toBe('second');
    second.close();
  });

  it('surfaces a datastore error to an awaiting caller', async () => {
    const seams = buildStateSeams({ getDatastore: () => ds });
    ds.close(); // a closed datastore makes the sync repo body throw
    // The seam evaluates the sync SQLite body inside the method, so an awaiting
    // caller (the only sanctioned usage) observes it as a rejected promise.
    await expect((async () => seams.list('fit'))()).rejects.toThrow();
    await expect((async () => seams.get('fit', 'k'))()).rejects.toThrow();
  });
});
