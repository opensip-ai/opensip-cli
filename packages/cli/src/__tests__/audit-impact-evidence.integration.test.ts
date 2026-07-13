import { RunScope, runWithScopeSync } from '@opensip-cli/core';
import { DataStoreFactory, type DataStore } from '@opensip-cli/datastore';
import { RunRepo, SessionRepo } from '@opensip-cli/session-store';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { persistSuiteRun } from '../commands/suite/run-ledger-persist.js';

import type { StoredSession, SuiteRunResult } from '@opensip-cli/contracts';

const opened: DataStore[] = [];

function datastore(): DataStore {
  const value = DataStoreFactory.open({ backend: 'memory' });
  opened.push(value);
  return value;
}

function graphSession(id: string, impactStatus: 'available' | 'omitted-overflow'): StoredSession {
  return {
    id,
    tool: 'graph',
    cwd: '/repo',
    startedAt: '2026-07-01T00:00:00.000Z',
    completedAt: '2026-07-01T00:00:01.000Z',
    durationMs: 1000,
    score: 100,
    passed: true,
    cliVersion: '0.0.0-test',
    payload: {
      __version: 1,
      summary: { total: 1, passed: 1, failed: 0, errors: 0, warnings: 0 },
      checks: [],
      impactStatus,
      ...(impactStatus === 'omitted-overflow'
        ? {}
        : {
            impact: {
              basis: { type: 'files', warningCodes: [] },
              changedFiles: ['src/change.ts'],
              changedFunctions: [],
              impactedFunctions: [],
              impactedFiles: [],
              impactedPackages: [],
              trust: {
                coverage: 'full',
                fallback: 'targeted',
                fullyVerified: true,
                uncertainties: [],
              },
              recommendedCommands: ['opensip fit --changed'],
              truncated: false,
              omitted: {
                changedFiles: 0,
                changedFunctions: 0,
                impactedFunctions: 0,
                impactedFiles: 0,
                impactedPackages: 0,
                recommendedCommands: 0,
              },
              detailTruncated: false,
              metadataOmitted: false,
            },
          }),
    },
  };
}

describe('audit Run to graph-session evidence join', () => {
  afterEach(() => {
    for (const value of opened.splice(0)) value.close();
  });

  it('joins only through RunStep.sessionId even when timestamps overlap', () => {
    const store = datastore();
    const sessions = new SessionRepo(store);
    sessions.save(graphSession('session-linked', 'available'));
    sessions.save(graphSession('session-same-time-unlinked', 'omitted-overflow'));
    const logger = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };
    const scope = new RunScope({ datastore: () => store, logger });
    const result: SuiteRunResult = {
      type: 'suite-run',
      suite: 'audit',
      suiteRunId: 'suite-join',
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
      steps: [
        {
          tool: 'graph',
          stableId: '3873f1c2-02a9-4719-930a-bca74b62b706',
          command: 'impact',
          durationMs: 1000,
          exitCode: 0,
          outcome: 'passed',
        },
      ],
    };

    const runId = runWithScopeSync(scope, () =>
      persistSuiteRun({
        result,
        internalSteps: [
          {
            stepIndex: 0,
            summary: result.steps[0],
            sessionId: 'session-linked',
          },
        ],
        source: 'built-in',
        cwd: '/repo',
        startedAt: '2026-07-01T00:00:00.000Z',
        completedAt: '2026-07-01T00:00:01.000Z',
      }),
    );

    expect(runId).toMatch(/^RUN_/u);
    const runs = new RunRepo(store);
    expect(runs.getRun(runId!)).toMatchObject({
      id: runId,
      legacySuiteRunId: 'suite-join',
    });
    const [step] = runs.listStepsForRun(runId!);
    expect(step?.sessionId).toBe('session-linked');
    expect(runs.getStepBySessionId('session-linked')?.runId).toBe(runId);
    const linked = sessions.get(step?.sessionId ?? '');
    expect(linked?.payload).toMatchObject({
      impactStatus: 'available',
      impact: { changedFiles: ['src/change.ts'] },
    });
    expect(sessions.latest({ tool: 'graph' })?.id).not.toBeUndefined();
    expect(linked?.id).not.toBe('session-same-time-unlinked');
  });

  it('keeps legacy and overflow graph evidence states explicit', () => {
    const store = datastore();
    const sessions = new SessionRepo(store);
    const legacy = graphSession('session-legacy', 'available');
    const legacyPayload = legacy.payload as { readonly summary: unknown };
    sessions.save({
      ...legacy,
      payload: { __version: 1, summary: legacyPayload.summary, checks: [] },
    });
    sessions.save(graphSession('session-overflow', 'omitted-overflow'));

    expect(sessions.get('session-legacy')?.payload).not.toHaveProperty('impactStatus');
    expect(sessions.get('session-legacy')?.payload).not.toHaveProperty('impact');
    expect(sessions.get('session-overflow')?.payload).toMatchObject({
      impactStatus: 'omitted-overflow',
    });
    expect(sessions.get('session-overflow')?.payload).not.toHaveProperty('impact');
  });
});
