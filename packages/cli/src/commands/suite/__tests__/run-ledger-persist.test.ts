import { RunScope, runWithScopeSync, type Logger } from '@opensip-cli/core';
import { DataStoreFactory, type DataStore } from '@opensip-cli/datastore';
import { RunRepo, SessionRepo } from '@opensip-cli/session-store';
import { afterEach, describe, expect, it, vi, type Mock } from 'vitest';

import { persistSuiteRun } from '../run-ledger-persist.js';

import type { SuiteStepReviewInput } from '../review-brief.js';
import type { SignalEnvelope, StoredSession, SuiteRunResult } from '@opensip-cli/contracts';

const STARTED_AT = '2026-01-01T00:00:00.000Z';
const COMPLETED_AT = '2026-01-01T00:00:02.000Z';

const openDatastores: DataStore[] = [];

interface TestLogger extends Logger {
  readonly debug: Mock;
  readonly info: Mock;
  readonly warn: Mock;
  readonly error: Mock;
}

function openMemoryDatastore(): DataStore {
  const datastore = DataStoreFactory.open({ backend: 'memory' });
  openDatastores.push(datastore);
  return datastore;
}

function logger(): TestLogger {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
}

function seedSession(datastore: DataStore): void {
  const session: StoredSession = {
    id: 'session-fit-1',
    tool: 'fit',
    startedAt: STARTED_AT,
    completedAt: COMPLETED_AT,
    cwd: '/repo',
    score: 100,
    passed: true,
    durationMs: 11,
    cliVersion: '0.0.0-test',
    payload: { __version: 1 },
  };
  new SessionRepo(datastore).save(session);
}

function result(overrides: Partial<SuiteRunResult> = {}): SuiteRunResult {
  const steps = overrides.steps ?? [
    {
      tool: 'fit',
      stableId: 'fitness',
      command: 'fit',
      exitCode: 0,
      durationMs: 11,
      outcome: 'passed',
    },
  ];
  return {
    type: 'suite-run',
    suite: 'audit',
    suiteRunId: 'suite-run-1',
    exitCode: 0,
    durationMs: 23,
    steps,
    ...overrides,
  };
}

function reviewStep(overrides: Partial<SuiteStepReviewInput> = {}): SuiteStepReviewInput {
  return {
    stepIndex: 0,
    summary: {
      tool: 'fit',
      stableId: 'fitness',
      command: 'fit',
      exitCode: 0,
      durationMs: 11,
      outcome: 'passed',
    },
    ...overrides,
  };
}

function envelope(): SignalEnvelope {
  return {
    schemaVersion: 2,
    tool: 'fit',
    runId: 'run-fit-1',
    createdAt: STARTED_AT,
    verdict: {
      passed: true,
      faulted: false,
      score: 1,
      summary: {
        total: 1,
        passed: 1,
        failed: 0,
        errors: 0,
        warnings: 0,
      },
    },
    units: [{ slug: 'check-a', passed: true, durationMs: 1 }],
    // Minimal signal stub: this fixture only needs a fingerprint + metadata for projection.
    signals: [{ fingerprint: 'fp-1', metadata: {} }] as unknown as SignalEnvelope['signals'],
    baselineIdentity: {
      fingerprintStrategyId: 'test',
      fingerprintStrategyVersion: 1,
    },
    resolutionMode: 'fast',
  };
}

