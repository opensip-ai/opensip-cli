import { currentLogger } from '@opensip-cli/core';

import { decideCurrentReportOpen } from '../../bootstrap/report-open-policy.js';
import { composeAndWriteReport } from '../../report-compose.js';

import { BUILT_IN_AUDIT_SUITE_NAME } from './built-in-suites.js';

import type { CliCommandsContext } from '../shared.js';
import type { SuiteRunResult } from '@opensip-cli/contracts';

/**
 * Best-effort HTML report open after a suite completes.
 *
 * Built-in audit opens the Change Impact surface for the persisted parent run.
 * Other suites open the ordinary report without a closed view selection.
 * JSON/non-TTY/CI never launch a browser; report failure never changes the
 * suite exit code.
 */
export async function maybeOpenSuiteReport(input: {
  readonly name: string;
  readonly result: SuiteRunResult;
  readonly opts: Readonly<Record<string, unknown>>;
  readonly ctx: CliCommandsContext;
}): Promise<SuiteRunResult> {
  const { ctx, name, opts, result } = input;
  const openDecision = decideCurrentReportOpen({
    openRequested: opts.open === true,
    jsonOutput: opts.json === true,
  });
  if (!openDecision.shouldOpen) return result;

  try {
    const report = await composeAndWriteReport({
      open: true,
      ...(name === BUILT_IN_AUDIT_SUITE_NAME
        ? {
            selection: {
              view: 'change-impact' as const,
              ...(result.runId === undefined ? {} : { runId: result.runId }),
            },
          }
        : {}),
    });
    if (!report.opened) await ctx.render(report);
  } catch (error) {
    currentLogger().warn?.({
      evt: 'cli.report.suite_open_failed',
      module: 'cli:report',
      suite: name,
      errorName: error instanceof Error ? error.name : 'UnknownError',
    });
    const isAudit = name === BUILT_IN_AUDIT_SUITE_NAME;
    await ctx.render({
      type: 'text-lines',
      title: isAudit ? 'Change Impact report unavailable' : 'Report unavailable',
      lines: [
        isAudit
          ? 'The audit completed, but its report could not be generated or opened.'
          : 'The suite completed, but its report could not be generated or opened.',
      ],
    });
  }
  // Report composition and browser launch are best-effort presentation. The
  // completed suite remains the sole authority for the command verdict.
  ctx.setExitCode(result.exitCode);
  return result;
}
