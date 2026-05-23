// @fitness-ignore-file unused-config-options -- Config options reserved for future use or environment-specific
// @fitness-ignore-file context-mutation-check -- Local array/object mutations are safe within function scope; not shared context
// @fitness-ignore-file silent-early-returns -- Guard clauses in pattern matching function return false for non-matching patterns
/**
 * @fileoverview Context mutation safety check — flags direct mutation of
 * request/execution context objects, which causes side effects across
 * middleware in concurrent server environments.
 */

import { logger } from '@opensip-tools/core/logger'
import { defineCheck, isCommentLine, type CheckViolation } from '@opensip-tools/fitness'

// =============================================================================
// CONTEXT MUTATION CHECK
// =============================================================================

/**
 * Safe string patterns for checking context objects.
 * Using string includes for safe, linear-time matching.
 */
const CONTEXT_STRING_PATTERNS = [
  'request.context',
  'request.ctx',
  'req.context',
  'req.ctx',
  'ctx.',
  'context.',
  'RequestContext',
  'ExecutionContext',
]

/**
 * Checks if content uses context patterns.
 * @param content - The content to check
 * @returns True if content contains context patterns
 */
function usesContextPattern(content: string): boolean {
  return CONTEXT_STRING_PATTERNS.some((pattern) => content.includes(pattern))
}

/**
 * Detects local declarations of `ctx` or `context` as a function-scoped
 * variable — `const ctx = {...}`, `const ctx: T = {...}`, `let ctx`,
 * `var ctx`. When such a declaration exists in the file, every
 * subsequent `ctx.X =` mutation is a local-object-construction
 * pattern, NOT a mutation of a shared request context. Skipping those
 * lines eliminates the canonical false-positive where a function
 * builds a return object named `ctx` and the check flags it as
 * request-context mutation.
 *
 * Whole-word matching prevents collisions with `myCtx`, `subContext`,
 * etc. Returns the set of identifier names that are locally declared
 * — callers consult it before flagging a mutation rooted at that
 * identifier.
 */
const LOCAL_DECLARATION_PATTERNS: readonly (readonly [string, RegExp])[] = [
  ['ctx', /\b(?:const|let|var)\s+ctx\b(?!\s*\.)/],
  ['context', /\b(?:const|let|var)\s+context\b(?!\s*\.)/],
]
function findLocallyDeclaredNames(content: string): Set<string> {
  const declared = new Set<string>()
  for (const [name, pattern] of LOCAL_DECLARATION_PATTERNS) {
    if (pattern.test(content)) declared.add(name)
  }
  return declared
}

/**
 * Mutation detection configuration.
 * Using simple string matching for linear-time detection.
 */
interface MutationDetector {
  readonly test: (line: string) => boolean
  readonly patternName: string
}

/**
 * Finds the end index of a word (consecutive word characters) in a string.
 * @param str - The string to search
 * @returns The index after the last word character, or 0 if no word characters found
 */
function findWordEndIndex(str: string): number {
  logger.debug({
    evt: 'fitness.checks.context_safety.find_word_end_index',
    msg: 'Finding end index of word characters in string',
  })
  let wordEnd = 0
  // eslint-disable-next-line unicorn/no-for-loop -- offset-bearing scan: returns the UTF-16 index after the last word char
  for (let i = 0; i < str.length; i++) {
    const char = str[i]
    if (char === undefined || !/\w/.test(char)) {
      return wordEnd
    }
    wordEnd = i + 1
  }
  return wordEnd
}

/**
 * Creates a safe mutation detector using string matching.
 * Detects patterns like: ctx.property = or context.field =
 * Does NOT match comparison operators (==, ===, !=, !==)
 * @param prefix - The prefix to match (e.g., 'ctx.')
 * @returns A detector that checks for assignment after prefix and word
 */
function createAssignmentDetector(prefix: string): MutationDetector {
  return {
    test: (line: string): boolean => {
      logger.debug({
        evt: 'fitness.checks.context_safety.assignment_detector_test',
        msg: 'Testing line for context assignment mutation',
      })
      const idx = line.indexOf(prefix)
      if (idx === -1) return false
      // Find next non-word character after prefix
      const afterPrefix = line.slice(Math.max(0, idx + prefix.length))
      // Must have at least one word character
      const wordEnd = findWordEndIndex(afterPrefix)
      if (wordEnd === 0) return false
      const afterWord = afterPrefix.slice(Math.max(0, wordEnd)).trimStart()
      // Check for assignment (but NOT comparison operators)
      if (!afterWord.startsWith('=')) return false
      // Exclude === and == (comparison) and !=, !==
      const secondChar = afterWord.charAt(1)
      if (secondChar === '=' || secondChar === '!') return false
      return true
    },
    patternName: `${prefix}*=`,
  }
}

