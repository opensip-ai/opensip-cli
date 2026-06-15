/**
 * @fileoverview Advisory meta-check for content filter usage
 *
 * Detects fitness checks that use regex pattern matching on file content
 * without declaring contentFilter: 'strip-strings', which may lead to
 * false positives from string literal and comment content.
 */

import { defineCheck, type CheckViolation } from '@opensip-cli/fitness';

const REGEX_USAGE_PATTERN = /\.(test|match|exec|search)\s*\(/;
const CONTENT_FILTER_PATTERN =
  /contentFilter\s*:\s*['"](raw|strip-strings|strip-strings-and-comments)['"]/;
const DEFINE_CHECK_PATTERN = /defineCheck\s*\(/;

export const noRawRegexOnCode = defineCheck({
  id: '7a0f6bc1-f4dd-4e55-9628-d797c877c6e0',
  slug: 'no-raw-regex-on-code',
  scope: { languages: ['typescript'], concerns: ['fitness'] },

  confidence: 'medium',
  description: 'Detect regex checks that should use contentFilter: strip-strings',
  longDescription: `**Purpose:** Advisory meta-check that identifies fitness checks using regex pattern matching without declaring \`contentFilter: 'strip-strings'\`. Such checks may produce false positives when patterns match inside string literals or comments.

**Detects:**
- Check files that call \`.test()\`, \`.match()\`, \`.exec()\`, or \`.search()\` on content
- That do NOT declare \`contentFilter: 'strip-strings'\` or \`contentFilter: 'raw'\`

**Why it matters:** Regex checks without content filtering match patterns inside string literals and documentation, producing false positives. Adding \`contentFilter: 'strip-strings'\` to the check config eliminates this class of false positives.

**Scope:** Fitness check files only.`,
  tags: ['quality', 'internal', 'meta', 'content-filter'],
  fileTypes: ['ts'],

  analyze(content, filePath): CheckViolation[] {
    // Only analyze fitness check files
    if (!filePath.includes('fitness/src/checks/')) return [];

    // Must be a defineCheck file
    if (!DEFINE_CHECK_PATTERN.test(content)) return [];

    // Check if it uses regex methods
    if (!REGEX_USAGE_PATTERN.test(content)) return [];

    // Check if contentFilter is already declared (either value)
    if (CONTENT_FILTER_PATTERN.test(content)) return [];

    // Find the line with defineCheck to report the violation
    const lines = content.split('\n');
    for (const [i, line] of lines.entries()) {
      if (line && DEFINE_CHECK_PATTERN.test(line)) {
        return [
          {
            line: i + 1,
            column: 0,
            message: 'Check uses regex pattern matching without contentFilter declaration',
            severity: 'warning',
            type: 'missing-content-filter',
            suggestion:
              "Add contentFilter: 'strip-strings' to skip string literals, or contentFilter: 'raw' to explicitly opt out (e.g., for secret detection checks).",
          },
        ];
      }
    }

    return [];
  },
});
