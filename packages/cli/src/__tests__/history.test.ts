import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { SessionRepo } from '@opensip-tools/contracts';
import { DataStoreFactory } from '@opensip-tools/datastore';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { showHistory } from '../commands/history.js';

import type { StoredSession } from '@opensip-tools/contracts';
import type { DataStore } from '@opensip-tools/datastore';

let tmp: string;
let ds: DataStore;

function makeSession(id: string, score: number, ts: number = Date.now()): StoredSession {
  return {
    id,
    tool: 'fit',
    cwd: '/x',
    timestamp: new Date(ts).toISOString(),
    score,
    passed: score >= 90,
    durationMs: 100,
    summary: { total: 1, passed: 1, failed: 0, errors: 0, warnings: 0 },
    checks: [],
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
});
