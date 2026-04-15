// @fitness-ignore-file file-length-limits -- Complex module with tightly coupled logic; splitting would fragment cohesive functionality
// @fitness-ignore-file eslint-backend -- Fitness framework orchestrator; ESLint rule variations between fitness runner and IDE are expected
/**
 * @fileoverview Central orchestrator for fitness recipe execution
 *
 * FitnessRecipeService resolves checks, manages session lifecycle,
 * coordinates parallel/sequential execution, and builds results.
 */

import { logger } from '../lib/logger.js'
import { NotFoundError, SystemError } from '../lib/errors.js'
import { generateId } from '../lib/ids.js'

import { fileCache, DEFAULT_PREWARM_PATTERNS } from '../framework/file-cache.js'
import { defaultRegistry, type Check, type CheckRegistry } from '../framework/registry.js'
import { initParseCache, clearParseCache } from '../framework/parse-cache.js'

import { resolveChecks, validateCheckReferences } from './check-resolution.js'
import { executeParallel, type ExecutionOptions, type ExecutionServiceContext } from './parallel-execution.js'
import { defaultRecipeRegistry, type FitnessRecipeRegistry } from './registry.js'
import { executeSequential } from './sequential-execution.js'
import type {
  FitnessRecipeServiceCallbacks,
  FitnessRecipeServiceConfig,
  FitnessRecipeSession,
} from './service-types.js'
import {
  DEFAULT_MAX_PARALLEL,
  type CheckSelector,
  type FitnessRecipe,
  type FitnessRecipeResult,
  type RecipeRunSummary,
} from './types.js'

const MODULE_FITNESS_RECIPES = 'fitness:recipes'

/** Default success threshold percentage when none is configured. */
const DEFAULT_SUCCESS_THRESHOLD_PERCENT = 85

/**
 * Compute prewarm glob patterns from the resolved checks' fileTypes.
 * If any check is universal (no fileTypes), falls back to DEFAULT_PREWARM_PATTERNS.
 */
function computePrewarmPatterns(checks: readonly Check[]): readonly string[] {
  const extensions = new Set<string>()
  for (const check of checks) {
    const ft = check.config.fileTypes
    if (!ft || ft.length === 0) {
      // Universal check — need all file types
      return DEFAULT_PREWARM_PATTERNS
    }
    for (const ext of ft) {
      extensions.add(ext)
    }
  }
  return [...extensions].sort().map((ext) => `**/*.${ext}`)
}

/**
 * Central orchestrator for fitness check execution.
 */
export class FitnessRecipeService {
  private readonly config: FitnessRecipeServiceConfig
  private readonly checkRegistry: CheckRegistry
  private readonly recipeRegistry: FitnessRecipeRegistry
  private activeSession: FitnessRecipeSession | null = null
  private abortController?: AbortController

  constructor(config?: FitnessRecipeServiceConfig) {
    this.config = config ?? {}
    this.checkRegistry = config?.checkRegistry ?? defaultRegistry
    this.recipeRegistry = config?.recipeRegistry ?? defaultRecipeRegistry
  }

  private get session(): FitnessRecipeSession {
    if (!this.activeSession) {
      throw new SystemError('No active session', { code: 'SYSTEM.FITNESS.NO_SESSION' })
    }
    return this.activeSession
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
      throw new SystemError('Recipe execution already in progress', { code: 'SYSTEM.FITNESS.SESSION_IN_PROGRESS' })
    }

    const recipe = typeof recipeOrName === 'string' ? this.getRecipe(recipeOrName) : recipeOrName

    if (!recipe) {
      // @fitness-ignore-next-line result-pattern-consistency -- internal method, exceptions propagate to CLI boundary
      throw new NotFoundError(`Recipe not found: ${String(recipeOrName)}`, { code: 'RESOURCE.NOT_FOUND.RECIPE', metadata: { entity: 'recipe', identifier: String(recipeOrName) } })
    }

