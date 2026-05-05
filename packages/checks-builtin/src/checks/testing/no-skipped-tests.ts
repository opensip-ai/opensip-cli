// @fitness-ignore-file unused-config-options -- Config options reserved for future use or environment-specific
// @fitness-ignore-file no-test-only-skip -- longDescription contains backtick-escaped .skip( patterns for documentation
/**
 * @fileoverview Detects .skip in test files that prevent tests from running
 *
 * Skipped tests should be fixed or removed, not left dormant.
 */

import { logger } from '@opensip-tools/core/logger'

import { defineCheck, type CheckViolation } from '@opensip-tools/core'
import { isCommentLine, isTestFile } from '../../utils/index.js'

/**
 * Patterns that indicate skipped tests
 */
const SKIP_PATTERNS = [
  { pattern: /\bdescribe\.skip\s*\(/g, type: 'describe.skip' },
  { pattern: /\bit\.skip\s*\(/g, type: 'it.skip' },
  { pattern: /\btest\.skip\s*\(/g, type: 'test.skip' },
  { pattern: /\bxit\s*\(/g, type: 'xit' },
  { pattern: /\bxdescribe\s*\(/g, type: 'xdescribe' },
  { pattern: /\bxtest\s*\(/g, type: 'xtest' },
]

/**
 * Generates the replacement string for a skip pattern match
 * @param matchText - The matched text
 * @returns The replacement string
 */
function generateReplacement(matchText: string): string {
  logger.debug({
    evt: 'fitness.checks.no_skipped_tests.generate_replacement',
    msg: 'Generating replacement text for skipped test match',
  })
  return matchText.replace('.skip', '').replace(/^x(it|describe|test)/, (_, p1) => p1 as string)
}

/**
 * Analyze a file for skipped test patterns
 */
function analyzeFile(content: string, filePath: string): CheckViolation[] {
  logger.debug({
    evt: 'fitness.checks.no_skipped_tests.analyze_file',
    msg: 'Analyzing file for skipped test patterns',
  })
  const violations: CheckViolation[] = []

  // Only check test files
  if (!isTestFile(filePath)) {
    return violations
  }

  const lines = content.split('\n')

  for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
    const line = lines[lineIndex]
    if (line === undefined || isCommentLine(line)) {
      continue
    }

    for (const { pattern, type } of SKIP_PATTERNS) {
      pattern.lastIndex = 0
      const match = pattern.exec(line)
      if (match) {
        const replacement = generateReplacement(match[0])
        violations.push({
          line: lineIndex + 1,
          column: match.index,
          message: `Skipped test found: ${type} - this test is not running`,
          severity: 'warning',
          type,
          match: match[0],
          suggestion: `Fix the test and remove .skip: replace '${match[0]}' with '${replacement}', or delete the test if no longer needed`,
        })
      }
    }
  }

  return violations
}

/**
 * Check: testing/no-skipped-tests
 *
 * Detects .skip in test files that prevent tests from running.
 * Skipped tests should be fixed or removed.
 */
export const noSkippedTests = defineCheck({
  id: '6d58546e-7335-42da-94f3-abb015e3a4c0',
  slug: 'no-skipped-tests',
  scope: { languages: ['typescript', 'tsx'], concerns: ['testing'] },
  description: 'Detects .skip in test files that prevent tests from running',
  longDescription: `**Purpose:** Surfaces skipped tests that are not running, so they can be fixed or removed rather than left dormant.

**Detects:**
- \`describe.skip(\` via \`/\\bdescribe\\.skip\\s*\\(/\`
- \`it.skip(\` via \`/\\bit\\.skip\\s*\\(/\`
- \`test.skip(\` via \`/\\btest\\.skip\\s*\\(/\`
- \`xit(\` (Jasmine-style skipped test) via \`/\\bxit\\s*\\(/\`
- \`xdescribe(\` via \`/\\bxdescribe\\s*\\(/\`
- \`xtest(\` via \`/\\bxtest\\s*\\(/\`
- Skips comment lines

**Why it matters:** Skipped tests accumulate as dead code and silently reduce effective test coverage, hiding regressions that the skipped tests were meant to catch.

**Scope:** General best practice. Analyzes each file individually, targeting test files only.`,
  tags: ['testing'],
  fileTypes: ['ts', 'tsx'],
  contentFilter: 'strip-strings',
  confidence: 'high',

  analyze: analyzeFile,
})
