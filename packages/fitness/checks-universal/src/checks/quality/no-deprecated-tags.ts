/**
 * @fileoverview Detects `@deprecated` JSDoc tags in production code.
 *
 * Once a symbol is marked deprecated, the deprecated implementation
 * should be removed in the same PR — leaving it behind keeps two
 * paths alive and accumulates tech debt.
 *
 * Extracted from the former `no-legacy-code` umbrella in Phase C4.
 */

import { defineCheck, type CheckViolation } from '@opensip-cli/fitness';

const EXCLUDE_PATTERNS = [
  /fitness/,
  /test/,
  /spec/,
  /docs/,
  /reports/,
  // Schema-migration utilities legitimately mark superseded versions
  /versioning/,
];

function shouldExcludeFile(relativePath: string): boolean {
  return EXCLUDE_PATTERNS.some((pattern) => pattern.test(relativePath));
}

/**
 * Detects JSDoc `@deprecated` tag lines. Uses string operations to
 * avoid regex complexity and ReDoS.
 */
function isDeprecatedJsdocLine(line: string): boolean {
  const trimmed = line.trim();
  const normalized = trimmed.startsWith('*') ? trimmed.slice(1).trim() : trimmed;
  // Defensive concatenation — avoids accidental self-detection in this file's source.
  const marker = '@' + 'deprecated';
  return normalized.toLowerCase().startsWith(marker);
}

export const noDeprecatedTags = defineCheck({
  id: '3a27c17d-a926-46a8-864d-610de1a385eb',
  slug: 'no-deprecated-tags',
  scope: { languages: ['typescript'], concerns: ['backend', 'frontend', 'cli'] },
  contentFilter: 'raw',
  confidence: 'medium',
  description: 'Detects @deprecated JSDoc tags in production code',
  longDescription: `**Purpose:** Surfaces \`@deprecated\` JSDoc tags so the deprecated implementation can be removed and call sites updated in the same PR.

**Detects:**
- JSDoc lines whose first non-asterisk word is \`@deprecated\` (case-insensitive)

**Why it matters:** Deprecation tags accumulate when the deprecated path stays alive. The fitness rule treats every tag as a follow-up to schedule, not a permanent annotation.

**Scope:** General best practice. Analyzes each file individually; excludes test/docs/versioning paths.`,
  tags: ['code-quality', 'compliance', 'quality'],
  fileTypes: ['ts', 'tsx'],

  analyze(content, filePath): CheckViolation[] {
    if (shouldExcludeFile(filePath)) return [];
    if (!content.toLowerCase().includes('deprecated')) return [];

    const violations: CheckViolation[] = [];
    const lines = content.split('\n');

    for (const [i, line] of lines.entries()) {
      if (!line) continue;
      if (isDeprecatedJsdocLine(line)) {
        violations.push({
          line: i + 1,
          column: 0,
          message:
            'Found @deprecated JSDoc tag - remove this deprecated code and update all callers in the same PR',
          severity: 'error',
          type: 'deprecated-tag',
          suggestion:
            'Remove the deprecated code entirely and update all call sites in the same PR',
          match: line.trim(),
        });
      }
    }

    return violations;
  },
});
