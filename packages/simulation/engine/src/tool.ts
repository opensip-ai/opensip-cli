/**
 * simulationTool — simulation as a Tool plugin.
 *
 * Owns the `sim` subcommand's Commander wiring. The CLI calls
 * register() once at startup; this file owns the option-parsing
 * surface, JSON/Ink dispatch, and dashboard auto-open hook.
 */

import { EXIT_CODES, type CliProgram, type ToolOptions } from '@opensip-tools/contracts';
import { readPackageVersion } from '@opensip-tools/core';

import { executeSim } from './cli/sim.js';
import { createScenarioRegistry } from './framework/registry.js';
import { createSimulationRecipeRegistry } from './recipes/registry.js';
// Side-effect import: ensures the RunScope.simulation augmentation is
// loaded so `scope.simulation` is the correctly-typed slot here.
import './scope-augmentation.js';

import type { ScopeContribution, Tool, ToolCliContext, ToolCommandDescriptor } from '@opensip-tools/core';


const SIM: ToolCommandDescriptor = {
  name: 'sim',
  description: 'Run simulation scenarios [experimental]',
};

function register(cli: ToolCliContext): void {
  // `CliProgram` is contracts' alias for commander's `Command` —
  // contracts already declares commander as an optional peer dep.
  // Audit 2026-05-23 G6.
  const program = cli.program as CliProgram;

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
        const { result } = await executeSim(opts);

        if (opts.json) {
          if (result.type === 'error') {
            cli.setExitCode(result.exitCode);
            cli.emitJson({ error: result.message });
          } else {
            if (result.shouldFail === true) cli.setExitCode(EXIT_CODES.RUNTIME_ERROR);
            cli.emitJson(result);
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
          jsonOutput: Boolean(opts.json),
        });
      },
    );
}

/**
 * Per-run subscope contribution (D7). Called by the CLI's pre-action-hook
 * after constructing the scope and before entering it; the kernel installs
 * the returned `simulation` slot. Fresh scenario + recipe registries per
 * run so concurrent scopes carry independent simulation state.
 */
function contributeScope(): ScopeContribution {
  return {
    simulation: {
      scenarios: createScenarioRegistry(),
      recipes: createSimulationRecipeRegistry(),
    },
  };
}

export const simulationTool: Tool = {
  metadata: {
    id: 'simulation',
    version: readPackageVersion(import.meta.url),
    description: 'Run simulation scenarios against a codebase',
  },
  commands: [SIM],
  register,
  contributeScope,
};

// Pre-load hook re-export — mirrors fitness's tool surface so a future
// CLI bootstrap that injects project-plugin auto-sync can do it
// symmetrically for both tools.
export { setPreLoadHook } from './cli/sim.js';
