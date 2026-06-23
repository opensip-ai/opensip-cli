/**
 * simulationTool — simulation as a Tool plugin.
 *
 * Owns the `sim` subcommand. The Commander wiring is no longer hand-rolled:
 * the tool exports a
 * declarative {@link CommandSpec} (`simCommand`) and the host's
 * `mountCommandSpec` mounts it (name/description/aliases, the ADR-0021 common
 * flags, the `--recipe` option) and owns the parse→handler→error→exit pipeline.
 * This file owns only the sim runner — the `runSim` handler below — which keeps
 * the JSON/Ink dispatch, cloud egress, and report auto-open exactly as the
 * old `register()` action body did (byte-identical behaviour).
 */

import { EXIT_CODES, type StoredSession, type ToolOptions } from '@opensip-cli/contracts';
import {
  createToolScope,
  definePrimaryCommand,
  defineTool,
  readPackageVersion,
} from '@opensip-cli/core';

import { SIMULATION_IDENTITY, SIMULATION_LIVE_VIEW_KEY } from './identity.js';
import { resolveSession } from '@opensip-cli/session-store';

import { collectSimulationReportData } from './cli/report-data.js';
import { simulationConfigDeclaration } from './cli/sim-config-schema.js';
import { simRecipesCommandSpec } from './cli/sim-recipes.js';
import { renderSimLive } from './cli/sim-runner.js';
import { simRunWorkerCommandSpec } from './cli/sim-worker.js';
import { executeSim } from './cli/sim.js';
import {
  createScenarioRegistry,
  createSimulationLoadState,
  currentScenarioRegistry,
} from './framework/registry.js';
import { simReplayFromSession } from './persistence/session-replay.js';
import { SIM_PLUGIN_LAYOUT } from './plugins/loader.js';
import {
  createSimulationRecipeRegistry,
  currentSimulationRecipeRegistry,
} from './recipes/registry.js';
import { simScaffoldExamples, simStableExampleIds } from './scaffold/examples.js';
// Side-effect import: ensures the RunScope.simulation augmentation is
// loaded so `scope.simulation` is the correctly-typed slot here.
import './scope-augmentation.js';

import type { RunnableScenario } from './framework/runnable-scenario.js';
import type { SimulationRecipe } from './recipes/types.js';
import type {
  CapabilityRegistrar,
  CommandSpec,
  Tool,
  ToolCliContext,
  ToolRunCompletion,
} from '@opensip-cli/core';
import type { DataStore } from '@opensip-cli/datastore';

/** @deprecated Use {@link SIMULATION_LIVE_VIEW_KEY} from `identity.ts`. */
const SIM_LIVE_VIEW_KEY = SIMULATION_LIVE_VIEW_KEY;

/** Parsed `sim` options — the ADR-0021 common flags plus sim's `--recipe`. */
type SimOptions = ToolOptions & {
  recipe?: string;
  quiet?: boolean;
  open?: boolean;
  verbose?: boolean;
};

/**
 * Set sim's live view (ADR-0016) up on the host context — a synchronous,
 * void-returning map write (named with the `set` prefix to signal that). Its
 * effectful egress (cloud + `--report-to`) lives at the composition root:
 * renderSimLive returns the run's envelope and this callback delivers it once
 * the Ink app exits — the same contract fit uses.
 *
 * In the spec-mounted world there is no `register()` mount hook, so the handler
 * sets the renderer up lazily at the top of its body (before any
 * `cli.renderLive` lookup). `registerLiveView` is an idempotent map write, so
 * doing this once per run — only on the interactive path that needs it — is
 * equivalent to the old mount-time registration.
 */
function setUpSimLiveView(cli: ToolCliContext): void {
  cli.registerLiveView(SIM_LIVE_VIEW_KEY, async (args, liveContext) => {
    const simArgs = args as ToolOptions;
    // The renderer returns a ToolRunCompletion; the HOST persists its `session`
    // after this resolves (host-owned-run-timing Phase 2).
    const completion = await renderSimLive(simArgs, { setExitCode: cli.setExitCode }, liveContext);
    if (completion.envelope !== undefined) {
      // ADR-0035: the host derives the findings exit from envelope.verdict.passed.
      await cli.deliverSignals(completion.envelope, {
        cwd: simArgs.cwd,
        reportTo: simArgs.reportTo,
        apiKey: simArgs.apiKey,
      });
    }
    return completion;
  });
}

/**
 * The `sim` command handler — the former `register()` action body, lifted to a
 * spec handler. `output: 'raw-stream'` (handler owns its own IO): the host runs
 * this and renders nothing further, so the handler keeps full ownership of the
 * TTY-vs-static branch, the JSON/Ink dispatch, the cloud egress, the exit-code
 * decision, and the report auto-open.
 */
