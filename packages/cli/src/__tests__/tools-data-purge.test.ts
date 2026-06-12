/**
 * `tools data-purge` (plan phase 7.5 + the live id-form bug): the stores key
 * inconsistently (sessions use the SHORT id 'fit'; the baseline plane the
 * LONG id 'fitness') — purging either form must clear all of them. Caught
 * live: purging 'fitness' missed a 'fit' session.
 */

import { DataStoreFactory, BaselineRepo, ToolStateRepo } from '@opensip-tools/datastore';
import { SessionRepo } from '@opensip-tools/session-store';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { toolsDataPurge } from '../commands/tools/data-purge.js';

import type { StoredSession } from '@opensip-tools/contracts';
import type { DataStore } from '@opensip-tools/datastore';

let ds: DataStore;

beforeEach(() => {
  ds = DataStoreFactory.open({ backend: 'memory' });
});

afterEach(() => {
  ds.close();
});

function fitSession(id: string): StoredSession {
  return {
    id,
    tool: 'fit',
    timestamp: '2026-06-12T00:00:00.000Z',
    cwd: '/tmp',
    recipe: 'default',
    score: 100,
    passed: true,
    durationMs: 10,
    payload: { summary: { total: 1, passed: 1, failed: 0, errors: 0, warnings: 0 }, checks: [] },
  };
}

describe('toolsDataPurge', () => {
  it('purging the LONG id clears the SHORT-keyed sessions + LONG-keyed baselines + state', () => {
    new SessionRepo(ds).save(fitSession('FIT_A'));
    new BaselineRepo(ds).save('fitness', []);
    new ToolStateRepo(ds).put('fitness', 'k', { v: 1 });

    const result = toolsDataPurge('fitness', ds);
    expect(result.sessions).toBe(1);
    expect(result.baselineMeta).toBe(true);
    expect(result.stateRows).toBe(1);
    expect(new SessionRepo(ds).count()).toBe(0);
    expect(new BaselineRepo(ds).exists('fitness')).toBe(false);
  });

  it('purging the SHORT id clears the same set', () => {
    new SessionRepo(ds).save(fitSession('FIT_B'));
    new BaselineRepo(ds).save('fitness', []);

    const result = toolsDataPurge('fit', ds);
    expect(result.sessions).toBe(1);
    expect(result.baselineMeta).toBe(true);
  });

  it('third-party ids purge under their own single form, never touching others', () => {
    new SessionRepo(ds).save(fitSession('FIT_C'));
    new ToolStateRepo(ds).put('acme-audit', 'k', 1);

    const result = toolsDataPurge('acme-audit', ds);
    expect(result.stateRows).toBe(1);
    expect(result.sessions).toBe(0);
    expect(new SessionRepo(ds).count()).toBe(1);
  });
});
