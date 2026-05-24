/**
 * Shared helper for the acceptance fixture tests.
 *
 * Each fixture lives in its own __fixtures__/<name>/ directory with a
 * tiny tsconfig.json and a few .ts files. The helper runs stages 0+1+2
 * end-to-end against the fixture and returns the resulting catalog.
 */

import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { discoverFiles } from '../../discover.js';
import { resolveEdges } from '../../edges.js';
import { buildInventory } from '../../inventory.js';

import type { Catalog, FunctionOccurrence } from '@opensip-tools/graph';

export type FixtureFiles = Readonly<Record<string, string>>;

const FIXTURE_TSCONFIG = JSON.stringify({
  compilerOptions: {
    target: 'ES2022',
    module: 'Node16',
    moduleResolution: 'Node16',
    lib: ['ES2022', 'DOM'],
    strict: true,
    esModuleInterop: true,
    skipLibCheck: true,
    jsx: 'preserve',
    rootDir: '.',
  },
  include: ['**/*.ts', '**/*.tsx'],
});

export function writeFixture(rootDir: string, files: FixtureFiles): void {
  rmSync(rootDir, { recursive: true, force: true });
  mkdirSync(rootDir, { recursive: true });
  writeFileSync(join(rootDir, 'tsconfig.json'), FIXTURE_TSCONFIG, 'utf8');
  for (const [rel, content] of Object.entries(files)) {
    const filePath = join(rootDir, rel);
    mkdirSync(filePath.slice(0, Math.max(0, filePath.lastIndexOf('/'))), { recursive: true });
    writeFileSync(filePath, content, 'utf8');
  }
}

export function runFixture(rootDir: string): Catalog {
  const discovery = discoverFiles({ projectDir: rootDir });
  const inv = buildInventory({
    projectDirAbs: discovery.projectDirAbs,
    files: discovery.files,
    compilerOptions: discovery.compilerOptions,
    tsConfigPathAbs: discovery.tsConfigPathAbs,
  });
  const edges = resolveEdges({
    catalog: inv.catalog,
    program: inv.program,
    projectDirAbs: discovery.projectDirAbs,
  });
  return edges.catalog;
}

export function findOccurrence(
  catalog: Catalog,
  predicate: (o: FunctionOccurrence) => boolean,
): FunctionOccurrence | undefined {
  for (const occs of Object.values(catalog.functions)) {
    for (const o of occs) {
      if (predicate(o)) return o;
    }
  }
  return undefined;
}

