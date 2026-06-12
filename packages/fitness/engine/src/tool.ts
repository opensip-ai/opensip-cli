/**
 * fitnessTool — fitness as a Tool plugin.
 *
 * Owns the `fit`, `fit-list`, `fit-recipes`, and `fit-baseline-export`
 * subcommands. Since release 2.11.0 (Phase 4) the Commander wiring is no longer
 * hand-rolled: the tool exports declarative {@link CommandSpec}s
 * (`commandSpecs`) and the host's `mountCommandSpec` mounts them
 * (name/description/aliases, the ADR-0021 common flags, each command's options)
 * and owns the parse→handler→error→exit pipeline. This file owns only the
 * fitness command-spec assembly + the live-view renderer wiring; the spec
 * modules under `cli/fit/` own the option declarations and handler bodies. (The
 * standalone `dashboard` subcommand is owned by the CLI, which composes it from
 * every tool's contributed data — see
 * packages/cli/src/commands/register-dashboard.ts — and migrates with the host
 * commands in Phase 6.)
 *
 * Two-key registration invariant
 * ------------------------------
 * Fitness contributes TWO distinct identifiers to the CLI's registries
 * and the mismatch is intentional — do not collapse them:
 *
 *   - `metadata.id = 'fitness'` is the package-wide tool identifier
 *     (conflict-detection key in the CLI-managed tool registry).
 *
 *   - `FIT_LIVE_VIEW_KEY = 'fit'` is the live-view key. Used to call
 *     `cli.registerLiveView('fit', renderer)` and consumed by
 *     `cli.renderLive('fit', args)` in `runLiveMode`. The key matches
 *     the `fit` subcommand name so the dispatcher's `renderLive(key)`
 *     reads naturally next to the command that triggers it.
 *
 * Layer 5 Phase 3 (closes audit 2026-05-23 F3): fitness now ships its
 * own Ink/React renderer (`renderFitLive` in `cli/fit-runner.tsx`)
 * and registers it directly via `cli.registerLiveView`. The prior
 * `cli.builtinLiveViews` self-lookup handshake is gone.
 *
 * In the spec-mounted world there is no `register()` mount hook, so the live-view
 * renderer is registered lazily on the host context (via {@link setUpFitLiveView})
 * the first time a live `fit` run needs it. `registerLiveView` is an idempotent
 * map write, so doing this once per run — only on the interactive path that needs
 * it — is equivalent to the old mount-time registration.
 *
 * Module layout
 * -------------
 * - This file owns the command-spec assembly + the tool descriptor.
 * - `cli/fit/fit-command-spec.ts` owns the primary `fit` command spec + handler.
 * - `cli/fit/fit-aux-command-specs.ts` owns the aux command specs.
 * - `cli/fit-modes.ts` owns the dispatch branches (gate/list/recipes/json/live).
 */

import { readPackageVersion } from '@opensip-tools/core';

import { fitnessFingerprintStrategy } from './baseline-strategy.js';
import { collectFitnessDashboardData } from './cli/dashboard.js';
import {
  fitBaselineExportCommandSpec,
  fitListCommandSpec,
  fitRecipesCommandSpec,
} from './cli/fit/fit-aux-command-specs.js';
import { buildFitCommandSpec, FIT_LIVE_VIEW_KEY } from './cli/fit/fit-command-spec.js';
import { renderFitLive } from './cli/fit-runner.js';
import { fitRunWorkerCommandSpec } from './cli/fit-worker.js';
import { fitnessConfigDeclaration } from './config/fitness-config-schema.js';
import {
  createCheckRegistry,
  createFitnessLoadState,
  createRecipeRegistry,
  currentCheckRegistry,
  currentRecipeRegistry,
} from './framework/scope-registry.js';
import { fitReplayFromSession } from './persistence/session-replay.js';
import { FIT_PLUGIN_LAYOUT } from './plugins/loader.js';
import { fitScaffoldExamples, fitStableExampleIds } from './scaffold/examples.js';
// Side-effect import: ensures the RunScope.fitness augmentation is loaded so
// `scope.fitness` is the correctly-typed slot here.
import './scope-augmentation.js';

