import { existsSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';

import type { WorkspaceUnit } from '@opensip-cli/core';

const PACKAGES_SEARCH_ROOT = 'packages';
const SEARCH_MAX_DEPTH = 3;

/**
 * Walk <rootDir>/packages/** for directories containing tsconfig.json.
 * Each match becomes a WorkspaceUnit. Behavior matches the legacy
 * `discoverWorkspacePackages` in graph's scope.ts which this replaces.
 *
 * Returns absolute paths, sorted lexicographically.
 *
 * The unit `id` is the unit's path RELATIVE to <rootDir>/packages, in POSIX
 * form (e.g. `fitness/engine`, `graph/engine`, `core`). It must be unique and
 * stable: a bare `basename(dir)` collapses nested packages that share a leaf
 * name (this monorepo has `fitness/engine`, `graph/engine`, and
 * `simulation/engine` — three distinct packages all named `engine`). The id is
 * the shard id (graph's per-shard fragment-cache PRIMARY KEY), so a collision
 * silently overwrites cache rows and breaks build determinism. The
 * root-relative path restores a 1:1 id↔unit mapping.
 */
// eslint-disable-next-line @typescript-eslint/require-await
export async function discoverTypescriptWorkspaceUnits(
  rootDir: string,
): Promise<readonly WorkspaceUnit[]> {
  const root = resolve(rootDir, PACKAGES_SEARCH_ROOT);
  if (!existsSync(root) || !safeIsDir(root)) return [];
  const out: WorkspaceUnit[] = [];
  walk(root, 0);
  out.sort((a, b) => a.rootDir.localeCompare(b.rootDir));
  return out;

  function walk(dir: string, depth: number): void {
    if (depth > SEARCH_MAX_DEPTH) return;
    const tsconfigPath = join(dir, 'tsconfig.json');
    if (existsSync(tsconfigPath)) {
      out.push({
        id: unitId(root, dir),
        rootDir: dir,
        configPath: tsconfigPath,
      });
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

/**
 * Derive a unique, stable unit id: the directory's path relative to the
 * packages root, normalized to POSIX separators (so ids are identical on
 * Windows and POSIX). E.g. `<root>/packages/fitness/engine` → `fitness/engine`.
 */
function unitId(packagesRoot: string, dir: string): string {
  return relative(packagesRoot, dir).split(sep).join('/');
}

function safeIsDir(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}
