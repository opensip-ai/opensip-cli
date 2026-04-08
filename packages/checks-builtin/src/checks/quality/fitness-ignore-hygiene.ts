// @fitness-ignore-file fitness-ignore-hygiene -- check references internal slugs that may differ from registered slugs
/**
 * @fileoverview Fitness ignore hygiene check
 */

import { defineCheck, type CheckViolation } from '@opensip-tools/core'

/** Regex to match @fitness-ignore directives */
const FITNESS_IGNORE_REGEX = /@fitness-ignore(?:-file|-next-line)?\s+(\S+)/g

/** Valid check slug format: kebab-case */
const VALID_SLUG_PATTERN = /^[a-z][a-z0-9-]*$/

/**
 * Analyze @fitness-ignore directives for hygiene issues
 */
function analyzeIgnoreHygiene(content: string, _filePath: string): CheckViolation[] {
  const violations: CheckViolation[] = []
  const lines = content.split('\n')

  let totalIgnoreDirectives = 0

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? ''

    // Only check actual comment lines — skip string literals, code, and template literals
    // that happen to contain ignore-directive text (e.g., regex patterns, suggestion strings)
    if (!line.trim().startsWith('//')) continue

    FITNESS_IGNORE_REGEX.lastIndex = 0
    const ignoreMatches = [...line.matchAll(FITNESS_IGNORE_REGEX)]
    for (const match of ignoreMatches) {
      totalIgnoreDirectives++
      const checkSlug = match[1]

      // Validate check slug format
      if (checkSlug && !VALID_SLUG_PATTERN.test(checkSlug)) {
        violations.push({
          line: i + 1,
          message: `@fitness-ignore references '${checkSlug}' which is not a valid check slug (expected kebab-case)`,
          severity: 'warning',
          suggestion: 'Use a valid check slug like "no-generic-error" or "file-length-limits"',
          type: 'invalid-ignore-slug',
          match: line.trim().slice(0, 120),
        })
      }

      // Check for ignore directive without a reason comment
      // Expected format: @fitness-ignore slug -- reason
      const afterMatch = line.slice(match.index + match[0].length)
      const hasReason = afterMatch.includes('--')
      if (!hasReason) {
        violations.push({
          line: i + 1,
          message: `@fitness-ignore directive for '${checkSlug ?? 'unknown'}' missing a reason comment`,
          severity: 'warning',
          suggestion: 'Add a reason: @fitness-ignore check-slug -- Reason why this is suppressed',
          type: 'ignore-without-reason',
          match: line.trim().slice(0, 120),
        })
      }
    }
  }

  // Flag files with excessive ignore directives
  if (totalIgnoreDirectives > 7) {
    violations.push({
      line: 1,
      message: `File has ${totalIgnoreDirectives} @fitness-ignore directives — consider fixing the underlying issues instead of suppressing`,
      severity: 'warning',
      suggestion: 'Review each suppression to determine if the underlying issue can be fixed',
      type: 'excessive-ignores',
    })
  }

  return violations
}

/**
 * Check: quality/fitness-ignore-hygiene
 *
 * Validates that @fitness-ignore directives have valid check slugs and reason comments.
 */
export const fitnessIgnoreHygiene = defineCheck({
  id: '1d4028f6-6cd4-40b1-8b66-9846daa57e5a',
  slug: 'fitness-ignore-hygiene',
  scope: { languages: ['typescript'], concerns: ['fitness'] },
  contentFilter: 'raw',
  description:
    'Validates that @fitness-ignore directives have valid check slugs and reason comments',
  longDescription: `**Purpose:** Validates the quality of \`@fitness-ignore\` directives to prevent stale or undocumented suppressions.

**Detects:**
- Directives with invalid check slugs (not kebab-case)
- Directives missing a reason comment (\`-- reason\`)
- Files with more than 7 ignore directives (suggests fixing underlying issues)

**Why it matters:** Undocumented suppressions accumulate over time and can mask real issues when check scopes change.

**Scope:** All TypeScript files. Analyzes each file individually via regex.`,
  tags: ['quality', 'fitness', 'hygiene'],
  fileTypes: ['ts'],
  confidence: 'medium',
  analyze: analyzeIgnoreHygiene,
})
