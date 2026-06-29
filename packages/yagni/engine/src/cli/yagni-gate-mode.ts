/**
 * Gate mode for `opensip yagni` (`--gate-save` / `--gate-compare`).
 *
 * Host-owned baseline persistence and exit (ADR-0036 / ADR-0035): yagni hands
 * the fingerprint-stamped envelope to the baseline seams and feeds the findings
 * verdict to `deliverSignals` runFailed — no tool-side `setExitCode`.
 */

import { EXIT_CODES } from '@opensip-cli/contracts';
import {
  resolveFailOnDegraded,
  type ToolCliContext,
  type ToolRunCompletion,
} from '@opensip-cli/core';

import { executeYagni } from './execute-yagni.js';
import { loadYagniConfig } from './yagni-config.js';

import type { YagniConfidence } from '../types/yagni-metadata.js';
import type { SignalEnvelope } from '@opensip-cli/contracts';

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

/**
 * Finalize a gate run: deliver the signal envelope and (when `--sarif` is set)
 * write the SARIF report. The two are independent I/O — signal egress vs. a
 * local file write, both read-only over the same envelope — so they run
 * concurrently. Shared by the gate-save and gate-compare tails (identical
 * finalize sequence; the only difference is how `runFailed` is derived).
 */
async function deliverAndExport(
  cli: ToolCliContext,
  envelope: SignalEnvelope,
  runFailed: boolean,
  deliverOpts: { readonly cwd: string; readonly reportTo?: string; readonly apiKey?: string },
  sarifPath: string | undefined,
): Promise<void> {
  const tasks: Promise<unknown>[] = [cli.deliverSignals(envelope, { ...deliverOpts, runFailed })];
  if (sarifPath !== undefined && sarifPath !== '') {
    tasks.push(cli.writeSarif(envelope, sarifPath));
  }
  await Promise.all(tasks);
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

  if (opts.gateSave === true) {
    await cli.saveBaseline('yagni', outcome.envelope);
    const runFailed = !outcome.envelope.verdict.passed;
    await cli.render({
      type: 'gate-done',
      lines: runFailed
        ? [
            `YAGNI baseline saved (${String(outcome.envelope.signals.length)} signal(s))`,
            'YAGNI gate FAILED: findings policy not satisfied.',
          ]
        : [`YAGNI baseline saved (${String(outcome.envelope.signals.length)} signal(s))`],
    });
    await deliverAndExport(cli, outcome.envelope, runFailed, deliverOpts, opts.sarif);
    return { session: outcome.session };
  }

  const result = await cli.compareBaseline('yagni', outcome.envelope);
  const runFailed = result.degraded && resolveFailOnDegraded('yagni');
  await cli.render({
    type: 'gate-done',
    lines: renderGateCompareLines(result),
  });
  await deliverAndExport(cli, outcome.envelope, runFailed, deliverOpts, opts.sarif);
  return { session: outcome.session };
}
