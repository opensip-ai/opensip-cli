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

import { readPackageVersion } from '@opensip-tools/core';
import { type Command } from 'commander';

// Side-effect import: registers the first-party TypeScript adapter
// at module load. PR 3 of docs/plans/10-graph-language-pluggability.md.
import './bootstrap.js';
import { executeGraph } from './cli/graph.js';
import { runHeapPreflight } from './cli/heap-preflight.js';

import type { Tool, ToolCliContext, ToolCommandDescriptor } from '@opensip-tools/core';

const GRAPH: ToolCommandDescriptor = {
  name: 'graph',
  description:
    'Run static call-graph analysis (rules, entry points, catalog summary in one report)',
};

function register(cli: ToolCliContext): void {
  const program = cli.program as Command;

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
        /* v8 ignore next -- reExec branch only fires in production
           when the heap actually needs elevation; tested manually. */
        if (reExecing) return;
      }

      const isInteractiveDefault =
        opts.json !== true
        && opts.gateSave !== true
        && opts.gateCompare !== true
        /* v8 ignore next -- reportTo as an empty-string is defensive;
           Commander emits string|undefined, never empty string. */
        && (typeof opts.reportTo !== 'string' || opts.reportTo.length === 0)
        && opts.packages !== true
        /* v8 ignore next -- package as an empty-string is defensive;
           Commander emits string|undefined, never empty string. */
        && (typeof opts.package !== 'string' || opts.package.length === 0);

      if (isInteractiveDefault) {
        await cli.renderLive('graph', {
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
}

export const graphTool: Tool = {
  metadata: {
    id: 'graph',
    version: readPackageVersion(import.meta.url),
    description: 'Static call-graph + dead-end analysis',
  },
  commands: [GRAPH],
  register,
};
