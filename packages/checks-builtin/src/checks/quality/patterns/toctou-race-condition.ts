/**
 * @fileoverview TOCTOU Race Condition Detection Check
 *
 * Detects Time-of-Check-Time-of-Use race conditions where data is read,
 * then updated without passing version/condition for atomic updates.
 */

import * as ts from 'typescript'

import { defineCheck, getCheckConfig, type CheckViolation } from '@opensip-tools/core'
import { getSharedSourceFile } from '@opensip-tools/core/framework/parse-cache.js'
import { isTestFile } from '../../../utils/index.js'

/**
 * Recipe-config shape for toctou-race-condition. Project-specific safe-paths
 * (e.g. opensip's `/chain-walker/`) belong in a recipe's
 * `checks.config['toctou-race-condition']` block, not in built-in defaults.
 */
export interface TocTouConfig extends Record<string, unknown> {
  /**
   * Additional path patterns where TOCTOU is not a concern. Each entry is
   * compiled to a case-insensitive RegExp via `new RegExp(entry, 'i')`.
   */
  additionalSafeTOCTOUPaths?: readonly string[]
}

const TOCTOU_SLUG = 'toctou-race-condition'

/** Patterns that indicate proper atomic update handling */
const ATOMIC_PATTERNS = [
  /expectedVersion/i,
  /version\s*:/,
  /ConditionExpression/,
  /conditionalUpdate/i,
  /atomicUpdate/i,
  /compareAndSwap/i,
  /optimisticLock/i,
  /CONCURRENCY SAFE/,
  // Transaction patterns
  /transaction/i,
  /beginTransaction/i,
  /withTransaction/i,
  /runInTransaction/i,
  // Lock patterns
  /acquireLock/i,
  /withLock/i,
  /mutex/i,
  // Idempotency patterns
  /idempotent/i,
  /idempotencyKey/i,
  // Single-threaded/in-memory safety comments
  /single-threaded/i,
  /in-memory/i,
  /atomic in.*Node/i,
  // Documented coalescing/event-loop safety patterns commonly used in Node single-threaded code
  /single-threaded coalesce/i, // explicit coalescing-cache documentation
  /Node single-threaded/i,     // explicit Node single-threaded documentation
  /event-loop semantics/i,     // explicit event-loop atomicity documentation
]

/**
 * Paths where TOCTOU is typically not a concern
 * (in-memory caches, rate limiters, local state managers)
 */
const SAFE_TOCTOU_PATHS = [
  // In-memory data structures
  /\/cache\//i,
  /\/caching\//i,
  /memory-backend/i,
  /memory-cache/i,
  /memory-store/i,
  /in-memory/i,
  // Filename conventions — `*-cache.ts` and `*-prefetcher.ts` are
  // single-threaded coalescing structures by convention (Node event-loop
  // semantics make the .get-then-.set pattern safe). The path-segment
  // /cache/ skip above misses files at top of a package's src/ tree.
  /-cache\.tsx?$/i,
  /-prefetcher\.tsx?$/i,
  // Rate limiting (bounded operations)
  /rate-limit/i,
  /rate_limit/i,
  // Local state management
  /local-storage/i,
  /local-state/i,
  /state-manager/i,
  // CLI/scripts (single user, non-concurrent)
  // CLI commands use local Map/Set operations that are not shared-state TOCTOU risks.
  // Server lifecycle TOCTOU issues are better caught by the reentrancy-guard check.
  /\/cli\//,
  /\/scripts\//,
  // Test utilities
  /\/testing\//,
  /test-utils/,
  // Configuration/Registry (startup-time operations)
  /\/config\//,
  /\/registry\//,
  /\/di-registration\//,
  /\/factories\//,
  // Route handlers — request-scoped Map/Set ops are not shared-state TOCTOU; route handlers are dominated by Zod.pick/parse and per-request local maps that the regex misreads as TOCTOU.
  /\/routes\//,
  // DI composition — fragment graphs construct a per-startup map of providers; not concurrent shared state.
  /\/di\//,
  // Schema declarations — Drizzle/Zod schema files are pure declarative builders, no runtime read/update race surface.
  /\/schema\//,
  // NOTE: opensip-specific paths (e.g. `/chain-walker/` for audit-chain
  // walkers) are NOT defaults. They live in opensip's recipe under
  // `checks.config['toctou-race-condition'].additionalSafeTOCTOUPaths`.
]

