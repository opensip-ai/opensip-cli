/**
 * graph-command-spec — the declarative primary `graph` command (launch
 * Phase 5 Task 5.1).
 *
 * Replaces graph's hand-rolled `registerGraphCommand()` body: the host mounts
 * this spec via `mountCommandSpec`, applies the ADR-0021 common flags + graph's
 * own options, and invokes {@link runGraphCommand}. The tool no longer touches
 * Commander.
 *
 * `output: 'raw-stream'` because graph's handler owns its entire output surface —
 * it dispatches at runtime between the interactive Ink live view (TTY-only
 * default), a discovery-only `--list-files` short-circuit, the static
 * gate/json/render path, and the `--sarif` file write, then performs its own
 * cloud egress (`deliverSignals` / `--report-to`) and exit-code decision. None of
 * that is expressible through the `signal-envelope` dispatch arm (which only does
 * `emitEnvelope`/`render`), so the host renders nothing and the handler stays
 * authoritative — byte-identical to the former `registerGraphCommand` action
 * body.
 *
 * `--resolution` validation: the legacy action validated the raw string via
 * `parseResolutionMode` inside the body (a `ValidationError` on a typo). That
 * validation now lives in the declared `choices: ['exact', 'fast']` — the mount
 * layer enforces membership at parse time (Commander rejects an out-of-set value
 * before the handler runs), so the handler trusts the parsed value.
 */

import { EXIT_CODES, type SignalEnvelope, type StoredSession } from '@opensip-cli/contracts';
import { defineCommand } from '@opensip-cli/core';
import { resolveSession } from '@opensip-cli/session-store';

import { graphReplayFromSession } from '../../persistence/session-replay.js';
import { resolveRecipeToRules } from '../../recipes/resolve.js';
import { renderGraphLive } from '../graph-runner.js';
import { executeGraph, resolveLiveEngineShards } from '../graph.js';
import { runHeapPreflight } from '../heap-preflight.js';
import { executeListFiles } from '../list-files.js';
import { loadGraphConfig, resolveGraphRecipeSelection } from '../orchestrate.js';

import type { GraphConfig, ResolutionMode, Rule } from '../../types.js';
import type { Shard } from '../orchestrate/shard-model.js';
import type { CommandSpec, ToolCliContext, ToolRunCompletion } from '@opensip-cli/core';
import type { DataStore } from '@opensip-cli/datastore';

/**
 * Live-view key graph contributes to the CLI's renderer registry. Owned by this
 * package — the CLI dispatcher does NOT key off this literal; each tool decides
 * its own live-view name. It matches the `graph` command name so the dispatcher's
 * `renderLive(key)` lookup reads naturally next to the command that triggers it.
 *
 * The renderer is registered lazily inside the interactive branch of the handler
 * via {@link setUpGraphLiveView} (the tool wires that callback in).
 */
export const GRAPH_LIVE_VIEW_KEY = 'graph';

/** Parsed `graph` options — the ADR-0021 common flags plus graph's own flags. */
interface GraphCommandOptions {
  cwd: string;
  json?: boolean;
  cache?: boolean;
  recipe?: string;
  gateSave?: boolean;
  gateCompare?: boolean;
  reportTo?: string;
  apiKey?: string;
  profile?: string;
  workspace?: boolean;
  exact?: boolean;
  concurrency?: number;
  language?: string;
  verbose?: boolean;
  quiet?: boolean;
  // `choices: ['exact','fast']` guarantees this is one of those two (or the
  // 'exact' default) by the time the handler sees it.
  resolution?: string;
  listFiles?: boolean;
  sarif?: string;
  show?: string;
}

/**
 * Set graph's live view up on the host context — a synchronous, void-returning
 * map write (named with the `setUp` prefix to signal that; `register*` would trip
 * the `detached-promises` dogfood heuristic). In the spec-mounted world there is
 * no `register()` mount hook, so the handler sets the renderer up lazily on the
 * interactive path (before any `cli.renderLive` lookup). `registerLiveView` is an
 * idempotent map write, so doing this once per run — only on the live path that
 * needs it — is equivalent to the old mount-time registration.
 */
function setUpGraphLiveView(cli: ToolCliContext): void {
  cli.registerLiveView(GRAPH_LIVE_VIEW_KEY, async (args, liveContext) => {
    // The renderer returns a ToolRunCompletion; the HOST persists its `session`
    // after this resolves (host-owned-run-timing Phase 2). Graph's cloud egress
    // is on the static gate path, so the live wrapper emits no envelope.
    return renderGraphLive(
      args as {
        cwd: string;
        noCache?: boolean;
        resolution?: ResolutionMode;
        verbose?: boolean;
        quiet?: boolean;
        config?: GraphConfig;
        rules?: readonly Rule[];
        recipe?: string;
        exact?: boolean;
        shards?: readonly Shard[];
      },
      cli.scope.datastore() as DataStore | undefined,
      { setExitCode: cli.setExitCode },
      liveContext,
    );
  });
}