import type { Check } from './framework/check-types.js';
import type { FitnessRecipe } from './recipes/types.js';
import type { FitOptions } from '@opensip-tools/contracts';
import type {
  CapabilityRegistrar,
  CommandSpec,
  ScopeContribution,
  Tool,
  ToolCliContext,
  ToolCommandDescriptor,
} from '@opensip-tools/core';
import type { DataStore } from '@opensip-tools/datastore';

// =============================================================================
// COMMAND DESCRIPTORS — used by --help listings and conflict detection.
// =============================================================================

const FIT: ToolCommandDescriptor = {
  name: 'fit',
  description: 'Run fitness checks',
};

const FIT_LIST: ToolCommandDescriptor = {
  name: 'fit-list',
  description: 'List available fitness checks',
  aliases: ['list-checks'],
};

const FIT_RECIPES: ToolCommandDescriptor = {
  name: 'fit-recipes',
  description: 'List available fitness recipes',
  aliases: ['list-recipes'],
};

const FIT_BASELINE_EXPORT: ToolCommandDescriptor = {
  name: 'fit-baseline-export',
  description: 'Export the fit gate baseline (SARIF) from the datastore to a file',
};

const FIT_RUN_WORKER: ToolCommandDescriptor = {
  name: 'fit-run-worker',
  description:
    '[internal] Run fit headless and stream progress + result over IPC (forked by the live view)',
};

// =============================================================================
// LIVE-VIEW SETUP + COMMAND-SPEC ASSEMBLY
// =============================================================================

/**
 * Set fitness's live view (Layer 5 Phase 3) up on the host context — a
 * synchronous, void-returning map write (named with the `setUp` prefix to signal
 * that; `register*` would trip the `detached-promises` dogfood heuristic). Its
 * effectful egress (cloud + `--report-to`) lives at the composition root:
 * renderFitLive returns the run's envelope and this callback delivers it once
 * the Ink app exits.
 *
 * In the spec-mounted world there is no `register()` mount hook, so the `fit`
 * handler sets the renderer up lazily on the interactive path (before any
 * `cli.renderLive` lookup). `registerLiveView` is an idempotent map write, so
 * doing this once per run — only on the live path that needs it — is equivalent
 * to the old mount-time registration.
 */
function setUpFitLiveView(cli: ToolCliContext): void {
  cli.registerLiveView(FIT_LIVE_VIEW_KEY, async (args) => {
    const fitArgs = args as FitOptions;
    const envelope = await renderFitLive(fitArgs, cli.scope.datastore() as DataStore | undefined, {
      setExitCode: cli.setExitCode,
    });
    // Effectful egress lives at the composition root (ADR-0011 / ADR-0008):
    // best-effort cloud sync + `--report-to` (which owns exit 4). Delivered
    // ONCE, after the interactive Ink view exits. A content failure
    // (critical/high signals) dominates a `--report-to` upload failure so a
    // real failure is never masked by exit 4.
    if (envelope !== undefined) {
      // ADR-0035: the host derives the findings exit from envelope.verdict.passed
      // inside deliverSignals — no runFailed override on a normal run.
      await cli.deliverSignals(envelope, {
        cwd: fitArgs.cwd,
        reportTo: fitArgs.reportTo,
        apiKey: fitArgs.apiKey,
      });
    }
  });
}

/**
 * Fitness's declarative command surface (release 2.11.0 Phase 4). The host
 * mounts each spec via `mountCommandSpec`; fitness no longer touches Commander.
 * The primary `fit` spec is built with `setUpFitLiveView` so the renderer wiring
 * stays next to the `renderFitLive` import in this module.
 */
const fitCommandSpecs: readonly CommandSpec<unknown, ToolCliContext>[] = [
  buildFitCommandSpec(setUpFitLiveView),
  fitListCommandSpec,
  fitRecipesCommandSpec,
  fitBaselineExportCommandSpec,
  fitRunWorkerCommandSpec,
];

/**
 * The fitness tool's REAL registrar for its `fit-pack` capability domain
 * (§5.3 / Phase 4). The host registers the domain from fitness's manifest with
 * a deferred placeholder, then swaps in this registrar once fitness's module
 * loads. A routed contribution (already shape-checked against the domain's
 * `requiredKeys: ['slug']` schema by the host) is registered into THIS run's
 * scope-owned check registry — fitness owns the registration semantics.
 */
