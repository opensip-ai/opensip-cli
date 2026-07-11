import {
  agentRunFlagSpecs,
  defineAnalysisRunCommand,
  gateRunFlagSpecs,
  sarifRunFlagSpec,
} from '@opensip-cli/contracts';

import { YAGNI_LIVE_VIEW_KEY } from '../identity.js';
import { applyAdvisoryExitCode } from '../lib/apply-advisory-exit.js';
import { resolveYagniPositionalPaths } from '../lib/resolve-positional-paths.js';

import { executeYagni } from './execute-yagni.js';
import { readYagniConfig } from './yagni-config.js';
import { buildYagniRunPresentation } from './yagni-presentation.js';

import type { YagniLiveArgs } from './yagni-runner.js';
import type { YagniConfig } from '../types/yagni-config.js';
import type { YagniConfidence } from '../types/yagni-metadata.js';
import type { AnalysisRunCommandOptions } from '@opensip-cli/contracts';
import type { ToolCliContext } from '@opensip-cli/core';

export interface YagniCommandOptions extends AnalysisRunCommandOptions {
  readonly quiet?: boolean;
  readonly verbose?: boolean;
  readonly minConfidence?: string;
  readonly detector?: string | string[];
  readonly category?: string | string[];
  readonly includeTests?: boolean;
  readonly _args?: readonly unknown[];
}

interface YagniAnalysisRequest {
  readonly cwd: string;
  readonly config: YagniConfig;
  readonly minConfidence?: YagniConfidence;
  readonly detectors: readonly string[];
  readonly categories: readonly string[];
  readonly includeTests: boolean;
  readonly pathRoots?: readonly string[];
}

function parseMinConfidence(raw: string | undefined): YagniConfidence | undefined {
  if (raw === 'low' || raw === 'medium' || raw === 'high') return raw;
  return undefined;
}

function normalizeRepeatable(raw: string | string[] | undefined): readonly string[] {
  if (raw === undefined) return [];
  return Array.isArray(raw) ? raw : [raw];
}

function positionalPathRoots(opts: YagniCommandOptions): readonly string[] | undefined {
  const positionals = opts._args ?? [];
  const paths = (positionals[0] ?? []) as readonly string[];
  return paths.length > 0 ? resolveYagniPositionalPaths(paths, opts.cwd) : undefined;
}

function normalizeYagniRequest(
  opts: YagniCommandOptions,
  cli: ToolCliContext,
): YagniAnalysisRequest {
  const config = readYagniConfig(cli);
  return {
    cwd: opts.cwd,
    config,
    minConfidence: parseMinConfidence(opts.minConfidence),
    detectors: normalizeRepeatable(opts.detector),
    categories: normalizeRepeatable(opts.category),
    includeTests: opts.includeTests ?? config.includeTests ?? false,
    pathRoots: positionalPathRoots(opts),
  };
}

function buildYagniLiveArgs(
  request: YagniAnalysisRequest,
  opts: YagniCommandOptions,
): YagniLiveArgs {
  return {
    cwd: request.cwd,
    verbose: opts.verbose === true,
    quiet: opts.quiet === true,
    minConfidence: request.minConfidence,
    detectors: request.detectors,
    categories: request.categories,
    includeTests: request.includeTests,
    pathRoots: request.pathRoots,
  };
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

export function buildYagniAnalysisRunCommand(setUpLiveView: (cli: ToolCliContext) => void) {
  return defineAnalysisRunCommand<
    YagniCommandOptions,
    YagniAnalysisRequest,
    Awaited<ReturnType<typeof executeYagni>>
  >({
    description: 'Run YAGNI reduction audit detectors',
    options: [
      ...gateRunFlagSpecs,
      sarifRunFlagSpec,
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
      ...agentRunFlagSpecs,
    ],
    args: [
      {
        name: 'paths',
        description: 'Limit analysis to one or more directory subtrees',
        variadic: true,
        optional: true,
      },
    ],
    normalize: normalizeYagniRequest,
    execute: (request) =>
      executeYagni({
        cwd: request.cwd,
        config: request.config,
        minConfidence: request.minConfidence,
        detectors: request.detectors,
        categories: request.categories,
        includeTests: request.includeTests,
        pathRoots: request.pathRoots,
      }),
    envelope: (result) => result.envelope,
    session: (result) => result.session,
    presentation: ({ options, request, result, envelope, durationMs }) =>
      buildYagniRunPresentation({
        envelope,
        cwd: request.cwd,
        skippedDetectors: result.session.payload.summary.skippedDetectors,
        verbose: options.verbose === true,
        durationMs,
      }),
    live: {
      key: YAGNI_LIVE_VIEW_KEY,
      setUp: setUpLiveView,
      shouldUse: ({ options, request }) =>
        options.json !== true && process.stdout.isTTY === true && request.pathRoots === undefined,
      args: ({ options, request }) => buildYagniLiveArgs(request, options),
    },
    gate: {
      tool: 'yagni',
      mode: ({ options }) => {
        if (options.gateSave === true) return 'save';
        if (options.gateCompare === true) return 'compare';
      },
      saveRunFailed: ({ envelope }) => !envelope.verdict.passed,
      renderSaveLines: ({ envelope, runFailed }) =>
        runFailed
          ? [
              `YAGNI baseline saved (${String(envelope.signals.length)} signal(s))`,
              'YAGNI gate FAILED: findings policy not satisfied.',
            ]
          : [`YAGNI baseline saved (${String(envelope.signals.length)} signal(s))`],
      renderCompareLines: ({ result }) => renderGateCompareLines(result),
    },
    afterDelivery: ({ cli, options, request }) => {
      // Advisory re-affirmation exists ONLY to undo an exit code a nested graph
      // evidence build may have raised on the json/human path. On the gate path
      // the host owns the exit (ADR-0035): `--gate-save`/`--gate-compare` derive
      // RUNTIME_ERROR from the baseline verdict / `failOnDegraded`, and resetting
      // it to SUCCESS here would silently green a failed ratchet gate. Skip it.
      if (options.gateSave === true || options.gateCompare === true) return;
      applyAdvisoryExitCode(cli, request.config);
    },
  });
}
