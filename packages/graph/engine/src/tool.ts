// @fitness-ignore-file no-direct-stdout-in-tool-engine -- auxiliary subcommand status line: `graph-baseline-export` writes the JSON baseline to a file and prints a one-line "Exported graph baseline to <path>" confirmation (the --json path uses cli.emitJson). This is not the signal-envelope run output (ADR-0011), which routes through the composition root.
// @fitness-ignore-file detached-promises -- async command actions invoke synchronous helpers (runCatalogJsonMode/runSarifExportMode/handleGraphError all return void); the heuristic flags them inside the async handlers. Matches the sibling graph CLI files (graph.ts, graph-modes.ts, orchestrate.ts).
// @fitness-ignore-file module-coupling-fan-out -- composition root: the graph Tool descriptor wires every subcommand, the scope contribution, and the adapter/rule/recipe registries; high intra-project fan-out is inherent to a tool-wiring file (cf. the index.ts / code-paths.ts barrels that suppress the same check).
/**
 * graphTool — graph as a Tool plugin.
 *
 * Owns the Commander wiring for the graph command surface. The CLI calls
 * register() once at startup; this file owns the option-parsing surface and
 * dispatches to the graph CLI helpers.
 *
 * Per spec §10A AC-2 / AC-1: this module does NOT import from
 * opensip-tools. It receives the ToolCliContext interface from
 * @opensip-tools/core and uses it for setExitCode + logger.
 *
 * History: v0.2 originally registered three subcommands (`graph`,
 * `graph-orphans`, `graph-entry-points`). The orphans and entry-points
 * subcommands were folded into the unified `graph` output — all three
 * data slices (rules, entry points, catalog summary) are reachable via
 * the single `graph` invocation.
 */

import { applyCommonFlags, type CliProgram } from '@opensip-tools/contracts';
import { ConfigurationError, logger, readPackageVersion, ValidationError } from '@opensip-tools/core';

// PR 3 of plan 2026-05-23-plan-graph-adapter-package-split.md: the
// engine no longer hosts adapter source. First-party adapters live in
// their own packages and register via the CLI's discovery walker
// (register-graph-adapters.ts). The historical engine-side bootstrap is
// gone.
import { exportGraphBaseline } from './cli/baseline-export.js';
import { buildGraphRecipeCatalog, buildGraphRuleCatalog } from './cli/dashboard-data.js';
import { runCatalogJsonMode } from './cli/graph-modes.js';
import { renderGraphLive } from './cli/graph-runner.js';
import { executeGraph, handleGraphError } from './cli/graph.js';
import { runHeapPreflight } from './cli/heap-preflight.js';
import { executeListFiles } from './cli/list-files.js';
import { listGraphRecipes } from './cli/list-graph-recipes.js';
import { executeLookup } from './cli/lookup.js';
import { loadGraphConfig, runGraph } from './cli/orchestrate.js';
import { runSarifExportMode } from './cli/sarif-export.js';
import { executeShardWorker } from './cli/shard-worker.js';
import { executeSymbolIndex } from './cli/symbol-index.js';
import { createAdapterRegistry, getDiscoveredAdapters } from './lang-adapter/registry.js';
import { CatalogRepo } from './persistence/catalog-repo.js';
import { createRecipeRegistry } from './recipes/registry.js';
import { resolveRecipeToRules } from './recipes/resolve.js';
import { createRulesRegistry } from './rules/registry.js';
// Side-effect import: ensures the RunScope.graph augmentation is
// loaded so `scope.graph` is correctly-typed here.
import './scope-augmentation.js';

import type { GraphConfig, ResolutionMode, Rule } from './types.js';
import type { ScopeContribution, Tool, ToolCliContext, ToolCommandDescriptor, ToolScope } from '@opensip-tools/core';
import type { DataStore } from '@opensip-tools/datastore';

/**
 * Validate and normalize the raw `--resolution` string into a
 * `ResolutionMode`. Commander defaults the flag to `'exact'`, so a value
 * is always present; anything other than `exact`/`fast` is a user typo
 * and fails loudly with a ValidationError rather than silently degrading.
 */
