import { describe, expect, it } from 'vitest';

import { makeStepRecord } from '../model/record.js';

import { EVAL_REPORT_SCHEMA_VERSION, inspectEvalReport, validateEvalReport } from './model.js';

import type { EvalReport } from './model.js';
import type { StepRecord } from '../model/record.js';
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

function withFirstStepFields(
  value: EvalReport,
  fields: Readonly<Record<string, unknown>>,
): unknown {
  const task = value.tasks[0];
  const arm = task?.arms.opensip;
  const leg = arm?.record.legs[0];
  const step: StepRecord | undefined = leg?.steps[0];
  if (task === undefined || arm === undefined || leg === undefined || step === undefined) {
    throw new TypeError('EvalReport test fixture requires one OpenSIP step.');
  }
  return {
    ...value,
    tasks: [
      {
        ...task,
        arms: {
          ...task.arms,
          opensip: {
            ...arm,
            record: {
              ...arm.record,
              legs: [
                { ...leg, steps: [{ ...step, ...fields }, ...leg.steps.slice(1)] },
                ...arm.record.legs.slice(1),
              ],
            },
          },
        },
      },
      ...value.tasks.slice(1),
    ],
  };
}

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
  [
    'invalid cli target source',
    (value) => ({
      ...value,
      cliTarget: { entrypointName: 'index.js', source: 'bogus' },
    }),
  ],
  [
    'cli target missing entrypoint name',
    (value) => ({ ...value, cliTarget: { source: 'installed' } }),
  ],
  [
    'installed cli target has only one identity digest',
    (value) => ({
      ...value,
      cliTarget: {
        entrypointName: 'index.js',
        entrypointSha256: `sha256:${'a'.repeat(64)}`,
        source: 'installed',
      },
    }),
  ],
  [
    'installed cli target has malformed entrypoint digest',
    (value) => ({
      ...value,
      cliTarget: {
        entrypointName: 'index.js',
        entrypointSha256: 'sha256:nope',
        packageJsonSha256: `sha256:${'b'.repeat(64)}`,
        source: 'installed',
      },
    }),
  ],
  ['missing task arm', (value) => ({ ...value, tasks: [{ ...value.tasks[0], arms: {} }] })],
  [
    'unknown step failure code',
    (value) =>
      withFirstStepFields(value, {
        failure: { code: 'future-failure', kind: 'protocol', message: 'invalid response' },
      }),
  ],
  [
    'unknown step failure kind',
    (value) =>
      withFirstStepFields(value, {
        failure: { code: 'invalid-mcp-json', kind: 'unknown', message: 'invalid response' },
      }),
  ],
  [
    'empty step failure message',
    (value) =>
      withFirstStepFields(value, {
        failure: { code: 'invalid-mcp-json', kind: 'protocol', message: '' },
      }),
  ],
  [
    'invalid step retryability',
    (value) =>
      withFirstStepFields(value, {
        failure: {
          code: 'mcp-request-timeout',
          kind: 'infrastructure',
          message: 'timed out',
          retryable: 'yes',
        },
      }),
  ],
  ['raw response leak', (value) => withFirstStepFields(value, { renderedResponse: 'forbidden' })],
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

  it('tolerates an absent cli target but validates a present one', () => {
    expect(validateEvalReport(report())).toBe(true);
    expect(
      validateEvalReport({
        ...report(),
        cliTarget: { entrypointName: 'index.js', source: 'installed' },
      }),
    ).toBe(true);
    expect(
      validateEvalReport({
        ...report(),
        cliTarget: {
          entrypointName: 'index.js',
          entrypointSha256: `sha256:${'a'.repeat(64)}`,
          packageJsonSha256: `sha256:${'b'.repeat(64)}`,
          source: 'installed',
        },
      }),
    ).toBe(true);
    expect(
      validateEvalReport({
        ...report(),
        cliTarget: { entrypointName: 'index.js', source: 'workspace' },
      }),
    ).toBe(true);
  });

  it.each(INVALID_REPORT_CASES)('rejects %s', (_label, mutate) => {
    expect(validateEvalReport(mutate(report()))).toBe(false);
  });

  it('identifies the invalid root or task field without retaining report values', () => {
    expect(inspectEvalReport({ ...report(), contractFingerprint: 'sha256:nope' })).toEqual({
      field: 'contractFingerprint',
      ok: false,
    });
    expect(
      inspectEvalReport(
        withFirstStepFields(report(), {
          failure: { code: 'future-failure', kind: 'protocol', message: 'secret detail' },
        }),
      ),
    ).toEqual({ field: 'tasks[0].arms.opensip.record.legs[0].steps[0].failure', ok: false });
  });
});
