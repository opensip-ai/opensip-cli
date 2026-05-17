// @fitness-ignore-file no-unbounded-concurrency -- Concurrency bounded by design in this context
/**
 * @fileoverview Performance Anti-Patterns Check
 *
 * Detects common performance anti-patterns:
 * - Sequential awaits in loops
 * - Spread operators in loops
 * - String concatenation in loops
 * - Nested O(n^2) loops
 */

import { defineCheck, isTestFile, type CheckViolation } from '@opensip-tools/fitness'

/**
 * Performance anti-pattern types
 */
type AntiPatternType =
  | 'sequential-await'
  | 'spread-in-loop'
  | 'string-concat-in-loop'
  | 'nested-loop'
  | 'sync-in-async'

interface PatternConfig {
  pattern: RegExp
  type: AntiPatternType
  message: string
  severity: 'error' | 'warning'
}

// Anti-pattern type identifiers
const ANTI_PATTERN_TYPES = {
  SEQUENTIAL_AWAIT: 'sequential-await',
  SPREAD_IN_LOOP: 'spread-in-loop',
  STRING_CONCAT_IN_LOOP: 'string-concat-in-loop',
} as const

// Patterns use bounded quantifiers to prevent ReDoS vulnerabilities
const PATTERNS: PatternConfig[] = [
  {
    // Bounded to prevent super-linear runtime
    pattern: /for\s{0,5}\([^)]{0,200}\)\s{0,5}\{[^}]{0,500}await\s/,
    type: ANTI_PATTERN_TYPES.SEQUENTIAL_AWAIT,
    message: 'Sequential await in for loop - consider Promise.all()',
    severity: 'warning',
  },
  {
    // Bounded to prevent super-linear runtime
    pattern: /while\s{0,5}\([^)]{0,200}\)\s{0,5}\{[^}]{0,500}await\s/,
    type: ANTI_PATTERN_TYPES.SEQUENTIAL_AWAIT,
    message: 'Sequential await in while loop - consider Promise.all()',
    severity: 'warning',
  },
  {
    // Bounded to prevent super-linear runtime
    pattern: /\.forEach\([^)]{0,200}\)\s{0,5}\{[^}]{0,500}await\s/,
    type: ANTI_PATTERN_TYPES.SEQUENTIAL_AWAIT,
    message: 'Sequential await in forEach - use for...of with Promise.all()',
    severity: 'warning',
  },
  {
    // Bounded to prevent super-linear runtime.
    // We match `[...` or `(...` or `, ...` so that destructuring rest
    // (`{ a, ...rest } = obj` and `const [a, ...rest] = arr`) does NOT trigger:
    // those forms appear after `{`/`[` that immediately follow `const`/`let`/`var`
    // — the `(...|[...|, ...` shapes here cover spread-in-array-literal,
    // spread-in-call-args, and spread-in-arg-list-after-comma respectively.
    pattern: /for\s{0,5}\([^)]{0,200}\)\s{0,5}\{[^}]{0,500}[([,]\s{0,5}\.\.\./,
    type: ANTI_PATTERN_TYPES.SPREAD_IN_LOOP,
    message: 'Spread operator in loop - pre-allocate array instead',
    severity: 'warning',
  },
  {
    // Bounded to prevent super-linear runtime
    pattern: /for\s{0,5}\([^)]{0,200}\)\s{0,5}\{[^}]{0,500}\+=\s{0,5}['"`]/,
    type: ANTI_PATTERN_TYPES.STRING_CONCAT_IN_LOOP,
    message: 'String concatenation in loop - use array.join() instead',
    severity: 'warning',
  },
]

interface CheckLineForPerformancePatternsOptions {
  lines: string[]
  index: number
}

/**
 * Recognize retry/backoff loops, where sequential `await` is the entire
 * point — running attempts in parallel would defeat retry semantics. The
 * giveaway is an `await delay(`, `await sleep(`, `await setTimeout`, or
 * `await wait(` inside the same loop body. These loops are bounded by
 * their retry counter, not by data volume, so the sequential-await
 * suggestion is a false positive.
 *
 * Bounded quantifiers prevent ReDoS — context is at most 8 lines.
 */
