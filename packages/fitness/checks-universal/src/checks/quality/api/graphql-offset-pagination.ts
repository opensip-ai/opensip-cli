// @fitness-ignore-file correlation-id-coverage -- Fitness check analysis function; no network operations requiring correlation
/**
 * @fileoverview Detect offset-based pagination in GraphQL queries
 *
 * Offset pagination produces unstable results when data changes between page
 * fetches (the "shifting page" problem). Cursor-based pagination (keyset via
 * where clause) provides stable results.
 */

import { defineCheck, type CheckViolation } from '@opensip-cli/fitness';

const OFFSET_VAR_PATTERN = /\$offset\s*:\s*Int/;

export const graphqlOffsetPagination = defineCheck({
  id: '0ef4c33d-48e6-4bb1-871b-6ac7c1b579e9',
  slug: 'graphql-offset-pagination',
  disabled: true,
  scope: { languages: ['typescript'], concerns: ['backend', 'server'] },
  contentFilter: 'strip-strings',

  confidence: 'medium',
  description: 'Detect $offset variables in GraphQL queries that indicate offset-based pagination',
  longDescription: `**Purpose:** Flags GraphQL queries that use offset-based pagination, which produces unstable results when data changes between page fetches.

**Detects:**
- \`$offset: Int\` variable declarations (matched by \`/\\$offset\\s*:\\s*Int/\`) inside \`gql\\\`\` template literals

**Why it matters:** Offset pagination causes the "shifting page" problem where inserts or deletes between fetches cause items to be skipped or duplicated. Cursor-based (keyset) pagination provides stable results.

**Scope:** General best practice. Analyzes each file individually using line-by-line text scanning within \`gql\\\`\` template boundaries.`,
  tags: ['quality', 'graphql', 'pagination', 'api'],
  fileTypes: ['ts'],

  analyze(content: string, filePath: string): CheckViolation[] {
    const violations: CheckViolation[] = [];
    const lines = content.split('\n');

    let inTemplate = false;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i] ?? '';

      if (line.includes('gql`') || line.includes('gql `')) {
        inTemplate = true;
      }

      if (!inTemplate && line.includes('= `')) {
        const nextLines = lines.slice(i, Math.min(i + 3, lines.length)).join('\n');
        if (/(?:query|mutation|subscription)\s+\w+/.test(nextLines)) {
          inTemplate = true;
        }
      }

      if (inTemplate && OFFSET_VAR_PATTERN.test(line)) {
        violations.push({
          filePath,
          line: i + 1,
          severity: 'error',
          message: 'GraphQL query uses offset-based pagination ($offset: Int).',
          suggestion:
            'Use cursor-based pagination (keyset via where clause) instead of offset for stable results during data changes.',
        });
      }

      if (
        inTemplate &&
        line.trimEnd().endsWith('`') &&
        !line.includes('gql`') &&
        !line.includes('= `')
      ) {
        inTemplate = false;
      }
    }

    return violations;
  },
});
