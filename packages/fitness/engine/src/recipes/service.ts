// @fitness-ignore-file eslint-backend -- Fitness framework orchestrator; ESLint rule variations between fitness runner and IDE are expected
/**
 * @fileoverview Central orchestrator for fitness recipe execution
 *
 * FitnessRecipeService resolves checks, manages session lifecycle,
 * coordinates parallel/sequential execution, and builds results.
 */

import {
  logger,
  NotFoundError,
  SystemError,
  generateId,
  clearParseCache,
  RunScope,
  currentScope,
  runWithScope,
} from '@opensip-cli/core';

import { FileCache } from '../framework/file-cache.js';
import { type CheckRegistry } from '../framework/registry.js';
import { currentCheckRegistry, currentRecipeRegistry } from '../framework/scope-registry.js';

import { setCurrentRecipeCheckConfig, clearCurrentRecipeCheckConfig } from './check-config.js';
import {
  executeParallel,
  type ExecutionOptions,
  type ExecutionServiceContext,
} from './parallel-execution.js';
import { type FitnessRecipeRegistry } from './registry.js';
import { executeSequential } from './sequential-execution.js';
import { createAdHocRecipe, type AdHocRecipeArgs } from './service-adhoc.js';
import { resolveAndFilterChecks } from './service-check-resolution.js';
import { prepareRecipeExecution } from './service-prepare.js';
import {
  buildRecipeResult,
  collectAppliedDirectives,
  createRecipeSession,
} from './service-session.js';
import { type FitnessRecipe, type FitnessRecipeResult } from './types.js';

import type {
  FitnessRecipeServiceCallbacks,
  FitnessRecipeServiceConfig,
  FitnessRecipeSession,
} from './service-types.js';

const MODULE_FITNESS_RECIPES = 'fitness:recipes';

/**
 * Central orchestrator for fitness check execution.
 */
export class FitnessRecipeService {
  private readonly config: FitnessRecipeServiceConfig;
  private readonly checkRegistry: CheckRegistry;
  private readonly recipeRegistry: FitnessRecipeRegistry;
  /**
   * Per-run file cache, resolved ONCE at `executeRecipeInScope` entry (NOT in
   * the constructor — the constructor may run before a scope exists). It is the
   * SINGLE instance read by prewarm, `execOpts.fileCache`, and the `finally`
   * `clear()`; resolving it elsewhere (a divergent function-local) would
   * reintroduce the cache-instance-mismatch bug this phase fixes.
   */
  private fileCache!: FileCache;
  private activeSession: FitnessRecipeSession | null = null;
  private abortController?: AbortController;

  constructor(config?: FitnessRecipeServiceConfig) {
    this.config = config ?? {};
    // Default to the current scope's registries (the production path: a fit
    // run executes inside the pre-action-hook's RunScope). An explicit
    // `checkRegistry`/`recipeRegistry` in config overrides — tests and
    // programmatic callers can inject their own without a scope.
    this.checkRegistry = config?.checkRegistry ?? currentCheckRegistry();
    this.recipeRegistry = config?.recipeRegistry ?? currentRecipeRegistry();
    // NOTE: `this.fileCache` is intentionally NOT assigned here. It is resolved
    // per-run at `executeRecipeInScope` entry from the scope (the canonical
    // per-run cache is `scope.fitness.fileCache`); a constructor default would
    // be an orphan — prewarm/exec resolve a different scope instance while a
    // ctor instance only ever leaks (the very instance-vs-global split this
    // phase closes).
  }

  private get session(): FitnessRecipeSession {
    if (!this.activeSession) {
      throw new SystemError('No active session', {
        code: 'SYSTEM.FITNESS.NO_SESSION',
      });
    }
    return this.activeSession;
  }

