/**
 * Workspace package name → coupling group map.
 *
 * Maps each workspace package's npm name (e.g. `@opensip-tools/fitness`,
 * `@opensip-tools/lang-typescript`) to its coupling group — the first segment
 * under `packages/` (`fitness`, `languages`). This is the authoritative
 * specifier→group source: the TypeScript resolver points workspace imports at
 * built `dist/*.d.ts` files (outside the catalog), so a module's resolved
 * `dependencies[].to` is empty for every cross-package import. The raw import
 * specifier, mapped through this table, recovers the real import graph.
 *
 * Returns an empty map when there is no `packages/` directory (non-monorepo
 * repos), in which case the edge-constraint pass treats it as "no import data"
 * and is a no-op.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { logger } from '@opensip-tools/core';

import type { Dirent } from 'node:fs';

export function buildPackageGroupMap(projectRoot: string): Map<string, string> {
  const out = new Map<string, string>();
  const packagesDir = join(projectRoot, 'packages');
  for (const groupEntry of safeReaddir(packagesDir)) {
    if (!groupEntry.isDirectory()) continue;
    const group = groupEntry.name;
    const groupDir = join(packagesDir, group);
    // A group dir is itself a package (`packages/core`) or a container of them
    // (`packages/fitness/engine`, `packages/languages/lang-typescript`). Read
    // both levels — every package.json under the group maps to that group.
    addPackage(out, groupDir, group);
    for (const sub of safeReaddir(groupDir)) {
      if (sub.isDirectory()) addPackage(out, join(groupDir, sub.name), group);
    }
  }
  return out;
}

function addPackage(out: Map<string, string>, dir: string, group: string): void {
  const name = readPackageName(join(dir, 'package.json'));
  if (name !== null) out.set(name, group);
}

function readPackageName(pkgJsonPath: string): string | null {
  try {
    const parsed = JSON.parse(readFileSync(pkgJsonPath, 'utf8')) as { name?: unknown };
    return typeof parsed.name === 'string' ? parsed.name : null;
  } catch (error) {
    // Absent/unparseable package.json ⇒ "not a package"; expected for plain
    // directories. Debug-only so it never adds noise on non-monorepo repos.
    logger.debug({ evt: 'graph.package_map.read_skipped', module: 'graph:package-map', path: pkgJsonPath, err: errMessage(error) });
    return null;
  }
}

function safeReaddir(dir: string): Dirent[] {
  try {
    return readdirSync(dir, { withFileTypes: true });
  } catch (error) {
    // Missing directory (e.g. no `packages/` ⇒ non-monorepo); expected.
    logger.debug({ evt: 'graph.package_map.readdir_skipped', module: 'graph:package-map', dir, err: errMessage(error) });
    return [];
  }
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