async function runSim(rawOpts: unknown, cli: ToolCliContext): Promise<ToolRunCompletion | void> {
  const opts = rawOpts as SimOptions;
  if (opts.show !== undefined && opts.show.length > 0) {
    await runSimShowMode(opts, cli);
    return;
  }

  // Interactive TTY (non-json): the animated live view. Egress + exit code +
  // host session persistence are handled via the registerLiveView callback /
  // renderSimLive (host completeLiveRender) after the Ink app exits.
  if (opts.json !== true && process.stdout.isTTY === true) {
    setUpSimLiveView(cli);
    await cli.renderLive(SIM_LIVE_VIEW_KEY, opts);
    await cli.maybeOpenReport({
      openRequested: Boolean(opts.open),
      jsonOutput: false,
    });
    return;
  }

  // json / non-TTY (pipe / CI): run the engine and render statically — the
  // animated Ink view is a TTY-only affordance. Output is byte-for-byte the
  // pre-live-view behavior.
  const { result } = await executeSim(opts);

  if (result.type === 'error') {
    if (opts.json) {
      // Structured error outcome: the host wraps and sets the exit code.
      cli.emitError({ message: result.message, exitCode: result.exitCode });
    } else {
      cli.setExitCode(result.exitCode);
      await cli.render(result);
    }
    return;
  }

  // ADR-0011: one render path per mode. `--json` emits the envelope
  // through the shared formatSignalJson; default renders the envelope-
  // derived per-scenario table.
  if (opts.json) {
    cli.emitEnvelope(result.envelope);
  } else {
    await cli.render(result);
  }

  // Effectful egress + host-owned findings exit live at the root (cloud sink +
  // `--report-to` exit 4 + the verdict-derived exit, ADR-0035). Once per run.
  // envelope-first-presentation: `result` is the render-only RunPresentation —
  // cwd comes from `opts.cwd` (in scope), recipe from `result.envelope.recipe`.
  await cli.deliverSignals(result.envelope, {
    cwd: opts.cwd,
    reportTo: opts.reportTo,
    apiKey: opts.apiKey,
  });

  await cli.maybeOpenReport({
    openRequested: Boolean(opts.open),
    jsonOutput: Boolean(opts.json),
  });

  // host-owned-run-timing Phase 3: RETURN the generic-session contribution; the
  // host run plane persists it after this handler resolves (no tool-side write).
  // The session row is built from the envelope, not from *DoneResult fields.
  const { buildSimulationSessionPayload } = await import('./persistence/session-payload.js');
  return {
    session: {
      tool: 'sim',
      cwd: opts.cwd,
      recipe: result.envelope.recipe,
      score: result.envelope.verdict.score,
      passed: result.envelope.verdict.passed,
      payload: buildSimulationSessionPayload(result.envelope),
    },
  };
}

async function runSimShowMode(opts: SimOptions, cli: ToolCliContext): Promise<void> {
  const datastore = cli.scope.datastore() as DataStore | undefined;
  if (datastore === undefined) {
    await emitSimShowError(
      opts,
      cli,
      'datastore-unavailable',
      'session replay requires a datastore',
    );
    return;
  }
  const resolved = resolveSession(datastore, {
    ref: opts.show ?? 'latest',
    tool: 'sim',
  });
  if (!resolved.ok) {
    await emitSimShowError(opts, cli, resolved.reason, resolved.detail);
    return;
  }

  try {
    const replay = simReplayFromSession(resolved.session);
    if (opts.json === true) {
      cli.emitJson(sessionShowJson(resolved.session, replay));
      return;
    }
    await cli.render(sessionReplayResult(resolved.session, replay));
  } catch (error) {
    await emitSimShowError(
      opts,
      cli,
      'decode-error',
      error instanceof Error ? error.message : String(error),
    );
  }
}

async function emitSimShowError(
  opts: Pick<SimOptions, 'json'>,
  cli: ToolCliContext,
  reason: string,
  detail: string,
): Promise<void> {
  if (opts.json === true) {
    // emitError sets the exit code itself (process exit == reported outcome).
    cli.emitError({
      message: detail,
      exitCode: EXIT_CODES.CONFIGURATION_ERROR,
      code: reason,
    });
    return;
  }
  cli.setExitCode(EXIT_CODES.CONFIGURATION_ERROR);
  await cli.render({
    type: 'error',
    message: detail,
    exitCode: EXIT_CODES.CONFIGURATION_ERROR,
  });
}

function sessionShowJson(
  session: StoredSession,
  replay: ReturnType<typeof simReplayFromSession>,
): unknown {
  return {
    session: {
      id: session.id,
      tool: session.tool,
      startedAt: session.startedAt,
      completedAt: session.completedAt,
      recipe: session.recipe,
      cwd: session.cwd,
      score: session.score,
      passed: session.passed,
      durationMs: session.durationMs,
    },
    fidelity: replay.fidelity,
    envelope: replay.envelope,
  };
}

