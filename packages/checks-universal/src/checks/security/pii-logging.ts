// @fitness-ignore-file pii-logging -- References 'user' in context of user-object detection logic, not actual PII logging
// @fitness-ignore-file logging-standards -- Suggestion/description strings contain logger call examples that match the logging-standards pattern
// @fitness-ignore-file fitness-ignore-validation -- Fitness-ignore directives reference internal check IDs that may not be statically resolvable
/**
 * @fileoverview Detect PII in log statements
 *
 * Enforces privacy-safe logging standards.
 */

import { logger } from '@opensip-tools/core/logger'

import { defineCheck, type CheckViolation } from '@opensip-tools/core'

// PII field names to detect in log statements
const PII_FIELDS = [
  'email',
  'phone',
  'ssn',
  'socialSecurity',
  'social_security',
  'creditCard',
  'credit_card',
  'cardNumber',
  'card_number',
  'cvv',
  'cvc',
  'address',
  'streetAddress',
  'street_address',
  'dateOfBirth',
  'date_of_birth',
  'dob',
  'passport',
  'driverLicense',
  'driver_license',
  'bankAccount',
  'bank_account',
  'routingNumber',
  'routing_number',
  'ipAddress',
  'ip_address',
]

// Logger patterns to detect
const LOGGER_PATTERNS = [
  /logger\.(info|debug|warn|error|trace|fatal)\s*\(/,

  /console\.(log|info|debug|warn|error)\s*\(/,

  /log\.(info|debug|warn|error|trace)\s*\(/,
]

/**
 * Check if line has PII masking applied (using simple string search)
 */
function hasPiiMasking(line: string): boolean {
  logger.debug({
    evt: 'fitness.checks.pii_logging.has_pii_masking',
    msg: 'Checking if line has PII masking applied',
  })
  const lowerLine = line.toLowerCase()
  return (
    lowerLine.includes('maskpii') ||
    lowerLine.includes('mask(') ||
    lowerLine.includes('redact') ||
    lowerLine.includes('sanitize')
  )
}

/**
 * Check if line has user object reference (without being a userId)
 */
function hasUserObjectReference(line: string): boolean {
  logger.debug({
    evt: 'fitness.checks.pii_logging.has_user_object_reference',
    msg: 'Checking if line has user object reference',
  })
  // Use indexOf-based approach to avoid ReDoS
  const lowerLine = line.toLowerCase()
  const userIdx = lowerLine.indexOf('user')
  if (userIdx === -1) return false

  // Check if followed by safe patterns (Id, _id, .id)
  const afterUser = lowerLine.substring(userIdx + 4)
  if (afterUser.startsWith('id') || afterUser.startsWith('_id') || afterUser.startsWith('.id')) {
    return false
  }

  // Check if it's a property assignment with userId
  if (lowerLine.includes('userid')) {
    return false
  }

  return true
}

/**
 * Find user logging match using simple string search
 */
function findUserLoggingMatch(line: string): { match: string; index: number } | null {
  logger.debug({
    evt: 'fitness.checks.pii_logging.find_user_logging_match',
    msg: 'Searching for user logging match in line',
  })
  const prefixes = ['logger.', 'console.', 'log.']

  // Filter to prefixes that exist in the line with valid parentheses
  const presentPrefixes = prefixes
    .map((prefix) => ({ prefix, idx: line.indexOf(prefix) }))
    .filter(({ idx }) => idx !== -1)
    .map(({ idx: prefixIdx }) => {
      const parenStart = line.indexOf('(', prefixIdx)
      const parenEnd = parenStart !== -1 ? line.indexOf(')', parenStart) : -1
      return { prefixIdx, parenStart, parenEnd }
    })
    .filter(({ parenStart, parenEnd }) => parenStart !== -1 && parenEnd !== -1)

  for (const { prefixIdx, parenStart, parenEnd } of presentPrefixes) {
    const callContent = line.substring(parenStart, parenEnd + 1)
    if (callContent.toLowerCase().includes('user')) {
      return {
        match: line.substring(prefixIdx, parenEnd + 1),
        index: prefixIdx,
      }
    }
  }

  return null
}

/**
 * Check: security/pii-logging
 *
 * Detects PII (Personally Identifiable Information) in log statements.
 * PII should be masked using a centralized PII masking utility or excluded from logs.
 */
export const piiLogging = defineCheck({
  id: '7126d006-7d16-4282-a589-7ce0760f4b84',
  slug: 'pii-logging',
  disabled: true,
  scope: { languages: ['typescript'], concerns: ['backend', 'frontend', 'cli'] },
  contentFilter: 'raw',

  confidence: 'medium',
  description: 'Detect PII fields in log statements',
  longDescription: `**Purpose:** Detects Personally Identifiable Information (PII) fields being logged without masking, enforcing privacy-safe logging practices.

**Detects:**
- PII field names (email, phone, ssn, creditCard, cardNumber, cvv, address, dateOfBirth, dob, passport, driverLicense, bankAccount, routingNumber, ipAddress, etc.) used as property assignments in logger/console/log calls without masking (maskPii, mask, redact, sanitize)
- Logging full user objects (e.g., \`logger.info({ user })\`) that may contain PII — only \`userId\`/\`user.id\` references are allowed

**Why it matters:** PII in logs violates privacy regulations (GDPR, CCPA) and creates liability. Log aggregation systems make leaked PII widely accessible within an organization.

**Scope:** Codebase-specific convention enforcing privacy-safe logging. Analyzes each file individually.`,
  tags: ['security', 'pii', 'logging', 'privacy'],
  fileTypes: ['ts'],

  analyze(content: string, filePath: string): CheckViolation[] {
    logger.debug({
      evt: 'fitness.checks.pii_logging.analyze',
      msg: 'Analyzing file for PII in log statements',
    })
    const violations: CheckViolation[] = []
    const lines = content.split('\n')

    // Build regex for PII fields (case-insensitive for object properties)

    const piiFieldsRegex = new RegExp(`(?:${PII_FIELDS.join('|')})\\s*[:=]`, 'gi')

    for (let lineNum = 0; lineNum < lines.length; lineNum++) {
      const line = lines[lineNum] ?? ''

      // Skip comments
      const trimmed = line.trim()
      if (trimmed.startsWith('//') || trimmed.startsWith('*')) {
        continue
      }

      // Check if line contains a logger call
      const isLoggerCall = LOGGER_PATTERNS.some((pattern) => pattern.test(line))
      if (!isLoggerCall) {
        continue
      }

      // Check for PII fields in the log statement
      piiFieldsRegex.lastIndex = 0
      const match = piiFieldsRegex.exec(line)
      if (match && !hasPiiMasking(line)) {
        // eslint-disable-next-line sonarjs/slow-regex -- \s* and [:=] do not overlap; $ anchor
        const piiField = match[0].replace(/\s*[:=]$/, '')
        violations.push({
          line: lineNum + 1,
          column: match.index,
          message: `PII field '${piiField}' detected in log statement - use a centralized PII masking utility`,
          severity: 'error',
          suggestion: `Use a PII masking function to redact PII before logging: logger.info({ ${piiField}: maskPii(${piiField}) });`,
          match: match[0],
          filePath,
        })
      }

      // Also check for logging entire user objects which may contain PII
      if (hasUserObjectReference(line)) {
        const userMatch = findUserLoggingMatch(line)
        if (userMatch) {
          violations.push({
            line: lineNum + 1,
            column: userMatch.index,
            message:
              'Logging full user object may expose PII - log only userId or specific safe fields',
            severity: 'warning',
            suggestion:
              'Instead of logging the full user object, log only safe identifiers: logger.info({ userId: user.id, action: "login" }). Never log email, phone, address, or other PII.',
            match: userMatch.match,
            filePath,
          })
        }
      }
    }

    return violations
  },
})
