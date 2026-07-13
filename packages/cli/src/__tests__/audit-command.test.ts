import { beforeEach, describe, expect, it, vi } from 'vitest';

const executeSuiteCommand = vi.hoisted(() => vi.fn());
const composeAndWriteReport = vi.hoisted(() => vi.fn());
const decideCurrentReportOpen = vi.hoisted(() => vi.fn());

vi.mock('../commands/suite/execute-suite-command.js', () => ({
  executeSuiteCommand,
}));
vi.mock('../report-compose.js', () => ({ composeAndWriteReport }));
vi.mock('../bootstrap/report-open-policy.js', () => ({
  decideCurrentReportOpen,
}));

import { buildAuditCommandSpec } from '../commands/audit-command-spec.js';

import type { CliCommandsContext } from '../commands/shared.js';
import type { SuiteRunResult } from '@opensip-cli/contracts';

const RESULT: SuiteRunResult = {
  type: 'suite-run',
  suite: 'audit',
  suiteRunId: 'suite-1',
  runId: 'run-parent-1',
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
  composeAndWriteReport.mockReset();
  decideCurrentReportOpen.mockReset();
  executeSuiteCommand.mockImplementation(
    (input: { readonly ctx: CliCommandsContext }): Promise<SuiteRunResult> => {
      input.ctx.setExitCode(RESULT.exitCode);
      return Promise.resolve(RESULT);
    },
  );
  composeAndWriteReport.mockResolvedValue({
    type: 'report',
    path: '/repo/.runtime/reports/latest.html',
    opened: true,
  });
  decideCurrentReportOpen.mockImplementation(
    (opts: { readonly openRequested: boolean; readonly jsonOutput: boolean }) => ({
      shouldOpen: opts.openRequested && !opts.jsonOutput,
      reason: opts.openRequested && !opts.jsonOutput ? 'ok' : 'suppressed',
    }),
  );
});

describe('audit report launch', () => {
  it('composes after suite completion and selects the persisted parent run', async () => {
    const order: string[] = [];
    executeSuiteCommand.mockImplementation(() => {
      order.push('suite');
      return Promise.resolve(RESULT);
    });
    composeAndWriteReport.mockImplementation(() => {
      order.push('report');
      return Promise.resolve({
        type: 'report',
        path: '/repo/report.html',
        opened: true,
      });
    });
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
    expect(order).toEqual(['suite', 'report']);
    expect(executeSuiteCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'audit',
        defaultChanged: true,
        opts: {
          files: ['src/a.ts'],
          cwd: '/repo',
          config: '/repo/opensip-cli.config.yml',
        },
      }),
    );
    expect(composeAndWriteReport).toHaveBeenCalledWith({
      open: true,
      selection: { view: 'change-impact', runId: 'run-parent-1' },
    });
  });

  it('selects Change Impact without inventing a run when persistence was unavailable', async () => {
    const resultWithoutParent = { ...RESULT, runId: undefined };
    executeSuiteCommand.mockResolvedValue(resultWithoutParent);
    const ctx = makeCtx();

    await buildAuditCommandSpec(ctx).handler({ open: true }, ctx);

    expect(composeAndWriteReport).toHaveBeenCalledWith({
      open: true,
      selection: { view: 'change-impact' },
    });
  });

  it.each([
    ['not requested', { open: false, json: false }],
    ['JSON mode', { open: true, json: true }],
  ])('does not compose a report when opening is suppressed: %s', async (_label, opts) => {
    const ctx = makeCtx();

    const result = await buildAuditCommandSpec(ctx).handler(opts, ctx);

    expect(result).toBe(RESULT);
    expect(composeAndWriteReport).not.toHaveBeenCalled();
  });

  it('renders the written report when browser launch fails without changing the audit exit', async () => {
    const report = {
      type: 'report' as const,
      path: '/repo/.runtime/reports/latest.html',
      opened: false,
    };
    composeAndWriteReport.mockResolvedValue(report);
    const ctx = makeCtx();

    const result = await buildAuditCommandSpec(ctx).handler({ open: true }, ctx);

    expect(result).toBe(RESULT);
    expect(ctx.render).toHaveBeenCalledWith(report);
    expect(ctx.exitCodes.at(-1)).toBe(RESULT.exitCode);
  });

  it('renders a bounded report diagnostic when composition fails and preserves the audit result', async () => {
    composeAndWriteReport.mockRejectedValue(new Error('/private/repo report failure'));
    const ctx = makeCtx();

    const result = await buildAuditCommandSpec(ctx).handler({ open: true }, ctx);

    expect(result).toBe(RESULT);
    expect(ctx.render).toHaveBeenCalledWith({
      type: 'text-lines',
      title: 'Change Impact report unavailable',
      lines: ['The audit completed, but its report could not be generated or opened.'],
    });
    expect(ctx.exitCodes.at(-1)).toBe(RESULT.exitCode);
  });
});
