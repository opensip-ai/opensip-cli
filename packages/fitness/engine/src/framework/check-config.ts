// @fitness-ignore-file zod-schema-strictness -- flexible schema for external data
// @fitness-ignore-file null-safety -- Zod schema builder chains (z.string().regex(), z.object().passthrough().superRefine().pipe()) always return valid schema objects
/**
 * @fileoverview Unified check configuration schema
 *
 * Defines the configuration types for fitness checks with three analysis modes:
 * - analyze: Per-file analysis with content and path
 * - analyzeAll: Multi-file analysis with lazy loading FileAccessor
 * - command: External tool execution with output parsing
 */

import { z } from 'zod'

import type { ItemType } from '../types/findings.js'

// =============================================================================
// CHECK SLUGS AND IDS
// =============================================================================

/** Zod schema for validating kebab-case check slugs. */
const CheckSlugSchema = z
  .string()
  .regex(/^[a-z][a-z0-9-]*(?:-[a-z0-9]+)*$/, 'Check slug must be kebab-case (e.g., no-console-log)')

/** Zod schema for validating UUID-format check IDs. */
const CheckIdSchema = z
  .string()
  .regex(
    /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/,
    'Check ID must be plain UUID format',
  )

/** Type alias for a kebab-case check slug string. */
// eslint-disable-next-line sonarjs/redundant-type-aliases -- semantic alias documents intent ("a slug" vs raw string)
type CheckSlug = string

// =============================================================================
// RESOLVED SCOPE (glob-based file matching)
// =============================================================================

/**
 * Resolved scope with concrete glob patterns for file matching.
 * Produced by resolving a CheckScope against targets configuration.
 */
export interface ResolvedScope {
  readonly include: readonly string[]
  readonly exclude: readonly string[]
  readonly description: string
}

// =============================================================================
// CHECK SCOPE (semantic, marketplace-ready)
// =============================================================================

/**
 * Semantic concern describing what kind of code a check targets.
 * Used for automatic target matching: a check with `concerns: ['backend']`
 * matches any target that declares `concerns: ['backend', ...]`.
 */
// eslint-disable-next-line sonarjs/redundant-type-aliases -- semantic alias documents the marketplace concern dimension
export type CheckConcern = string

/**
 * Language a check is designed for. Used for automatic target matching:
 * a check with `languages: ['typescript']` matches any target with
 * `languages: ['typescript', ...]`.
 */
// eslint-disable-next-line sonarjs/redundant-type-aliases -- semantic alias documents the marketplace language dimension
export type CheckLanguage = string

/**
 * Portable scope declaration for a fitness check.
 *
 * Instead of referencing project-specific target names, checks declare
 * what kind of code they analyze. The platform matches this intent
 * against project targets automatically.
 *
 * @example
 * ```typescript
 * scope: {
 *   languages: ['typescript'],
 *   concerns: ['backend', 'server'],
 * }
 * ```
 */
export interface CheckScope {
  /** File type affinity — which languages this check analyzes. */
  readonly languages: readonly CheckLanguage[]
  /** Semantic hints — what kind of code this check targets. */
  readonly concerns: readonly CheckConcern[]
}

// =============================================================================
// CHECK VIOLATION (AUTHOR'S RETURN TYPE)
// =============================================================================

/**
 * Violation returned by check authors.
 * This is the simplified shape - the framework converts it to a Signal.
 */
export interface CheckViolation {
  readonly line: number
  readonly column?: number
  readonly message: string
  readonly severity: 'error' | 'warning'
  readonly suggestion?: string
  readonly match?: string
  readonly type?: string
  readonly filePath?: string
  readonly fix?: {
    readonly action: 'replace' | 'insert' | 'delete' | 'refactor' | 'configure' | 'investigate'
    readonly replacement?: string
    readonly confidence: number
  }
}

// =============================================================================
// FILE ACCESSOR (FOR ANALYZE ALL MODE)
// =============================================================================

/**
 * Lazy-loading file accessor for analyzeAll mode.
 */