/** The tool-agnostic `session-replay` view result (rendered via the shared
 *  envelope table; no live-run footer). `cli.render` takes `unknown`. */
function sessionReplayResult(
  session: StoredSession,
  replay: ReturnType<typeof simReplayFromSession>,
): unknown {
  return {
    type: 'session-replay',
    session: {
      id: session.id,
      tool: session.tool,
      startedAt: session.startedAt,
      completedAt: session.completedAt,
      ...(session.recipe === undefined ? {} : { recipe: session.recipe }),
      score: session.score,
      passed: session.passed,
      durationMs: session.durationMs,
    },
    envelope: replay.envelope,
    fidelity: replay.fidelity,
  };
}

/**
 * The declarative `sim` command. Replaces the hand-rolled `register()` body:
 * the host mounts this
 * spec, applies the ADR-0021 common flags + the `--recipe` option, and invokes
 * `runSim`.
 *
 * `output: 'raw-stream'` because sim's handler owns its entire output surface —
 * it dispatches between the interactive Ink live view and the static
 * render/JSON path at runtime (TTY-dependent) and performs cloud egress, the
 * report auto-open, and the exit-code decision itself. None of those are
 * expressible through the `signal-envelope` dispatch arm (which only does
 * `emitEnvelope`/`render`), so the host renders nothing and the handler stays
 * authoritative — byte-identical to the former action body.
 */
const simCommand = definePrimaryCommand<unknown, ToolCliContext>({
  description: 'Run simulation scenarios',
  // ADR-0021 cross-tool flags from the single registry: --cwd, --json, --quiet,
  // --verbose, --debug, --report-to, --api-key, --open. sim carries -v/--verbose
  // (per-scenario detail). `cwd` is seeded with process.cwd() by the mounter.
  commonFlags: ['cwd', 'json', 'quiet', 'verbose', 'debug', 'reportTo', 'apiKey', 'open'],
  options: [
    {
      flag: '--recipe',
      value: '<name>',
      description: 'Run a named sim recipe (default: built-in `default`)',
    },
    {
      flag: '--show',
      value: '<session>',
      description: 'Replay a stored sim session by id, or latest for the latest sim session',
    },
  ],
  scope: 'project',
  output: 'raw-stream',
  rawStreamReason: 'runtime-render-dispatch',
  handler: runSim,
});

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
 * The simulation tool's registrar for its `sim-recipe` capability domain (§5.3
 * separate-domains fold). A scenario pack's co-located `recipes` export is routed
 * here by the SAME discovery walk that loads its scenarios. Host-checked against
 * `requiredKeys: ['id', 'name']`; silently skips an already-registered id/name
 * (mirroring the shared `registerRecipesFromMod` dedupe).
 */
const registerSimRecipe: CapabilityRegistrar = (contribution) => {
  const recipe = contribution as SimulationRecipe;
  const registry = currentSimulationRecipeRegistry();
  if (registry.has(recipe.id) || registry.has(recipe.name)) return;
  registry.register(recipe, { allowOverwrite: false });
};

const simulationScope = createToolScope({
  slot: 'simulation',
  create: () => ({
    scenarios: createScenarioRegistry(),
    recipes: createSimulationRecipeRegistry(),
    load: createSimulationLoadState(),
  }),
});

/**
 * Per-tool contract version (ADR-0047).
 */
export const SIMULATION_CONTRACT_VERSION = '1.0.0';

export const SIMULATION_STABLE_ID = '715d32c2-692c-4ed4-985b-a35deaf186aa';

export const simulationTool: Tool = defineTool({
  identity: SIMULATION_IDENTITY,
  metadata: {
    id: SIMULATION_STABLE_ID,
    version: readPackageVersion(import.meta.url),
    description: 'Run simulation scenarios against a codebase',
  },
  pluginLayout: { userSubdirs: SIM_PLUGIN_LAYOUT.userSubdirs },
  commandSpecs: [simCommand, simRecipesCommandSpec, simRunWorkerCommandSpec],
  extensionPoints: {
    simulationContractVersion: SIMULATION_CONTRACT_VERSION,
    contributeScope: simulationScope.contributeScope,
    collectReportData: collectSimulationReportData,
    sessionReplay: {
      replaySession: simReplayFromSession,
    },
    config: {
      schema: simulationConfigDeclaration.schema,
      defaults: simulationConfigDeclaration.defaults,
      env: simulationConfigDeclaration.env,
    },
    capabilityRegistrars: {
      'sim-pack': registerSimScenario,
      'sim-recipe': registerSimRecipe,
    },
    scaffoldExamples: simScaffoldExamples,
    stableExampleIds: simStableExampleIds,
  },
});
