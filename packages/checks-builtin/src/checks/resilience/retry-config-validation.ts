/**
 * @fileoverview Retry configuration validation check
 */

import { logger } from '@opensip-tools/core/logger'

import { defineCheck, type CheckViolation } from '@opensip-tools/core'
import { stripStringLiterals, stripStringsAndComments } from '@opensip-tools/core/framework/strip-literals.js'

import { isDigit } from './config-validation-helpers.js'

// =============================================================================
// CONFIG PARSING
// =============================================================================

/**
 * Parse a config value from a line using string matching.
 */
function parseConfigValueFromLine(
  line: string,
  configKey: string,
): { value: number; matchText: string } | null {
  logger.debug({
    evt: 'fitness.checks.retry_config_validation.parse_config_value_from_line',
    msg: 'Parsing config value from line',
  })
  const lowerLine = line.toLowerCase()
  const lowerKey = configKey.toLowerCase()
  const idx = lowerLine.indexOf(lowerKey)
  if (idx === -1) return null

  const afterKey = line.substring(idx + configKey.length)
  let i = 0

  // Skip whitespace
  while (i < afterKey.length && (afterKey[i] === ' ' || afterKey[i] === '\t')) {
    i++
  }

  // Check for = or :
  if (afterKey[i] !== '=' && afterKey[i] !== ':') {
    return null
  }
  i++

  // Skip whitespace
  while (i < afterKey.length && (afterKey[i] === ' ' || afterKey[i] === '\t')) {
    i++
  }

  // Parse digits
  const digitStart = i
  while (i < afterKey.length && isDigit(afterKey[i])) {
    i++
  }

  if (digitStart === i) {
    return null // No digits found
  }

  // @fitness-ignore-next-line numeric-validation -- substring is guaranteed digit-only by isDigit loop above
  const value = parseInt(afterKey.substring(digitStart, i), 10)
  return {
    value,
    matchText: `${configKey}${afterKey.substring(0, i)}`,
  }
}

// =============================================================================
// VALUE CHECKING
// =============================================================================

interface RetryViolation {
  message: string
  severity: 'error' | 'warning'
  suggestion: string
  type: string
}

function checkMaxRetriesValue(value: number): RetryViolation | null {
  logger.debug({
    evt: 'fitness.checks.retry_config_validation.check_max_retries_value',
    msg: 'Checking maxRetries value for excessive count',
  })
  if (value <= 10) return null

  return {
    message: `maxRetries of ${value} is excessive`,
    severity: 'warning',
    suggestion:
      'Consider reducing maxRetries to 3-5 with exponential backoff. Use a shared retry utility for proper retry handling.',
    type: 'excessive-retries',
  }
}

function checkBaseDelayValue(value: number): RetryViolation | null {
  logger.debug({
    evt: 'fitness.checks.retry_config_validation.check_base_delay_value',
    msg: 'Checking baseDelay value for aggressive timing',
  })
  if (value >= 100) return null

  return {
    message: `baseDelay of ${value}ms may be too aggressive`,
    severity: 'warning',
    suggestion:
      'Consider a baseDelay of at least 100ms to avoid overwhelming downstream services. Use exponential backoff for better resilience.',
    type: 'aggressive-retry-delay',
  }
}

// =============================================================================
// LINE CHECKING
// =============================================================================

function checkConfigOnLine(
  strippedLine: string,
  configKey: string,
  checker: (value: number) => RetryViolation | null,
  lineNumber: number,
  filePath: string,
): CheckViolation | null {
  const result = parseConfigValueFromLine(strippedLine, configKey)
  if (!result) return null

  const violation = checker(result.value)
  if (!violation) return null

  return {
    line: lineNumber,
    column: 0,
    message: violation.message,
    severity: violation.severity,
    suggestion: violation.suggestion,
    match: result.matchText,
    type: violation.type,
    filePath,
  }
}

// =============================================================================
// CHECK DEFINITION
// =============================================================================

/**
 * Check: resilience/retry-config-validation
 *
 * Validates retry configuration values to prevent:
 * - Too many retries (resource exhaustion)
 * - Too few retries (no fault tolerance)
 * - Excessive backoff delays
 */
export const retryConfigValidation = defineCheck({
  id: '174659f8-56b5-4e8d-a495-3c3188fddaf8',
  slug: 'retry-config-validation',
  scope: { languages: ['typescript'], concerns: ['backend', 'server'] },
  contentFilter: 'code-only',

  confidence: 'medium',
  description:
    'Validate retry configs: flag excessive maxRetries (>10) and aggressive baseDelay (<100ms)',
  longDescription: `**Purpose:** Validates retry configuration values to prevent resource exhaustion from too many retries or aggressive retry timing.

**Detects:**
- \`maxRetries = N\` or \`maxRetries: N\` where N > 10 (excessive retries)
- \`baseDelay = N\` or \`baseDelay: N\` where N < 100ms (too aggressive)
- Only scans files containing \`retry\` or \`attempt\` keywords

**Why it matters:** Excessive retries can amplify failures into cascading outages; aggressive retry delays overwhelm already-struggling downstream services.

**Scope:** General best practice. Analyzes each file individually via string parsing.`,
  tags: ['resilience', 'retry', 'config'],
  fileTypes: ['ts'],

  analyze(content: string, filePath: string): CheckViolation[] {
    const violations: CheckViolation[] = []

    const strippedContent = stripStringsAndComments(content).toLowerCase()
    if (!strippedContent.includes('retry') && !strippedContent.includes('attempt')) {
      return violations
    }

    const lines = content.split('\n')
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]
      if (!line) continue

      const strippedLine = stripStringLiterals(line)
      const trimmed = strippedLine.trim()
      if (trimmed.startsWith('//') || trimmed.startsWith('*')) {
        continue
      }

      const lineNumber = i + 1

      const maxRetriesViolation = checkConfigOnLine(
        strippedLine, 'maxRetries', checkMaxRetriesValue, lineNumber, filePath,
      )
      if (maxRetriesViolation) violations.push(maxRetriesViolation)

      const baseDelayViolation = checkConfigOnLine(
        strippedLine, 'baseDelay', checkBaseDelayValue, lineNumber, filePath,
      )
      if (baseDelayViolation) violations.push(baseDelayViolation)
    }

    return violations
  },
})
