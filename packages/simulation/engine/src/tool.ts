/**
 * simulationTool — simulation as a Tool plugin.
 *
 * Owns the `sim` subcommand's Commander wiring. The CLI calls
 * register() once at startup; this file owns the option-parsing
 * surface, JSON/Ink dispatch, and dashboard auto-open hook.
 */

import { applyCommonFlags, EXIT_CODES, type CliProgram, type ToolOptions } from '@opensip-tools/contracts';
import { readPackageVersion } from '@opensip-tools/core';

import { simulationConfigDeclaration } from './cli/sim-config-schema.js';
import { renderSimLive } from './cli/sim-runner.js';
import { executeSim } from './cli/sim.js';
import { createScenarioRegistry, currentScenarioRegistry } from './framework/registry.js';
import { SIM_PLUGIN_LAYOUT } from './plugins/loader.js';
import { createSimulationRecipeRegistry } from './recipes/registry.js';
// Side-effect import: ensures the RunScope.simulation augmentation is
// loaded so `scope.simulation` is the correctly-typed slot here.
import './scope-augmentation.js';

import type { RunnableScenario } from './framework/runnable-scenario.js';
import type { CapabilityRegistrar, ScopeContribution, Tool, ToolCliContext, ToolCommandDescriptor } from '@opensip-tools/core';


const SIM: ToolCommandDescriptor = {
  name: 'sim',
  description: 'Run simulation scenarios [experimental]',
};

// Live-view key — matches the `sim` subcommand name so the dispatcher's
// renderLive(key) lookup resolves it (ADR-0016). sim's Ink/React renderer
// (renderSimLive) is registered directly; the prior static-only path remains
// for json / non-TTY runs.
const SIM_LIVE_VIEW_KEY = 'sim';

function register(cli: ToolCliContext): void {
  // `CliProgram` is contracts' alias for commander's `Command` —
  // contracts already declares commander as an optional peer dep.
  // Audit 2026-05-23 G6.
  const program = cli.program as CliProgram;

  // Contribute sim's live view (ADR-0016). Effectful egress (cloud +
  // `--report-to`) lives at the composition root: renderSimLive returns the
  // run's envelope and this callback delivers it once the Ink app exits — the
  // same contract fit uses.
  cli.registerLiveView(SIM_LIVE_VIEW_KEY, async (args) => {
    const simArgs = args as ToolOptions;
    const envelope = await renderSimLive(simArgs, { setExitCode: cli.setExitCode });
    if (envelope !== undefined) {
      await cli.deliverSignals(envelope, {
        cwd: simArgs.cwd,
        reportTo: simArgs.reportTo,
        apiKey: simArgs.apiKey,
        runFailed: !envelope.verdict.passed,
      });
    }
  });

  const simCmd = program
    .command(SIM.name)
    .description(SIM.description)
    .option('--recipe <name>', 'Run a named sim recipe (default: built-in `default`)');
  // Common cross-tool flags from the single registry (ADR-0021): --cwd, --json,
  // --quiet, --verbose, --debug, --report-to, --api-key, --open. sim gained
  // -v/--verbose here (per-scenario detail).
  applyCommonFlags(
    simCmd,
    ['cwd', 'json', 'quiet', 'verbose', 'debug', 'reportTo', 'apiKey', 'open'],
    { cwd: process.cwd() },
  );
  simCmd
    .action(
      async (
        opts: ToolOptions & { recipe?: string; quiet?: boolean; open?: boolean; verbose?: boolean },
      ) => {
        // Interactive TTY (non-json): the animated live view. Egress + exit code
        // are handled inside the registerLiveView callback / renderSimLive after
        // the Ink app exits.
        if (opts.json !== true && process.stdout.isTTY === true) {
          await cli.renderLive(SIM_LIVE_VIEW_KEY, opts);
          await cli.maybeOpenDashboard({ openRequested: Boolean(opts.open), jsonOutput: false });
          return;
        }

        // json / non-TTY (pipe / CI): run the engine and render statically — the
        // animated Ink view is a TTY-only affordance. Output is byte-for-byte the
        // pre-live-view behavior.
        const { result } = await executeSim(opts);

        if (result.type === 'error') {
          cli.setExitCode(result.exitCode);
          if (opts.json) {
            cli.emitJson({ error: result.message });
          } else {
            await cli.render(result);
          }
          return;
        }

        if (result.shouldFail === true) cli.setExitCode(EXIT_CODES.RUNTIME_ERROR);

        // ADR-0011: one render path per mode. `--json` emits the envelope
        // through the shared formatSignalJson; default renders the envelope-
        // derived per-scenario table.
        if (opts.json) {
          cli.emitEnvelope(result.envelope);
        } else {
          await cli.render(result);
        }

        // Effectful egress lives at the root (cloud sink + `--report-to`,
        // which owns exit 4). Called once per run, after rendering.
        await cli.deliverSignals(result.envelope, {
          cwd: process.cwd(),
          reportTo: opts.reportTo,
          apiKey: opts.apiKey,
          runFailed: result.shouldFail,
        });

        await cli.maybeOpenDashboard({
          openRequested: Boolean(opts.open),
          jsonOutput: Boolean(opts.json),
        });
      },
    );
}

/**
 * The simulation tool's REAL registrar for its `sim-pack` capability domain
 * (§5.3 / Phase 4). The host registers the domain from sim's manifest with a
 * deferred placeholder, then swaps in this registrar once sim's module loads.
 * A routed contribution (host-checked against `requiredKeys: ['id']`) is
 * registered into THIS run's scope-owned scenario registry.
 */
const registerSimScenario: CapabilityRegistrar = (contribution) => {
  currentScenarioRegistry().register(contribution as RunnableScenario);
};

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
  pluginLayout: SIM_PLUGIN_LAYOUT,
  register,
  contributeScope,
  // ADR-0023 Phase 4: simulation contributes its namespaced `simulation:` Zod
  // schema so the host composes + strict-validates the whole config document
  // before dispatch.
  config: simulationConfigDeclaration,
  // §5.3 Phase 4: simulation owns the `sim-pack` capability domain (declared in
  // its manifest). It supplies the REAL registrar so the host can replace the
  // manifest-time deferred placeholder once sim's module loads.
  capabilityRegistrars: { 'sim-pack': registerSimScenario },
};
