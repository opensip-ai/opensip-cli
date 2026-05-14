/**
 * simulationTool — simulation as a Tool plugin.
 *
 * Owns the `sim` subcommand's Commander wiring. The CLI calls
 * register() once at startup; this file owns the option-parsing
 * surface, JSON/Ink dispatch, and dashboard auto-open hook.
 */

import { EXIT_CODES } from '@opensip-tools/cli-shared';
import { type Command } from 'commander';

import { executeSim } from './cli/sim.js';

import type { CliArgs, ToolOptions } from '@opensip-tools/cli-shared';
import type { Tool, ToolCliContext, ToolCommandDescriptor } from '@opensip-tools/core';


const SIM: ToolCommandDescriptor = {
  name: 'sim',
  description: 'Run simulation scenarios [experimental]',
};

function toolOptsToCliArgs(command: string, opts: ToolOptions & { kind?: string }): CliArgs {
  return {
    command,
    json: opts.json,
    cwd: opts.cwd,
    help: false,
    list: false,
    listRecipes: false,
    verbose: false,
    exclude: [],
    findings: false,
    ...(opts.kind ? { kind: opts.kind } : {}),
  };
}

function register(cli: ToolCliContext): void {
  const program = cli.program as Command;

  program
    .command(SIM.name)
    .description(SIM.description)
    .option('--cwd <path>', 'Target directory', process.cwd())
    .option('--json', 'Output structured JSON', false)
    .option('-q, --quiet', 'Suppress banner / boxes; print only the pass-fail summary', false)
    .option('--open', 'Launch the HTML dashboard in your browser after the run completes', false)
    .option('--kind <kind>', 'Filter scenarios by kind (load | chaos | invariant | fix-evaluation)')
    .option('--debug', 'Enable debug mode for structured log output', false)
    .action(async (opts: ToolOptions & { quiet?: boolean; open?: boolean; kind?: string }) => {
      const args = toolOptsToCliArgs('sim', opts);
      const result = executeSim(args);
      if (args.json) {
        process.stdout.write(JSON.stringify(result, null, 2) + '\n');
        // executeSim is sync today and returns a stub result — no exit
        // code shaping needed here. When sim grows real outcomes, this
        // is where pass/fail mapping goes.
        return;
      }
      await cli.render(result);

      await cli.maybeOpenDashboard({
        openRequested: Boolean(opts.open),
        jsonOutput: Boolean(args.json),
        cwd: args.cwd,
      });
    });

  // Reference EXIT_CODES so the import isn't dropped — sim doesn't
  // currently set non-zero exit codes but will when scenarios fail.
  void EXIT_CODES;
}

export const simulationTool: Tool = {
  metadata: {
    id: 'simulation',
    version: '2.0.0',
    description: 'Run simulation scenarios against a codebase',
  },
  commands: [SIM],
  register,
};