/**
 * Creates a simple string contains detector.
 * @param pattern - The string pattern to match
 * @returns A detector that checks for pattern inclusion
 */
function createContainsDetector(pattern: string): MutationDetector {
  return {
    test: (line: string): boolean => line.includes(pattern),
    patternName: pattern,
  }
}

/**
 * Creates a detector for array mutation methods on context objects.
 * Only matches patterns like ctx.array.push() or context.items.splice()
 * Does NOT match local variables like myArray.push()
 * @param method - The method name (e.g., 'push', 'splice')
 * @returns A detector that checks for context-prefixed array mutations
 */
function createContextArrayMutationDetector(method: string): MutationDetector {
  const contextPrefixes = [
    'ctx.',
    'context.',
    'req.context.',
    'request.context.',
    'req.',
    'request.',
  ]
  return {
    test: (line: string): boolean => {
      logger.debug({
        evt: 'fitness.checks.context_safety.array_mutation_detector_test',
        msg: 'Testing line for context array mutation pattern',
      })
      // Must contain the method call
      if (!line.includes(`.${method}(`)) return false
      // Check if it's prefixed by a context variable
      for (const prefix of contextPrefixes) {
        const prefixIdx = line.indexOf(prefix)
        if (prefixIdx !== -1) {
          // Check if the method call is after the context prefix
          const methodIdx = line.indexOf(`.${method}(`, prefixIdx)
          if (methodIdx > prefixIdx) {
            return true
          }
        }
      }
      return false
    },
    patternName: `ctx/*.${method}()`,
  }
}

/**
 * Safe mutation detectors using string-based matching.
 * Only flags mutations on actual context objects, not local variables.
 */
const MUTATION_DETECTORS: readonly MutationDetector[] = [
  createAssignmentDetector('ctx.'),
  createAssignmentDetector('context.'),
  createAssignmentDetector('req.context.'),
  createAssignmentDetector('request.context.'),
  createContainsDetector('Object.assign(ctx'),
  createContainsDetector('Object.assign( ctx'),
  createContainsDetector('Object.assign(context'),
  createContainsDetector('Object.assign( context'),
  // Only flag array mutations when prefixed by context objects
  createContextArrayMutationDetector('push'),
  createContextArrayMutationDetector('splice'),
  createContextArrayMutationDetector('pop'),
  createContextArrayMutationDetector('shift'),
  createContextArrayMutationDetector('unshift'),
  createContainsDetector('delete ctx.'),
  createContainsDetector('delete context.'),
]

/**
 * Safe keywords (allowed mutations).
 * These are common fields that are either:
 * - Standard context setup fields that are expected to be set
 * - Fields that indicate local object construction, not request context mutation
 */
const SAFE_KEYWORDS = [
  'correlationId',
  'requestId',
  'traceId',
  'spanId',
  'logger',
  'startTime',
  // Common local context construction patterns
  'userId', // User ID setup in local context objects
  'timestamp', // Timestamp field in local context
  'details', // Details field in error/result context
  'metadata', // Metadata field in local context
  'statusCode', // Status code in error context
  'code', // Error code in error context
  // Recovery/retry execution context fields
  'fallbackAttempts', // Used in recovery/retry execution contexts
  'lastError', // Used in retry execution contexts
  'strategy', // Used in retry execution contexts
  'retryAttempts', // Used in retry execution contexts
  // Validation context fields
  'schemaName', // Used in validation contexts
  // Ticket/build context fields
  'git', // Used in ticket/build context
  'environment', // Used in ticket/build context
  // Search relevance context fields
  'userPreferences', // Used in search relevance context
  'boosts', // Used in search relevance context
  // Fitness check analysis context fields
  'violations', // Used in fitness check analysis contexts
]

/**
 * Safe context prefixes that indicate non-request context objects.
 * These are local/scoped context objects, not shared request contexts.
 */
const SAFE_CONTEXT_PREFIXES = [
  'entry.context', // Log entry context (per-entry metadata)
  'logEntry.context', // Log entry context
  'this.context', // Builder pattern on class instances
  'result.context', // Result/response context
  'error.context', // Error context builder
  'config.context', // Configuration context
  'options.context', // Options object context
  'params.context', // Parameters context
  'state.context', // Local state context
  'item.context', // Item/element context
  'record.context', // Record context
  'event.context', // Event context
]

/**
 * Checks if a line contains safe mutation patterns.
 * @param line - The line to check
 * @returns True if line contains safe patterns
 */
