/**
 * graphTool — graph as a Tool plugin.
 *
 * Owns the Commander wiring for the single `graph` subcommand. The CLI
 * calls register() once at startup; this file owns the option-parsing
 * surface and dispatches to cli/graph.ts.
 *
 * Per spec §10A AC-2 / AC-1: this module does NOT import from
 * @opensip-tools/cli. It receives the ToolCliContext interface from
 * @opensip-tools/core and uses it for setExitCode + logger.
 *
 * History: v0.2 originally registered three subcommands (`graph`,
 * `graph-orphans`, `graph-entry-points`). The orphans and entry-points
 * subcommands were folded into the unified `graph` output — all three
 * data slices (rules, entry points, catalog summary) are reachable via
 * the single `graph` invocation.
 */

import { type CliProgram } from '@opensip-tools/contracts';
import { ConfigurationError, logger, readPackageVersion, ValidationError } from '@opensip-tools/core';

// PR 3 of plan 2026-05-23-plan-graph-adapter-package-split.md: the
// engine no longer hosts any adapter source. All three first-party
// adapters (typescript, python, rust) live in their own packages and
// register themselves via the CLI's discovery walker
// (register-graph-adapters.ts). The historical engine-side bootstrap
// is gone.
import { exportGraphBaseline } from './cli/baseline-export.js';
import { renderGraphLive } from './cli/graph-runner.js';
import { executeGraph } from './cli/graph.js';
import { runHeapPreflight } from './cli/heap-preflight.js';
import { executeLookup } from './cli/lookup.js';
import { executeShardWorker } from './cli/shard-worker.js';
import { executeSymbolIndex } from './cli/symbol-index.js';
import { createAdapterRegistry, getDiscoveredAdapters } from './lang-adapter/registry.js';
import { CatalogRepo } from './persistence/catalog-repo.js';
import { createRulesRegistry } from './rules/registry.js';
// Side-effect import: ensures the RunScope.graph augmentation is
// loaded so `scope.graph` is correctly-typed here.
import './scope-augmentation.js';

import type { ResolutionMode } from './types.js';
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
      args as { cwd: string; noCache?: boolean; resolution?: ResolutionMode },
      cli.scope.datastore() as DataStore | undefined,
      { setExitCode: cli.setExitCode },
    );
  });

  program
    .command(GRAPH.name)
    .description(GRAPH.description)
    .argument('[paths...]', 'Subtrees to analyze (default: whole project)')
    .option('--cwd <path>', 'Target directory', process.cwd())
    .option('--json', 'Output structured JSON', false)
    .option('--no-cache', 'Skip catalog cache (force full rebuild)')
    .option(
      '--resolution <mode>',
      'Edge resolution tier: exact (semantic) or fast (syntactic, no type checker)',
      'exact',
    )
    .option('--gate-save', 'Save current Signal set as the gate baseline', false)
    .option('--gate-compare', 'Compare current Signals to the gate baseline', false)
    .option('--baseline <path>', 'Override the default baseline path')
    .option('--report-to <url>', 'POST findings to OpenSIP Cloud or compatible')
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
      '-v, --verbose',
      'Show detailed catalog, findings-by-rule, and entry-point sections in the done view (default: summary only)',
      false,
    )
    .option('--debug', 'Enable debug mode for structured log output', false)
    .action(async (paths: readonly string[], opts: {
      cwd: string;
      json?: boolean;
      cache?: boolean;
      gateSave?: boolean;
      gateCompare?: boolean;
      baseline?: string;
      reportTo?: string;
      workspace?: boolean;
      concurrency?: number;
      language?: string;
      verbose?: boolean;
      resolution?: string;
    }) => {
      // Validate --resolution at the boundary so a typo fails loudly
      // rather than silently falling back to exact. Covers every
      // downstream path (interactive live view, executeGraph, workspace
      // fan-out) since they all branch off this single action.
      const resolution = parseResolutionMode(opts.resolution);
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
        const reExecing = await runHeapPreflight({ cwd: opts.cwd });
        /* v8 ignore next */
        if (reExecing) return;
      }

      const isInteractiveDefault =
        opts.json !== true
        && opts.gateSave !== true
        && opts.gateCompare !== true
        /* v8 ignore next */
        && (typeof opts.reportTo !== 'string' || opts.reportTo.length === 0)
        && opts.workspace !== true
        && paths.length === 0
        /* v8 ignore next */
        && typeof opts.language !== 'string';

      if (isInteractiveDefault) {
        await cli.renderLive(GRAPH_LIVE_VIEW_KEY, {
          cwd: opts.cwd,
          noCache: opts.cache === false,
          verbose: opts.verbose === true,
          resolution,
        });
        return;
      }

      await executeGraph(
        {
          cwd: opts.cwd,
          json: opts.json,
          noCache: opts.cache === false,
          resolution,
          gateSave: opts.gateSave,
          gateCompare: opts.gateCompare,
          baseline: opts.baseline,
          reportTo: opts.reportTo,
          paths,
          workspace: opts.workspace,
          concurrency: opts.concurrency,
          language: opts.language,
          verbose: opts.verbose,
          cliScript: process.argv[1],
        },
        cli,
      );
    });

  program
    .command(GRAPH_LOOKUP.name)
    .description(GRAPH_LOOKUP.description)
    .argument('<name>', 'Function simple name to look up (e.g. "saveBaseline")')
    .option('--json', 'Output structured JSON', false)
    .action((name: string, opts: { json?: boolean }) => {
      executeLookup({ name, json: opts.json }, cli);
    });

  program
    .command(GRAPH_SHARD_WORKER.name)
    .description(GRAPH_SHARD_WORKER.description)
    .argument('<specPath>', 'Path to a JSON ShardWorkerSpec file')
    .action((specPath: string) => {
      executeShardWorker(specPath, cli);
    });

  program
    .command(GRAPH_SYMBOL_INDEX.name)
    .description(GRAPH_SYMBOL_INDEX.description)
    .option('--cwd <path>', 'Target directory (out path resolves against this)', process.cwd())
    .option('--out <path>', 'Output file path', 'symbolindex.json')
    .action((opts: { cwd: string; out: string }) => {
      executeSymbolIndex({ cwd: opts.cwd, out: opts.out }, cli);
    });

  program
    .command(GRAPH_BASELINE_EXPORT.name)
    .description(GRAPH_BASELINE_EXPORT.description)
    .requiredOption('--out <path>', 'Output file path for the JSON baseline')
    .option('--cwd <path>', 'Target directory', process.cwd())
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
 */
function collectDashboardData(scope: ToolScope): Record<string, unknown> {
  const datastore = scope.datastore() as DataStore | undefined;
  if (!datastore) return {};
  try {
    return { graphCatalog: new CatalogRepo(datastore).loadCatalogContract() };
  } catch (error) {
    // No catalog (or an unreadable one) → the panel renders its no-data
    // state. Log at debug so the empty-result path is traceable rather
    // than silent.
    logger.debug({
      evt: 'graph.dashboard.catalog_load_failed',
      module: 'graph:tool',
      err: error instanceof Error ? error.message : String(error),
    });
    return {};
  }
}

export const graphTool: Tool = {
  metadata: {
    id: 'graph',
    version: readPackageVersion(import.meta.url),
    description: 'Static call-graph + dead-end analysis',
  },
  commands: [GRAPH, GRAPH_LOOKUP, GRAPH_SYMBOL_INDEX, GRAPH_BASELINE_EXPORT, GRAPH_SHARD_WORKER],
  register,
  contributeScope,
  collectDashboardData,
};