/**
 * Dispatch the interactive (TTY) live `graph` view. Extracted from
 * `runGraphCommand` so the handler's branching stays under the cognitive-
 * complexity bound: this owns the lazy renderer setup, the ADR-0022 recipe
 * resolution, and the live args (including the serializable `--recipe` NAME the
 * off-process worker re-resolves, ADR-0028).
 */
async function dispatchGraphLiveView(
  opts: GraphCommandOptions,
  cli: ToolCliContext,
  resolution: ResolutionMode,
): Promise<void> {
  // Spec-mounted world: no `register()` mount hook, so set the renderer up
  // lazily here (idempotent map write) before the `cli.renderLive` lookup.
  setUpGraphLiveView(cli);
  // Resolve the recipe here (the handler runs inside the entered RunScope
  // via the pre-action hook) for parity with `executeGraph`: tool-scoped
  // precedence (`--recipe` > `graph.recipe` > `default`, ADR-0022), with
  // config-sourced unknown names tolerantly
  // falling back to `default` and explicit-flag typos still hard-failing.
  const recipeSelection = resolveGraphRecipeSelection(opts.cwd, opts.recipe);
  // Resolve the build engine HERE, on the dispatch seam — `resolveLiveEngineShards`
  // needs the `cli` context (language registry + datastore) the React runner does
  // not hold. The SAME policy the static path uses (ADR-0032): sharded when
  // `--exact` is absent and the project yields >1 shard, exact otherwise. The
  // runner reads `shards.length` to pick engine-aware labels and pass the
  // plain-data shard plan to the worker. `isTTY` is never consulted — engine =
  // exact + shardability alone.
  const shards = await resolveLiveEngineShards(
    {
      cwd: opts.cwd,
      noCache: opts.cache === false,
      resolution,
      exact: opts.exact,
      cliScript: process.argv[1],
    },
    cli,
  );
  await cli.renderLive(GRAPH_LIVE_VIEW_KEY, {
    cwd: opts.cwd,
    noCache: opts.cache === false,
    verbose: opts.verbose === true,
    quiet: opts.quiet === true,
    resolution,
    // The engine selector (`--exact` + the pre-resolved shard set). The live
    // runner sends this plain-data plan to the worker (ADR-0028).
    exact: opts.exact === true,
    shards,
    // The recipe NAME (serializable) for the worker, which re-resolves rules
    // itself (ADR-0028); `rules` below serves the in-process fallback path.
    ...(opts.recipe === undefined ? {} : { recipe: opts.recipe }),
    // Pass the resolved rule subset into the live path. Avoids a second
    // scope read inside the React tree.
    rules: resolveRecipeToRules(recipeSelection.name, {
      tolerant: recipeSelection.tolerant,
    }),
    // Honor the project's `graph:` config block in the interactive
    // path too — parity with `executeGraph` (graph.ts), which loads
    // it via the same helper. Loading here (not inside the React
    // runner) keeps the fs read on the dispatch seam.
    config: loadGraphConfig(opts.cwd),
  });
}

/**
 * The `graph` command handler — the former `registerGraphCommand()` action body,
 * lifted to a spec handler. The host (`raw-stream`) renders nothing, so the
 * handler keeps full ownership of the list-files/live/static dispatch, the
 * `--sarif` write, the cloud egress, and the exit-code decision.
 *
 * host-owned-run-timing Phase 3: the static render path RETURNS a
 * {@link ToolRunCompletion} carrying the run's `session` contribution; the host
 * run plane persists it after this handler resolves (graph no longer writes the
 * generic session row itself). The early-return branches (show / list-files /
 * heap-preflight re-exec / TTY live view) return `void` — the live view path
 * persists its own session via `renderLive`, and the other branches produce no
 * session.
 */