const RETRY_LOOP_BODY = /await\s{1,5}(delay|sleep|wait|setTimeout|backoff|pause)\s{0,5}\(/

function checkLineForPerformancePatterns(
  options: CheckLineForPerformancePatternsOptions,
): CheckViolation | null {
  const { lines, index } = options
  const line = lines[index]
  if (!line) return null

  // Get multi-line context for loop detection
  const contextStart = Math.max(0, index - 2)
  const contextEnd = Math.min(lines.length, index + 5)
  const context = lines.slice(contextStart, contextEnd).join('\n')

  // Wider window for retry-loop detection — the `await delay()` that
  // marks an intentional retry/backoff loop often sits past the small
  // 8-line context window that the anti-pattern regexes themselves use.
  // 30 lines forward covers nearly all real retry helpers without
  // crossing function boundaries in normal code.
  const retryContextEnd = Math.min(lines.length, index + 30)
  const retryContext = lines.slice(contextStart, retryContextEnd).join('\n')

  for (const patternConfig of PATTERNS) {
    if (patternConfig.pattern.test(context)) {
      // Skip retry/backoff loops — sequential awaits with intentional
      // pacing between attempts. Only applies to the sequential-await
      // pattern (a spread or string-concat in a retry loop is still a
      // real bug).
      if (
        patternConfig.type === ANTI_PATTERN_TYPES.SEQUENTIAL_AWAIT &&
        RETRY_LOOP_BODY.test(retryContext)
      ) {
        continue
      }

      // Check if this line contains the key indicator
      // Using bounded quantifiers to prevent ReDoS
      const isSequentialAwait =
        patternConfig.type === ANTI_PATTERN_TYPES.SEQUENTIAL_AWAIT && line.includes('await')
      const isSpreadInLoop =
        patternConfig.type === ANTI_PATTERN_TYPES.SPREAD_IN_LOOP && isSpreadInCallOrArray(line)
      const isStringConcatInLoop =
        patternConfig.type === ANTI_PATTERN_TYPES.STRING_CONCAT_IN_LOOP &&
        /\+=\s{0,5}['"`]/.test(line)
      const isRelevantLine = isSequentialAwait || isSpreadInLoop || isStringConcatInLoop

      if (isRelevantLine) {
        const lineNum = index + 1

        const suggestion = getPerformanceSuggestion(patternConfig.type, patternConfig.message)

        return {
          line: lineNum,
          column: 0,
          message: patternConfig.message,
          severity: patternConfig.severity,
          suggestion,
          match: line,
        }
      }
    }
  }

  return null
}

/**
 * Distinguish spread-in-call / spread-in-array (a real anti-pattern in loops)
 * from rest-destructuring (`{ a, ...rest } = obj`, `const [a, ...rest] = arr`),
 * which is not.
 *
 * Heuristic: a true spread is preceded by `(`, `[`, or `,` (after optional
 * whitespace) — those positions correspond to call args, array literals, and
 * subsequent args. A destructuring rest, while syntactically also `, ...rest`
 * inside `{}`, is always followed by an `=` on the same line (the destructuring
 * assignment), so we exclude lines containing `} =` or `] =`.
 */
function isSpreadInCallOrArray(line: string): boolean {
  if (!line.includes('...')) return false
  // Exclude rest-destructuring: `{ ..., ...rest } = expr` or `[..., ...rest] = expr`
  // Bounded quantifier prevents catastrophic backtracking.
  if (/[\]}]\s{0,5}=/.test(line)) return false
  // Must be `(...`, `[...`, or `, ...` — bounded quantifier keeps this linear.
  return /[([,]\s{0,5}\.\.\./.test(line)
}

function getPerformanceSuggestion(type: AntiPatternType, defaultMessage: string): string {
  switch (type) {
    case 'sequential-await': {
      return 'Collect promises in an array and use Promise.all() to execute them in parallel, e.g.: const results = await Promise.all(items.map(item => fetchItem(item)));'
    }
    case 'spread-in-loop': {
      return 'Pre-allocate the result array with the known size, then use indexed assignment or push() without spread to avoid O(n^2) complexity'
    }
    case 'string-concat-in-loop': {
      return 'Collect strings in an array and call .join("") after the loop completes to avoid O(n^2) string allocation'
    }
    default: {
      return defaultMessage
    }
  }
}

/**
 * Check: quality/performance-anti-patterns
 *
 * Detects common performance anti-patterns in code.
 */
export const performanceAntiPatterns = defineCheck({
  id: '7631876c-1688-4f36-b6c9-0b987202d9f9',
  slug: 'performance-anti-patterns',
  scope: { languages: ['typescript'], concerns: ['backend', 'server'] },
  contentFilter: 'strip-strings',

  confidence: 'medium',
  description: 'Detects common performance anti-patterns (sequential await, spread in loops)',
  longDescription: `**Purpose:** Detects common performance anti-patterns that cause unnecessary latency or O(n^2) complexity in production code.

**Detects:** Analyzes each file individually. Uses regex patterns with multi-line context to find:
- \`await\` inside \`for\`, \`while\`, or \`.forEach\` loops (sequential async operations)
- Spread operator (\`...\`) inside \`for\` loops (O(n^2) array copies)
- String concatenation (\`+= '...'\`) inside \`for\` loops (O(n^2) string allocation)

**Why it matters:** These patterns cause quadratic performance degradation that is invisible at small scale but catastrophic with production data volumes.

**Scope:** General best practice`,
  tags: ['performance', 'quality'],
  fileTypes: ['ts', 'tsx'],
  // @fitness-ignore-next-line no-hardcoded-timeouts -- framework default for fitness check execution
  timeout: 180_000, // 3 minutes - parses AST for all production files

  analyze(content, filePath) {
    // Skip test files — performance anti-patterns in tests are low-risk
    if (isTestFile(filePath)) return []

    // Skip fitness check definitions — they iterate files with sequential async operations
    // as part of analysis, which is bounded by the check's file set
    if (filePath.includes('/fitness/src/checks/')) return []

    // Skip diagnostic/debug endpoints — sequential processing is acceptable for diagnostics
    if (filePath.includes('/diagnostics')) return []

    // @lazy-ok -- 'await' appears as a string literal, not an actual await expression
    // Quick filter: skip files without performance-related patterns
    if (!content.includes('await') && !content.includes('for') && !content.includes('while')) {
      return []
    }

    // Skip files with explicit sequential-ok marker (intentional sequential processing)
    if (content.includes('@sequential-ok')) return []

    const violations: CheckViolation[] = []
    const lines = content.split('\n')

    for (let i = 0; i < lines.length; i++) {
      const violation = checkLineForPerformancePatterns({ lines, index: i })
      if (violation) {
        violations.push(violation)
      }
    }

    return violations
  },
})
