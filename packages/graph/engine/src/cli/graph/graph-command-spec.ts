/**
 * graph-command-spec — the declarative primary `graph` command (release 2.11.0
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

import { EXIT_CODES, type StoredSession } from '@opensip-tools/contracts';
import { defineCommand } from '@opensip-tools/core';
import { resolveSession } from '@opensip-tools/session-store';

import { graphReplayFromSession } from '../../persistence/session-replay.js';
import { resolveRecipeToRules } from '../../recipes/resolve.js';
import { renderGraphLive } from '../graph-runner.js';
import { executeGraph } from '../graph.js';
import { runHeapPreflight } from '../heap-preflight.js';
import { executeListFiles } from '../list-files.js';
import { loadGraphConfig, resolveGraphRecipeSelection } from '../orchestrate.js';

import type { GraphConfig, ResolutionMode, Rule } from '../../types.js';
import type { CommandSpec, ToolCliContext } from '@opensip-tools/core';
import type { DataStore } from '@opensip-tools/datastore';

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
  cli.registerLiveView(GRAPH_LIVE_VIEW_KEY, async (args) => {
    await renderGraphLive(
      args as {
        cwd: string;
        noCache?: boolean;
        resolution?: ResolutionMode;
        verbose?: boolean;
        quiet?: boolean;
        config?: GraphConfig;
        rules?: readonly Rule[];
        recipe?: string;
      },
      cli.scope.datastore() as DataStore | undefined,
      { setExitCode: cli.setExitCode },
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
  // precedence (`--recipe` > `graph.recipe` > deprecated `cli.recipe` >
  // `default`, ADR-0022), with config-sourced unknown names tolerantly
  // falling back to `default` and explicit-flag typos still hard-failing.
  const recipeSelection = resolveGraphRecipeSelection(opts.cwd, opts.recipe);
  await cli.renderLive(GRAPH_LIVE_VIEW_KEY, {
    cwd: opts.cwd,
    noCache: opts.cache === false,
    verbose: opts.verbose === true,
    quiet: opts.quiet === true,
    resolution,
    // The recipe NAME (serializable) for the off-process worker, which
    // re-resolves rules itself (ADR-0028); `rules` below is the in-process path.
    ...(opts.recipe === undefined ? {} : { recipe: opts.recipe }),
    // Pass the resolved rule subset into the live path. Avoids a second
    // scope read inside the React tree.
    rules: resolveRecipeToRules(recipeSelection.name, { tolerant: recipeSelection.tolerant }),
    // Honor the project's `graph:` config block in the interactive
    // path too — parity with `executeGraph` (graph.ts), which loads
    // it via the same helper. Loading here (not inside the React
    // runner) keeps the fs read on the dispatch seam.
    config: loadGraphConfig(opts.cwd),
  });
}

/**
 * The `graph` command handler — the former `registerGraphCommand()` action body,
 * lifted verbatim to a spec handler. Returns `void`: the host (`raw-stream`)
 * renders nothing, so the handler keeps full ownership of the
 * list-files/live/static dispatch, the `--sarif` write, the cloud egress, and
 * the exit-code decision — byte-identical to 2.10.0.
 */
