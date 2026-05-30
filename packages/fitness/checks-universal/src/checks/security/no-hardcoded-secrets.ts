// @fitness-ignore-file no-hardcoded-secrets -- Fitness check definition references secret patterns in longDescription as examples, not actual secrets
/**
 * @fileoverview Detect hardcoded secrets in source code.
 *
 * Inline regex-list shape retained — migration to `defineRegexListCheck`
 * deferred (Phase C6 / 2026-05-23 NF2). This site has site-specific
 * post-match filters that the helper does not model:
 *   1. `isInsideRegexLiteral` — skips matches inside `/.../` literals
 *      to avoid false-firing on detection-pattern source itself.
 *   2. `lineHasRedactionPlaceholder` — skips lines containing `***`,
 *      `[REDACTED]`, `<REDACTED>`, or `X{4,}` redaction markers.
 * Adding these as helper options would broaden its surface beyond
 * what the other adopters need; keeping them inline here is the
 * smaller change.
 */

import { logger } from '@opensip-tools/core'
import { defineCheck, type CheckViolation } from '@opensip-tools/fitness'

/**
 * Creates a pre-compiled RegExp for pattern matching.
 * These patterns operate on trusted source code files, not user input,
 * and use bounded character classes to prevent ReDoS.
 * @param pattern - The regex pattern string
 * @param flags - Optional regex flags
 * @returns Compiled RegExp object
 */
function createPattern(pattern: string, flags?: string): RegExp {
  // @fitness-ignore-next-line semgrep-scan -- non-literal RegExp is intentional; patterns are hardcoded string constants for code analysis, not user input
  return new RegExp(pattern, flags)
}

// Patterns that indicate hardcoded secrets
// Note: These regex patterns operate on trusted source code files, not user input.
// The patterns use bounded character classes and limited repetition to prevent ReDoS.
const SECRET_PATTERNS = [
  // Stripe keys - bounded alphanumeric character class
  {
    regex: createPattern('[\'"`]sk_live_[a-zA-Z0-9]{20,}[\'"`]', 'g'),
    message: 'Hardcoded Stripe secret key detected',
    suggestion:
      'Move Stripe secret key to environment variable: process.env.STRIPE_SECRET_KEY. Never commit production keys to source control.',
  },
  {
    regex: createPattern('[\'"`]pk_live_[a-zA-Z0-9]{20,}[\'"`]', 'g'),
    message: 'Hardcoded Stripe publishable key detected',
    suggestion:
      'Move Stripe publishable key to environment variable: process.env.STRIPE_PUBLISHABLE_KEY. Use separate keys for test/production environments.',
  },
  {
    regex: createPattern('[\'"`]rk_live_[a-zA-Z0-9]{20,}[\'"`]', 'g'),
    message: 'Hardcoded Stripe restricted key detected',
    suggestion:
      'Move Stripe restricted key to environment variable. Consider using Stripe Connect if exposing to third parties.',
  },
  // AWS keys - bounded alphanumeric character class
  {
    regex: createPattern('[\'"`]AKIA[A-Z0-9]{16}[\'"`]', 'g'),
    message: 'Hardcoded AWS access key detected',
    suggestion:
      'Remove AWS access key immediately and rotate it. Use IAM roles, environment variables, or AWS Secrets Manager instead of hardcoded credentials.',
  },
  // Generic API keys - use [\\w-] (word chars + hyphen) to avoid character class duplicates
  {
    regex: createPattern('(?:api[_-]?key|apikey)\\s*[:=]\\s*[\'"`][\\w-]{16,}[\'"`]', 'gi'),
    message: 'Hardcoded API key detected',
    suggestion:
      'Move API key to environment variable: process.env.API_KEY. For local development, use .env files (and add to .gitignore).',
  },
  // Passwords - uses [^'"`]* which is bounded by quote characters
  {
    regex: createPattern('(?:password|passwd|pwd)\\s*[:=]\\s*[\'"`][^\'"`]{8,}[\'"`]', 'gi'),
    message: 'Hardcoded password detected',
    suggestion:
      'Move password to environment variable or secrets manager. Never store passwords in source code. Consider using a password manager or vault service.',
  },
  // JWT secrets - uses [^'"`]* which is bounded by quote characters
  {
    regex: createPattern('(?:jwt[_-]?secret|jwt[_-]?key)\\s*[:=]\\s*[\'"`][^\'"`]{8,}[\'"`]', 'gi'),
    message: 'Hardcoded JWT secret detected',
    suggestion:
      'Move JWT secret to environment variable: process.env.JWT_SECRET. Generate a strong random secret (256+ bits) and rotate periodically.',
  },
  // Database connection strings with credentials - uses [^:]+ and [^@]+ which are bounded
  {
    regex: createPattern('(?:postgres|mysql|mongodb)://[^:]+:[^@]+@', 'gi'),
    message: 'Hardcoded database connection string with credentials detected',
    suggestion:
      'Use environment variables for database credentials: process.env.DATABASE_URL. Consider using IAM authentication or secrets manager for production.',
  },
  // Private keys (PEM format start) - fixed pattern, no variable repetition
  {
    regex: createPattern(String.raw`-----BEGIN\s+(?:RSA\s+)?PRIVATE\s+KEY-----`, 'g'),
    message: 'Hardcoded private key detected',
    suggestion:
      'Move private key to a secure file outside the repository or use a secrets manager. Never commit private keys to source control. If exposed, rotate immediately.',
  },
  // Bearer tokens - use [\\w-] (word chars + hyphen) to avoid character class duplicates
  {
    regex: createPattern('[\'"`]Bearer\\s+[\\w-]{20,}[\'"`]', 'g'),
    message: 'Hardcoded bearer token detected',
    suggestion:
      'Remove hardcoded bearer token. Tokens should be obtained at runtime through authentication flows, not stored in code.',
  },
]