export interface FileAccessor {
  /** List of matched file paths */
  readonly paths: readonly string[]
  /** Read a single file on demand (cached after first read) */
  read(filePath: string): Promise<string>
  /** Read multiple files in batch */
  readMany(filePaths: readonly string[]): Promise<Map<string, string>>
  /** Read all matched files */
  readAll(): Promise<Map<string, string>>
}

// =============================================================================
// COMMAND MODE TYPES
// =============================================================================

/** Configuration for an external command-based check. */
export interface CommandConfig {
  readonly bin: string
  readonly args: readonly string[] | ((files: readonly string[]) => readonly string[])
  parseOutput(
    stdout: string,
    stderr: string,
    exitCode: number,
    files: readonly string[],
    cwd: string,
  ): CheckViolation[]
  readonly expectedExitCodes?: readonly number[]
}

const CommandArgsSchema = z.union([z.array(z.string()), z.function()])

/** Zod schema for validating command configurations. */
const CommandConfigSchema = z.object({
  bin: z.string().min(1),
  args: CommandArgsSchema,
  parseOutput: z.function(),
  expectedExitCodes: z.array(z.number().int()).optional(),
})

// =============================================================================
// ANALYSIS MODE SCHEMAS
// =============================================================================

const AnalyzeModeSchema = z.object({ analyze: z.function() })
const AnalyzeAllModeSchema = z.object({ analyzeAll: z.function() })
const CommandModeSchema = z.object({ command: CommandConfigSchema })

// =============================================================================
// BASE CHECK CONFIG
// =============================================================================

/** Common configuration fields shared by all check types. */
interface BaseCheckConfig {
  readonly id: string
  readonly slug: CheckSlug
  readonly description: string
  readonly longDescription?: string
  readonly tags: readonly string[]
  readonly docs?: string
  readonly timeout?: number
  readonly disabled?: boolean
  readonly fileTypes?: readonly string[]
  /** Signal provider name for external tool checks (default: 'opensip') */
  readonly provider?: string
  /** The type of items this check validates (default: 'files'). Used for display in results table. */
  readonly itemType?: ItemType
  /** Portable scope declaration for marketplace-ready target matching. */
  readonly scope?: CheckScope
  /**
   * Content filtering mode for the analyze() function. Names describe
   * what the filter strips so rule authors don't have to guess at intent.
   *
   * - 'raw' (default): Full file content, unchanged. Use for checks that
   *   need to analyze string content (e.g., hardcoded secrets, PII detection).
   * - 'strip-strings': String literals replaced with whitespace,
   *   preserving line/column positions. COMMENTS PRESERVED — use when
   *   the check reads comment-based directives like the deprecation
   *   marker, the swallow-ok marker, or `// @fitness-ignore-...` (we
   *   don't reference those tag names verbatim in this JSDoc to avoid
   *   confusing static analyzers).
   * - 'strip-strings-and-comments': BOTH string literals and comments
   *   replaced with whitespace, preserving line/column positions. Use
   *   for checks that pattern-match identifiers via regex and would
   *   false-positive on the same banned phrase appearing in JSDoc /
   *   line / block comments documenting the rule itself.
   *
   * The legacy `'code-only'` / `'no-strings-no-comments'` aliases were
   * retained through 0.4.x for backwards-compat and removed in 0.5.0.
   * Migrate any remaining call sites to the strip-* names.
   */
  readonly contentFilter?: 'raw' | 'strip-strings' | 'strip-strings-and-comments'
  /**
   * Confidence level of this check's findings. Consumers of opensip-tools
   * signals (via --report-to) use this to decide how aggressively to act
   * on findings; this package treats it as pure metadata.
   *
   * - 'high': AST-based or structurally guaranteed no false positives.
   * - 'medium': Regex with context filtering — some false positives expected.
   * - 'low': Naive regex or heuristic — surfaced in reports but easily noisy.
   *
   * Default: 'medium' (applied at runtime, not in schema).
   */
  readonly confidence?: 'high' | 'medium' | 'low'
}

