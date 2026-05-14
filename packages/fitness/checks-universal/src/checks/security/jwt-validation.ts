// @fitness-ignore-file file-length-limits -- reviewed: tightly coupled JWT validation logic with pattern detection, AST analysis, and violation reporting requires single-file cohesion
// @fitness-ignore-file error-handling-quality -- reviewed: false positive; String.prototype.match() at line 141 is regex matching, not Result.match() error handling
/**
 * @fileoverview Validate JWT handling follows security best practices
 */

import { logger } from '@opensip-tools/core/logger'
import { defineCheck, type CheckViolation } from '@opensip-tools/fitness'

/**
 * JWT security pattern definitions.
 * Each pattern has a check function to avoid complex regex backtracking issues.
 */
interface JwtSecurityPattern {
  id: string
  message: string
  suggestion: string
  severity: 'error' | 'warning'
  check: (line: string) => { matched: boolean; matchIndex: number; matchText: string }
}

/**
 * Check if line contains jwt.verify without algorithm option.
 * Uses simple string matching to avoid ReDoS.
 *
 * @param line - Line to check
 * @returns Match result
 */
function checkJwtVerifyWithoutAlgorithm(line: string): {
  matched: boolean
  matchIndex: number
  matchText: string
} {
  logger.debug({
    evt: 'fitness.checks.jwt_validation.check_jwt_verify_without_algorithm',
    msg: 'Checking for JWT verify without algorithm option',
  })
  const idx = line.indexOf('jwt.verify')
  if (idx === -1) return { matched: false, matchIndex: -1, matchText: '' }

  // Find the end of the verify call
  const afterVerify = line.slice(Math.max(0, idx))
  const parenStart = afterVerify.indexOf('(')
  if (parenStart === -1) return { matched: false, matchIndex: -1, matchText: '' }

  // Count parentheses to find end of call
  let depth = 0
  let parenEnd = -1
  for (let i = parenStart; i < afterVerify.length; i++) {
    const char = afterVerify[i]
    if (char === '(') {
      depth++
    } else if (char === ')') {
      depth--
      if (depth === 0) {
        parenEnd = i
        break
      }
    } else {
      // Other characters are ignored during parenthesis counting
    }
  }

  if (parenEnd === -1) return { matched: false, matchIndex: -1, matchText: '' }

  const callContent = afterVerify.slice(parenStart, parenEnd + 1)

  // Check if there are 2 args (no options) - simple comma count for basic calls
  const commaCount = (callContent.match(/,/g) ?? []).length

  // jwt.verify(token, secret) has 1 comma, jwt.verify(token, secret, options) has 2+
  // Also check if 'algorithms' is mentioned
  if (commaCount === 1 && !callContent.toLowerCase().includes('algorithm')) {
    return { matched: true, matchIndex: idx, matchText: 'jwt.verify' + callContent }
  }

  return { matched: false, matchIndex: -1, matchText: '' }
}

/**
 * Check if line uses jwt.decode for authentication context.
 *
 * @param line - Line to check
 * @returns Match result
 */
function checkJwtDecodeForAuth(line: string): {
  matched: boolean
  matchIndex: number
  matchText: string
} {
  logger.debug({
    evt: 'fitness.checks.jwt_validation.check_jwt_decode_for_auth',
    msg: 'Checking for JWT decode used for authentication',
  })
  const idx = line.indexOf('jwt.decode')
  if (idx === -1) return { matched: false, matchIndex: -1, matchText: '' }

  // Check if line contains auth-related keywords
  const lowerLine = line.toLowerCase()
  const authKeywords = ['user', 'auth', 'session', 'token']
  const hasAuthKeyword = authKeywords.some((kw) => lowerLine.includes(kw))

  if (hasAuthKeyword) {
    return { matched: true, matchIndex: idx, matchText: 'jwt.decode' }
  }

  return { matched: false, matchIndex: -1, matchText: '' }
}

/**
 * Check if line has a weak JWT secret (short string literal).
 *
 * @param line - Line to check
 * @returns Match result
 */
