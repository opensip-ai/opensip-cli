// @fitness-ignore-file error-handling-quality -- CLI output baseline-write at line 396 is best-effort by design ("don't fail the run"); the comment + v8-ignore at the catch already document that user-visible behavior is unaffected if the persistence layer hiccups.
// @fitness-ignore-file detached-promises -- CLI renderers (process.stdout.write, render helpers, log lines, setExitCode) are synchronous; heuristic flags inside async handlers.
// @fitness-ignore-file module-coupling-fan-out -- composition root: the main graph command handler wires detection, orchestration, reporting, workspace, persistence, and recipe resolution; high intra-project fan-out is inherent to a CLI entry point (cf. the index.ts / code-paths.ts barrels that suppress the same check).
// @fitness-ignore-file performance-anti-patterns -- spread in CLI report aggregation iterates bounded result sets (rule counts, entry-point lists).
// @fitness-ignore-file no-markdown-references -- docs/plans/* pointers in JSDoc are stable internal references.
// @fitness-ignore-file public-api-jsdoc -- GraphCommandOptions interface and executeGraph are already documented with rich JSDoc on each field; the check counts the top-level export line, not the fields.
// @fitness-ignore-file file-length-limit -- remaining top-level graph command handler still coordinates mode dispatch, output delivery, single-run engine selection, and CLI error mapping; large workspace/multi-path modes and sharded engine/session helpers are split out.
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

import { finalizeGraphSignals, type FinalizedSignals } from './apply-suppressions.js';
import { buildGraphEnvelope } from './build-envelope.js';
import { planGraphExecution } from './graph-command-plan.js';
import { runCatalogJsonMode, runGateMode } from './graph-modes.js';
import { executeMultiPathGraph } from './graph-multi-path-mode.js';
import { buildUnifiedReportLines, resolutionBannerText } from './graph-report.js';
import { buildGraphSessionContribution } from './graph-session-contribution.js';
import { executeSinglePathGraph } from './graph-single-run-mode.js';
import { executeWorkspaceGraph } from './graph-workspace-mode.js';
import { resolveGraphRecipeSelection, type RunGraphResult } from './orchestrate.js';
import { MemoryPressureError } from './pressure-monitor.js';
import { GraphProfileBuilder, writeGraphProfile } from './profile.js';

import type { GraphCommandOptions } from './graph-options.js';
import type { GraphRunOutcome } from './graph-run-outcome.js';
import type { RunPresentation, SignalEnvelope, VerboseDetail } from '@opensip-cli/contracts';
import type { ToolCliContext } from '@opensip-cli/core';

// Re-exports kept so the package barrel + cli/graph-runner.tsx + tests
// keep using `cli/graph.js` as a single import site for these shapes.
export type { GraphCommandOptions } from './graph-options.js';

export type { UnifiedReportInput, LiveGraphOutput } from './graph-report.js';

const EVT_GRAPH_COMPLETE = 'graph.cli.graph.complete';
const MODULE_GRAPH_CLI = 'graph:cli';
const MODULE_GRAPH_RENDER = 'graph:render';

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

/**
 * Engine-selection policy (ADR-0033, superseding ADR-0032/0031). The SHARDED
 * engine is the DEFAULT — both engines resolve through one shared model (exact =
 * the 1-shard case), held equivalent by the directional soundness invariant +
 * completeness floor (`equivalence-repo-scale.test.ts` fixture +
 * `graph-equivalence-check` directional real-repo ratchet +
 * `resolution-completeness-floor.test.ts`; ADR-0033). Returns the shard
 * set whenever the project can actually shard (>1 non-empty shard); returns an
 * empty array (→ the EXACT single-program engine) when `--exact` is passed OR
 * the project isn't shardable (single-package / flat / discovery failure — the
 * natural exact fallback). The decision is a pure function of the parsed options
 * + the project's shardability — it never reads `process.stdout.isTTY`, so a
 * bare `graph` is deterministic across terminal / pipe / CI invocations.
 *
 * The exact engine is selected (returns `[]`) when:
 *   - `--exact` was passed (the explicit small-repo / oracle escape hatch);
 *   - positional `[paths...]` were given (subtree/multi-path runs are exact);
 *   - the project resolves to ≤1 non-empty shard (nothing to parallelize) or
 *     no worker script is available — a graceful fall-through to exact, the
 *     natural single-package path.
 */
