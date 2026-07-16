import { describe, expect, it } from 'vitest';

import {
  makeStepRecord,
  type ArmLegRecord,
  type ArmRunRecord,
  type MakeStepRecordInput,
} from '../model/record.js';

import { computeArmMetrics, computeRecoveryMetrics } from './metrics.js';

import type { AnswerFact, RunLeg } from '../model/task.js';

const extractNothing = (): readonly AnswerFact[] => [];

function resolvedStep(id: string, expectedNonEmpty = false) {
  return {
    arguments: {},
    expectedNonEmpty,
    extract: extractNothing,
    id,
    provesAbsence: [{ kind: 'symbol' as const, name: 'removed' }],
    rationale: 'Collect normalized facts.',
    tool: 'search',
  };
}

function step(
  id: string,
  leg: RunLeg,
  renderedResponse: string,
  wallMs: number,
  facts: readonly AnswerFact[] = [],
  overrides: Partial<MakeStepRecordInput> = {},
) {
  return makeStepRecord({
    completeness: 'complete',
    facts,
    leg,
    proofClosure: { domainExhausted: true, projectionComplete: true, reasonCodes: [] },
    renderedResponse,
    step: resolvedStep(id),
    wallMs,
    ...overrides,
  });
}

function run(legs: readonly ArmLegRecord[]): ArmRunRecord {
  return {
    arm: 'opensip',
    legs,
    setup: {
      mcp: {
        handshakeDurationMs: 30_000,
        mutationPosture: 'read-only',
        projectRootVerified: true,
        projectScope: 'project',
        stderr: { bytes: 512, truncated: false },
        surfaceEpoch: 4,
        surfaceVerified: true,
        toolCount: 1,
        toolNames: ['get_agent_catalog'],
        version: '0.6.0',
      },
      mode: 'fixture',
      stages: [
        { durationMs: 10_000, exitCode: 0, name: 'init' },
        { durationMs: 20_000, exitCode: 0, name: 'graph' },
      ],
    },
    strategyVersion: 'v1',
    taskId: 'task',
  };
}

