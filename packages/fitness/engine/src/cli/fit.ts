// @fitness-ignore-file detached-promises -- persistFitSession is a synchronous best-effort SQLite write; the heuristic flags it because it lives in an async caller
/**
 * fit command — run fitness checks.
 *
 * Thin orchestrator. `executeFit` sequences the five extracted phases:
 *   1. {@link ensureChecksLoaded}                — plugin + check-pack discovery
 *   2. {@link loadFitConfig}                     — opensip-tools.config.yml parse
 *   3. {@link selectRecipe}                      — recipe-name lookup vs. ad-hoc
 *   4. {@link validateLanguagesAgainstAdapters}  — warn on unknown languages
 *   5. {@link runRecipeOrAdHoc}                  — drive FitnessRecipeService
 *
 * Each phase lives in a sibling module under `./fit/`:
 *   - `fit/check-loader.ts`     — discovery + lifecycle singletons
 *   - `fit/display-registry.ts` — merged check display map
 *   - `fit/config-loader.ts`    — config parse + language validation
 *   - `fit/recipe-selector.ts`  — recipe-pick + run
 *   - `fit/result-builders.ts`  — SignalEnvelope / FitDoneResult / session persist
 *
 * This file re-exports the public surface (`executeFit`,
 * `ensureChecksLoaded`, the display accessors, `setPreLoadHook`, the
 * formatting helpers) so existing consumers (`opensip-tools`,
 * `dashboard.ts`, the fitness `index.ts` barrel) keep resolving the
 * same names.
 */

import { logger } from '@opensip-tools/core';

import { defaultRegistry } from '../framework/registry.js';
import { buildScopeBasedFileMap } from '../framework/scope-resolver.js';
import { FitnessRecipeService } from '../recipes/service.js';

import { ensureChecksLoaded, getLoadWarnings } from './fit/check-loader.js';
import { loadFitConfig, validateLanguagesAgainstAdapters } from './fit/config-loader.js';
import { runRecipeOrAdHoc, selectRecipe } from './fit/recipe-selector.js';
import { buildFitEnvelope, buildFitCallbacks, buildFitDoneResult, persistFitSession } from './fit/result-builders.js';

import type {
  FitOptions,
  SignalEnvelope,
  FitDoneResult,
  ErrorResult,
} from '@opensip-tools/contracts';
import type { DataStore } from '@opensip-tools/datastore';

// ---------------------------------------------------------------------------
// Re-exports — preserve the public surface that external consumers
// (`opensip-tools`, `dashboard.ts`, fitness's barrel) import from
// this file. Splitting the implementation under `./fit/` is an internal
// refactor; the import sites stay on `./fit.js`.
// ---------------------------------------------------------------------------

export {
  ensureChecksLoaded,
  getEnabledCheckCount,
  getLoadWarnings,
  getPluginLoadErrors,
  loadDiscoveredCheckPackages,
  setPreLoadHook,
} from './fit/check-loader.js';
export type { LoadDiscoveredResult, PreLoadHook } from './fit/check-loader.js';
export { getDisplayName, getIcon } from './fit/display-registry.js';
// `formatValidatedColumn` moved to `@opensip-tools/cli-ui` (shared by the
// fit static + live table views) in ADR-0011 Phase 6; re-export it here so
// fitness's public surface is unchanged.
export { formatValidatedColumn } from '@opensip-tools/cli-ui';
// `formatDuration` is shared across tools and lives in core; re-export it
// here so fitness's public surface is unchanged.
export { formatDuration } from '@opensip-tools/core';

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
 *   - `datastore` — when supplied, the run is persisted via
 *     `SessionRepo.save(...)` after `buildFitEnvelope`. Errors during the
 *     save are best-effort: a failed write logs `cli.fit.session.save_failed`
 *     and is swallowed so a SQLite hiccup never fails an otherwise
 *     successful fitness run — the same best-effort policy the graph
 *     tool's `persistSession` uses.
 */
export interface ExecuteFitOptions {
  onProgress?: (completed: number, total: number) => void;
  datastore?: DataStore;
}

