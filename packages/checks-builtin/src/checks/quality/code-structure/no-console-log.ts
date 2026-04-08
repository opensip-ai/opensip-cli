// @fitness-ignore-file no-console-log -- Check definition file references console patterns in its description
/**
 * @fileoverview Disallow console.log in production code
 */

import { defineCheck, type CheckViolation } from '@opensip-tools/core'
import { isCommentLine } from '../../../utils/index.js'

/**
 * Pattern definitions for console method detection.
 * These are inlined from the patterns config for direct pattern matching.
 */
const CONSOLE_PATTERNS = [
  {
    id: '38b2df63-54c3-4ab9-8a4d-5050384fa56b',
    slug: 'console-log',
    regex: /console\.log\s{0,10}\(/g,
    message: 'console.log detected',
    suggestion: 'Use a structured logger (e.g., pino, winston)',
  },
  {
    id: '766f1fdd-c257-4b56-b107-39fb83a92f2f',
    slug: 'console-debug',
    regex: /console\.debug\s{0,10}\(/g,
    message: 'console.debug detected',
    suggestion: 'Use a structured logger (e.g., pino, winston) for debug output',
  },
  {
    id: '3daf933d-551a-42af-9789-e24887df735c',
    slug: 'console-info',
    regex: /console\.info\s{0,10}\(/g,
    message: 'console.info detected',
    suggestion: 'Use a structured logger (e.g., pino, winston) for info output',
  },
  {
    id: 'dca59172-8f84-43b6-af5d-d9526b98248a',
    slug: 'console-warn',
    regex: /console\.warn\s{0,10}\(/g,
    message: 'console.warn detected',
    suggestion: 'Use a structured logger (e.g., pino, winston) for warnings',
  },
  {
    id: '9a364012-3d09-414d-8d1d-2236c843b2e6',
    slug: 'console-error',
    regex: /console\.error\s{0,10}\(/g,
    message: 'console.error detected',
    suggestion: 'Use a structured logger (e.g., pino, winston) for errors',
  },
]

/**
 * Paths where console.* is the correct output mechanism (CLI tools, display modules, scripts).
 */
const CLI_OUTPUT_PATTERNS = [
  /\/commands\//,
  /\/display\//,
  /\/output\//,
  /\/bin\//,
  /\/scripts\//,
  /\/cli\/.*\.ts$/,
]

/**
 * Check if a file is a CLI output file where console.* is acceptable.
 */
function isCliOutputFile(filePath: string): boolean {
  return CLI_OUTPUT_PATTERNS.some(p => p.test(filePath))
}

/**
 * Check: quality/no-console-log
 *
 * Ensures production code uses structured logging via a project logger
 * instead of console.log, console.debug, console.info, console.warn, or console.error.
 * Skips CLI command files, display/output modules, and scripts where console is appropriate.
 */
export const noConsoleLog = defineCheck({
  id: '86403377-5903-478a-bdf2-e4f2f17df39f',
  slug: 'no-console-log',
  scope: { languages: ['typescript'], concerns: ['backend', 'frontend', 'cli'] },
  description:
    'Disallow console.log in production code - use a structured logger',
  longDescription: `**Purpose:** Ensures production code uses a structured logger (e.g., pino, winston) instead of console methods, which lack structured fields and log levels.

**Detects:** Analyzes each file individually via regex matching against each line.
- \`console.log(\` calls (regex: \`/console\\.log\\s{0,10}\\(/\`)
- \`console.debug(\` calls
- \`console.info(\` calls
- \`console.warn(\` calls
- \`console.error(\` calls
- Skips lines that are comments (\`//\`, \`*\`, \`/*\`)
- Skips CLI output files: \`/commands/\`, \`/display/\`, \`/output/\`, \`/bin/\`, \`/scripts/\` paths

**Why it matters:** Console methods produce unstructured output without structured fields or log levels, making production debugging and log aggregation difficult.

**Scope:** General best practice. Analyzes each file individually.`,
  tags: ['logging', 'quality'],
  fileTypes: ['ts'],
  contentFilter: 'code-only',
  confidence: 'high',

  analyze(content, _filePath): CheckViolation[] {
    // CLI commands, display modules, and scripts use console.* as their output mechanism
    if (isCliOutputFile(_filePath)) return []

    const violations: CheckViolation[] = []
    const lines = content.split('\n')

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i] ?? ''
      const lineNum = i + 1

      // Skip comments
      if (isCommentLine(line)) {
        continue
      }

      // Check each console pattern
      for (const pattern of CONSOLE_PATTERNS) {
        // Reset lastIndex for global regex
        pattern.regex.lastIndex = 0

        if (pattern.regex.test(line)) {
          violations.push({
            line: lineNum,
            column: 0,
            message: pattern.message,
            severity: 'error',
            suggestion: pattern.suggestion,
            match: line.trim(),
          })
        }
      }
    }

    return violations
  },
})