/** Profile bucket for the run shape: workspace fan-out, multi-path, or single graph. */
function profileMode(opts: GraphCommandOptions): string {
  if (opts.workspace === true) return 'workspace';
  if ((opts.paths?.length ?? 0) > 1) return 'multi-path';
  return 'graph';
}

function createProfileBuilder(
  opts: GraphCommandOptions,
  startedAt: string,
): GraphProfileBuilder | undefined {
  if (typeof opts.profileOutput !== 'string' || opts.profileOutput.length === 0) {
    return undefined;
  }
  return new GraphProfileBuilder({
    cwd: opts.cwd,
    mode: profileMode(opts),
    resolutionMode: opts.resolution,
    startedAt,
  });
}

function writeProfileIfRequested(
  opts: GraphCommandOptions,
  profile: GraphProfileBuilder | undefined,
): void {
  if (profile === undefined) return;
  if (typeof opts.profileOutput !== 'string' || opts.profileOutput.length === 0) return;
  const outPath = writeGraphProfile(opts.profileOutput, opts.cwd, profile.complete());
  logger.info({
    evt: 'graph.profile.write.complete',
    module: MODULE_GRAPH_CLI,
    output: outPath,
  });
}

/**
 * Assemble the run's {@link SignalEnvelope} from its raw engine signals
 * (ADR-0011). Centralises `runId`/`createdAt` resolution off the live scope so
 * cloud egress correlates with the run id the logger stamps; the envelope is
 * pure (the clock read happens here, once).
 */
function envelopeFor(
  opts: GraphCommandOptions,
  result: RunGraphResult,
  durationMs: number,
): SignalEnvelope {
  return buildGraphEnvelope({
    signals: result.signals,
    recipe: opts.recipe,
    runId: currentScope()?.runId ?? '',
    createdAt: new Date().toISOString(),
    durationMs,
    resolutionMode: result.catalog?.resolutionMode,
  });
}

// Exported for the per-mode dispatch test (audit P1-2). Not re-exported by
// the package barrel (only `executeGraph` is), so it stays package-internal.
//
// Returns the run's {@link GraphRunOutcome} for every mode that should deliver
// signals (gate, catalog, `--report-to`, default render) so the composition
// root can cloud-emit + report-to it ONCE (ADR-0011 / ADR-0008) and the host
// can persist the optional session contribution (host-owned-run-timing Phase
// 3). Returns `undefined` for plain `--json` (the `--workspace` child carrier —
// children must not each emit cloud signals).
export async function dispatchGraphResult(
  opts: GraphCommandOptions,
  rawResult: RunGraphResult,
  cli: ToolCliContext,
  startedAt: string,
  suppressionRoot: string,
): Promise<GraphRunOutcome | undefined> {
  // ADR-0014: apply the inline graph-ignore waivers BEFORE any mode consumes
  // the signals — the gate baseline, catalog, render, and session persistence
  // all see the post-waiver set. `--workspace` is covered transitively: each
  // child runs `graph --json` through this function, so the parent aggregates
  // already-waived signals.
  //
  // `suppressionRoot` is the build root the signals' `code.file` paths are
  // RELATIVE TO — i.e. the positional subtree / sharded-child / workspace-unit
  // root, NOT necessarily `opts.cwd`. A `graph <subdir>` run (and every
  // `--workspace` child, which runs `graph <unitRoot> --json`) builds against
  // `runCwd = positionalPaths[0]`, so its signal paths and directive files
  // resolve under that root. Resolving against `opts.cwd` instead made every
  // `@graph-ignore` directive file unreadable (ENOENT), silently leaking the
  // waiver — the bug this parameter closes.
  // Route through the SINGLE suppression chokepoint (finalizeGraphSignals) — the
  // same seam the live/worker producers cross via buildLiveGraphOutput. The
  // branded FinalizedSignals it returns is the only signal shape the
  // session-contribution builder (and, transitively, the verdict + render) will
  // accept, so a future fourth output path cannot deliver un-waived signals: the
  // compiler rejects it.
  const finalized = await finalizeGraphSignals(rawResult.signals, suppressionRoot);
  return deliverGraphResult(
    opts,
    { ...rawResult, signals: finalized.signals },
    cli,
    startedAt,
    finalized,
  );
}