/**
 * Run a fitness session end-to-end. Sequences the phase helpers in this
 * package in a fixed order:
 *
 *   1. `ensureChecksLoaded` — loads check packs and fit-domain plugins
 *      (must run first; populates `defaultRegistry` and
 *      `defaultRecipeRegistry` for downstream phases).
 *   2. `loadFitConfig` — resolves `signalersConfig` + `targetsConfig`
 *      from `opensip-tools.config.yml`. Sequenced before `selectRecipe`
 *      so a missing/invalid config surfaces before recipe-name
 *      validation — the config tells the user what recipes exist, so
 *      the config error is the more useful message of the two.
 *   3. `selectRecipe` — looks up the requested recipe in
 *      `defaultRecipeRegistry` (populated by step 1). Has a hard
 *      precondition on `ensureChecksLoaded`; see its JSDoc.
 *   4. `validateLanguagesAgainstAdapters` — warns on unknown languages.
 *   5. Build scope-based file map → run recipe → build outputs.
 *
 * The phase helpers read from module-singleton state set by step 1
 * (see the lifecycle singletons block in `./fit/check-loader.ts`). The
 * ordering here is the contract that lets those reads be safe.
 */
export async function executeFit(
  args: FitOptions,
  opts: ExecuteFitOptions = {},
): Promise<{ result: FitDoneResult; envelope: SignalEnvelope } | { result: ErrorResult; envelope?: undefined }> {
  logger.info({ evt: 'cli.checks.loading', module: 'cli:fit' });
  await ensureChecksLoaded(args.cwd);
  logger.info({ evt: 'cli.checks.loaded', module: 'cli:fit', checkCount: defaultRegistry.listEnabled().length });

  const configResult = loadFitConfig(args);
  if ('error' in configResult) return { result: configResult.error };
  const { signalersConfig, targetsConfig, targetRegistry } = configResult;

  const recipePick = selectRecipe(args);
  if ('error' in recipePick) return { result: recipePick.error };
  const { recipeName } = recipePick;

  const validationWarnings = await validateLanguagesAgainstAdapters(targetRegistry);

  const allChecks = defaultRegistry.listSlugs().map((key) => {
    const check = defaultRegistry.getBySlug(key);
    return { slug: check?.config.slug ?? key, scope: check?.config.checkScope };
  });
  const scopeMap = buildScopeBasedFileMap(allChecks, targetRegistry, targetsConfig, args.cwd);
  const checkTargetFiles = scopeMap.size > 0 ? scopeMap : undefined;

  const service = new FitnessRecipeService({
    cwd: args.cwd,
    checkTargetFiles,
    callbacks: buildFitCallbacks(opts.onProgress),
    disabledChecks: signalersConfig.fitness.disabledChecks,
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
  // `@opensip-tools/output` dependency in Phase 6).
  const envelope = buildFitEnvelope(fitnessResult, recipeName);

  // Persistence: when bootstrap supplied a datastore, write the
  // session via SessionRepo. Best-effort — a SQLite write failure never
  // fails an otherwise-successful fitness run (same policy as graph's
  // persistSession). `buildFitDoneResult` stays a
  // pure builder; the side effect lives here so every executeFit caller
  // (FitView, runJsonMode, runGateMode) gets the write for free as long
  // as they pass `datastore` through.
  if (opts.datastore) {
    persistFitSession(opts.datastore, args, envelope, fitnessResult.durationMs);
  }

  // Collect warnings from check loading (ensureChecksLoaded → loadWarnings)
  // and from config validation (validateLanguagesAgainstAdapters). Both flow
  // through the result rather than direct stderr writes so the live renderer
  // can surface them without breaking Ink's frame tracking.
  const warnings = [...getLoadWarnings(), ...validationWarnings];

  const result = buildFitDoneResult({ args, fitnessResult, envelope, signalersConfig, recipeName, warnings });

  logger.info({ evt: 'cli.fit.complete', module: 'cli:fit', score: envelope.verdict.score, passed: fitnessResult.success, totalChecks: fitnessResult.summary.totalChecks, durationMs: fitnessResult.durationMs });

  return { result, envelope };
}
