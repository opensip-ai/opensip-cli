/**
 * Go file discovery.
 *
 * Strategy mirrors graph-rust:
 *   1. Locate `go.mod`. We do NOT parse it — recursive `.go` glob with
 *      vendor/ excluded handles single modules and most workspace
 *      layouts. Go workspace files (`go.work`) listing multiple
 *      modules would require parsing; that's a follow-up.
 *   2. If no go.mod present, configPath is undefined; cacheKey falls
 *      back to the literal `no-config`.
 *   3. Records go.sum (if present) as the fingerprint — prefers go.sum
 *      since it holds the resolved-dep hashes; falls back to go.mod.
 *
 * Excluded directories:
 *   - `vendor/` — Go's vendored-dep directory; semantically third-party.
 *   - `node_modules/` — rare in Go projects but defensive.
 *   - `.git/` — VCS metadata.
 *
 * Returns absolute, realpath-normalized, sorted, deduped paths so I-9
 * (referential transparency of discoverFiles) holds across runs.
 */

import { existsSync, realpathSync } from 'node:fs';
import { resolve, sep } from 'node:path';

import { logger } from '@opensip-tools/core';
import { glob } from 'glob';

import type { DiscoverInput, DiscoverOutput } from '@opensip-tools/graph';

const EXCLUDED_DIR_GLOBS: readonly string[] = [
  '**/vendor/**',
  '**/node_modules/**',
  '**/.git/**',
];

export function discoverFiles(input: DiscoverInput): DiscoverOutput {
  logger.info({
    evt: 'graph.discover.start',
    module: 'graph:discover:go',
    projectDir: input.cwd,
  });

  const projectDirAbs = normalizeProjectDir(input.cwd);
  const configPathAbs = resolveConfigPath(projectDirAbs, input.configPathOverride);
  const files = collectGoFiles(projectDirAbs);

  logger.info({
    evt: 'graph.discover.complete',
    module: 'graph:discover:go',
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
  // Prefer go.sum (resolved deps with hashes) over go.mod (intent).
  const sum = resolve(projectDirAbs, 'go.sum');
  if (existsSync(sum)) return realpathOrPath(sum);
  const mod = resolve(projectDirAbs, 'go.mod');
  if (existsSync(mod)) return realpathOrPath(mod);
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

function collectGoFiles(projectDirAbs: string): readonly string[] {
  const matches: string[] = glob.sync('**/*.go', {
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
