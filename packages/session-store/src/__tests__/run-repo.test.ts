import { DataStoreFactory, type DataStore } from '@opensip-cli/datastore';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { RunRepo } from '../run-repo.js';
import { SessionRepo } from '../session-repo.js';

import type { StoredRun, StoredRunStep, StoredSession } from '@opensip-cli/contracts';

function makeRun(overrides: Partial<StoredRun> = {}): StoredRun {
  return {
    id: 'run-test-1',
    name: 'audit',
    source: 'built-in-suite',
    cwd: '/proj',
    startedAt: '2026-07-08T12:00:00.000Z',
    completedAt: '2026-07-08T12:00:01.000Z',
    durationMs: 1000,
    exitCode: 0,
    aggregate: { steps: 2, passed: 2, failed: 0, faulted: 0, errors: 0, warnings: 0 },
    legacySuiteRunId: 'suite-legacy-1',
    cliVersion: '0.5.0',
    ...overrides,
  };
}

function makeStep(overrides: Partial<StoredRunStep> = {}): StoredRunStep {
  return {
    id: 'step-test-1',
    runId: 'run-test-1',
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
    verdictSummary: { passed: true, errors: 0, warnings: 0, findings: 0 },
    evidence: { findings: 0 },
    ...overrides,
  };
}

function makeSession(overrides: Partial<StoredSession> = {}): StoredSession {
  return {
    id: 'session-test-1',
    tool: 'fit',
    startedAt: '2026-07-08T12:00:00.000Z',
    completedAt: '2026-07-08T12:00:00.250Z',
    cwd: '/proj',
    recipe: 'agent-risk',
    score: 100,
    passed: true,
    durationMs: 250,
    ...overrides,
  };
}

let datastore: DataStore;
let repo: RunRepo;

beforeEach(() => {
  datastore = DataStoreFactory.open({ backend: 'memory' });
  repo = new RunRepo(datastore);
});

afterEach(() => {
  datastore.close();
});

describe('RunRepo', () => {
  it('round-trips a run with ordered steps', () => {
    const run = makeRun();
    repo.saveRunWithSteps(run, [
      makeStep({ id: 'step-2', ordinal: 1, logicalStepKey: '1:graph:impact' }),
      makeStep({ id: 'step-1', ordinal: 0, logicalStepKey: '0:fit:fitness' }),
    ]);

    expect(repo.getRun(run.id)).toEqual(run);
    expect(repo.listStepsForRun(run.id).map((step) => step.id)).toEqual(['step-1', 'step-2']);
  });

  it('upserts repeated run and step ids instead of duplicating rows', () => {
    const run = makeRun();
    repo.saveRunWithSteps(run, [makeStep()]);
    repo.saveRunWithSteps(
      { ...run, exitCode: 1, aggregate: { ...run.aggregate, failed: 1, passed: 1 } },
      [makeStep({ exitCode: 1, outcome: 'failed' })],
    );

    expect(repo.listRuns()).toHaveLength(1);
    expect(repo.listStepsForRun(run.id)).toHaveLength(1);
    expect(repo.getRun(run.id)?.exitCode).toBe(1);
    expect(repo.listStepsForRun(run.id)[0]?.outcome).toBe('failed');
  });

  it('looks up runs by legacy suite id and steps by linked session id', () => {
    new SessionRepo(datastore).save(makeSession());
    const run = makeRun();
    const step = makeStep({ sessionId: 'session-test-1' });
    repo.saveRunWithSteps(run, [step]);

    expect(repo.getRunByLegacySuiteRunId('suite-legacy-1')?.id).toBe(run.id);
    expect(repo.getStepBySessionId('session-test-1')).toEqual(step);
  });

  it('groups steps for multiple runs', () => {
    repo.saveRunWithSteps(makeRun({ id: 'run-a' }), [
      makeStep({ id: 'a-0', runId: 'run-a', ordinal: 0 }),
    ]);
    repo.saveRunWithSteps(makeRun({ id: 'run-b', legacySuiteRunId: 'suite-b' }), [
      makeStep({ id: 'b-0', runId: 'run-b', ordinal: 0 }),
      makeStep({ id: 'b-1', runId: 'run-b', ordinal: 1, logicalStepKey: '1:yagni:yagni' }),
    ]);

    const byRun = repo.listStepsForRuns(['run-a', 'run-b']);
    expect(byRun.get('run-a')?.map((step) => step.id)).toEqual(['a-0']);
    expect(byRun.get('run-b')?.map((step) => step.id)).toEqual(['b-0', 'b-1']);
  });
});
