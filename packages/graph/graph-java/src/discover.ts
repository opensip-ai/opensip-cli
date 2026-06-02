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
 * in `@opensip-tools/graph-adapter-common`; this module supplies only the
 * Java-specific inputs.
 */

import { createDiscover } from '@opensip-tools/graph-adapter-common';

const EXCLUDED_DIR_GLOBS: readonly string[] = [
  '**/target/**',
  '**/build/**',
  '**/out/**',
  '**/bin/**',
  '**/.gradle/**',
  '**/node_modules/**',
  '**/.git/**',
];

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
  configCandidates: CONFIG_CANDIDATES,
  languageId: 'java',
});