  /**
   * Execute a fitness recipe by name or recipe object.
   *
   * Resolves checks, prewarms the file cache, runs checks in parallel or sequential mode,
   * then builds and returns a {@link FitnessRecipeResult}. Only one session can be active
   * at a time — call {@link abort} to cancel a running session.
   *
   * @param recipeOrName - A recipe name (looked up in the recipe registry) or a FitnessRecipe object.
   * @returns The result of the recipe execution including per-check results and summary.
   * @throws {SystemError} If a session is already in progress.
   * @throws {NotFoundError} If the recipe name is not found in the registry.
   */
  async start(recipeOrName: FitnessRecipe | string): Promise<FitnessRecipeResult> {
    if (this.activeSession) {
      throw new SystemError('Recipe execution already in progress', {
        code: 'SYSTEM.FITNESS.SESSION_IN_PROGRESS',
      });
    }

    const recipe = typeof recipeOrName === 'string' ? this.getRecipe(recipeOrName) : recipeOrName;

    if (!recipe) {
      const identifier = typeof recipeOrName === 'string' ? recipeOrName : recipeOrName.name;
      throw new NotFoundError(`Recipe not found: ${identifier}`, {
        code: 'RESOURCE.NOT_FOUND.RECIPE',
        metadata: { entity: 'recipe', identifier },
      });
    }

    return this.executeRecipe(recipe);
  }

  private async executeRecipe(recipe: FitnessRecipe): Promise<FitnessRecipeResult> {
    // Two paths: if we're already inside a `runWithScope`, project the
    // recipe-config slot onto the existing scope and run inline. Otherwise
    // construct an ad-hoc scope and enter `runWithScope` so the dynamic
    // extent of the recipe-execution body (including every check's
    // `getCheckConfig(slug)` lookup) sees the recipe's per-check config.
    const existing = currentScope();
    if (existing) {
      return this.executeRecipeInScope(recipe, existing);
    }
    // No ambient scope (programmatic / ad-hoc API use): construct one, but own
    // its lifecycle — dispose() frees the per-run parseCache + recipe config so
    // an ad-hoc execution does not leak per-run state (esp. in long-lived hosts).
    const adhoc = new RunScope();
    try {
      return await runWithScope(adhoc, () => this.executeRecipeInScope(recipe, adhoc));
    } finally {
      adhoc.dispose();
    }
  }

