// @fitness-ignore-file module-coupling-fan-out -- composition root: the main graph command handler wires detection, orchestration, reporting, workspace, persistence, and recipe resolution; high intra-project fan-out is inherent to a CLI entry point (cf. the index.ts / code-paths.ts barrels that suppress the same check).

// @fitness-ignore-file no-markdown-references -- docs/plans/* pointers in JSDoc are stable internal references.
/**
 * `opensip graph` — main subcommand handler.
 *
 * Runs the full pipeline and prints a comprehensive report covering
 * rules, entry points, and catalog summary in one invocation. Per
 * DEC-8, a switch in this handler dispatches to the right renderer.
 *
 * CLI shape (language-neutral):
 *   - `graph` — whole project, auto-detected language(s)
 *   - `graph <path> [<path>...]` — scope to one or more subtrees
 *   - `graph --workspace` — fan out across detected workspace units
 *     (polyglot: aggregates every adapter's units per spec D8b)
 *   - `graph --language <name>` — force a single adapter
 *
 * History: v0.2 originally split this into three subcommands (`graph`,
 * `graph-orphans`, `graph-entry-points`). The two filtered views are
 * now sections in this unified report. The TS-flavored `--package` /
 * `--packages` flags were retired in favor of the polyglot surface
 * above; see docs/plans/graph-cli-language-neutral-scoping/.
 */

import { EXIT_CODES } from '@opensip-cli/contracts';
import {
  ConfigurationError,
  currentScope,
  logger,
  ToolError,
  ValidationError,
} from '@opensip-cli/core';

import { resolveRecipeToRules } from '../recipes/resolve.js';

import { planGraphExecution } from './graph-command-plan.js';
import { executeMultiPathGraph } from './graph-multi-path-mode.js';
import {
  createProfileBuilder,
  deliverGraphResult,
  dispatchGraphResult,
  writeProfileIfRequested,
} from './graph-result-delivery.js';
import { executeSinglePathGraph } from './graph-single-run-mode.js';
import { executeWorkspaceGraph } from './graph-workspace-mode.js';
import { resolveGraphRecipeSelection } from './orchestrate.js';
import { MemoryPressureError } from './pressure-monitor.js';

import type { GraphCommandOptions } from './graph-options.js';
import type { GraphRunOutcome } from './graph-run-outcome.js';
import type { ToolCliContext } from '@opensip-cli/core';

// Re-exports kept so the package barrel + cli/graph-runner.tsx + tests
// keep using `cli/graph.js` as a single import site for these shapes.
export type { GraphCommandOptions } from './graph-options.js';

export type { UnifiedReportInput, LiveGraphOutput } from './graph-report.js';

export { dispatchGraphResult } from './graph-result-delivery.js';

const MODULE_GRAPH_CLI = 'graph:cli';

/**
 * Run graph and return the run's {@link GraphRunOutcome} — the deliverable
 * {@link SignalEnvelope} (so the composition root can cloud + `--report-to`
 * deliver it, ADR-0011) plus the optional generic-session contribution the
 * host run plane persists (host-owned-run-timing Phase 3; graph never writes
 * the row itself). Returns `undefined` for the paths that do NOT produce a
 * deliverable envelope: plain `--json` (the `--workspace` child carrier —
 * children must not each emit cloud signals) and `--workspace` itself (the
 * parent aggregates per-unit findings for the dashboard, not signals for the
 * cloud — audit P1-2), and any error path. The `--workspace` path returns its
 * outcome through `executeWorkspaceGraph` so the host persists the single
 * aggregate session. tool.ts calls `cli.deliverSignals` only when an envelope
 * comes back.
 */
