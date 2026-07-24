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
  const normalized = filePath.replaceAll('\\', '/');
  // Must be in a source directory
  const inSource = SOURCE_DIRS.some(
    (d) => normalized.includes(`/${d}`) || normalized.startsWith(d),
  );
  if (!inSource) return null;

  // Must not be in dist/, node_modules/, or .cache/
  if (
    normalized.includes('/dist/') ||
    normalized.includes('/node_modules/') ||
    normalized.includes('/.cache/')
  )
    return null;

  for (const ext of ARTIFACT_EXTENSIONS) {
    if (filePath.endsWith(ext)) return { ext };
  }
  return null;
}

/**
 * A file is a STALE artifact only when the source it was compiled from sits
 * beside it — that shadowing twin is what causes the import-resolution bugs
 * this check exists for. A standalone `.js` with no `.ts`/`.tsx` sibling is a
 * legitimate hand-authored or vendored file (pure-JS projects, checked-in
 * bundles), never flagged.
 */
function shadowedSourceTwin(filePath: string, ext: string, paths: ReadonlySet<string>): boolean {
  const base = filePath.slice(0, filePath.length - ext.length);
  return paths.has(`${base}.ts`) || paths.has(`${base}.tsx`);
}

export const staleBuildArtifacts = defineCheck({
  id: '8d36209b-5aeb-4ab0-8255-3134a20fdfd5',
  slug: 'stale-build-artifacts',
  // Universal scope + fileTypes (not `languages: ['typescript']`) is
  // deliberate: every typescript-language target globs source by
  // extension (e.g. `src/**/*.ts`), so a check scoped to that language
  // would NEVER see the very `.js`/`.js.map` artifacts it exists to catch
  // — they don't match a typescript target's include globs and so never
  // reach a scope-resolved check at all (filtering by `fileTypes` happens
  // downstream of scope-based file resolution, too late to widen the set).
  // Falling back to the prewarmed file cache and filtering by extension
  // here (same pattern as `file-length-limit` / `no-todo-comments`) is
  // the only way to see all three ARTIFACT_EXTENSIONS.
  //
  // Residual caveat: `.js`/`.d.ts` are always covered because
  // `DEFAULT_PREWARM_PATTERNS` (fitness engine) already globs `**/*.js` and
  // `**/*.ts`. `.js.map` is covered only when this check (or a check set
  // whose union of `fileTypes` includes `map`) drives prewarm — a
  // full-registry run where any OTHER check is fully universal (no
  // `fileTypes`) still falls back to `DEFAULT_PREWARM_PATTERNS`, which has
  // no `.map` entry. That's a pre-existing fitness-engine prewarm
  // limitation, not something this check can widen from here.
  scope: { languages: [], concerns: [] },
  fileTypes: ['ts', 'js', 'map'],
  confidence: 'high',
  description:
    'Detects compiled .js/.d.ts/.js.map files in source directories that should only exist in dist/',
  tags: ['architecture', 'build', 'hygiene'],

  // eslint-disable-next-line @typescript-eslint/require-await -- AnalyzeAllCheckConfig requires Promise<CheckViolation[]>; this implementation is synchronous
  async analyzeAll(files: FileAccessor): Promise<CheckViolation[]> {
    const violations: CheckViolation[] = [];
    const pathSet = new Set(files.paths);

    for (const filePath of files.paths) {
      const result = isArtifactInSource(filePath);
      if (result && shadowedSourceTwin(filePath, result.ext, pathSet)) {
        violations.push({
          filePath,
          line: 1,
          message: `Stale build artifact (${result.ext}) shadows its sibling source file. This file should only exist in dist/.`,
          severity: 'error',
          suggestion: `Delete ${filePath} and ensure .gitignore excludes compiled files from source directories.`,
          type: 'STALE_ARTIFACT',
        });
      }
    }

    return violations;
  },
});
