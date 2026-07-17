import { describe, expect, expectTypeOf, it } from 'vitest';

import type {
  CommandResult,
  RunDetailResult,
  RunHistoryResult,
  RuntimeNextCommand,
  RuntimeRecoveryCommand,
  RuntimeRecoveryReasonCode,
  RuntimeStatusResult,
  StoredRun,
  StoredRunStep,
} from '../index.js';

const RUN: StoredRun = {
  id: 'run-parent-01',
  name: 'audit',
  source: 'built-in-suite',
  cwd: '/redacted/project',
  startedAt: '2026-07-16T00:00:00.000Z',
  completedAt: '2026-07-16T00:00:01.000Z',
  durationMs: 1000,
  exitCode: 0,
  aggregate: { steps: 1, passed: 1, failed: 0, faulted: 0, errors: 0, warnings: 0 },
};

const STEP: StoredRunStep = {
  id: 'step-01',
  runId: RUN.id,
  logicalStepKey: 'graph',
  ordinal: 0,
  attempt: 1,
  tool: 'graph',
  command: 'graph --json',
  stableId: 'graph',
  exitCode: 0,
  outcome: 'passed',
  durationMs: 100,
  sessionId: 'session-01',
};

function baseStatus(): RuntimeStatusResult {
  return {
    type: 'runtime-status',
    projectInitialized: false,
    activePlane: 'none',
    cache: { exists: false, identityStrength: 'path-only' },
    project: { exists: false },
    evidenceDatabase: { exists: false },
    adoptionState: 'not-needed',
    retention: {
      cache: { keep: 50, maxAgeDays: 30 },
      evidence: { keep: 200, maxAgeDays: 60, maxSizeMb: 150 },
    },
    nextCommands: ['opensip init'],
  };
}

describe('runtime and parent Run result contracts', () => {
  it('admits a status result with absent optional recovery fields', () => {
    const status = baseStatus();
    expect(status.recoveryPhase).toBeUndefined();
    expect(status.recoveryCommand).toBeUndefined();
    expect(status.cache).not.toHaveProperty('path');
    expectTypeOf(status).toMatchTypeOf<CommandResult>();
  });

  it('admits open recovery and closed cleanup projections', () => {
    const open: RuntimeStatusResult = {
      ...baseStatus(),
      adoptionState: 'recovery-required',
      recoveryPhase: 'destination-install',
      recoveryReasonCode: 'operation-interrupted',
      sourcePreserved: true,
      recoveryCommand: 'opensip init',
    };
    const closed: RuntimeStatusResult = {
      ...baseStatus(),
      activePlane: 'project',
      projectInitialized: true,
      project: { exists: true },
      adoptionState: 'not-needed',
      recoveryPhase: 'cleanup',
      recoveryReasonCode: 'cleanup-pending',
      sourcePreserved: false,
      cleanupPending: true,
      recoveryCommand: 'opensip init',
    };
    expect(open.recoveryReasonCode).toBe('operation-interrupted');
    expect(closed.cleanupPending).toBe(true);
  });

  it('keeps the recovery reason and command vocabularies closed', () => {
    const reasons: readonly RuntimeRecoveryReasonCode[] = [
      'operation-interrupted',
      'operation-failed',
      'journal-malformed',
      'journal-oversize',
      'journal-key-mismatch',
      'journal-phase-invalid',
      'source-unverified',
      'artifact-missing',
      'artifact-mismatch',
      'state-ambiguous',
      'rollback-incomplete',
      'cleanup-pending',
    ];
    const commands: readonly RuntimeRecoveryCommand[] = [
      'opensip init',
      'opensip init --runtime-conflict keep-project',
      'opensip init --runtime-conflict use-cache',
    ];
    expect(reasons).toHaveLength(12);
    expect(commands).toHaveLength(3);
    expectTypeOf('arbitrary recovery text').not.toMatchTypeOf<RuntimeRecoveryReasonCode>();
    expectTypeOf('rm -rf /').not.toMatchTypeOf<RuntimeRecoveryCommand>();
    expectTypeOf('rm -rf /').not.toMatchTypeOf<RuntimeNextCommand>();
  });

  it('preserves exact Run and ordered RunStep identities without Session payloads', () => {
    const history: RunHistoryResult = {
      type: 'run-history',
      runs: [{ run: RUN, showCommand: `opensip runs show ${RUN.id} --json` }],
      requestedLimit: 20,
      effectiveLimit: 20,
      truncated: false,
    };
    const detail: RunDetailResult = {
      type: 'run-detail',
      run: RUN,
      steps: [STEP],
      offset: 0,
      limit: 20,
      total: 1,
      sessionFollowUps: [
        {
          runStepId: STEP.id,
          sessionId: 'session-01',
          showCommand: 'opensip sessions show session-01 --json',
        },
      ],
    };
    expect(history.runs[0]?.run.id).toBe(RUN.id);
    expect(detail.steps.map((step) => step.id)).toEqual(['step-01']);
    expect(detail.sessionFollowUps[0]?.sessionId).toBe('session-01');
    expect(detail).not.toHaveProperty('sessions');
    expectTypeOf(history).toMatchTypeOf<CommandResult>();
    expectTypeOf(detail).toMatchTypeOf<CommandResult>();
  });

  it('serializes no recovery path, token, or digest fields', () => {
    const result = {
      ...baseStatus(),
      adoptionState: 'recovery-required',
      recoveryPhase: 'unknown',
      recoveryReasonCode: 'journal-malformed',
      sourcePreserved: true,
      recoveryCommand: 'opensip init',
    } satisfies RuntimeStatusResult;
    const serialized = JSON.stringify(result);
    const keys = Object.keys(JSON.parse(serialized) as Record<string, unknown>);
    expect(keys).not.toEqual(
      expect.arrayContaining(['path', 'cachePath', 'projectPath', 'token', 'digest', 'manifest']),
    );
    expect(serialized).not.toContain('/Users/');
  });
});