function parseResolutionMode(raw: string | undefined): ResolutionMode {
  if (raw === undefined || raw === 'exact') return 'exact';
  if (raw === 'fast') return 'fast';
  throw new ValidationError(
    `--resolution must be 'exact' or 'fast' (got '${raw}').`,
  );
}

const GRAPH: ToolCommandDescriptor = {
  name: 'graph',
  description:
    'Run static call-graph analysis (rules, entry points, catalog summary in one report)',
};

const GRAPH_LOOKUP: ToolCommandDescriptor = {
  name: 'graph-lookup',
  description: 'Look up function occurrences by simple name from the persisted catalog',
};

const GRAPH_SYMBOL_INDEX: ToolCommandDescriptor = {
  name: 'graph-symbol-index',
  description: 'Emit a symbolindex.json artifact (name→file:line and file→names) from the persisted catalog',
};

const GRAPH_BASELINE_EXPORT: ToolCommandDescriptor = {
  name: 'graph-baseline-export',
  description: 'Export the graph gate baseline (JSON) from the datastore to a file',
};

const GRAPH_SHARD_WORKER: ToolCommandDescriptor = {
  name: 'graph-shard-worker',
  description:
    '[internal] Build one shard from a spec file and emit a ShardBuildResult JSON (spawned by the sharded build)',
};

const GRAPH_CATALOG_EXPORT: ToolCommandDescriptor = {
  name: 'catalog-export',
  description:
    'Run graph analysis and write the CatalogExport JSON document (symbols + edges + provenance) to a file',
};

const GRAPH_SARIF_EXPORT: ToolCommandDescriptor = {
  name: 'sarif-export',
  description:
    'Run graph analysis and write OpenSIP-convention SARIF v2.1.0 findings to a file',
};

const GRAPH_RECIPES: ToolCommandDescriptor = {
  name: 'graph-recipes',
  description: 'List available graph recipes',
  aliases: ['list-graph-recipes'],
};

// Shared --cwd option flag + description (the `graph`, symbol-index,
// baseline-export, and the two export subcommands all target a directory).
// Deduped to one literal each.
const OPT_CWD = '--cwd <path>';
const OPT_DESC_CWD = 'Target directory';

// Live-view key graph contributes to the CLI's renderer registry. Owned
// by this package — the CLI dispatcher does NOT key off this literal;
// each tool decides its own live-view name.
const GRAPH_LIVE_VIEW_KEY = 'graph';

function register(cli: ToolCliContext): void {
  // `CliProgram` is contracts' alias for commander's `Command` —
  // contracts already declares commander as an optional peer dep.
  // Audit 2026-05-23 G6.
  const program = cli.program as CliProgram;

  // Contract guard: the live-view key the tool registers under MUST
  // equal the tool's metadata id. They are equal today by convention;
  // pinning the equality at register-time prevents silent drift if a
  // future refactor renames one without the other. Audit 2026-05-23
  // N-1.
  if (GRAPH_LIVE_VIEW_KEY !== graphTool.metadata.id) {
    throw new ConfigurationError(
      `graph live-view key '${GRAPH_LIVE_VIEW_KEY}' must equal tool id '${graphTool.metadata.id}'`,
    );
  }

  // Contribute graph's live view to the CLI's renderer registry.
  // Layer 5 Phase 3 (audit 2026-05-23 F3): graph owns its own Ink/
  // React renderer (`renderGraphLive` in `cli/graph-runner.tsx`) and
  // registers it directly. The prior `cli.builtinLiveViews` self-
  // lookup handshake is gone — adding a fourth tool with a live view
  // requires zero CLI edits.
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
      },
      cli.scope.datastore() as DataStore | undefined,
      { setExitCode: cli.setExitCode },
    );
  });

  // Mount each subcommand block. Order preserved exactly (graph,
  // graph-lookup, graph-shard-worker, graph-symbol-index,
  // graph-baseline-export, catalog-export, sarif-export, graph-recipes)
  // — the blocks were extracted verbatim into focused helpers below to
  // keep this orchestrator readable (graph:large-function).
  registerGraphCommand(program, cli);
  registerGraphLookupCommand(program, cli);
  registerGraphShardWorkerCommand(program, cli);
  registerGraphSymbolIndexCommand(program, cli);
  registerGraphBaselineExportCommand(program, cli);
  registerGraphCatalogExportCommand(program, cli);
  registerGraphSarifExportCommand(program, cli);
  registerGraphRecipesCommand(program, cli);
}

