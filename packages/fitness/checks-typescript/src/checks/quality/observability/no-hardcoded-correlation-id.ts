/**
 * @fileoverview Detects hardcoded correlation ID values
 */

import { defineCheck, isTestFile, type CheckViolation } from '@opensip-cli/fitness';
import { countUnescapedBackticks } from '@opensip-cli/lang-typescript';

/**
 * Pattern for detecting hardcoded correlationId string literal assignments.
 * Matches: correlationId: 'something' or correlationId: "something"
 * Only matches single/double quotes, not backtick template literals.
 */
const HARDCODED_CORR_ID_PATTERN = /correlationId\s{0,5}:\s{0,5}['"]([a-zA-Z0-9_-]{1,100})['"]/g;

function findHardcodedCorrelationIds(content: string, filePath: string): CheckViolation[] {
  const violations: CheckViolation[] = [];
  const lines = content.split('\n');
  let inTemplateLiteral = false;

  for (const [i, line] of lines.entries()) {
    /* v8 ignore next -- defensive guard */
    if (!line) continue;

    const backtickCount = countUnescapedBackticks(line);
    if (backtickCount % 2 === 1) inTemplateLiteral = !inTemplateLiteral;
    if (inTemplateLiteral && backtickCount % 2 === 0) continue;

    const trimmed = line.trim();
    if (trimmed.startsWith('//') || trimmed.startsWith('*')) continue;

    HARDCODED_CORR_ID_PATTERN.lastIndex = 0;
    let match;
    while ((match = HARDCODED_CORR_ID_PATTERN.exec(line)) !== null) {
      violations.push({
        line: i + 1,
        column: match.index,
        message: `Hardcoded correlationId '${match[1]}' — use generateCorrelationId() instead`,
        severity: 'warning',
        suggestion:
          'Use a correlation ID generator function (e.g., uuid or nanoid) to create unique IDs for each operation',
        match: match[0],
        type: 'hardcoded-correlation-id',
        filePath,
      });
    }
  }

  return violations;
}

export const noHardcodedCorrelationId = defineCheck({
  id: 'de7e8777-2979-4ea5-97b7-8fbcc37bdfef',
  slug: 'no-hardcoded-correlation-id',
  scope: { languages: ['typescript'], concerns: ['backend', 'frontend', 'cli'] },
  contentFilter: 'raw',

  confidence: 'medium',
  description: 'Detect hardcoded correlation ID string literals',
  longDescription: `**Purpose:** Ensures correlation IDs are generated dynamically using the canonical \`generateCorrelationId()\` function instead of hardcoded string literals.

**Detects:**
- \`correlationId: 'literal-string'\` patterns where a static string is used instead of a generated ID
- Skips test files (hardcoded IDs in tests are expected)

**Why it matters:** Hardcoded correlation IDs make request tracing impossible — every operation would share the same ID, defeating the purpose of correlation-based observability.

**Scope:** Codebase-specific convention. Analyzes each file individually via regex.`,
  tags: ['quality', 'observability', 'correlation', 'tracing'],
  fileTypes: ['ts'],

  analyze(content: string, filePath: string): CheckViolation[] {
    if (isTestFile(filePath)) {
      return [];
    }
    if (filePath.includes('/fitness/src/checks/')) {
      return [];
    }
    if (!content.includes('correlationId')) {
      return [];
    }

    return findHardcodedCorrelationIds(content, filePath);
  },
});
