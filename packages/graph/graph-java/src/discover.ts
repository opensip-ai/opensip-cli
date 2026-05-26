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
 * Returns absolute, realpath-normalized, sorted, deduped paths so I-9
 * holds across runs.
 */

import { existsSync, realpathSync } from 'node:fs';
import { resolve, sep } from 'node:path';

import { logger } from '@opensip-tools/core';
import { glob } from 'glob';

import type { DiscoverInput, DiscoverOutput } from '@opensip-tools/graph';

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

export function discoverFiles(input: DiscoverInput): DiscoverOutput {
  logger.info({
    evt: 'graph.discover.start',
    module: 'graph:discover:java',
    projectDir: input.cwd,
  });

  const projectDirAbs = normalizeProjectDir(input.cwd);
  const configPathAbs = resolveConfigPath(projectDirAbs, input.configPathOverride);
  const files = collectJavaFiles(projectDirAbs);

  logger.info({
    evt: 'graph.discover.complete',
    module: 'graph:discover:java',
    projectDir: projectDirAbs,
    configPath: configPathAbs ?? '(none)',
    fileCount: files.length,
  });

  const out: DiscoverOutput = configPathAbs === undefined
    ? { projectDirAbs, files }
    : { projectDirAbs, files, configPathAbs };
  return out;
}

/* v8 ignore start */
function normalizeProjectDir(projectDir: string): string {
  const abs = resolve(projectDir);
  try {
    return realpathSync(abs);
  } catch {
    return abs;
  }
}
/* v8 ignore stop */

function resolveConfigPath(
  projectDirAbs: string,
  override: string | undefined,
): string | undefined {
  if (override !== undefined && override.length > 0) {
    const abs = resolve(projectDirAbs, override);
    return existsSync(abs) ? realpathOrPath(abs) : abs;
  }
  for (const candidate of CONFIG_CANDIDATES) {
    const path = resolve(projectDirAbs, candidate);
    if (existsSync(path)) return realpathOrPath(path);
  }
  return undefined;
}

/* v8 ignore start */
function realpathOrPath(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}
/* v8 ignore stop */

function collectJavaFiles(projectDirAbs: string): readonly string[] {
  const matches: string[] = glob.sync('**/*.java', {
    cwd: projectDirAbs,
    absolute: true,
    ignore: [...EXCLUDED_DIR_GLOBS],
    nodir: true,
    follow: false,
    dot: false,
  });
  const seen = new Set<string>();
  const out: string[] = [];
  for (const m of matches) {
    let real: string = m;
    /* v8 ignore start */
    try {
      real = realpathSync(m);
    } catch {
      // fall through with original
    }
    /* v8 ignore stop */
    const key = real.split(sep).join('/');
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(real);
  }
  out.sort();
  return out;
}
