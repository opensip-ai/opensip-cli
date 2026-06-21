/**
 * Workspace-invariant contract test: the dependency-cruiser tsconfig paths map
 * (`.config/tsconfig.depcruise.json`) must list EVERY workspace package.
 *
 * That paths map is what makes `@opensip-cli/*` imports resolve into
 * `packages/**\/src` so the cruiser's layer rules actually match. It is
 * hand-maintained, so a newly added package with no entry would silently
 * resolve via its published `exports` to `dist/` — which the cruiser excludes —
 * making every layer rule against that package INERT (no error, just no
 * enforcement). This test fails loudly when a package lacks an entry.
 *
 * Sits beside `release-package-order-contract.test.ts` / `plugin-kind-contract.test.ts`
 * (the home for workspace-invariant tests that read repo files) and resolves the
 * repo root the same way.
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

function findRepoRoot(start: string): string {
  let dir = start;
  let prev = '';
  while (dir !== prev) {
    if (existsSync(join(dir, 'pnpm-workspace.yaml'))) return dir;
    prev = dir;
    dir = dirname(dir);
  }
  throw new Error(`could not locate repo root (pnpm-workspace.yaml) from ${start}`);
}

const REPO_ROOT = findRepoRoot(dirname(fileURLToPath(import.meta.url)));

function readPackageName(pkgJsonPath: string): string {
  return (JSON.parse(readFileSync(pkgJsonPath, 'utf8')) as { name: string }).name;
}

/**
 * Discover every workspace package `name` from `packages/*` and `packages/*\/*`
 * (the two nesting levels declared in `pnpm-workspace.yaml`).
 */
function discoverWorkspacePackageNames(): string[] {
  const names: string[] = [];
  const packagesDir = join(REPO_ROOT, 'packages');
  for (const entry of readdirSync(packagesDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const dir = join(packagesDir, entry.name);
    const direct = join(dir, 'package.json');
    if (existsSync(direct)) {
      names.push(readPackageName(direct));
      continue;
    }
    for (const sub of readdirSync(dir, { withFileTypes: true })) {
      if (!sub.isDirectory()) continue;
      const nested = join(dir, sub.name, 'package.json');
      if (existsSync(nested)) names.push(readPackageName(nested));
    }
  }
  return names;
}

describe('depcruise tsconfig paths ↔ workspace package set', () => {
  it('every workspace package has a paths entry (so its layer rules resolve to src)', () => {
    const tsconfig = JSON.parse(
      readFileSync(join(REPO_ROOT, '.config/tsconfig.depcruise.json'), 'utf8'),
    ) as { compilerOptions: { paths: Record<string, readonly string[]> } };
    const pathKeys = new Set(Object.keys(tsconfig.compilerOptions.paths));

    const missing = discoverWorkspacePackageNames()
      .filter((name) => !pathKeys.has(name))
      .sort();

    expect(
      missing,
      'workspace packages missing a .config/tsconfig.depcruise.json paths entry (their layer rules would be silently inert)',
    ).toEqual([]);
  });
});