async function runGraphCommand(
  rawOpts: unknown,
  cli: ToolCliContext,
): Promise<ToolRunCompletion | void> {
  const opts = rawOpts as GraphCommandOptions;
  // `--resolution`'s value is `exact`/`fast` by construction now (declared
  // `choices`); the mount layer rejected any other value before we got here.
  // Default is `exact` (the spec's declared default), so coerce undefined too.
  const resolution: ResolutionMode = opts.resolution === 'fast' ? 'fast' : 'exact';

  // --list-files short-circuits to discovery-only: print the resolved
  // source-file set for this scope and exit, BEFORE heap preflight or any
  // catalog build. Reuses the same scoping flags (paths / --workspace /
  // --language) and honors --json.
  //
  // `[paths...]` is graph's sole positional, and it is variadic — Commander
  // hands a variadic positional to its action as a SINGLE array argument, so
  // the host's `_args` positional array carries that array as its first (and
  // only) element. The variadic value is therefore `_args[0]` (the string[]),
  // not `_args` itself. An invocation with no paths yields `_args === [[]]`
  // (a single empty array), so `?? []` covers the absent case too.
  const positionals = (opts as unknown as { _args?: readonly unknown[] })._args ?? [];
  const paths = (positionals[0] ?? []) as readonly string[];
  if (opts.show !== undefined && opts.show.length > 0) {
    await runGraphShowMode(opts, cli);
    return;
  }
  if (opts.listFiles === true) {
    await executeListFiles(
      {
        cwd: opts.cwd,
        json: opts.json,
        paths,
        workspace: opts.workspace,
        language: opts.language,
      },
      cli,
    );
    return;
  }
  // Preflight runs BEFORE any heavy work. If the repo's file count
  // exceeds a threshold AND the current heap cap is too low, this
  // re-execs the process with elevated `--max-old-space-size`. The
  // re-execing parent never returns from this call (it `process.exit`s
  // with the child's code), so `returned === true` only matters for
  // the type checker. Skipped when the user has expressed an explicit
  // scope (positional paths, --workspace, or --language): those runs
  // either touch a fraction of files (positional/language) or spawn
  // child processes per unit (workspace) and don't need the global
  // heap sizing.
  const hasExplicitScope =
    paths.length > 0 || opts.workspace === true || typeof opts.language === 'string';
  if (!hasExplicitScope) {
    const reExecing = await runHeapPreflight({
      cwd: opts.cwd,
      verbose: opts.verbose === true,
    });
    /* v8 ignore next */
    if (reExecing) return;
  }

  // Determinism (ADR-0032, superseding ADR-0031): TTY selects only the RENDERER
  // (the Ink live view vs the static `executeGraph` text/JSON path), NEVER the
  // build engine. The build engine is chosen downstream — by `--exact` +
  // shardability alone — and the live view drives WHICHEVER engine that policy
  // selects through the worker, so the live runner is engine-agnostic. A bare
  // `graph` (sharded default) and `graph --exact` BOTH
  // show the staged "Code Graph" checklist in a terminal; both fall through to
  // the static path when piped. The live view is therefore eligible for any
  // rendering run — there is no `--exact` gate. Every non-rendering mode (json/
  // gate/report/profile/workspace/positional-paths/language) is excluded.
  const isLiveViewEligible =
    opts.json !== true &&
    opts.gateSave !== true &&
    opts.gateCompare !== true &&
    /* v8 ignore next */
    (typeof opts.reportTo !== 'string' || opts.reportTo.length === 0) &&
    (typeof opts.profile !== 'string' || opts.profile.length === 0) &&
    opts.workspace !== true &&
    paths.length === 0 &&
    /* v8 ignore next */
    typeof opts.language !== 'string';

  // The animated live view is a TTY-only affordance (frame-driven Ink).
  // In a pipe / CI / redirected run (non-TTY) it would emit garbled or
  // empty frames, so fall through to the static `executeGraph` path, whose
  // `graph-done` result is dual-rendered through the seam (`renderToText`)
  // — the same report content (and the SAME engine the policy selects),
  // consistent with the TTY final frame. Only the rendering surface differs
  // by TTY.
  if (isLiveViewEligible && process.stdout.isTTY === true) {
    await dispatchGraphLiveView(opts, cli, resolution);
    return;
  }

  const outcome = await executeGraph(
    {
      cwd: opts.cwd,
      json: opts.json,
      noCache: opts.cache === false,
      resolution,
      recipe: opts.recipe,
      gateSave: opts.gateSave,
      gateCompare: opts.gateCompare,
      reportTo: opts.reportTo,
      apiKey: opts.apiKey,
      profileOutput: opts.profile,
      paths,
      workspace: opts.workspace,
      exact: opts.exact,
      concurrency: opts.concurrency,
      language: opts.language,
      verbose: opts.verbose,
      cliScript: process.argv[1],
    },
    cli,
  );

  // `--sarif <path>`: write this run's findings as a SARIF 2.1.0 file via the
  // root `cli.writeSarif` seam (the one place that formats an envelope to
  // SARIF; the engine never imports @opensip-cli/output). Composes with
  // --gate-save: executeGraph has already set the gate exit code, but the
  // handler body still runs, so the SARIF lands even when the gate fails —
  // GitHub Code Scanning then surfaces net-new graph findings on PRs.
  if (opts.sarif !== undefined && opts.sarif !== '' && outcome?.envelope !== undefined) {
    await cli.writeSarif(outcome.envelope, opts.sarif);
  }

  await deliverNonGateEgress(opts, outcome?.envelope, cli);

  // host-owned-run-timing Phase 3: RETURN the generic-session contribution; the
  // host run plane persists it after this handler resolves (no tool-side write).
  return graphRunCompletion(outcome);
}

