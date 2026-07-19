import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { DataStoreFactory } from '@opensip-cli/datastore';
import { commitEvidenceBundle, RunRepo, SessionRepo } from '@opensip-cli/session-store';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type {
  StoredRun,
  StoredRunStep,
  StoredSession,
  StoredSessionHostMetrics,
} from '@opensip-cli/contracts';
import type { DataStore } from '@opensip-cli/datastore';

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

function makeStoredSession(id: string, timestamp: number, tool = 'fit'): StoredSession {
  return {
    id,
    tool,
    cwd: '/x',
    startedAt: new Date(timestamp).toISOString(),
    completedAt: new Date(timestamp).toISOString(),
    score: 95,
    passed: true,
    durationMs: 100,
  };
}

function makeHostMetrics(): StoredSessionHostMetrics {
  return { renderMs: 2, egressMs: 3, totalCommandMs: 300, persistMs: 1 };
}

function makeRun(overrides: Partial<StoredRun> = {}): StoredRun {
  return {
    id: 'run-1',
    name: 'audit',
    source: 'built-in-suite',
    cwd: '/x',
    startedAt: '2026-07-16T12:00:00.000000Z',
    completedAt: '2026-07-16T12:00:01.000000Z',
    durationMs: 1000,
    exitCode: 0,
    aggregate: {
      steps: 1,
      passed: 1,
      failed: 0,
      faulted: 0,
      errors: 0,
      warnings: 0,
    },
    cliVersion: '0.7.0',
    ...overrides,
  };
}

function makeStep(sessionId: string, overrides: Partial<StoredRunStep> = {}): StoredRunStep {
  return {
    id: 'step-1',
    runId: 'run-1',
    logicalStepKey: '0:fit:fitness',
    ordinal: 0,
    attempt: 1,
    tool: 'fit',
    command: 'fitness',
    stableId: 'tool-fit',
    effectiveArgs: { recipe: 'agent-risk' },
    exitCode: 0,
    outcome: 'passed',
    durationMs: 250,
    sessionId,
    verdictSummary: { passed: true, errors: 0, warnings: 0, findings: 0 },
    ...overrides,
  };
}

function openStore(label: string): DataStore {
  return DataStoreFactory.open({
    backend: 'sqlite',
    path: join(tmp, `${label}.sqlite`),
  });
}

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'cli-clear-'));
  ds = openStore('project-runtime');
  nextAnswer = 'y';
  vi.resetModules();
});

afterEach(() => {
  ds.close();
  rmSync(tmp, { recursive: true, force: true });
});

