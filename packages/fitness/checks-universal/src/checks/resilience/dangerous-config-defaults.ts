// @fitness-ignore-file batch-operation-limits -- iterates bounded collections (config entries, registry items, or small analysis results)
// @fitness-ignore-file unsafe-secret-comparison -- keyIndex comparisons are search index positions, not cryptographic keys
// @fitness-ignore-file dangerous-config-defaults -- Fitness check definition references config patterns in longDescription, not actual configuration
/**
 * @fileoverview Dangerous configuration defaults check
 */

import { logger } from '@opensip-tools/core/logger'
import { defineCheck, type CheckViolation, getLineNumber } from '@opensip-tools/fitness'

import { isDigit, isAlphanumericChar } from './_helpers/config-validation.js'

// =============================================================================
// TYPES
// =============================================================================

/**
 * Configuration pattern checker using string matching.
 * Avoids regex patterns that trigger SonarJS warnings.
 */
interface ConfigPatternChecker {
  check: (content: string) => { index: number; match: string }[]
  message: string
  suggestion: string
  severity: 'error' | 'warning'
}

/**
 * Options for creating a config pattern checker.
 */
interface CreateConfigCheckerOptions {
  configKey: string
  expectedValue: string
  message: string
  suggestion: string
  severity: 'error' | 'warning'
}

// =============================================================================
// PATTERN CHECKERS
// =============================================================================

/**
 * Extract assignment part after a config key.
 */
function extractAssignment(afterKey: string, expectedValue: string): string | null {
  logger.debug({
    evt: 'fitness.checks.dangerous_config_defaults.extract_assignment',
    msg: 'Extracting assignment part after config key',
  })
  let i = 0
  while (i < afterKey.length && (afterKey[i] === ' ' || afterKey[i] === '\t')) {
    i++
  }

  if (afterKey[i] !== '=' && afterKey[i] !== ':') {
    return null
  }
  i++

  while (i < afterKey.length && (afterKey[i] === ' ' || afterKey[i] === '\t')) {
    i++
  }

  const remaining = afterKey.slice(Math.max(0, i))
  if (remaining.toLowerCase().startsWith(expectedValue.toLowerCase())) {
    const nextChar = remaining[expectedValue.length]
    if (!nextChar || !isAlphanumericChar(nextChar)) {
      return afterKey.slice(0, Math.max(0, i + expectedValue.length))
    }
  }

  return null
}

/**
 * Creates a config pattern checker using string search.
 * This avoids regex safety warnings from SonarJS.
 */
function createConfigChecker(options: CreateConfigCheckerOptions): ConfigPatternChecker {
  const { configKey, expectedValue, message, suggestion, severity } = options
  return {
    check(content: string): { index: number; match: string }[] {
      logger.debug({
        evt: 'fitness.checks.dangerous_config_defaults.config_checker_check',
        msg: 'Checking content for dangerous config pattern matches',
      })
      const results: { index: number; match: string }[] = []
      const lowerContent = content.toLowerCase()
      const lowerKey = configKey.toLowerCase()
      let searchStart = 0

      for (;;) {
        const keyIndex = lowerContent.indexOf(lowerKey, searchStart)
        if (keyIndex === -1) break

        const afterKey = content.slice(Math.max(0, keyIndex + configKey.length))
        const assignMatch = extractAssignment(afterKey, expectedValue)

        if (assignMatch) {
          const fullMatch = content.slice(
            keyIndex,
            keyIndex + configKey.length + assignMatch.length,
          )
          results.push({ index: keyIndex, match: fullMatch })
        }

        searchStart = keyIndex + 1
      }

      return results
    },
    message,
    suggestion,
    severity,
  }
}

/**
 * Extract TLS assignment value (0 with optional quotes).
 */
