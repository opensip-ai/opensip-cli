// @fitness-ignore-file graph-ignore-hygiene -- check references internal slugs that may differ from registered slugs
/**
 * @fileoverview Graph ignore hygiene check
 */

import { defineCheck, type CheckViolation } from '@opensip-tools/fitness';

/** Regex to match @graph-ignore directives */
const GRAPH_IGNORE_REGEX = /@graph-ignore(?:-file|-next-line)?\s+(\S+)/g;

/** Valid graph rule id format: graph-namespaced kebab-case (e.g. `graph:cycle`) */
const VALID_GRAPH_ID = /^graph:[a-z][a-z0-9-]*$/;

/**
 * Analyze @graph-ignore directives for hygiene issues
 */
function analyzeIgnoreHygiene(content: string, _filePath: string): CheckViolation[] {
  const violations: CheckViolation[] = [];
  const lines = content.split('\n');

  let totalIgnoreDirectives = 0;

  for (const [i, line_] of lines.entries()) {
    const line = line_ ?? '';

    // Only check actual comment lines — skip string literals, code, and template literals
    // that happen to contain ignore-directive text (e.g., regex patterns, suggestion strings)
    if (!line.trim().startsWith('//')) continue;

    GRAPH_IGNORE_REGEX.lastIndex = 0;
    const ignoreMatches = [...line.matchAll(GRAPH_IGNORE_REGEX)];
    for (const match of ignoreMatches) {
      totalIgnoreDirectives++;
      const ruleId = match[1];

      // Validate graph rule id format (graph:<kebab>)
      if (ruleId && !VALID_GRAPH_ID.test(ruleId)) {
        violations.push({
          line: i + 1,
          message: `@graph-ignore references '${ruleId}' which is not a valid graph rule id (expected \`graph:<kebab>\`)`,
          severity: 'warning',
          suggestion: 'Use a valid graph rule id like "graph:cycle" or "graph:large-function"',
          type: 'invalid-ignore-slug',
          match: line.trim().slice(0, 120),
        });
      }

      // Check for ignore directive without a reason comment
      // Expected format: @graph-ignore graph:<rule> -- reason
      const afterMatch = line.slice(match.index + match[0].length);
      const hasReason = afterMatch.includes('--');
      if (!hasReason) {
        violations.push({
          line: i + 1,
          message: `@graph-ignore directive for '${ruleId ?? 'unknown'}' missing a reason comment`,
          severity: 'warning',
          suggestion: 'Add a reason: @graph-ignore graph:rule-id -- Reason why this is suppressed',
          type: 'ignore-without-reason',
          match: line.trim().slice(0, 120),
        });
      }
    }
  }

  // Flag files with excessive ignore directives
  if (totalIgnoreDirectives > 7) {
    violations.push({
      line: 1,
      message: `File has ${totalIgnoreDirectives} @graph-ignore directives — consider fixing the underlying issues instead of suppressing`,
      severity: 'warning',
      suggestion: 'Review each suppression to determine if the underlying issue can be fixed',
      type: 'excessive-ignores',
    });
  }

  return violations;
}

/**
 * Check: quality/graph-ignore-hygiene
 *
 * Validates that @graph-ignore directives have valid graph rule ids and reason comments.
 */
export const graphIgnoreHygiene = defineCheck({
  id: 'c39f899d-acba-40fd-af5c-299b3462c277',
  slug: 'graph-ignore-hygiene',
  // Broad TS source scope: @graph-ignore can appear in any production source
  // the graph tool analyzes, so this is NOT scoped to `concerns: ['fitness']`.
  scope: { languages: ['typescript'], concerns: ['backend', 'frontend', 'cli'] },
  contentFilter: 'raw',
  description:
    'Validates that @graph-ignore directives have valid graph rule ids and reason comments',
  longDescription: `**Purpose:** Validates the quality of \`@graph-ignore\` directives to prevent stale or undocumented suppressions.

**Detects:**
- Directives with invalid graph rule ids (not \`graph:<kebab>\`)
- Directives missing a reason comment (\`-- reason\`)
- Files with more than 7 ignore directives (suggests fixing underlying issues)

**Why it matters:** Undocumented suppressions accumulate over time and can mask real issues when graph rules change.

**Scope:** General TypeScript source. Analyzes each file individually via regex.`,
  tags: ['quality', 'graph', 'hygiene'],
  fileTypes: ['ts'],
  confidence: 'medium',
  analyze: analyzeIgnoreHygiene,
});
