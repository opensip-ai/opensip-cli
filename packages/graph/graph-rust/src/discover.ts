// @fitness-ignore-file error-handling-quality -- realpathSync probe for symlink dedup; exception → fall through with the original path (file might be in a symlinked dir or have been unlinked), already marked v8-ignore as effectively unreachable on real input.
/**
 * Rust file discovery — Stage 0 for the Rust adapter.
 *
 * Lands in PR 6 of plan docs/plans/10-graph-language-pluggability.md.
 *
 * Strategy:
 *   1. Locate `Cargo.toml`. The PR 6 implementation does NOT parse it
 *      to honor `[workspace] members = [...]` or `[lib]` / `[[bin]]`
 *      paths — that's a deliberate punt. Instead we recurse all `.rs`
 *      files from the project root excluding `target/`, which covers
 *      single crates and most workspace layouts. Workspace-aware
 *      discovery is a follow-up the plan flagged.
 *   2. If no `Cargo.toml` is present, the configPath is undefined and
 *      `cacheKey` falls back to the literal `no-config`.
 *   3. Records `Cargo.lock` (if present) as a sibling fingerprint —
 *      `cacheKey` prefers Cargo.lock since it's the resolved-dep
 *      hash; falls back to Cargo.toml.
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
  '**/target/**',
  '**/node_modules/**',
  '**/.git/**',
];

export function discoverFiles(input: DiscoverInput): DiscoverOutput {
  logger.info({
    evt: 'graph.discover.start',
    module: 'graph:discover:rust',
    projectDir: input.cwd,
  });

  const projectDirAbs = normalizeProjectDir(input.cwd);
  const configPathAbs = resolveConfigPath(projectDirAbs, input.configPathOverride);
  const files = collectRustFiles(projectDirAbs);

  logger.info({
    evt: 'graph.discover.complete',
    module: 'graph:discover:rust',
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
  // Prefer Cargo.lock (resolved deps) over Cargo.toml (intent), since
  // changing a dep version invalidates the call-graph more reliably
  // than editing the manifest.
  const lock = resolve(projectDirAbs, 'Cargo.lock');
  if (existsSync(lock)) return realpathOrPath(lock);
  const toml = resolve(projectDirAbs, 'Cargo.toml');
  if (existsSync(toml)) return realpathOrPath(toml);
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

function collectRustFiles(projectDirAbs: string): readonly string[] {
  const matches: string[] = glob.sync('**/*.rs', {
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