/** Mount the unified `graph` subcommand (rules, entry points, catalog summary). */
function registerGraphCommand(program: CliProgram, cli: ToolCliContext): void {
  const graphCmd = program
    .command(GRAPH.name)
    .description(GRAPH.description)
    .argument('[paths...]', 'Subtrees to analyze (default: whole project)')
    .option('--no-cache', 'Skip catalog cache (force full rebuild)')
    .option(
      '--resolution <mode>',
      'Edge resolution tier: exact (semantic) or fast (syntactic, no type checker)',
      'exact',
    )
    .option('--recipe <name>', 'Run a named recipe (a subset of graph rules). Default: all rules')
    .option('--gate-save', 'Save current Signal set as the gate baseline', false)
    .option('--gate-compare', 'Compare current Signals to the gate baseline', false)
    .option('--profile <path>', 'Write graph performance profile JSON to path')
    .option(
      '--workspace',
      'Fan out across detected workspace units (memory-isolated; polyglot)',
      false,
    )
    .option(
      '--concurrency <n>',
      'Concurrency cap for --workspace (default: cpus()-1)',
      (v) => Number.parseInt(v, 10),
    )
    .option(
      '--language <name>',
      'Force a specific language adapter (suppresses auto-detection)',
    )
    .option(
      '--list-files',
      'List the source files graph would discover for this scope and exit (no build; honors [paths...], --workspace, --language, --json)',
      false,
    );
  // Common cross-tool flags from the single registry (ADR-0021): --cwd, --json,
  // --quiet, --verbose, --debug, --report-to, --api-key. graph-specific flags
  // stay declared above.
  applyCommonFlags(
    graphCmd,
    ['cwd', 'json', 'quiet', 'verbose', 'debug', 'reportTo', 'apiKey'],
    { cwd: process.cwd() },
  );
  graphCmd
    .action(async (paths: readonly string[], opts: {
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
      resolution?: string;
      listFiles?: boolean;
    }) => {
      // Validate --resolution at the boundary so a typo fails loudly
      // rather than silently falling back to exact. Covers every
      // downstream path (interactive live view, executeGraph, workspace
      // fan-out) since they all branch off this single action.
      const resolution = parseResolutionMode(opts.resolution);

      // --list-files short-circuits to discovery-only: print the resolved
      // source-file set for this scope and exit, BEFORE heap preflight or any
      // catalog build. Reuses the same scoping flags (paths / --workspace /
      // --language) and honors --json.
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
        await cli.renderLive(GRAPH_LIVE_VIEW_KEY, {
          cwd: opts.cwd,
          noCache: opts.cache === false,
          verbose: opts.verbose === true,
          quiet: opts.quiet === true,
          resolution,
          // Resolve `--recipe` here (the action runs inside the entered
          // RunScope via the pre-action hook) and pass the rule subset into
          // the live path for parity with `executeGraph`. Avoids a second
          // scope read inside the React tree. An unknown name throws a
          // ConfigurationError, caught by the dispatcher.
          rules: resolveRecipeToRules(opts.recipe),
          // Honor the project's `graph:` config block in the interactive
          // path too — parity with `executeGraph` (graph.ts), which loads
          // it via the same helper. Loading here (not inside the React
          // runner) keeps the fs read on the dispatch seam.
          config: loadGraphConfig(opts.cwd),
        });
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
    });
}

/** Mount `graph-lookup` — look up function occurrences by simple name. */
function registerGraphLookupCommand(program: CliProgram, cli: ToolCliContext): void {
  program
    .command(GRAPH_LOOKUP.name)
    .description(GRAPH_LOOKUP.description)
    .argument('<name>', 'Function simple name to look up (e.g. "saveBaseline")')
    .option('--json', 'Output structured JSON', false)
    .action(async (name: string, opts: { json?: boolean }) => {
      await executeLookup({ name, json: opts.json }, cli);
    });
}

