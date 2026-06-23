/**
 * @fileoverview Flag files that exceed a recommended line count.
 *
 * Operates on raw content — file length is identical regardless of
 * language. Counts only non-empty lines so massive whitespace-padded
 * files don't slip through and trivial generated boilerplate isn't
 * over-counted (configurable later if needed).
 *
 * Test and fixture paths are excluded — long behavior-fixture suites are
 * intentional; modularity rules apply to production source.
 */
import { defineCheck, isTestFile, type CheckViolation } from '@opensip-cli/fitness';

const SOFT_LIMIT = 400;
const HARD_LIMIT = 800;

/**
 * Pure analysis function. Exported so unit tests can exercise the
 * line-counting logic without spinning up an ExecutionContext.
 */
export function analyzeFileLength(content: string): CheckViolation[] {
  const lines = content.split('\n').filter((l) => l.trim().length > 0);
  if (lines.length <= SOFT_LIMIT) return [];

  const violations: CheckViolation[] = [];
  if (lines.length > HARD_LIMIT) {
    violations.push({
      message: `File has ${lines.length} non-empty lines (hard limit ${HARD_LIMIT})`,
      severity: 'error',
      line: 1,
      suggestion: 'Split this file into focused modules organized by responsibility',
    });
  } else {
    violations.push({
      message: `File has ${lines.length} non-empty lines (soft limit ${SOFT_LIMIT})`,
      severity: 'warning',
      line: 1,
      suggestion: 'Consider splitting before this exceeds the hard limit',
    });
  }
  return violations;
}

/**
 * Per-file entry point: skips test/fixture paths before line counting.
 */
export function analyzeFileLengthForPath(content: string, filePath: string): CheckViolation[] {
  if (isTestFile(filePath) || filePath.includes('/__fixtures__/')) {
    return [];
  }
  return analyzeFileLength(content);
}

export const fileLengthLimit = defineCheck({
  id: 'fc8b5ec9-d020-4e76-b16f-f5f73ce9d21e',
  slug: 'file-length-limit',
  description: `Files longer than ${HARD_LIMIT} lines hint at insufficient module decomposition`,
  scope: { languages: [], concerns: [] },
  tags: ['quality', 'modularity'],
  analyze: (content, filePath) => analyzeFileLengthForPath(content, filePath),
});