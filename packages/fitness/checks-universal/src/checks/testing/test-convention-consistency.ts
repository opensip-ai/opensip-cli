/**
 * @fileoverview Test convention consistency check
 *
 * Detects mixed .test and .spec naming conventions across the codebase.
 * When one convention is dominant (>95%), flags the minority files for renaming.
 */

import * as path from 'node:path';

import { defineCheck, type CheckViolation, type FileAccessor } from '@opensip-cli/fitness';

/** Threshold for convention dominance (95%) */
const DOMINANCE_THRESHOLD = 0.95;

type Convention = 'test' | 'spec';

/**
 * Determine which convention a file path uses.
 */
function getConvention(filePath: string): Convention {
  const basename = path.basename(filePath);
  return basename.includes('.spec.') ? 'spec' : 'test';
}

/**
 * Check: testing/test-convention-consistency
 *
 * Detects mixed .test and .spec naming conventions. When one is dominant (>95%),
 * flags minority files for renaming to match the dominant convention.
 */
export const testConventionConsistency = defineCheck({
  id: 'e5a7d9f1-6b0c-4a4d-c8e3-1f5b9d7a0c6e',
  slug: 'test-convention-consistency',
  scope: { languages: ['typescript', 'tsx'], concerns: ['testing'] },

  confidence: 'medium',
  description: 'Detects mixed .test and .spec naming conventions across the codebase',
  longDescription: `**Purpose:** Detects mixed \`.test\` and \`.spec\` naming conventions and flags minority files when one convention is dominant (>95%).

**Detects:**
- Files using the minority test naming convention
- Only flags when one convention is clearly dominant (>95% of all test files)
- If neither convention is dominant, no violations are reported

**Why it matters:** Consistent test naming conventions improve developer experience and make it easier to configure test runners, CI pipelines, and glob patterns consistently.

**Scope:** Cross-file analysis via \`analyzeAll\`. General best practice.`,
  tags: ['testing', 'consistency'],
  fileTypes: ['ts', 'tsx'],

  // @fitness-ignore-next-line concurrency-safety -- async keyword required by analyzeAll interface contract; synchronous analysis implementation
  // eslint-disable-next-line @typescript-eslint/require-await -- AnalyzeAllCheckConfig requires Promise<CheckViolation[]>; this implementation is synchronous
  async analyzeAll(files: FileAccessor): Promise<CheckViolation[]> {
    const testFiles: string[] = [];
    const specFiles: string[] = [];

    // Categorize files by convention
    for (const filePath of files.paths) {
      const convention = getConvention(filePath);
      if (convention === 'spec') {
        specFiles.push(filePath);
      } else {
        testFiles.push(filePath);
      }
    }

    const total = testFiles.length + specFiles.length;
    if (total === 0) return [];

    // Determine if one convention is dominant
    const testRatio = testFiles.length / total;
    const specRatio = specFiles.length / total;

    let dominant: Convention | null = null;
    let minorityFiles: string[] = [];

    if (testRatio >= DOMINANCE_THRESHOLD) {
      dominant = 'test';
      minorityFiles = specFiles;
    } else if (specRatio >= DOMINANCE_THRESHOLD) {
      dominant = 'spec';
      minorityFiles = testFiles;
    }

    // No dominant convention — no violations
    if (!dominant) return [];

    const violations: CheckViolation[] = [];
    const minorityConvention = dominant === 'test' ? 'spec' : 'test';

    for (const filePath of minorityFiles) {
      const basename = path.basename(filePath);
      const renamed = basename.replace(`.${minorityConvention}.`, `.${dominant}.`);

      violations.push({
        filePath,
        line: 1,
        message: `Test file uses .${minorityConvention} convention but codebase uses .${dominant} (${Math.round((dominant === 'test' ? testRatio : specRatio) * 100)}% dominant)`,
        severity: 'warning',
        suggestion: `Rename to match dominant convention: ${renamed}`,
      });
    }

    return violations;
  },
});
