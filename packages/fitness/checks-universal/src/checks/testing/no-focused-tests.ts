// @fitness-ignore-file no-test-only-skip -- longDescription contains backtick-escaped .only( patterns for documentation
/**
 * @fileoverview Detects .only in test files that would skip other tests
 *
 * Focused tests should not be committed as they prevent other tests from running.
 */

import { logger } from '@opensip-tools/core/logger'
import { defineCheck, type CheckViolation } from '@opensip-tools/fitness'

import { isCommentLine, isTestFile } from '../../utils/index.js'

/**
 * Focus pattern configuration
 */
interface FocusPattern {
  pattern: RegExp
  type: string
}

/**
 * Patterns that indicate focused tests
 */
const FOCUS_PATTERNS: FocusPattern[] = [
  { pattern: /\bdescribe\.only\s*\(/g, type: 'describe.only' },
  { pattern: /\bit\.only\s*\(/g, type: 'it.only' },
  { pattern: /\btest\.only\s*\(/g, type: 'test.only' },
  { pattern: /\bfit\s*\(/g, type: 'fit' },
  { pattern: /\bfdescribe\s*\(/g, type: 'fdescribe' },
]

/**
 * Generate replacement text for a focused test match
 * @param matchText - The matched text
 * @returns Replacement suggestion
 */
function generateReplacement(matchText: string): string {
  logger.debug({
    evt: 'fitness.checks.no_focused_tests.generate_replacement',
    msg: 'Generating replacement text for focused test match',
  })
  return matchText.replace('.only', '').replace(/^f(it|describe)/, (_match: string, p1: string) => p1)
}

/**
 * Analyze a file for focused test patterns
 */
function analyzeFile(content: string, filePath: string): CheckViolation[] {
  logger.debug({
    evt: 'fitness.checks.no_focused_tests.analyze_file',
    msg: 'Analyzing file for focused test patterns',
  })
  const violations: CheckViolation[] = []

  // Only check test files
  if (!isTestFile(filePath)) {
    return violations
  }

  const lines = content.split('\n')

  for (const [lineIndex, line] of lines.entries()) {
    if (line === undefined || isCommentLine(line)) {
      continue
    }

    for (const { pattern, type } of FOCUS_PATTERNS) {
      pattern.lastIndex = 0
      const match = pattern.exec(line)
      if (match) {
        const replacement = generateReplacement(match[0])
        violations.push({
          line: lineIndex + 1,
          column: match.index,
          message: `Focused test found: ${type} - this will skip other tests`,
          severity: 'error',
          type,
          match: match[0],
          suggestion: `Remove .only from test: replace '${match[0]}' with '${replacement}'`,
        })
      }
    }
  }

  return violations
}

/**
 * Check: testing/no-focused-tests
 *
 * Detects .only in test files that would skip other tests.
 * Focused tests should not be committed.
 */
export const noFocusedTests = defineCheck({
  id: '6cbde4d3-e709-421d-a2d5-004ec9e11537',
  slug: 'no-focused-tests',
  scope: { languages: ['typescript', 'tsx'], concerns: ['testing'] },
  description: 'Detects .only in test files that would skip other tests',
  longDescription: `**Purpose:** Prevents focused tests (\`.only\`) from being committed, which would silently skip all other tests in the suite.

**Detects:**
- \`describe.only(\` via \`/\\bdescribe\\.only\\s*\\(/\`
- \`it.only(\` via \`/\\bit\\.only\\s*\\(/\`
- \`test.only(\` via \`/\\btest\\.only\\s*\\(/\`
- \`fit(\` (Jasmine-style focused test) via \`/\\bfit\\s*\\(/\`
- \`fdescribe(\` (Jasmine-style focused describe) via \`/\\bfdescribe\\s*\\(/\`
- Skips comment lines

**Why it matters:** A committed \`.only\` causes CI to run only the focused test, giving a false green signal while the rest of the suite is silently skipped.

**Scope:** General best practice. Analyzes each file individually, targeting test files only.`,
  tags: ['testing', 'ci-blocking'],
  fileTypes: ['ts', 'tsx'],
  contentFilter: 'strip-strings',
  confidence: 'high',

  analyze: analyzeFile,
})
