/**
 * @fileoverview Validate routes have rate limiting configured
 */

import { logger } from '@opensip-tools/core/logger'

import { defineCheck, type CheckViolation } from '@opensip-tools/core'
import { stripStringLiterals, stripStringsAndComments } from '@opensip-tools/core/framework/strip-literals.js'


/**
 * Pre-compiled regex patterns for rate limit detection.
 * These patterns match fixed, bounded strings with no user input - safe from ReDoS.
 */
const RATE_LIMIT_REGEX = new RegExp(
  'rateLimit|rateLimiter|preHandler.*rateLimit|onRequest.*rateLimit',
  'i',
)
const INTERNAL_ROUTE_REGEX = new RegExp('/health|/metrics|/ready|/live|internal', 'i')
const FASTIFY_ROUTE_REGEX = new RegExp(
  'fastify\\.(get|post|put|patch|delete)\\s*\\(\\s*[\'"`]/api[^\'"`]*[\'"`]',
  'gi',
)
const EXPRESS_ROUTE_REGEX = new RegExp(
  '(?:app|router)\\.(get|post|put|patch|delete)\\s*\\(\\s*[\'"`]/api[^\'"`]*[\'"`]',
  'gi',
)
const SENSITIVE_ENDPOINT_REGEX = new RegExp(
  '\\.(post|put)\\s*\\(\\s*[\'"`][^\'"`]*(?:login|signin|signup|register|password|reset|auth|token)[^\'"`]*[\'"`]',
  'gi',
)
const GLOBAL_RATE_LIMIT_REGISTER_REGEX = new RegExp(
  'register\\s*\\(\\s*(?:rateLimit|rateLimiter)',
  'i',
)
const GLOBAL_RATE_LIMIT_USE_REGEX = new RegExp('use\\s*\\(\\s*(?:rateLimit|rateLimiter)', 'i')
const FRAMEWORK_DETECT_REGEX = /(?:fastify|app|router)\.(get|post|put|patch|delete)\s*\(/i

/**
 * Check if context has rate limiting
 * @param context - The code context to check
 * @returns True if rate limiting is present
 */
function hasRateLimiting(context: string): boolean {
  logger.debug({
    evt: 'fitness.checks.rate_limit_coverage.has_rate_limiting',
    msg: 'Checking if context has rate limiting',
  })
  return RATE_LIMIT_REGEX.test(context)
}

/**
 * Check if route is internal (health, metrics, etc.)
 * @param context - The code context to check
 * @returns True if the route is internal
 */
function isInternalRoute(context: string): boolean {
  logger.debug({
    evt: 'fitness.checks.rate_limit_coverage.is_internal_route',
    msg: 'Checking if route is internal',
  })
  return INTERNAL_ROUTE_REGEX.test(context)
}

// Patterns that indicate route definitions needing rate limiting
const ROUTE_PATTERNS = [
  // Fastify routes
  {
    regex: FASTIFY_ROUTE_REGEX,
    check: (context: string) => !hasRateLimiting(context) && !isInternalRoute(context),
    message: 'API route may be missing rate limiting configuration',
    suggestion:
      'Add rate limiting middleware: fastify.register(rateLimiter, { max: 100, timeWindow: "1 minute" }). Apply per-route or globally.',
    severity: 'warning' as const,
  },
  // Express routes
  {
    regex: EXPRESS_ROUTE_REGEX,
    check: (context: string) => !hasRateLimiting(context) && !isInternalRoute(context),
    message: 'API route may be missing rate limiting configuration',
    suggestion:
      'Add rate limiting middleware: app.use(rateLimiter({ max: 100, windowMs: 60000 })). Apply per-route or globally.',
    severity: 'warning' as const,
  },
  // Sensitive endpoints that must have rate limiting
  {
    regex: SENSITIVE_ENDPOINT_REGEX,
    check: (context: string) => !hasRateLimiting(context),
    message: 'Sensitive authentication endpoint should have rate limiting',
    suggestion:
      'Authentication endpoints must have strict rate limiting to prevent brute force attacks. Apply a limit of ~5-10 requests per minute for login/password endpoints.',
    severity: 'error' as const,
  },
]

/**
 * Check: security/rate-limit-coverage
 *
 * Validates that routes have rate limiting configured.
 */
export const rateLimitCoverage = defineCheck({
  id: '19382a02-5d84-4316-b0a3-906f4acd7061',
  slug: 'rate-limit-coverage',
  disabled: true,
  scope: { languages: ['typescript'], concerns: ['backend', 'server'] },
  contentFilter: 'strip-strings',

  confidence: 'medium',
  description: 'Validate routes have rate limiting configured',
  longDescription: `**Purpose:** Ensures API routes have rate limiting configured to prevent abuse, with stricter enforcement on authentication endpoints.

**Detects:**
- Fastify routes (\`fastify.get/post/put/patch/delete('/api/...')\`) without rateLimit/rateLimiter in the surrounding context (next 8 lines)
- Express routes (\`app/router.get/post/put/patch/delete('/api/...')\`) without rate limiting
- Sensitive authentication endpoints (\`.post/.put\` with login, signin, signup, register, password, reset, auth, or token in path) missing rate limiting (elevated to error severity)

**Why it matters:** Without rate limiting, APIs are vulnerable to brute-force attacks, credential stuffing, and denial-of-service. Authentication endpoints are especially critical targets.

**Scope:** General best practice. Analyzes each file individually. Skips files with global rate limiting (\`register(rateLimit)\` or \`use(rateLimit)\`).`,
  tags: ['security', 'rate-limiting', 'api'],
  fileTypes: ['ts'],

  analyze(content: string, filePath: string): CheckViolation[] {
    logger.debug({
      evt: 'fitness.checks.rate_limit_coverage.analyze',
      msg: 'Analyzing file for rate limit coverage',
    })
    // Only check files that might define routes
    if (!FRAMEWORK_DETECT_REGEX.test(stripStringsAndComments(content))) {
      return []
    }

    // Check if file has global rate limiting applied
    const hasGlobalRateLimit =
      GLOBAL_RATE_LIMIT_REGISTER_REGEX.test(content) || GLOBAL_RATE_LIMIT_USE_REGEX.test(content)

    // If global rate limiting is applied, skip detailed checking
    if (hasGlobalRateLimit) {
      return []
    }

    const violations: CheckViolation[] = []
    const lines = content.split('\n')

    for (let lineNum = 0; lineNum < lines.length; lineNum++) {
      const line = lines[lineNum] ?? ''

      // Get context (current line + next few lines)
      const context = lines.slice(lineNum, lineNum + 8).join(' ')

      // Skip comments
      const trimmed = line.trim()
      if (trimmed.startsWith('//') || trimmed.startsWith('*')) {
        continue
      }

      const strippedLine = stripStringLiterals(line)
      const strippedContext = stripStringLiterals(context)

      for (const pattern of ROUTE_PATTERNS) {
        // Reset regex state
        pattern.regex.lastIndex = 0
        const match = pattern.regex.exec(strippedLine)
        if (match && pattern.check(strippedContext)) {
          violations.push({
            line: lineNum + 1,
            column: match.index,
            message: pattern.message,
            severity: pattern.severity,
            suggestion: pattern.suggestion,
            match: match[0],
            filePath,
          })
        }
      }
    }

    return violations
  },
})
