/**
 * simulationTool — simulation as a Tool plugin.
 *
 * Owns the `sim` subcommand's Commander wiring. The CLI calls
 * register() once at startup; this file owns the option-parsing
 * surface, JSON/Ink dispatch, and dashboard auto-open hook.
 */

import { EXIT_CODES } from '@opensip-tools/contracts';
import { readPackageVersion } from '@opensip-tools/core';
import { type Command } from 'commander';

import { executeSim } from './cli/sim.js';


// eslint-disable-next-line sonarjs/deprecation -- intentional adapter usage; sim's tool.ts bridges per-command ToolOptions to executeSim's legacy CliArgs shape via toolOptsToCliArgs
import type { CliArgs, ToolOptions } from '@opensip-tools/contracts';
import type { Tool, ToolCliContext, ToolCommandDescriptor } from '@opensip-tools/core';


const SIM: ToolCommandDescriptor = {
  name: 'sim',
  description: 'Run simulation scenarios [experimental]',
};

function toolOptsToCliArgs(
  command: string,
  opts: ToolOptions & { recipe?: string; kind?: string },
  // eslint-disable-next-line sonarjs/deprecation -- intentional adapter usage; CliArgs bridge
): CliArgs {
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
    ...(opts.recipe ? { recipe: opts.recipe } : {}),
    ...(opts.kind ? { kind: opts.kind } : {}),
  };
}

function register(cli: ToolCliContext): void {
  const program = cli.program as Command;

  program
    .command(SIM.name)
    .description(SIM.description)
    .option('--recipe <name>', 'Run a named sim recipe (default: built-in `default`)')
    .option('--cwd <path>', 'Target directory', process.cwd())
    .option('--json', 'Output structured JSON', false)
    .option('-q, --quiet', 'Suppress banner / boxes; print only the pass-fail summary', false)
    .option('--open', 'Launch the HTML dashboard in your browser after the run completes', false)
    .option('--kind <kind>', 'Filter scenarios by kind (load | chaos | invariant | fix-evaluation)')
    .option('--debug', 'Enable debug mode for structured log output', false)
    .action(
      async (
        opts: ToolOptions & { recipe?: string; quiet?: boolean; open?: boolean; kind?: string },
      ) => {
        const args = toolOptsToCliArgs('sim', opts);
        const { result } = await executeSim(args);

        if (args.json) {
          if (result.type === 'error') {
            cli.setExitCode(result.exitCode);
            process.stdout.write(JSON.stringify({ error: result.message }, null, 2) + '\n');
          } else {
            if (result.shouldFail === true) cli.setExitCode(EXIT_CODES.RUNTIME_ERROR);
            process.stdout.write(JSON.stringify(result, null, 2) + '\n');
          }
          return;
        }

        if (result.type === 'error') {
          cli.setExitCode(result.exitCode);
          await cli.render(result);
          return;
        }

        if (result.shouldFail === true) cli.setExitCode(EXIT_CODES.RUNTIME_ERROR);
        await cli.render(result);

        await cli.maybeOpenDashboard({
          openRequested: Boolean(opts.open),
          jsonOutput: Boolean(args.json),
          cwd: args.cwd,
        });
      },
    );
}

export const simulationTool: Tool = {
  metadata: {
    id: 'simulation',
    version: readPackageVersion(import.meta.url),
    description: 'Run simulation scenarios against a codebase',
  },
  commands: [SIM],
  register,
};