/**
 * Build graph's run completion from the run outcome (host-owned-run-timing
 * Phase 3): the generic-session contribution the host run plane persists. The
 * export/carrier modes (`--json`, gate, `--report-to`) carry no session.
 */
function graphRunCompletion(
  outcome: { readonly envelope?: SignalEnvelope; readonly session?: unknown } | undefined,
): ToolRunCompletion {
  return {
    session: outcome?.session as ToolRunCompletion['session'],
  };
}

/**
 * Effectful egress at the composition root (ADR-0011 / ADR-0008): cloud sync +
 * `--report-to` (which owns exit 4). `executeGraph` returns the envelope for every
 * mode that should deliver (catalog / default render / `--report-to`) and
 * `undefined` for the modes that must not (plain `--json` workspace-child carrier,
 * `--workspace` parent, error paths).
 *
 * ADR-0036: gate modes (`--gate-save`/`--gate-compare`) own their OWN
 * deliverSignals call inside `runGateMode` — they feed the gate verdict to the
 * host's runFailed override (the host derives the exit; no tool setExitCode), so
 * the host must NOT deliver again here. The `--sarif` write still runs for gate
 * mode (it reads the returned envelope), preserving `if: always()` export.
 */
async function deliverNonGateEgress(
  opts: GraphCommandOptions,
  envelope: SignalEnvelope | undefined,
  cli: ToolCliContext,
): Promise<void> {
  const isGateMode = opts.gateSave === true || opts.gateCompare === true;
  if (envelope === undefined || isGateMode) return;
  await cli.deliverSignals(envelope, {
    cwd: opts.cwd,
    reportTo: opts.reportTo,
    apiKey: opts.apiKey,
  });
}

async function runGraphShowMode(opts: GraphCommandOptions, cli: ToolCliContext): Promise<void> {
  const datastore = cli.scope.datastore() as DataStore | undefined;
  if (datastore === undefined) {
    await emitGraphShowError(
      opts,
      cli,
      'datastore-unavailable',
      'session replay requires a datastore',
    );
    return;
  }
  const resolved = resolveSession(datastore, {
    ref: opts.show ?? 'latest',
    tool: 'graph',
  });
  if (!resolved.ok) {
    await emitGraphShowError(opts, cli, resolved.reason, resolved.detail);
    return;
  }

  try {
    const replay = graphReplayFromSession(resolved.session);
    if (opts.json === true) {
      cli.emitJson(sessionShowJson(resolved.session, replay));
      return;
    }
    await cli.render(sessionReplayResult(resolved.session, replay));
  } catch (error) {
    await emitGraphShowError(
      opts,
      cli,
      'decode-error',
      error instanceof Error ? error.message : String(error),
    );
  }
}

async function emitGraphShowError(
  opts: Pick<GraphCommandOptions, 'json'>,
  cli: ToolCliContext,
  reason: string,
  detail: string,
): Promise<void> {
  if (opts.json === true) {
    // emitError sets the exit code itself (process exit == reported outcome).
    cli.emitError({
      message: detail,
      exitCode: EXIT_CODES.CONFIGURATION_ERROR,
      code: reason,
    });
    return;
  }
  cli.setExitCode(EXIT_CODES.CONFIGURATION_ERROR);
  await cli.render({
    type: 'error',
    message: detail,
    exitCode: EXIT_CODES.CONFIGURATION_ERROR,
  });
}

function sessionShowJson(
  session: StoredSession,
  replay: ReturnType<typeof graphReplayFromSession>,
): unknown {
  return {
    session: {
      id: session.id,
      tool: session.tool,
      startedAt: session.startedAt,
      completedAt: session.completedAt,
      recipe: session.recipe,
      cwd: session.cwd,
      score: session.score,
      passed: session.passed,
      durationMs: session.durationMs,
    },
    fidelity: replay.fidelity,
    envelope: replay.envelope,
  };
}

