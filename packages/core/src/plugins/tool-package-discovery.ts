/**
 * @fileoverview Auto-discovery of @opensip-tools Tool plugin packages
 * installed in node_modules.
 *
 * A Tool plugin is any npm package (scoped or unscoped, first- or third-
 * party) whose `package.json` declares:
 *
 *   { "opensipTools": { "kind": "tool" } }
 *
 * The explicit marker is intentional: a name-prefix rule (e.g. anything
 * matching `@opensip-tools/*`) breaks down once organizations publish
 * their own scoped tools (`@my-company/opensip-tools-audit`). Marker-
 * based discovery decouples publication scope from plugin shape.
 *
 * The walker mirrors `check-package-discovery.ts` (now fitness-internal)
 * — walk up ancestor `node_modules/` directories from the project root,
 * matching Node's resolution algorithm. This handles pnpm hoisting and
 * monorepo layouts where the scope may live in the workspace root.
 *
 * Direct dependencies of @opensip-tools/cli are always loaded by the
 * CLI's own import statements; this discovery exists so a user can
 * install a third-party tool via `npm install` and have it picked up
 * with no further wiring.
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { logger } from '../lib/logger.js';

import { resolvePackageEntryPoint } from './package-entry.js';

const TOOL_KIND = 'tool';

export interface ToolPackageDiscoveryOptions {
  /** Absolute path to the project root. */
  readonly projectDir: string;
}

export interface DiscoveredToolPackage {
  /** npm package name, e.g. '@opensip-tools/fitness' or '@my-co/audit'. */
  readonly name: string;
  /** Absolute path to the package's directory inside node_modules. */
  readonly packageDir: string;
}

/**
 * Walk up from `projectDir` looking for `node_modules/` directories.
 * For each one, scan top-level entries (and one level into scoped
 * directories like `@opensip-tools/`) for packages declaring
 * `opensipTools.kind === 'tool'`. Return the deduplicated list.
 *
 * Same-named packages are returned once — the first occurrence walking
 * from `projectDir` outward wins, matching Node's nearest-ancestor
 * resolution behavior.
 */
export function discoverToolPackages(
  options: ToolPackageDiscoveryOptions,
): DiscoveredToolPackage[] {
  const { projectDir } = options;
  const seen = new Set<string>();
  const out: DiscoveredToolPackage[] = [];
  let dir = projectDir;
  let prev = '';
  while (dir !== prev) {
    const nodeModules = join(dir, 'node_modules');
    if (existsSync(nodeModules)) {
      collectFromNodeModules(nodeModules, seen, out);
    }
    prev = dir;
    dir = dirname(dir);
  }
  return out;
}

// eslint-disable-next-line sonarjs/cognitive-complexity -- node_modules walker: handles both flat and @scope/* layouts and skips invalid entries inline
function collectFromNodeModules(
  nodeModulesDir: string,
  seen: Set<string>,
  out: DiscoveredToolPackage[],
): void {
  for (const entry of safeReaddir(nodeModulesDir)) {
    if (entry.startsWith('.')) continue;
    const entryPath = join(nodeModulesDir, entry);
    if (entry.startsWith('@')) {
      // Scoped — descend one level
      for (const scopedEntry of safeReaddir(entryPath)) {
        if (scopedEntry.startsWith('.')) continue;
        const name = `${entry}/${scopedEntry}`;
        if (seen.has(name)) continue;
        const pkgDir = join(entryPath, scopedEntry);
        if (isToolPackage(pkgDir)) {
          seen.add(name);
          out.push({ name, packageDir: pkgDir });
        }
      }
      continue;
    }
    if (seen.has(entry)) continue;
    if (isToolPackage(entryPath)) {
      seen.add(entry);
      out.push({ name: entry, packageDir: entryPath });
    }
  }
}

function isToolPackage(packageDir: string): boolean {
  const pkgJsonPath = join(packageDir, 'package.json');
  if (!existsSync(pkgJsonPath)) return false;
  try {
    const pkg = JSON.parse(readFileSync(pkgJsonPath, 'utf8')) as {
      opensipTools?: { kind?: string };
    };
    return pkg.opensipTools?.kind === TOOL_KIND;
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    logger.debug({
      evt: 'core.tool_discovery.read_failed',
      module: 'core:plugins',
      packageDir,
      error: msg,
    });
    return false;
  }
}

function safeReaddir(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

/**
 * Read `name` and the resolved main entry of a discovered tool package.
 * Mirrors readCheckPackageMetadata in shape but is exposed at the kernel
 * level so any consumer (CLI, tests, future tooling) can resolve a tool
 * package without depending on fitness.
 */
export interface ToolPackageMetadata {
  readonly name: string;
  readonly mainEntry: string;
}

export function readToolPackageMetadata(packageDir: string): ToolPackageMetadata | undefined {
  const resolved = resolvePackageEntryPoint(packageDir);
  if (!resolved) return undefined;
  return { name: resolved.name, mainEntry: resolved.entry };
}
