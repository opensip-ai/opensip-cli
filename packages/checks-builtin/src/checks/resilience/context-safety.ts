// @fitness-ignore-file unused-config-options -- Config options reserved for future use or environment-specific
// @fitness-ignore-file context-mutation-check -- Local array/object mutations are safe within function scope; not shared context
// @fitness-ignore-file file-length-limits -- JSDoc documentation required for public API
// @fitness-ignore-file silent-early-returns -- Guard clauses in pattern matching function return false for non-matching patterns
/**
 * @fileoverview Context safety and mutation checks
 */

import { logger } from '@opensip-tools/core/logger'

import { defineCheck, type CheckViolation } from '@opensip-tools/core'
import { isCommentLine, isTestFile } from '../../utils/index.js'

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
      const afterPrefix = line.substring(idx + prefix.length)
      // Must have at least one word character
      const wordEnd = findWordEndIndex(afterPrefix)
      if (wordEnd === 0) return false
      const afterWord = afterPrefix.substring(wordEnd).trimStart()
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
 * Check: resilience/context-mutation-check
 *
 * Detects potentially unsafe mutations of request/execution context objects.
 * Context should be immutable to prevent side effects across middleware.
 */
export const contextMutationCheck = defineCheck({
  id: 'abed5b29-960b-486f-bb0d-5b9e1744241d',
  slug: 'context-mutation-check',
  scope: { languages: ['typescript'], concerns: ['backend', 'frontend', 'cli'] },
  contentFilter: 'code-only',

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
    logger.debug({
      evt: 'fitness.checks.context_safety.context_mutation_check_analyze',
      msg: 'Analyzing file for unsafe context mutations',
    })
    const violations: CheckViolation[] = []

    // Skip files that don't use context patterns
    if (!usesContextPattern(content)) {
      return violations
    }

    const lines = content.split('\n')
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]
      if (line === undefined || !line) continue
      if (isCommentLine(line)) continue

      const match = findMutationMatch(line)
      if (!match || match.isSafe) continue

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
  },
})

// =============================================================================
// REQUEST CONTEXT LEAKAGE
// =============================================================================

/**
 * Storage pattern detector configuration.
 * Using string-based detection for safe, linear-time matching.
 */
interface StoragePatternDetector {
  readonly test: (line: string) => boolean
  readonly patternName: string
}

/**
 * Checks if a line contains a variable declaration with context-related name.
 * Looks for patterns like: let ctx =, var context =, let requestCtx =
 * @param line - The line to check
 * @returns True if line contains a variable declaration with context name
 */
function hasVarContextDeclaration(line: string): boolean {
  const trimmed = line.trimStart()
  if (!trimmed.startsWith('let ') && !trimmed.startsWith('var ')) {
    return false
  }
  const lowerLine = line.toLowerCase()
  const hasContextName =
    lowerLine.includes('context') || lowerLine.includes('ctx') || lowerLine.includes('request')
  return hasContextName && line.includes('=')
}

/**
 * Checks if a line contains a private class field with context-related name.
 * Looks for patterns like: private context =, private requestCtx:
 * @param line - The line to check
 * @returns True if line contains a private field with context name
 */
function hasPrivateContextField(line: string): boolean {
  const trimmed = line.trimStart()
  if (!trimmed.startsWith('private ')) {
    return false
  }
  const lowerLine = line.toLowerCase()
  const hasContextName = lowerLine.includes('context')
  return hasContextName && (line.includes('=') || line.includes(':'))
}

/**
 * Checks if a line contains a static field with context-related name.
 * Looks for patterns like: static context, static requestContext
 * @param line - The line to check
 * @returns True if line contains a static field with context name
 */
function hasStaticContextField(line: string): boolean {
  const trimmed = line.trimStart()
  if (!trimmed.startsWith('static ')) {
    return false
  }
  const lowerLine = line.toLowerCase()
  return lowerLine.includes('context')
}

/**
 * Storage pattern detectors using string-based matching.
 */
const STORAGE_PATTERN_DETECTORS: readonly StoragePatternDetector[] = [
  { test: hasVarContextDeclaration, patternName: 'let/var context declaration' },
  { test: hasPrivateContextField, patternName: 'private context field' },
  { test: hasStaticContextField, patternName: 'static context field' },
]

/**
 * Checks if a line should be skipped for context storage detection.
 * @param line - The line to check
 * @returns True if line should be skipped
 */
function shouldSkipLineForStorage(line: string): boolean {
  logger.debug({
    evt: 'fitness.checks.context_safety.should_skip_line_for_storage',
    msg: 'Checking if line should be skipped for context storage detection',
  })
  // Skip type definitions
  if (line.includes('type ') || line.includes('interface ')) {
    return true
  }
  // Skip AsyncLocalStorage patterns (proper context management)
  if (line.includes('AsyncLocalStorage')) {
    return true
  }
  return false
}

/**
 * Check: resilience/context-leakage
 *
 * Detects potential context leakage where request context is stored
 * in module or class scope, which could cause cross-request pollution.
 */
export const contextLeakage = defineCheck({
  id: '037b58ef-7b7d-404c-896b-2d40efe02a95',
  slug: 'context-leakage',
  scope: { languages: ['typescript'], concerns: ['backend', 'frontend', 'cli'] },
  description: 'Detect potential request context leakage',
  longDescription: `**Purpose:** Detects request context stored in module or class scope, which can leak between concurrent requests.

**Detects:**
- \`let\`/\`var\` declarations with context-related names (\`context\`, \`ctx\`, \`request\`) and an assignment
- \`private\` class fields with context-related names
- \`static\` fields with context-related names
- Skips \`AsyncLocalStorage\` usage (proper context management), type definitions, and interface declarations

**Why it matters:** Storing per-request context in shared scope causes cross-request pollution in multi-tenant or concurrent server environments.

**Scope:** General best practice. Analyzes each file individually via string matching.`,
  tags: ['resilience', 'context', 'security'],

  analyze(content: string, filePath: string): CheckViolation[] {
    // Skip test files — context leakage in tests is low-risk
    if (isTestFile(filePath)) return []

    logger.debug({
      evt: 'fitness.checks.context_safety.context_leakage_analyze',
      msg: 'Analyzing file for request context leakage',
    })
    const violations: CheckViolation[] = []

    // Skip files that don't mention context
    if (!content.toLowerCase().includes('context')) {
      return violations
    }

    const lines = content.split('\n')
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]
      if (!line) continue

      // Skip lines that should be ignored
      if (shouldSkipLineForStorage(line)) {
        continue
      }

      // Find matching detector
      const detector = STORAGE_PATTERN_DETECTORS.find((d) => d.test(line))
      if (!detector) {
        continue
      }

      const lineNumber = i + 1
      violations.push({
        line: lineNumber,
        column: 0,
        message: 'Request context stored in module/class scope may leak between requests',
        severity: 'warning',
        suggestion:
          'Use AsyncLocalStorage for request-scoped context or pass context as a parameter. Storing context in module/class scope can cause cross-request pollution.',
        match: detector.patternName,
        type: 'context-leakage',
        filePath,
      })
    }

    return violations
  },
})