const registerFitCheck: CapabilityRegistrar = (contribution) => {
  currentCheckRegistry().register(contribution as Check);
};

/**
 * The fitness tool's registrar for its `fit-recipe` capability domain (§5.3
 * separate-domains fold). A check pack's co-located `recipes` export is routed
 * here by the SAME discovery walk that loads its checks. The host has already
 * shape-checked each contribution against `requiredKeys: ['id', 'name']`; this
 * silently skips a recipe whose id/name is already registered (mirroring the
 * shared `registerRecipesFromMod` dedupe), so re-discovery is idempotent.
 */
const registerFitRecipe: CapabilityRegistrar = (contribution) => {
  const recipe = contribution as FitnessRecipe;
  const registry = currentRecipeRegistry();
  if (registry.has(recipe.id) || registry.has(recipe.name)) return;
  registry.register(recipe, { allowOverwrite: false });
};

/**
 * Per-run subscope contribution (D7). Called by the CLI's pre-action-hook
 * after constructing the scope and before entering it; the kernel installs
 * the returned `fitness` slot. Fresh check + recipe registries (and an empty
 * `ensureChecksLoaded` lifecycle slot) per run so concurrent scopes carry
 * independent fitness state.
 */
function contributeScope(): ScopeContribution {
  return {
    fitness: {
      checks: createCheckRegistry(),
      recipes: createRecipeRegistry(),
      load: createFitnessLoadState(),
    },
  };
}

// =============================================================================
// EXPORT
// =============================================================================

export const fitnessTool: Tool = {
  metadata: {
    id: 'fitness',
    version: readPackageVersion(import.meta.url),
    description: 'Run fitness checks against a codebase',
  },
  commands: [FIT, FIT_LIST, FIT_RECIPES, FIT_BASELINE_EXPORT, FIT_RUN_WORKER],
  pluginLayout: FIT_PLUGIN_LAYOUT,
  // Release 2.11.0 Phase 4: fitness declares its command surface; the host
  // mounts each spec via mountCommandSpec. The deprecated `register()` fallback
  // is gone — fitness no longer touches Commander.
  commandSpecs: fitCommandSpecs,
  contributeScope,
  collectDashboardData: collectFitnessDashboardData,
  sessionReplay: {
    tool: 'fit',
    replaySession: fitReplayFromSession,
  },
  // ADR-0023 Phase 4: fitness contributes its namespaced `fitness:` Zod schema
  // (gate thresholds, disabledChecks, recipe) so the host composes +
  // strict-validates the whole config document before dispatch. Shared
  // targeting (targets/globalExcludes/checkOverrides) stays with
  // SignalersConfigSchema because the fit hot path consumes target registries
  // through that loader.
  config: fitnessConfigDeclaration,
  // §5.3 Phase 4: fitness owns the `fit-pack` capability domain (declared in
  // its manifest). It supplies the REAL registrar so the host can replace the
  // manifest-time deferred placeholder once fitness's module loads.
  capabilityRegistrars: { 'fit-pack': registerFitCheck, 'fit-recipe': registerFitRecipe },
  // ADR-0036: fitness's message-hash baseline identity (sha256(filePath\nruleId\n
  // message)), read by the host baseline/ratchet seams when fit stamps its gate
  // envelope. Excludes line/col so unrelated line-shifts don't flap the ratchet.
  fingerprintStrategy: fitnessFingerprintStrategy,
  // ADR-0038: fitness owns its `init` example bytes + the pinned check-id universe.
  // The host writes each returned file under userPluginDir('fit', file.kind).
  scaffoldExamples: fitScaffoldExamples,
  stableExampleIds: fitStableExampleIds,
  initialize: async (): Promise<void> => {
    // ensureChecksLoaded() is called inside the executeFit / listChecks
    // / listRecipes paths, so a separate initialize() pass is not
    // strictly needed today. Left as a no-op so fitness has somewhere
    // to hang future tool-startup work (eager check-pack discovery,
    // catalog warming, etc.) without requiring a contract change.
  },
};
