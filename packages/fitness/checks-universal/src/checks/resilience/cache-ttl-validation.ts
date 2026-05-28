// @fitness-ignore-file duplicate-implementation-detection -- reviewed: pattern is architecturally justified or false positive
// @fitness-ignore-file unused-config-options -- Config options reserved for future use or environment-specific
/**
 * @fileoverview Cache TTL validation check
 */

import { logger } from '@opensip-tools/core/logger'
import { defineCheck, isTestFile, type CheckViolation } from '@opensip-tools/fitness'

import { isDigit } from './_helpers/config-validation.js'

// =============================================================================
// CONSTANTS
// =============================================================================

const MIN_TTL_SECONDS = 5 // Minimum 5 seconds to avoid thundering herd
const MAX_TTL_SECONDS = 86_400 // Maximum 24 hours for general data
const MAX_FINANCIAL_TTL_SECONDS = 60 // Maximum 1 minute for financial data

// =============================================================================
// DATA TYPE DETECTION
// =============================================================================

/**
 * Check if line contains financial data keywords.
 */
function isFinancialDataLine(line: string): boolean {
  const lowerLine = line.toLowerCase()
  const hasMoneyTerms =
    lowerLine.includes('balance') || lowerLine.includes('wallet') || lowerLine.includes('payment')
  const hasTransactionTerms =
    lowerLine.includes('transaction') || lowerLine.includes('escrow') || lowerLine.includes('price')
  const hasAccountingTerms =
    lowerLine.includes('amount') || lowerLine.includes('credit') || lowerLine.includes('debit')
  return hasMoneyTerms || hasTransactionTerms || hasAccountingTerms
}

/**
 * Check if line contains sensitive data keywords.
 */
function isSensitiveDataLine(line: string): boolean {
  const lowerLine = line.toLowerCase()
  const hasSessionTerms = lowerLine.includes('session') || lowerLine.includes('token')
  const hasAuthTerms =
    lowerLine.includes('auth') || lowerLine.includes('permission') || lowerLine.includes('role')
  return hasSessionTerms || hasAuthTerms
}

/**
 * Check if line should be skipped (non-cache pattern).
 */
function isNonCachePattern(line: string): boolean {
  const lowerLine = line.toLowerCase()
  const isMapOperation = line.includes('Map()') && line.includes('.set')
  const isCollectionInit = line.includes('new Map') || line.includes('new Set')
  const isMetricsOperation = lowerLine.includes('metrics.set') || lowerLine.includes('gauge.set')
  return isMapOperation || isCollectionInit || isMetricsOperation
}

/**
 * Check if file contains cache-related patterns.
 */
function hasCachePatterns(content: string): boolean {
  const lowerContent = content.toLowerCase()
  return (
    lowerContent.includes('cache') || lowerContent.includes('redis') || lowerContent.includes('ttl')
  )
}

// =============================================================================
// TTL PARSING
// =============================================================================

/**
 * Parse TTL value from a line using string matching.
 */
function parseTtlFromLine(line: string): { ttl: number; matchText: string } | null {
  logger.debug({
    evt: 'fitness.checks.cache_ttl_validation.parse_ttl_from_line',
    msg: 'Parsing TTL value from line using string matching',
  })
  const lowerLine = line.toLowerCase()
  const ttlIndex = lowerLine.indexOf('ttl')
  if (ttlIndex === -1) return null

  const afterTtl = line.slice(Math.max(0, ttlIndex + 3))
  let i = 0

  // Skip whitespace
  while (i < afterTtl.length && (afterTtl[i] === ' ' || afterTtl[i] === '\t')) {
    i++
  }

  // Check for = or :
  if (afterTtl[i] !== '=' && afterTtl[i] !== ':') {
    return null
  }
  i++

  // Skip whitespace
  while (i < afterTtl.length && (afterTtl[i] === ' ' || afterTtl[i] === '\t')) {
    i++
  }

  // Parse digits
  const digitStart = i
  while (i < afterTtl.length && isDigit(afterTtl[i])) {
    i++
  }

  if (digitStart === i) {
    return null // No digits found
  }

  // @fitness-ignore-next-line numeric-validation -- substring is guaranteed digit-only by isDigit loop above
  const ttlValue = Number.parseInt(afterTtl.slice(digitStart, i), 10)
  return {
    ttl: ttlValue,
    matchText: `ttl${afterTtl.slice(0, Math.max(0, i))}`,
  }
}

// =============================================================================
// VIOLATION DETECTION
// =============================================================================

interface TtlViolation {
  message: string
  severity: 'error' | 'warning'
  suggestion: string
  patternId: string
}

/**
 * Detect TTL violation type based on value and data type.
 */
