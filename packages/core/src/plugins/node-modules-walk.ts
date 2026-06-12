/**
 * @fileoverview Shared node_modules ancestor-walk primitives for plugin
 * auto-discovery.
 *
 * Scoped package discovery (`scenarios-*`, future packs) walks up the
 * directory tree from a project root, scanning
 * `node_modules/<scope>/` directories — mirroring Node's nearest-ancestor
 * module resolution, which handles pnpm hoisting and monorepo layouts
 * where the scope may live in the workspace root.
 *
 * The leaf filesystem probes (`safeReaddir`, `hasPackageJson`) and the
 * explicit-name resolver (`resolvePackageDir`) are shared by marker
 * discovery, exact package resolution, and simulation's scoped scenario-pack
 * discovery. They live here now — one home for the generic walk plumbing the
 * kernel already owns.
 *
 * These are pure `node:fs` / `node:path` primitives — no fitness/sim
 * vocabulary leaks down into the kernel. The per-tool policy (explicit
 * list vs opt-out vs auto-discover, the domain-specific not-resolved
 * warning events) stays in each engine's outer discovery function.
 */

import { existsSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';

/** A package discovered (or resolved) inside node_modules. */
export interface DiscoveredScopedPackage {
  /** npm package name, e.g. '@opensip-cli/checks-python'. */
  readonly name: string;
  /** Absolute path to the package's directory inside node_modules. */
  readonly packageDir: string;
}

/** Inputs for {@link discoverScopedPackages}: the project root, the npm scopes to scan, and the package-name prefix to match. */
export interface DiscoverScopedPackagesOptions {
  /** Absolute path to the project root. */
  readonly projectDir: string;
  /** Effective npm scopes to scan (already validated/deduped). */
  readonly scopes: readonly string[];
  /** Package-name prefix to match within each scope, e.g. `checks-`. */
  readonly prefix: string;
}

/**
 * Walk up the directory tree from `projectDir` looking for
 * `node_modules/<scope>/` directories under every configured scope, and
 * return all packages whose name (the entry under the scope dir) starts
 * with `prefix` and contains a `package.json`. Deduplicated by full
 * package name; the first occurrence walking from `projectDir` outward
 * wins, matching Node's nearest-ancestor resolution.
 */
// eslint-disable-next-line sonarjs/cognitive-complexity -- ancestor-walk discovery: walks node_modules trees up the directory tree until the filesystem root
export function discoverScopedPackages(
  options: DiscoverScopedPackagesOptions,
): DiscoveredScopedPackage[] {
  const { projectDir, scopes, prefix } = options;
  const seen = new Set<string>();
  const out: DiscoveredScopedPackage[] = [];
  let dir = projectDir;
  let prev = '';
  while (dir !== prev) {
    for (const scope of scopes) {
      const scopeDir = join(dir, 'node_modules', scope);
      if (!existsSync(scopeDir)) continue;
      for (const entry of safeReaddir(scopeDir)) {
        if (!entry.startsWith(prefix)) continue;
        const name = `${scope}/${entry}`;
        if (seen.has(name)) continue;
        const packageDir = join(scopeDir, entry);
        if (!hasPackageJson(packageDir)) continue;
        seen.add(name);
        out.push({ name, packageDir });
      }
    }
    prev = dir;
    dir = dirname(dir);
  }
  return out;
}

/**
 * Resolve an *explicit* package name to its on-disk directory by walking
 * ancestor `node_modules` directories. Returns the first directory that
 * contains a `package.json`, or undefined if the package is not installed.
 */
export function resolvePackageDir(projectDir: string, name: string): string | undefined {
  let dir = projectDir;
  let prev = '';
  while (dir !== prev) {
    const candidate = join(dir, 'node_modules', name);
    if (hasPackageJson(candidate)) return candidate;
    prev = dir;
    dir = dirname(dir);
  }
  return undefined;
}

/** True when `packageDir` exists and contains a `package.json`. */
export function hasPackageJson(packageDir: string): boolean {
  if (!existsSync(packageDir)) return false;
  return existsSync(join(packageDir, 'package.json'));
}

/**
 * Read a directory's entries, returning `[]` on any failure. A filesystem
 * probe: a missing directory or permission denial yields "no entries",
 * indistinguishable from a genuinely empty directory.
 */
export function safeReaddir(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    // @fitness-ignore-next-line error-handling-quality -- filesystem probe; exception → empty array is the function's contract (missing directory or permission denied returns "no entries", same as a genuinely empty dir).
    return [];
  }
}
