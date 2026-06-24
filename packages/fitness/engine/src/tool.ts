/**
 * fitnessTool — fitness as a Tool plugin.
 *
 * Owns the `fit` primary plus its nested `fit list`, `fit recipes`, and
 * `fit export` subcommands. Since release 2.11.0 (Phase 4) the Commander wiring is no longer
 * hand-rolled: the tool exports declarative {@link CommandSpec}s
 * (`commandSpecs`) and the host's `mountCommandSpec` mounts them
 * (name/description/aliases, the ADR-0021 common flags, each command's options)
 * and owns the parse→handler→error→exit pipeline. This file owns only the
 * fitness command-spec assembly + the live-view renderer wiring; the spec
 * modules under `cli/fit/` own the option declarations and handler bodies. (The
 * standalone `report` subcommand is owned by the CLI, which composes it from
 * every tool's contributed data — see
 * packages/cli/src/commands/host-command-specs.ts — and migrates with the host
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
 * - `cli/fit/fit-aux-command-specs.ts` owns the nested `fit list` / `fit recipes`
 *   / `fit export` command specs.
 * - `cli/fit-modes.ts` owns the dispatch branches (gate/list/recipes/json/live).
 */

import { defineTool, readPackageVersion } from '@opensip-cli/core';

import { fitnessFingerprintStrategy } from './baseline-strategy.js';
import {
  fitExportCommandSpec,
  fitListGroupedCommandSpec,
  fitRecipesGroupedCommandSpec,
} from './cli/fit/fit-aux-command-specs.js';
import { buildFitCommandSpec } from './cli/fit/fit-command-spec.js';
import { renderFitLive } from './cli/fit-runner.js';
import { fitRunWorkerCommandSpec } from './cli/fit-worker.js';
import { collectFitnessReportData } from './cli/report-data.js';
import { fitnessConfigDeclaration } from './config/fitness-config-schema.js';
import { FileCache } from './framework/file-cache.js';
import {
  createCheckRegistry,
  createFitnessLoadState,
  createRecipeRegistry,
  currentCheckRegistry,
  currentRecipeRegistry,
} from './framework/scope-registry.js';
import { FITNESS_IDENTITY, FITNESS_LIVE_VIEW_KEY } from './identity.js';
import { fitReplayFromSession } from './persistence/session-replay.js';
import { FIT_PLUGIN_LAYOUT } from './plugins/loader.js';
import {
  fitScaffoldConfigBlock,
  fitScaffoldExamples,
  fitStableExampleIds,
} from './scaffold/index.js';
// Side-effect import: ensures the RunScope.fitness augmentation is loaded so
// `scope.fitness` is the correctly-typed slot here.
import './scope-augmentation.js';

import type { Check } from './framework/check-types.js';
import type { FitnessRecipe } from './recipes/types.js';
import type { FitOptions } from '@opensip-cli/contracts';
import type {
  CapabilityRegistrar,
  ContributeScopeResult,
  Tool,
  ToolCliContext,
} from '@opensip-cli/core';

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
  cli.registerLiveView(FITNESS_LIVE_VIEW_KEY, async (args, liveContext) => {
    const fitArgs = args as FitOptions;
    // The host always supplies the LiveViewContext (carrying the run timer for
    // the summary provider). The renderer returns a ToolRunCompletion; the HOST
    // persists its `session` after this resolves (host-owned-run-timing Phase 2).
    const completion = await renderFitLive(fitArgs, liveContext, {
      setExitCode: cli.setExitCode,
    });
    // Effectful egress lives at the composition root (ADR-0011 / ADR-0008):
    // best-effort cloud sync + `--report-to` (which owns exit 4). Delivered
    // ONCE, after the interactive Ink view exits. A content failure
    // (critical/high signals) dominates a `--report-to` upload failure so a
    // real failure is never masked by exit 4.
    if (completion.envelope !== undefined) {
      // ADR-0035: the host derives the findings exit from envelope.verdict.passed
      // inside deliverSignals — no runFailed override on a normal run.
      await cli.deliverSignals(completion.envelope, {
        cwd: fitArgs.cwd,
        reportTo: fitArgs.reportTo,
        apiKey: fitArgs.apiKey,
      });
    }
    // Return the completion so the host completes the lifecycle + persists the
    // session contribution (the renderer no longer writes the session).
    return completion;
  });
}

