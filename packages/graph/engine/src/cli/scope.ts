/**
 * Scope resolution for `graph --package <name|path>`.
 *
 * Per docs/plans/graph-performance-improvements.md Phase 6: a flag that
 * narrows the run to a single workspace package's tsconfig. Cross-
 * package call sites become unresolved (lower fidelity, much faster).
 *
 * Resolution rules — in order:
 *   1. If the argument resolves to an existing directory (absolute or
 *      relative to `cwd`) and that directory contains a `tsconfig.json`,
 *      use that directory.
 *   2. Otherwise, treat the argument as a name and search for a
 *      directory under `<cwd>/packages/**` whose basename matches.
 *      Stops at the first match with a `tsconfig.json`.
 *
 * Anything more elaborate (parsing `pnpm-workspace.yaml`, npm workspaces,
 * yarn workspaces) is deferred — the simple search covers the dominant
 * monorepo layout. Users with non-conforming layouts can pass an explicit
 * path.
 */

import { existsSync, readdirSync, statSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';

import { ConfigurationError } from '@opensip-tools/core';

export interface ScopeResolutionInput {
  readonly cwd: string;
  /**
   * The user's --package argument: a directory path (absolute or
   * relative to cwd) or a bare package basename.
   */
  readonly packageArg: string;
}

export interface ScopeResolutionOutput {
  /** Absolute path to the package directory the run should target. */
  readonly packageDirAbs: string;
  /** Absolute path to that package's tsconfig.json. */
  readonly tsConfigPathAbs: string;
}

const PACKAGES_SEARCH_ROOT = 'packages';
const SEARCH_MAX_DEPTH = 3;

export function resolvePackageScope(input: ScopeResolutionInput): ScopeResolutionOutput {
  const arg = input.packageArg.trim();
  if (arg.length === 0) {
    throw new ConfigurationError('--package requires a non-empty argument.');
  }

  // Path mode: argument resolves to a directory with tsconfig.json.
  const asPath = isAbsolute(arg) ? arg : resolve(input.cwd, arg);
  if (existsSync(asPath) && safeIsDir(asPath)) {
    const tsconfig = join(asPath, 'tsconfig.json');
    if (!existsSync(tsconfig)) {
      throw new ConfigurationError(
        `Directory '${asPath}' has no tsconfig.json; cannot scope graph to it.`,
      );
    }
    return { packageDirAbs: asPath, tsConfigPathAbs: tsconfig };
  }

  // Name mode: search packages/** for a basename match.
  const root = resolve(input.cwd, PACKAGES_SEARCH_ROOT);
  if (!existsSync(root) || !safeIsDir(root)) {
    throw new ConfigurationError(
      `--package '${arg}' did not resolve to a directory and no '${PACKAGES_SEARCH_ROOT}/' tree exists at ${input.cwd} to search.`,
    );
  }
  const matches = findPackageByName(root, arg, SEARCH_MAX_DEPTH);
  if (matches.length === 0) {
    throw new ConfigurationError(
      `--package '${arg}': no matching package directory with a tsconfig.json under ${root}.`,
    );
  }
  if (matches.length > 1) {
    throw new ConfigurationError(
      `--package '${arg}' is ambiguous; matched ${String(matches.length)} directories: ${matches.join(', ')}. Pass an explicit path instead.`,
    );
  }
  const matched = matches[0];
  /* v8 ignore next 5 */
  if (matched === undefined) {
    throw new ConfigurationError(
      `--package '${arg}': no matching package directory with a tsconfig.json under ${root}.`,
    );
  }
  return {
    packageDirAbs: matched,
    tsConfigPathAbs: join(matched, 'tsconfig.json'),
  };
}

function safeIsDir(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function findPackageByName(root: string, name: string, maxDepth: number): readonly string[] {
  const out: string[] = [];
  walk(root, 0);
  return out;

  function walk(dir: string, depth: number): void {
    if (depth > maxDepth) return;
    let entries: readonly string[];
    try {
      entries = readdirSync(dir);
    } catch {
      /* v8 ignore next */
      return;
    }
    for (const entry of entries) {
      const sub = join(dir, entry);
      if (!safeIsDir(sub)) continue;
      if (entry === name) {
        const tsconfig = join(sub, 'tsconfig.json');
        if (existsSync(tsconfig)) out.push(sub);
        // Don't recurse into a matched directory.
        continue;
      }
      // Skip node_modules / dist / build for performance.
      if (entry === 'node_modules' || entry === 'dist' || entry === 'build') continue;
      walk(sub, depth + 1);
    }
  }
}

/**
 * Find every workspace package under `<cwd>/packages/**` that has a
 * tsconfig.json. Used by `--packages` to enumerate the targets a
 * parallel run should fan out over.
 *
 * Returns absolute package directory paths, sorted lexicographically
 * for deterministic output ordering.
 */
export function discoverWorkspacePackages(cwd: string): readonly string[] {
  const root = resolve(cwd, PACKAGES_SEARCH_ROOT);
  if (!existsSync(root) || !safeIsDir(root)) return [];
  const out: string[] = [];
  walk(root, 0);
  out.sort();
  return out;

  function walk(dir: string, depth: number): void {
    if (depth > SEARCH_MAX_DEPTH) return;
    // A directory with a tsconfig.json is a candidate; record it and
    // do not recurse into it. Without this short-circuit, nested
    // tsconfigs (e.g., a sub-package with its own tsconfig under a
    // parent package) would all be enumerated, double-counting code.
    if (existsSync(join(dir, 'tsconfig.json'))) {
      out.push(dir);
      return;
    }
    let entries: readonly string[];
    try {
      entries = readdirSync(dir);
    } catch {
      /* v8 ignore next */
      return;
    }
    for (const entry of entries) {
      if (entry === 'node_modules' || entry === 'dist' || entry === 'build') continue;
      const sub = join(dir, entry);
      if (!safeIsDir(sub)) continue;
      walk(sub, depth + 1);
    }
  }
}
