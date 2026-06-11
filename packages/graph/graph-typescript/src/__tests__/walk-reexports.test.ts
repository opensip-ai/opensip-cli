/**
 * Re-export capture (`collectReExports`): the walk records the data the engine's
 * export index needs to follow re-export chains. Covers both TS forms plus the
 * "local definition export is not a re-export" exclusion.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { parseProject } from '../parse.js';
import { walkProgram } from '../walk.js';

import type { ReExportRecord } from '../walk.js';

describe('walkProgram — re-export capture', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'graph-ts-reexp-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function reExportsOf(source: string): ReExportRecord[] {
    const f = join(dir, 'index.ts');
    writeFileSync(f, source, 'utf8');
    const files = [f];
    const parsed = parseProject({ projectDirAbs: dir, files, resolutionMode: 'exact' });
    if (parsed.project.kind !== 'exact') throw new Error('expected exact tier');
    const out = walkProgram({
      sourceFiles: parsed.project.program.getSourceFiles(),
      files,
      projectDirAbs: dir,
    });
    return [...out.reExports].sort((a, b) => a.exportedName.localeCompare(b.exportedName));
  }

  it('captures `export { x, y as z } from spec`', () => {
    expect(reExportsOf(`export { childrenOf, nameOf as renamed } from '@scope/ts';\n`)).toEqual([
      {
        fromFile: 'index.ts',
        exportedName: 'childrenOf',
        sourceName: 'childrenOf',
        specifier: '@scope/ts',
      },
      {
        fromFile: 'index.ts',
        exportedName: 'renamed',
        sourceName: 'nameOf',
        specifier: '@scope/ts',
      },
    ]);
  });

  it('captures the import-then-re-export idiom `export { x }` (no `from`)', () => {
    expect(
      reExportsOf(`import { childrenOf } from '@scope/ts';\nexport { childrenOf };\n`),
    ).toEqual([
      {
        fromFile: 'index.ts',
        exportedName: 'childrenOf',
        sourceName: 'childrenOf',
        specifier: '@scope/ts',
      },
    ]);
  });

  it('captures an aliased import-then-re-export', () => {
    expect(
      reExportsOf(`import { nameOf } from '@scope/ts';\nexport { nameOf as renamed };\n`),
    ).toEqual([
      {
        fromFile: 'index.ts',
        exportedName: 'renamed',
        sourceName: 'nameOf',
        specifier: '@scope/ts',
      },
    ]);
  });

  it('captures `export * from spec`', () => {
    expect(reExportsOf(`export * from '@scope/ts';\n`)).toEqual([
      { fromFile: 'index.ts', exportedName: '*', sourceName: '*', specifier: '@scope/ts' },
    ]);
  });

  it('does NOT treat a local definition export as a re-export', () => {
    expect(reExportsOf(`function localFn() { return 1; }\nexport { localFn };\n`)).toEqual([]);
  });
});