/**
 * Deliver an already-waived run to its output mode (gate / catalog-json /
 * render) and, on the human-facing render path, BUILD the generic-session
 * contribution the host run plane persists (host-owned-run-timing Phase 3 —
 * graph never writes the row itself). Split out of {@link dispatchGraphResult}
 * so the multi-path path — which must waive each path's signals against ITS
 * OWN root before aggregating (the roots differ) — can aggregate the kept
 * signals and deliver once, without a second (wrong-root) suppression pass.
 *
 * The contribution is built HERE, where the branded {@link FinalizedSignals}
 * is in scope, so the dashboard history can only ever carry post-waiver
 * findings (the branding guard is not lost across the return boundary).
 */
async function deliverGraphResult(
  opts: GraphCommandOptions,
  result: RunGraphResult,
  cli: ToolCliContext,
  startedAt: string,
  finalized: FinalizedSignals,
): Promise<GraphRunOutcome | undefined> {
  const suppressedCount = finalized.suppressedCount;
  const durationMs = Math.max(0, Date.now() - Date.parse(startedAt));
  if (opts.gateSave === true || opts.gateCompare === true) {
    // ADR-0036: the envelope arrives fingerprint-stamped — `buildGraphEnvelope`
    // passes graph's byte-preserved strategy into `buildSignalEnvelope`, which
    // stamps at construction (over the canonical remapped ruleIds, exactly what
    // the former post-hoc gate-path stamp produced). The host seams only read
    // `signal.fingerprint`. runGateMode owns the deliverSignals call
    // (host-derived exit), so the command-spec skips it.
    const envelope = envelopeFor(opts, result, durationMs);
    await runGateMode(opts, envelope, cli, result.catalog?.resolutionMode);
    logger.info({
      evt: EVT_GRAPH_COMPLETE,
      module: MODULE_GRAPH_CLI,
      suppressed: suppressedCount,
    });
    return { envelope };
  }
  if (typeof opts.catalogOutput === 'string' && opts.catalogOutput.length > 0) {
    runCatalogJsonMode(opts, result, cli, startedAt);
    logger.info({
      evt: EVT_GRAPH_COMPLETE,
      module: MODULE_GRAPH_CLI,
      suppressed: suppressedCount,
    });
    return { envelope: envelopeFor(opts, result, durationMs) };
  }
  const envelope = await renderGraphResult(opts, result, startedAt, cli);
  // Session persistence is dashboard history — populated on human-facing runs
  // only. Skipped for:
  //   - `--json` (the machine-artifact mode AND the carrier each
  //     `executeWorkspaceGraph` child runs under — keeps "one human invocation
  //     = one session"; the --workspace parent persists the single aggregate);
  //   - `--report-to` (an export mode; like gate/catalog it opts out of session
  //     history — the root delivers the envelope to the receiver instead).
  // The host persists the returned `session` after the handler resolves; graph
  // builds it here from the BRANDED FinalizedSignals so the contribution can
  // only ever carry post-waiver findings regardless of which path reached here.
  const isReportTo = typeof opts.reportTo === 'string' && opts.reportTo.length > 0;
  const session =
    opts.json !== true && !isReportTo ? buildGraphSessionContribution(opts, finalized) : undefined;
  cli.setExitCode(EXIT_CODES.SUCCESS);
  logger.info({
    evt: EVT_GRAPH_COMPLETE,
    module: MODULE_GRAPH_CLI,
    signals: result.signals.length,
    suppressed: suppressedCount,
  });
  // Plain `--json` is the workspace-child carrier: it returns `undefined` so
  // the root does not cloud-emit per child (the parent owns the dashboard
  // aggregate, not per-unit signal batches — audit P1-2). Every other mode
  // (default render, `--report-to`) returns the outcome for root delivery; only
  // the non-export render path carries a `session`.
  return opts.json === true ? undefined : { envelope, ...(session ? { session } : {}) };
}