function extractTlsAssignment(afterKey: string): string | null {
  logger.debug({
    evt: 'fitness.checks.dangerous_config_defaults.extract_tls_assignment',
    msg: 'Extracting TLS assignment value with optional quotes',
  })
  let i = 0
  while (i < afterKey.length && (afterKey[i] === ' ' || afterKey[i] === '\t')) {
    i++
  }

  if (afterKey[i] !== '=' && afterKey[i] !== ':') {
    return null
  }
  i++

  while (i < afterKey.length && (afterKey[i] === ' ' || afterKey[i] === '\t')) {
    i++
  }

  const hasQuote = afterKey[i] === '"' || afterKey[i] === "'"
  if (hasQuote) i++

  if (afterKey[i] !== '0') {
    return null
  }
  i++

  if (hasQuote && (afterKey[i] === '"' || afterKey[i] === "'")) {
    i++
  }

  return afterKey.slice(0, Math.max(0, i))
}

/**
 * Check for TLS reject unauthorized env var set to disabled (with optional quotes).
 */
// @fitness-ignore-next-line dangerous-config-defaults -- This is the fitness check definition itself; the string literal 'node_tls_reject_unauthorized' is the pattern being detected, not actual TLS configuration
function createTlsRejectChecker(): ConfigPatternChecker {
  return {
    check(content: string): { index: number; match: string }[] {
      logger.debug({
        evt: 'fitness.checks.dangerous_config_defaults.tls_reject_checker_check',
        msg: 'Checking content for TLS reject unauthorized patterns',
      })
      const results: { index: number; match: string }[] = []
      const lowerContent = content.toLowerCase()
      const key = 'node_tls_reject_unauthorized'
      let searchStart = 0

      for (;;) {
        const keyIndex = lowerContent.indexOf(key, searchStart)
        if (keyIndex === -1) break

        const afterKey = content.slice(Math.max(0, keyIndex + key.length))
        const assignMatch = extractTlsAssignment(afterKey)

        if (assignMatch) {
          const fullMatch = content.slice(keyIndex, keyIndex + key.length + assignMatch.length)
          results.push({ index: keyIndex, match: fullMatch })
        }

        searchStart = keyIndex + 1
      }

      return results
    },
    message: 'TLS validation globally disabled via environment',
    suggestion: 'Remove this setting - it disables all TLS security',
    severity: 'error',
  }
}

/**
 * Check for very small connection pool sizes (1 or 2).
 */
// @fitness-ignore-next-line dangerous-config-defaults -- This is the fitness check definition itself; the string literal 'poolsize' is the pattern being detected, not actual pool configuration
function createPoolSizeChecker(): ConfigPatternChecker {
  return {
    check(content: string): { index: number; match: string }[] {
      logger.debug({
        evt: 'fitness.checks.dangerous_config_defaults.pool_size_checker_check',
        msg: 'Checking content for small connection pool size patterns',
      })
      const results: { index: number; match: string }[] = []
      const lowerContent = content.toLowerCase()
      let searchStart = 0

      for (;;) {
        const keyIndex = lowerContent.indexOf('poolsize', searchStart)
        if (keyIndex === -1) break

        const afterKey = content.slice(Math.max(0, keyIndex + 8))
        const assignMatch = extractPoolSizeAssignment(afterKey)

        if (assignMatch) {
          const fullMatch = content.slice(keyIndex, keyIndex + 8 + assignMatch.length)
          results.push({ index: keyIndex, match: fullMatch })
        }

        searchStart = keyIndex + 1
      }

      return results
    },
    message: 'Very small connection pool size',
    suggestion: 'Consider larger pool size for production workloads',
    severity: 'warning',
  }
}

function extractPoolSizeAssignment(afterKey: string): string | null {
  logger.debug({
    evt: 'fitness.checks.dangerous_config_defaults.extract_pool_size_assignment',
    msg: 'Extracting pool size assignment value',
  })
  let i = 0
  while (i < afterKey.length && (afterKey[i] === ' ' || afterKey[i] === '\t')) {
    i++
  }

  if (afterKey[i] !== '=' && afterKey[i] !== ':') {
    return null
  }
  i++

  while (i < afterKey.length && (afterKey[i] === ' ' || afterKey[i] === '\t')) {
    i++
  }

  if (afterKey[i] === '1' || afterKey[i] === '2') {
    const nextChar = afterKey[i + 1]
    if (!nextChar || !isDigit(nextChar)) {
      return afterKey.slice(0, Math.max(0, i + 1))
    }
  }

  return null
}