/** Mount `graph-shard-worker` — [internal] build one shard from a spec file. */
function registerGraphShardWorkerCommand(program: CliProgram, cli: ToolCliContext): void {
  program
    .command(GRAPH_SHARD_WORKER.name)
    .description(GRAPH_SHARD_WORKER.description)
    .argument('<specPath>', 'Path to a JSON ShardWorkerSpec file')
    .action(async (specPath: string) => {
      await executeShardWorker(specPath, cli);
    });
}

/** Mount `graph-symbol-index` — emit a symbolindex.json artifact. */
function registerGraphSymbolIndexCommand(program: CliProgram, cli: ToolCliContext): void {
  program
    .command(GRAPH_SYMBOL_INDEX.name)
    .description(GRAPH_SYMBOL_INDEX.description)
    .option(OPT_CWD, 'Target directory (out path resolves against this)', process.cwd())
    .option('--out <path>', 'Output file path', 'symbolindex.json')
    .action((opts: { cwd: string; out: string }) => {
      executeSymbolIndex({ cwd: opts.cwd, out: opts.out }, cli);
    });
}

/** Mount `graph-baseline-export` — export the graph gate baseline (JSON). */
function registerGraphBaselineExportCommand(program: CliProgram, cli: ToolCliContext): void {
  program
    .command(GRAPH_BASELINE_EXPORT.name)
    .description(GRAPH_BASELINE_EXPORT.description)
    .requiredOption('--out <path>', 'Output file path for the JSON baseline')
    .option(OPT_CWD, OPT_DESC_CWD, process.cwd())
    .option('--json', 'Output structured JSON', false)
    .action((opts: { cwd: string; out: string; json?: boolean }) => {
      const datastore = cli.scope.datastore() as DataStore;
      const result = exportGraphBaseline(datastore, opts.out);
      if (result.type === 'error') {
        cli.setExitCode(result.exitCode);
        if (opts.json === true) {
          cli.emitJson({ error: result.message });
          return;
        }
        process.stderr.write(`Error: ${result.message}\n`);
        return;
      }
      if (opts.json === true) {
        cli.emitJson(result);
        return;
      }
      process.stdout.write(
        `Exported graph baseline to ${result.outPath} ` +
          `(${String(result.fingerprintCount)} fingerprint(s), ${String(result.bytesWritten)} bytes)\n`,
      );
    });
}

/**
 * Mount `catalog-export` — dedicated subcommand carrying the catalog-JSON
 * renderer + machine flags (`--catalog-output`/`--tenant-id`/`--repo-id`/
 * `--git-sha`). This is the CLI contract the opensip
 * `EngineSubprocessPort.runCatalogExport` spawns (DEC-498). The flags live
 * here, NOT on `graph` — the v1 `graph --catalog-output` shape was retired
 * by the split, so docs/consumers must target `catalog-export`.
 */