function checkWeakJwtSecret(line: string): {
  matched: boolean
  matchIndex: number
  matchText: string
} {
  logger.debug({
    evt: 'fitness.checks.jwt_validation.check_weak_jwt_secret',
    msg: 'Checking for weak JWT secret',
  })
  const lowerLine = line.toLowerCase()
  const secretKeywords = ['jwtsecret', 'jwt_secret', 'jwt-secret', 'secret']

  for (const keyword of secretKeywords) {
    const idx = lowerLine.indexOf(keyword)
    if (idx === -1) continue

    // Look for assignment after keyword - simple check for short strings
    const afterKeyword = line.slice(Math.max(0, idx + keyword.length))
    // Match patterns like: = 'short' or : "short"
    // @fitness-ignore-next-line sonarjs-regular-expr -- Simple pattern with bounded quantifier {0,20} and negated class [^'"`]; no backtracking risk
    const assignMatch = /^\s*[:=]\s*['"`]([^'"`]{0,20})['"`]/.exec(afterKeyword)

    if (assignMatch?.[1] !== undefined && assignMatch[1].length <= 20) {
      return { matched: true, matchIndex: idx, matchText: keyword + assignMatch[0] }
    }
  }

  return { matched: false, matchIndex: -1, matchText: '' }
}

/**
 * Check if line allows algorithm 'none'.
 *
 * @param line - Line to check
 * @returns Match result
 */
function checkAlgorithmNone(line: string): {
  matched: boolean
  matchIndex: number
  matchText: string
} {
  logger.debug({
    evt: 'fitness.checks.jwt_validation.check_algorithm_none',
    msg: 'Checking for insecure algorithm none',
  })
  const lowerLine = line.toLowerCase()

  // Look for algorithms: ['none'] or algorithm: ['none']
  const patterns = ['algorithms', 'algorithm']
  for (const pattern of patterns) {
    const idx = lowerLine.indexOf(pattern)
    if (idx === -1) continue

    const afterPattern = lowerLine.slice(Math.max(0, idx))
    // Check for assignment to array containing 'none'
    const hasNone =
      afterPattern.includes('[') &&
      (afterPattern.includes("'none'") ||
        afterPattern.includes('"none"') ||
        afterPattern.includes('`none`'))

    if (hasNone) {
      const matchEnd = line.slice(Math.max(0, idx)).indexOf(']') + 1
      return { matched: true, matchIndex: idx, matchText: line.slice(idx, idx + matchEnd) }
    }
  }

  return { matched: false, matchIndex: -1, matchText: '' }
}

/**
 * Check if .verify( call is missing issuer/audience validation.
 * Only matches actual method calls (.verify() with opening paren),
 * not method names that contain 'verify' as a substring (e.g., verifyEventSignature).
 *
 * @param line - Line to check
 * @returns Match result
 */
function checkMissingIssuerAudience(line: string): {
  matched: boolean
  matchIndex: number
  matchText: string
} {
  logger.debug({
    evt: 'fitness.checks.jwt_validation.check_missing_issuer_audience',
    msg: 'Checking for missing issuer or audience validation',
  })
  // Look for .verify( specifically to match method calls, not substrings like verifyEventSignature
  const idx = line.indexOf('.verify(')
  if (idx === -1) return { matched: false, matchIndex: -1, matchText: '' }

  // Check if there's an options object
  const afterVerify = line.slice(Math.max(0, idx))
  if (!afterVerify.includes('{')) return { matched: false, matchIndex: -1, matchText: '' }

  // Check if issuer/audience/iss/aud is present
  const lowerAfter = afterVerify.toLowerCase()
  const hasValidation =
    lowerAfter.includes('issuer') ||
    lowerAfter.includes('audience') ||
    lowerAfter.includes('iss') ||
    lowerAfter.includes('aud')

  if (!hasValidation) {
    return { matched: true, matchIndex: idx, matchText: '.verify(...)' }
  }

  return { matched: false, matchIndex: -1, matchText: '' }
}

const JWT_SECURITY_PATTERNS: JwtSecurityPattern[] = [
  {
    // @fitness-ignore-next-line fitness-check-standards -- This is an internal pattern ID for violation grouping, not the check ID
    id: 'jwt-verify-no-algorithm',
    message: 'JWT verification without algorithm restriction - specify algorithms option',
    suggestion:
      'Add algorithms option to prevent algorithm substitution attacks: jwt.verify(token, secret, { algorithms: ["HS256"] }). This ensures only the expected algorithm is accepted.',
    severity: 'error',
    check: checkJwtVerifyWithoutAlgorithm,
  },
  {
    id: 'jwt-decode-for-auth',
    message: 'jwt.decode used for authentication - use jwt.verify instead',
    suggestion:
      'jwt.decode does not verify the signature! Use jwt.verify() for authentication: const payload = jwt.verify(token, secret, { algorithms: ["HS256"] });',
    severity: 'error',
    check: checkJwtDecodeForAuth,
  },
  {
    id: 'weak-jwt-secret',
    message: 'JWT secret appears weak (too short) - use a strong random secret',
    suggestion:
      'Use a cryptographically strong random secret of at least 256 bits (32 bytes). Generate with: openssl rand -base64 32. Store in environment variable, not in code.',
    severity: 'warning',
    check: checkWeakJwtSecret,
  },
  {
    id: 'algorithm-none',
    message: 'JWT algorithm "none" is insecure - never allow unsigned tokens',
    suggestion:
      'Remove "none" from allowed algorithms. This would allow unsigned tokens to bypass authentication. Use only secure algorithms like HS256, RS256, or ES256.',
    severity: 'error',
    check: checkAlgorithmNone,
  },
  {
    id: 'missing-issuer-audience',
    message: 'Consider adding issuer/audience validation for enhanced security',
    suggestion:
      'Add issuer and audience validation: jwt.verify(token, secret, { issuer: "your-issuer", audience: "your-api" }). This prevents token reuse across different services.',
    severity: 'warning',
    check: checkMissingIssuerAudience,
  },
]

/**
 * Check if content contains JWT-related keywords.
 * Uses simple string matching to avoid regex issues.
 *
 * @param content - Content to check
 * @returns True if JWT keywords found
 */
function hasJwtKeywords(content: string): boolean {
  logger.debug({
    evt: 'fitness.checks.jwt_validation.has_jwt_keywords',
    msg: 'Checking if content contains JWT-related keywords',
  })
  const lowerContent = content.toLowerCase()
  return (
    lowerContent.includes('jwt') ||
    lowerContent.includes('jsonwebtoken') ||
    lowerContent.includes('jose')
  )
}

/**
 * Check: security/jwt-validation
 *
 * Validates JWT handling follows security best practices including
 * algorithm specification, proper verification, and strong secrets.
 */
export const jwtValidation = defineCheck({
  id: '2f5c06d9-4b94-4dbf-a071-5ae021819d61',
  slug: 'jwt-validation',
  disabled: true,
  scope: { languages: ['typescript'], concerns: ['backend', 'server'] },
  contentFilter: 'strip-strings',

  confidence: 'medium',
  description: 'Validate JWT handling follows security best practices',
  longDescription: `**Purpose:** Validates that JWT handling code follows security best practices for token verification, algorithm selection, and secret strength.

**Detects:**
- \`jwt.verify(token, secret)\` with only 2 arguments (missing algorithms option) — enables algorithm substitution attacks
- \`jwt.decode\` used in auth context (decode does not verify signatures)
- Weak JWT secrets: short string literals (<=20 chars) assigned to jwt_secret/jwt-secret/secret variables
- Algorithm \`"none"\` in algorithms array — allows unsigned tokens
- \`.verify()\` calls with options object but missing issuer/audience validation

**Why it matters:** JWT misconfigurations are a top authentication bypass vector. Missing algorithm restriction, unverified tokens, and weak secrets can all lead to complete auth bypass.

**Scope:** General best practice. Analyzes each file individually. Only scans files containing jwt, jsonwebtoken, or jose references.`,
  tags: ['security', 'jwt', 'authentication'],
  fileTypes: ['ts'],

  analyze(content: string, filePath: string): CheckViolation[] {
    logger.debug({
      evt: 'fitness.checks.jwt_validation.analyze',
      msg: 'Analyzing file for JWT validation best practices',
    })
    // Skip files that don't deal with JWT
    if (!hasJwtKeywords(content)) {
      return []
    }

    const violations: CheckViolation[] = []
    const lines = content.split('\n')

    for (const [lineNum, line_] of lines.entries()) {
      const line = line_ ?? ''

      // Skip comments
      const trimmed = line.trim()
      if (trimmed.startsWith('//') || trimmed.startsWith('*')) {
        continue
      }

      for (const pattern of JWT_SECURITY_PATTERNS) {
        const result = pattern.check(line)
        if (result.matched) {
          violations.push({
            line: lineNum + 1,
            column: result.matchIndex,
            message: pattern.message,
            severity: pattern.severity,
            suggestion: pattern.suggestion,
            match: result.matchText,
            filePath,
          })
        }
      }
    }

    return violations
  },
})
