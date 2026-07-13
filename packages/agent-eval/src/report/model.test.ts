import { describe, expect, it } from 'vitest';

import { makeStepRecord } from '../model/record.js';

import { EVAL_REPORT_SCHEMA_VERSION, validateEvalReport } from './model.js';

import type { EvalReport } from './model.js';
import type { ResolvedStrategyStep } from '../model/task.js';

function report(): EvalReport {
  const step: ResolvedStrategyStep = {
    arguments: { query: 'entry' },
    expectedNonEmpty: true,
    extract: () => [],
    id: 'search-entry',
    rationale: 'test',
    tool: 'search_symbols',
  };
  const stepRecord = makeStepRecord({
    completeness: 'complete',
    facts: [{ kind: 'file', path: 'src/index.ts' }],
    leg: 'main',
    renderedResponse: '{"data":"not persisted"}',
    step,
    wallMs: 2,
  });
  return {
    cliVersion: '0.6.0',
    completedAt: '2026-07-12T20:01:00.000Z',
    contractFingerprint: `sha256:${'a'.repeat(64)}`,
    gitSha: 'abc1234',
    harnessVersion: '0.6.0',
    nodeVersion: 'v24.0.0',
    platform: 'darwin-arm64',
    promotionEligible: true,
    schemaVersion: EVAL_REPORT_SCHEMA_VERSION,
    selectedArms: ['opensip'],
    sourceState: 'clean',
    startedAt: '2026-07-12T20:00:00.000Z',
    tasks: [
      {
        arms: {
          opensip: {
            assertions: { incorrectNone: 0, passed: true, scopes: [] },
            metrics: {
              callCount: 1,
              incorrectNone: 0,
              responseBytes: stepRecord.responseBytes,
              timeToFirstUsefulContextMs: 2,
              totalWallMs: 2,
            },
            record: {
              arm: 'opensip',
              legs: [{ leg: 'main', steps: [stepRecord] }],
              setup: { mode: 'fixture', stages: [] },
              strategyVersion: 'mcp-epoch-4-v1',
              taskId: 'entrypoint-trace.customer-ts',
            },
            recoveryMetrics: { callCount: 0, responseBytes: 0, totalWallMs: 0 },
          },
        },
        completedAt: '2026-07-12T20:00:30.000Z',
        taskId: 'entrypoint-trace.customer-ts',
      },
    ],
  };
}

type ReportMutation = (value: EvalReport) => unknown;

const INVALID_REPORT_CASES: readonly (readonly [string, ReportMutation])[] = [
  [
    'missing schema',
    ({ schemaVersion: _schemaVersion, ...rest }) => {
      void _schemaVersion;
      return rest;
    },
  ],
  ['non-integer schema', (value) => ({ ...value, schemaVersion: 1.5 })],
  ['invalid contract fingerprint', (value) => ({ ...value, contractFingerprint: 'sha256:nope' })],
  ['missing source state', ({ sourceState: _sourceState, ...rest }) => rest],
  ['invalid source state', (value) => ({ ...value, sourceState: 'unknown' })],
  [
    'inconsistent promotion eligibility',
    (value) => ({ ...value, promotionEligible: false, sourceState: 'clean' }),
  ],
  ['empty task set', (value) => ({ ...value, tasks: [] })],
  ['missing task arm', (value) => ({ ...value, tasks: [{ ...value.tasks[0], arms: {} }] })],
  [
    'raw response leak',
    (value) => {
      const task = value.tasks[0];
      const opensip = task?.arms.opensip;
      const step = opensip?.record.legs[0]?.steps[0];
      return {
        ...value,
        tasks: [
          {
            ...task,
            arms: {
              opensip: {
                ...opensip,
                record: {
                  ...opensip?.record,
                  legs: [
                    {
                      leg: 'main',
                      steps: [{ ...step, renderedResponse: 'forbidden' }],
                    },
                  ],
                },
              },
            },
          },
        ],
      };
    },
  ],
];

describe('EvalReport model', () => {
  it('round-trips required fields and never persists rendered responses', () => {
    const original = report();
    const serialized = JSON.stringify(original);
    const parsed: unknown = JSON.parse(serialized);

    expect(parsed).toEqual(original);
    expect(validateEvalReport(parsed)).toBe(true);
    expect(serialized).not.toContain('not persisted');
    expect(original.schemaVersion).toBe(1);
    expect(Number.isInteger(original.schemaVersion)).toBe(true);
  });

  it('tolerates additive unknown fields', () => {
    expect(validateEvalReport({ ...report(), futureField: { enabled: true } })).toBe(true);
  });

  it.each(INVALID_REPORT_CASES)('rejects %s', (_label, mutate) => {
    expect(validateEvalReport(mutate(report()))).toBe(false);
  });
});
