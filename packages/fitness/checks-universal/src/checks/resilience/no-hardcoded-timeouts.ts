/**
 * @fileoverview No hardcoded timeouts check
 */

import { logger } from '@opensip-tools/core/logger'
import { defineCheck, isTestFile, type CheckViolation } from '@opensip-tools/fitness'
import { stripStringLiterals, stripStringsAndComments } from '@opensip-tools/fitness'

import {
  isDigit,
  isAlphanumericChar,
  skipWhitespace,
  parseDigits,
} from './config-validation-helpers.js'

// =============================================================================
// CONSTANTS
// =============================================================================

/**
 * Minimum timeout to flag (5000ms = 5 seconds)
 */
// @fitness-ignore-next-line no-hardcoded-timeouts -- constant defined at module scope for check threshold configuration
const MIN_FLAGGABLE_TIMEOUT = 5000

// =============================================================================
// TIMEOUT EXTRACTION
// =============================================================================

/**
 * Find the comma separator after the callback in setTimeout
 */
function findSetTimeoutComma(str: string, startPos: number): number {
  logger.debug({
    evt: 'fitness.checks.no_hardcoded_timeouts.find_set_timeout_comma',
    msg: 'Finding comma separator after setTimeout callback',
  })
  let i = startPos
  let parenDepth = 1

  while (i < str.length && parenDepth > 0) {
    if (str[i] === '(') {
      parenDepth++
    } else if (str[i] === ')') {
      parenDepth--
    } else if (str[i] === ',' && parenDepth === 1) {
      break
    } else {
      // Other characters - continue scanning
    }
    i++
  }

  return i
}

/* v8 ignore start -- timeout extraction state machines; many parser-state branches covered indirectly */
/**
 * Extract setTimeout value using string parsing.
 */
function extractSetTimeoutValue(line: string): { timeout: number; matchText: string } | null {
  logger.debug({
    evt: 'fitness.checks.no_hardcoded_timeouts.extract_set_timeout_value',
    msg: 'Extracting setTimeout value from line',
  })
  const idx = line.indexOf('setTimeout')
  if (idx === -1) return null

  const afterSetTimeout = line.slice(Math.max(0, idx + 10))
  let i = skipWhitespace(afterSetTimeout, 0)

  // Expect (
  if (afterSetTimeout[i] !== '(') return null
  i++

  // Find the comma (skip over the callback argument)
  i = findSetTimeoutComma(afterSetTimeout, i)
  if (afterSetTimeout[i] !== ',') return null
  i++

  // Skip whitespace
  i = skipWhitespace(afterSetTimeout, i)

  // Parse the timeout number (4+ digits)
  const { endPos, value: timeout, digitCount } = parseDigits(afterSetTimeout, i)
  i = endPos
  if (digitCount < 4) return null

  // Skip whitespace and expect )
  i = skipWhitespace(afterSetTimeout, i)
  if (afterSetTimeout[i] !== ')') return null
  i++

  return {
    timeout,
    matchText: `setTimeout${afterSetTimeout.slice(0, Math.max(0, i))}`,
  }
}

/**
 * Extract timeout assignment value using string parsing.
 */
function extractTimeoutAssignment(line: string): { timeout: number; matchText: string } | null {
  logger.debug({
    evt: 'fitness.checks.no_hardcoded_timeouts.extract_timeout_assignment',
    msg: 'Extracting timeout assignment value from line',
  })
  const lowerLine = line.toLowerCase()
  const idx = lowerLine.indexOf('timeout')
  if (idx === -1) return null

  // Skip if this is setTimeout (handled separately)
  if (idx >= 3 && lowerLine.slice(idx - 3, idx) === 'set') return null

  const afterTimeout = line.slice(Math.max(0, idx + 7))
  let i = 0

  // Skip whitespace
  while (i < afterTimeout.length && (afterTimeout[i] === ' ' || afterTimeout[i] === '\t')) {
    i++
  }

  // Check for = or :
  if (afterTimeout[i] !== '=' && afterTimeout[i] !== ':') {
    return null
  }
  i++

  // Skip whitespace
  while (i < afterTimeout.length && (afterTimeout[i] === ' ' || afterTimeout[i] === '\t')) {
    i++
  }

  // Parse the timeout number (4+ digits)
  const digitStart = i
  while (i < afterTimeout.length && isDigit(afterTimeout[i])) {
    i++
  }

  const digitCount = i - digitStart
  if (digitCount < 4) return null

  // Word boundary check
  if (i < afterTimeout.length && isAlphanumericChar(afterTimeout[i])) {
    return null
  }

  // @fitness-ignore-next-line numeric-validation -- substring is guaranteed digit-only by isDigit loop above
  const timeout = Number.parseInt(afterTimeout.slice(digitStart, i), 10)
  return {
    timeout,
    matchText: `timeout${afterTimeout.slice(0, Math.max(0, i))}`,
  }
}

/**
 * Extract .timeout(N) value using string parsing.
 */
