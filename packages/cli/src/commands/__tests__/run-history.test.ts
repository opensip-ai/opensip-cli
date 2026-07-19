import { EXIT_CODES, mapToolErrorToExitCode } from '@opensip-cli/contracts';
import { ConfigurationError, ValidationError } from '@opensip-cli/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { executeRunsList, executeRunsShow } from '../run-history.js';

import type { StoredRun, StoredRunStep } from '@opensip-cli/contracts';
import type { DataStore } from '@opensip-cli/datastore';

const readMocks = vi.hoisted(() => ({
  listParentRuns: vi.fn(),
  resolveParentRun: vi.fn(),
}));

vi.mock('@opensip-cli/session-store', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@opensip-cli/session-store')>()),
  ...readMocks,
}));

const STORE = {} as DataStore;

function run(overrides: Partial<StoredRun> = {}): StoredRun {
  return {
    id: 'RUN_01',
    name: 'audit',
    source: 'built-in-suite',
    cwd: '/repo',
    startedAt: '2026-07-17T00:00:00.000Z',
    completedAt: '2026-07-17T00:00:01.000Z',
    durationMs: 1000,
    exitCode: 0,
    aggregate: {
      steps: 2,
      passed: 2,
      failed: 0,
      faulted: 0,
      errors: 0,
      warnings: 1,
    },
    reviewBrief: {
      version: 1,
      suite: 'audit',
      suiteRunId: 'suite-run-01',
      verdict: 'pass',
      changedFiles: 2,
      topRisks: [],
      newFindings: [],
      baselineDelta: { available: true, added: 0, removed: 0, unchanged: 1 },
      degraded: [],
      recommendedActions: [],
    },
    contextManifest: {
      futureVocabulary: { preserved: true },
    } as unknown as StoredRun['contextManifest'],
    ...overrides,
  };
}

function step(overrides: Partial<StoredRunStep> = {}): StoredRunStep {
  return {
    id: 'STEP_01',
    runId: 'RUN_01',
    logicalStepKey: '0:fit:fitness',
    ordinal: 0,
    attempt: 1,
    tool: 'fit',
    command: 'fitness',
    stableId: 'tool-fit',
    exitCode: 0,
    outcome: 'passed',
    durationMs: 250,
    ...overrides,
  };
}

beforeEach(() => {
  readMocks.listParentRuns.mockReset();
  readMocks.resolveParentRun.mockReset();
});

describe('executeRunsList', () => {
  it('preserves the snapshot order and maps exact parent show commands', () => {
    const newest = run({ id: 'RUN_NEWEST' });
    const older = run({
      id: 'RUN_OLDER',
      completedAt: '2026-07-16T00:00:01.000Z',
    });
    readMocks.listParentRuns.mockReturnValue({
      runs: [newest, older],
      requestedLimit: 20,
      effectiveLimit: 20,
      truncated: false,
    });

    const result = executeRunsList({ store: STORE, limit: 20 });

    expect(readMocks.listParentRuns).toHaveBeenCalledOnce();
    expect(readMocks.listParentRuns).toHaveBeenCalledWith(STORE, { limit: 20 });
    expect(result).toEqual({
      type: 'run-history',
      runs: [
        { run: newest, showCommand: 'opensip runs show RUN_NEWEST --json' },
        { run: older, showCommand: 'opensip runs show RUN_OLDER --json' },
      ],
      requestedLimit: 20,
      effectiveLimit: 20,
      truncated: false,
    });
    expect(result.runs[0]?.run).toBe(newest);
  });

  it('delegates defaulting and truncation metadata to the bounded store reader', () => {
    readMocks.listParentRuns.mockReturnValue({
      runs: [],
      requestedLimit: 20,
      effectiveLimit: 20,
      truncated: true,
    });

    expect(executeRunsList({ store: STORE })).toEqual({
      type: 'run-history',
      runs: [],
      requestedLimit: 20,
      effectiveLimit: 20,
      truncated: true,
    });
    expect(readMocks.listParentRuns).toHaveBeenCalledWith(STORE, {});
  });

  it('does not clamp or reinterpret a bound rejected by session-store', () => {
    const error = new ValidationError('limit must be between 1 and 500', {
      code: 'VALIDATION.RUN_READ.LIMIT',
    });
    readMocks.listParentRuns.mockImplementation(() => {
      throw error;
    });

    expect(() => executeRunsList({ store: STORE, limit: 501 })).toThrow(error);
    expect(readMocks.listParentRuns).toHaveBeenCalledWith(STORE, {
      limit: 501,
    });
  });
});

