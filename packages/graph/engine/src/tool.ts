/**
 * graphTool — graph as a Tool plugin.
 *
 * Owns the Commander wiring for `graph`, `graph-orphans`, and
 * `graph-entry-points`. The CLI calls register() once at startup; this
 * file owns the option-parsing surface and dispatches to the
 * cli/<command>.ts handlers.
 *
 * Per spec §10A AC-2 / AC-1: this module does NOT import from
 * @opensip-tools/cli. It receives the ToolCliContext interface from
 * @opensip-tools/core and uses it for setExitCode + logger.
 */

import { type Command } from 'commander';

import { executeGraphEntryPoints } from './cli/graph-entry-points.js';
import { executeGraphOrphans } from './cli/graph-orphans.js';
import { executeGraph } from './cli/graph.js';

import type { Tool, ToolCliContext, ToolCommandDescriptor } from '@opensip-tools/core';

const GRAPH: ToolCommandDescriptor = {
  name: 'graph',
  description: 'Run static call-graph analysis (orphans, duplicates, dead branches)',
};

const GRAPH_ORPHANS: ToolCommandDescriptor = {
  name: 'graph-orphans',
  description: 'List orphan-subtree findings only',
};

const GRAPH_ENTRY_POINTS: ToolCommandDescriptor = {
  name: 'graph-entry-points',
  description: 'List inferred entry points for the project',
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
    .option('--debug', 'Enable debug mode for structured log output', false)
    .action(async (opts: {
      cwd: string;
      json?: boolean;
      cache?: boolean;
      gateSave?: boolean;
      gateCompare?: boolean;
      baseline?: string;
      reportTo?: string;
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
        },
        cli,
      );
    });

  program
    .command(GRAPH_ORPHANS.name)
    .description(GRAPH_ORPHANS.description)
    .option('--cwd <path>', 'Target directory', process.cwd())
    .option('--json', 'Output structured JSON', false)
    .option('--debug', 'Enable debug mode for structured log output', false)
    .action(async (opts: { cwd: string; json?: boolean }) => {
      await executeGraphOrphans({ cwd: opts.cwd, json: opts.json }, cli);
    });

  program
    .command(GRAPH_ENTRY_POINTS.name)
    .description(GRAPH_ENTRY_POINTS.description)
    .option('--cwd <path>', 'Target directory', process.cwd())
    .option('--json', 'Output structured JSON', false)
    .option('--debug', 'Enable debug mode for structured log output', false)
    .action(async (opts: { cwd: string; json?: boolean }) => {
      await executeGraphEntryPoints({ cwd: opts.cwd, json: opts.json }, cli);
    });
}

export const graphTool: Tool = {
  metadata: {
    id: 'graph',
    version: '1.0.5',
    description: 'Static call-graph + dead-end analysis',
  },
  commands: [GRAPH, GRAPH_ORPHANS, GRAPH_ENTRY_POINTS],
  register,
};
