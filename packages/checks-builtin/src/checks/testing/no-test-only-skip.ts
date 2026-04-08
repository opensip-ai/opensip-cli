// @fitness-ignore-file no-test-only-skip -- longDescription contains backtick-escaped .only( and .skip( patterns for documentation
// @fitness-ignore-file unused-config-options -- Config options reserved for future use or environment-specific
/**
 * @fileoverview Detects .only and .skip in test files that may have been accidentally committed
 *
 * Combined check for both .only and .skip patterns.
 * .only is treated as an error (blocks CI), .skip as a warning.
 */

import { logger } from '@opensip-tools/core/logger'

import { defineCheck, type CheckViolation } from '@opensip-tools/core'
import { createPathMatcher, isCommentLine } from '../../utils/index.js'

/** Pattern types for test modifiers */
type PatternType = 'only' | 'skip'

/** Severity levels */
type PatternSeverity = 'error' | 'warning'

/** Pattern configuration */
interface PatternConfig {
  pattern: RegExp
  type: PatternType
  severity: PatternSeverity
  message: string
}

/**
 * Patterns that indicate .only or .skip usage in tests.
 * Supports Vitest, Jest, and Playwright patterns.
 */
const PATTERNS: PatternConfig[] = [
  // .only patterns (errors)
  {
    pattern: /\b(test|it|describe)\.only\s*\(/g,
    type: 'only',
    severity: 'error',
    message: 'test.only will skip other tests - remove before committing',
  },
  {
    pattern: /\b(test|it|describe)\.concurrent\.only\s*\(/g,
    type: 'only',
    severity: 'error',
    message: 'test.concurrent.only will skip other tests - remove before committing',
  },
  // .skip patterns (warnings)
  {
    pattern: /\b(test|it|describe)\.skip\s*\(/g,
    type: 'skip',
    severity: 'warning',
    message: 'test.skip found - ensure this is intentional',
  },
  {
    pattern: /\b(test|it|describe)\.concurrent\.skip\s*\(/g,
    type: 'skip',
    severity: 'warning',
    message: 'test.concurrent.skip found - ensure this is intentional',
  },
  // Playwright-specific patterns
  {
    pattern: /\btest\.describe\.only\s*\(/g,
    type: 'only',
    severity: 'error',
    message: 'test.describe.only will skip other tests - remove before committing',
  },
  {
    pattern: /\btest\.describe\.skip\s*\(/g,
    type: 'skip',
    severity: 'warning',
    message: 'test.describe.skip found - ensure this is intentional',
  },
]

const SELF_TEST_PATTERNS = [
  /node_modules/,
  /\/dist\//,
  /\.d\.ts$/,
  // Exclude fitness check test fixtures that intentionally contain .only/.skip
  /no-focused-tests\/__tests__/,
  /no-skipped-tests\/__tests__/,
]

const isExcludedTestSkipPath = createPathMatcher(SELF_TEST_PATTERNS)

/**
 * Generates the replacement string for a pattern match
 * @param matchText - The matched text
 * @returns The replacement string
 */
function generateReplacement(matchText: string): string {
  logger.debug({
    evt: 'fitness.checks.no_test_only_skip.generate_replacement',
    msg: 'Generating replacement text for pattern match',
  })
  return matchText
    .replace('.only', '')
    .replace('.skip', '')
    .replace('.concurrent.', '.')
    .replace('..', '.')
}

/**
 * Generates a suggestion message for the violation
 * @param type - The pattern type (only or skip)
 * @param matchText - The matched text
 * @param replacement - The replacement string
 * @returns The suggestion message
 */
function generateSuggestion(type: PatternType, matchText: string, replacement: string): string {
  logger.debug({
    evt: 'fitness.checks.no_test_only_skip.generate_suggestion',
    msg: 'Generating suggestion message for violation',
  })
  if (type === 'only') {
    return `Remove .only to run all tests: replace '${matchText}' with '${replacement}'`
  }
  return `Fix the test and remove .skip: replace '${matchText}' with '${replacement}', or delete the test if no longer needed`
}

/**
 * Analyze a file for .only and .skip patterns
 */
function analyzeFile(content: string, filePath: string): CheckViolation[] {
  logger.debug({
    evt: 'fitness.checks.no_test_only_skip.analyze_file',
    msg: 'Analyzing file for only and skip patterns',
  })
  const violations: CheckViolation[] = []

  // Skip excluded paths
  if (isExcludedTestSkipPath(filePath)) {
    return violations
  }

  const lines = content.split('\n')

  for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
    const line = lines[lineIndex]
    if (line === undefined || isCommentLine(line)) {
      continue
    }

    for (const config of PATTERNS) {
      config.pattern.lastIndex = 0
      const match = config.pattern.exec(line)
      if (match) {
        const replacement = generateReplacement(match[0])
        const suggestion = generateSuggestion(config.type, match[0], replacement)

        violations.push({
          line: lineIndex + 1,
          column: match.index,
          message: config.message,
          severity: config.severity,
          type: config.type,
          match: match[0],
          suggestion,
        })
      }
    }
  }

  return violations
}

/**
 * Check: testing/no-test-only-skip
 *
 * Detects .only and .skip in test files that should not be committed.
 */
export const noTestOnlySkip = defineCheck({
  id: '11f39e35-8518-49a7-b0f0-44c2fab0634d',
  slug: 'no-test-only-skip',
  scope: { languages: ['typescript', 'tsx'], concerns: ['testing'] },
  contentFilter: 'code-only',

  confidence: 'medium',
  description: 'Detects .only and .skip in test files that should not be committed',
  longDescription: `**Purpose:** Combined check for both \`.only\` and \`.skip\` test modifiers, treating \`.only\` as errors (CI-blocking) and \`.skip\` as warnings.

**Detects:**
- \`(test|it|describe).only(\` and \`.concurrent.only(\` patterns (severity: error)
- \`(test|it|describe).skip(\` and \`.concurrent.skip(\` patterns (severity: warning)
- Playwright-specific \`test.describe.only(\` and \`test.describe.skip(\` patterns
- Supports Vitest, Jest, and Playwright syntax
- Excludes \`no-focused-tests/__tests__\` and \`no-skipped-tests/__tests__\` fixture directories
- Skips comment lines, \`node_modules\`, \`dist\`, and \`.d.ts\` files

**Why it matters:** Focused tests cause CI to silently skip the rest of the suite; skipped tests accumulate as dead code reducing effective coverage.

**Scope:** General best practice. Analyzes each file individually, targeting test files.`,
  tags: ['testing', 'ci-blocking'],
  fileTypes: ['ts', 'tsx'],
  timeout: 180_000, // 3 minutes - scans many test files

  analyze: analyzeFile,
})
