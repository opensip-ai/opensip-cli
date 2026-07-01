/**
 * Gate mode for `opensip yagni` (`--gate-save` / `--gate-compare`).
 *
 * Host-owned baseline persistence and exit (ADR-0036 / ADR-0035): yagni hands
 * the fingerprint-stamped envelope to the baseline seams and feeds the findings
 * verdict to `deliverSignals` runFailed — no tool-side `setExitCode`.
 */

import { EXIT_CODES, runHostGateDispatch } from '@opensip-cli/contracts';

import { executeYagni } from './execute-yagni.js';
import { loadYagniConfig } from './yagni-config.js';

import type { YagniConfidence } from '../types/yagni-metadata.js';
import type { ToolCliContext, ToolRunCompletion } from '@opensip-cli/core';

export interface YagniGateCommandOptions {
  readonly cwd: string;
  readonly json?: boolean;
  readonly reportTo?: string;
  readonly apiKey?: string;
  readonly gateSave?: boolean;
  readonly gateCompare?: boolean;
  readonly sarif?: string;
  readonly minConfidence?: string;
  readonly detector?: string | string[];
  readonly category?: string | string[];
  readonly includeTests?: boolean;
}

function parseMinConfidence(raw: string | undefined): YagniConfidence | undefined {
  if (raw === 'low' || raw === 'medium' || raw === 'high') return raw;
  return undefined;
}

function normalizeRepeatable(raw: string | string[] | undefined): readonly string[] {
  if (raw === undefined) return [];
  return Array.isArray(raw) ? raw : [raw];
}

function renderGateCompareLines(result: {
  readonly degraded: boolean;
  readonly added: readonly unknown[];
  readonly resolved: readonly unknown[];
}): string[] {
  return result.degraded
    ? [`YAGNI gate FAILED: ${String(result.added.length)} new finding(s) since baseline.`]
    : [
        `YAGNI gate PASS: no regressions (${String(result.resolved.length)} resolved since baseline).`,
      ];
}

export async function runYagniGateMode(
  opts: YagniGateCommandOptions,
  cli: ToolCliContext,
): Promise<ToolRunCompletion | undefined> {
  if (opts.gateSave === true && opts.gateCompare === true) {
    await cli.reportFailure({
      message: 'Error: --gate-save and --gate-compare are mutually exclusive.',
      exitCode: EXIT_CODES.CONFIGURATION_ERROR,
      jsonRequested: opts.json === true,
    });
    return undefined;
  }

  const config = loadYagniConfig(opts.cwd);
  const outcome = await executeYagni(
    {
      cwd: opts.cwd,
      config,
      minConfidence: parseMinConfidence(opts.minConfidence),
      detectors: normalizeRepeatable(opts.detector),
      categories: normalizeRepeatable(opts.category),
      includeTests: opts.includeTests ?? config.includeTests,
    },
    cli,
  );

  const deliverOpts = {
    cwd: opts.cwd,
    reportTo: opts.reportTo,
    apiKey: opts.apiKey,
  };

  await runHostGateDispatch({
    cli,
    tool: 'yagni',
    envelope: outcome.envelope,
    mode: opts.gateSave === true ? 'save' : 'compare',
    deliver: deliverOpts,
    sarifPath: opts.sarif,
    saveRunFailed: ({ envelope }) => !envelope.verdict.passed,
    renderSaveLines: ({ envelope, runFailed }) =>
      runFailed
        ? [
            `YAGNI baseline saved (${String(envelope.signals.length)} signal(s))`,
            'YAGNI gate FAILED: findings policy not satisfied.',
          ]
        : [`YAGNI baseline saved (${String(envelope.signals.length)} signal(s))`],
    renderCompareLines: ({ result }) => renderGateCompareLines(result),
  });
  return { session: outcome.session };
}