/**
 * Fitness's declarative command surface (release 2.11.0 Phase 4). The host
 * mounts each spec via `mountCommandSpec`; fitness no longer touches Commander.
 * The primary `fit` spec is built with `setUpFitLiveView` so the renderer wiring
 * stays next to the `renderFitLive` import in this module.
 */
const fitCommandSpecs = [
  buildFitCommandSpec(setUpFitLiveView),
  // Grouped Tier-2 children — `fit list` / `fit recipes` nest under the `fit`
  // primary via the nested-mount capability (the canonical `<tool> <verb>`
  // grammar; the legacy flat aliases were removed).
  fitListGroupedCommandSpec,
  fitRecipesGroupedCommandSpec,
  // Canonical nested export — mounts as `fit export` under the `fit` primary via
  // the nested-mount capability.
  fitExportCommandSpec,
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
 * the returned `fitness` slot. Fresh check + recipe registries, an empty
 * `ensureChecksLoaded` lifecycle slot, and a fresh per-run `FileCache` so
 * concurrent scopes carry independent fitness state.
 *
 * Returns the {@link ScopeContributionWithDisposer} wrapper: the SAME
 * `fileCache` instance is placed on `scope.fitness.fileCache` and closed over by
 * the `onDispose` disposer, so `RunScope.dispose()` clears the cache + cancels
 * its auto-clear timer. The kernel install loop registers the disposer via
 * `scope.onDispose(...)`; core never names `FileCache` (layering-clean).
 */
function contributeScope(): ContributeScopeResult {
  const fileCache = new FileCache();
  // Lazily populated by checks-typescript's getSharedTypeCheckedProgram; held
  // here so one ts.Program is shared by every type-aware check in the run and
  // released on dispose. `value` is opaque (unknown) — the engine never names
  // lang-typescript's TypeCheckedProgram, keeping the typescript dep out of here.
  const tsProgram: { value: unknown } = { value: undefined };
  return {
    contribution: {
      fitness: {
        checks: createCheckRegistry(),
        recipes: createRecipeRegistry(),
        load: createFitnessLoadState(),
        fileCache,
        tsProgram,
      },
    },
    onDispose: () => {
      fileCache.clear();
      tsProgram.value = undefined;
    },
  };
}

// =============================================================================
// Per-tool contract version (ADR-0047)
// =============================================================================

/**
 * Per-tool contract version for the fitness-specific surface
 * (defineCheck, analysis modes, check packs, recipes, etc.).
 * Independent of the core TOOL_CONTRACT_VERSION (the generic Tool bus).
 * Bumped only on actual changes to this surface; value = major.minor of the
 * CLI release shipping the change (see ADR-0047).
 */
export const FITNESS_CONTRACT_VERSION = '1.0.0';

// =============================================================================
// EXPORT
// =============================================================================

export const FITNESS_STABLE_ID = 'afd68bd3-ff3c-4935-a5b6-76d8fc7a5224';

export const fitnessTool: Tool = defineTool({
  identity: FITNESS_IDENTITY,
  metadata: {
    id: FITNESS_STABLE_ID,
    version: readPackageVersion(import.meta.url),
    description: 'Run fitness checks against a codebase',
  },
  pluginLayout: { userSubdirs: FIT_PLUGIN_LAYOUT.userSubdirs },
  commandSpecs: fitCommandSpecs,
  extensionPoints: {
    fitnessContractVersion: FITNESS_CONTRACT_VERSION,
    contributeScope,
    collectReportData: collectFitnessReportData,
    sessionReplay: {
      replaySession: fitReplayFromSession,
    },
    config: {
      schema: fitnessConfigDeclaration.schema,
      defaults: fitnessConfigDeclaration.defaults,
      env: fitnessConfigDeclaration.env,
    },
    capabilityRegistrars: { 'fit-pack': registerFitCheck, 'fit-recipe': registerFitRecipe },
    fingerprintStrategy: fitnessFingerprintStrategy,
    scaffoldExamples: fitScaffoldExamples,
    stableExampleIds: fitStableExampleIds,
    scaffoldConfigBlock: fitScaffoldConfigBlock,
    initialize: async (): Promise<void> => {
      // ensureChecksLoaded() runs inside executeFit / listChecks / listRecipes.
    },
  },
});
