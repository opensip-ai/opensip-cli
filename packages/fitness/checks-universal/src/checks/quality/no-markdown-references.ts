// @fitness-ignore-file unused-config-options -- Config options reserved for future use or environment-specific
// @fitness-ignore-file no-markdown-references -- Check's own JSDoc contains example .md references to document what it detects
/**
 * @fileoverview Detect markdown file references in code comments
 *
 * File path references to markdown documents become stale when documents are
 * moved, renamed, or deleted. Use stable identifiers instead.
 */

import { defineCheck, type CheckViolation } from '@opensip-cli/fitness';

/**
 * Pattern to match .md file references in comments
 * Matches patterns like:
 *   - docs/adr/052-something.md
 *   - ./README.md
 *   - ../docs/guide.md
 *   - CHANGELOG.md
 */
const MARKDOWN_REFERENCE_PATTERN = /(?:^|[\s(])([./\w-]+\.md)(?:[\s)]|$)/g;

/**
 * Pattern to detect if a line is likely a comment (not a template literal)
 */
const COMMENT_PATTERNS = [
  /^\s*\/\//, // Single-line comment
  /^\s*\/\*/, // Multi-line comment start (/**)
  /^\s*\*(?!\*)/, // JSDoc continuation (* text) but NOT markdown bold (**text**)
];

/**
 * Files/patterns to exclude from this check
 */
const EXCLUDED_PATTERNS = [
  /\.md$/, // Don't check markdown files themselves
  /CHANGELOG/, // Changelog files often reference other changelogs
  /README/, // README files reference other docs
  /__tests__/, // Test files may legitimately reference test fixtures
  /\.test\.ts$/, // Test files
  /\.spec\.ts$/, // Spec files
];

/**
 * Well-known markdown file names that are stable references (not stale paths).
 * These are root-level or conventionally-named files that don't become stale.
 */
const STABLE_REFERENCE_PATTERNS = [
  /^CLAUDE\.md$/i, // Project-level AI guidance file
  /^README\.md$/i, // Standard readme files
  /^CHANGELOG\.md$/i, // Standard changelog files
  /^CONTRIBUTING\.md$/i, // Contribution guidelines
  /^LICENSE\.md$/i, // License file
  /^CODE_OF_CONDUCT\.md$/i, // Code of conduct
  /^SECURITY\.md$/i, // Security policy
];

/**
 * Check if a line is a comment line
 */
function isCommentLine(line: string): boolean {
  return COMMENT_PATTERNS.some((pattern) => pattern.test(line));
}

/**
 * Check if a file should be excluded
 */
function shouldExcludeFile(filePath: string): boolean {
  return EXCLUDED_PATTERNS.some((pattern) => pattern.test(filePath));
}

/**
 * Find markdown references in a file
 */
function findMarkdownReferences(
  content: string,
): { lineNumber: number; line: string; reference: string }[] {
  const references: { lineNumber: number; line: string; reference: string }[] = [];
  const lines = content.split('\n');

  for (const [i, line] of lines.entries()) {
    /* v8 ignore next -- defensive: lines.entries() never yields undefined */
    if (line === undefined) continue;

    // Only check comment lines
    if (!isCommentLine(line)) continue;

    // Find all .md references in this line
    let match;
    MARKDOWN_REFERENCE_PATTERN.lastIndex = 0; // Reset regex state
    while ((match = MARKDOWN_REFERENCE_PATTERN.exec(line)) !== null) {
      const reference = match[1];

      // Skip if it's just mentioning the file extension generically or undefined
      if (!reference || reference === '.md') continue;

      // Skip well-known stable markdown file names (e.g., CLAUDE.md, README.md)
      /* v8 ignore next -- defensive: split + pop on a non-empty string never returns undefined */
      const basename = reference.split('/').pop() ?? reference;
      if (STABLE_REFERENCE_PATTERNS.some((pattern) => pattern.test(basename))) continue;

      references.push({
        lineNumber: i + 1,
        line,
        reference,
      });
    }
  }

  return references;
}

/**
 * Check: quality/no-markdown-references
 *
 * Detects markdown file path references in code comments. These references
 * become stale when documents are moved, renamed, or deleted.
 *
 * Use stable identifiers instead of file paths to avoid stale references.
 */
export const noMarkdownReferences = defineCheck({
  id: '8be86917-6908-49e5-a185-a6bd18045b31',
  slug: 'no-markdown-references',
  scope: {
    languages: ['typescript'],
    concerns: ['backend', 'frontend', 'cli'],
  },
  contentFilter: 'raw',

  confidence: 'medium',
  description: 'Detect markdown file references in code comments that may become stale',
  longDescription: `**Purpose:** Detects markdown file path references in code comments that become stale when documents are moved, renamed, or deleted.

**Detects:**
- References matching \`[./\\w-]+\\.md\` in comment lines (single-line \`//\`, multi-line \`/* */\`, and JSDoc \`/** */\`)
- Examples: \`docs/adr/052-something.md\`, \`./README.md\`, \`../docs/guide.md\`, \`CHANGELOG.md\`

**Why it matters:** File path references silently break when documents are reorganized. Stable identifiers (e.g., document titles or IDs) remain valid regardless of file location.

**Scope:** General best practice. Analyzes each file individually (\`analyze\`). Targets production files, excluding markdown, test, and changelog files.`,
  tags: ['documentation', 'maintainability', 'quality'],
  fileTypes: ['ts', 'tsx'],

  analyze(content, filePath): CheckViolation[] {
    // Skip excluded files
    if (shouldExcludeFile(filePath)) {
      return [];
    }

    const violations: CheckViolation[] = [];
    const references = findMarkdownReferences(content);

    for (const { lineNumber, reference } of references) {
      const suggestion = `Remove or replace the markdown file reference '${reference}'. Use stable identifiers (e.g., document titles or IDs) instead of file paths that break when documents are moved.`;

      violations.push({
        line: lineNumber,
        column: 0,
        message: `Markdown file reference '${reference}' may become stale`,
        severity: 'warning',
        suggestion,
        match: reference,
      });
    }

    return violations;
  },
});
