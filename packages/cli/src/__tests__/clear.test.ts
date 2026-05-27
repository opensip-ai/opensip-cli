import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { SessionRepo } from '@opensip-tools/contracts';
import { DataStoreFactory } from '@opensip-tools/datastore';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { StoredSession } from '@opensip-tools/contracts';
import type { DataStore } from '@opensip-tools/datastore';

let tmp: string;
let ds: DataStore;
let nextAnswer: string;

vi.mock('node:readline', () => ({
  createInterface: () => ({
    question: (_q: string, cb: (answer: string) => void) => cb(nextAnswer),
    close: () => undefined,
  }),
}));

async function loadModule() {
  return await import('../commands/clear.js');
}

function makeStoredSession(id: string, timestamp: number): StoredSession {
  return {
    id,
    tool: 'fit',
    cwd: '/x',
    timestamp: new Date(timestamp).toISOString(),
    score: 95,
    passed: true,
    durationMs: 100,
    summary: { total: 1, passed: 1, failed: 0, errors: 0, warnings: 0 },
    checks: [],
  };
}

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'cli-clear-'));
  ds = DataStoreFactory.open({ backend: 'sqlite', path: join(tmp, 'd.sqlite') });
  nextAnswer = 'y';
  vi.resetModules();
});

afterEach(() => {
  ds.close();
  rmSync(tmp, { recursive: true, force: true });
});

describe('executeClear', () => {
  it('returns "empty" action when there are no sessions', async () => {
    const { executeClear } = await loadModule();
    const result = await executeClear({ yes: true, datastore: ds });
    expect(result).toEqual({ type: 'clear-done', action: 'empty', deletedCount: 0, sessionCount: 0 });
  });

  it('deletes all sessions when --yes is passed and olderThan is omitted', async () => {
    const repo = new SessionRepo(ds);
    repo.save(makeStoredSession('a', Date.now()));
    repo.save(makeStoredSession('b', Date.now()));
    const { executeClear } = await loadModule();
    const result = await executeClear({ yes: true, datastore: ds });
    expect(result.action).toBe('done');
    expect(result.deletedCount).toBe(2);
    expect(repo.count()).toBe(0);
  });

  it('purges only sessions older than the cutoff', async () => {
    const repo = new SessionRepo(ds);
    const now = Date.now();
    const oldTs = now - 10 * 24 * 60 * 60 * 1000;
    const recentTs = now - 1 * 60 * 60 * 1000;
    repo.save(makeStoredSession('old', oldTs));
    repo.save(makeStoredSession('recent', recentTs));
    const { executeClear } = await loadModule();
    const result = await executeClear({ yes: true, olderThan: 5, datastore: ds });
    expect(result.action).toBe('done');
    expect(result.deletedCount).toBe(1);
    expect(repo.count()).toBe(1);
  });

  it('renders cancelled action when user replies "n" at the prompt', async () => {
    const repo = new SessionRepo(ds);
    repo.save(makeStoredSession('a', Date.now()));
    nextAnswer = 'n';
    const writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    try {
      const { executeClear } = await loadModule();
      const result = await executeClear({ yes: false, datastore: ds });
      expect(result.action).toBe('cancelled');
      expect(repo.count()).toBe(1);
    } finally {
      writeSpy.mockRestore();
    }
  });

  it('proceeds when user replies "y" at the prompt', async () => {
    const repo = new SessionRepo(ds);
    repo.save(makeStoredSession('a', Date.now()));
    nextAnswer = 'y';
    const writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    try {
      const { executeClear } = await loadModule();
      const result = await executeClear({ yes: false, olderThan: 1, datastore: ds });
      // Session is recent (now); olderThan=1 means it stays.
      expect(result.action).toBe('done');
      expect(result.deletedCount).toBe(0);
      expect(repo.count()).toBe(1);
    } finally {
      writeSpy.mockRestore();
    }
  });

  it('uses singular "day" wording for olderThan = 1 in the prompt', async () => {
    const repo = new SessionRepo(ds);
    repo.save(makeStoredSession('a', Date.now()));
    nextAnswer = 'n';
    const writes: string[] = [];
    const writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation((s: unknown) => {
      writes.push(String(s));
      return true;
    });
    try {
      const { executeClear } = await loadModule();
      await executeClear({ yes: false, olderThan: 1, datastore: ds });
      expect(writes.some((s) => s.includes('older than 1 day '))).toBe(true);
    } finally {
      writeSpy.mockRestore();
    }
  });
});
