/**
 * yagni-command-spec — declarative primary `yagni` command.
 *
 * `output: 'raw-stream'` because the handler owns JSON vs stub human render,
 * cloud egress, and the advisory exit posture (failOnErrors/Warnings: 0).
 */

import { defineCommand } from '@opensip-cli/core';

import { loadYagniConfig } from './yagni-config.js';
import { executeYagni } from './execute-yagni.js';

import type { YagniGraphMode } from '../types/yagni-config.js';
import type { CommandSpec, ToolCliContext, ToolRunCompletion } from '@opensip-cli/core';

interface YagniCommandOptions {
  cwd: string;
  json?: boolean;
  quiet?: boolean;
  verbose?: boolean;
  reportTo?: string;
  apiKey?: string;
  graph?: string;
}

async function runYagniCommand(
  rawOpts: unknown,
  cli: ToolCliContext,
): Promise<ToolRunCompletion> {
  const opts = rawOpts as YagniCommandOptions;
  const config = loadYagniConfig(opts.cwd);
  const graphMode = parseGraphMode(opts.graph) ?? config.graphMode ?? 'auto';

  const outcome = await executeYagni({ cwd: opts.cwd, config, graphMode }, cli);

  if (opts.json === true) {
    cli.emitEnvelope(outcome.envelope);
  } else {
    await cli.render({
      type: 'yagni-report',
      headline: 'YAGNI Reduction Audit',
      passed: outcome.envelope.verdict.passed,
      summary: outcome.envelope.verdict.summary,
      units: outcome.envelope.units,
      signalCount: outcome.envelope.signals.length,
      skippedDetectors: outcome.session.payload.summary.skippedDetectors,
    });
  }

  await cli.deliverSignals(outcome.envelope, {
    cwd: opts.cwd,
    reportTo: opts.reportTo,
    apiKey: opts.apiKey,
  });

  return { session: outcome.session };
}

function parseGraphMode(raw: string | undefined): YagniGraphMode | undefined {
  if (raw === 'auto' || raw === 'reuse' || raw === 'build' || raw === 'off') return raw;
  return undefined;
}

export const yagniCommandSpec: CommandSpec<unknown, ToolCliContext> = defineCommand<
  unknown,
  ToolCliContext
>({
  name: 'yagni',
  description: 'Run YAGNI reduction audit detectors (advisory; exit 0 by default)',
  commonFlags: ['cwd', 'json', 'quiet', 'verbose', 'debug', 'reportTo', 'apiKey'],
  options: [
    {
      flag: '--graph',
      value: '<mode>',
      description: 'Graph evidence mode: auto (reuse or build), reuse, build, or off',
      default: 'auto',
      choices: ['auto', 'reuse', 'build', 'off'],
    },
  ],
  scope: 'project',
  output: 'raw-stream',
  rawStreamReason: 'runtime-render-dispatch',
  handler: runYagniCommand,
});