/**
 * Check: security/no-hardcoded-secrets
 *
 * Detects hardcoded secrets, API keys, and credentials in source code.
 * Secrets should come from environment variables or secret management.
 */
export const noHardcodedSecrets = defineCheck({
  id: '68ba1265-9e9b-4a1c-9adc-73c68f470242',
  slug: 'no-hardcoded-secrets',
  scope: { languages: ['typescript'], concerns: ['backend', 'frontend', 'cli'] },
  contentFilter: 'strip-strings',
  confidence: 'medium',
  description: 'Detect hardcoded secrets, API keys, and credentials in source code',
  longDescription: `**Purpose:** Detects hardcoded secrets, API keys, and credentials in source code that should be stored in environment variables or a secrets manager.

**Detects:**
- Stripe keys: \`sk_live_\`, \`pk_live_\`, \`rk_live_\` prefixed strings
- AWS access keys: \`AKIA\` prefixed strings (16+ alphanumeric chars)
- Generic API keys: \`api_key\`/\`apikey\` assignments with 16+ character string values
- Hardcoded passwords: \`password\`/\`passwd\`/\`pwd\` assignments with 8+ character values
- JWT secrets: \`jwt_secret\`/\`jwt_key\` assignments with 8+ character values
- Database connection strings with embedded credentials: \`postgres://user:pass@host\`
- PEM private keys: \`-----BEGIN PRIVATE KEY-----\`
- Bearer tokens: \`Bearer \` followed by 20+ character token strings

**Why it matters:** Secrets committed to source control are permanently exposed in git history and can be harvested by attackers scanning repositories.

**Scope:** General best practice. Analyzes each file individually against the production preset.`,
  tags: ['security', 'secrets', 'credentials'],
  fileTypes: ['ts', 'tsx'],

  analyze(content: string, filePath: string): CheckViolation[] {
    return analyzeHardcodedSecrets(content, filePath)
  },
})

/**
 * Pure analysis function. Exported so unit tests can exercise the
 * detection logic without standing up the full Check framework.
 */
export function analyzeHardcodedSecrets(content: string, filePath: string): CheckViolation[] {
  logger.debug({
    evt: 'fitness.checks.no_hardcoded_secrets.analyze',
    msg: 'Analyzing file for hardcoded secrets and credentials',
  })
  const violations: CheckViolation[] = []
  const lines = content.split('\n')

  for (const [lineNum, line_] of lines.entries()) {
    const line = line_ ?? ''
    analyzeLine(line, lineNum + 1, filePath, violations)
  }

  return violations
}

function analyzeLine(
  line: string,
  lineNumber: number,
  filePath: string,
  violations: CheckViolation[],
): void {
  const trimmed = line.trim()
  if (trimmed.startsWith('//') || trimmed.startsWith('*')) return

  for (const pattern of SECRET_PATTERNS) {
    pattern.regex.lastIndex = 0
    const matched = pattern.regex.exec(line)
    if (!matched) continue
    if (isInsideRegexLiteral(line, matched.index)) continue
    if (lineHasRedactionPlaceholder(line)) continue
    violations.push({
      line: lineNumber,
      column: matched.index,
      message: pattern.message,
      severity: 'error',
      suggestion: pattern.suggestion,
      match: matched[0],
      filePath,
    })
  }
}

/**
 * Heuristic: is `pos` inside a regex literal on `line`? Walks the line
 * tracking unescaped `/` chars as regex-literal delimiters. A position
 * with an odd number of unescaped `/` chars to its left, and another
 * unescaped `/` after, is inside a literal.
 *
 * Heuristic — division operators and JSX can confuse it, but lines
 * with those tokens AND a secret-pattern match in the same line are
 * rare; the trade-off favors silencing the redaction-pattern FPs.
 */
function isInsideRegexLiteral(line: string, pos: number): boolean {
  // Count unescaped slashes before pos.
  let slashesBefore = 0
  for (let i = 0; i < pos; i++) {
    if (line[i] === '/' && line[i - 1] !== '\\') slashesBefore++
  }
  if (slashesBefore % 2 !== 1) return false
  // Check at least one unescaped slash follows.
  for (let i = pos; i < line.length; i++) {
    if (line[i] === '/' && line[i - 1] !== '\\') return true
  }
  return false
}

/**
 * True iff the LINE around a secret match contains a redaction-
 * placeholder marker. Many of the project-defined patterns only match
 * the HEADER (e.g. `-----BEGIN PRIVATE KEY-----`) but the surrounding
 * value is replaced with `***`, `[REDACTED]`, etc. Checking the line
 * (not just the matched span) catches those.
 *
 * Markers: `***`, `<REDACTED>`, `[REDACTED]`, runs of `X` (4+).
 */
function lineHasRedactionPlaceholder(line: string): boolean {
  return (
    line.includes('***') ||
    line.includes('[REDACTED]') ||
    line.includes('<REDACTED>') ||
    /X{4,}/.test(line)
  )
}