async function runGraphCommand(rawOpts: unknown, cli: ToolCliContext): Promise<void> {
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
    paths.length > 0 ||
    opts.workspace === true ||
    typeof opts.language === 'string';
  if (!hasExplicitScope) {
    const reExecing = await runHeapPreflight({ cwd: opts.cwd, verbose: opts.verbose === true });
    /* v8 ignore next */
    if (reExecing) return;
  }

  const isInteractiveDefault =
    opts.json !== true
    && opts.gateSave !== true
    && opts.gateCompare !== true
    /* v8 ignore next */
    && (typeof opts.reportTo !== 'string' || opts.reportTo.length === 0)
    && (typeof opts.profile !== 'string' || opts.profile.length === 0)
    && opts.workspace !== true
    && paths.length === 0
    /* v8 ignore next */
    && typeof opts.language !== 'string';

  // The animated live view is a TTY-only affordance (frame-driven Ink).
  // In a pipe / CI / redirected run (non-TTY) it would emit garbled or
  // empty frames, so fall through to the static `executeGraph` path, whose
  // `graph-done` result is dual-rendered through the seam (`renderToText`)
  // — the same report content, consistent with the TTY final frame.
  if (isInteractiveDefault && process.stdout.isTTY === true) {
    await dispatchGraphLiveView(opts, cli, resolution);
    return;
  }

  const envelope = await executeGraph(
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
      concurrency: opts.concurrency,
      language: opts.language,
      verbose: opts.verbose,
      cliScript: process.argv[1],
    },
    cli,
  );

  // `--sarif <path>`: write this run's findings as a SARIF 2.1.0 file via the
  // root `cli.writeSarif` seam (the one place that formats an envelope to
  // SARIF; the engine never imports @opensip-tools/output). Composes with
  // --gate-save: executeGraph has already set the gate exit code, but the
  // handler body still runs, so the SARIF lands even when the gate fails —
  // GitHub Code Scanning then surfaces net-new graph findings on PRs.
  if (opts.sarif !== undefined && opts.sarif !== '' && envelope !== undefined) {
    await cli.writeSarif(envelope, opts.sarif);
  }

  // Effectful egress lives at the composition root (ADR-0011 / ADR-0008):
  // cloud sync + `--report-to` (which owns exit 4). `executeGraph` returns
  // the envelope for every mode that should deliver (gate / catalog /
  // default render / `--report-to`) and `undefined` for the modes that
  // must not (plain `--json` workspace-child carrier, `--workspace`
  // parent, error paths). Called once per run, after rendering.
  if (envelope !== undefined) {
    await cli.deliverSignals(envelope, {
      cwd: opts.cwd,
      reportTo: opts.reportTo,
      apiKey: opts.apiKey,
      // A content failure (critical/high signals) dominates a `--report-to`
      // upload failure (ADR-0008): a real failure must not be masked by
      // exit 4. The gate path sets its own exit code upstream.
      runFailed: !envelope.verdict.passed,
    });
  }
}

async function runGraphShowMode(opts: GraphCommandOptions, cli: ToolCliContext): Promise<void> {
  const datastore = cli.scope.datastore() as DataStore | undefined;
  if (datastore === undefined) {
    await emitGraphShowError(opts, cli, 'datastore-unavailable', 'session replay requires a datastore');
    return;
  }
  const resolved = resolveSession(datastore, { ref: opts.show ?? 'latest', tool: 'graph' });
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
    cli.emitError({ message: detail, exitCode: EXIT_CODES.CONFIGURATION_ERROR, code: reason });
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
      timestamp: session.timestamp,
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
      timestamp: session.timestamp,
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
 * The declarative primary `graph` command (release 2.11.0 Phase 5 Task 5.1).
 * The host mounts this spec, applies the ADR-0021 common flags + graph's options
 * + the `[paths...]` variadic argument, and invokes {@link runGraphCommand}.
 */
export const graphCommandSpec: CommandSpec<unknown, ToolCliContext> = defineCommand<unknown, ToolCliContext>({
  name: 'graph',
  description:
    'Run static call-graph analysis (rules, entry points, catalog summary in one report)',
  // ADR-0021 cross-tool flags from the single registry: --cwd, --json, --quiet,
  // --verbose, --debug, --report-to, --api-key. `cwd` is seeded with
  // process.cwd() by the mounter. graph-specific flags stay declared below.
  commonFlags: ['cwd', 'json', 'quiet', 'verbose', 'debug', 'reportTo', 'apiKey'],
  options: [
    { flag: '--no-cache', description: 'Skip catalog cache (force full rebuild)', negatable: true },
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
    { flag: '--gate-save', description: 'Save current Signal set as the gate baseline', default: false },
    { flag: '--gate-compare', description: 'Compare current Signals to the gate baseline', default: false },
    { flag: '--profile', value: '<path>', description: 'Write graph performance profile JSON to path' },
    {
      flag: '--workspace',
      description: 'Fan out across detected workspace units (memory-isolated; polyglot)',
      default: false,
    },
    {
      flag: '--concurrency',
      value: '<n>',
      description: 'Concurrency cap for --workspace (default: cpus()-1)',
      parse: (v) => Number.parseInt(v, 10),
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
  args: [{ name: 'paths', variadic: true, optional: true, description: 'Subtrees to analyze (default: whole project)' }],
  scope: 'project',
  output: 'raw-stream',
  handler: runGraphCommand,
});
