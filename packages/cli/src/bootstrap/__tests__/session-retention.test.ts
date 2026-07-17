import { cliConfigSchema } from '@opensip-cli/config';
import {
  DataStoreFactory,
  ToolStateRepo,
  type DataStore,
  type DatastoreMaintenance,
} from '@opensip-cli/datastore';
import { RunRepo, SessionRepo } from '@opensip-cli/session-store';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  DEFAULT_SESSION_RETENTION_KEEP,
  DEFAULT_SESSION_RETENTION_MAX_AGE_DAYS,
  DEFAULT_SESSION_RETENTION_MAX_SIZE_MB,
  EVIDENCE_RETENTION_BATCH_SIZE,
  MAX_EVIDENCE_RETENTION_ITERATIONS,
  enforceSessionRetention,
  resolveSessionRetentionPolicy,
} from '../session-retention.js';

import type { StoredRun, StoredRunStep, StoredSession } from '@opensip-cli/contracts';
import type { Logger } from '@opensip-cli/core';

const ONE_MB = 1024 * 1024;

function logger(): Logger {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
}

function makeSession(id: string, day: number): StoredSession {
  const iso = `2026-01-${String(day).padStart(2, '0')}T00:00:00.000Z`;
  return {
    id,
    tool: 'fit',
    startedAt: iso,
    completedAt: iso,
    cwd: '/proj',
    score: 100,
    passed: true,
    durationMs: 1,
    payload: { __version: 1, id },
  };
}

function makeRun(id: string, day: number): StoredRun {
  const iso = `2026-01-${String(day).padStart(2, '0')}T00:00:00.000Z`;
  return {
    id,
    name: 'audit',
    source: 'built-in-suite',
    cwd: '/proj',
    startedAt: iso,
    completedAt: iso,
    durationMs: 1,
    exitCode: 0,
    aggregate: {
      steps: 1,
      passed: 1,
      failed: 0,
      faulted: 0,
      errors: 0,
      warnings: 0,
    },
  };
}

function makeStep(runId: string, sessionId?: string): StoredRunStep {
  return {
    id: `step-${runId}`,
    runId,
    logicalStepKey: `0:fit:${runId}`,
    ordinal: 0,
    attempt: 1,
    tool: 'fit',
    command: 'fitness',
    stableId: 'tool-fit',
    exitCode: 0,
    outcome: 'passed',
    durationMs: 1,
    ...(sessionId === undefined ? {} : { sessionId }),
  };
}

interface Repos {
  readonly sessions: SessionRepo;
  readonly runs: RunRepo;
}

function withRepos(fn: (repos: Repos, datastore: DataStore) => void): void {
  const datastore = DataStoreFactory.open({ backend: 'memory' });
  try {
    fn(
      {
        sessions: new SessionRepo(datastore),
        runs: new RunRepo(datastore),
      },
      datastore,
    );
  } finally {
    datastore.close();
  }
}

function saveLinked(repos: Repos, id: string, day: number): void {
  repos.sessions.save(makeSession(`session-${id}`, day));
  repos.runs.saveRunWithSteps(makeRun(`run-${id}`, day), [makeStep(`run-${id}`, `session-${id}`)]);
}

function withMaintenance(datastore: DataStore, maintenance: DatastoreMaintenance): DataStore {
  Object.defineProperty(datastore, 'maintenance', {
    value: maintenance,
    configurable: true,
  });
  return datastore;
}