function registerGraphCatalogExportCommand(program: CliProgram, cli: ToolCliContext): void {
  program
    .command(GRAPH_CATALOG_EXPORT.name)
    .description(GRAPH_CATALOG_EXPORT.description)
    .requiredOption('--catalog-output <path>', 'Output file path for the CatalogExport JSON')
    .requiredOption('--tenant-id <id>', 'Tenant scope stamped on every row + provenance')
    .requiredOption('--repo-id <id>', 'Repository scope stamped on every row')
    .requiredOption('--git-sha <sha>', 'Commit SHA the catalog was extracted at')
    .option('--run-id <uuid>', 'Run id for provenance (auto-generated if absent)')
    .option(
      '--mode <mode>',
      "'initial' (full rebuild) or 'incremental' (reuse cache when present)",
      'initial',
    )
    .option(
      '--changed-file <relPath>',
      'Changed file (repeatable). Advisory today — the engine derives the true changed set from fingerprint diffs; recorded for observability.',
      (val: string, acc: string[]) => [...acc, val],
      [] as string[],
    )
    .option(OPT_CWD, OPT_DESC_CWD, process.cwd())
    .option('--language <name>', 'Force a specific language adapter (suppresses auto-detection)')
    .option(
      '--resolution <mode>',
      'Edge resolution tier: exact (semantic) or fast (syntactic, no type checker)',
      'exact',
    )
    .action(async (opts: {
      catalogOutput: string;
      tenantId: string;
      repoId: string;
      gitSha: string;
      runId?: string;
      mode?: string;
      changedFile?: readonly string[];
      cwd: string;
      language?: string;
      resolution?: string;
    }) => {
      const startedAt = new Date().toISOString();
      try {
        const resolution = parseResolutionMode(opts.resolution);
        const incremental = opts.mode === 'incremental';
        const changedFiles = opts.changedFile ?? [];
        if (incremental && changedFiles.length > 0) {
          // Advisory only: the incremental path self-derives the changed
          // set from on-disk fingerprint diffs, so a caller-supplied set
          // does not (yet) narrow the walk. Logged for observability.
          logger.info({
            evt: 'graph.cli.catalog_export.changed_files_advisory',
            module: 'graph:cli',
            runId: opts.runId,
            changedFileCount: changedFiles.length,
          });
        }
        const result = await runGraph({
          cwd: opts.cwd,
          noCache: !incremental,
          resolution,
          language: opts.language,
          datastore: cli.scope.datastore() as DataStore | undefined,
        });
        runCatalogJsonMode(
          {
            cwd: opts.cwd,
            catalogOutput: opts.catalogOutput,
            tenantId: opts.tenantId,
            repoId: opts.repoId,
            gitSha: opts.gitSha,
            runId: opts.runId,
          },
          result,
          cli,
          startedAt,
        );
      } catch (error) {
        handleGraphError('catalog-export', error, cli);
      }
    });
}

/**
 * Mount `sarif-export` — runs the pipeline and writes OpenSIP-convention
 * SARIF to a file, matching the opensip `EngineSubprocessPort.runSarifExport`
 * contract (DEC-498). Always a full run (findings, not incremental).
 */
function registerGraphSarifExportCommand(program: CliProgram, cli: ToolCliContext): void {
  program
    .command(GRAPH_SARIF_EXPORT.name)
    .description(GRAPH_SARIF_EXPORT.description)
    .requiredOption('--output-sarif <path>', 'Output file path for the SARIF v2.1.0 document')
    .requiredOption('--tenant-id <id>', 'Tenant scope for the run')
    .requiredOption('--repo-id <id>', 'Repository scope for the run')
    .option('--run-id <uuid>', 'Run id for trace correlation (auto-generated if absent)')
    .option(OPT_CWD, OPT_DESC_CWD, process.cwd())
    .option('--language <name>', 'Force a specific language adapter (suppresses auto-detection)')
    .option(
      '--resolution <mode>',
      'Edge resolution tier: exact (semantic) or fast (syntactic, no type checker)',
      'exact',
    )
    .action(async (opts: {
      outputSarif: string;
      tenantId: string;
      repoId: string;
      runId?: string;
      cwd: string;
      language?: string;
      resolution?: string;
    }) => {
      try {
        const resolution = parseResolutionMode(opts.resolution);
        const result = await runGraph({
          cwd: opts.cwd,
          noCache: true,
          resolution,
          language: opts.language,
          datastore: cli.scope.datastore() as DataStore | undefined,
        });
        await runSarifExportMode(
          {
            outputSarif: opts.outputSarif,
            tenantId: opts.tenantId,
            repoId: opts.repoId,
            runId: opts.runId,
          },
          result.signals,
          cli,
        );
      } catch (error) {
        handleGraphError('sarif-export', error, cli);
      }
    });
}

/**
 * Mount `graph-recipes` — list available graph recipes (mirrors fit-recipes).
 * Reuses the shared ListRecipesResult contract + viewListRecipes renderer.
 */
