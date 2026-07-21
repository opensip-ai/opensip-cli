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

import { readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { SystemError } from '../lib/errors.js';

/** Errno codes that genuinely mean "this path is not there". */
const ABSENT_ERRNO = new Set(['ENOENT', 'ENOTDIR']);

/**
 * Errno codes for present-but-unreadable paths. The ancestor walk crosses
 * system directories on its way to the filesystem root, so a permission
 * denial is a legitimate "nothing discoverable here", same as absence.
 */
const UNREADABLE_ERRNO = new Set(['EACCES', 'EPERM']);

function errnoOf(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' ? code : 'unknown';
}

function isAbsenceErrno(code: string): boolean {
  return ABSENT_ERRNO.has(code) || UNREADABLE_ERRNO.has(code);
}

/**
 * Any other errno (EMFILE/ENFILE fd exhaustion, EIO, …) is an environment
 * failure, not evidence of absence. Treating it as "not installed" silently
 * drops packs — under load this reads as a nondeterministically shrinking
 * check surface (the v0.8.2 fit-acceptance divergence) — so it must throw.
 */
function probeFailure(path: string, error: unknown): SystemError {
  return new SystemError(
    `Filesystem probe failed for ${path} (${errnoOf(error)}); refusing to treat an environment failure as "package not installed"`,
    { code: 'SYSTEM.PLUGINS.FS_PROBE_FAILED', cause: error },
  );
}

/**
 * True when `path` exists; absence/unreadable errnos → false.
 *
 * @throws {SystemError} `SYSTEM.PLUGINS.FS_PROBE_FAILED` on any non-absence
 *   errno (EMFILE/EIO/…) — resource exhaustion must never read as "not there".
 */
function probePathPresent(path: string): boolean {
  try {
    statSync(path);
    return true;
  } catch (error) {
    if (isAbsenceErrno(errnoOf(error))) return false;
    throw probeFailure(path, error);
  }
}

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
      if (!probePathPresent(scopeDir)) continue;
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

/**
 * True when `packageDir` exists and contains a `package.json`. Absence and
 * permission denial read as `false`; any other probe failure (EMFILE, EIO, …)
 * throws `SYSTEM.PLUGINS.FS_PROBE_FAILED` — resource exhaustion must never
 * masquerade as "not installed".
 */
export function hasPackageJson(packageDir: string): boolean {
  return probePathPresent(join(packageDir, 'package.json'));
}

/**
 * Read a directory's entries. A missing directory or permission denial yields
 * `[]` — indistinguishable from a genuinely empty directory, which is the
 * intended ancestor-walk semantics.
 *
 * @throws {SystemError} `SYSTEM.PLUGINS.FS_PROBE_FAILED` on any non-absence
 *   errno (EMFILE, EIO, …) — a resource failure must fail loud, not silently
 *   shrink discovery.
 */
export function safeReaddir(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch (error) {
    if (isAbsenceErrno(errnoOf(error))) return [];
    throw probeFailure(dir, error);
  }
}