  private async executeRecipeInScope(
    recipe: FitnessRecipe,
    recipeScope: RunScope,
  ): Promise<FitnessRecipeResult> {
    // Resolve the per-run cache ONCE — the single instance that prewarm,
    // execOpts.fileCache, and the `finally` clear() all read. Precedence:
    // explicit config cache (tests/programmatic) > the scope's canonical
    // `scope.fitness.fileCache` (production: the CLI install loop already
    // registered its disposer via contributeScope's onDispose) > an ad-hoc
    // `new FileCache()` for the pure programmatic path (a scope with no fitness
    // subscope and no config cache). The ad-hoc fallback is the ONLY case where
    // nothing else owns teardown, so register its disposer on the scope.
    const scopeCache = recipeScope.fitness?.fileCache;
    if (this.config.fileCache) {
      this.fileCache = this.config.fileCache;
    } else if (scopeCache) {
      this.fileCache = scopeCache;
    } else {
      const adhocCache = new FileCache();
      this.fileCache = adhocCache;
      recipeScope.onDispose(() => adhocCache.clear());
    }

    const sessionId = this.generateSessionId();
    this.activeSession = createRecipeSession(sessionId, recipe);

    this.abortController = new AbortController();

    logger.info('Starting recipe session', {
      evt: 'fitness.recipe.session.start',
      module: MODULE_FITNESS_RECIPES,
      sessionId,
      recipeName: recipe.name,
    });
    // Run-level lifecycle event on the per-run DiagnosticsBus (north-star §5.10).
    // The host emits COMMAND-level lifecycle; only the recipe engine knows its
    // INTERNAL lifecycle (which recipe ran, how many checks passed/failed), so the
    // fit run contributes `start`/`complete` events here. Emitted before any early
    // return (e.g. an empty recipe) so every run surfaces at least one event on
    // the `--json` CommandOutcome via `scope.diagnostics.snapshot()`.
    recipeScope.diagnostics.event('execute', 'debug', 'recipe session started', {
      recipe: recipe.name,
    });

    // Project the recipe's per-check config into the current scope's
    // recipe-config slot so individual checks can read their slice via
    // getCheckConfig<T>(slug). Cleared in the `finally` below.
    setCurrentRecipeCheckConfig(recipeScope, recipe.checks.config);

    try {
      const cwd = this.config.cwd ?? process.cwd();
      const checks = resolveAndFilterChecks(recipe, this.checkRegistry, {
        disabledChecks: this.config.disabledChecks,
      });

      this.activeSession.totalChecks = checks.length;

      if (checks.length === 0) {
        return buildRecipeResult(this.session);
      }

      await prepareRecipeExecution({
        checks,
        cwd,
        fileCache: this.fileCache,
        checkRegistry: this.checkRegistry,
        callbacks: this.callbacks,
        prewarmCache: this.config.prewarmCache,
        prewarmPatterns: this.config.prewarmPatterns,
      });

      // Execute
      const execOpts: ExecutionOptions = {
        checks,
        cwd,
        recipe,
        checkTargetFiles: this.config.checkTargetFiles,
        ...(this.config.globalExcludes ? { globalExcludes: this.config.globalExcludes } : {}),
        fileCache: this.fileCache,
      };
      const execCtx: ExecutionServiceContext = {
        session: this.activeSession,
        callbacks: this.callbacks,
        abortController: this.abortController,
        includeViolations: this.config.includeViolations ?? false,
      };

      // Deliberate two-mode dispatch (see audit 2026-05-23 F5): when a
      // 3rd mode lands, tabularize. Both executors share the exact
      // `(ctx, opts) =>
      // Promise<void>` shape, so the moment a third mode (e.g.
      // 'staged' for incremental fit, 'isolated' for sandbox-per-check)
      // is added, swap this ternary for a `Map<ExecutionMode, Executor>`
      // lookup and let the compiler enforce exhaustiveness. The
      // two-mode ternary is small enough that the table is premature
      // today (audit 2026-05-23 F5).
      await (recipe.execution.mode === 'parallel'
        ? executeParallel(execCtx, execOpts)
        : executeSequential(execCtx, execOpts));

      this.activeSession.directives = collectAppliedDirectives(this.activeSession);

      this.activeSession.status = 'completed';
      const result = buildRecipeResult(this.session);

      logger.info('Recipe session completed', {
        evt: 'fitness.recipe.session.complete',
        module: MODULE_FITNESS_RECIPES,
        sessionId,
        recipeName: recipe.name,
        passed: result.summary.passedChecks,
        failed: result.summary.failedChecks,
        durationMs: result.durationMs,
      });
      recipeScope.diagnostics.event('execute', 'debug', 'recipe session completed', {
        recipe: recipe.name,
        passed: result.summary.passedChecks,
        failed: result.summary.failedChecks,
      });
      void this.callbacks.onComplete?.(result);
      return result;
    } catch (error) {
      logger.error('Recipe session failed', {
        evt: 'fitness.recipe.session.error',
        module: MODULE_FITNESS_RECIPES,
        sessionId,
        recipeName: recipe.name,
        err: error instanceof Error ? error : undefined,
      });
      if (this.activeSession) {
        this.activeSession.status = 'failed';
      }
      throw error;
    } finally {
      clearCurrentRecipeCheckConfig(recipeScope);
      void clearParseCache();
      this.fileCache.clear();
      this.abortController?.abort();
      delete this.abortController;
      this.activeSession = null;
    }
  }

  /**
   * Convert CLI arguments to an ad-hoc FitnessRecipe.
   */
  static createAdHocRecipe(args: AdHocRecipeArgs): FitnessRecipe {
    return createAdHocRecipe(args);
  }

  /** Get the currently active session, or null if no recipe is running. */
  getActiveSession(): FitnessRecipeSession | null {
    return this.activeSession;
  }

  /** Abort the currently running recipe execution. No-op if no session is active. */
  abort(): void {
    this.abortController?.abort();
  }

  /** List all available recipes from the recipe registry. */
  listRecipes(): readonly FitnessRecipe[] {
    return this.recipeRegistry.getAllRecipes();
  }

  /**
   * Look up a recipe by name or ID.
   * @param nameOrId - The recipe name or full recipe ID (e.g. "default" or "RCP_default").
   * @returns The recipe if found, undefined otherwise.
   */
  getRecipe(nameOrId: string): FitnessRecipe | undefined {
    return this.recipeRegistry.loadRecipe(nameOrId);
  }

  protected generateSessionId(): string {
    return generateId('SES');
  }

  protected get callbacks(): FitnessRecipeServiceCallbacks {
    return this.config.callbacks ?? {};
  }
}