/** The tool-agnostic `session-replay` view result (rendered via the shared
 *  envelope table; no live-run footer). `cli.render` takes `unknown`. */
function sessionReplayResult(
  session: StoredSession,
  replay: ReturnType<typeof graphReplayFromSession>,
): unknown {
  return {
    type: 'session-replay',
    session: {
      id: session.id,
      tool: session.tool,
      startedAt: session.startedAt,
      completedAt: session.completedAt,
      ...(session.recipe === undefined ? {} : { recipe: session.recipe }),
      score: session.score,
      passed: session.passed,
      durationMs: session.durationMs,
    },
    envelope: replay.envelope,
    fidelity: replay.fidelity,
  };
}

/**
 * Parse the `--concurrency <n>` value into a positive integer. A named
 * declaration (not an inline arrow) so the `@throws` JSDoc attaches to the
 * function node the throws-documentation check inspects.
 *
 * @throws {Error} When the value is not a positive integer (Commander surfaces
 *   it as a usage/parse error, which the CLI boundary maps to exit 2).
 */
function parseConcurrency(v: string): number {
  const n = Number.parseInt(v, 10);
  if (!Number.isFinite(n) || n < 1) {
    throw new Error(`--concurrency must be a positive integer (received '${v}')`);
  }
  return n;
}

/**
 * The declarative primary `graph` command (launch Phase 5 Task 5.1).
 * The host mounts this spec, applies the ADR-0021 common flags + graph's options
 * + the `[paths...]` variadic argument, and invokes {@link runGraphCommand}.
 */
export const graphCommandSpec: CommandSpec<unknown, ToolCliContext> = defineCommand<
  unknown,
  ToolCliContext
>({
  name: 'graph',
  description:
    'Run static call-graph analysis (rules, entry points, catalog summary in one report)',
  // ADR-0021 cross-tool flags from the single registry: --cwd, --json, --quiet,
  // --verbose, --debug, --report-to, --api-key. `cwd` is seeded with
  // process.cwd() by the mounter. graph-specific flags stay declared below.
  commonFlags: ['cwd', 'json', 'quiet', 'verbose', 'debug', 'reportTo', 'apiKey'],
  options: [
    {
      flag: '--no-cache',
      description: 'Skip catalog cache (force full rebuild)',
      negatable: true,
    },
    {
      flag: '--resolution',
      value: '<mode>',
      description: 'Edge resolution tier: exact (semantic) or fast (syntactic, no type checker)',
      default: 'exact',
      choices: ['exact', 'fast'],
    },
    {
      flag: '--recipe',
      value: '<name>',
      description: 'Run a named recipe (a subset of graph rules). Default: all rules',
    },
    {
      flag: '--show',
      value: '<session>',
      description: 'Replay a stored graph session by id, or latest for the latest graph session',
    },
    {
      flag: '--gate-save',
      description: 'Save current Signal set as the gate baseline',
      default: false,
    },
    {
      flag: '--gate-compare',
      description: 'Compare current Signals to the gate baseline',
      default: false,
    },
    {
      flag: '--profile',
      value: '<path>',
      description: 'Write graph performance profile JSON to path',
    },
    {
      flag: '--workspace',
      description: 'Fan out across detected workspace units (memory-isolated; polyglot)',
      default: false,
    },
    {
      flag: '--exact',
      description:
        'Use the single-program exact build engine instead of the default parallel sharded engine (both resolve through one shared model — exact = the 1-shard case — held equivalent by the directional equivalence guardrail; --exact suits small/single-package repos).',
      default: false,
    },
    {
      flag: '--concurrency',
      value: '<n>',
      description: 'Concurrency cap for --workspace and the sharded build (default: cpus()-1)',
      parse: parseConcurrency,
    },
    {
      flag: '--language',
      value: '<name>',
      description: 'Force a specific language adapter (suppresses auto-detection)',
    },
    {
      flag: '--list-files',
      description:
        'List the source files graph would discover for this scope and exit (no build; honors [paths...], --workspace, --language, --json)',
      default: false,
    },
    {
      flag: '--sarif',
      value: '<path>',
      description:
        'Also write this run’s findings as a SARIF 2.1.0 file (for GitHub Code Scanning). Composes with --gate-save; written even when the gate fails.',
    },
  ],
  args: [
    {
      name: 'paths',
      variadic: true,
      optional: true,
      description: 'Subtrees to analyze (default: whole project)',
    },
  ],
  scope: 'project',
  output: 'raw-stream',
  rawStreamReason: 'runtime-render-dispatch',
  handler: runGraphCommand,
});