function isSafeMutation(line: string): boolean {
  logger.debug({
    evt: 'fitness.checks.context_safety.is_safe_mutation',
    msg: 'Checking if line contains safe mutation patterns',
  })
  // Check for safe keywords
  if (SAFE_KEYWORDS.some((keyword) => line.includes(keyword))) {
    return true
  }
  // Check for safe context prefixes (non-request context objects)
  if (SAFE_CONTEXT_PREFIXES.some((prefix) => line.includes(prefix))) {
    return true
  }
  return false
}

/**
 * Find a mutation detector that matches the line.
 * @param line - The line to check.
 * @returns The matching detector and whether it's a safe mutation, or null if no match.
 */
function findMutationMatch(line: string): { detector: MutationDetector; isSafe: boolean } | null {
  for (const detector of MUTATION_DETECTORS) {
    if (detector.test(line)) {
      return { detector, isSafe: isSafeMutation(line) }
    }
  }
  return null
}

/**
 * Check if the mutation is defensive (inside a try block).
 * @param lines - All lines of the file.
 * @param index - Current line index.
 * @returns True if the mutation is in a try block.
 */
function isDefensiveMutation(lines: string[], index: number): boolean {
  if (!Array.isArray(lines)) {
    return false
  }
  const contextBefore = lines.slice(Math.max(0, index - 5), index).join('\n')
  return contextBefore.includes('try')
}

/**
 * Pure analysis function. Exported so unit tests can exercise the
 * detection logic without standing up the full Check framework
 * (defineCheck wraps `analyze` into an `execute` closure that requires
 * an ExecutionContext to invoke).
 */
export function analyzeContextMutation(content: string, filePath: string): CheckViolation[] {
  logger.debug({
    evt: 'fitness.checks.context_safety.context_mutation_check_analyze',
    msg: 'Analyzing file for unsafe context mutations',
  })
  const violations: CheckViolation[] = []

  if (!usesContextPattern(content)) return violations

  const locallyDeclared = findLocallyDeclaredNames(content)

  const lines = content.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (line === undefined || !line) continue
    if (isCommentLine(line)) continue

    const match = findMutationMatch(line)
    if (!match || match.isSafe) continue

    // eslint-disable-next-line sonarjs/slow-regex -- bounded input: patternName is a short literal like 'ctx.*=' / 'context.*=' authored above in MUTATION_DETECTORS, not attacker input
    const rootName = match.detector.patternName.replace(/\..*$/, '')
    if (locallyDeclared.has(rootName)) continue

    const isDefensive = isDefensiveMutation(lines, i)
    const lineNumber = i + 1

    violations.push({
      line: lineNumber,
      column: 0,
      message: 'Mutation of context object may cause side effects',
      severity: isDefensive ? 'warning' : 'error',
      suggestion:
        'Create a new context object instead of mutating. Use spread operator: const newCtx = { ...ctx, property: newValue }; or Object.freeze() for immutability.',
      match: match.detector.patternName,
      type: 'context-mutation',
      filePath,
    })
  }

  return violations
}

/**
 * Check: resilience/context-mutation-check
 *
 * Detects potentially unsafe mutations of request/execution context objects.
 * Context should be immutable to prevent side effects across middleware.
 */
export const contextMutationCheck = defineCheck({
  id: 'abed5b29-960b-486f-bb0d-5b9e1744241d',
  slug: 'context-mutation-check',
  scope: { languages: ['typescript'], concerns: ['backend', 'frontend', 'cli'] },
  contentFilter: 'strip-strings',

  confidence: 'medium',
  description: 'Detect unsafe mutations of request/execution context',
  longDescription: `**Purpose:** Prevents direct mutation of request/execution context objects, which can cause side effects across middleware and handlers.

**Detects:**
- Assignment to context properties: \`ctx.prop =\`, \`context.prop =\`, \`req.context.prop =\`, \`request.context.prop =\` (excluding \`==\`/\`===\` comparisons)
- \`Object.assign(ctx, ...)\` and \`Object.assign(context, ...)\`
- Array mutation methods on context objects: \`.push()\`, \`.splice()\`, \`.pop()\`, \`.shift()\`, \`.unshift()\`
- \`delete ctx.\` / \`delete context.\` expressions
- Allows safe fields like \`correlationId\`, \`requestId\`, \`logger\`, and non-request context prefixes like \`error.context\`, \`this.context\`

**Why it matters:** Mutating shared request context causes unpredictable cross-request data leakage in concurrent server environments.

**Scope:** General best practice. Analyzes each file individually via string matching.`,
  tags: ['resilience', 'context', 'immutability'],
  fileTypes: ['ts'],

  analyze(content: string, filePath: string): CheckViolation[] {
    return analyzeContextMutation(content, filePath)
  },
})
