/**
 * SessionRepo.clearForTool (ADR-0042, plan phase 7.5): only the target tool's
 * sessions are removed, and their payload rows cascade.
 */

import { DataStoreFactory } from '@opensip-tools/datastore';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { SessionRepo } from '../session-repo.js';

import type { StoredSession } from '@opensip-tools/contracts';
import type { DataStore } from '@opensip-tools/datastore';

let ds: DataStore;
let repo: SessionRepo;

function session(id: string, tool: StoredSession['tool']): StoredSession {
  return {
    id,
    tool,
    timestamp: '2026-06-12T00:00:00.000Z',
    cwd: '/tmp',
    recipe: 'default',
    score: 100,
    passed: true,
    durationMs: 10,
    payload: { summary: { total: 1, passed: 1, failed: 0, errors: 0, warnings: 0 }, checks: [] },
  };
}

beforeEach(() => {
  ds = DataStoreFactory.open({ backend: 'memory' });
  repo = new SessionRepo(ds);
});

afterEach(() => {
  ds.close();
});

describe('SessionRepo.clearForTool', () => {
  it('removes only the target tool’s sessions', () => {
    repo.save(session('FIT_A', 'fit'));
    repo.save(session('FIT_B', 'fit'));
    repo.save(session('GRAPH_A', 'graph'));

    expect(repo.clearForTool('fit')).toBe(2);
    expect(repo.count()).toBe(1);
    expect(repo.latest({ tool: 'graph' })?.id).toBe('GRAPH_A');
    expect(repo.latest({ tool: 'fit' })).toBeNull();
  });

  it('clearing a tool with no sessions is a 0-count no-op', () => {
    repo.save(session('FIT_A', 'fit'));
    expect(repo.clearForTool('sim')).toBe(0);
    expect(repo.count()).toBe(1);
  });
});
