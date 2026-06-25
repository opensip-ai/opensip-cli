// @fitness-ignore-file yagni-ignore-hygiene -- check references internal slugs that may differ from registered slugs
/**
 * @fileoverview Yagni ignore hygiene check
 */

import { defineCheck, type CheckViolation } from '@opensip-cli/fitness';

/** Regex to match @yagni-ignore directives */
const YAGNI_IGNORE_REGEX = /@yagni-ignore(?:-file|-next-line)?\s+(\S+)/g;

/** Valid detector slug format: kebab-case or yagni-prefixed */
const VALID_DETECTOR_PATTERN = /^(?:yagni:)?[a-z][a-z0-9-]*$/;

function analyzeIgnoreHygiene(content: string, _filePath: string): CheckViolation[] {
  const violations: CheckViolation[] = [];
  const lines = content.split('\n');

  let totalIgnoreDirectives = 0;

  for (const [i, line_] of lines.entries()) {
    const line = line_ ?? '';
    if (!line.trim().startsWith('//')) continue;

    YAGNI_IGNORE_REGEX.lastIndex = 0;
    const ignoreMatches = [...line.matchAll(YAGNI_IGNORE_REGEX)];
    for (const match of ignoreMatches) {
      totalIgnoreDirectives++;
      const detectorSlug = match[1];

      if (detectorSlug && !VALID_DETECTOR_PATTERN.test(detectorSlug)) {
        violations.push({
          line: i + 1,
          message: `@yagni-ignore references '${detectorSlug}' which is not a valid detector slug (expected kebab-case)`,
          severity: 'warning',
          suggestion:
            'Use a valid detector slug like "unused-config-surface" or "yagni:unused-config-surface"',
          type: 'invalid-ignore-slug',
          match: line.trim().slice(0, 120),
        });
      }

      const afterMatch = line.slice(match.index + match[0].length);
      const hasReason = afterMatch.includes('--');
      if (!hasReason) {
        violations.push({
          line: i + 1,
          message: `@yagni-ignore directive for '${detectorSlug ?? 'unknown'}' missing a reason comment`,
          severity: 'warning',
          suggestion: 'Add a reason: @yagni-ignore detector-slug -- Reason why this is suppressed',
          type: 'ignore-without-reason',
          match: line.trim().slice(0, 120),
        });
      }
    }
  }

  if (totalIgnoreDirectives > 7) {
    violations.push({
      line: 1,
      message: `File has ${totalIgnoreDirectives} @yagni-ignore directives — consider fixing the underlying issues instead of suppressing`,
      severity: 'warning',
      suggestion: 'Review each suppression to determine if the underlying issue can be fixed',
      type: 'excessive-ignores',
    });
  }

  return violations;
}

/**
 * Check: quality/yagni-ignore-hygiene
 *
 * Validates that @yagni-ignore directives have valid detector slugs and reason comments.
 */
export const yagniIgnoreHygiene = defineCheck({
  id: 'a8f3c2e1-5b4d-4a9f-9c1e-7d2f8e6a4b30',
  slug: 'yagni-ignore-hygiene',
  scope: {
    languages: ['typescript'],
    concerns: ['backend', 'frontend', 'cli'],
  },
  contentFilter: 'raw',
  description:
    'Validates that @yagni-ignore directives have valid detector slugs and reason comments',
  longDescription: `**Purpose:** Validates the quality of \`@yagni-ignore\` directives to prevent stale or undocumented suppressions.

**Detects:**
- Directives with invalid detector slugs (not kebab-case)
- Directives missing a reason comment (\`-- reason\`)
- Files with more than 7 ignore directives (suggests fixing underlying issues)

**Why it matters:** Undocumented suppressions accumulate over time and can mask real reduction opportunities when detector scopes change.

**Scope:** General TypeScript source. Analyzes each file individually via regex.`,
  tags: ['quality', 'yagni', 'hygiene'],
  fileTypes: ['ts'],
  confidence: 'medium',
  analyze: analyzeIgnoreHygiene,
});
