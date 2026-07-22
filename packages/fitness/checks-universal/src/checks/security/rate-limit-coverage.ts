/**
 * @fileoverview Validate routes have rate limiting configured
 */

import { logger } from '@opensip-cli/core';
import { defineCheck, type CheckViolation } from '@opensip-cli/fitness';

import {
  createCodeMask,
  createLiteralAwareCodeMask,
  findCodeMatches,
  hasCodeMatch,
} from '../code-aware-match.js';

/**
 * Pre-compiled regex patterns for rate limit detection.
 * These patterns match fixed, bounded strings with no user input - safe from ReDoS.
 */
const RATE_LIMIT_REGEX = /\b(?:rateLimit|rateLimiter)\b/i;
const INTERNAL_ROUTE_REGEX = new RegExp('/health|/metrics|/ready|/live|internal', 'i');
const ROUTE_PATH_REGEX = /\.(?:get|post|put|patch|delete)\s*\(\s*['"`]([^'"`]{1,500})['"`]/i;
const FASTIFY_ROUTE_REGEX = new RegExp(
  'fastify\\.(get|post|put|patch|delete)\\s*\\(\\s*[\'"`]/api[^\'"`]*[\'"`]',
  'gi',
);
const EXPRESS_ROUTE_REGEX = new RegExp(
  '(?:app|router)\\.(get|post|put|patch|delete)\\s*\\(\\s*[\'"`]/api[^\'"`]*[\'"`]',
  'gi',
);
const SENSITIVE_ENDPOINT_REGEX = new RegExp(
  '\\.(post|put)\\s*\\(\\s*[\'"`][^\'"`]*(?:login|signin|signup|register|password|reset|auth|token)[^\'"`]*[\'"`]',
  'gi',
);
const GLOBAL_RATE_LIMIT_REGISTER_REGEX = new RegExp(
  String.raw`\bfastify\s*\.\s*register\s*\(\s*(?:rateLimit|rateLimiter)\b`,
  'i',
);
const GLOBAL_RATE_LIMIT_USE_REGEX = new RegExp(
  String.raw`\b(?:app|router)\s*\.\s*use\s*\(\s*(?:rateLimit|rateLimiter)\b`,
  'i',
);
const FRAMEWORK_DETECT_REGEX = /(?:fastify|app|router)\.(get|post|put|patch|delete)\s*\(/i;

/**
 * Check if context has rate limiting
 * @param context - The code context to check
 * @returns True if rate limiting is present
 */
function hasRateLimiting(_context: string, codeContext: string): boolean {
  logger.debug({
    evt: 'fitness.checks.rate_limit_coverage.has_rate_limiting',
    msg: 'Checking if context has rate limiting',
  });
  return hasCodeMatch(RATE_LIMIT_REGEX, codeContext, codeContext);
}

/**
 * Check if route is internal (health, metrics, etc.)
 * @param context - The code context to check
 * @returns True if the route is internal
 */
function isInternalRoute(routeLine: string): boolean {
  logger.debug({
    evt: 'fitness.checks.rate_limit_coverage.is_internal_route',
    msg: 'Checking if route is internal',
  });
  const routePath = ROUTE_PATH_REGEX.exec(routeLine)?.[1];
  return routePath !== undefined && INTERNAL_ROUTE_REGEX.test(routePath);
}

// Patterns that indicate route definitions needing rate limiting
const ROUTE_PATTERNS = [
  // Fastify routes
  {
    regex: FASTIFY_ROUTE_REGEX,
    check: (context: string, codeContext: string, routeLine: string) =>
      !hasRateLimiting(context, codeContext) && !isInternalRoute(routeLine),
    message: 'API route may be missing rate limiting configuration',
    suggestion:
      'Add rate limiting middleware: fastify.register(rateLimiter, { max: 100, timeWindow: "1 minute" }). Apply per-route or globally.',
    severity: 'warning' as const,
  },
  // Express routes
  {
    regex: EXPRESS_ROUTE_REGEX,
    check: (context: string, codeContext: string, routeLine: string) =>
      !hasRateLimiting(context, codeContext) && !isInternalRoute(routeLine),
    message: 'API route may be missing rate limiting configuration',
    suggestion:
      'Add rate limiting middleware: app.use(rateLimiter({ max: 100, windowMs: 60000 })). Apply per-route or globally.',
    severity: 'warning' as const,
  },
  // Sensitive endpoints that must have rate limiting
  {
    regex: SENSITIVE_ENDPOINT_REGEX,
    check: (context: string, codeContext: string) => !hasRateLimiting(context, codeContext),
    message: 'Sensitive authentication endpoint should have rate limiting',
    suggestion:
      'Authentication endpoints must have strict rate limiting to prevent brute force attacks. Apply a limit of ~5-10 requests per minute for login/password endpoints.',
    severity: 'error' as const,
  },
];

function callEnd(codeMask: string, matchIndex: number): number {
  const openingParen = codeMask.indexOf('(', matchIndex);
  if (openingParen === -1) return matchIndex;
  let depth = 0;
  for (let index = openingParen; index < codeMask.length; index++) {
    if (codeMask[index] === '(') depth++;
    if (codeMask[index] !== ')') continue;
    depth--;
    if (depth === 0) return index + 1;
  }
  return codeMask.length;
}

function globalRateLimitIndexes(codeMask: string): readonly number[] {
  return [
    ...findCodeMatches(GLOBAL_RATE_LIMIT_REGISTER_REGEX, codeMask, codeMask),
    ...findCodeMatches(GLOBAL_RATE_LIMIT_USE_REGEX, codeMask, codeMask),
  ].map((match) => match.index);
}

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
  contentFilter: 'raw',

  confidence: 'medium',
  description: 'Validate routes have rate limiting configured',
  longDescription: `**Purpose:** Ensures API routes have rate limiting configured to prevent abuse, with stricter enforcement on authentication endpoints.

**Detects:**
- Fastify routes (\`fastify.get/post/put/patch/delete('/api/...')\`) without rateLimit/rateLimiter in the same route call
- Express routes (\`app/router.get/post/put/patch/delete('/api/...')\`) without rate limiting
- Sensitive authentication endpoints (\`.post/.put\` with login, signin, signup, register, password, reset, auth, or token in path) missing rate limiting (elevated to error severity)

**Why it matters:** Without rate limiting, APIs are vulnerable to brute-force attacks, credential stuffing, and denial-of-service. Authentication endpoints are especially critical targets.

**Scope:** General best practice. Analyzes each file individually. A global \`register(rateLimit)\` or \`use(rateLimit)\` protects only routes declared after that registration.`,
  tags: ['security', 'rate-limiting', 'api'],
  fileTypes: ['ts'],

  analyze(content: string, filePath: string): CheckViolation[] {
    logger.debug({
      evt: 'fitness.checks.rate_limit_coverage.analyze',
      msg: 'Analyzing file for rate limit coverage',
    });
    // Only check files that might define routes
    const codeMask = createCodeMask(filePath, content);
    const literalCodeMask = createLiteralAwareCodeMask(filePath, content);
    const syntaxMask = literalCodeMask === codeMask ? content : literalCodeMask;
    if (!hasCodeMatch(FRAMEWORK_DETECT_REGEX, syntaxMask, codeMask)) {
      return [];
    }

    // A sensitive route also matches its framework's generic route pattern.
    // Keep one finding per syntactic call, preferring the elevated error.
    const violationsByCall = new Map<number, CheckViolation>();
    const globalIndexes = globalRateLimitIndexes(codeMask);

    for (const pattern of ROUTE_PATTERNS) {
      for (const match of findCodeMatches(pattern.regex, syntaxMask, codeMask)) {
        const openingParen = codeMask.indexOf('(', match.index);
        const end = callEnd(codeMask, match.index);
        const routeCode = codeMask.slice(match.index, end);
        const routeSyntax = syntaxMask.slice(match.index, end);
        const hasPrecedingGlobal = globalIndexes.some((index) => index < match.index);
        if (hasPrecedingGlobal || !pattern.check(routeSyntax, routeCode, routeSyntax)) {
          continue;
        }

        const lineStart = content.lastIndexOf('\n', match.index - 1) + 1;
        // 1-based column within the line. `match.index` is a global content
        // offset here, so subtract the line start before the +1.
        const column = match.index - lineStart + 1;
        const violation: CheckViolation = {
          line: content.slice(0, match.index).split('\n').length,
          column,
          message: pattern.message,
          severity: pattern.severity,
          suggestion: pattern.suggestion,
          match: content.slice(match.index, match.index + match[0].length),
          filePath,
        };
        const existing = violationsByCall.get(openingParen);
        if (existing?.severity !== 'error') {
          violationsByCall.set(openingParen, violation);
        }
      }
    }

    return [...violationsByCall.values()];
  },
});
