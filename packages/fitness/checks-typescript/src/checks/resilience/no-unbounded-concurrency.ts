/**
 * @fileoverview No unbounded concurrency check — flags `Promise.all(arr.map(...))`
 * patterns without nearby concurrency controls.
 */

import { defineCheck, getLineNumber, isTestFile, stripStringsAndCommentsPreservingPositions, type CheckViolation } from '@opensip-tools/fitness'

/**
 * Pattern indicating unbounded Promise.all usage.
 * Safe regex: uses word boundaries and explicit character classes, no nested quantifiers.
 */
const UNBOUNDED_PROMISE_ALL_PATTERN = /Promise\.all\s*\(\s*[a-zA-Z_$][a-zA-Z0-9_$]*\.map\s*\(/g

/**
 * Check if content contains bounded concurrency patterns.
 * @param {string} content - The content to check
 * @returns {boolean} True if bounded patterns found
 */
function hasBoundedConcurrencyPattern(content: string): boolean {
  const lowerContent = content.toLowerCase()
  // Check simple string patterns first (faster)
  if (lowerContent.includes('plimit')) return true
  if (lowerContent.includes('p-limit')) return true
  if (content.includes('Promise.allSettled')) return true
  // Check regex patterns
  if (/concurrency:\s*\d+/i.test(content)) return true
  if (/\b(?:chunk|batch)\b/i.test(content)) return true
  if (/\b(?:throttle|rateLimit)\b/i.test(content)) return true
  return false
}

/**
 * Check: resilience/no-unbounded-concurrency
 *
 * Detects Promise.all with .map() that may spawn unbounded concurrent operations.
 */
export const noUnboundedConcurrency = defineCheck({
  id: 'fc2a0fee-8374-432b-a7ef-763aea867855',
  slug: 'no-unbounded-concurrency',
  description: 'Detect Promise.all with unbounded concurrency',
  longDescription: `**Purpose:** Prevents unbounded parallel execution that can overwhelm downstream services or exhaust system resources.

**Detects:**
- \`Promise.all(items.map(\` pattern without nearby concurrency controls
- Skips files containing bounded concurrency indicators: \`plimit\`, \`p-limit\`, \`Promise.allSettled\`, \`concurrency: N\`, \`chunk\`, \`batch\`, \`throttle\`, \`rateLimit\`

**Why it matters:** Mapping an unbounded array into concurrent promises can spawn thousands of simultaneous operations, causing connection exhaustion or OOM.

**Scope:** General best practice. Analyzes each file individually via regex.`,
  tags: ['resilience', 'async', 'concurrency'],

  analyze(content: string, filePath: string): CheckViolation[] {
    const violations: CheckViolation[] = []

    // Skip test files — bounded by fixture data, not external load. A
    // partial mock of bounded-concurrency helpers that fans out via
    // Promise.all is a deliberate test seam; the production callers it
    // replaces ARE bounded.
    if (isTestFile(filePath)) return violations

    // Skip files that don't use Promise.all
    if (!content.includes('Promise.all')) {
      return violations
    }

    // Strip strings and comments before pattern-match scanning so
    // doc-block prose describing the pattern (e.g. JSDoc that says
    // "`Promise.all(arr.map(asyncFn))` fans out one promise per
    // element") doesn't produce a false positive that's impossible to
    // suppress without a pragma in user code. Use the position-
    // preserving variant so match indexes still map onto the original
    // source line numbers.
    //
    // Bounded-pattern detection (`hasBoundedConcurrencyPattern`)
    // intentionally runs on the ORIGINAL content — comments often carry
    // intent ("// Batch failed", "// chunked at 4 in flight") that
    // operators expect to suppress the warning. Stripping them there
    // would surface previously-passing files as new positives every
    // time we tighten the regex, so keep the file-level escape hatch
    // generous and only narrow the per-match scan.
    const codeOnly = stripStringsAndCommentsPreservingPositions(content)
    if (!codeOnly.includes('Promise.all')) {
      return violations
    }

    // Check if file has bounded concurrency patterns (uses original content)
    if (hasBoundedConcurrencyPattern(content)) {
      return violations
    }

    UNBOUNDED_PROMISE_ALL_PATTERN.lastIndex = 0
    let match
    while ((match = UNBOUNDED_PROMISE_ALL_PATTERN.exec(codeOnly)) !== null) {
      // @lazy-ok -- 'await' appears in suggestion string literal, not actual await
      // Check context around match for bounded patterns. Use the
      // ORIGINAL content here — adjacent comments like
      // `// chunked, batch=N` or `// see batchWithConcurrency above`
      // are deliberate hints that operators expect to suppress the
      // warning. Same rationale as the file-level bounded check.
      const start = Math.max(0, match.index - 200)
      const end = Math.min(content.length, match.index + 200)
      const context = content.slice(start, end)

      if (!hasBoundedConcurrencyPattern(context)) {
        const lineNumber = getLineNumber(content, match.index)
        violations.push({
          line: lineNumber,
          column: 0,
          message: 'Promise.all with .map() may spawn unbounded concurrent operations',
          severity: 'warning',
          suggestion:
            'Use p-limit or batch processing to limit concurrency. Example: const limit = pLimit(10); await Promise.all(items.map(item => limit(() => process(item))))',
          match: match[0],
          type: 'unbounded-promise-all',
          filePath,
        })
      }
    }

    return violations
  },
})
