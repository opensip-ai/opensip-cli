// @fitness-ignore-file project-readme-existence -- internal module, not a package root
// @fitness-ignore-file fitness-check-coverage -- check implementation with framework-managed coverage
/**
 * @fileoverview Detects error branches that silently exit with success (exit 0)
 */

import { defineCheck, type CheckViolation, getLineNumber } from '@opensip-tools/fitness'
import { isCommentLine } from '../../utils/index.js'

/**
 * Pattern for catch blocks that log errors but don't propagate failure.
 * Detects: catch blocks containing logger.error/console.error but no throw/process.exit(1)/return err
 */
const CATCH_BLOCK_PATTERN = /\bcatch\s*\([^)]+\)\s*\{([^{}]*(?:\{[^{}]*\}[^{}]*)*)}/g

/** Patterns indicating error is logged */
const ERROR_LOG_PATTERNS = [
  /logger\.error/,
  /logger\.fatal/,
  /console\.error/,
]

/** Patterns indicating error is propagated or recorded for the caller */
const ERROR_PROPAGATION_PATTERNS = [
  /\bthrow\b/,
  /process\.exit\s*\(\s*1\s*\)/,
  /process\.exitCode\s*=\s*1/,
  /return\s+err\s*\(/,
  /return\s+Result\.err/,
  /return\s+\{\s*ok\s*:\s*false/,
  /return\s+undefined/, // Signal failure to caller via sentinel return
  /\.errors\.push\(/, // Error aggregation pattern — error is collected for batch reporting
  /\.push\(\s*`/, // Template literal push to errors array
]

/**
 * Check: resilience/exit-code-correctness
 *
 * Detects catch blocks that log errors but silently allow execution to continue
 * (masking failures), especially in CLI command handlers where this means
 * exiting with code 0 despite a failure.
 */
export const exitCodeCorrectness = defineCheck({
  id: 'c5007f87-9c72-49be-861a-a419cac1006f',
  slug: 'exit-code-correctness',
  scope: { languages: ['typescript'], concerns: ['backend', 'frontend', 'cli'] },
  contentFilter: 'strip-strings',

  confidence: 'medium',
  description: 'Detect error branches that mask failures with silent success exit',
  longDescription: `**Purpose:** Prevents error branches from silently masking failures by logging the error but allowing execution to continue with an implicit success exit code.

**Detects:**
- \`catch\` blocks in CLI command files that log errors (\`logger.error\`, \`console.error\`) but do not propagate the failure (via \`throw\`, \`process.exit(1)\`, or \`Result.err\`)
- This pattern causes CLI commands to exit 0 despite encountering errors, making failures invisible to scripts and CI pipelines

**Why it matters:** Silent failure masking means CI pipelines, scripts, and orchestrators cannot detect that an operation failed, leading to cascading silent corruption.

**Scope:** CLI and command handler files. Analyzes each file individually via regex.`,
  tags: ['resilience', 'cli', 'error-handling'],
  fileTypes: ['ts'],

  analyze(content: string, filePath: string): CheckViolation[] {
    const violations: CheckViolation[] = []

    // Target CLI and command handler files
    if (!filePath.includes('/cli/') && !filePath.includes('/commands/') && !filePath.includes('/bin/')) {
      return violations
    }

    // Skip test files
    if (filePath.includes('.test.') || filePath.includes('.spec.') || filePath.includes('__tests__')) {
      return violations
    }

    // Quick check
    if (!content.includes('catch')) {
      return violations
    }

    CATCH_BLOCK_PATTERN.lastIndex = 0
    let match
    while ((match = CATCH_BLOCK_PATTERN.exec(content)) !== null) {
      const catchBody = match[1] ?? ''

      // Only flag if it logs an error
      const logsError = ERROR_LOG_PATTERNS.some((p) => p.test(catchBody))
      if (!logsError) continue

      // Check if error is actually propagated
      const propagatesError = ERROR_PROPAGATION_PATTERNS.some((p) => p.test(catchBody))
      if (propagatesError) continue

      const lineNumber = getLineNumber(content, match.index)
      const line = content.split('\n')[lineNumber - 1] ?? ''
      if (isCommentLine(line)) continue

      violations.push({
        line: lineNumber,
        column: 0,
        message: 'Catch block logs error but does not propagate failure — process will exit 0',
        severity: 'warning',
        suggestion:
          'Re-throw the error, call process.exit(1), or return a Result.err() to ensure the failure is visible to callers and CI pipelines.',
        match: match[0].substring(0, 60),
        type: 'silent-failure-exit',
        filePath,
      })
    }

    return violations
  },
})
