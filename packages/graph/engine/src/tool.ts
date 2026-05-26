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
import { ConfigurationError, readPackageVersion } from '@opensip-tools/core';

// PR 3 of plan 2026-05-23-plan-graph-adapter-package-split.md: the
// engine no longer hosts any adapter source. All three first-party
// adapters (typescript, python, rust) live in their own packages and
// register themselves via the CLI's discovery walker
// (register-graph-adapters.ts). The historical engine-side bootstrap
// is gone.
import { renderGraphLive } from './cli/graph-runner.js';
import { executeGraph } from './cli/graph.js';
import { runHeapPreflight } from './cli/heap-preflight.js';
import { executeLookup } from './cli/lookup.js';
import { executeSymbolIndex } from './cli/symbol-index.js';

import type { Tool, ToolCliContext, ToolCommandDescriptor } from '@opensip-tools/core';
import type { DataStore } from '@opensip-tools/datastore';

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
      args as { cwd: string; noCache?: boolean },
      cli.datastore as DataStore | undefined,
      { setExitCode: cli.setExitCode },
    );
  });

  program
    .command(GRAPH.name)
    .description(GRAPH.description)
    .option('--cwd <path>', 'Target directory', process.cwd())
    .option('--json', 'Output structured JSON', false)
    .option('--no-cache', 'Skip catalog cache (force full rebuild)')
    .option('--gate-save', 'Save current Signal set as the gate baseline', false)
    .option('--gate-compare', 'Compare current Signals to the gate baseline', false)
    .option('--baseline <path>', 'Override the default baseline path')
    .option('--report-to <url>', 'POST findings to OpenSIP Cloud or compatible')
    .option(
      '--package <name|path>',
      'Scope the run to a single workspace package (TypeScript-only; faster on monorepos; cross-package call sites become unresolved)',
    )
    .option(
      '--packages',
      'Fan the run across every workspace package under packages/** (TypeScript-only; parallel; aggregates per-package findings)',
      false,
    )
    .option(
      '--packages-concurrency <n>',
      'Concurrency cap for --packages (default: cpus()-1)',
      (v) => Number.parseInt(v, 10),
    )
    .option('--debug', 'Enable debug mode for structured log output', false)
    .action(async (opts: {
      cwd: string;
      json?: boolean;
      cache?: boolean;
      gateSave?: boolean;
      gateCompare?: boolean;
      baseline?: string;
      reportTo?: string;
      package?: string;
      packages?: boolean;
      packagesConcurrency?: number;
    }) => {
      // Preflight runs BEFORE any heavy work. If the repo's file count
      // exceeds a threshold AND the current heap cap is too low, this
      // re-execs the process with elevated `--max-old-space-size`. The
      // re-execing parent never returns from this call (it `process.exit`s
      // with the child's code), so `returned === true` only matters for
      // the type checker. Skipped when `--package <name>` is set: scoped
      // runs touch a fraction of files and don't need the global heap
      // sizing — the user has already opted into a smaller working set.
      if (typeof opts.package !== 'string' || opts.package.length === 0) {
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
        && opts.packages !== true
        /* v8 ignore next */
        && (typeof opts.package !== 'string' || opts.package.length === 0);

      if (isInteractiveDefault) {
        await cli.renderLive(GRAPH_LIVE_VIEW_KEY, {
          cwd: opts.cwd,
          noCache: opts.cache === false,
        });
        return;
      }

      await executeGraph(
        {
          cwd: opts.cwd,
          json: opts.json,
          noCache: opts.cache === false,
          gateSave: opts.gateSave,
          gateCompare: opts.gateCompare,
          baseline: opts.baseline,
          reportTo: opts.reportTo,
          packageScope: opts.package,
          allPackages: opts.packages,
          packagesConcurrency: opts.packagesConcurrency,
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
    .command(GRAPH_SYMBOL_INDEX.name)
    .description(GRAPH_SYMBOL_INDEX.description)
    .option('--cwd <path>', 'Target directory (out path resolves against this)', process.cwd())
    .option('--out <path>', 'Output file path', 'symbolindex.json')
    .action((opts: { cwd: string; out: string }) => {
      executeSymbolIndex({ cwd: opts.cwd, out: opts.out }, cli);
    });
}

export const graphTool: Tool = {
  metadata: {
    id: 'graph',
    version: readPackageVersion(import.meta.url),
    description: 'Static call-graph + dead-end analysis',
  },
  commands: [GRAPH, GRAPH_LOOKUP, GRAPH_SYMBOL_INDEX],
  register,
};