describe('executeRunsShow', () => {
  it('preserves exact Run/step ordering and adds follow-ups only for linked Sessions', () => {
    const exactRun = run();
    const linked = step({
      id: 'STEP_B',
      ordinal: 0,
      attempt: 1,
      sessionId: 'SESSION_01',
    });
    const runOnly = step({
      id: 'STEP_A',
      logicalStepKey: '0:graph:impact',
      ordinal: 0,
      attempt: 2,
      tool: 'graph',
      command: 'impact',
    });
    readMocks.resolveParentRun.mockReturnValue({
      status: 'found',
      run: exactRun,
      steps: [linked, runOnly],
      offset: 2,
      limit: 2,
      total: 5,
      nextOffset: 4,
    });

    const result = executeRunsShow({
      store: STORE,
      runId: exactRun.id,
      offset: 2,
      limit: 2,
    });

    expect(readMocks.resolveParentRun).toHaveBeenCalledOnce();
    expect(readMocks.resolveParentRun).toHaveBeenCalledWith(STORE, {
      runId: exactRun.id,
      offset: 2,
      limit: 2,
    });
    expect(result).toEqual({
      type: 'run-detail',
      run: exactRun,
      steps: [linked, runOnly],
      offset: 2,
      limit: 2,
      total: 5,
      nextOffset: 4,
      sessionFollowUps: [
        {
          runStepId: 'STEP_B',
          sessionId: 'SESSION_01',
          showCommand: 'opensip sessions show SESSION_01 --json',
        },
      ],
    });
    expect(result.run).toBe(exactRun);
    expect(result.steps).toEqual([linked, runOnly]);
    expect(result).not.toHaveProperty('sessions');
  });

  it('returns an empty exact page without inventing continuation or Session data', () => {
    const exactRun = run({ id: 'RUN_EMPTY_PAGE' });
    readMocks.resolveParentRun.mockReturnValue({
      status: 'found',
      run: exactRun,
      steps: [],
      offset: 10,
      limit: 100,
      total: 2,
    });

    expect(executeRunsShow({ store: STORE, runId: exactRun.id, offset: 10 })).toEqual({
      type: 'run-detail',
      run: exactRun,
      steps: [],
      offset: 10,
      limit: 100,
      total: 2,
      sessionFollowUps: [],
    });
    expect(readMocks.resolveParentRun).toHaveBeenCalledWith(STORE, {
      runId: 'RUN_EMPTY_PAGE',
      offset: 10,
    });
  });

  it('uses exact opaque identity and never falls back to name, legacy ID, or latest', () => {
    const exactRun = run({ id: 'opaque_id-WITH-123' });
    readMocks.resolveParentRun.mockReturnValue({
      status: 'found',
      run: exactRun,
      steps: [],
      offset: 0,
      limit: 100,
      total: 0,
    });

    executeRunsShow({ store: STORE, runId: exactRun.id });

    expect(readMocks.resolveParentRun).toHaveBeenCalledOnce();
    expect(readMocks.resolveParentRun).toHaveBeenCalledWith(STORE, {
      runId: 'opaque_id-WITH-123',
    });
  });

  it('refuses to generate a shell command for an unsafe linked Session ID', () => {
    const exactRun = run();
    readMocks.resolveParentRun.mockReturnValue({
      status: 'found',
      run: exactRun,
      steps: [step({ sessionId: 'unsafe/session' })],
      offset: 0,
      limit: 100,
      total: 1,
    });

    expect(() => executeRunsShow({ store: STORE, runId: exactRun.id })).toThrow(
      expect.objectContaining({
        name: 'SystemError',
        code: 'SYSTEM.RUN_READ.UNSAFE_SESSION_ID',
      }),
    );
  });

  it('throws a stable typed exit-2 ConfigurationError for a missing exact Run', () => {
    readMocks.resolveParentRun.mockReturnValue({ status: 'not-found' });

    let caught: unknown;
    try {
      executeRunsShow({ store: STORE, runId: 'RUN_MISSING' });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(ConfigurationError);
    expect(caught).toMatchObject({
      code: 'CLI.RUNS.NOT_FOUND',
      message: "Parent Run 'RUN_MISSING' was not found.",
    });
    expect(mapToolErrorToExitCode(caught as ConfigurationError)).toBe(
      EXIT_CODES.CONFIGURATION_ERROR,
    );
    expect(readMocks.resolveParentRun).toHaveBeenCalledWith(STORE, {
      runId: 'RUN_MISSING',
    });
  });

  it('propagates offset and limit validation errors from the snapshot reader', () => {
    const error = new ValidationError('offset must be non-negative', {
      code: 'VALIDATION.RUN_READ.OFFSET',
    });
    readMocks.resolveParentRun.mockImplementation(() => {
      throw error;
    });

    expect(() =>
      executeRunsShow({
        store: STORE,
        runId: 'RUN_01',
        offset: -1,
        limit: 501,
      }),
    ).toThrow(error);
    expect(readMocks.resolveParentRun).toHaveBeenCalledWith(STORE, {
      runId: 'RUN_01',
      offset: -1,
      limit: 501,
    });
  });
});
