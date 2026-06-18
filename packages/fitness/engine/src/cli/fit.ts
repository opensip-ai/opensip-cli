/**
 * fit command — run fitness checks.
 *
 * Thin orchestrator. `executeFit` sequences the five extracted phases:
 *   1. {@link ensureChecksLoaded}                — plugin + check-pack discovery
 *   2. {@link loadFitConfig}                     — opensip-cli.config.yml parse
 *   3. {@link selectRecipe}                      — recipe-name lookup vs. ad-hoc
 *   4. {@link validateLanguagesAgainstAdapters}  — warn on unknown languages
 *   5. {@link runRecipeOrAdHoc}                  — drive FitnessRecipeService
 *
 * Each phase lives in a sibling module under `./fit/`:
 *   - `fit/check-loader.ts`     — discovery + lifecycle singletons
 *   - `fit/display-registry.ts` — merged check display map
 *   - `fit/config-loader.ts`    — config parse + language validation
 *   - `fit/recipe-selector.ts`  — recipe-pick + run
 *   - `fit/result-builders.ts`  — SignalEnvelope / RunPresentation / session persist
 *
 * This file re-exports the public surface (`executeFit`,
 * `ensureChecksLoaded`, and the display accessors) so existing consumers
 * (`opensip-cli`, `report-data.ts`, the fitness `index.ts` barrel) keep
 * resolving the same names.
 */

import { logger } from '@opensip-cli/core';

import { currentCheckRegistry } from '../framework/scope-registry.js';
import { buildScopeBasedFileMap } from '../framework/scope-resolver.js';
import { FitnessRecipeService } from '../recipes/service.js';

import { ensureChecksLoaded, getLoadWarnings } from './fit/check-loader.js';
import { loadFitConfig, validateLanguagesAgainstAdapters } from './fit/config-loader.js';
import { runRecipeOrAdHoc, selectRecipe } from './fit/recipe-selector.js';
import { resolvedFitnessConfig } from './fit/resolved-fitness-config.js';
import {
  buildFitEnvelope,
  buildFitCallbacks,
  buildFitPresentation,
} from './fit/result-builders.js';

import type {
  FitOptions,
  SignalEnvelope,
  RunPresentation,
  ErrorResult,
} from '@opensip-cli/contracts';

// ---------------------------------------------------------------------------
// Re-exports — preserve the public surface that external consumers
// (`opensip-cli`, `report-data.ts`, fitness's barrel) import from
// this file. Splitting the implementation under `./fit/` is an internal
// refactor; the import sites stay on `./fit.js`.
// ---------------------------------------------------------------------------

export {
  ensureChecksLoaded,
  getEnabledCheckCount,
  getLoadWarnings,
  getPluginLoadErrors,
} from './fit/check-loader.js';
export { getDisplayName, getIcon } from './fit/display-registry.js';

// ---------------------------------------------------------------------------
// executeFit — main fit command (returns data, no console output)
// ---------------------------------------------------------------------------

/**
 * Optional dependencies threaded through `executeFit`. Both fields are
 * optional so test harnesses and the JSON/gate paths can call
 * `executeFit(args)` exactly as before.
 *
 *   - `onProgress` — wired to `FitnessRecipeService` callbacks; FitView
 *     drives the live progress bar from this callback.
 *
 * Persistence is NOT done here (ADR-0028): the engine is worker-safe — it returns
 * the envelope + result and the host persists. The datastore handle cannot cross
 * the worker boundary. The fit modes (json / non-TTY live / gate) RETURN a
 * `ToolSessionContribution` and the host run plane writes the generic session row
 * after the handler resolves (host-owned-run-timing Phase 3); the TTY live runner
 * returns its contribution to the host via `renderLive`.
 */
export interface ExecuteFitOptions {
  onProgress?: (completed: number, total: number) => void;
}

/**
 * Run a fitness session end-to-end. Sequences the phase helpers in this
 * package in a fixed order:
 *
 *   1. `ensureChecksLoaded` — loads check packs and fit-domain plugins
 *      (must run first; populates the scope's check + recipe registries
 *      for downstream phases).
 *   2. `loadFitConfig` — resolves `signalersConfig` + `targetsConfig`
 *      from `opensip-cli.config.yml`. Sequenced before `selectRecipe`
 *      so a missing/invalid config surfaces before recipe-name
 *      validation — the config tells the user what recipes exist, so
 *      the config error is the more useful message of the two.
 *   3. `selectRecipe` — looks up the requested recipe in the scope's
 *      recipe registry (populated by step 1). Has a hard
 *      precondition on `ensureChecksLoaded`; see its JSDoc.
 *   4. `validateLanguagesAgainstAdapters` — warns on unknown languages.
 *   5. Build scope-based file map → run recipe → build outputs.
 *
 * The phase helpers read from per-run scope state set by step 1
 * (`scope.fitness.load`; see the accessors block in
 * `./fit/check-loader.ts`). The ordering here is the contract that lets
 * those reads be safe.
 */
