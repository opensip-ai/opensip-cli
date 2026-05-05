/**
 * @fileoverview Service communication and infrastructure resilience checks
 */

import { logger } from '@opensip-tools/core/logger'

import { defineCheck, type CheckViolation, getLineNumber } from '@opensip-tools/core'

// =============================================================================
// PRE-COMPILED REGEX PATTERNS (Safe for static code analysis)
// =============================================================================

// Service entry patterns (bounded quantifiers to prevent slow regex)
const LISTEN_PATTERN = /\.listen\s{0,5}\(/
const FASTIFY_PATTERN = /fastify\s{0,5}\(\)/
const EXPRESS_PATTERN = /express\s{0,5}\(\)/
const CREATE_SERVER_PATTERN = /createServer\s{0,5}\(/

// Shutdown patterns (bounded quantifiers to prevent slow regex)
const SIGTERM_PATTERN = /process\.on\s{0,5}\(\s{0,5}['"]SIGTERM['"]/
const SIGINT_PATTERN = /process\.on\s{0,5}\(\s{0,5}['"]SIGINT['"]/
const CLOSE_PATTERN = /\.close\s{0,5}\(\s{0,5}\)/
const GRACEFUL_PATTERN = /graceful(?:Shutdown|Stop)/i

// API endpoint patterns
const GET_ENDPOINT_PATTERN = /\.get\s*\(\s*['"][^'"]{1,200}['"]/
const POST_ENDPOINT_PATTERN = /\.post\s*\(\s*['"][^'"]{1,200}['"]/
const PUT_ENDPOINT_PATTERN = /\.put\s*\(\s*['"][^'"]{1,200}['"]/
const DELETE_ENDPOINT_PATTERN = /\.delete\s*\(\s*['"][^'"]{1,200}['"]/
const PATCH_ENDPOINT_PATTERN = /\.patch\s*\(\s*['"][^'"]{1,200}['"]/

// Rate limiting patterns
const RATE_LIMIT_PATTERN = /rateLimit/i
const RATE_LIMITER_PATTERN = /rateLimiter/i
const THROTTLE_PATTERN = /throttle/i
const RATE_LIMIT_DECORATOR_PATTERN = /@RateLimit/

// Sensitive endpoints
const AUTH_ENDPOINT_PATTERN = /\/auth\//i
const LOGIN_ENDPOINT_PATTERN = /\/login/i
const REGISTER_ENDPOINT_PATTERN = /\/register/i
const PASSWORD_ENDPOINT_PATTERN = /\/password/i
const PAYMENT_ENDPOINT_PATTERN = /\/payment/i


// =============================================================================
// PATTERN ARRAYS (Using pre-compiled patterns)
// =============================================================================

const SERVICE_ENTRY_PATTERNS = [
  LISTEN_PATTERN,
  FASTIFY_PATTERN,
  EXPRESS_PATTERN,
  CREATE_SERVER_PATTERN,
]

const SHUTDOWN_PATTERNS = [SIGTERM_PATTERN, SIGINT_PATTERN, CLOSE_PATTERN, GRACEFUL_PATTERN]

const API_ENDPOINT_PATTERNS = [
  GET_ENDPOINT_PATTERN,
  POST_ENDPOINT_PATTERN,
  PUT_ENDPOINT_PATTERN,
  DELETE_ENDPOINT_PATTERN,
  PATCH_ENDPOINT_PATTERN,
]

const RATE_LIMITING_PATTERNS = [
  RATE_LIMIT_PATTERN,
  RATE_LIMITER_PATTERN,
  THROTTLE_PATTERN,
  RATE_LIMIT_DECORATOR_PATTERN,
]

const SENSITIVE_ENDPOINTS = [
  AUTH_ENDPOINT_PATTERN,
  LOGIN_ENDPOINT_PATTERN,
  REGISTER_ENDPOINT_PATTERN,
  PASSWORD_ENDPOINT_PATTERN,
  PAYMENT_ENDPOINT_PATTERN,
]


// =============================================================================
// HELPER FUNCTIONS
// =============================================================================

function isServiceEntryPoint(content: string): boolean {
  logger.debug({
    evt: 'fitness.checks.service_patterns.is_service_entry_point',
    msg: 'Checking if content is a service entry point',
  })
  return SERVICE_ENTRY_PATTERNS.some((pattern) => pattern.test(content))
}

function hasShutdownHandler(content: string): boolean {
  logger.debug({
    evt: 'fitness.checks.service_patterns.has_shutdown_handler',
    msg: 'Checking if content has shutdown handler',
  })
  return SHUTDOWN_PATTERNS.some((pattern) => pattern.test(content))
}

function hasApiEndpoints(content: string): boolean {
  logger.debug({
    evt: 'fitness.checks.service_patterns.has_api_endpoints',
    msg: 'Checking if content has API endpoints',
  })
  return API_ENDPOINT_PATTERNS.some((pattern) => pattern.test(content))
}

function matchesRateLimitingPatterns(content: string): boolean {
  logger.debug({
    evt: 'fitness.checks.service_patterns.matches_rate_limiting_patterns',
    msg: 'Checking if content matches rate limiting patterns',
  })
  return RATE_LIMITING_PATTERNS.some((pattern) => pattern.test(content))
}

function isSensitiveEndpoint(line: string): boolean {
  logger.debug({
    evt: 'fitness.checks.service_patterns.is_sensitive_endpoint',
    msg: 'Checking if line contains a sensitive endpoint',
  })
  return SENSITIVE_ENDPOINTS.some((pattern) => pattern.test(line))
}

function isApiEndpoint(line: string): boolean {
  logger.debug({
    evt: 'fitness.checks.service_patterns.is_api_endpoint',
    msg: 'Checking if line contains an API endpoint',
  })
  return API_ENDPOINT_PATTERNS.some((pattern) => pattern.test(line))
}


// =============================================================================
// GRACEFUL SHUTDOWN
// =============================================================================

/**
 * Check: resilience/graceful-shutdown
 *
 * Validates services implement proper graceful shutdown handling.
 * Ensures in-flight requests complete and resources are cleaned up.
 */
export const gracefulShutdown = defineCheck({
  id: '3e98b441-1ec9-4963-bb97-6f5b0bce0fbe',
  slug: 'graceful-shutdown',
  scope: { languages: ['typescript'], concerns: ['backend', 'server'] },
  contentFilter: 'strip-strings',

  confidence: 'medium',
  description: 'Validate services implement graceful shutdown handling',
  longDescription: `**Purpose:** Ensures service entry points implement graceful shutdown to allow in-flight requests to complete before termination.

**Detects:**
- Files containing service entry patterns (\`.listen(\`, \`fastify()\`, \`express()\`, \`createServer(\`) without shutdown handlers
- Checks for \`process.on('SIGTERM'\`, \`process.on('SIGINT'\`, \`.close()\`, or \`gracefulShutdown\`/\`gracefulStop\` patterns

**Why it matters:** Without graceful shutdown, deploys and restarts drop in-flight requests, corrupt transactions, and leak resources.

**Scope:** General best practice. Analyzes each file individually via regex.`,
  tags: ['resilience', 'infrastructure', 'shutdown'],
  fileTypes: ['ts'],

  analyze(content: string, filePath: string): CheckViolation[] {
    const violations: CheckViolation[] = []

    if (!isServiceEntryPoint(content)) {
      return violations
    }

    if (hasShutdownHandler(content)) {
      return violations
    }

    // Find service entry violation
    for (const pattern of SERVICE_ENTRY_PATTERNS) {
      // @fitness-ignore-next-line performance-anti-patterns -- false positive: keyword in comment text below, not an async call
      // @lazy-ok -- 'await' appears in suggestion string literal, not actual await
      pattern.lastIndex = 0
      const match = pattern.exec(content)
      if (!match) {
        continue
      }

      const lineNumber = getLineNumber(content, match.index)
      violations.push({
        line: lineNumber,
        column: 0,
        message: 'Service entry point missing graceful shutdown handler',
        severity: 'warning',
        suggestion:
          'Add SIGTERM/SIGINT handlers to gracefully close connections. Example: process.on("SIGTERM", async () => { await server.close(); process.exit(0); })',
        match: match[0],
        type: 'missing-shutdown-handler',
        filePath,
      })
      // Found one violation, exit loop
      break
    }

    return violations
  },
})

// =============================================================================
// RATE LIMITING COVERAGE
// =============================================================================

/**
 * Check: resilience/rate-limiting-coverage
 *
 * Validates API endpoints have rate limiting configured,
 * especially for sensitive operations.
 */
export const rateLimitingCoverage = defineCheck({
  id: '4648cce9-f8de-47fe-9350-5f49953c8edc',
  slug: 'rate-limiting-coverage',
  scope: { languages: ['typescript'], concerns: ['backend', 'server'] },
  description: 'Validate API endpoints have rate limiting',
  longDescription: `**Purpose:** Ensures sensitive API endpoints have rate limiting configured to prevent abuse.

**Detects:**
- API endpoint definitions (\`.get(\`, \`.post(\`, \`.put(\`, \`.delete(\`, \`.patch(\` with string path) that match sensitive paths (\`/auth/\`, \`/login\`, \`/register\`, \`/password\`, \`/payment\`)
- Flags when the file lacks any rate limiting indicator: \`rateLimit\`, \`rateLimiter\`, \`throttle\`, \`@RateLimit\`

**Why it matters:** Unprotected auth, login, and payment endpoints are vulnerable to brute-force attacks, credential stuffing, and payment fraud.

**Scope:** General best practice. Analyzes each file individually via regex.`,
  tags: ['resilience', 'security', 'rate-limiting'],

  analyze(content: string, filePath: string): CheckViolation[] {
    const violations: CheckViolation[] = []

    if (!hasApiEndpoints(content)) {
      return violations
    }

    const hasRateLimitingInFile = matchesRateLimitingPatterns(content)
    const lines = content.split('\n')

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]
      if (!line) continue

      const isEndpoint = isApiEndpoint(line)
      const isSensitive = isSensitiveEndpoint(line)

      if (isEndpoint && isSensitive && !hasRateLimitingInFile) {
        const lineNumber = i + 1
        violations.push({
          line: lineNumber,
          column: 0,
          message: 'Sensitive endpoint without rate limiting',
          severity: 'warning',
          suggestion:
            'Add rate limiting to prevent abuse. Use a shared rate limiter middleware or apply a @RateLimit decorator to protect auth, login, and payment endpoints.',
          match: line.trim(),
          type: 'sensitive-endpoint-no-rate-limit',
          filePath,
        })
      }
    }

    return violations
  },
})