/**
 * Render the run and return its {@link SignalEnvelope} (ADR-0011).
 *
 * `--json` emits the envelope through the shared `formatSignalJson`
 * (`cli.emitEnvelope`). The default/`--verbose` path hands a {@link RunPresentation}
 * to the render seam (Ink on TTY, plain text in pipes/CI): the SAME `envelope`
 * already built here IS carried on the render object (envelope-first-presentation
 * plan, RP-2), so `presentationToView` derives the PASS/FAIL summary and verdict
 * from it — graph no longer carries a count-based `graph-done` summary. The
 * verbose catalog/findings/entry-point body rides as `verboseDetail`
 * ({kind:'lines'}, ADR-0021), and that verbose/detail surface also carries the
 * per-unit table; graph's fast-tier caveat moves to `RunPresentation.banners` (a
 * muted line above the summary); the non-verbose footer hints are emitted by the
 * shared seam. The host-stamped
 * `durationMs` (ADR-0051) is threaded as `RunPresentation.durationMs` so the
 * summary shows the real wall-clock — graph's envelope units carry `durationMs: 0`,
 * so without this thread `presentationToView`'s unit-sum default would render
 * `0ms`. The envelope is also RETURNED for the composition root's cloud +
 * `--report-to` delivery (egress, a separate plane — untouched here).
 */
async function renderGraphResult(
  opts: GraphCommandOptions,
  result: RunGraphResult,
  startedAt: string,
  cli: ToolCliContext,
): Promise<SignalEnvelope> {
  const durationMs = Math.max(0, Date.now() - Date.parse(startedAt));
  const envelope = envelopeFor(opts, result, durationMs);
  if (opts.json === true) {
    logger.info({
      evt: 'graph.render.json.start',
      module: MODULE_GRAPH_RENDER,
    });
    cli.emitEnvelope(envelope);
    logger.info({
      evt: 'graph.render.json.complete',
      module: MODULE_GRAPH_RENDER,
    });
    return envelope;
  }
  logger.info({ evt: 'graph.render.presentation.start', module: MODULE_GRAPH_RENDER });
  const verbose = opts.verbose === true;
  // ADR-0021: graph's verbose body is carried as VerboseDetail{kind:'lines'} and
  // rendered through the shared resultToView seam — the same path the live runner
  // uses — instead of a graph-only `reportLines`/`footerHints` shape. The
  // non-verbose footer hints are emitted by the seam (envelope-first-presentation
  // RP-2 → `presentationToView`).
  const verboseDetail: VerboseDetail | undefined = verbose
    ? {
        kind: 'lines',
        lines: buildUnifiedReportLines(
          {
            catalog: result.catalog,
            indexes: result.indexes,
            signals: result.signals,
            cacheHit: result.cacheHit,
          },
          { includeSummary: false },
        ),
      }
    : undefined;
  const resolutionBanner = resolutionBannerText(result.catalog?.resolutionMode);
  // envelope-first-presentation RP-2: route graph's static render through the
  // shared RunPresentation. The envelope IS carried (it drives the verdict and
  // optional verbose/detail table); `durationMs` is threaded so the host-owned
  // wall-clock wins over the unit-sum (graph units carry durationMs:0); the
  // resolution caveat moves to `banners`.
  const presentation: RunPresentation = {
    type: 'run-presentation',
    tool: 'graph',
    envelope,
    ...(verboseDetail === undefined ? {} : { verboseDetail }),
    ...(resolutionBanner === undefined ? {} : { banners: [resolutionBanner] }),
    durationMs,
  };
  await cli.render(presentation);
  logger.info({
    evt: 'graph.render.presentation.complete',
    module: MODULE_GRAPH_RENDER,
  });
  return envelope;
}

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
