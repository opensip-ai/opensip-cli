/**
 * ToolStateRepo round-trips (ADR-0042, plan phase 7.5): put/get/list/delete/
 * clear, upsert semantics, per-tool isolation, and the payload cap erroring
 * (never evicting).
 */

import { ValidationError } from '@opensip-cli/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { DataStoreFactory } from '../factory.js';
import { ToolStateRepo, TOOL_STATE_MAX_PAYLOAD_BYTES } from '../tool-state-repo.js';

import type { DataStore } from '../data-store.js';

let ds: DataStore;
let repo: ToolStateRepo;

beforeEach(() => {
  ds = DataStoreFactory.open({ backend: 'memory' });
  repo = new ToolStateRepo(ds);
});

afterEach(() => {
  ds.close();
});

describe('ToolStateRepo', () => {
  it('round-trips an opaque JSON payload', () => {
    repo.put('acme-audit', 'cursor', { page: 3, items: ['a', 'b'] });
    expect(repo.get('acme-audit', 'cursor')).toEqual({ page: 3, items: ['a', 'b'] });
  });

  it('get of a never-put key is undefined', () => {
    expect(repo.get('acme-audit', 'nope')).toBeUndefined();
  });

  it('put is an upsert (same key replaces)', () => {
    repo.put('acme-audit', 'k', { v: 1 });
    repo.put('acme-audit', 'k', { v: 2 });
    expect(repo.get('acme-audit', 'k')).toEqual({ v: 2 });
    expect(repo.list('acme-audit')).toEqual(['k']);
  });

  it('list returns this tool’s keys sorted; delete removes one', () => {
    repo.put('acme-audit', 'b', 1);
    repo.put('acme-audit', 'a', 2);
    expect(repo.list('acme-audit')).toEqual(['a', 'b']);
    repo.delete('acme-audit', 'a');
    expect(repo.list('acme-audit')).toEqual(['b']);
  });

  it('tools are isolated: clear(A) never touches B', () => {
    repo.put('tool-a', 'k', 1);
    repo.put('tool-b', 'k', 2);
    expect(repo.clear('tool-a')).toBe(1);
    expect(repo.get('tool-a', 'k')).toBeUndefined();
    expect(repo.get('tool-b', 'k')).toBe(2);
  });

  it('an oversized payload throws ValidationError (error, never evict)', () => {
    const big = 'x'.repeat(TOOL_STATE_MAX_PAYLOAD_BYTES + 1);
    expect(() => repo.put('acme-audit', 'big', big)).toThrow(ValidationError);
    // Nothing was stored — the cap rejects, it does not truncate or evict.
    expect(repo.get('acme-audit', 'big')).toBeUndefined();
  });
});
