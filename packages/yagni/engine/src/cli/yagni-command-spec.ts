/**
 * yagni-command-spec — declarative primary `yagni` command.
 */

import { definePrimaryCommand } from '@opensip-cli/core';

import { YAGNI_LIVE_VIEW_KEY } from '../identity.js';
import { applyAdvisoryExitCode } from '../lib/apply-advisory-exit.js';
import { resolveYagniPositionalPaths } from '../lib/resolve-positional-paths.js';

import { executeYagni } from './execute-yagni.js';
import { loadYagniConfig } from './yagni-config.js';
import { buildYagniRunPresentation } from './yagni-presentation.js';

import type { YagniLiveArgs } from './yagni-runner.js';
import type { YagniConfidence } from '../types/yagni-metadata.js';
import type { SignalEnvelope } from '@opensip-cli/contracts';
import type { ToolCliContext, ToolRunCompletion } from '@opensip-cli/core';

interface YagniCommandOptions {
  cwd: string;
  json?: boolean;
  quiet?: boolean;
  verbose?: boolean;
  reportTo?: string;
  apiKey?: string;
  open?: boolean;
  minConfidence?: string;
  detector?: string | string[];
  category?: string | string[];
  includeTests?: boolean;
}

function parseMinConfidence(raw: string | undefined): YagniConfidence | undefined {
  if (raw === 'low' || raw === 'medium' || raw === 'high') return raw;
  return undefined;
}

function normalizeRepeatable(raw: string | string[] | undefined): readonly string[] {
  if (raw === undefined) return [];
  return Array.isArray(raw) ? raw : [raw];
}

function buildYagniLiveArgs(
  opts: YagniCommandOptions,
  pathRoots: readonly string[] | undefined,
): YagniLiveArgs {
  return {
    cwd: opts.cwd,
    verbose: opts.verbose === true,
    quiet: opts.quiet === true,
    minConfidence: parseMinConfidence(opts.minConfidence),
    detectors: normalizeRepeatable(opts.detector),
    categories: normalizeRepeatable(opts.category),
    includeTests: opts.includeTests,
    pathRoots,
  };
}

async function deliverYagniRun(
  opts: YagniCommandOptions,
  cli: ToolCliContext,
  config: ReturnType<typeof loadYagniConfig>,
  outcome: Pick<Awaited<ReturnType<typeof executeYagni>>, 'envelope'>,
): Promise<void> {
  await cli.deliverSignals(outcome.envelope, {
    cwd: opts.cwd,
    reportTo: opts.reportTo,
    apiKey: opts.apiKey,
  });

  await cli.maybeOpenReport({
    openRequested: opts.open === true,
    jsonOutput: opts.json === true,
  });

  // Re-affirm after delivery (--report-to may set exit 4; advisory policy wins otherwise).
  applyAdvisoryExitCode(cli, config);
}

async function runYagniCommand(
  rawOpts: unknown,
  cli: ToolCliContext,
  setUpLiveView: (cli: ToolCliContext) => void,
): Promise<ToolRunCompletion> {
  const opts = rawOpts as YagniCommandOptions;
  const config = loadYagniConfig(opts.cwd);
  const positionals = (opts as unknown as { _args?: readonly unknown[] })._args ?? [];
  const paths = (positionals[0] ?? []) as readonly string[];
  const pathRoots = paths.length > 0 ? resolveYagniPositionalPaths(paths, opts.cwd) : undefined;
  const useLiveView =
    opts.json !== true && process.stdout.isTTY === true && pathRoots === undefined;

  if (useLiveView) {
    setUpLiveView(cli);
    const completion = await cli.renderLive(
      YAGNI_LIVE_VIEW_KEY,
      buildYagniLiveArgs(opts, pathRoots),
    );
    const envelope = completion?.envelope as SignalEnvelope | undefined;
    if (envelope !== undefined) {
      await deliverYagniRun(opts, cli, config, { envelope });
    }
    return completion ?? {};
  }

  const startedAt = Date.now();
  const outcome = await executeYagni(
    {
      cwd: opts.cwd,
      config,
      minConfidence: parseMinConfidence(opts.minConfidence),
      detectors: normalizeRepeatable(opts.detector),
      categories: normalizeRepeatable(opts.category),
      includeTests: opts.includeTests ?? config.includeTests,
      pathRoots,
    },
    cli,
  );

  // Re-affirm advisory exit policy before the host wraps the envelope
  // (emitEnvelope snapshots getExitCode at write time; --report-to may set exit 4).
  applyAdvisoryExitCode(cli, config);

  if (opts.json === true) {
    cli.emitEnvelope(outcome.envelope);
  } else {
    const durationMs = Math.max(0, Date.now() - startedAt);
    const presentation = buildYagniRunPresentation({
      envelope: outcome.envelope,
      cwd: opts.cwd,
      skippedDetectors: outcome.session.payload.summary.skippedDetectors,
      verbose: opts.verbose === true,
      durationMs,
    });
    await cli.render(presentation);
  }

  await deliverYagniRun(opts, cli, config, outcome);

  return { session: outcome.session };
}

export function buildYagniCommandSpec(setUpLiveView: (cli: ToolCliContext) => void) {
  return definePrimaryCommand<unknown, ToolCliContext>({
    description: 'Run YAGNI reduction audit detectors (advisory; exit 0 by default)',
    commonFlags: ['cwd', 'json', 'quiet', 'verbose', 'debug', 'reportTo', 'apiKey', 'open'],
    options: [
      {
        flag: '--min-confidence',
        value: '<level>',
        description: 'Minimum confidence level: low, medium, or high',
        choices: ['low', 'medium', 'high'],
      },
      {
        flag: '--detector',
        value: '<slug>',
        description: 'Run only the named detector (repeatable)',
        arrayDefault: [],
        parse: (val, prev) => [...(prev as string[]), val],
      },
      {
        flag: '--category',
        value: '<name>',
        description: 'Filter findings by reduction category (repeatable)',
        arrayDefault: [],
        parse: (val, prev) => [...(prev as string[]), val],
      },
      {
        flag: '--include-tests',
        description: 'Include test and fixture code in analysis',
        default: false,
      },
    ],
    args: [
      {
        name: 'paths',
        description: 'Limit analysis to one or more directory subtrees',
        variadic: true,
        optional: true,
      },
    ],
    scope: 'project',
    output: 'raw-stream',
    rawStreamReason: 'runtime-render-dispatch',
    handler: (rawOpts, cli) => runYagniCommand(rawOpts, cli, setUpLiveView),
  });
}
