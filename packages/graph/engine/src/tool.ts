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


import { executeGraph } from './cli/graph.js';

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
      'Scope the run to a single workspace package (faster on monorepos; cross-package call sites become unresolved)',
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
    }) => {
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
