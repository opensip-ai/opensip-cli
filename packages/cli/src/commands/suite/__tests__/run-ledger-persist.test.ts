import { buildTaskContextFileScope, buildTaskContextProjectIdentity } from '@opensip-cli/contracts';
import { RunScope, runWithScopeSync, type Logger } from '@opensip-cli/core';
import { DataStoreFactory, type DataStore } from '@opensip-cli/datastore';
import { readTaskContextRun, RunRepo, SessionRepo } from '@opensip-cli/session-store';
import { afterEach, describe, expect, it, vi, type Mock } from 'vitest';

import { BUILT_IN_AGENT_CONTEXT_PLANES, BUILT_IN_GRAPH_TOOL_ID } from '../built-in-suites.js';
import {
  allocateSuiteLedgerIdentity,
  persistSuiteRun,
  type PersistSuiteRunInput,
} from '../run-ledger-persist.js';

import type { SuiteStepReviewInput } from '../review-brief.js';
import type {
  SignalEnvelope,
  StoredSession,
  SuiteRunResult,
  TaskContextManifest,
} from '@opensip-cli/contracts';

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

function persistWithIdentity(input: Omit<PersistSuiteRunInput, 'identity'>): string | undefined {
  return persistSuiteRun({
    ...input,
    identity: allocateSuiteLedgerIdentity(input.internalSteps),
  });
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

function contextManifest(runId: string): TaskContextManifest {
  const source = {
    configIdentity: `sha256:${'1'.repeat(64)}`,
    gitHead: 'a'.repeat(40),
    worktreeIdentity: `sha256:${'2'.repeat(64)}`,
    dirty: true,
    status: 'captured' as const,
    reasonCodes: [],
  };
  return {
    schemaVersion: 1,
    suite: 'agent-context',
    runId,
    createdAt: '2026-01-01T00:00:01.000Z',
    projectIdentity: buildTaskContextProjectIdentity('/repo'),
    readiness: 'unavailable',
    sourceStart: source,
    sourceEnd: source,
    fileScope: buildTaskContextFileScope(['src/task.ts']),
    planes: [],
    reasonCodes: ['fixture-degraded'],
    nextActions: ['get_context_status'],
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
      persistWithIdentity({
        result: result({
          aggregate: {
            steps: 1,
            passed: 1,
            failed: 0,
            faulted: 0,
            errors: 0,
            warnings: 0,
          },
          scope: {
            mode: 'changed',
            source: 'explicit',
            ref: 'origin/main',
            changedFiles: 2,
          },
          reviewBrief: {
            version: 1,
            suite: 'audit',
            suiteRunId: 'suite-run-1',
            verdict: 'pass',
            changedFiles: 2,
            topRisks: [],
            newFindings: [],
            baselineDelta: {
              available: true,
              added: 0,
              removed: 0,
              unchanged: 0,
            },
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
    const scope = new RunScope({
      datastore: () => datastore,
      logger: logger(),
    });

    const persistedRunId = runWithScopeSync(scope, () =>
      persistWithIdentity({
        result: result({
          suite: 'security',
          suiteRunId: 'suite-run-2',
          steps: [],
        }),
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

  it('omits explicit file paths from context ledger args and logs without changing configured suites', () => {
    const secretPath = 'src/private-customer-task.ts';
    const datastore = openMemoryDatastore();
    const log = logger();
    const scope = new RunScope({ datastore: () => datastore, logger: log });

    const contextSteps = BUILT_IN_AGENT_CONTEXT_PLANES.map((plane, stepIndex) =>
      reviewStep({
        stepIndex,
        summary: {
          tool: 'graph',
          stableId: BUILT_IN_GRAPH_TOOL_ID,
          command: plane.command,
          exitCode: 1,
          durationMs: 1,
          outcome: 'faulted',
          kind: 'evidence',
          readiness: 'unavailable',
        },
        effectiveArgs: { files: [secretPath], selectionMode: 'focused' },
      }),
    );
    const contextIdentity = allocateSuiteLedgerIdentity(contextSteps);
    runWithScopeSync(scope, () =>
      persistSuiteRun({
        result: result({
          suite: 'agent-context',
          exitCode: 1,
          contextManifest: contextManifest(contextIdentity.runId),
          steps: contextSteps.map((step) => step.summary),
          aggregate: {
            steps: 3,
            passed: 0,
            failed: 0,
            faulted: 3,
            errors: 0,
            warnings: 0,
          },
        }),
        internalSteps: contextSteps,
        source: 'built-in',
        cwd: '/repo',
        startedAt: STARTED_AT,
        completedAt: COMPLETED_AT,
        identity: contextIdentity,
      }),
    );
    runWithScopeSync(scope, () =>
      persistWithIdentity({
        result: result({ suite: 'configured-context' }),
        internalSteps: [reviewStep({ effectiveArgs: { files: [secretPath] } })],
        source: 'configured',
        cwd: '/repo',
        startedAt: STARTED_AT,
        completedAt: COMPLETED_AT,
      }),
    );

    const repo = new RunRepo(datastore);
    const contextRun = repo.listRuns().find((run) => run.name === 'agent-context');
    const configuredRun = repo.listRuns().find((run) => run.name === 'configured-context');
    expect(repo.listStepsForRun(contextRun?.id ?? '')[0]?.effectiveArgs).toEqual({
      selectionMode: 'focused',
    });
    expect(repo.listStepsForRun(configuredRun?.id ?? '')[0]?.effectiveArgs).toEqual({
      files: [secretPath],
    });
    const replayed = readTaskContextRun({
      datastore,
      cwd: '/repo',
      runId: contextIdentity.runId,
    });
    expect(replayed.ok).toBe(true);
    const allocatedDuplicate = allocateSuiteLedgerIdentity(contextSteps);
    const duplicateId = allocatedDuplicate.steps[0]?.id;
    if (duplicateId === undefined) throw new Error('fixture identity is missing');
    const duplicateIdentity = {
      ...allocatedDuplicate,
      steps: allocatedDuplicate.steps.map((identity, index) =>
        index === 1 ? { ...identity, id: duplicateId } : identity,
      ),
    };
    expect(
      runWithScopeSync(scope, () =>
        persistSuiteRun({
          result: result({
            suite: 'agent-context',
            exitCode: 1,
            contextManifest: contextManifest(duplicateIdentity.runId),
            steps: contextSteps.map((step) => step.summary),
            aggregate: {
              steps: 3,
              passed: 0,
              failed: 0,
              faulted: 3,
              errors: 0,
              warnings: 0,
            },
          }),
          internalSteps: contextSteps,
          source: 'built-in',
          cwd: '/repo',
          startedAt: STARTED_AT,
          completedAt: COMPLETED_AT,
          identity: duplicateIdentity,
        }),
      ),
    ).toBeUndefined();
    expect(JSON.stringify(log.info.mock.calls)).not.toContain(secretPath);
    expect(JSON.stringify(log.debug.mock.calls)).not.toContain(secretPath);
    expect(JSON.stringify(log.warn.mock.calls)).not.toContain(secretPath);
    expect(JSON.stringify(log.error.mock.calls)).not.toContain(secretPath);
  });

  it('rejects noncanonical context timing, exits, durations, and verdict-bearing evidence rows', () => {
    const datastore = openMemoryDatastore();
    const scope = new RunScope({
      datastore: () => datastore,
      logger: logger(),
    });

    const attempt = (options: {
      readonly startedAt?: string;
      readonly completedAt?: string;
      readonly resultDurationMs?: number;
      readonly resultExitCode?: number;
      readonly stepDurationMs?: number;
      readonly stepExitCode?: number;
      readonly includeVerdict?: boolean;
    }): string | undefined => {
      const internalSteps = BUILT_IN_AGENT_CONTEXT_PLANES.map((plane, stepIndex) =>
        reviewStep({
          stepIndex,
          summary: {
            tool: 'graph',
            stableId: BUILT_IN_GRAPH_TOOL_ID,
            command: plane.command,
            exitCode: stepIndex === 0 ? (options.stepExitCode ?? 1) : 1,
            durationMs: stepIndex === 0 ? (options.stepDurationMs ?? 1) : 1,
            outcome: 'faulted',
            kind: 'evidence',
            readiness: 'unavailable',
            ...(stepIndex === 0 && options.includeVerdict === true
              ? {
                  verdict: {
                    passed: false,
                    errors: 1,
                    warnings: 0,
                    findings: 1,
                  },
                }
              : {}),
          },
        }),
      );
      const identity = allocateSuiteLedgerIdentity(internalSteps);
      return runWithScopeSync(scope, () =>
        persistSuiteRun({
          result: result({
            suite: 'agent-context',
            durationMs: options.resultDurationMs ?? 2,
            exitCode: options.resultExitCode ?? 1,
            contextManifest: contextManifest(identity.runId),
            steps: internalSteps.map((step) => step.summary),
            aggregate: {
              steps: 3,
              passed: 0,
              failed: 0,
              faulted: 3,
              errors: options.includeVerdict === true ? 1 : 0,
              warnings: 0,
            },
          }),
          internalSteps,
          source: 'built-in',
          cwd: '/repo',
          startedAt: options.startedAt ?? STARTED_AT,
          completedAt: options.completedAt ?? COMPLETED_AT,
          identity,
        }),
      );
    };

    expect(attempt({ resultDurationMs: -1 })).toBeUndefined();
    expect(attempt({ stepDurationMs: -1 })).toBeUndefined();
    expect(attempt({ resultExitCode: 99 })).toBeUndefined();
    expect(attempt({ stepExitCode: 99 })).toBeUndefined();
    expect(attempt({ includeVerdict: true })).toBeUndefined();
    expect(attempt({ startedAt: '2026-01-01T00:00:00Z' })).toBeUndefined();
    expect(attempt({ completedAt: '2025-12-31T23:59:59.000Z' })).toBeUndefined();
    expect(new RunRepo(datastore).listRuns()).toEqual([]);
  });

  it('rejects context manifests outside the host-owned built-in Run authority', () => {
    const datastore = openMemoryDatastore();
    const log = logger();
    const scope = new RunScope({ datastore: () => datastore, logger: log });
    const internalSteps = [reviewStep()];

    const persist = (
      manifestForIdentity: (runId: string) => TaskContextManifest,
      source: PersistSuiteRunInput['source'] = 'built-in',
    ): string | undefined => {
      const identity = allocateSuiteLedgerIdentity(internalSteps);
      return runWithScopeSync(scope, () =>
        persistSuiteRun({
          result: result({
            suite: 'agent-context',
            contextManifest: manifestForIdentity(identity.runId),
          }),
          internalSteps,
          source,
          cwd: '/repo',
          startedAt: STARTED_AT,
          completedAt: COMPLETED_AT,
          identity,
        }),
      );
    };

    expect(persist(() => contextManifest('different-run'))).toBeUndefined();
    expect(
      persist((runId) => ({
        ...contextManifest(runId),
        projectIdentity: buildTaskContextProjectIdentity('/other'),
      })),
    ).toBeUndefined();
    expect(persist(contextManifest, 'configured')).toBeUndefined();
    expect(
      persist((runId) => ({
        ...contextManifest(runId),
        createdAt: '2027-01-01T00:00:00.000Z',
      })),
    ).toBeUndefined();
    const missingIdentity = allocateSuiteLedgerIdentity(internalSteps);
    expect(
      runWithScopeSync(scope, () =>
        persistSuiteRun({
          result: result({ suite: 'agent-context' }),
          internalSteps,
          source: 'built-in',
          cwd: '/repo',
          startedAt: STARTED_AT,
          completedAt: COMPLETED_AT,
          identity: missingIdentity,
        }),
      ),
    ).toBeUndefined();
    expect(new RunRepo(datastore).listRuns()).toEqual([]);
    expect(log.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        evt: 'cli.run-ledger.suite_record_failed',
        reason: 'ledger-write-failed',
      }),
    );
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
      persistWithIdentity({
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
        reason: 'datastore-unavailable',
      }),
    );
    expect(JSON.stringify(log.debug.mock.calls)).not.toContain('datastore offline');
    expect(persistedRunId).toBeUndefined();
  });
});