    return this.executeRecipe(recipe)
  }

  private async executeRecipe(recipe: FitnessRecipe): Promise<FitnessRecipeResult> {
    const sessionId = this.generateSessionId()
    this.activeSession = this.createSession(sessionId, recipe)

    this.abortController = new AbortController()

    logger.info('Starting recipe session', { evt: 'fitness.recipe.session.start', module: MODULE_FITNESS_RECIPES, sessionId, recipeName: recipe.name })

    try {
      const cwd = this.config.cwd ?? process.cwd()
      const checks = this.resolveAndFilterChecks(recipe)

      this.activeSession.totalChecks = checks.length

      if (checks.length === 0) {
        return this.buildResult()
      }

      await this.prepareExecution(checks, cwd)

      // Execute
      const execOpts: ExecutionOptions = { checks, cwd, recipe, checkTargetFiles: this.config.checkTargetFiles }
      const execCtx: ExecutionServiceContext = {
        session: this.activeSession,
        callbacks: this.callbacks,
        abortController: this.abortController,
        includeViolations: this.config.includeViolations ?? false,
      }

      if (recipe.execution.mode === 'parallel') {
        await executeParallel(execCtx, execOpts)
      } else {
        await executeSequential(execCtx, execOpts)
      }

      this.activeSession.directives = this.collectAppliedDirectives()

      this.activeSession.status = 'completed'
      const result = this.buildResult()

      logger.info('Recipe session completed', { evt: 'fitness.recipe.session.complete', module: MODULE_FITNESS_RECIPES, sessionId, recipeName: recipe.name, passed: result.summary.passedChecks, failed: result.summary.failedChecks, durationMs: result.durationMs })
      void this.callbacks.onComplete?.(result)
      return result
    } catch (error) {
      logger.error('Recipe session failed', { evt: 'fitness.recipe.session.error', module: MODULE_FITNESS_RECIPES, sessionId, recipeName: recipe.name, err: error instanceof Error ? error : undefined })
      if (this.activeSession) {
        this.activeSession.status = 'failed'
      }
      throw error
    } finally {
      void clearParseCache()
      fileCache.clear()
      this.abortController?.abort()
      delete this.abortController
      this.activeSession = null
    }
  }

  private collectAppliedDirectives(): import('../framework/directive-inventory.js').DirectiveEntry[] {
    const result: import('../framework/directive-inventory.js').DirectiveEntry[] = []
    const session = this.activeSession
    if (!session) return result
    for (const cr of session.checkResults) {
      if (cr.appliedDirectives) {
        for (const directive of cr.appliedDirectives) {
          result.push(directive)
        }
      }
    }
    return result
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
    }
  }

  private resolveAndFilterChecks(recipe: FitnessRecipe): Check[] {
    const checkSlugs = resolveChecks(recipe.checks, this.checkRegistry)

    // Validate explicit references
    if (recipe.checks.type === 'explicit') {
      const allSlugs = this.checkRegistry.listSlugs()
      const { missing } = validateCheckReferences(recipe.checks.checkIds, [...allSlugs])
      if (missing.length > 0) {
        logger.warn(`Recipe references ${missing.length} unknown check(s)`, { evt: 'fitness.recipe.checks.missing', module: MODULE_FITNESS_RECIPES, missing, recipeName: recipe.name })
      }
    }

    const configDisabled = new Set(this.config.disabledChecks ?? [])
    const includeDisabledSet = new Set(recipe.includeDisabled ?? [])
    const checks: Check[] = []

    // Warn about unknown slugs in disabledChecks config
    if (configDisabled.size > 0) {
      const allSlugs = new Set(this.checkRegistry.listSlugs())
      const unknownDisabled = [...configDisabled].filter((s) => !allSlugs.has(s))
      if (unknownDisabled.length > 0) {
        logger.warn(`disabledChecks references ${unknownDisabled.length} unknown slug(s)`, { evt: 'fitness.recipe.disabled.unknown', module: MODULE_FITNESS_RECIPES, unknownDisabled })
      }
    }

    for (const slug of checkSlugs) {
      const check = this.checkRegistry.getBySlug(slug)
      if (!check) continue
      const bareSlug = slug.includes(':') ? slug.split(':').pop()! : slug
      const isDisabled = check.config.disabled || configDisabled.has(slug) || configDisabled.has(bareSlug)
      const isForceIncluded = includeDisabledSet.has(slug) || includeDisabledSet.has(bareSlug)
      if (!isDisabled || isForceIncluded) {
        checks.push(check)
      }
    }

    return checks
  }

  private async prepareExecution(checks: Check[], cwd: string): Promise<void> {
    // Sync check catalog for dashboard visibility
    if (this.callbacks.onCatalogSync) {
      const entries = this.checkRegistry.list().map((c) => ({
        id: c.config.id,
        slug: c.config.slug,
        tags: c.config.tags,
        description: c.config.description,
      }))
      void this.callbacks.onCatalogSync(entries)
    }

    // Prewarm file cache with only the extensions needed by resolved checks
    if (this.config.prewarmCache !== false) {
      const patterns = this.config.prewarmPatterns ?? computePrewarmPatterns(checks)
      await fileCache.prewarm(cwd, patterns)
    }

    // Initialize shared AST parse cache for cross-check deduplication
    void initParseCache()
  }

  private buildResult(): FitnessRecipeResult {
    const session = this.session
    const completedAt = new Date()

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
    }

    const score = session.totalChecks > 0 ? Math.round((session.passedChecks / session.totalChecks) * 100) : 100

    const result: FitnessRecipeResult = {
      recipeId: session.recipe.id,
      recipeName: session.recipe.name,
      sessionId: session.sessionId,
      success: score >= (session.recipe.execution.successThreshold ?? DEFAULT_SUCCESS_THRESHOLD_PERCENT) && session.status === 'completed',
      startedAt: session.startedAt,
      completedAt,
      durationMs: completedAt.getTime() - session.startedAt.getTime(),
      checkResults: session.checkResults,
      summary,
    }

    return {
      ...result,
      ...(session.ignoreCounts ? { ignoreCounts: session.ignoreCounts } : {}),
      ...(session.directives.length > 0 ? { directives: session.directives } : {}),
    }
  }

  /**
   * Convert CLI arguments to an ad-hoc FitnessRecipe.
   */
  static createAdHocRecipe(args: {
    check?: string
    tagFilters?: string[]
    file?: string
    parallel?: boolean
    json?: boolean
    unified?: boolean
    verbose?: boolean
    retry?: boolean
    maxRetries?: number
    maxParallel?: number
    timeout?: number
    successThreshold?: number
  }): FitnessRecipe {
    let checks: CheckSelector
    let includeDisabled: string[] | undefined

    if (args.check) {
      if (args.check.includes('*') || args.check.includes('?')) {
        checks = { type: 'pattern', include: [args.check] }
      } else {
        checks = { type: 'explicit', checkIds: [args.check] }
        includeDisabled = [args.check]
      }
    } else if (args.tagFilters?.length) {
      checks = { type: 'tags', include: args.tagFilters }
    } else {
      checks = { type: 'all', exclude: [] }
    }

    return {
      id: 'RCP_cli-adhoc',
      name: 'cli-adhoc',
      displayName: 'CLI Ad-Hoc',
      description: 'Dynamically created recipe from CLI arguments',
      checks,
      execution: {
        mode: args.parallel !== false ? 'parallel' : 'sequential',
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
          return args.unified ? 'unified' as const : 'json' as const;
        })(),
        verbose: args.verbose ?? false,
      },
      ...(includeDisabled ? { includeDisabled } : {}),
      ...(args.file ? { fileFilter: args.file } : {}),
    }
  }

  /** Get the currently active session, or null if no recipe is running. */
  getActiveSession(): FitnessRecipeSession | null {
    return this.activeSession
  }

  /** Abort the currently running recipe execution. No-op if no session is active. */
  abort(): void {
    this.abortController?.abort()
  }

  /** List all available recipes from the recipe registry. */
  listRecipes(): readonly FitnessRecipe[] {
    return this.recipeRegistry.getAllRecipes()
  }

  /**
   * Look up a recipe by name or ID.
   * @param nameOrId - The recipe name or full recipe ID (e.g. "default" or "RCP_default").
   * @returns The recipe if found, undefined otherwise.
   */
  getRecipe(nameOrId: string): FitnessRecipe | undefined {
    return this.recipeRegistry.loadRecipe(nameOrId)
  }

  protected generateSessionId(): string {
    return generateId('SES')
  }

  protected get callbacks(): FitnessRecipeServiceCallbacks {
    return this.config.callbacks ?? {}
  }
}