function detectTtlViolation(
  ttl: number,
  isFinancialData: boolean,
  isSensitiveData: boolean,
): TtlViolation | null {
  logger.debug({
    evt: 'fitness.checks.cache_ttl_validation.detect_ttl_violation',
    msg: 'Detecting TTL violation type based on value and data type',
  })
  // TTL too short
  if (ttl < MIN_TTL_SECONDS) {
    return {
      message: `TTL of ${ttl}s is too short, may cause thundering herd`,
      severity: 'warning',
      suggestion: `Increase TTL to at least ${MIN_TTL_SECONDS}s to prevent thundering herd when cache expires simultaneously for many requests.`,
      patternId: 'ttl-too-short',
    }
  }

  // Financial data with long TTL
  if (isFinancialData && ttl > MAX_FINANCIAL_TTL_SECONDS) {
    return {
      message: `Financial data cached with ${ttl}s TTL may cause stale data`,
      severity: 'error',
      suggestion: `Reduce TTL to ${MAX_FINANCIAL_TTL_SECONDS}s or less for financial data. Stale financial data can cause incorrect balances, payments, or escrow issues.`,
      patternId: 'financial-ttl-too-long',
    }
  }

  // Sensitive data with long TTL
  if (isSensitiveData && ttl > MAX_TTL_SECONDS / 4) {
    return {
      message: `Sensitive data cached with ${ttl}s TTL may cause auth issues`,
      severity: 'warning',
      suggestion: `Consider reducing TTL to ${MAX_TTL_SECONDS / 4}s or less for sensitive data like sessions, tokens, or permissions to prevent stale authorization state.`,
      patternId: 'sensitive-ttl-too-long',
    }
  }

  // General data with excessive TTL
  if (!isFinancialData && !isSensitiveData && ttl > MAX_TTL_SECONDS) {
    return {
      message: `TTL of ${ttl}s exceeds maximum recommended (${MAX_TTL_SECONDS}s)`,
      severity: 'warning',
      suggestion: `Reduce TTL to ${MAX_TTL_SECONDS}s (24 hours) or add a comment justifying the longer TTL for this specific use case.`,
      patternId: 'ttl-too-long',
    }
  }

  return null
}

// =============================================================================
// CHECK DEFINITION
// =============================================================================

/**
 * Check: resilience/cache-ttl-validation
 *
 * Validates cache TTL values to prevent:
 * - Thundering herd (TTL too short)
 * - Stale data issues (TTL too long for sensitive data)
 * - Financial data cached inappropriately
 */
export const cacheTtlValidation = defineCheck({
  id: 'a4d3b82d-d599-4ff1-be42-1313b1c11a70',
  slug: 'cache-ttl-validation',
  scope: { languages: ['typescript'], concerns: ['backend', 'server'] },

  confidence: 'medium',
  description: 'Validate cache TTL values for appropriate caching behavior',
  longDescription: `**Purpose:** Validates that cache TTL values fall within safe ranges, with stricter limits for financial and sensitive data.

**Detects:**
- TTL assignments (\`ttl = N\` or \`ttl: N\`) in files containing cache/redis/ttl keywords
- TTL < 5s (thundering herd risk)
- TTL > 60s for financial data lines containing \`balance\`, \`wallet\`, \`payment\`, \`transaction\`, \`escrow\`, \`price\`, \`amount\`, \`credit\`, \`debit\`
- TTL > 21600s for sensitive data lines containing \`session\`, \`token\`, \`auth\`, \`permission\`, \`role\`
- TTL > 86400s (24h) for general data
- Skips non-cache patterns like \`new Map()\`, \`new Set()\`, and metrics operations

**Why it matters:** Incorrect TTLs cause thundering herd problems (too short) or serve dangerously stale financial/auth data (too long).

**Scope:** General best practice. Analyzes each file individually via string parsing.`,
  tags: ['resilience', 'cache', 'performance'],
  fileTypes: ['ts'],

  analyze(content: string, filePath: string): CheckViolation[] {
    // Test fixtures intentionally exercise TTL boundary cases (too short,
    // too long, financial TTLs) to verify detection logic.
    if (isTestFile(filePath)) return []

    logger.debug({
      evt: 'fitness.checks.cache_ttl_validation.analyze',
      msg: 'Analyzing file for cache TTL validation violations',
    })
    const violations: CheckViolation[] = []

    // Skip files that don't have cache patterns
    if (!hasCachePatterns(content)) {
      return violations
    }

    const lines = content.split('\n')
    for (const [i, line] of lines.entries()) {
      if (!line || isNonCachePattern(line)) {
        continue
      }

      const ttlResult = parseTtlFromLine(line)
      if (!ttlResult) continue

      const { ttl, matchText } = ttlResult
      const isFinancialData = isFinancialDataLine(line)
      const isSensitiveData = isSensitiveDataLine(line)

      const violation = detectTtlViolation(ttl, isFinancialData, isSensitiveData)
      if (!violation) continue

      const lineNumber = i + 1
      violations.push({
        line: lineNumber,
        column: 0,
        message: violation.message,
        severity: violation.severity,
        suggestion: violation.suggestion,
        match: matchText,
        type: violation.patternId,
        filePath,
      })
    }

    return violations
  },
})
