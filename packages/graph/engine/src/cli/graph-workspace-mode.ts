import { EXIT_CODES } from '@opensip-cli/contracts';
import {
  createToolLogger,
  ConfigurationError,
  type Signal,
  type ToolCliContext,
  type ToolSessionContribution,
} from '@opensip-cli/core';

import { graphCompletionLogFields } from './graph-run-outcome.js';
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

const log = createToolLogger('graph:cli');

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
  // Commander preserves the literal explicit `--cwd` value, which may be
  // relative. Bootstrap's ProjectContext is the one canonical absolute
  // selection shared with the parent runtime lease; children must receive that
  // exact value both as process cwd and `--cwd` or `project/project` drift can
  // select a different coordination key.
  const effectiveCwd = cli.scope.projectContext?.cwd ?? opts.cwd;
  const effectiveOpts = effectiveCwd === opts.cwd ? opts : { ...opts, cwd: effectiveCwd };
  const cliScript = opts.cliScript ?? process.argv[1];
  if (typeof cliScript !== 'string' || cliScript.length === 0) {
    throw new ConfigurationError(
      '--workspace: could not determine the CLI entry script (process.argv[1] is empty).',
    );
  }
  const adapters = resolveAdaptersForRun(effectiveOpts, cli);
  const units = await discoverPolyglotUnits(effectiveCwd, adapters);
  if (units.length === 0) {
    const adapterLabel = adapters.map((a) => a.id).join(', ') || '(no language adapters available)';
    throw new ConfigurationError(
      `--workspace: no workspace units detected for [${adapterLabel}]. Use 'opensip graph' for whole-project analysis.`,
    );
  }

  const profileRun = profile?.startRun({
    label: 'workspace',
    cwd: effectiveCwd,
    mode: 'workspace',
  });
  // Internal per-run timer for the workspace report artifact. The generic
  // session row's timing remains host-owned.
  const startedAt = Date.now();
  const result = await runWorkspaceUnitsInParallel({
    cwd: effectiveCwd,
    ...(cli.scope.projectContext?.configPath === undefined
      ? {}
      : { configPath: cli.scope.projectContext.configPath }),
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
  // @sequential-ok — a synchronous signal flatten (no await in the loop body);
  // the heuristic's forward scan bleeds into the later `await writeWorkspaceReport`.
  // Actual unit parallelism is bounded by `concurrency` in runWorkspaceUnitsInParallel.
  for (const r of result.perUnit) allSignals.push(...r.signals);
  setProfileSummaryFinished(profileRun, {
    cacheHit: false,
    signals: allSignals.length,
  });

  if (opts.json === true) {
    cli.emitJson(buildWorkspaceJsonDocument(result.perUnit, durationMs));
  } else {
    await writeWorkspaceReport(result.perUnit, durationMs, cli);
  }
  const session: ToolSessionContribution = buildWorkspaceSessionContribution(
    effectiveOpts,
    allSignals,
    result.anyChildFailed,
  );

  if (result.anyChildFailed) {
    cli.setExitCode(EXIT_CODES.RUNTIME_ERROR);
    process.stderr.write(
      `graph --workspace: at least one unit run failed; see per-unit output above.\n`,
    );
  } else {
    cli.setExitCode(EXIT_CODES.SUCCESS);
  }
  log.info({
    evt: EVT_GRAPH_COMPLETE,
    module: MODULE_GRAPH_CLI,
    units: result.perUnit.length,
    findings: allSignals.length,
    failed: result.anyChildFailed,
    durationMs,
    ...graphCompletionLogFields({
      kind: 'workspace-parent',
      deliveryMode: 'workspace-parent',
    }),
  });

  return { kind: 'workspace-parent', session };
}