/**
 * Zod schema for validating check scope declarations.
 *
 * Empty `languages` and empty `concerns` are both valid and mean
 * "matches any". This is how cross-language ("universal") checks
 * declare themselves — see @opensip-tools/checks-universal.
 *
 * findByScope() in TargetRegistry treats empty arrays as match-any
 * already; the schema mirrors that behavior so callers can author
 * universal checks without inventing a wildcard sentinel.
 */
const CheckScopeSchema = z.object({
  languages: z.array(z.string()),
  concerns: z.array(z.string()),
})

const BaseCheckConfigSchema = z.object({
  id: CheckIdSchema,
  slug: CheckSlugSchema,
  description: z.string().min(1, 'Description is required'),
  longDescription: z.string().optional(),
  tags: z.array(z.string()).min(1, 'At least one tag is required'),
  docs: z.string().optional(),
  timeout: z.number().positive().optional(),
  disabled: z.boolean().optional(),
  fileTypes: z.array(z.string()).optional(),
  provider: z.string().optional(),
  scope: CheckScopeSchema.optional(),
  contentFilter: z.enum(['raw', 'strip-strings', 'strip-strings-and-comments']).optional(),
  confidence: z.enum(['high', 'medium', 'low']).optional(),
})

// =============================================================================
// UNIFIED CHECK CONFIG
// =============================================================================

/** Check config with per-file analysis mode. */
export interface AnalyzeCheckConfig extends BaseCheckConfig {
  analyze(content: string, filePath: string): CheckViolation[]
}

/** Check config with multi-file analysis mode using FileAccessor. */
export interface AnalyzeAllCheckConfig extends BaseCheckConfig {
  analyzeAll(files: FileAccessor): Promise<CheckViolation[]>
}

/** Check config with external command execution mode. */
export interface CommandCheckConfig extends BaseCheckConfig {
  command: CommandConfig
}

/** Union of all check configuration types (analyze, analyzeAll, command). */
export type UnifiedCheckConfig = AnalyzeCheckConfig | AnalyzeAllCheckConfig | CommandCheckConfig

// =============================================================================
// VALIDATION
// =============================================================================

/** Zod schema for validating unified check configurations (exactly one analysis mode required). */
const UnifiedCheckConfigSchema = z
  .object({})
  .passthrough()
  .superRefine((config, ctx) => {
    const modes = ['analyze' in config, 'analyzeAll' in config, 'command' in config].filter(
      Boolean,
    ).length

    if (modes === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Check config must specify an analysis mode: analyze, analyzeAll, or command',
      })
    } else if (modes > 1) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Check config must specify exactly one analysis mode (found multiple)',
      })
    }
  })
  .pipe(
    BaseCheckConfigSchema.and(
      z.union([AnalyzeModeSchema, AnalyzeAllModeSchema, CommandModeSchema]),
    ),
  )

/** Validate and parse a check configuration, throwing on invalid input. */
export function validateCheckConfig(config: unknown): UnifiedCheckConfig {
  return UnifiedCheckConfigSchema.parse(config) as UnifiedCheckConfig
}

/** Type guard for per-file analyze mode checks. */
export function isAnalyzeConfig(config: UnifiedCheckConfig): config is AnalyzeCheckConfig {
  return 'analyze' in config && typeof config.analyze === 'function'
}

/** Type guard for multi-file analyzeAll mode checks. */
export function isAnalyzeAllConfig(config: UnifiedCheckConfig): config is AnalyzeAllCheckConfig {
  return 'analyzeAll' in config && typeof config.analyzeAll === 'function'
}

/** Type guard for external command mode checks. */
export function isCommandConfig(config: UnifiedCheckConfig): config is CommandCheckConfig {
  return 'command' in config && typeof config.command === 'object'
}

/** Determine which analysis mode a check config uses. */
export function getAnalysisMode(config: UnifiedCheckConfig): 'analyze' | 'analyzeAll' | 'command' {
  if (isAnalyzeConfig(config)) return 'analyze'
  if (isAnalyzeAllConfig(config)) return 'analyzeAll'
  return 'command'
}
