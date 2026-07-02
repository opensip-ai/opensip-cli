import { buildImpactTrust, buildSignalEnvelope } from '@opensip-cli/contracts';
import { describe, expect, it } from 'vitest';

import { verifyRepair, type ProcessRunRequest } from '../verify-runner.js';
import { classifyVerification, parseVerificationEnvelope } from '../verify.js';

import type {
  RepairApplyResult,
  RepairSignalRef,
  SignalEnvelope,
  UnitResult,
} from '@opensip-cli/contracts';
import type { Signal } from '@opensip-cli/core';

const SELECTED: RepairSignalRef = {
  id: 'sig-1',
  ruleId: 'typescript-directive-hygiene',
  message: 'Use @ts-expect-error instead of @ts-ignore',
  filePath: 'src/example.ts',
  line: 1,
  fingerprint: 'fp-1',
};

const COMMAND = {
  tool: 'fit',
  args: [
    'fit',
    '--check',
    'typescript-directive-hygiene',
    '--changed',
    '--include-impacted',
    '--json',
  ],
  cwd: '/repo',
  check: 'typescript-directive-hygiene',
};

const ACTION = {
  id: 'replace-directive',
  kind: 'replace' as const,
  title: 'Replace directive',
  autofixable: true,
  confidence: 0.9,
};

function signal(overrides: Partial<Signal> = {}): Signal {
  return {
    id: 'sig-1',
    source: 'typescript-directive-hygiene',
    provider: 'opensip',
    severity: 'medium',
    category: 'quality',
    ruleId: 'typescript-directive-hygiene',
    message: 'Use @ts-expect-error instead of @ts-ignore',
    filePath: 'src/example.ts',
    line: 1,
    metadata: {},
    createdAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function unit(overrides: Partial<UnitResult> = {}): UnitResult {
  return {
    slug: 'typescript-directive-hygiene',
    passed: true,
    violationCount: 0,
    durationMs: 1,
    ...overrides,
  };
}

function envelope(input: {
  readonly signals?: readonly Signal[];
  readonly units?: readonly UnitResult[];
  readonly verification?: SignalEnvelope['verification'];
}): SignalEnvelope {
  return buildSignalEnvelope({
    tool: 'fit',
    runId: 'run-1',
    createdAt: '2026-01-01T00:00:00.000Z',
    units: input.units ?? [unit()],
    signals: input.signals ?? [],
    policy: { failOnErrors: 1, failOnWarnings: 0 },
    runFaulted: false,
    verification: input.verification,
  });
}

describe('repair verification classifier', () => {
  it('classifies a fully trusted run with no remaining finding as verified', () => {
    const result = classifyVerification({
      tool: 'fit',
      ruleId: SELECTED.ruleId,
      files: ['src/example.ts'],
      envelope: envelope({ verification: buildImpactTrust() }),
      signal: SELECTED,
      command: COMMAND,
      exitCode: 0,
      durationMs: 42,
    });

    expect(result.status).toBe('verified');
    expect(result.coverage).toBe('full');
    expect(result.scope.checkRan).toBe(true);
  });

  it('classifies a remaining same-rule same-file finding as unverified', () => {
    const result = classifyVerification({
      tool: 'fit',
      ruleId: SELECTED.ruleId,
      files: ['src/example.ts'],
      envelope: envelope({
        signals: [signal({ fingerprint: 'fp-1' })],
        verification: buildImpactTrust(),
      }),
      signal: SELECTED,
      command: COMMAND,
      exitCode: 1,
      durationMs: 42,
    });

    expect(result.status).toBe('unverified');
    expect(result.remainingFindings).toHaveLength(1);
    expect(result.failure?.code).toBe('verification-finding-remains');
  });

  it('classifies absent trust metadata as partial rather than verified', () => {
    const result = classifyVerification({
      tool: 'fit',
      ruleId: SELECTED.ruleId,
      files: ['src/example.ts'],
      envelope: envelope({}),
      signal: SELECTED,
      command: COMMAND,
      exitCode: 0,
      durationMs: 42,
    });

    expect(result.status).toBe('partial');
    expect(result.coverage).toBe('unknown');
    expect(result.notes?.join('\n')).toContain('impact-trust');
  });

  it('rejects malformed verification JSON', () => {
    const result = parseVerificationEnvelope('{not json');

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.code).toBe('verification-json-invalid');
  });

  it('parses the current command outcome data envelope shape', () => {
    const expected = envelope({ verification: buildImpactTrust() });
    const result = parseVerificationEnvelope(
      JSON.stringify({
        kind: 'agent-filtered',
        status: 'ok',
        exitCode: 0,
        data: { type: 'agent-filtered', envelope: expected },
      }),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.envelope.runId).toBe('run-1');
  });

  it('runs the scoped fit verification command through the process runner seam', async () => {
    const applyResult: RepairApplyResult = {
      type: 'repair-apply',
      status: 'applied',
      session: { id: 'sess-1', tool: 'fit', cwd: '/repo' },
      signal: SELECTED,
      action: ACTION,
      changes: [
        {
          filePath: 'src/example.ts',
          status: 'modified',
          beforeHash: 'before',
          afterHash: 'after',
          diff: 'diff --git a/src/example.ts b/src/example.ts',
        },
      ],
    };
    const calls: ProcessRunRequest[] = [];

    const result = await verifyRepair({
      projectRoot: '/repo',
      applyResult,
      cliEntrypoint: '/repo/packages/cli/dist/index.js',
      runner: (request) => {
        calls.push(request);
        return Promise.resolve({
          exitCode: 0,
          stdout: JSON.stringify({ envelope: envelope({ verification: buildImpactTrust() }) }),
          stderr: '',
          durationMs: 17,
          timedOut: false,
          truncated: false,
        });
      },
    });

    expect(calls).toEqual([
      {
        command: process.execPath,
        args: [
          '/repo/packages/cli/dist/index.js',
          'fit',
          '--check',
          'typescript-directive-hygiene',
          '--changed',
          '--include-impacted',
          '--json',
        ],
        cwd: '/repo',
        timeoutMs: 120_000,
      },
    ]);
    expect(result.status).toBe('verified');
    expect(result.scope.files).toEqual(['src/example.ts']);
  });
});
