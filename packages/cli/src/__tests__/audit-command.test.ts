import { beforeEach, describe, expect, it, vi } from 'vitest';

const executeSuiteCommand = vi.hoisted(() => vi.fn());
const planReportOpen = vi.hoisted(() => vi.fn());

vi.mock('../commands/suite/execute-suite-command.js', () => ({
  executeSuiteCommand,
}));
vi.mock('../bootstrap/report-open-policy.js', () => ({ planReportOpen }));

import { buildAuditCommandSpec } from '../commands/audit-command-spec.js';
import { planSuiteReportEffect } from '../commands/suite/open-suite-report.js';

import type { CliCommandsContext } from '../commands/shared.js';
import type { SuiteRunResult } from '@opensip-cli/contracts';

const RESULT: SuiteRunResult = {
  type: 'suite-run',
  suite: 'audit',
  suiteRunId: 'suite-1',
  runId: 'RUN_01J00000000000000000000000',
  exitCode: 3,
  durationMs: 10,
  steps: [],
};

function makeCtx(): CliCommandsContext & { readonly exitCodes: number[] } {
  const exitCodes: number[] = [];
  return {
    setExitCode: (code) => exitCodes.push(code),
    getExitCode: () => exitCodes.at(-1),
    render: vi.fn(() => Promise.resolve()),
    emitJson: vi.fn(),
    emitRaw: vi.fn(),
    emitError: vi.fn(),
    pluginLayouts: [],
    toolScaffolds: [],
    datastore: vi.fn(),
    exitCodes,
  };
}

beforeEach(() => {
  executeSuiteCommand.mockReset();
  planReportOpen.mockReset();
  executeSuiteCommand.mockResolvedValue(RESULT);
  planReportOpen.mockReturnValue({
    status: 'open',
    effect: { kind: 'compose-and-open' },
  });
});

describe('audit report launch', () => {
  it('passes the top-level report request into atomic suite orchestration', async () => {
    const ctx = makeCtx();

    const result = await buildAuditCommandSpec(ctx).handler(
      {
        open: true,
        files: ['src/a.ts'],
        cwd: '/repo',
        config: '/repo/opensip-cli.config.yml',
        reportTo: 'https://untrusted.example/upload',
        apiKey: 'must-not-propagate',
        unknown: 'must-not-propagate',
      },
      ctx,
    );

    expect(result).toBe(RESULT);
    expect(executeSuiteCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'audit',
        defaultChanged: true,
        opts: {
          open: true,
          files: ['src/a.ts'],
          cwd: '/repo',
          config: '/repo/opensip-cli.config.yml',
        },
      }),
    );
  });

  it('plans one exact Change Impact effect for audit', () => {
    expect(
      planSuiteReportEffect({
        name: 'audit',
        runId: RESULT.runId!,
        opts: { open: true },
      }),
    ).toEqual({
      kind: 'compose-and-open',
      selection: { view: 'change-impact', runId: RESULT.runId },
    });
    expect(planReportOpen).toHaveBeenCalledWith({
      openRequested: true,
      jsonOutput: false,
    });
  });

  it('plans an ordinary report without inventing a Change Impact selection', () => {
    expect(
      planSuiteReportEffect({
        name: 'nightly',
        runId: RESULT.runId!,
        opts: { open: true },
      }),
    ).toEqual({ kind: 'compose-and-open' });
  });

  it.each([
    ['not requested', { open: false, json: false }],
    ['JSON mode', { open: true, json: true }],
  ])('does not plan a report when opening is suppressed: %s', (_label, opts) => {
    planReportOpen.mockReturnValueOnce({
      status: 'skipped',
      reason: 'suppressed',
    });

    expect(
      planSuiteReportEffect({
        name: 'audit',
        runId: RESULT.runId!,
        opts,
      }),
    ).toBeUndefined();
  });
});
