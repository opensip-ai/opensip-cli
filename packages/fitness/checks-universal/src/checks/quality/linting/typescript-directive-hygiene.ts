/**
 * @fileoverview TypeScript Directive Hygiene Check
 *
 * Validates TypeScript suppression directives (@ts-expect-error, @ts-ignore) have proper justifications.
 */

import { defineCheck, type CheckViolation } from '@opensip-tools/fitness'

/** Check ID constant to avoid duplicate string literals */
const CHECK_SLUG = 'typescript-directive-hygiene'
const CHECK_ID = 'e7007f81-f00c-4a2e-99a2-fc8a2193f658'

/**
 * Regex to match TypeScript directive comments.
 * Uses character class for whitespace to prevent ReDoS (no backtracking on \s*).
 * Pattern: // followed by optional spaces/tabs, then directive, then rest of line
 */
const TS_DIRECTIVE_REGEX = /\/\/[ \t]*(@ts-expect-error|@ts-ignore)([^\n]*)$/

const GENERIC_JUSTIFICATIONS = [
  /^$/,
  /^[ \t]*$/,
  /^todo$/i,
  /^fix[ \t]*(?:this|later|me)?$/i,
  /^temporary$/i,
  /^temp$/i,
  /^wip$/i,
  /^ignore$/i,
  /^skip$/i,
  /^hack$/i,
  /^workaround$/i,
]

const MIN_JUSTIFICATION_LENGTH = 10

/**
 * Extract justification from the text after a TypeScript directive
 */
function extractJustification(afterDirective: string): string | null {
  const trimmed = afterDirective.trim()

  // Check for -- separator (non-greedy, use string operations)
  if (trimmed.startsWith('--')) {
    const rest = trimmed.slice(2).trim()
    return rest || null
  }

  // Check for - separator (must have space after dash)
  if (trimmed.startsWith('- ')) {
    const rest = trimmed.slice(2).trim()
    return rest || null
  }

  // Check for : separator
  if (trimmed.startsWith(':')) {
    const rest = trimmed.slice(1).trim()
    return rest || null
  }

  // Accept substantial text without separator
  if (trimmed.length >= MIN_JUSTIFICATION_LENGTH) return trimmed

  return null
}

/**
 * Check if a justification is too generic
 */
function isGeneric(justification: string): boolean {
  const trimmed = justification.trim()
  if (trimmed.length < MIN_JUSTIFICATION_LENGTH) return true
  return GENERIC_JUSTIFICATIONS.some((p) => p.test(trimmed))
}

/**
 * Check: quality/typescript-directive-hygiene
 *
 * Ensures @ts-expect-error and @ts-ignore have proper justifications.
 */
export const typescriptDirectiveHygiene = defineCheck({
  id: CHECK_ID,
  slug: CHECK_SLUG,
  scope: { languages: ['typescript'], concerns: ['backend', 'frontend', 'cli'] },
  contentFilter: 'raw',

  confidence: 'medium',
  description: 'Ensures TypeScript directives have proper justifications',
  longDescription: `**Purpose:** Enforces that every \`@ts-expect-error\` and \`@ts-ignore\` directive includes a meaningful justification and prefers \`@ts-expect-error\` over \`@ts-ignore\`.

**Detects:**
- Missing justifications on \`@ts-expect-error\` and \`@ts-ignore\` directives (no \`--\`, \`-\`, or \`:\` separator with reason)
- Generic justifications matching patterns like \`todo\`, \`fix later\`, \`temp\`, \`hack\`, \`workaround\`, etc., or text shorter than 10 characters
- Usage of \`@ts-ignore\` where \`@ts-expect-error\` should be used instead (warns about stale suppression risk)

**Why it matters:** Unjustified type suppressions hide real type errors and accumulate as technical debt. Using \`@ts-expect-error\` over \`@ts-ignore\` ensures suppressions are automatically flagged when the underlying issue is fixed.

**Scope:** Analyzes each file individually (excludes test files: \`**/__tests__/**\`, \`**/*.test.*\`, \`**/*.spec.*\`). General best practice.`,
  tags: ['quality', 'code-quality', 'documentation'],
  fileTypes: ['ts'],

  analyze: (content: string, filePath: string): CheckViolation[] => {
    const violations: CheckViolation[] = []

    // Quick filter - skip files without directives
    if (!content.includes('@ts-expect-error') && !content.includes('@ts-ignore')) {
      return violations
    }

    const lines = content.split('\n')

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i] ?? ''
      const match = TS_DIRECTIVE_REGEX.exec(line)
      if (!match) continue

      const directive = match[1] as '@ts-expect-error' | '@ts-ignore'
      const afterDirective = match[2] ?? ''
      const justification = extractJustification(afterDirective)

      const lineNum = i + 1

      if (!justification) {
        violations.push({
          filePath,
          line: lineNum,
          message: `${directive} missing justification`,
          severity: 'error',
          suggestion: `Add a justification after the directive: ${directive} -- Reason why this suppression is needed`,
          match: directive,
        })
      } else if (isGeneric(justification)) {
        violations.push({
          filePath,
          line: lineNum,
          message: `${directive} has generic justification: "${justification}"`,
          severity: 'warning',
          suggestion: `Replace generic justification with a specific explanation. Minimum ${MIN_JUSTIFICATION_LENGTH} characters describing WHY the suppression is needed`,
          match: justification,
        })
      } else if (directive === '@ts-ignore') {
        violations.push({
          filePath,
          line: lineNum,
          message: `Use @ts-expect-error instead of @ts-ignore`,
          severity: 'warning',
          suggestion:
            'Replace @ts-ignore with @ts-expect-error. The latter will error if the suppressed issue is fixed, preventing stale suppressions',
          match: directive,
        })
      }
    }

    return violations
  },
})
