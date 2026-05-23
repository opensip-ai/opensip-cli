/**
 * @fileoverview Await result unwrap check — flags missing `await` before
 * `.unwrap()` on async Result values.
 */

import { defineCheck, type CheckViolation } from '@opensip-tools/fitness'

/**
 * Pattern to detect async call followed by .unwrap().
 * Safe regex: uses explicit character classes, no nested quantifiers.
 */
const ASYNC_CALL_UNWRAP_PATTERN = /\.[a-zA-Z_$][a-zA-Z0-9_$]*\([^)]*\)\s*\.unwrap\s*\(\)/

/**
 * Check: resilience/await-result-unwrap
 *
 * Detects potential missing await before .unwrap() on async results.
 */
export const awaitResultUnwrap = defineCheck({
  id: 'f0cd1ad8-edea-42dc-b245-4f2a80bc56a0',
  slug: 'await-result-unwrap',
  disabled: true,
  description: 'Detect potential missing await before .unwrap() on async results',
  longDescription: `**Purpose:** Catches missing \`await\` before calling \`.unwrap()\` on async Result values, which would unwrap a Promise instead of the Result.

**Detects:**
- Lines containing \`.unwrap()\` without \`await\` keyword, where the preceding expression matches \`.methodName(args).unwrap()\`
- Only flags files that also contain \`async\` or \`await\` keywords

**Why it matters:** Calling \`.unwrap()\` on an unresolved Promise instead of a Result silently produces \`undefined\` or throws unexpectedly, bypassing the Result error-handling pattern.

**Scope:** Codebase-specific convention (Result pattern). Analyzes each file individually via regex.`,
  tags: ['resilience', 'async', 'result-pattern'],

  analyze(content: string, filePath: string): CheckViolation[] {
    const violations: CheckViolation[] = []

    // Skip files that don't use unwrap
    if (!content.includes('.unwrap(')) {
      return violations
    }

    // Skip files that don't have async context
    if (!content.includes('async ') && !content.includes('await ')) {
      // @lazy-ok -- 'await' is in string literals, not actual await
      return violations
    }

    const lines = content.split('\n')

    // Pre-filter lines that have .unwrap() without await
    const candidateLines = lines // @lazy-ok -- 'await' is in string comparisons, not actual await
      .map((line, i) => ({ line, index: i }))
      .filter(({ line }) => {
        if (!line) return false
        return line.includes('.unwrap()') && !line.includes('await')
      })

    // @fitness-ignore-next-line performance-anti-patterns -- 'await' appears in comments and string literals within this loop, not actual await expressions
    for (const { line, index: i } of candidateLines) {
      // Check if the line has an async call before unwrap
      const asyncMatch = ASYNC_CALL_UNWRAP_PATTERN.exec(line)
      if (!asyncMatch) {
        continue
      }

      const lineNumber = i + 1
      violations.push({
        line: lineNumber,
        column: line.indexOf('.unwrap'),
        message: 'Potential missing await before .unwrap() on async result',
        severity: 'warning',
        suggestion:
          'Add await if the Result is from an async function: `const result = await someAsyncFn(); result.unwrap();` or `(await someAsyncFn()).unwrap()`',
        match: asyncMatch[0],
        type: 'missing-await-unwrap',
        filePath,
      })
    }

    return violations
  },
})