describe('arm metrics', () => {
  it('measures only consumed early-exit steps and the first contributing fact', () => {
    const record = run([
      {
        leg: 'main',
        steps: [
          step('inventory', 'main', 'a', 3, [{ kind: 'package', name: 'other' }]),
          step('answer', 'main', 'bb', 7, [{ kind: 'package', name: 'core' }]),
        ],
      },
    ]);

    expect(
      computeArmMetrics(record, {
        mustInclude: [{ kind: 'package', name: 'core' }],
      }),
    ).toEqual({
      callCount: 2,
      incorrectNone: 0,
      responseBytes: 3,
      timeToFirstUsefulContextMs: 10,
      totalWallMs: 10,
    });
  });

  it('supports a full-length strategy and reports no useful context when truth is absent', () => {
    const steps = Array.from({ length: 5 }, (_, index) =>
      step(`step-${index}`, 'main', 'x', 2, [{ kind: 'package', name: `other-${index}` }]),
    );
    const metrics = computeArmMetrics(run([{ leg: 'main', steps }]), {
      mustInclude: [{ kind: 'package', name: 'missing' }],
    });

    expect(metrics).toMatchObject({
      callCount: 5,
      responseBytes: 5,
      timeToFirstUsefulContextMs: null,
      totalWallMs: 10,
    });
  });

  it('treats complete absence as useful context for a negative assertion', () => {
    const record = run([
      {
        leg: 'main',
        steps: [step('absence', 'main', '[]', 4)],
      },
    ]);

    expect(
      computeArmMetrics(record, {
        mustExclude: [{ kind: 'symbol', name: 'removed' }],
      }).timeToFirstUsefulContextMs,
    ).toBe(4);
  });

  it('does not report unrelated, paged, or stale absence as useful context', () => {
    const assertions = {
      mustExclude: [{ kind: 'symbol' as const, name: 'removed' }],
    };
    const candidates = [
      step('unrelated', 'main', '[]', 4, [], {
        step: {
          ...resolvedStep('unrelated'),
          provesAbsence: [{ kind: 'file' as const, path: 'other.ts' }],
        },
      }),
      step('paged', 'main', '[]', 4, [], { nextCursor: 'r1:more' }),
      step('stale', 'main', '[]', 4, [], {
        freshness: { fresh: false, verification: 'complete' },
      }),
    ];

    for (const candidate of candidates) {
      expect(
        computeArmMetrics(run([{ leg: 'main', steps: [candidate] }]), assertions)
          .timeToFirstUsefulContextMs,
      ).toBeNull();
    }
  });

  it('does not report terminal absence over an incomplete discovery prefix as useful', () => {
    const record = run([
      {
        leg: 'main',
        steps: [
          step(
            'frontier',
            'main',
            'partial',
            3,
            [{ kind: 'text', label: 'frontier', value: 'partial' }],
            {
              completeness: 'incomplete',
              step: { ...resolvedStep('frontier', true), provesAbsence: [] },
              truncated: true,
            },
          ),
          step('terminal', 'main', '[]', 4),
        ],
      },
    ]);

    expect(
      computeArmMetrics(record, {
        mustExclude: [{ kind: 'symbol', name: 'removed' }],
      }).timeToFirstUsefulContextMs,
    ).toBeNull();
  });

  it('does not report negative context after an earlier forbidden fact or false-none contract', () => {
    const assertions = { mustExclude: [{ kind: 'symbol' as const, name: 'removed' }] };
    const conflicting = run([
      {
        leg: 'main',
        steps: [
          step('conflict', 'main', 'removed', 2, [{ kind: 'symbol', name: 'removed' }]),
          step('terminal', 'main', '[]', 3),
        ],
      },
    ]);
    const falseNone = run([
      {
        leg: 'main',
        steps: [
          step('required-empty', 'main', '[]', 2, [], {
            step: resolvedStep('required-empty', true),
          }),
          step('terminal', 'main', '[]', 3),
        ],
      },
    ]);

    expect(computeArmMetrics(conflicting, assertions).timeToFirstUsefulContextMs).toBeNull();
    expect(computeArmMetrics(falseNone, assertions).timeToFirstUsefulContextMs).toBeNull();
  });

  it('waits for a consumed fact instead of an unrelated non-empty checkpoint', () => {
    const record = run([
      {
        leg: 'main',
        steps: [
          step('lookup', 'main', '{}', 6, [{ kind: 'text', label: 'note', value: 'found' }], {
            step: resolvedStep('lookup', true),
          }),
          step('answer', 'main', '{}', 7, [{ kind: 'package', name: 'core' }]),
        ],
      },
    ]);

    expect(
      computeArmMetrics(record, {
        mustInclude: [{ kind: 'package', name: 'core' }],
      }).timeToFirstUsefulContextMs,
    ).toBe(13);
  });

  it('counts incorrect none but not incomplete or failed none', () => {
    const record = run([
      {
        leg: 'main',
        steps: [
          step('wrong-none', 'main', '[]', 1, [], {
            step: resolvedStep('wrong-none', true),
          }),
          step('partial-none', 'main', '[]', 1, [], {
            completeness: 'incomplete',
            step: resolvedStep('partial-none', true),
            truncated: true,
          }),
          step('failed-none', 'main', '', 1, [], {
            failure: { code: 'failure', kind: 'tool', message: 'failed' },
            step: resolvedStep('failed-none', true),
          }),
        ],
      },
    ]);

    expect(computeArmMetrics(record, {})).toMatchObject({ incorrectNone: 1 });
  });

  it('returns null for a zero-step run', () => {
    expect(computeArmMetrics(run([]), {})).toEqual({
      callCount: 0,
      incorrectNone: 0,
      responseBytes: 0,
      timeToFirstUsefulContextMs: null,
      totalWallMs: 0,
    });
  });

  it('does not treat facts from a failed invocation as useful context', () => {
    const record = run([
      {
        leg: 'main',
        steps: [
          step('failed', 'main', 'bad', 4, [{ kind: 'package', name: 'core' }], {
            failure: {
              code: 'protocol',
              kind: 'protocol',
              message: 'invalid response',
            },
          }),
        ],
      },
    ]);

    expect(
      computeArmMetrics(record, {
        mustInclude: [{ kind: 'package', name: 'core' }],
      }).timeToFirstUsefulContextMs,
    ).toBeNull();
  });

  it('waits for post-edit truth instead of treating the pre-edit probe as the answer', () => {
    const record = run([
      {
        leg: 'pre-edit',
        steps: [step('before', 'pre-edit', 'old', 5, [{ kind: 'symbol', name: 'removed' }])],
      },
      {
        leg: 'post-edit',
        steps: [step('after', 'post-edit', '[]', 7)],
      },
    ]);
    const metrics = computeArmMetrics(record, {
      scoped: [
        {
          leg: 'pre-edit',
          mustInclude: [{ kind: 'symbol', name: 'removed' }],
        },
        {
          leg: 'post-edit',
          mustExclude: [{ kind: 'symbol', name: 'removed' }],
        },
      ],
      staleness: { postEditLeg: 'post-edit' },
    });

    expect(metrics.timeToFirstUsefulContextMs).toBe(12);
  });
});

describe('recovery metrics', () => {
  it('keeps recovery calls, bytes, and time out of primary cost', () => {
    const record = run([
      { leg: 'post-edit', steps: [step('post', 'post-edit', 'p', 2)] },
      {
        leg: 'recovery',
        steps: [step('refresh', 'recovery', 'rr', 10), step('retry', 'recovery', 'rrr', 20)],
      },
    ]);

    expect(computeArmMetrics(record, {})).toMatchObject({
      callCount: 1,
      responseBytes: 1,
      totalWallMs: 2,
    });
    expect(computeRecoveryMetrics(record)).toEqual({
      callCount: 2,
      responseBytes: 5,
      totalWallMs: 30,
    });
  });

  it('returns zeros when recovery was not attempted', () => {
    expect(computeRecoveryMetrics(run([]))).toEqual({
      callCount: 0,
      responseBytes: 0,
      totalWallMs: 0,
    });
  });
});
