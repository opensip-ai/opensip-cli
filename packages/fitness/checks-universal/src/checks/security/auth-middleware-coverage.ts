// @fitness-ignore-file fitness-ignore-validation -- Fitness-ignore directives reference internal check IDs that may not be statically resolvable
/**
 * @fileoverview Validate routes have authentication middleware
 */

import { logger } from '@opensip-tools/core/logger'
import { defineCheck, type CheckViolation } from '@opensip-tools/fitness'
import { stripStringLiterals, stripStringsAndComments } from '@opensip-tools/fitness'

/**
 * Match Fastify route definitions
 * Pattern: fastify.METHOD('/path', handler)
 */
function matchFastifyRoute(line: string): RegExpExecArray | null {
  logger.debug({
    evt: 'fitness.checks.auth_middleware_coverage.match_fastify_route',
    msg: 'Checking for Fastify route definition',
  })
  // @fitness-ignore-next-line sonarjs-regular-expr -- Simple pattern with no backtracking risk; negated character class [^'"`]+ is linear
  return /fastify\.(get|post|put|patch|delete)\s*\(\s*['"`]([^'"`]+)['"`]/i.exec(line)
}

/**
 * Match Express route definitions
 * Pattern: app.METHOD('/path', handler) or router.METHOD('/path', handler)
 */
function matchExpressRoute(line: string): RegExpExecArray | null {
  logger.debug({
    evt: 'fitness.checks.auth_middleware_coverage.match_express_route',
    msg: 'Checking for Express route definition',
  })
  // @fitness-ignore-next-line sonarjs-regular-expr -- Simple pattern with no backtracking risk; negated character class [^'"`]+ is linear
  return /(?:app|router)\.(get|post|put|patch|delete)\s*\(\s*['"`]([^'"`]+)['"`]/i.exec(line)
}

// Patterns that indicate route definitions
const ROUTE_PATTERNS = [
  // Fastify routes without auth
  {
    match: matchFastifyRoute,
    check: (line: string) => !hasAuthMiddleware(line) && !isPublicRoute(line),
    message: 'Route may be missing authentication middleware',
    suggestion:
      'Add auth middleware via preHandler: { preHandler: [authMiddleware] } or use onRequest hook with authentication check.',
    severity: 'warning' as const,
  },
  // Express routes without auth
  {
    match: matchExpressRoute,
    check: (line: string) => !hasAuthMiddleware(line) && !isPublicRoute(line),
    message: 'Route may be missing authentication middleware',
    suggestion:
      'Add auth middleware before the route handler: router.get("/path", authMiddleware, handler). Or mark as public: { public: true }.',
    severity: 'warning' as const,
  },
]

// Keywords indicating auth middleware is present
const AUTH_MIDDLEWARE_KEYWORDS = [
  'authmiddleware',
  'authenticate',
  'requireauth',
  'isauthenticated',
  'verifytoken',
  'verifyjwt',
]

// Keywords indicating intentionally public routes
const PUBLIC_ROUTE_KEYWORDS = [
  'public',
  'skipauth',
  'noauth',
  '/health',
  '/status',
  '/ping',
  '/ready',
  '/live',
  '/metrics',
  '/docs',
  '/swagger',
  '/openapi',
  '/.well-known',
]

function hasAuthMiddleware(line: string): boolean {
  logger.debug({
    evt: 'fitness.checks.auth_middleware_coverage.has_auth_middleware',
    msg: 'Checking if line has auth middleware',
  })
  const lowerLine = line.toLowerCase()
  if (AUTH_MIDDLEWARE_KEYWORDS.some((kw) => lowerLine.includes(kw))) {
    return true
  }
  // Check for preHandler.*auth or onRequest.*auth patterns
  if (
    (lowerLine.includes('prehandler') || lowerLine.includes('onrequest')) &&
    lowerLine.includes('auth')
  ) {
    return true
  }
  return false
}

function isPublicRoute(line: string): boolean {
  logger.debug({
    evt: 'fitness.checks.auth_middleware_coverage.is_public_route',
    msg: 'Checking if route is public',
  })
  const lowerLine = line.toLowerCase()
  return PUBLIC_ROUTE_KEYWORDS.some((kw) => lowerLine.includes(kw))
}

// Paths to exclude from checking
const PUBLIC_ROUTE_PATTERNS = ['/health/', '/status/']

/**
 * Check if content contains route-defining framework references
 */
function containsRouteFramework(content: string): boolean {
  logger.debug({
    evt: 'fitness.checks.auth_middleware_coverage.contains_route_framework',
    msg: 'Checking if content contains route framework references',
  })
  const stripped = stripStringsAndComments(content)
  return /(?:fastify|app|router)\.(get|post|put|patch|delete)\s*\(/i.test(stripped)
}

/**
 * Check if file has global auth middleware applied
 */
function hasGlobalAuthMiddleware(content: string): boolean {
  logger.debug({
    evt: 'fitness.checks.auth_middleware_coverage.has_global_auth_middleware',
    msg: 'Checking if file has global auth middleware applied',
  })
  const stripped = stripStringsAndComments(content)
  return /\.register\s*\(\s*auth/i.test(stripped) || /\.use\s*\(\s*auth/i.test(stripped)
}

/**
 * Determine if a file should be processed for auth middleware checks
 */
function shouldProcessFile(filePath: string, content: string): boolean {
  logger.debug({
    evt: 'fitness.checks.auth_middleware_coverage.should_process_file',
    msg: 'Determining if file should be processed for auth middleware checks',
  })
  // Skip excluded paths
  if (PUBLIC_ROUTE_PATTERNS.some((p) => filePath.includes(p))) {
    return false
  }
  // Only check files that might define routes
  if (!containsRouteFramework(content)) {
    return false
  }
  // If global auth is applied, skip detailed checking
  if (hasGlobalAuthMiddleware(content)) {
    return false
  }
  return true
}

/**
 * Check: security/auth-middleware-coverage
 *
 * Validates all routes have proper authentication middleware.
 * Ensures no endpoints are accidentally exposed without auth.
 */
export const authMiddlewareCoverage = defineCheck({
  id: 'eb8b97f1-3125-4391-be4d-020c74413817',
  slug: 'auth-middleware-coverage',
  scope: { languages: ['typescript'], concerns: ['backend', 'server'] },
  contentFilter: 'strip-strings',

  confidence: 'medium',
  description: 'Validate routes have authentication middleware',
  longDescription: `**Purpose:** Ensures all Fastify and Express route definitions include authentication middleware, preventing accidental exposure of unprotected endpoints.

**Detects:**
- Fastify routes: \`fastify.(get|post|put|patch|delete)('/path', ...)\` without auth middleware keywords (authMiddleware, authenticate, requireAuth, verifyToken, verifyJwt) or preHandler/onRequest auth hooks
- Express routes: \`(app|router).(get|post|put|patch|delete)('/path', ...)\` without auth middleware

**Why it matters:** A single unprotected endpoint can expose sensitive data or allow unauthorized actions. This check catches routes missing auth before they reach production.

**Scope:** General best practice. Analyzes each file individually. Skips files with global auth middleware (\`register\`/\`use\` + \`auth\`) and public routes (/health, /status, /docs, etc.).`,
  tags: ['security', 'authentication', 'middleware', 'routes'],
  fileTypes: ['ts'],

  analyze(content: string, filePath: string): CheckViolation[] {
    logger.debug({
      evt: 'fitness.checks.auth_middleware_coverage.analyze',
      msg: 'Analyzing file for auth middleware coverage',
    })
    if (!shouldProcessFile(filePath, content)) {
      return []
    }

    const violations: CheckViolation[] = []
    const lines = content.split('\n')

    for (let lineNum = 0; lineNum < lines.length; lineNum++) {
      const line = lines[lineNum] ?? ''

      // Get context (current line + next few lines)
      const context = lines.slice(lineNum, lineNum + 5).join(' ')

      // Skip comments
      const trimmed = line.trim()
      if (trimmed.startsWith('//') || trimmed.startsWith('*')) {
        continue
      }

      const strippedLine = stripStringLiterals(line)
      const strippedContext = stripStringLiterals(context)

      for (const pattern of ROUTE_PATTERNS) {
        const match = pattern.match(strippedLine)
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