export async function executeGraph(
  opts: GraphCommandOptions,
  cli: ToolCliContext,
): Promise<GraphRunOutcome | undefined> {
  // Hoisted dummies for any remaining internal startedAt refs in non-session
  // profile/display code paths inside this file (the session ones were switched
  // to host record). Visible to all branches despite early returns.
  const startedAtForProfile = new Date().toISOString();
  const startedAt: string = startedAtForProfile;
  const profile = createProfileBuilder(opts, startedAtForProfile);

  logger.info({
    evt: 'graph.cli.graph.start',
    module: MODULE_GRAPH_CLI,
    cwd: opts.cwd,
    // Observability: which build engine the user requested. Sharded is the
    // default (ADR-0032), so a bare run requests `sharded`; `--exact` opts back
    // to the single-program engine. The RESOLVED engine (after shardability) is
    // logged at `graph.cli.graph.engine`.
    requestedEngine: opts.exact === true ? 'exact' : 'sharded',
  });
  // Run-level lifecycle event on the per-run DiagnosticsBus (north-star §5.10).
  // The host emits COMMAND-level lifecycle (mount-command-spec / pre-action
  // hook); only the engine knows its INTERNAL lifecycle (requested engine,
  // resolved mode, shard fan-out), so the graph run contributes a `start` here —
  // before any branch, so workspace / multi-path / single-path runs all surface
  // it — and a `complete` once the build returns. Rides on every `--json`
  // CommandOutcome via `scope.diagnostics.snapshot()`. Engine/library code emits
  // through the ambient `currentScope()?.diagnostics` accessor (the documented
  // idiom; `cli.scope`/ToolScope deliberately omits the bus — see
  // diagnostics-bus.ts header).
  currentScope()?.diagnostics?.event('execute', 'debug', 'graph build started', {
    requestedEngine: opts.exact === true ? 'exact' : 'sharded',
  });
  // (profile / startedAtForProfile already declared at top of fn for branch visibility)
  try {
    const plan = planGraphExecution(opts);
    // Resolve the recipe once at the top of the run (CLI layer owns selection;
    // the engine stays recipe-agnostic). Tool-scoped (ADR-0022): precedence is
    // `--recipe` flag > `graph.recipe` > `default`.
    // Threaded into every build path as `RunGraphInput.rules`. An explicit
    // unknown name throws a ConfigurationError here (caught by handleGraphError);
    // a config-sourced unknown name falls back to `default` with a warning. For
    // the `--workspace` path the parent resolves only to validate the name
    // (fail-fast); children re-resolve in their own scope.
    const recipeSelection = resolveGraphRecipeSelection(opts.cwd, opts.recipe);
    const rules = resolveRecipeToRules(recipeSelection.name, {
      tolerant: recipeSelection.tolerant,
    });
    // Normalize opts.recipe to the RESOLVED name so the envelope/run-header,
    // dashboard sessions, and any `--workspace` children report what actually
    // ran. Pre-ADR-0022 the generic `mergeConfigDefaults` set opts.recipe from
    // config; that responsibility now lives here, tool-scoped — opts is the
    // request-scoped parsed-options bag the pre-action hook already augments, so
    // this is the single point that owns graph's recipe normalization.
    (opts as { recipe?: string }).recipe = recipeSelection.name;
    if (plan.shape === 'workspace') {
      const outcome = await executeWorkspaceGraph(opts, cli, profile);
      writeProfileIfRequested(opts, profile);
      return outcome;
    }
    if (plan.shape === 'multi-path') {
      const outcome = await executeMultiPathGraph(
        { opts, cli, rules, startedAt, profile, deliverGraphResult },
        plan.positionalPaths,
      );
      writeProfileIfRequested(opts, profile);
      return outcome;
    }
    const outcome = await executeSinglePathGraph(
      { opts, cli, rules, startedAt, profile, dispatchGraphResult },
      plan.positionalPaths,
    );
    writeProfileIfRequested(opts, profile);
    return outcome;
  } catch (error) {
    handleGraphError('graph', error, cli);
    return undefined;
  }
}

/** Map graph CLI errors to exit codes and emit a stderr message. */
export function handleGraphError(label: string, error: unknown, cli: ToolCliContext): void {
  logger.error({
    evt: `graph.cli.${label}.error`,
    module: MODULE_GRAPH_CLI,
    err: error instanceof Error ? error.message : String(error),
  });
  if (error instanceof ConfigurationError) {
    cli.setExitCode(EXIT_CODES.CONFIGURATION_ERROR);
  } else {
    /* v8 ignore start */
    if (error instanceof ValidationError) {
      cli.setExitCode(EXIT_CODES.CONFIGURATION_ERROR);
    } else if (error instanceof MemoryPressureError) {
      cli.setExitCode(EXIT_CODES.RUNTIME_ERROR);
    } else if (error instanceof ToolError) {
      cli.setExitCode(EXIT_CODES.RUNTIME_ERROR);
    } else {
      cli.setExitCode(EXIT_CODES.RUNTIME_ERROR);
    }
    /* v8 ignore stop */
  }
  process.stderr.write(`${label}: ${error instanceof Error ? error.message : String(error)}\n`);
}

export { contributionFromSignals, evaluatedRuleSlugs } from './graph-session-contribution.js';
export {
  resolveLiveEngineShards,
  resolveShardsForCwd,
  runShardedLiveBuild,
} from './graph-sharded-engine.js';
export type { GraphLiveBuildArgs } from './graph-sharded-engine.js';
export { buildUnifiedReportLines, buildLiveGraphOutput } from './graph-report.js';
