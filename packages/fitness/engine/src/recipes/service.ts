// @fitness-ignore-file file-length-limit -- Complex module with tightly coupled logic; splitting would fragment cohesive functionality
// @fitness-ignore-file eslint-backend -- Fitness framework orchestrator; ESLint rule variations between fitness runner and IDE are expected
// @fitness-ignore-file detached-promises -- clearParseCache is explicitly voided; surrounding sync calls (fileCache.clear, abort) are flagged by heuristic
/**
 * @fileoverview Central orchestrator for fitness recipe execution
 *
 * FitnessRecipeService resolves checks, manages session lifecycle,
 * coordinates parallel/sequential execution, and builds results.
 */

import { passRate } from '@opensip-cli/contracts';
import {
  logger,
  NotFoundError,
  SystemError,
  generateId,
  initParseCache,
  clearParseCache,
  RunScope,
  currentScope,
  runWithScope,
} from '@opensip-cli/core';

import {
  FileCache,
  fileCache as globalFileCache,
  DEFAULT_PREWARM_PATTERNS,
} from '../framework/file-cache.js';
import { type Check, type CheckRegistry } from '../framework/registry.js';
import { currentCheckRegistry, currentRecipeRegistry } from '../framework/scope-registry.js';

import { setCurrentRecipeCheckConfig, clearCurrentRecipeCheckConfig } from './check-config.js';
import { resolveChecks, validateCheckReferences } from './check-resolution.js';
import {
  executeParallel,
  type ExecutionOptions,
  type ExecutionServiceContext,
} from './parallel-execution.js';
import { type FitnessRecipeRegistry } from './registry.js';
import { executeSequential } from './sequential-execution.js';
import {
  DEFAULT_MAX_PARALLEL,
  type CheckSelector,
  type FitnessRecipe,
  type FitnessRecipeResult,
  type RecipeRunSummary,
} from './types.js';

import type {
  FitnessRecipeServiceCallbacks,
  FitnessRecipeServiceConfig,
  FitnessRecipeSession,
} from './service-types.js';
import type { DirectiveEntry } from '../framework/directive-inventory.js';

const MODULE_FITNESS_RECIPES = 'fitness:recipes';

/** Default success threshold percentage when none is configured. */
const DEFAULT_SUCCESS_THRESHOLD_PERCENT = 85;

/**
 * Compute prewarm glob patterns from the resolved checks' fileTypes.
 * If any check is universal (no fileTypes), falls back to DEFAULT_PREWARM_PATTERNS.
 */
function computePrewarmPatterns(checks: readonly Check[]): readonly string[] {
  const extensions = new Set<string>();
  for (const check of checks) {
    const ft = check.config.fileTypes;
    if (!ft || ft.length === 0) {
      // Universal check — need all file types
      return DEFAULT_PREWARM_PATTERNS;
    }
    for (const ext of ft) {
      extensions.add(ext);
    }
  }
  return [...extensions].sort().map((ext) => `**/*.${ext}`);
}

/**
 * Central orchestrator for fitness check execution.
 */
