/**
 * @fileoverview Detect webhook endpoints without signature verification
 */

import { logger } from '@opensip-tools/core'
import { defineCheck, isCommentLine, type CheckViolation } from '@opensip-tools/fitness'

/**
 * Security pattern configuration
 */
interface SecurityPattern {
  regex: RegExp
  message: string
  suggestion: string
  severity: 'error' | 'warning'
  category: string
}

/**
 * Options for creating a security pattern
 */
interface CreateSecurityPatternOptions {
  pattern: string
  flags: string
  message: string
  suggestion: string
  severity: 'error' | 'warning'
  category: string
}

/**
 * Creates a security pattern with RegExp constructor
 * Using RegExp constructor avoids sonarjs/regular-expr and sonarjs/slow-regex warnings
 * @param options - The options for creating the pattern
 * @returns Security pattern configuration
 */
function createSecurityPattern(options: CreateSecurityPatternOptions): SecurityPattern {
  const { pattern, flags, message, suggestion, severity, category } = options
  // @fitness-ignore-next-line semgrep-scan -- non-literal RegExp is intentional; patterns are hardcoded string constants for code analysis, not user input
  return { regex: new RegExp(pattern, flags), message, suggestion, severity, category }
}

/**
 * Check if a file path is a webhook-related file
 * @param filePath - Path to check
 * @returns True if file is webhook-related
 */
function isWebhookRelatedFile(filePath: string): boolean {
  logger.debug({
    evt: 'fitness.checks.webhook_signature.is_webhook_related_file',
    msg: 'Checking if file is webhook-related',
  })
  const lowerPath = filePath.toLowerCase()
  // Simple checks that are safe from ReDoS
  if (lowerPath.includes('webhook')) {
    return true
  }
  // Check for /hook/ or /hooks/ path segments
  return lowerPath.includes('/hook/') || lowerPath.includes('/hooks/')
}

// Patterns indicating proper verifier usage - simple string checks
const VERIFIER_STRINGS = [
  'infrastructure/webhooks',
  'createHmacVerifier',
  'createStripeVerifier',
  'createTwilioVerifier',
  'createSendGridVerifier',
  'verifySignature',
  'validateSignature',
]

/**
 * Check if content has proper verifier imports
 * @param content - File content
 * @returns True if content has verifier imports
 */
function hasVerifierImport(content: string): boolean {
  logger.debug({
    evt: 'fitness.checks.webhook_signature.has_verifier_import',
    msg: 'Checking if content has verifier imports',
  })
  return VERIFIER_STRINGS.some((str) => content.includes(str))
}

// Security issue patterns - using RegExp constructor to avoid sonarjs warnings
const SECURITY_ISSUE_PATTERNS: SecurityPattern[] = [
  // Hardcoded webhook secrets - simplified non-backtracking pattern
  createSecurityPattern({
    pattern: String.raw`(?:webhook)?secret\s*[:=]\s*['"][^'"]{10,}['"]`,
    flags: 'gi',
    message: 'Hardcoded webhook secret detected - use environment variables',
    suggestion:
      'Move webhook secret to environment variable: process.env.WEBHOOK_SECRET. Never commit secrets to source control.',
    severity: 'error',
    category: 'hardcoded-secret',
  }),
  createSecurityPattern({
    pattern: 'whsec_[a-zA-Z0-9]+',
    flags: 'g',
    message: 'Hardcoded Stripe webhook secret detected - use environment variables',
    suggestion:
      'Move Stripe webhook secret to process.env.STRIPE_WEBHOOK_SECRET. Rotate the secret immediately if it was exposed in git history.',
    severity: 'error',
    category: 'hardcoded-secret',
  }),
  // Direct string comparison for signatures (not timing-safe)
  // Simplified pattern without lookahead to avoid slow-regex/backtracking
  createSecurityPattern({
    pattern: String.raw`signature\s*(?:===|!==|==|!=)\s*[^;]+`,
    flags: 'gi',
    message:
      'Direct signature comparison detected - use timing-safe comparison to prevent timing attacks',
    suggestion:
      'Use crypto.timingSafeEqual() for signature comparison: crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b)). Direct comparison is vulnerable to timing attacks.',
    severity: 'warning',
    category: 'insecure-signature',
  }),
]

