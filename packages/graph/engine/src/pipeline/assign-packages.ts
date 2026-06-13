/**
 * Package assignment — post-walk catalog pass.
 *
 * Stamps every occurrence with the package it belongs to, so the coupling
 * grid and the cross-package edge constraint bucket by real package boundary
 * rather than a path heuristic. The package label is the `name` of the
 * occurrence's **nearest enclosing `package.json`** (walking up from the
 * file's directory to the project root), e.g. `@opensip-cli/fitness`. When
 * no manifest is found, it falls back to the file's top-level path segment
 * (so `apps/`, `libs/`, `src/`, `crates/`, Go-module repos still bucket
 * sensibly instead of collapsing to one `<unknown>`).
 *
 * This runs in the engine (filesystem available); the dashboard has none, so
 * it reads the stamped `occurrence.package` straight from the catalog.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { logger, withSpan } from '@opensip-cli/core';

import type { Catalog, FunctionOccurrence } from '../types.js';

const UNKNOWN = '<unknown>';

export function assignPackages(catalog: Catalog, projectRoot: string): Catalog {
  return withSpan(
    'opensip-cli-graph',
    'graph.assign_packages',
    () => {
      const nameByDir = new Map<string, string | null>();
      const labelOf = (filePath: string): string => {
        const nearest = nearestManifestName(dirOf(filePath), projectRoot, nameByDir);
        if (nearest !== null) return nearest;
        const seg = filePath.split('/')[0];
        return seg && seg !== filePath ? seg : UNKNOWN;
      };

      const functions: Record<string, FunctionOccurrence[]> = {};
      for (const [name, occs] of Object.entries(catalog.functions)) {
        functions[name] = occs.map((occ) => ({ ...occ, package: labelOf(occ.filePath) }));
      }
      return { ...catalog, functions };
    },
    { 'graph.assign_packages.project': projectRoot }
  );
}

/** Project-relative posix directory of a file ('' for a root-level file). */
function dirOf(filePath: string): string {
  const slash = filePath.lastIndexOf('/');
  return slash === -1 ? '' : filePath.slice(0, slash);
}

function parentOf(dir: string): string {
  const slash = dir.lastIndexOf('/');
  return slash === -1 ? '' : dir.slice(0, slash);
}

/**
 * The `name` of the nearest `package.json` at or above `dir` (project-relative),
 * or null if none up to the root. Memoized per directory so the upward walk
 * runs once per distinct directory across the whole catalog.
 */
function nearestManifestName(
  dir: string,
  projectRoot: string,
  memo: Map<string, string | null>,
): string | null {
  const cached = memo.get(dir);
  if (cached !== undefined) return cached;

  const name = readManifestName(join(projectRoot, dir, 'package.json'));
  let result: string | null;
  if (name !== null) result = name;
  else if (dir === '') result = null;
  else result = nearestManifestName(parentOf(dir), projectRoot, memo);

  memo.set(dir, result);
  return result;
}

function readManifestName(pkgJsonPath: string): string | null {
  // No manifest here is the common, expected case (keep walking up) — not an
  // error, so check rather than catch. Only a present-but-unreadable manifest
  // is noteworthy.
  if (!existsSync(pkgJsonPath)) return null;
  try {
    const parsed = JSON.parse(readFileSync(pkgJsonPath, 'utf8')) as { name?: unknown };
    return typeof parsed.name === 'string' && parsed.name.length > 0 ? parsed.name : null;
  } catch (error) {
    logger.debug({
      evt: 'graph.assign_packages.manifest_unreadable',
      module: 'graph:assign-packages',
      path: pkgJsonPath,
      err: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}