// =============================================================================
// DANGEROUS DEFAULTS PATTERNS
// =============================================================================

/**
 * Patterns for dangerous default configurations
 */
const DANGEROUS_DEFAULTS: ConfigPatternChecker[] = [
  createConfigChecker({
    configKey: 'ssl',
    expectedValue: 'false',
    message: 'SSL disabled in configuration',
    suggestion: 'Enable SSL for all database and service connections',
    severity: 'error',
  }),
  createConfigChecker({
    configKey: 'rejectUnauthorized',
    expectedValue: 'false',
    message: 'TLS certificate validation disabled',
    suggestion: 'Enable certificate validation in production',
    severity: 'error',
  }),
  createTlsRejectChecker(),
  createConfigChecker({
    configKey: 'debug',
    expectedValue: 'true',
    message: 'Debug mode enabled in configuration',
    suggestion: 'Ensure debug mode is disabled in production',
    severity: 'warning',
  }),
  createConfigChecker({
    configKey: 'maxRetries',
    expectedValue: '0',
    message: 'Zero retries configured - no fault tolerance',
    suggestion: 'Configure at least 1-3 retries for resilience',
    severity: 'warning',
  }),
  createConfigChecker({
    configKey: 'timeout',
    expectedValue: '0',
    message: 'Zero timeout configured - operations may hang indefinitely',
    suggestion: 'Set appropriate timeout values',
    severity: 'error',
  }),
  createPoolSizeChecker(),
]

// =============================================================================
// CHECK DEFINITION
// =============================================================================

/**
 * Check: resilience/dangerous-config-defaults
 *
 * Detects potentially dangerous configuration defaults that could
 * compromise security or reliability.
 */
export const dangerousConfigDefaults = defineCheck({
  id: '81e6dbfc-b755-4c65-a62b-ffd244542129',
  slug: 'dangerous-config-defaults',
  scope: { languages: ['typescript'], concerns: ['backend', 'server'] },

  confidence: 'medium',
  description: 'Detect dangerous default configurations',
  longDescription: `**Purpose:** Catches configuration defaults that compromise security or reliability if accidentally deployed to production.

**Detects:**
- \`ssl = false\` (SSL disabled)
- \`rejectUnauthorized = false\` (TLS certificate validation disabled)
- \`NODE_TLS_REJECT_UNAUTHORIZED = 0\` (global TLS validation disabled, with optional quotes)
- \`debug = true\` (debug mode enabled)
- \`maxRetries = 0\` (no fault tolerance)
- \`timeout = 0\` (operations may hang indefinitely)
- \`poolSize = 1\` or \`poolSize = 2\` (very small connection pool)

**Why it matters:** These defaults can silently disable security controls or remove fault tolerance, causing outages or vulnerabilities in production.

**Scope:** General best practice. Analyzes each file individually via string matching.`,
  tags: ['resilience', 'security', 'config'],
  fileTypes: ['ts'],

  analyze(content: string, filePath: string): CheckViolation[] {
    logger.debug({
      evt: 'fitness.checks.dangerous_config_defaults.analyze',
      msg: 'Analyzing file for dangerous configuration defaults',
    })
    const violations: CheckViolation[] = []

    for (const checker of DANGEROUS_DEFAULTS) {
      const matches = checker.check(content)
      for (const { index, match } of matches) {
        const lineNumber = getLineNumber(content, index)
        violations.push({
          line: lineNumber,
          column: 0,
          message: checker.message,
          severity: checker.severity,
          suggestion: checker.suggestion,
          match,
          type: 'dangerous-config',
          filePath,
        })
      }
    }

    return violations
  },
})