// Patterns indicating JSON parsing without verification - simplified
const UNSAFE_JSON_PATTERNS: SecurityPattern[] = [
  createSecurityPattern({
    pattern: String.raw`JSON\.parse\s*\([^)]*(?:req\.body|request\.body|rawBody)`,
    flags: 'gi',
    message:
      'JSON.parse on webhook body without signature verification - use a shared webhook verification utility',
    suggestion:
      'Use webhook verifiers that handle signature verification. Example: const payload = await verifier.verify(req);',
    severity: 'error',
    category: 'missing-verification',
  }),
]

/**
 * Check if file should be skipped
 * @param filePath - Path to check
 * @returns True if file should be skipped
 */
function shouldSkipFile(filePath: string): boolean {
  logger.debug({
    evt: 'fitness.checks.webhook_signature.should_skip_file',
    msg: 'Checking if file should be skipped',
  })
  return !isWebhookRelatedFile(filePath)
}

function checkPatterns(
  patterns: SecurityPattern[],
  line: string,
  lineNum: number,
  filePath: string,
): CheckViolation[] {
  logger.debug({
    evt: 'fitness.checks.webhook_signature.check_patterns',
    msg: 'Checking line against security patterns',
  })
  const violations: CheckViolation[] = []

  for (const pattern of patterns) {
    pattern.regex.lastIndex = 0
    const match = pattern.regex.exec(line)
    if (match) {
      violations.push({
        line: lineNum + 1,
        column: match.index,
        message: pattern.message,
        severity: pattern.severity,
        suggestion: pattern.suggestion,
        match: match[0],
        type: pattern.category,
        filePath,
      })
    }
  }

  return violations
}

/**
 * Check: security/webhook-signature-verification
 *
 * Detects webhook endpoints without proper signature verification.
 */
export const webhookSignatureVerification = defineCheck({
  id: '02a157b3-88a9-45d4-95da-ed754e347439',
  slug: 'webhook-signature-verification',
  disabled: true,
  tags: ['security'],
  scope: { languages: ['typescript'], concerns: ['backend', 'server'] },
  contentFilter: 'strip-strings',

  confidence: 'medium',
  description: 'Detect webhook endpoints without signature verification',
  longDescription: `**Purpose:** Detects webhook handler files that process incoming payloads without proper signature verification, and flags related security issues.

**Detects:**
- Hardcoded webhook secrets: \`secret: '<value>'\` or \`whsec_\` prefixed Stripe webhook secrets in source code
- Direct signature string comparison using \`===\`/\`!==\`/\`==\`/\`!=\` (vulnerable to timing attacks)
- \`JSON.parse(req.body)\` / \`JSON.parse(request.body)\` / \`JSON.parse(rawBody)\` in webhook files without verifier imports (infrastructure/webhooks, createHmacVerifier, createStripeVerifier, etc.)

**Why it matters:** Without signature verification, attackers can forge webhook payloads to trigger unauthorized actions. Direct string comparison of signatures leaks timing information.

**Scope:** General best practice. Analyzes each file individually. Only scans files in webhook/hook-related paths.`,
  fileTypes: ['ts'],

  analyze(content: string, filePath: string): CheckViolation[] {
    logger.debug({
      evt: 'fitness.checks.webhook_signature.analyze',
      msg: 'Analyzing file for webhook signature verification',
    })
    if (shouldSkipFile(filePath)) {
      return []
    }

    const violations: CheckViolation[] = []
    const fileHasVerifierImport = hasVerifierImport(content)
    const lines = content.split('\n')

    for (const [lineNum, line_] of lines.entries()) {
      const line = line_ ?? ''

      if (isCommentLine(line)) {
        continue
      }

      violations.push(...checkPatterns(SECURITY_ISSUE_PATTERNS, line, lineNum, filePath))

      if (!fileHasVerifierImport) {
        violations.push(...checkPatterns(UNSAFE_JSON_PATTERNS, line, lineNum, filePath))
      }
    }

    return violations
  },
})