function extractDotTimeout(line: string): { timeout: number; matchText: string } | null {
  logger.debug({
    evt: 'fitness.checks.no_hardcoded_timeouts.extract_dot_timeout',
    msg: 'Extracting .timeout() value from line',
  })
  const idx = line.indexOf('.timeout')
  if (idx === -1) return null

  const afterDotTimeout = line.slice(Math.max(0, idx + 8))
  let i = 0

  // Skip whitespace
  while (
    i < afterDotTimeout.length &&
    (afterDotTimeout[i] === ' ' || afterDotTimeout[i] === '\t')
  ) {
    i++
  }

  // Expect (
  if (afterDotTimeout[i] !== '(') return null
  i++

  // Skip whitespace
  while (
    i < afterDotTimeout.length &&
    (afterDotTimeout[i] === ' ' || afterDotTimeout[i] === '\t')
  ) {
    i++
  }

  // Parse the timeout number (4+ digits)
  const digitStart = i
  while (i < afterDotTimeout.length && isDigit(afterDotTimeout[i])) {
    i++
  }

  const digitCount = i - digitStart
  if (digitCount < 4) return null

  // @fitness-ignore-next-line numeric-validation -- substring is guaranteed digit-only by isDigit loop above
  const timeout = Number.parseInt(afterDotTimeout.slice(digitStart, i), 10)

  // Skip whitespace and expect )
  while (
    i < afterDotTimeout.length &&
    (afterDotTimeout[i] === ' ' || afterDotTimeout[i] === '\t')
  ) {
    i++
  }
  if (afterDotTimeout[i] !== ')') return null
  i++

  return {
    timeout,
    matchText: `.timeout${afterDotTimeout.slice(0, Math.max(0, i))}`,
  }
}
/* v8 ignore stop */

/**
 * Extract timeout value from a line using string parsing.
 */
function extractTimeoutFromLine(line: string): { timeout: number; matchText: string } | null {
  logger.debug({
    evt: 'fitness.checks.no_hardcoded_timeouts.extract_timeout_from_line',
    msg: 'Extracting timeout value from line',
  })
  // Check for setTimeout(fn, NUMBER)
  const setTimeoutMatch = extractSetTimeoutValue(line)
  if (setTimeoutMatch) return setTimeoutMatch

  // Check for timeout = NUMBER or timeout: NUMBER
  const timeoutAssignMatch = extractTimeoutAssignment(line)
  if (timeoutAssignMatch) return timeoutAssignMatch

  // Check for .timeout(NUMBER)
  const dotTimeoutMatch = extractDotTimeout(line)
  if (dotTimeoutMatch) return dotTimeoutMatch

  return null
}

// =============================================================================
// LINE CHECKING
// =============================================================================

/**
 * Check if a line should be skipped for timeout checking.
 */
function shouldSkipTimeoutLine(line: string | undefined): boolean {
  logger.debug({
    evt: 'fitness.checks.no_hardcoded_timeouts.should_skip_timeout_line',
    msg: 'Checking if line should be skipped for timeout checking',
  })
  /* v8 ignore next -- defensive: lines.entries() never yields undefined */
  if (!line) return true
  const trimmed = line.trim()
  return trimmed.startsWith('//') || trimmed.startsWith('*')
}

// =============================================================================
// CHECK DEFINITION
// =============================================================================

/**
 * Check: resilience/no-hardcoded-timeouts
 *
 * Detects hardcoded timeout values that should be configurable.
 */
export const noHardcodedTimeouts = defineCheck({
  id: '5c183a31-ff6e-4120-a7a5-39a32dbbcfa5',
  slug: 'no-hardcoded-timeouts',
  scope: { languages: ['typescript'], concerns: ['backend', 'server'] },
  contentFilter: 'strip-strings',

  confidence: 'medium',
  description: 'Detect hardcoded timeout values that should be configurable',
  longDescription: `**Purpose:** Flags hardcoded timeout values that should be externalized to configuration for environment-specific tuning.

**Detects:**
- \`setTimeout(callback, N)\` where N has 4+ digits (>= 1000ms) and the value >= 5000ms
- \`timeout = N\` or \`timeout: N\` assignments where N has 4+ digits and >= 5000ms
- \`.timeout(N)\` method calls where N has 4+ digits and >= 5000ms
- Skips comment lines and lines starting with \`//\` or \`*\`

**Why it matters:** Hardcoded timeouts cannot be tuned per environment; a value suitable for development may cause failures or excessive waits in production.

**Scope:** General best practice. Analyzes each file individually via string parsing.`,
  tags: ['resilience', 'config', 'timeout'],
  fileTypes: ['ts'],

  analyze(content: string, filePath: string): CheckViolation[] {
    // Skip test files — hardcoded timeouts in tests are low-risk
    if (isTestFile(filePath)) return []

    logger.debug({
      evt: 'fitness.checks.no_hardcoded_timeouts.analyze',
      msg: 'Analyzing file for hardcoded timeout values',
    })
    const violations: CheckViolation[] = []

    // Skip files that don't have timeout patterns (strip strings/comments to avoid false positives)
    const strippedContent = stripStringsAndComments(content)
    if (!strippedContent.includes('timeout') && !strippedContent.includes('setTimeout')) {
      return violations
    }

    const lines = content.split('\n')
    for (const [i, line] of lines.entries()) {
      if (!line || shouldSkipTimeoutLine(line)) {
        continue
      }

      const strippedLine = stripStringLiterals(line)
      const result = extractTimeoutFromLine(strippedLine)
      if (!result || result.timeout < MIN_FLAGGABLE_TIMEOUT) continue

      const lineNumber = i + 1
      violations.push({
        line: lineNumber,
        column: 0,
        message: `Hardcoded timeout value: ${result.timeout}ms`,
        severity: 'warning',
        suggestion:
          'Use configurable timeout from configuration or constants. Example: const timeout = config.get("httpTimeout") or import { HTTP_TIMEOUT } from "./constants"',
        match: result.matchText,
        type: 'hardcoded-timeout',
        filePath,
      })
    }

    return violations
  },
})