export class FitnessRecipeService {
  private readonly config: FitnessRecipeServiceConfig;
  private readonly checkRegistry: CheckRegistry;
  private readonly recipeRegistry: FitnessRecipeRegistry;
  private readonly fileCache: FileCache;
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
    // Per-service FileCache instance for SaaS concurrent RunScope isolation.
    // Global singleton is for tests / non-service paths; each service gets its
    // own so prewarm/clear in one run does not affect another.
    this.fileCache = config?.fileCache ?? new FileCache();
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
  // @fitness-ignore-next-line result-pattern-consistency -- return type is FitnessRecipeResult (not Result<T,E>); throw is appropriate for precondition failures
  async start(recipeOrName: FitnessRecipe | string): Promise<FitnessRecipeResult> {
    if (this.activeSession) {
      throw new SystemError('Recipe execution already in progress', {
        code: 'SYSTEM.FITNESS.SESSION_IN_PROGRESS',
      });
    }

    const recipe = typeof recipeOrName === 'string' ? this.getRecipe(recipeOrName) : recipeOrName;

    if (!recipe) {
      const identifier = typeof recipeOrName === 'string' ? recipeOrName : recipeOrName.name;
      // @fitness-ignore-next-line result-pattern-consistency -- internal method, exceptions propagate to CLI boundary
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
    const adhoc = new RunScope();
    return runWithScope(adhoc, () => this.executeRecipeInScope(recipe, adhoc));
  }

  private async executeRecipeInScope(
    recipe: FitnessRecipe,
    recipeScope: RunScope,
  ): Promise<FitnessRecipeResult> {
    const sessionId = this.generateSessionId();
    this.activeSession = this.createSession(sessionId, recipe);

    this.abortController = new AbortController();

    logger.info('Starting recipe session', {
      evt: 'fitness.recipe.session.start',
      module: MODULE_FITNESS_RECIPES,
      sessionId,
      recipeName: recipe.name,
    });

    // Project the recipe's per-check config into the current scope's
    // recipe-config slot so individual checks can read their slice via
    // getCheckConfig<T>(slug). Cleared in the `finally` below.
    setCurrentRecipeCheckConfig(recipeScope, recipe.checks.config);

    try {
      const cwd = this.config.cwd ?? process.cwd();
      const checks = this.resolveAndFilterChecks(recipe);

      this.activeSession.totalChecks = checks.length;

      if (checks.length === 0) {
        return this.buildResult();
      }

      await this.prepareExecution(checks, cwd);

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

      this.activeSession.directives = this.collectAppliedDirectives();

      this.activeSession.status = 'completed';
      const result = this.buildResult();

      logger.info('Recipe session completed', {
        evt: 'fitness.recipe.session.complete',
        module: MODULE_FITNESS_RECIPES,
        sessionId,
        recipeName: recipe.name,
        passed: result.summary.passedChecks,
        failed: result.summary.failedChecks,
        durationMs: result.durationMs,
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

  private collectAppliedDirectives(): DirectiveEntry[] {
    const result: DirectiveEntry[] = [];
    const session = this.activeSession;
    if (!session) return result;
    for (const cr of session.checkResults) {
      if (cr.appliedDirectives) {
        for (const directive of cr.appliedDirectives) {
          result.push(directive);
        }
      }
    }
    return result;
  }

  private createSession(sessionId: string, recipe: FitnessRecipe): FitnessRecipeSession {
    return {
      sessionId,
      recipe,
      startedAt: new Date(),
      status: 'running',
      totalChecks: 0,
      completedChecks: 0,
      passedChecks: 0,
      failedChecks: 0,
      totalErrors: 0,
      totalWarnings: 0,
      totalIgnored: 0,
      ignoresByTag: new Map(),
      checkResults: [],
      directives: [],
    };
  }

  private resolveAndFilterChecks(recipe: FitnessRecipe): Check[] {
    const checkSlugs = resolveChecks(recipe.checks, this.checkRegistry);

    // Validate explicit references
    if (recipe.checks.type === 'explicit') {
      const allSlugs = this.checkRegistry.listSlugs();
      const { missing } = validateCheckReferences(recipe.checks.checkIds, [...allSlugs]);
      if (missing.length > 0) {
        logger.warn(`Recipe references ${missing.length} unknown check(s)`, {
          evt: 'fitness.recipe.checks.missing',
          module: MODULE_FITNESS_RECIPES,
          missing,
          recipeName: recipe.name,
        });
      }
    }

    const configDisabled = new Set(this.config.disabledChecks);
    const includeDisabledSet = new Set(recipe.includeDisabled);
    const checks: Check[] = [];

    // Warn about unknown slugs in disabledChecks config
    if (configDisabled.size > 0) {
      const allSlugs = new Set(this.checkRegistry.listSlugs());
      const unknownDisabled = [...configDisabled].filter((s) => !allSlugs.has(s));
      if (unknownDisabled.length > 0) {
        logger.warn(`disabledChecks references ${unknownDisabled.length} unknown slug(s)`, {
          evt: 'fitness.recipe.disabled.unknown',
          module: MODULE_FITNESS_RECIPES,
          unknownDisabled,
        });
      }
    }

    for (const slug of checkSlugs) {
      const check = this.checkRegistry.getBySlug(slug);
      if (!check) continue;
      const bareSlug = slug.includes(':') ? slug.split(':').pop()! : slug;
      const isDisabled =
        (check.config.disabled ?? false) ||
        configDisabled.has(slug) ||
        configDisabled.has(bareSlug);
      const isForceIncluded = includeDisabledSet.has(slug) || includeDisabledSet.has(bareSlug);
      if (!isDisabled || isForceIncluded) {
        checks.push(check);
      }
    }

    return checks;
  }

  private async prepareExecution(checks: Check[], cwd: string): Promise<void> {
    // Sync check catalog for dashboard visibility
    if (this.callbacks.onCatalogSync) {
      const entries = this.checkRegistry.list().map((c) => ({
        id: c.config.id,
        slug: c.config.slug,
        tags: c.config.tags,
        description: c.config.description,
      }));
      void this.callbacks.onCatalogSync(entries);
    }

    // Prewarm file cache with only the extensions needed by resolved checks
    if (this.config.prewarmCache !== false) {
      const patterns = this.config.prewarmPatterns ?? computePrewarmPatterns(checks);
      await this.fileCache.prewarm(cwd, patterns);
    }

    // Initialize shared AST parse cache for cross-check deduplication
    void initParseCache();
  }

  private buildResult(): FitnessRecipeResult {
    const session = this.session;
    const completedAt = new Date();

    const summary: RecipeRunSummary = {
      totalChecks: session.totalChecks,
      passedChecks: session.passedChecks,
      failedChecks: session.failedChecks,
      skippedChecks: session.totalChecks - session.completedChecks,
      erroredChecks: session.checkResults.filter((r) => r.error !== undefined).length,
      totalViolations: session.checkResults.reduce((sum, r) => sum + r.violationCount, 0),
      totalErrors: session.totalErrors,
      totalWarnings: session.totalWarnings,
      totalIgnored: session.totalIgnored,
    };

    const score = passRate({
      total: session.totalChecks,
      passed: session.passedChecks,
    });

    const result: FitnessRecipeResult = {
      recipeId: session.recipe.id,
      recipeName: session.recipe.name,
      sessionId: session.sessionId,
      success:
        score >= (session.recipe.execution.successThreshold ?? DEFAULT_SUCCESS_THRESHOLD_PERCENT) &&
        session.status === 'completed',
      startedAt: session.startedAt,
      completedAt,
      durationMs: completedAt.getTime() - session.startedAt.getTime(),
      checkResults: session.checkResults,
      summary,
    };

    return {
      ...result,
      ...(session.ignoreCounts ? { ignoreCounts: session.ignoreCounts } : {}),
      ...(session.directives.length > 0 ? { directives: session.directives } : {}),
    };
  }

  /**
   * Convert CLI arguments to an ad-hoc FitnessRecipe.
   */
  static createAdHocRecipe(args: {
    check?: string;
    tagFilters?: string[];
    file?: string;
    parallel?: boolean;
    json?: boolean;
    unified?: boolean;
    verbose?: boolean;
    retry?: boolean;
    maxRetries?: number;
    maxParallel?: number;
    timeout?: number;
    successThreshold?: number;
  }): FitnessRecipe {
    let checks: CheckSelector;
    let includeDisabled: string[] | undefined;

    if (args.check) {
      if (args.check.includes('*') || args.check.includes('?')) {
        checks = { type: 'pattern', include: [args.check] };
      } else {
        checks = { type: 'explicit', checkIds: [args.check] };
        includeDisabled = [args.check];
      }
    } else if (args.tagFilters?.length) {
      checks = { type: 'tags', include: args.tagFilters };
    } else {
      checks = { type: 'all', exclude: [] };
    }

    return {
      id: 'RCP_cli-adhoc',
      name: 'cli-adhoc',
      displayName: 'CLI Ad-Hoc',
      description: 'Dynamically created recipe from CLI arguments',
      checks,
      execution: {
        mode: args.parallel === false ? 'sequential' : 'parallel',
        stopOnFirstFailure: false,
        timeout: args.timeout ?? 30_000,
        maxParallel: args.maxParallel ?? DEFAULT_MAX_PARALLEL,
        retryOnFailure: args.retry,
        maxRetries: args.maxRetries ?? 2,
        successThreshold: args.successThreshold,
      },
      reporting: {
        format: (() => {
          if (!args.json) return 'table' as const;
          return args.unified ? ('unified' as const) : ('json' as const);
        })(),
        verbose: args.verbose ?? false,
      },
      ...(includeDisabled ? { includeDisabled } : {}),
      ...(args.file ? { fileFilter: args.file } : {}),
    };
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