export async function executeFit(
  args: FitOptions,
  opts: ExecuteFitOptions = {},
): Promise<
  // envelope-first-presentation: the success arm carries the render-only
  // RunPresentation plus the run envelope. `warnings` rides here as a SIBLING
  // field (not on the presentation — it is not a display field the table view
  // renders): the non-Ink paths surface it via `emitWarningsToStderr` and the
  // live runner renders it in its summary block.
  | { result: RunPresentation; envelope: SignalEnvelope; warnings?: readonly string[] }
  | { result: ErrorResult; envelope?: undefined; warnings?: undefined }
> {
  logger.info({ evt: 'cli.checks.loading', module: 'cli:fit' });
  await ensureChecksLoaded(args.cwd);
  const checkRegistry = currentCheckRegistry();
  logger.info({
    evt: 'cli.checks.loaded',
    module: 'cli:fit',
    checkCount: checkRegistry.listEnabled().length,
  });

  const configResult = loadFitConfig(args);
  if ('error' in configResult) return { result: configResult.error };
  const { signalersConfig, targetsConfig, targetRegistry } = configResult;

  // ADR-0023, Phase 4: the fitness knobs (recipe + disabledChecks) come from the
  // host-RESOLVED config block (`scope.toolConfig.fitness`), which already folds
  // in flag > env > file > defaults. `signalersConfig` is the fallback when no
  // scope/toolConfig is present (config-less project / unit test).
  const fitnessResolved = resolvedFitnessConfig();

  // Tool-scoped recipe resolution (ADR-0022): explicit --recipe > fitness.recipe
  // > built-in default. The fitness.recipe default comes from the resolved scope
  // block when available.
  const recipePick = selectRecipe(args, {
    toolRecipe: fitnessResolved?.recipe ?? signalersConfig.fitness.recipe,
  });
  if ('error' in recipePick) return { result: recipePick.error };
  const { recipeName } = recipePick;

  const validationWarnings = await validateLanguagesAgainstAdapters(targetRegistry);

  const allChecks = checkRegistry.listSlugs().map((key) => {
    const check = checkRegistry.getBySlug(key);
    return { slug: check?.config.slug ?? key, scope: check?.config.checkScope };
  });
  const scopeMap = buildScopeBasedFileMap(allChecks, targetRegistry, targetsConfig, args.cwd);
  const checkTargetFiles = scopeMap.size > 0 ? scopeMap : undefined;

  // CLI --exclude (and any config-level per-run exclude) are additive runtime filters for this invocation.
  // They are merged into disabledChecks so the recipe service skips them exactly as permanently-disabled checks.
  // This makes the documented --exclude flag actually affect execution and the gate.
  const runtimeExcludes = [
    ...(fitnessResolved?.disabledChecks ?? []),
    ...(signalersConfig.fitness.disabledChecks ?? []),
    ...(args.exclude ?? []),
  ];
  const service = new FitnessRecipeService({
    cwd: args.cwd,
    checkTargetFiles,
    callbacks: buildFitCallbacks(opts.onProgress),
    disabledChecks: runtimeExcludes,
    includeViolations: true,
    globalExcludes: targetsConfig.globalExcludes,
  });

  const fitResultOrError = await runRecipeOrAdHoc(service, args, recipeName);
  if ('error' in fitResultOrError) return { result: fitResultOrError.error };
  const fitnessResult = fitResultOrError;

  // ADR-0011: the run's signal envelope is the canonical post-run transform —
  // the universal output currency the composition root renders, emits
  // (`--json`), and delivers (cloud + `--report-to`). Cloud egress no longer
  // happens here: the root's `deliverSignals` owns it (engines dropped their
  // `@opensip-cli/output` dependency in Phase 6).
  const envelope = buildFitEnvelope(fitnessResult, recipeName, signalersConfig);

  // Collect warnings from check loading (ensureChecksLoaded → loadWarnings)
  // and from config validation (validateLanguagesAgainstAdapters). Both flow
  // through the result rather than direct stderr writes so the live renderer
  // can surface them without breaking Ink's frame tracking.
  const warnings = [...getLoadWarnings(), ...validationWarnings];

  const result = buildFitPresentation({
    args,
    fitnessResult,
    envelope,
    signalersConfig,
    recipeName,
  });

  logger.info({
    evt: 'cli.fit.complete',
    module: 'cli:fit',
    score: envelope.verdict.score,
    passed: fitnessResult.success,
    totalChecks: fitnessResult.summary.totalChecks,
    durationMs: fitnessResult.durationMs,
  });

  return {
    result,
    envelope,
    // warnings ride as a sibling field (not on the presentation): the non-Ink
    // paths surface them via emitWarningsToStderr, the live runner in its summary.
    ...(warnings.length > 0 ? { warnings } : {}),
  };
}
