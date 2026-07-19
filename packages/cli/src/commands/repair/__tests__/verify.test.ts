import { buildImpactTrust, buildSignalEnvelope } from '@opensip-cli/contracts';
import { describe, expect, it } from 'vitest';

import {
  defaultProcessRunner,
  repairVerificationChildEnv,
  verifyRepair,
  type ProcessRunRequest,
} from '../verify-runner.js';
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
    '--cwd',
    '/repo',
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
  it('forwards the complete profiling contract to nested verification runs', () => {
    const savedGate = process.env.OPENSIP_PROFILING;
    const savedDirectory = process.env.OPENSIP_PROFILE_DIR;
    try {
      process.env.OPENSIP_PROFILING = '1';
      process.env.OPENSIP_PROFILE_DIR = '/opt/opensip/profiles';

      expect(repairVerificationChildEnv()).toMatchObject({
        OPENSIP_REPAIR_VERIFY_CHILD: '1',
        OPENSIP_PROFILING: '1',
        OPENSIP_PROFILE_DIR: '/opt/opensip/profiles',
      });
    } finally {
      if (savedGate === undefined) delete process.env.OPENSIP_PROFILING;
      else process.env.OPENSIP_PROFILING = savedGate;
      if (savedDirectory === undefined) delete process.env.OPENSIP_PROFILE_DIR;
      else process.env.OPENSIP_PROFILE_DIR = savedDirectory;
    }
  });

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

  it('classifies missing checks, check errors, and partial trust as unverifiable evidence', () => {
    const missingCheck = classifyVerification({
      tool: 'fit',
      ruleId: SELECTED.ruleId,
      files: ['', 'src/example.ts', 'src/example.ts'],
      envelope: envelope({ units: [] }),
      signal: SELECTED,
      command: COMMAND,
      exitCode: 0,
      durationMs: 42,
    });
    expect(missingCheck.status).toBe('partial');
    expect(missingCheck.failure?.code).toBe('verification-check-not-run');
    expect(missingCheck.scope.files).toEqual(['src/example.ts']);

    const unitError = classifyVerification({
      tool: 'fit',
      ruleId: SELECTED.ruleId,
      files: ['src/example.ts'],
      envelope: envelope({
        units: [unit({ passed: false, error: 'parser failed' })],
      }),
      signal: SELECTED,
      command: COMMAND,
      exitCode: 1,
      durationMs: 42,
    });
    expect(unitError.status).toBe('unverified');
    expect(unitError.failure?.code).toBe('verification-check-error');

    const partialTrust = classifyVerification({
      tool: 'fit',
      ruleId: SELECTED.ruleId,
      files: ['src/example.ts'],
      envelope: envelope({
        verification: buildImpactTrust({
          fallback: 'full-run',
          uncertainties: [{ code: 'git-shallow', source: 'git', message: 'shallow clone' }],
        }),
      }),
      signal: SELECTED,
      command: COMMAND,
      exitCode: 1,
      durationMs: 42,
    });
    expect(partialTrust.status).toBe('partial');
    expect(partialTrust.notes?.join('\n')).toContain('impact verification was partial');
    expect(partialTrust.notes?.join('\n')).toContain('verification command exited 1');
  });

  it('rejects malformed verification JSON', () => {
    const result = parseVerificationEnvelope('{not json');

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.code).toBe('verification-json-invalid');
  });

  it('rejects verification output with no envelope shape', () => {
    for (const raw of ['[]', '{}', JSON.stringify({ envelope: { signals: [] } })]) {
      const result = parseVerificationEnvelope(raw);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.failure.code).toMatch(/^verification-/);
    }
  });

  it('parses a direct envelope output shape', () => {
    const expected = envelope({ verification: buildImpactTrust() });
    const result = parseVerificationEnvelope(JSON.stringify({ envelope: expected }));

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.envelope.runId).toBe('run-1');
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
      configPath: '/repo/custom opensip.yml',
      applyResult,
      cliEntrypoint: '/repo/packages/cli/dist/index.js',
      runner: (request) => {
        calls.push(request);
        return Promise.resolve({
          exitCode: 0,
          stdout: JSON.stringify({
            envelope: envelope({ verification: buildImpactTrust() }),
          }),
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
          '--cwd',
          '/repo',
          '--config',
          '/repo/custom opensip.yml',
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

  it('returns unverified results for unsupported tools and missing entrypoints', async () => {
    const applyResult: RepairApplyResult = {
      type: 'repair-apply',
      status: 'applied',
      session: { id: 'sess-1', tool: 'graph', cwd: '/repo' },
      signal: SELECTED,
      action: ACTION,
      changes: [],
    };

    const unsupported = await verifyRepair({
      projectRoot: '/repo',
      applyResult,
    });
    expect(unsupported.status).toBe('unverified');
    expect(unsupported.failure?.code).toBe('verification-tool-unsupported');

    const missingEntrypoint = await verifyRepair({
      projectRoot: '/repo',
      applyResult: {
        ...applyResult,
        session: { id: 'sess-1', tool: 'fitness', cwd: '/repo' },
      },
      cliEntrypoint: '',
    });
    expect(missingEntrypoint.status).toBe('unverified');
    expect(missingEntrypoint.failure?.code).toBe('verification-entrypoint-unavailable');
  });

  it('returns unverified results for process timeout, truncation, and invalid output', async () => {
    const applyResult: RepairApplyResult = {
      type: 'repair-apply',
      status: 'applied',
      session: { id: 'sess-1', tool: 'fit', cwd: '/repo' },
      signal: SELECTED,
      action: ACTION,
      changes: [],
    };

    for (const [processResult, code] of [
      [
        {
          exitCode: null,
          stdout: '',
          stderr: '',
          durationMs: 1,
          timedOut: true,
          truncated: false,
        },
        'verification-timeout',
      ],
      [
        {
          exitCode: null,
          stdout: '',
          stderr: '',
          durationMs: 1,
          timedOut: false,
          truncated: true,
        },
        'verification-output-too-large',
      ],
      [
        {
          exitCode: 0,
          stdout: 'not json',
          stderr: '',
          durationMs: 1,
          timedOut: false,
          truncated: false,
        },
        'verification-json-invalid',
      ],
    ] as const) {
      const result = await verifyRepair({
        projectRoot: '/repo',
        applyResult,
        cliEntrypoint: '/repo/packages/cli/dist/index.js',
        timeoutMs: 5,
        runner: () => Promise.resolve(processResult),
      });
      expect(result.status).toBe('unverified');
      expect(result.failure?.code).toBe(code);
    }
  });

  it('captures stdout, stderr, and the exit code from the default process runner', async () => {
    const result = await defaultProcessRunner({
      command: process.execPath,
      args: [
        '-e',
        'process.stdout.write("verified-out"); process.stderr.write("verified-err"); process.exitCode = 7;',
      ],
      cwd: process.cwd(),
      timeoutMs: 10_000,
    });

    expect(result).toMatchObject({
      exitCode: 7,
      stdout: 'verified-out',
      stderr: 'verified-err',
      timedOut: false,
      truncated: false,
    });
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('reports process-spawn errors through the default runner result', async () => {
    const result = await defaultProcessRunner({
      command: `${process.cwd()}/opensip-command-that-does-not-exist`,
      args: [],
      cwd: process.cwd(),
      timeoutMs: 10_000,
    });

    expect(result.exitCode).toBeNull();
    expect(result.stderr).toMatch(/ENOENT|not found/u);
    expect(result.timedOut).toBe(false);
    expect(result.truncated).toBe(false);
  });

  it('uses the active process entrypoint when no explicit verification entrypoint is supplied', async () => {
    const applyResult: RepairApplyResult = {
      type: 'repair-apply',
      status: 'applied',
      session: { id: 'sess-1', tool: 'fitness', cwd: '/repo' },
      signal: SELECTED,
      action: ACTION,
      changes: [],
    };
    const originalEntrypoint = process.argv[1];
    process.argv[1] = '/virtual/opensip-entrypoint.js';
    try {
      const result = await verifyRepair({
        projectRoot: '/repo',
        applyResult,
        runner: (request) => {
          expect(request.args[0]).toBe('/virtual/opensip-entrypoint.js');
          return Promise.resolve({
            exitCode: 0,
            stdout: JSON.stringify({
              envelope: envelope({ verification: buildImpactTrust() }),
            }),
            stderr: '',
            durationMs: 1,
            timedOut: false,
            truncated: false,
          });
        },
      });

      expect(result.status).toBe('verified');
    } finally {
      process.argv[1] = originalEntrypoint;
    }
  });
});
