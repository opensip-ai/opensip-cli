// @fitness-ignore-file duplicate-implementation-detection -- similar patterns across diagnostic modules
// @fitness-ignore-file no-todo-comments -- JSDoc uses XXX as a placeholder token in example env-var names
/**
 * @fileoverview Validate API key handling supports rotation
 */

import { logger } from '@opensip-tools/core/logger'
import { defineCheck, type CheckViolation } from '@opensip-tools/fitness'
import { stripStringLiterals, stripStringsAndComments } from '@opensip-tools/fitness'

/**
 * Checks if text contains a single API key equality comparison
 * Pattern: === or !== followed by process.env.API_KEY (without rotation suffixes)
 */
function matchesSingleKeyEquality(text: string): RegExpExecArray | null {
  logger.debug({
    evt: 'fitness.checks.api_key_rotation.match_single_key_equality',
    msg: 'Checking for single key equality comparison',
  })
  // Match comparison operators followed by process.env key access
  // Exclude keys with rotation suffixes (CURRENT, PREVIOUS, PRIMARY, SECONDARY)
  const match = /(?:===|!==|==|!=)\s*process\.env\.(API_?KEY|SECRET_?KEY|AUTH_?KEY)(\w*)/i.exec(
    text,
  )
  if (!match) return null
  const suffix = match[2] ?? ''
  const rotationSuffixes = ['CURRENT', 'PREVIOUS', 'PRIMARY', 'SECONDARY']
  if (rotationSuffixes.some((s) => suffix.toUpperCase().includes(s))) {
    return null
  }
  return match
}

/**
 * Checks if text contains a single API key assignment
 * Pattern: const API_KEY = process.env.SOMETHING (not followed by function call)
 */
function matchesSingleKeyAssignment(text: string): RegExpExecArray | null {
  logger.debug({
    evt: 'fitness.checks.api_key_rotation.match_single_key_assignment',
    msg: 'Checking for single key assignment pattern',
  })
  // Match const declaration with API key name
  const match = /const\s+(API_?KEY|SECRET_?KEY|AUTH_?KEY)\s*=\s*process\.env\.(\w+)/i.exec(text)
  if (!match) return null
  // Check if followed by function call (indicates wrapped/processed key)
  const matchIndex = match.index
  const afterMatch = text.slice(matchIndex + match[0].length)
  if (/^\s*\(/.test(afterMatch)) {
    return null
  }
  return match
}

// Patterns that indicate single-key validation (no rotation support)
const SINGLE_KEY_PATTERNS = [
  // Direct equality check with single env var
  {
    match: matchesSingleKeyEquality,
    message:
      'Single API key validation detected - consider supporting key rotation with current/previous keys',
    suggestion:
      'Store multiple API keys (current + previous) in environment variables and validate against both during rotation periods. Use API_KEY_CURRENT and API_KEY_PREVIOUS pattern.',
    severity: 'warning' as const,
  },
  // Single key assignment (not array)
  {
    match: matchesSingleKeyAssignment,
    message: 'Single API key configuration - consider supporting multiple keys for rotation',
    suggestion:
      'Load keys as an array: const VALID_KEYS = [process.env.API_KEY_CURRENT, process.env.API_KEY_PREVIOUS].filter(Boolean). Then use validKeys.includes(providedKey) for validation.',
    severity: 'warning' as const,
  },
]

// Keywords that indicate rotation support is already implemented
const ROTATION_SUPPORT_KEYWORDS = [
  'api_key_current',
  'api_key_previous',
  'api_key_primary',
  'api_key_secondary',
  'apikey_current',
  'apikey_previous',
  'apikey_primary',
  'apikey_secondary',
  'validkeys.includes',
  'keys.some',
  'keys.find',
]

/**
 * Check if content already has rotation support indicators
 */
function hasRotationSupport(content: string): boolean {
  logger.debug({
    evt: 'fitness.checks.api_key_rotation.has_rotation_support',
    msg: 'Checking if content has rotation support indicators',
  })
  const lowerContent = content.toLowerCase()
  return ROTATION_SUPPORT_KEYWORDS.some((kw) => lowerContent.includes(kw))
}

/**
 * Check if content contains API key related references
 */
function containsApiKeyReferences(content: string): boolean {
  logger.debug({
    evt: 'fitness.checks.api_key_rotation.contains_api_key_references',
    msg: 'Checking if content contains API key references',
  })
  const stripped = stripStringsAndComments(content).toLowerCase()
  const hasApiKeyTerms =
    stripped.includes('api_key') ||
    stripped.includes('apikey') ||
    stripped.includes('api-key')
  const hasSecretKeyTerms =
    stripped.includes('secret_key') ||
    stripped.includes('secretkey') ||
    stripped.includes('secret-key')
  const hasAuthKeyTerms =
    stripped.includes('auth_key') ||
    stripped.includes('authkey') ||
    stripped.includes('auth-key')
  return hasApiKeyTerms || hasSecretKeyTerms || hasAuthKeyTerms
}

/**
 * Determine if a file should be processed for API key rotation checks
 */
function shouldProcessFile(filePath: string, content: string): boolean {
  logger.debug({
    evt: 'fitness.checks.api_key_rotation.should_process_file',
    msg: 'Determining if file should be processed for API key rotation checks',
  })
  // Only check files that deal with API keys
  if (!containsApiKeyReferences(content)) {
    return false
  }
  // Skip if file already has rotation patterns
  if (hasRotationSupport(content)) {
    return false
  }
  return true
}

/**
 * Check: security/api-key-rotation
 *
 * Validates that API key handling supports key rotation.
 */
export const apiKeyRotation = defineCheck({
  id: '32f69a85-7a07-4f60-88dd-cc4a0982c1b4',
  slug: 'api-key-rotation',
  scope: { languages: ['typescript'], concerns: ['backend', 'server'] },
  contentFilter: 'strip-strings',

  confidence: 'medium',
  description: 'Validate API key handling supports rotation',
  longDescription: `**Purpose:** Ensures API key validation logic supports key rotation rather than relying on a single static key.

**Detects:**
- Single-key equality comparisons: \`=== process.env.API_KEY\` / \`SECRET_KEY\` / \`AUTH_KEY\` without rotation suffixes (CURRENT/PREVIOUS/PRIMARY/SECONDARY)
- Single-key assignments: \`const API_KEY = process.env.SOMETHING\` not followed by a processing function call

**Why it matters:** Without rotation support, key changes cause downtime because old keys stop working immediately. Supporting current + previous keys allows zero-downtime rotation.

**Scope:** General best practice. Analyzes each file individually.`,
  tags: ['security', 'api-keys', 'rotation'],
  fileTypes: ['ts'],

  analyze(content: string, filePath: string): CheckViolation[] {
    logger.debug({
      evt: 'fitness.checks.api_key_rotation.analyze',
      msg: 'Analyzing file for API key rotation support',
    })
    if (!shouldProcessFile(filePath, content)) {
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

      const strippedLine = stripStringLiterals(line)
      for (const pattern of SINGLE_KEY_PATTERNS) {
        const match = pattern.match(strippedLine)
        if (match) {
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