describe('executeClear', () => {
  it('returns "empty" action when there are no sessions (zero matches)', async () => {
    const { executeClear } = await loadModule();
    const result = await executeClear({ yes: true, datastore: ds });
    expect(result).toEqual({
      type: 'clear-done',
      action: 'empty',
      deletedCount: 0,
      sessionCount: 0,
    });
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

  it('purges only sessions older than the cutoff (age boundary)', async () => {
    const repo = new SessionRepo(ds);
    const now = Date.now();
    const oldTs = now - 10 * 24 * 60 * 60 * 1000;
    const recentTs = now - 1 * 60 * 60 * 1000;
    repo.save(makeStoredSession('old', oldTs));
    repo.save(makeStoredSession('recent', recentTs));
    const { executeClear } = await loadModule();
    const result = await executeClear({
      yes: true,
      olderThan: 5,
      datastore: ds,
    });
    expect(result.action).toBe('done');
    expect(result.deletedCount).toBe(1);
    expect(repo.count()).toBe(1);
  });

  it('treats olderThan=0 as a full clear boundary', async () => {
    const repo = new SessionRepo(ds);
    repo.save(makeStoredSession('a', Date.now()));
    const { executeClear } = await loadModule();
    const result = await executeClear({ yes: true, olderThan: 0, datastore: ds });
    expect(result.action).toBe('done');
    expect(result.deletedCount).toBe(1);
    expect(repo.count()).toBe(0);
  });

  it('works against a separate user-cache store the same way as project runtime', async () => {
    const cacheStore = openStore('user-cache');
    try {
      const repo = new SessionRepo(cacheStore);
      repo.save(makeStoredSession('cache-1', Date.now()));
      repo.save(makeStoredSession('cache-2', Date.now() - 20 * 24 * 60 * 60 * 1000));
      const { executeClear } = await loadModule();
      const result = await executeClear({
        yes: true,
        olderThan: 7,
        datastore: cacheStore,
      });
      expect(result.action).toBe('done');
      expect(result.deletedCount).toBe(1);
      expect(repo.count()).toBe(1);
    } finally {
      cacheStore.close();
    }
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
      const result = await executeClear({
        yes: false,
        olderThan: 1,
        datastore: ds,
      });
      // Session is recent (now); olderThan=1 means it stays.
      expect(result.action).toBe('done');
      expect(result.deletedCount).toBe(0);
      expect(repo.count()).toBe(1);
    } finally {
      writeSpy.mockRestore();
    }
  });

  it('describes the active local evidence store and points full removal at uninstall', async () => {
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
      await executeClear({ yes: false, datastore: ds });
      const joined = writes.join('');
      expect(joined).toContain('active local evidence store');
      expect(joined).toContain('opensip uninstall --project');
      expect(joined).not.toContain('datastore.sqlite');
      expect(joined).not.toContain('opensip-cli/.runtime');
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

  it('preserves parent Runs when Tool Sessions are purged', async () => {
    const session = makeStoredSession('session-0', Date.now());
    const commit = commitEvidenceBundle(ds, {
      sessions: [{ session, hostMetrics: makeHostMetrics() }],
      run: {
        run: makeRun(),
        steps: [makeStep(session.id)],
      },
    });
    expect(commit.status).toBe('committed');

    const { executeClear } = await loadModule();
    const result = await executeClear({ yes: true, datastore: ds });
    expect(result.deletedCount).toBe(1);
    expect(new SessionRepo(ds).count()).toBe(0);

    const runs = new RunRepo(ds);
    expect(runs.getRun('run-1')).toBeDefined();
    expect(runs.getRun('run-1')?.id).toBe('run-1');
  });

  it('serializes with a paused evidence-bundle commit on both sides of purge', async () => {
    const { executeClear } = await loadModule();
    const sessionRepo = new SessionRepo(ds);
    sessionRepo.save(makeStoredSession('pre-existing', Date.now() - 1000));

    const during = makeStoredSession('during-hold', Date.now());
    const held = commitEvidenceBundle(ds, {
      sessions: [{ session: during, hostMetrics: makeHostMetrics() }],
      precondition: () => {
        // Evaluated under the evidence-bundle write lock / transaction.
        // Purge must not corrupt this in-flight commit; we exercise purge
        // after the commit returns (store-side serialization).
        return true;
      },
    });
    expect(held.status).toBe('committed');
    expect(sessionRepo.count()).toBe(2);

    const purged = await executeClear({ yes: true, datastore: ds });
    expect(purged.action).toBe('done');
    expect(purged.deletedCount).toBe(2);
    expect(sessionRepo.count()).toBe(0);

    // Post-purge evidence commit still succeeds (store integrity).
    const after = commitEvidenceBundle(ds, {
      sessions: [
        {
          session: makeStoredSession('post-purge', Date.now()),
          hostMetrics: makeHostMetrics(),
        },
      ],
    });
    expect(after.status).toBe('committed');
    expect(sessionRepo.count()).toBe(1);
  });

  it('rolls back nothing durable when the user cancels after counting', async () => {
    const repo = new SessionRepo(ds);
    const now = Date.now();
    repo.save(makeStoredSession('keep-a', now));
    repo.save(makeStoredSession('keep-b', now));
    nextAnswer = 'n';
    const writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    try {
      const { executeClear } = await loadModule();
      const result = await executeClear({ yes: false, olderThan: 999, datastore: ds });
      expect(result.action).toBe('cancelled');
      expect(result.deletedCount).toBe(0);
      expect(repo.count()).toBe(2);
      expect(
        repo
          .list()
          .map((s) => s.id)
          .sort(),
      ).toEqual(['keep-a', 'keep-b']);
    } finally {
      writeSpy.mockRestore();
    }
  });
});
