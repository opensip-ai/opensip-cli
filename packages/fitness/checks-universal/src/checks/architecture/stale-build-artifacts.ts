/**
 * @fileoverview Stale build artifact detection
 * @module checks-builtin/checks/architecture/stale-build-artifacts
 *
 * Detects .js, .d.ts, and .js.map files in source directories that should
 * only exist in dist/. These cause confusing import resolution bugs where
 * the compiled artifact shadows the source file.
 */

import { defineCheck, type CheckViolation, type FileAccessor } from '@opensip-cli/fitness';

const SOURCE_DIRS = ['src/', 'lib/'];
const ARTIFACT_EXTENSIONS = ['.js', '.d.ts', '.js.map'];

function isArtifactInSource(filePath: string): { ext: string } | null {
  // Must be in a source directory
  const inSource = SOURCE_DIRS.some((d) => filePath.includes(`/${d}`) || filePath.startsWith(d));
  if (!inSource) return null;

  // Must not be in dist/, node_modules/, or .cache/
  if (
    filePath.includes('/dist/') ||
    filePath.includes('/node_modules/') ||
    filePath.includes('/.cache/')
  )
    return null;

  for (const ext of ARTIFACT_EXTENSIONS) {
    if (filePath.endsWith(ext)) return { ext };
  }
  return null;
}

export const staleBuildArtifacts = defineCheck({
  id: '8d36209b-5aeb-4ab0-8255-3134a20fdfd5',
  slug: 'stale-build-artifacts',
  scope: {
    languages: ['typescript'],
    concerns: ['backend', 'frontend', 'cli'],
  },
  confidence: 'high',
  description:
    'Detects compiled .js/.d.ts/.js.map files in source directories that should only exist in dist/',
  tags: ['architecture', 'build', 'hygiene'],

  // eslint-disable-next-line @typescript-eslint/require-await -- AnalyzeAllCheckConfig requires Promise<CheckViolation[]>; this implementation is synchronous
  async analyzeAll(files: FileAccessor): Promise<CheckViolation[]> {
    const violations: CheckViolation[] = [];

    for (const filePath of files.paths) {
      const result = isArtifactInSource(filePath);
      if (result) {
        violations.push({
          filePath,
          line: 1,
          message: `Stale build artifact (${result.ext}) found in source directory. This file should only exist in dist/.`,
          severity: 'error',
          suggestion: `Delete ${filePath} and ensure .gitignore excludes compiled files from source directories.`,
          type: 'STALE_ARTIFACT',
        });
      }
    }

    return violations;
  },
});
