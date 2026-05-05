// @fitness-ignore-file no-stub-tests -- longDescription contains backtick-escaped stub test examples for documentation
/**
 * @fileoverview No stub tests check
 */

import { defineCheck, type CheckViolation } from '@opensip-tools/core'

/**
 * Patterns for empty test bodies on a single line
 */
const EMPTY_BODY_PATTERNS = [
  // it('...', () => {}) or it('...', () => { })
  /(?:it|test)\s*\(\s*['"`].*['"`]\s*,\s*(?:async\s*)?\(\)\s*=>\s*\{\s*\}\s*\)/,
  // it('...', function() {}) or it('...', function() { })
  /(?:it|test)\s*\(\s*['"`].*['"`]\s*,\s*(?:async\s*)?function\s*\(\)\s*\{\s*\}\s*\)/,
]

/**
 * Pattern for TODO/FIXME comments inside test bodies on same line
 */
const TODO_IN_TEST_BODY =
  /(?:it|test)\s*\(\s*['"`].*['"`]\s*,\s*(?:async\s*)?\(\)\s*=>\s*\{\s*\/[/*]\s*(?:TODO|FIXME|HACK|STUB)/i

/**
 * Pattern for trivial always-passing assertions
 */
const TRIVIAL_ASSERTION = /expect\s*\(\s*true\s*\)\s*\.toBe\s*\(\s*true\s*\)/

/**
 * Analyze a test file for stub tests
 */
function analyzeTestFile(content: string, _filePath: string): CheckViolation[] {
  const violations: CheckViolation[] = []
  const lines = content.split('\n')

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? ''
    const trimmed = line.trim()

    // Skip actual comments (not inside test bodies)
    if (trimmed.startsWith('//') || trimmed.startsWith('*')) continue

    // Check for empty test bodies
    for (const pattern of EMPTY_BODY_PATTERNS) {
      if (pattern.test(line)) {
        violations.push({
          line: i + 1,
          message: 'Empty test body — this test always passes without asserting anything',
          severity: 'error',
          suggestion:
            'Add meaningful assertions or use `it.todo()` if the test is planned but not yet implemented',
          type: 'empty-test-body',
          match: trimmed.slice(0, 120),
        })
        break
      }
    }

    // Check for TODO comments inside test bodies
    if (TODO_IN_TEST_BODY.test(line)) {
      violations.push({
        line: i + 1,
        message: 'Test body contains only a TODO comment — this is a stub that inflates coverage',
        severity: 'error',
        suggestion: 'Implement the test or convert to `it.todo()` to track as unimplemented',
        type: 'todo-stub-test',
        match: trimmed.slice(0, 120),
      })
    }

    // Check for trivial always-passing assertions
    if (TRIVIAL_ASSERTION.test(line)) {
      violations.push({
        line: i + 1,
        message: 'Trivial `expect(true).toBe(true)` assertion — this test always passes',
        severity: 'warning',
        suggestion: 'Replace with a meaningful assertion that validates actual behavior',
        type: 'trivial-assertion',
        match: trimmed.slice(0, 120),
      })
    }
  }

  return violations
}

/**
 * Check: testing/no-stub-tests
 *
 * Detects stub tests with empty bodies, TODO-only bodies,
 * or trivial always-passing assertions that inflate coverage metrics.
 */
export const noStubTests = defineCheck({
  id: 'fc8032e4-9fcf-4a1f-bc00-e080e58ae1c5',
  slug: 'no-stub-tests',
  scope: { languages: ['typescript', 'tsx'], concerns: ['testing'] },
  contentFilter: 'strip-strings',

  confidence: 'medium',
  description:
    'Detects stub tests with empty bodies, TODO-only bodies, or trivial always-passing assertions',
  longDescription: `**Purpose:** Detects tests that exist but don't actually test anything, inflating coverage metrics and masking gaps.

**Detects:**
- Empty test bodies: \`it('should X', () => {})\`
- TODO-only test bodies: \`it('should X', () => { /* TODO */ })\`
- Trivial assertions: \`expect(true).toBe(true)\`

**Why it matters:** Stub tests give false confidence in test coverage. They pass without asserting anything, hiding missing test coverage.

**Scope:** Test files only. Analyzes each file individually via regex.`,
  tags: ['testing', 'quality', 'coverage'],
  fileTypes: ['ts', 'tsx'],
  analyze: analyzeTestFile,
})
