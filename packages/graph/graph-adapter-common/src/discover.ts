/**
 * Shared file-discovery scaffolding for the tree-sitter graph adapters.
 *
 * The discover template is byte-identical across graph-go / graph-java /
 * graph-python / graph-rust save four data inputs:
 *
 *   - `extension`         — the source-file extension to glob (`.go`, …).
 *   - `excludedDirGlobs`  — vendored / build-output / VCS dirs to skip.
 *   - `configCandidates`  — the ordered config-file precedence list
 *                           (resolved-deps first, e.g. `['go.sum','go.mod']`).
 *   - `languageId`        — the `graph:discover:<id>` log tag.
 *
 * `createDiscover` closes over those and returns the adapter's
 * `discoverFiles(input): DiscoverOutput`. The collect loop, the symlink
 * realpath/dedup/sort normalization (so I-9 referential transparency
 * holds), and the `DiscoverOutput` assembly are shared verbatim.
 */

import { existsSync, realpathSync } from 'node:fs';
import { resolve, sep } from 'node:path';

import { logger } from '@opensip-cli/core';
import { throwIfGraphAdapterAborted } from '@opensip-cli/graph';
import { glob, Ignore, type IgnoreLike } from 'glob';

import type { DiscoverInput, DiscoverOutput } from '@opensip-cli/graph';

/** Per-language inputs to the shared discover template. */
export interface TreeSitterDiscoverConfig {
  /** Source-file extension WITHOUT the leading dot, e.g. `'go'`, `'py'`. */
  readonly extension: string;
  /** Directory globs to exclude from the recursive source-file walk. */
  readonly excludedDirGlobs: readonly string[];
  /**
   * Optional exception for paths that match an excluded glob but are valid
   * source locations. Receives a project-relative POSIX path.
   */
  readonly preserveExcludedPath?: (projectRelativePath: string) => boolean;
  /**
   * Ordered config-file precedence list (resolved-deps first). The first
   * candidate that exists at the project root becomes the cacheKey anchor.
   */
  readonly configCandidates: readonly string[];
  /** Log-tag suffix for `graph:discover:<languageId>`. */
  readonly languageId: string;
}

/** Builds the adapter's `discoverFiles` from per-language config. */
export function createDiscover(
  config: TreeSitterDiscoverConfig,
): (input: DiscoverInput) => DiscoverOutput {
  const { extension, excludedDirGlobs, preserveExcludedPath, configCandidates, languageId } =
    config;
  const module = `graph:discover:${languageId}`;
  const pattern = `**/*.${extension}`;

  return function discoverFiles(input: DiscoverInput): DiscoverOutput {
    // Adapters retain no lifecycle log; callers own aggregate terminal events.
    void input.diagnosticIntent;
    void module;
    void logger;
    throwIfGraphAdapterAborted(input.signal, `${languageId} discovery`);

    const projectDirAbs = normalizeProjectDir(input.cwd);
    const configPathAbs = resolveConfigPath(
      projectDirAbs,
      input.configPathOverride,
      configCandidates,
    );
    const files = collectFiles(
      projectDirAbs,
      pattern,
      excludedDirGlobs,
      preserveExcludedPath,
      input.signal,
      languageId,
    );
    throwIfGraphAdapterAborted(input.signal, `${languageId} discovery`);

    const out: DiscoverOutput =
      configPathAbs === undefined
        ? { projectDirAbs, files }
        : { projectDirAbs, files, configPathAbs };
    return out;
  };
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
  configCandidates: readonly string[],
): string | undefined {
  if (override !== undefined && override.length > 0) {
    const abs = resolve(projectDirAbs, override);
    return existsSync(abs) ? realpathOrPath(abs) : abs;
  }
  for (const candidate of configCandidates) {
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

function collectFiles(
  projectDirAbs: string,
  pattern: string,
  excludedDirGlobs: readonly string[],
  preserveExcludedPath: ((projectRelativePath: string) => boolean) | undefined,
  signal: AbortSignal | undefined,
  languageId: string,
): readonly string[] {
  const ignore = buildIgnore(excludedDirGlobs, preserveExcludedPath);
  const matches: string[] = glob.sync(pattern, {
    cwd: projectDirAbs,
    absolute: true,
    ignore,
    nodir: true,
    follow: false,
    dot: false,
  });
  const seen = new Set<string>();
  const out: string[] = [];
  for (const m of matches) {
    throwIfGraphAdapterAborted(signal, `${languageId} discovery`);
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

function buildIgnore(
  excludedDirGlobs: readonly string[],
  preserveExcludedPath: ((projectRelativePath: string) => boolean) | undefined,
): IgnoreLike {
  const baseIgnore = new Ignore([...excludedDirGlobs], {});
  if (preserveExcludedPath === undefined) return baseIgnore;

  return {
    ignored: (path) => !preserveExcludedPath(path.relativePosix()) && baseIgnore.ignored(path),
    childrenIgnored: (path) =>
      !preserveExcludedPath(path.relativePosix()) && baseIgnore.childrenIgnored(path),
  };
}
