// @fitness-ignore-file env-secret-exposure -- Fitness check definition references process.env patterns in longDescription, not actual secret exposure
// @fitness-ignore-file logging-standards -- Suggestion strings contain logger call examples that match the logging-standards pattern
// @fitness-ignore-file duplicate-implementation-detection -- similar patterns across diagnostic modules
// @fitness-ignore-file fitness-ignore-validation -- Fitness-ignore directives reference internal check IDs that may not be statically resolvable
/**
 * @fileoverview Detect secrets exposed through env vars in logs/errors
 */

import { logger } from '@opensip-tools/core/logger'
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

// Patterns that indicate potential secret exposure
// Note: These regex patterns operate on trusted source code files, not user input.
// The patterns use bounded character classes (e.g., [^)], [^;], [^`]) to prevent ReDoS.
const EXPOSURE_PATTERNS = [
  // Logging all env vars - uses [^)]* which is bounded by closing paren
  {
    regex: createPattern(
      String.raw`(?:logger|console|log)\.\w+\s*\([^)]*process\.env(?!\.\w+)[^)]*\)`,
      'g',
    ),
    message: 'Logging entire process.env exposes all secrets',
    suggestion:
      'Never log the entire process.env object. Log specific, non-sensitive values individually: logger.info({ nodeEnv: process.env.NODE_ENV }).',
    severity: 'error' as const,
  },
  // Env vars in error messages with interpolation - uses [^;]* which is bounded by semicolon
  {
    regex: createPattern(
      String.raw`(?:Error|throw)[^;]*process\.env\.\w*(?:SECRET|KEY|PASSWORD|TOKEN|CREDENTIAL)`,
      'gi',
    ),
    message: 'Sensitive environment variable in error message may expose secrets',
    suggestion:
      'Do not include secret values in error messages. Log only that the secret was missing or invalid, not its value: throw new Error("API key validation failed");',
    severity: 'error' as const,
  },
  // Stringifying env vars (JSON.stringify(process.env)) - fixed pattern, no variable repetition
  {
    regex: createPattern(String.raw`JSON\.stringify\s*\(\s*process\.env\s*\)`, 'g'),
    message: 'JSON.stringify(process.env) exposes all secrets',
    suggestion:
      'Select specific non-sensitive env vars to stringify: JSON.stringify({ NODE_ENV: process.env.NODE_ENV, PORT: process.env.PORT }).',
    severity: 'error' as const,
  },
  // Spreading env into object that might be logged - fixed pattern
  {
    regex: createPattern(String.raw`\{\s*\.\.\.process\.env`, 'g'),
    message: 'Spreading process.env may expose secrets if object is logged',
    suggestion:
      'Explicitly pick non-sensitive values instead of spreading: { NODE_ENV: process.env.NODE_ENV, PORT: process.env.PORT }.',
    severity: 'warning' as const,
  },
  // Template literal with secret env var - uses [^`]* which is bounded by backtick
  {
    regex: createPattern(
      '`[^`]*\\$\\{process\\.env\\.\\w*(?:SECRET|KEY|PASSWORD|TOKEN|CREDENTIAL)[^`]*`',
      'gi',
    ),
    message: 'Sensitive environment variable in template literal may be exposed',
    suggestion:
      'Do not interpolate secret values into strings that may be logged or displayed. Use the value directly for authentication without exposing it.',
    severity: 'warning' as const,
  },
]

/**
 * Check: security/env-secret-exposure
 *
 * Detects secrets that might be exposed through environment variables
 * in logs or error messages.
 */
export const envSecretExposure = defineCheck({
  id: '6833b667-cc72-465d-9f1e-2b6b6060faef',
  slug: 'env-secret-exposure',
  scope: { languages: ['json', 'typescript', 'yaml'], concerns: ['config'] },
  description: 'Detect secrets exposed through environment variables in logs or errors',
  longDescription: `**Purpose:** Detects patterns where sensitive environment variables may be inadvertently exposed through logging, error messages, or serialization.

**Detects:**
- Logging entire \`process.env\` object: \`logger.info(process.env)\`
- Sensitive env vars (SECRET, KEY, PASSWORD, TOKEN, CREDENTIAL) in error/throw statements
- \`JSON.stringify(process.env)\` which serializes all secrets
- Spreading \`{ ...process.env }\` into objects that may be logged
- Template literals interpolating sensitive env vars: \`\${process.env.SECRET_KEY}\`

**Why it matters:** Leaked secrets in logs or error reports can be harvested from log aggregators, monitoring dashboards, or error tracking services, leading to credential compromise.

**Scope:** General best practice. Analyzes each file individually.`,
  tags: ['security', 'secrets', 'logging', 'errors'],
  fileTypes: ['ts'],
  contentFilter: 'strip-strings',
  confidence: 'medium',

  analyze(content: string, filePath: string): CheckViolation[] {
    logger.debug({
      evt: 'fitness.checks.env_secret_exposure.analyze',
      msg: 'Analyzing file for environment secret exposure',
    })
    const violations: CheckViolation[] = []
    const lines = content.split('\n')

    for (const [lineNum, line_] of lines.entries()) {
      const line = line_ ?? ''

      // Skip comments
      const trimmed = line.trim()
      if (trimmed.startsWith('//') || trimmed.startsWith('*')) {
        continue
      }

      for (const pattern of EXPOSURE_PATTERNS) {
        // Reset regex state
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
            filePath,
          })
        }
      }
    }

    return violations
  },
})
