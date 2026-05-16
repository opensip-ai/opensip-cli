/**
 * graphTool — graph as a Tool plugin.
 *
 * Owns the `graph`, `graph-entry-points`, and `graph-orphans` Commander
 * subcommands. The CLI calls `register(cli)` once at startup; this file
 * owns the option-parsing surface and gate-mode dispatch.
 *
 * Pattern mirrors `packages/fitness/engine/src/tool.ts` and
 * `packages/simulation/engine/src/tool.ts`.
 */

import { EXIT_CODES } from '@opensip-tools/contracts';
import { type Command } from 'commander';

import { executeEntryPoints } from './cli/entry-points.js';
import { executeGraph } from './cli/graph.js';
import { executeOrphans } from './cli/orphans.js';
import {
  saveBaseline,
  compareToBaseline,
  renderGateCompareOutput,
  GraphBaselineMissingError,
  GraphBaselineInvalidError,
  DEFAULT_GRAPH_BASELINE_PATH,
} from './gate.js';

import type { ExecuteEntryPointsResult } from './cli/entry-points.js';
import type { ExecuteOrphansResult } from './cli/orphans.js';
import type { CliOutput } from '@opensip-tools/contracts';
import type { Tool, ToolCliContext, ToolCommandDescriptor } from '@opensip-tools/core';

const GRAPH: ToolCommandDescriptor = {
  name: 'graph',
  description: 'Build the code-path graph and emit dead-end Signals',
};

const GRAPH_ENTRY_POINTS: ToolCommandDescriptor = {
  name: 'graph-entry-points',
  description: 'List inferred entry points discovered by the graph tool',
  aliases: ['entry-points'],
};

const GRAPH_ORPHANS: ToolCommandDescriptor = {
  name: 'graph-orphans',
  description: 'List orphan subtrees (the deletable slices)',
  aliases: ['orphans'],
};

interface GraphActionOpts {
  cwd: string;
  config?: string;
  json: boolean;
  verbose: boolean;
  gateSave?: boolean;
  gateCompare?: boolean;
  baseline?: string;
  noCache: boolean;
  debug: boolean;
}

function register(cli: ToolCliContext): void {
  const program = cli.program as Command;

  // -- graph -----------------------------------------------------------------
  program
    .command(GRAPH.name)
    .description(GRAPH.description)
    .option('--cwd <path>', 'Target directory', process.cwd())
    .option('--config <path>', 'Path to opensip-tools.config.yml')
    .option('--json', 'Output structured JSON', false)
    .option('-v, --verbose', 'Show per-rule reasoning inline', false)
    .option('--gate-save', 'Save current findings as graph baseline', false)
    .option('--gate-compare', 'Compare current findings against baseline; exit 1 on regression', false)
    .option('--baseline <path>', 'Baseline file path (default: opensip-tools/.runtime/graph-baseline.sarif)')
    .option('--no-cache', 'Skip the catalog cache; rebuild from scratch', false)
    .option('--debug', 'Enable debug-level structured logs', false)
    .action(async (opts: GraphActionOpts) => {
      if (opts.gateSave === true || opts.gateCompare === true) {
        await runGateMode(opts, cli);
        return;
      }

      try {
        const result = await executeGraph({ cwd: opts.cwd, noCache: opts.noCache });
        const errCount = result.output.summary.errors;
        if (errCount > 0) cli.setExitCode(EXIT_CODES.RUNTIME_ERROR);
        if (opts.json) {
          process.stdout.write(JSON.stringify(result.output, null, 2) + '\n');
          return;
        }
        printSummary(result.output, result.fromCache);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        cli.setExitCode(EXIT_CODES.RUNTIME_ERROR);
        if (opts.json) {
          process.stdout.write(JSON.stringify({ error: message }, null, 2) + '\n');
          return;
        }
        process.stderr.write(`Error: ${message}\n`);
      }
    });

  // -- graph-entry-points (alias: entry-points) ------------------------------
  const entryPointsCmd = program
    .command(GRAPH_ENTRY_POINTS.name)
    .description(GRAPH_ENTRY_POINTS.description);
  for (const alias of GRAPH_ENTRY_POINTS.aliases ?? []) entryPointsCmd.alias(alias);
  entryPointsCmd
    .option('--cwd <path>', 'Target directory', process.cwd())
    .option('--json', 'Output structured JSON', false)
    .option('--no-cache', 'Skip the catalog cache; rebuild from scratch', false)
    .option('--debug', 'Enable debug-level structured logs', false)
    .action(async (opts: { cwd: string; json: boolean; noCache: boolean; debug: boolean }) => {
      try {
        const result = await executeEntryPoints({ cwd: opts.cwd, noCache: opts.noCache });
        if (opts.json) {
          process.stdout.write(JSON.stringify(result, null, 2) + '\n');
          return;
        }
        printEntryPoints(result);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        cli.setExitCode(EXIT_CODES.RUNTIME_ERROR);
        process.stderr.write(`Error: ${message}\n`);
      }
    });

  // -- graph-orphans (alias: orphans) ----------------------------------------
  const orphansCmd = program
    .command(GRAPH_ORPHANS.name)
    .description(GRAPH_ORPHANS.description);
  for (const alias of GRAPH_ORPHANS.aliases ?? []) orphansCmd.alias(alias);
  orphansCmd
    .option('--cwd <path>', 'Target directory', process.cwd())
    .option('--json', 'Output structured JSON', false)
    .option('--no-cache', 'Skip the catalog cache; rebuild from scratch', false)
    .option('--debug', 'Enable debug-level structured logs', false)
    .action(async (opts: { cwd: string; json: boolean; noCache: boolean; debug: boolean }) => {
      try {
        const result = await executeOrphans({ cwd: opts.cwd, noCache: opts.noCache });
        if (opts.json) {
          process.stdout.write(JSON.stringify(result, null, 2) + '\n');
          return;
        }
        printOrphans(result);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        cli.setExitCode(EXIT_CODES.RUNTIME_ERROR);
        process.stderr.write(`Error: ${message}\n`);
      }
    });
}

