import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { assignPackages } from '../assign-packages.js';

import type { Catalog, FunctionOccurrence } from '../../types.js';

let root: string;

function manifest(relDir: string, name: string): void {
  const dir = join(root, relDir);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name }), 'utf8');
}

function occ(filePath: string): FunctionOccurrence {
  return {
    bodyHash: filePath, simpleName: 'f', qualifiedName: `${filePath}.f`, filePath,
    line: 1, column: 0, endLine: 2, kind: 'function-declaration', params: [],
    returnType: null, enclosingClass: null, decorators: [], visibility: 'exported',
    inTestFile: false, definedInGenerated: false, calls: [],
  };
}

function catalogOf(filePaths: string[]): Catalog {
  return {
    version: '3.0', tool: 'graph', language: 'typescript', builtAt: 'x', cacheKey: 'k',
    functions: { f: filePaths.map(occ) },
  };
}

/** package label assigned to each filePath. */
function labels(filePaths: string[]): Record<string, string | undefined> {
  const out = assignPackages(catalogOf(filePaths), root);
  return Object.fromEntries(out.functions.f.map((o) => [o.filePath, o.package]));
}

beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'opensip-ap-')); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

describe('assignPackages', () => {
  it('stamps each occurrence with its nearest package.json name', () => {
    manifest('packages/fitness/engine', '@s/fitness');
    manifest('packages/core', '@s/core');
    const l = labels([
      'packages/fitness/engine/src/checks/x.ts',
      'packages/core/src/y.ts',
    ]);
    expect(l['packages/fitness/engine/src/checks/x.ts']).toBe('@s/fitness');
    expect(l['packages/core/src/y.ts']).toBe('@s/core');
  });

  it('uses the NEAREST manifest when packages are nested', () => {
    manifest('packages/fitness/engine', '@s/fitness');
    manifest('packages/fitness/engine/plugin', '@s/plugin');
    const l = labels([
      'packages/fitness/engine/src/a.ts',
      'packages/fitness/engine/plugin/src/b.ts',
    ]);
    expect(l['packages/fitness/engine/src/a.ts']).toBe('@s/fitness');
    expect(l['packages/fitness/engine/plugin/src/b.ts']).toBe('@s/plugin');
  });

  it('falls back to the top-level path segment when there is no manifest', () => {
    manifest('packages/core', '@s/core'); // unrelated; no root manifest, no apps manifest
    const l = labels(['apps/web/src/main.ts', 'scripts/build.ts']);
    expect(l['apps/web/src/main.ts']).toBe('apps');
    expect(l['scripts/build.ts']).toBe('scripts');
  });

  it('maps every file to the root package in a single-package repo', () => {
    manifest('', '@s/app'); // root manifest only
    const l = labels(['src/a.ts', 'lib/b.ts']);
    expect(l['src/a.ts']).toBe('@s/app');
    expect(l['lib/b.ts']).toBe('@s/app');
  });

  it('returns <unknown> for a root-level file with no manifest anywhere', () => {
    const l = labels(['solo.ts']);
    expect(l['solo.ts']).toBe('<unknown>');
  });
});