/**
 * Compile recipe-provided string entries to case-insensitive RegExp values.
 */
function buildEffectiveSafePaths(): readonly RegExp[] {
  const cfg = getCheckConfig<TocTouConfig>(TOCTOU_SLUG)
  const extras = (cfg.additionalSafeTOCTOUPaths ?? []).map((src) => new RegExp(src, 'i'))
  return [...SAFE_TOCTOU_PATHS, ...extras]
}

/**
 * Check if a file path is in a safe TOCTOU context. Combines built-in
 * defaults with the recipe-config augmentation.
 */
function isSafeToctouPath(filePath: string, safePaths: readonly RegExp[]): boolean {
  return safePaths.some((pattern) => pattern.test(filePath))
}

/** Read operation patterns */
const READ_PATTERNS = [
  /\.get\(/,
  /\.find\(/,
  /\.findOne\(/,
  /\.getById\(/,
  /\.fetch\(/,
  /\.load\(/,
  /\.read\(/,
]

/** Update operation patterns */
const UPDATE_PATTERNS = [/\.update\(/, /\.save\(/, /\.put\(/, /\.set\(/, /\.patch\(/, /\.modify\(/]

/**
 * Check if content has required read/update patterns
 */
function hasRequiredPatterns(content: string): boolean {
  const hasRead = READ_PATTERNS.some((p) => p.test(content))
  const hasUpdate = UPDATE_PATTERNS.some((p) => p.test(content))
  return hasRead && hasUpdate
}

/**
 * Check if content has atomic patterns
 */
function hasAtomicPatterns(content: string): boolean {
  return ATOMIC_PATTERNS.some((p) => p.test(content))
}

/**
 * Function-like node types that can have TOCTOU patterns
 */
type FunctionLikeNode =
  | ts.FunctionDeclaration
  | ts.MethodDeclaration
  | ts.ArrowFunction
  | ts.FunctionExpression

/**
 * Get function name from a function-like node
 */
function getFunctionNameFromNode(node: FunctionLikeNode, sourceFile: ts.SourceFile): string {
  if (ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node)) {
    return node.name?.getText(sourceFile) ?? 'anonymous'
  }
  if (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) {
    const parent = node.parent
    if (ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name)) {
      return parent.name.getText(sourceFile)
    }
  }
  return 'anonymous'
}

/**
 * Check if a function has TOCTOU pattern
 */
function hasToctouPattern(funcText: string): boolean {
  const funcHasRead = READ_PATTERNS.some((p) => p.test(funcText))
  const funcHasUpdate = UPDATE_PATTERNS.some((p) => p.test(funcText))
  const funcHasAtomic = ATOMIC_PATTERNS.some((p) => p.test(funcText))
  return funcHasRead && funcHasUpdate && !funcHasAtomic
}

/**
 * Check if node is a function-like node
 */
function isFunctionLikeNode(node: ts.Node): node is FunctionLikeNode {
  return (
    ts.isFunctionDeclaration(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isArrowFunction(node) ||
    ts.isFunctionExpression(node)
  )
}

/**
 * Options for checking a function for TOCTOU patterns
 */
interface CheckFunctionForToctouOptions {
  node: FunctionLikeNode
  sourceFile: ts.SourceFile
}

/**
 * Check a function for TOCTOU patterns
 * @param options - The options for the check
 * @returns CheckViolation if found, null otherwise
 */
function checkFunctionForToctou(options: CheckFunctionForToctouOptions): CheckViolation | null {
  const { node, sourceFile } = options
  const funcText = node.getText(sourceFile)

  if (!hasToctouPattern(funcText)) {
    return null
  }

  const { line, character } = sourceFile.getLineAndCharacterOfPosition(node.getStart())
  const lineNum = line + 1
  const funcName = getFunctionNameFromNode(node, sourceFile)

  return {
    line: lineNum,
    column: character + 1,
    message: `Function '${funcName}' has read-then-update pattern without atomic guarantees`,
    severity: 'warning',
    suggestion:
      'Use optimistic locking: pass expectedVersion to update, or use ConditionExpression for DynamoDB, or wrap in a transaction with SELECT FOR UPDATE for SQL',
    match: funcName,
  }
}

/**
 * Analyze a file for TOCTOU race conditions
 */
function analyzeFileForToctou(filePath: string, content: string): CheckViolation[] {
  const violations: CheckViolation[] = []

  // Skip files in safe TOCTOU paths (caches, rate limiters, CLI, etc.).
  // Merge built-in defaults with recipe config once per file.
  const safePaths = buildEffectiveSafePaths()
  if (isSafeToctouPath(filePath, safePaths)) {
    return violations
  }

  // Quick filter: must have both read and update patterns
  if (!hasRequiredPatterns(content)) {
    return violations
  }

  // Skip if file has atomic patterns
  if (hasAtomicPatterns(content)) {
    return violations
  }

  const sourceFile = getSharedSourceFile(filePath, content)
    if (!sourceFile) return []

  const visit = (node: ts.Node): void => {
    if (isFunctionLikeNode(node)) {
      const violation = checkFunctionForToctou({ node, sourceFile })
      if (violation) {
        violations.push(violation)
      }
    }
    ts.forEachChild(node, visit)
  }

  visit(sourceFile)
  return violations
}

/**
 * Check: quality/toctou-race-condition
 *
 * Detects read-then-update patterns without atomic guarantees.
 */
export const toctouRaceCondition = defineCheck({
  id: 'eb67d6f3-c984-485d-b077-1ebabea0d894',
  slug: 'toctou-race-condition',
  scope: { languages: ['typescript'], concerns: ['backend', 'server'] },
  contentFilter: 'code-only',

  confidence: 'high',
  description: 'Detects read-then-update patterns without atomic guarantees',
  longDescription: `**Purpose:** Detects Time-of-Check-Time-of-Use (TOCTOU) race conditions where data is read then updated without atomic guarantees.

**Detects:** Analyzes each file individually using TypeScript AST. Finds functions containing both read operations (\`.get(\`, \`.find(\`, \`.findOne(\`, \`.getById(\`, \`.fetch(\`, \`.load(\`, \`.read(\`) and update operations (\`.update(\`, \`.save(\`, \`.put(\`, \`.set(\`, \`.patch(\`, \`.modify(\`) without any atomic pattern (\`expectedVersion\`, \`ConditionExpression\`, \`transaction\`, \`acquireLock\`, \`mutex\`, \`optimisticLock\`, etc.). Skips safe contexts: in-memory caches, rate limiters, CLI/scripts, config/registry files.

**Why it matters:** TOCTOU bugs allow concurrent requests to overwrite each other's changes, causing silent data loss that only manifests under load.

**Scope:** General best practice`,
  tags: ['quality', 'performance', 'best-practices'],
  fileTypes: ['ts'],
  // @fitness-ignore-next-line no-hardcoded-timeouts -- framework default for fitness check execution
  timeout: 180000, // 3 minutes - analyzes read-then-update patterns

  analyze(content, filePath) {
    // Skip test files — TOCTOU patterns in tests are low-risk
    if (isTestFile(filePath)) return []
    return analyzeFileForToctou(filePath, content)
  },
})
