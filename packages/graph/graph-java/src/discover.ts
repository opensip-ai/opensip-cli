/**
 * Java file discovery.
 *
 * Strategy mirrors graph-go:
 *   1. Locate a build file. Precedence (resolved-deps first):
 *      gradle.lockfile > pom.xml > build.gradle.kts > build.gradle.
 *      We do NOT parse them — recursive `.java` glob with build
 *      output dirs excluded handles single modules and most multi-
 *      module layouts. Multi-module workspace-aware discovery
 *      (Gradle subprojects, Maven `<modules>`) is a follow-up.
 *   2. If no build file present, configPath is undefined; cacheKey
 *      falls back to `no-config`.
 *
 * Excluded directories:
 *   - `target/`       — Maven build output
 *   - `build/`        — Gradle build output
 *   - `out/`          — IntelliJ default output
 *   - `bin/`          — Eclipse default output
 *   - `.gradle/`      — Gradle cache
 *   - `node_modules/` — defensive
 *   - `.git/`         — VCS metadata
 *
 * The collect-loop / realpath-dedup / config-precedence scaffolding lives
 * in `@opensip-cli/graph-adapter-common`; this module supplies only the
 * Java-specific inputs.
 */

import { createDiscover } from '@opensip-cli/graph-adapter-common';

const EXCLUDED_DIR_GLOBS: readonly string[] = [
  '**/target/**',
  '**/build/**',
  '**/out/**',
  '**/bin/**',
  '**/.gradle/**',
  '**/node_modules/**',
  '**/.git/**',
];

const BUILD_OUTPUT_DIRS: ReadonlySet<string> = new Set(['target', 'build', 'out', 'bin']);
const ALWAYS_EXCLUDED_DIRS: ReadonlySet<string> = new Set(['.gradle', 'node_modules', '.git']);

function preserveCanonicalSourcePath(projectRelativePath: string): boolean {
  const segments = projectRelativePath.split('/');
  if (segments.some((segment) => ALWAYS_EXCLUDED_DIRS.has(segment))) return false;

  const sourceRootIndex = segments.findIndex(
    (segment, index) =>
      segment === 'src' &&
      (segments[index + 1] === 'main' || segments[index + 1] === 'test') &&
      segments[index + 2] === 'java',
  );
  if (sourceRootIndex === -1) return false;

  return segments.every(
    (segment, index) => !BUILD_OUTPUT_DIRS.has(segment) || index > sourceRootIndex + 2,
  );
}

// Search order: lockfile (most resolved) → pom.xml → build.gradle.kts → build.gradle.
const CONFIG_CANDIDATES: readonly string[] = [
  'gradle.lockfile',
  'pom.xml',
  'build.gradle.kts',
  'build.gradle',
];

export const discoverFiles = createDiscover({
  extension: 'java',
  excludedDirGlobs: EXCLUDED_DIR_GLOBS,
  preserveExcludedPath: preserveCanonicalSourcePath,
  configCandidates: CONFIG_CANDIDATES,
  languageId: 'java',
});
