import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { DataStoreFactory } from '@opensip-cli/datastore';
import { SessionRepo } from '@opensip-cli/session-store';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { showHistory } from '../commands/history.js';

import type { StoredSession } from '@opensip-cli/contracts';
import type { DataStore } from '@opensip-cli/datastore';

let tmp: string;
let ds: DataStore;

function makeSession(
  id: string,
  score: number,
  ts: number = Date.now(),
  overrides: Partial<StoredSession> = {},
): StoredSession {
  return {
    id,
    tool: 'fit',
    cwd: '/x',
    timestamp: new Date(ts).toISOString(),
    score,
    passed: score >= 90,
    durationMs: 100,
    payload: {
      summary: { total: 1, passed: 1, failed: 0, errors: 0, warnings: 0 },
      checks: [],
    },
    ...overrides,
  };
}

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'cli-hist-'));
  ds = DataStoreFactory.open({ backend: 'sqlite', path: join(tmp, 'd.sqlite') });
});

afterEach(() => {
  ds.close();
  rmSync(tmp, { recursive: true, force: true });
});

describe('showHistory', () => {
  it('returns an empty session list for a fresh datastore', () => {
    const result = showHistory(ds);
    expect(result.type).toBe('history');
    expect(result.sessions).toEqual([]);
  });

  it('returns every stored session', () => {
    const repo = new SessionRepo(ds);
    repo.save(makeSession('a', 95));
    repo.save(makeSession('b', 70));
    const result = showHistory(ds);
    expect(result.sessions).toHaveLength(2);
    expect(result.sessions.map((s) => s.id).sort()).toEqual(['a', 'b']);
  });

  it('filters and limits stored sessions', () => {
    const repo = new SessionRepo(ds);
    repo.save(makeSession('fit-1', 95, Date.now(), { tool: 'fit' }));
    repo.save(makeSession('graph-1', 95, Date.now() + 1, { tool: 'graph' }));
    repo.save(makeSession('fit-2', 95, Date.now() + 2, { tool: 'fit' }));
    const result = showHistory(ds, { tool: 'fit', limit: 1 });
    expect(result.sessions.map((s) => s.id)).toEqual(['fit-2']);
  });

  it('adds summary and showCommand fields for json consumers', () => {
    const repo = new SessionRepo(ds);
    repo.save(makeSession('FIT_01', 95));
    const result = showHistory(ds);
    expect(result.sessions[0]?.summary).toEqual({
      total: 1,
      passed: 1,
      failed: 0,
      errors: 0,
      warnings: 0,
    });
    expect(result.sessions[0]?.showCommand).toBe('opensip sessions show FIT_01 --json');
  });
});