// ---------------------------------------------------------------------------
// Gate mode
// ---------------------------------------------------------------------------

async function runGateMode(opts: GraphActionOpts, cli: ToolCliContext): Promise<void> {
  if (opts.gateSave === true && opts.gateCompare === true) {
    cli.setExitCode(EXIT_CODES.CONFIGURATION_ERROR);
    process.stderr.write('Error: --gate-save and --gate-compare are mutually exclusive.\n');
    return;
  }
  const baselinePath = opts.baseline ?? DEFAULT_GRAPH_BASELINE_PATH;

  let result;
  try {
    result = await executeGraph({ cwd: opts.cwd, noCache: opts.noCache });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    cli.setExitCode(EXIT_CODES.RUNTIME_ERROR);
    process.stderr.write(`Error: ${message}\n`);
    return;
  }

  try {
    if (opts.gateSave === true) {
      saveBaseline(result.output, baselinePath);
      const findingCount = result.output.checks.reduce((n, c) => n + c.findings.length, 0);
      process.stdout.write(`Baseline saved to ${baselinePath}\n`);
      process.stdout.write(`  ${result.output.checks.length} rule(s), ${findingCount} finding(s)\n`);
      return;
    }
    const cmp = compareToBaseline(result.output, baselinePath);
    process.stdout.write(renderGateCompareOutput(cmp) + '\n');
    cli.setExitCode(cmp.degraded ? 1 : 0);
  } catch (error) {
    if (error instanceof GraphBaselineMissingError || error instanceof GraphBaselineInvalidError) {
      cli.setExitCode(EXIT_CODES.CONFIGURATION_ERROR);
      process.stderr.write(`Error: ${error.message}\n`);
      return;
    }
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Stdout printers — minimal table-shaped output. Ink renderer integration
// lands with the dashboard PR; for v0.1 the console output is functional
// but plain.
// ---------------------------------------------------------------------------

function printSummary(output: CliOutput, fromCache: boolean): void {
  const totalFindings = output.checks.reduce((n, c) => n + c.findings.length, 0);
  process.stdout.write(`opensip-tools graph${fromCache ? ' (cached)' : ''}\n\n`);
  process.stdout.write(`Findings (${output.summary.errors} error${output.summary.errors === 1 ? '' : 's'}, ${output.summary.warnings} warning${output.summary.warnings === 1 ? '' : 's'}):\n`);
  for (const check of output.checks) {
    const sym = pickSymbol(check.findings);
    process.stdout.write(`  ${sym} ${check.checkSlug.padEnd(40)} ${check.findings.length} occurrence${check.findings.length === 1 ? '' : 's'}\n`);
  }
  process.stdout.write(`\n${totalFindings} finding${totalFindings === 1 ? '' : 's'} | Duration ${(output.durationMs / 1000).toFixed(1)}s\n`);
}

function pickSymbol(findings: CliOutput['checks'][number]['findings']): string {
  if (findings.length === 0) return '.';
  return findings.some((f) => f.severity === 'error') ? 'x' : '!';
}

function printEntryPoints(result: ExecuteEntryPointsResult): void {
  process.stdout.write(`Catalog: ${result.catalogStats.functions} functions across ${result.catalogStats.files} files\n`);
  process.stdout.write(`Entry points (${result.entryPoints.length}):\n`);
  for (const ep of result.entryPoints) {
    process.stdout.write(`  ${ep.filePath}:${ep.line}  ${ep.qualifiedName}  (${ep.heuristic})\n`);
  }
}

function printOrphans(result: ExecuteOrphansResult): void {
  process.stdout.write(`Orphan subtrees (${result.orphans.length}):\n`);
  for (const o of result.orphans) {
    process.stdout.write(
      `  ${o.filePath}:${o.line}  (${o.subtreeSize} fn, ${o.subtreeLines} lines, ${o.confidence})\n`,
    );
  }
}

// ---------------------------------------------------------------------------
// Tool export
// ---------------------------------------------------------------------------

export const graphTool: Tool = {
  metadata: {
    id: 'graph',
    version: '1.0.4',
    description: 'Code-path graph + dead-end detector (TypeScript)',
  },
  commands: [GRAPH, GRAPH_ENTRY_POINTS, GRAPH_ORPHANS],
  register,
};