function registerGraphRecipesCommand(program: CliProgram, cli: ToolCliContext): void {
  const graphRecipesCmd = program
    .command(GRAPH_RECIPES.name)
    .description(GRAPH_RECIPES.description);
  for (const alias of GRAPH_RECIPES.aliases ?? []) graphRecipesCmd.alias(alias);
  graphRecipesCmd
    .option('--json', 'Output structured JSON', false)
    .action(async (opts: { json?: boolean }) => {
      const result = await listGraphRecipes();
      if (opts.json === true) {
        cli.emitJson(result);
        return;
      }
      await cli.render(result);
    });
}

/**
 * Per-run subscope contribution (D7). Called by the CLI's pre-action-hook
 * after constructing the scope and before entering it; the kernel installs
 * the returned `graph` slot. Fresh adapter + rule registries per run so
 * concurrent scopes carry independent graph state.
 *
 * Adapter seeding: graph-adapter packages are discovered at CLI startup
 * (before any scope exists) and stashed via `setDiscoveredAdapters`.
 * `contributeScope` reads that list and re-registers each adapter into
 * this run's fresh registry so the orchestrator's `pickAdapter` resolves
 * them.
 */
function contributeScope(): ScopeContribution {
  const adapters = createAdapterRegistry();
  for (const adapter of getDiscoveredAdapters()) {
    adapters.register(adapter);
  }
  return {
    graph: {
      adapters,
      rules: createRulesRegistry(),
      recipes: createRecipeRegistry(),
    },
  };
}

/**
 * Dashboard-data contribution (audit 2026-05-29, L2). Graph owns its
 * Code Paths panel data: it returns the graph catalog (via its own
 * `CatalogRepo`) under the `graphCatalog` key that `generateDashboardHtml`
 * consumes. Best-effort — a missing/empty catalog yields no contribution
 * and the panel renders a no-data state. This is what lets the CLI
 * compose the cross-tool dashboard without fitness reaching into graph.
 *
 * The returned `graphCatalog.features` (Plan C) is populated when the
 * producing `graph` run requested the dashboard columns
 * (`['blast','scc','packageCoupling']`, see `executeGraph`); it rides on the
 * loaded contract for free via `loadCatalogContract`. This stays a pure read
 * — no on-demand engine compute at dashboard-compose time (ADR-0006). When a
 * catalog was produced by a non-dashboard run, `features` is absent and the
 * panel renders a no-data state.
 */
function collectDashboardData(scope: ToolScope): Record<string, unknown> {
  // Rule + recipe catalogs are cheap, scope-only reads (no I/O). A run
  // without the graph subscope yields empty arrays, not a throw. These use
  // DISTINCT keys from fitness's `checkCatalog`/`recipeCatalog` (which the
  // CLI merges via Object.assign) so graph never clobbers fitness.
  const graphRuleCatalog = buildGraphRuleCatalog(scope);
  const graphRecipeCatalog = buildGraphRecipeCatalog(scope);

  const datastore = scope.datastore() as DataStore | undefined;
  if (!datastore) return { graphRuleCatalog, graphRecipeCatalog };
  try {
    return {
      graphCatalog: new CatalogRepo(datastore).loadCatalogContract(),
      graphRuleCatalog,
      graphRecipeCatalog,
    };
  } catch (error) {
    // No catalog (or an unreadable one) → the panel renders its no-data
    // state. Log at debug so the empty-result path is traceable rather
    // than silent.
    logger.debug({
      evt: 'graph.dashboard.catalog_load_failed',
      module: 'graph:tool',
      err: error instanceof Error ? error.message : String(error),
    });
    return { graphRuleCatalog, graphRecipeCatalog };
  }
}

export const graphTool: Tool = {
  metadata: {
    id: 'graph',
    version: readPackageVersion(import.meta.url),
    description: 'Static call-graph + dead-end analysis',
  },
  commands: [GRAPH, GRAPH_LOOKUP, GRAPH_SYMBOL_INDEX, GRAPH_BASELINE_EXPORT, GRAPH_SHARD_WORKER, GRAPH_CATALOG_EXPORT, GRAPH_SARIF_EXPORT, GRAPH_RECIPES],
  register,
  contributeScope,
  collectDashboardData,
};
