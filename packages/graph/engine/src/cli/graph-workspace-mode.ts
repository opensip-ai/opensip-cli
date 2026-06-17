import { EXIT_CODES } from '@opensip-cli/contracts';
import {
  ConfigurationError,
  logger,
  type Signal,
  type ToolCliContext,
  type ToolSessionContribution,
} from '@opensip-cli/core';

import { buildWorkspaceSessionContribution } from './graph-session-contribution.js';
import {
  type GraphProfileBuilder,
  type GraphProfileRunRecorder,
  type GraphProfileRunSummary,
} from './profile.js';
import { resolveAdaptersForRun } from './resolve-adapters.js';
import { buildWorkspaceJsonDocument, writeWorkspaceReport } from './workspace-report.js';
import { discoverPolyglotUnits, runWorkspaceUnitsInParallel } from './workspace-runner.js';

import type { GraphCommandOptions } from './graph-options.js';
import type { GraphRunOutcome } from './graph-run-outcome.js';

const EVT_GRAPH_COMPLETE = 'graph.cli.graph.complete';
const MODULE_GRAPH_CLI = 'graph:cli';

function setProfileStageRecorded(
  profileRun: GraphProfileRunRecorder | undefined,
  durationMs: number,
  unitCount: number,
): void {
  if (profileRun !== undefined) {
    profileRun.recordStage('workspace-fanout', durationMs, `${String(unitCount)} unit(s)`);
  }
}

function setProfileSummaryFinished(
  profileRun: GraphProfileRunRecorder | undefined,
  summary: GraphProfileRunSummary,
): void {
  if (profileRun !== undefined) {
    profileRun.finishSummary(summary);
  }
}

/**
 * `graph --workspace` fan-out. The parent aggregates per-unit child runs for
 * reporting and a single dashboard session, but intentionally does not emit a
 * cloud signal envelope for the aggregate.
 */
export async function executeWorkspaceGraph(
  opts: GraphCommandOptions,
  cli: ToolCliContext,
  profile?: GraphProfileBuilder,
): Promise<GraphRunOutcome | undefined> {
  const cliScript = opts.cliScript ?? process.argv[1];
  if (typeof cliScript !== 'string' || cliScript.length === 0) {
    throw new ConfigurationError(
      '--workspace: could not determine the CLI entry script (process.argv[1] is empty).',
    );
  }
  const adapters = resolveAdaptersForRun(opts, cli);
  const units = await discoverPolyglotUnits(opts.cwd, adapters);
  if (units.length === 0) {
    const adapterLabel = adapters.map((a) => a.id).join(', ') || '(no language adapters available)';
    throw new ConfigurationError(
      `--workspace: no workspace units detected for [${adapterLabel}]. Use 'opensip graph' for whole-project analysis.`,
    );
  }

  const profileRun = profile?.startRun({
    label: 'workspace',
    cwd: opts.cwd,
    mode: 'workspace',
  });
  // Internal per-run timer for the workspace report artifact. The generic
  // session row's timing remains host-owned.
  const startedAt = Date.now();
  const result = await runWorkspaceUnitsInParallel({
    cwd: opts.cwd,
    units,
    cliScript,
    concurrency: opts.concurrency,
    noCache: opts.noCache,
    resolution: opts.resolution,
    recipe: opts.recipe,
    ...(opts.language === undefined ? {} : { language: opts.language }),
  });
  const durationMs = Date.now() - startedAt;
  setProfileStageRecorded(profileRun, durationMs, units.length);

  const allSignals: Signal[] = [];
  for (const r of result.perUnit) allSignals.push(...r.signals);
  setProfileSummaryFinished(profileRun, {
    cacheHit: false,
    signals: allSignals.length,
  });

  let session: ToolSessionContribution | undefined;
  if (opts.json === true) {
    cli.emitJson(buildWorkspaceJsonDocument(result.perUnit, durationMs));
  } else {
    await writeWorkspaceReport(result.perUnit, durationMs, cli);
    session = buildWorkspaceSessionContribution(opts, allSignals);
  }

  if (result.anyChildFailed) {
    cli.setExitCode(EXIT_CODES.RUNTIME_ERROR);
    process.stderr.write(
      `graph --workspace: at least one unit run failed; see per-unit output above.\n`,
    );
  } else {
    cli.setExitCode(EXIT_CODES.SUCCESS);
  }
  logger.info({
    evt: EVT_GRAPH_COMPLETE,
    module: MODULE_GRAPH_CLI,
    units: result.perUnit.length,
    findings: allSignals.length,
    failed: result.anyChildFailed,
    durationMs,
  });

  return session === undefined ? undefined : { session };
}
