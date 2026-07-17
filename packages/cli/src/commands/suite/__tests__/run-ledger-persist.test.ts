import { buildTaskContextFileScope, buildTaskContextProjectIdentity } from '@opensip-cli/contracts';
import { RunScope, runWithScopeSync } from '@opensip-cli/core';
import { describe, expect, it, vi } from 'vitest';

import { BUILT_IN_AGENT_CONTEXT_PLANES, BUILT_IN_GRAPH_TOOL_ID } from '../built-in-suites.js';
import {
  allocateSuiteLedgerIdentity,
  projectSuiteRun,
  type ProjectSuiteRunInput,
  type SuiteLedgerIdentity,
} from '../run-ledger-persist.js';

import type { SuiteStepReviewInput } from '../review-brief.js';
import type { SignalEnvelope, SuiteRunResult, TaskContextManifest } from '@opensip-cli/contracts';

const STARTED_AT = '2026-01-01T00:00:00.000Z';
const COMPLETED_AT = '2026-01-01T00:00:02.000Z';

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

function projectWithIdentity(input: Omit<ProjectSuiteRunInput, 'identity'>): {
  readonly identity: SuiteLedgerIdentity;
  readonly projection: ReturnType<typeof projectSuiteRun>;
} {
  const identity = allocateSuiteLedgerIdentity(input.internalSteps);
  return {
    identity,
    projection: projectSuiteRun({ ...input, identity }),
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

function contextSteps(
  overrides: {
    readonly resultDurationMs?: number;
    readonly resultExitCode?: number;
    readonly stepDurationMs?: number;
    readonly stepExitCode?: number;
    readonly includeVerdict?: boolean;
    readonly effectiveArgs?: Readonly<Record<string, unknown>>;
  } = {},
): SuiteStepReviewInput[] {
  return BUILT_IN_AGENT_CONTEXT_PLANES.map((plane, stepIndex) =>
    reviewStep({
      stepIndex,
      summary: {
        tool: 'graph',
        stableId: BUILT_IN_GRAPH_TOOL_ID,
        command: plane.command,
        exitCode: stepIndex === 0 ? (overrides.stepExitCode ?? 1) : 1,
        durationMs: stepIndex === 0 ? (overrides.stepDurationMs ?? 1) : 1,
        outcome: 'faulted',
        kind: 'evidence',
        readiness: 'unavailable',
        ...(stepIndex === 0 && overrides.includeVerdict === true
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
      ...(overrides.effectiveArgs === undefined ? {} : { effectiveArgs: overrides.effectiveArgs }),
    }),
  );
}

function contextInput(input: {
  readonly steps: readonly SuiteStepReviewInput[];
  readonly identity: SuiteLedgerIdentity;
  readonly manifest?: TaskContextManifest;
  readonly source?: ProjectSuiteRunInput['source'];
  readonly cwd?: string;
  readonly startedAt?: string;
  readonly completedAt?: string;
  readonly resultDurationMs?: number;
  readonly resultExitCode?: number;
}): ProjectSuiteRunInput {
  return {
    result: result({
      suite: 'agent-context',
      durationMs: input.resultDurationMs ?? 2,
      exitCode: input.resultExitCode ?? 1,
      ...(input.manifest === undefined ? {} : { contextManifest: input.manifest }),
      steps: input.steps.map((step) => step.summary),
      aggregate: {
        steps: 3,
        passed: 0,
        failed: 0,
        faulted: 3,
        errors: input.steps.some((step) => step.summary.verdict !== undefined) ? 1 : 0,
        warnings: 0,
      },
    }),
    internalSteps: input.steps,
    source: input.source ?? 'built-in',
    cwd: input.cwd ?? '/repo',
    startedAt: input.startedAt ?? STARTED_AT,
    completedAt: input.completedAt ?? COMPLETED_AT,
    identity: input.identity,
  };
}

describe('projectSuiteRun', () => {
  it('projects a built-in parent and ordered steps with explicit identity, session, and evidence', () => {
    const internalSteps = [
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
    ];
    const { identity, projection } = projectWithIdentity({
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
      internalSteps,
      source: 'built-in',
      cwd: '/repo',
      startedAt: STARTED_AT,
      completedAt: COMPLETED_AT,
      correlationRunId: 'correlation-run-1',
    });

    expect(projection.evidence.run).toMatchObject({
      id: identity.runId,
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
      scope: {
        mode: 'changed',
        source: 'explicit',
        ref: 'origin/main',
        changedFiles: 2,
      },
      reviewBrief: { suite: 'audit', verdict: 'pass' },
    });
    expect(projection.evidence.steps).toHaveLength(1);
    expect(projection.evidence.steps[0]).toMatchObject({
      id: identity.steps[0]?.id,
      runId: identity.runId,
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
      evidence: {
        tool: 'fit',
        runId: 'run-fit-1',
        signalCount: 1,
        unitCount: 1,
        fingerprints: ['fp-1'],
        resolutionMode: 'fast',
      },
    });
  });

  it('projects configured defaults and omits absent optional fields', () => {
    const { projection } = projectWithIdentity({
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
    });

    expect(projection.evidence.run).toMatchObject({
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
    expect(projection.evidence.run.scope).toBeUndefined();
    expect(projection.evidence.run.reviewBrief).toBeUndefined();
    expect(projection.evidence.run.correlationRunId).toBeUndefined();
    expect(projection.evidence.steps[0]?.effectiveArgs).toBeUndefined();
    expect(projection.evidence.steps[0]?.verdictSummary).toBeUndefined();
    expect(projection.evidence.steps[0]?.sessionId).toBeUndefined();
    expect(projection.evidence.steps[0]?.evidence).toBeUndefined();
  });

  it('redacts context file args, preserves configured file args, and validates identity before commit', () => {
    const secretPath = 'src/private-customer-task.ts';
    const trustedSteps = contextSteps({
      effectiveArgs: { files: [secretPath], selectionMode: 'focused' },
    });
    const trustedIdentity = allocateSuiteLedgerIdentity(trustedSteps);
    const trusted = projectSuiteRun(
      contextInput({
        steps: trustedSteps,
        identity: trustedIdentity,
        manifest: contextManifest(trustedIdentity.runId),
      }),
    );
    const configured = projectWithIdentity({
      result: result({ suite: 'configured-context' }),
      internalSteps: [reviewStep({ effectiveArgs: { files: [secretPath] } })],
      source: 'configured',
      cwd: '/repo',
      startedAt: STARTED_AT,
      completedAt: COMPLETED_AT,
    }).projection;

    expect(trusted.evidence.steps[0]?.effectiveArgs).toEqual({
      selectionMode: 'focused',
    });
    expect(configured.evidence.steps[0]?.effectiveArgs).toEqual({
      files: [secretPath],
    });

    const duplicateId = trustedIdentity.steps[0]?.id;
    if (duplicateId === undefined) throw new Error('fixture identity is missing');
    const duplicateIdentity = {
      ...trustedIdentity,
      steps: trustedIdentity.steps.map((identity, index) =>
        index === 1 ? { ...identity, id: duplicateId } : identity,
      ),
    };
    expect(() =>
      projectSuiteRun(
        contextInput({
          steps: trustedSteps,
          identity: duplicateIdentity,
          manifest: contextManifest(duplicateIdentity.runId),
        }),
      ),
    ).toThrow(TypeError);

    const wrongOrderIdentity = {
      ...allocateSuiteLedgerIdentity([reviewStep()]),
      steps: [
        {
          ...allocateSuiteLedgerIdentity([reviewStep()]).steps[0],
          ordinal: 1,
        },
      ],
    };
    expect(() =>
      projectSuiteRun({
        result: result(),
        internalSteps: [reviewStep()],
        source: 'configured',
        cwd: '/repo',
        startedAt: STARTED_AT,
        completedAt: COMPLETED_AT,
        identity: wrongOrderIdentity,
      }),
    ).toThrow('Suite ledger identity does not match the executed step order.');
  });

  it('rejects noncanonical context timing, exits, durations, and verdict-bearing evidence rows', () => {
    const attempt = (options: {
      readonly startedAt?: string;
      readonly completedAt?: string;
      readonly resultDurationMs?: number;
      readonly resultExitCode?: number;
      readonly stepDurationMs?: number;
      readonly stepExitCode?: number;
      readonly includeVerdict?: boolean;
    }): void => {
      const internalSteps = contextSteps(options);
      const identity = allocateSuiteLedgerIdentity(internalSteps);
      projectSuiteRun(
        contextInput({
          steps: internalSteps,
          identity,
          manifest: contextManifest(identity.runId),
          ...options,
        }),
      );
    };

    expect(() => attempt({ resultDurationMs: -1 })).toThrow(TypeError);
    expect(() => attempt({ stepDurationMs: -1 })).toThrow(TypeError);
    expect(() => attempt({ resultExitCode: 99 })).toThrow(TypeError);
    expect(() => attempt({ stepExitCode: 99 })).toThrow(TypeError);
    expect(() => attempt({ includeVerdict: true })).toThrow(TypeError);
    expect(() => attempt({ startedAt: '2026-01-01T00:00:00Z' })).toThrow(TypeError);
    expect(() => attempt({ completedAt: '2025-12-31T23:59:59.000Z' })).toThrow(TypeError);
  });

  it('rejects context manifests outside the host-owned built-in Run authority', () => {
    const internalSteps = contextSteps();
    const project = (
      manifestForIdentity: (runId: string) => TaskContextManifest | undefined,
      source: ProjectSuiteRunInput['source'] = 'built-in',
    ): void => {
      const identity = allocateSuiteLedgerIdentity(internalSteps);
      projectSuiteRun(
        contextInput({
          steps: internalSteps,
          identity,
          manifest: manifestForIdentity(identity.runId),
          source,
        }),
      );
    };

    expect(() => project(() => contextManifest('different-run'))).toThrow(TypeError);
    expect(() =>
      project((runId) => ({
        ...contextManifest(runId),
        projectIdentity: buildTaskContextProjectIdentity('/other'),
      })),
    ).toThrow(TypeError);
    expect(() => project(contextManifest, 'configured')).toThrow(TypeError);
    expect(() =>
      project((runId) => ({
        ...contextManifest(runId),
        createdAt: '2027-01-01T00:00:00.000Z',
      })),
    ).toThrow(TypeError);
    expect(() => project(() => undefined)).toThrow(TypeError);
  });

  it('is side-effect free and returns, but does not evaluate, the locked precondition', () => {
    const datastore = vi.fn(() => {
      throw new Error('projection must not open the datastore');
    });
    const log = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };
    const precondition = vi.fn(() => true);
    const scope = new RunScope({
      datastore,
      logger: log,
      runId: 'ambient-correlation-must-not-be-read',
    });

    const projection = runWithScopeSync(scope, () =>
      projectWithIdentity({
        result: result(),
        internalSteps: [reviewStep()],
        source: 'configured',
        cwd: '/repo',
        startedAt: STARTED_AT,
        completedAt: COMPLETED_AT,
        correlationRunId: 'explicit-correlation-run',
        persistencePrecondition: precondition,
      }),
    ).projection;

    expect(projection.evidence.run.correlationRunId).toBe('explicit-correlation-run');
    expect(projection.precondition).toBe(precondition);
    expect(precondition).not.toHaveBeenCalled();
    expect(datastore).not.toHaveBeenCalled();
    expect(log.debug).not.toHaveBeenCalled();
    expect(log.info).not.toHaveBeenCalled();
    expect(log.warn).not.toHaveBeenCalled();
    expect(log.error).not.toHaveBeenCalled();
  });
});