describe('persistSuiteRun', () => {
  afterEach(() => {
    for (const datastore of openDatastores.splice(0)) datastore.close();
  });

  it('persists a built-in suite run with step arguments, verdict, session, and evidence', () => {
    const datastore = openMemoryDatastore();
    seedSession(datastore);
    const log = logger();
    const scope = new RunScope({
      datastore: () => datastore,
      logger: log,
      runId: 'correlation-run-1',
    });

    const persistedRunId = runWithScopeSync(scope, () =>
      persistSuiteRun({
        result: result({
          aggregate: {
            steps: 1,
            passed: 1,
            failed: 0,
            faulted: 0,
            errors: 0,
            warnings: 0,
          },
          scope: { mode: 'changed', source: 'explicit', ref: 'origin/main', changedFiles: 2 },
          reviewBrief: {
            version: 1,
            suite: 'audit',
            suiteRunId: 'suite-run-1',
            verdict: 'pass',
            changedFiles: 2,
            topRisks: [],
            newFindings: [],
            baselineDelta: { available: true, added: 0, removed: 0, unchanged: 0 },
            degraded: [],
            recommendedActions: [],
          },
        }),
        internalSteps: [
          reviewStep({
            effectiveArgs: { recipe: 'agent-risk' },
            sessionId: 'session-fit-1',
            capturedEnvelope: envelope(),
            summary: {
              tool: 'fit',
              stableId: 'fitness',
              command: 'fit --recipe agent-risk',
              exitCode: 0,
              durationMs: 11,
              outcome: 'passed',
              verdict: {
                passed: true,
                errors: 0,
                warnings: 0,
                findings: 0,
              },
            },
          }),
        ],
        source: 'built-in',
        cwd: '/repo',
        startedAt: STARTED_AT,
        completedAt: COMPLETED_AT,
      }),
    );

    const repo = new RunRepo(datastore);
    const [run] = repo.listRuns();
    expect(persistedRunId).toBe(run?.id);
    expect(run).toMatchObject({
      name: 'audit',
      source: 'built-in-suite',
      correlationRunId: 'correlation-run-1',
      cwd: '/repo',
      startedAt: STARTED_AT,
      completedAt: COMPLETED_AT,
      durationMs: 23,
      exitCode: 0,
      legacySuiteRunId: 'suite-run-1',
      aggregate: {
        steps: 1,
        passed: 1,
        failed: 0,
        faulted: 0,
        errors: 0,
        warnings: 0,
      },
    });
    expect(run?.scope).toEqual({
      mode: 'changed',
      source: 'explicit',
      ref: 'origin/main',
      changedFiles: 2,
    });
    expect(run?.reviewBrief).toMatchObject({ suite: 'audit', verdict: 'pass' });

    const [step] = repo.listStepsForRun(run?.id ?? '');
    expect(step).toMatchObject({
      runId: run?.id,
      logicalStepKey: '0:fitness:fit --recipe agent-risk',
      ordinal: 0,
      attempt: 1,
      tool: 'fit',
      command: 'fit --recipe agent-risk',
      stableId: 'fitness',
      effectiveArgs: { recipe: 'agent-risk' },
      exitCode: 0,
      outcome: 'passed',
      durationMs: 11,
      verdictSummary: {
        passed: true,
        errors: 0,
        warnings: 0,
        findings: 0,
      },
      sessionId: 'session-fit-1',
    });
    expect(step?.evidence).toMatchObject({
      tool: 'fit',
      runId: 'run-fit-1',
      signalCount: 1,
      unitCount: 1,
      fingerprints: ['fp-1'],
      resolutionMode: 'fast',
    });
    expect(log.info).toHaveBeenCalledWith(
      expect.objectContaining({
        evt: 'cli.run-ledger.suite_recorded',
        suiteRunId: 'suite-run-1',
        stepCount: 1,
      }),
    );
  });

  it('persists configured suites with default aggregate and omitted optional step fields', () => {
    const datastore = openMemoryDatastore();
    const scope = new RunScope({ datastore: () => datastore, logger: logger() });

    const persistedRunId = runWithScopeSync(scope, () =>
      persistSuiteRun({
        result: result({ suite: 'security', suiteRunId: 'suite-run-2', steps: [] }),
        internalSteps: [reviewStep()],
        source: 'configured',
        cwd: '/repo',
        startedAt: STARTED_AT,
        completedAt: COMPLETED_AT,
      }),
    );

    const repo = new RunRepo(datastore);
    const [run] = repo.listRuns();
    expect(persistedRunId).toBe(run?.id);
    expect(run).toMatchObject({
      name: 'security',
      source: 'configured-suite',
      aggregate: {
        steps: 0,
        passed: 0,
        failed: 0,
        faulted: 0,
        errors: 0,
        warnings: 0,
      },
    });
    expect(run?.scope).toBeUndefined();
    expect(run?.reviewBrief).toBeUndefined();

    const [step] = repo.listStepsForRun(run?.id ?? '');
    expect(step?.effectiveArgs).toBeUndefined();
    expect(step?.verdictSummary).toBeUndefined();
    expect(step?.sessionId).toBeUndefined();
    expect(step?.evidence).toBeUndefined();
  });

  it('logs and returns when the scoped datastore cannot be opened', () => {
    const log = logger();
    const scope = new RunScope({
      datastore: () => {
        throw new Error('datastore offline');
      },
      logger: log,
    });

    const persistedRunId = runWithScopeSync(scope, () =>
      persistSuiteRun({
        result: result(),
        internalSteps: [],
        source: 'configured',
        cwd: '/repo',
        startedAt: STARTED_AT,
        completedAt: COMPLETED_AT,
      }),
    );

    expect(log.debug).toHaveBeenCalledWith(
      expect.objectContaining({
        evt: 'cli.run-ledger.datastore_unavailable',
        error: 'datastore offline',
      }),
    );
    expect(persistedRunId).toBeUndefined();
  });
});