function failWriteLock(datastore: DataStore, operation: string, error: unknown): void {
  const original = datastore.withWriteLock.bind(datastore);
  Object.defineProperty(datastore, 'withWriteLock', {
    value: <T>(op: string, fn: () => T): T => {
      if (op === operation) throw error;
      return original(op, fn);
    },
    configurable: true,
  });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('session retention defaults', () => {
  it('keeps CLI constants in sync with the config schema defaults', () => {
    const parsed = cliConfigSchema.shape.sessions.safeParse({});
    expect(parsed.success).toBe(true);
    if (!parsed.success) throw new Error('expected sessions defaults to parse');
    expect(parsed.data).toEqual({
      keep: DEFAULT_SESSION_RETENTION_KEEP,
      maxAgeDays: DEFAULT_SESSION_RETENTION_MAX_AGE_DAYS,
      maxSizeMb: DEFAULT_SESSION_RETENTION_MAX_SIZE_MB,
    });
    expect(resolveSessionRetentionPolicy()).toEqual(parsed.data);
  });

  it('normalizes configured values before enforcing retention', () => {
    expect(
      resolveSessionRetentionPolicy({
        keep: 3.8,
        maxAgeDays: -1,
        maxSizeMb: Number.POSITIVE_INFINITY,
      }),
    ).toEqual({
      keep: 3,
      maxAgeDays: DEFAULT_SESSION_RETENTION_MAX_AGE_DAYS,
      maxSizeMb: DEFAULT_SESSION_RETENTION_MAX_SIZE_MB,
    });
  });
});

describe('coordinated Session and parent-Run retention', () => {
  it('prunes Sessions first and removes newly unprotected and parent-only count excess', () => {
    withRepos((repos, datastore) => {
      saveLinked(repos, 'one', 1);
      saveLinked(repos, 'two', 2);
      saveLinked(repos, 'three', 3);
      repos.runs.saveRun(makeRun('run-parent-only', 1));

      const result = enforceSessionRetention(
        datastore,
        { keep: 2, maxAgeDays: 0, maxSizeMb: 0 },
        { logger: logger() },
      );

      expect(result.sessionsDeleted).toBe(1);
      expect(result.runsDeleted).toBe(2);
      expect(repos.sessions.list().map((session) => session.id)).toEqual([
        'session-three',
        'session-two',
      ]);
      expect(repos.runs.listRuns().map((run) => run.id)).toEqual(['run-three', 'run-two']);
    });
  });

  it('applies age bounds while retaining an old parent linked to a recent Session', () => {
    withRepos((repos, datastore) => {
      saveLinked(repos, 'old', 1);
      repos.sessions.save(makeSession('session-recent', 9));
      repos.runs.saveRunWithSteps(makeRun('run-old-protected', 1), [
        makeStep('run-old-protected', 'session-recent'),
      ]);
      repos.runs.saveRun(makeRun('run-old-unlinked', 1));
      repos.runs.saveRun(makeRun('run-at-cutoff', 5));

      const result = enforceSessionRetention(
        datastore,
        { keep: 0, maxAgeDays: 5, maxSizeMb: 0 },
        {
          now: Date.parse('2026-01-10T00:00:00.000Z'),
          logger: logger(),
        },
      );

      expect(result.sessionsDeleted).toBe(1);
      expect(result.runsDeleted).toBe(2);
      expect(result.protectedRuns).toBe(1);
      expect(repos.sessions.list().map((session) => session.id)).toEqual(['session-recent']);
      expect(repos.runs.listRuns().map((run) => run.id)).toEqual([
        'run-at-cutoff',
        'run-old-protected',
      ]);
    });
  });

  it('keeps a suite parent while any retained child Session remains linked', () => {
    withRepos((repos, datastore) => {
      for (let day = 1; day <= 3; day += 1) {
        repos.sessions.save(makeSession(`suite-session-${String(day)}`, day));
      }
      const parent = makeRun('suite-parent', 3);
      repos.runs.saveRunWithSteps(
        parent,
        Array.from({ length: 3 }, (_value, index) => ({
          ...makeStep(parent.id, `suite-session-${String(index + 1)}`),
          id: `suite-step-${String(index + 1)}`,
          logicalStepKey: `${String(index)}:fit:fitness`,
          ordinal: index,
        })),
      );

      enforceSessionRetention(
        datastore,
        { keep: 1, maxAgeDays: 0, maxSizeMb: 0 },
        { logger: logger() },
      );

      expect(repos.sessions.list().map((session) => session.id)).toEqual(['suite-session-3']);
      expect(repos.runs.getRun(parent.id)).not.toBeNull();
      expect(
        repos.runs
          .listStepsForRun(parent.id)
          .map((step) => step.sessionId)
          .filter((id) => id !== undefined),
      ).toEqual(['suite-session-3']);
    });
  });

  it('is idempotent after converging on the same effective policy', () => {
    withRepos((repos, datastore) => {
      saveLinked(repos, 'one', 1);
      saveLinked(repos, 'two', 2);
      const incrementalVacuum = vi.fn();
      withMaintenance(datastore, {
        incrementalVacuum,
        fullVacuum: vi.fn(),
        fileSizeBytes: vi.fn(() => 1),
      });
      const policy = { keep: 1, maxAgeDays: 0, maxSizeMb: 1 };

      const first = enforceSessionRetention(datastore, policy, { logger: logger() });
      const afterFirst = {
        sessions: repos.sessions.list(),
        runs: repos.runs.listRuns(),
      };
      const second = enforceSessionRetention(datastore, policy, { logger: logger() });

      expect(first.sessionsDeleted).toBe(1);
      expect(first.runsDeleted).toBe(1);
      expect(second.sessionsDeleted).toBe(0);
      expect(second.runsDeleted).toBe(0);
      expect(incrementalVacuum).toHaveBeenCalledTimes(1);
      expect({
        sessions: repos.sessions.list(),
        runs: repos.runs.listRuns(),
      }).toEqual(afterFirst);
    });
  });

  it('does no persistence or maintenance work when every policy dimension is disabled', () => {
    withRepos((repos, datastore) => {
      saveLinked(repos, 'one', 1);
      const fileSizeBytes = vi.fn();
      const maintenance: DatastoreMaintenance = {
        incrementalVacuum: vi.fn(),
        fullVacuum: vi.fn(),
        fileSizeBytes,
      };
      withMaintenance(datastore, maintenance);
      const sessionBatch = vi.spyOn(SessionRepo.prototype, 'pruneToCountBatch');
      const sessionAge = vi.spyOn(SessionRepo.prototype, 'purgeBatch');
      const runBatch = vi.spyOn(RunRepo.prototype, 'pruneToCountBatch');
      const runAge = vi.spyOn(RunRepo.prototype, 'pruneOlderThanBatch');

      const result = enforceSessionRetention(
        datastore,
        { keep: 0, maxAgeDays: 0, maxSizeMb: 0 },
        { logger: logger() },
      );

      expect(result.iterations).toBe(0);
      expect(sessionBatch).not.toHaveBeenCalled();
      expect(sessionAge).not.toHaveBeenCalled();
      expect(runBatch).not.toHaveBeenCalled();
      expect(runAge).not.toHaveBeenCalled();
      expect(fileSizeBytes).not.toHaveBeenCalled();
    });
  });
});

describe('size pressure and bounded failure behavior', () => {
  it('removes a Session and its newly unprotected parent before final size measurement', () => {
    withRepos((repos, datastore) => {
      saveLinked(repos, 'one', 1);
      saveLinked(repos, 'two', 2);
      saveLinked(repos, 'three', 3);
      const incrementalVacuum = vi.fn();
      const fullVacuum = vi.fn();
      withMaintenance(datastore, {
        incrementalVacuum,
        fullVacuum,
        fileSizeBytes: vi.fn(() => (repos.sessions.count() > 2 ? 3 * ONE_MB : 1024)),
      });

      const result = enforceSessionRetention(
        datastore,
        { keep: 4, maxAgeDays: 0, maxSizeMb: 1 },
        { logger: logger() },
      );

      expect(result.sessionsDeleted).toBe(1);
      expect(result.runsDeleted).toBe(1);
      expect(result.finalSizeBytes).toBe(1024);
      expect(result.unresolvedProtected).toBe(false);
      expect(result.unresolvedNonEvidence).toBe(false);
      expect(repos.sessions.get('session-one')).toBeNull();
      expect(repos.runs.getRun('run-one')).toBeNull();
      expect(fullVacuum).toHaveBeenCalledOnce();
      expect(incrementalVacuum).toHaveBeenCalledOnce();
    });
  });

  it('classifies policy-retained evidence separately from non-evidence oversize data', () => {
    withRepos((repos, datastore) => {
      saveLinked(repos, 'one', 1);
      const warn = vi.fn();
      const log: Logger = { ...logger(), warn };
      withMaintenance(datastore, {
        incrementalVacuum: vi.fn(),
        fullVacuum: vi.fn(),
        fileSizeBytes: vi.fn(() => 3 * ONE_MB),
      });

      const result = enforceSessionRetention(
        datastore,
        { keep: 1, maxAgeDays: 0, maxSizeMb: 1 },
        { logger: log },
      );

      expect(result.unresolvedProtected).toBe(true);
      expect(result.unresolvedNonEvidence).toBe(false);
      expect(warn).toHaveBeenCalledWith(
        expect.objectContaining({
          evt: 'evidence.retention.oversize_unresolved',
          unresolvedProtected: true,
          unresolvedNonEvidence: false,
        }),
      );
    });

    withRepos((repos, datastore) => {
      const warn = vi.fn();
      const log: Logger = { ...logger(), warn };
      const state = new ToolStateRepo(datastore);
      state.put('fit', 'retained-state', { marker: 'must-survive-size-retention' });
      withMaintenance(datastore, {
        incrementalVacuum: vi.fn(),
        fullVacuum: vi.fn(),
        fileSizeBytes: vi.fn(() => 3 * ONE_MB),
      });

      const result = enforceSessionRetention(
        datastore,
        { keep: 1, maxAgeDays: 0, maxSizeMb: 1 },
        { logger: log },
      );

      expect(repos.sessions.count()).toBe(0);
      expect(repos.runs.countRuns()).toBe(0);
      expect(state.get('fit', 'retained-state')).toEqual({
        marker: 'must-survive-size-retention',
      });
      expect(result.unresolvedProtected).toBe(false);
      expect(result.unresolvedNonEvidence).toBe(true);
    });
  });

  it('honors the named maximum pass count when bounded work remains', () => {
    withRepos((_repos, datastore) => {
      const sessionBatch = vi
        .spyOn(SessionRepo.prototype, 'pruneToCountBatch')
        .mockReturnValue(EVIDENCE_RETENTION_BATCH_SIZE);
      vi.spyOn(RunRepo.prototype, 'pruneToCountBatch').mockReturnValue({
        examined: 0,
        protected: 0,
        deleted: 0,
        remainingEligible: 0,
      });

      const result = enforceSessionRetention(
        datastore,
        { keep: 1, maxAgeDays: 0, maxSizeMb: 0 },
        { logger: logger() },
      );

      expect(sessionBatch).toHaveBeenCalledTimes(MAX_EVIDENCE_RETENTION_ITERATIONS);
      expect(result.iterations).toBe(MAX_EVIDENCE_RETENTION_ITERATIONS);
      expect(result.iterationLimitHit).toBe(true);
      expect(result.sessionsDeleted).toBe(
        EVIDENCE_RETENTION_BATCH_SIZE * MAX_EVIDENCE_RETENTION_ITERATIONS,
      );
    });
  });

  it('swallows repository and reclaim failures without escaping the finalizer', () => {
    withRepos((repos, datastore) => {
      saveLinked(repos, 'one', 1);
      saveLinked(repos, 'two', 2);
      const warn = vi.fn();
      const log: Logger = { ...logger(), warn };
      const incrementalVacuum = vi.fn();
      withMaintenance(datastore, {
        incrementalVacuum,
        fullVacuum: vi.fn(),
        fileSizeBytes: vi.fn(() => 1),
      });
      vi.spyOn(SessionRepo.prototype, 'pruneToCountBatch').mockImplementation(() => {
        throw new Error('session prune failed');
      });
      vi.spyOn(RunRepo.prototype, 'pruneToCountBatch').mockImplementation(() => {
        throw new Error('run prune failed');
      });

      expect(() =>
        enforceSessionRetention(
          datastore,
          { keep: 1, maxAgeDays: 0, maxSizeMb: 1 },
          { logger: log },
        ),
      ).not.toThrow();
      expect(repos.sessions.count()).toBe(2);
      expect(repos.runs.countRuns()).toBe(2);
      expect(warn).toHaveBeenCalledWith(
        expect.objectContaining({ evt: 'evidence.retention.failed' }),
      );
      expect(incrementalVacuum).not.toHaveBeenCalled();
    });
  });

  it('swallows incremental reclaim lock failures after both layers converge', () => {
    withRepos((repos, datastore) => {
      saveLinked(repos, 'one', 1);
      saveLinked(repos, 'two', 2);
      const warn = vi.fn();
      const log: Logger = { ...logger(), warn };
      withMaintenance(datastore, {
        incrementalVacuum: vi.fn(),
        fullVacuum: vi.fn(),
        fileSizeBytes: vi.fn(() => 1),
      });
      failWriteLock(datastore, 'evidence.retention.incremental_vacuum', 'lock denied');

      const result = enforceSessionRetention(
        datastore,
        { keep: 1, maxAgeDays: 0, maxSizeMb: 1 },
        { logger: log },
      );

      expect(result.sessionsDeleted).toBe(1);
      expect(result.runsDeleted).toBe(1);
      expect(warn).toHaveBeenCalledWith(
        expect.objectContaining({
          evt: 'evidence.retention.failed',
          operation: 'evidence.retention.incremental_vacuum',
          error: 'lock denied',
        }),
      );
    });
  });

  it('stops safely when a size probe or full reclaim fails', () => {
    withRepos((_repos, datastore) => {
      const warn = vi.fn();
      const log: Logger = { ...logger(), warn };
      let sizeCalls = 0;
      withMaintenance(datastore, {
        incrementalVacuum: vi.fn(),
        fullVacuum: vi.fn(() => {
          throw new Error('ENOSPC');
        }),
        fileSizeBytes: vi.fn(() => {
          sizeCalls += 1;
          if (sizeCalls === 1) return 3 * ONE_MB;
          throw new Error('stat unavailable');
        }),
      });

      expect(() =>
        enforceSessionRetention(
          datastore,
          { keep: 1, maxAgeDays: 0, maxSizeMb: 1 },
          { logger: log },
        ),
      ).not.toThrow();
      expect(warn).toHaveBeenCalledWith(
        expect.objectContaining({
          evt: 'evidence.retention.failed',
        }),
      );
    });
  });
});
