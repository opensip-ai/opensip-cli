import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { walkTypeScriptFiles } from '../lib/walk-typescript-files.js';

const roots: string[] = [];

function makeFixtureTree(): string {
  const root = mkdtempSync(join(tmpdir(), 'opensip-yagni-walk-'));
  roots.push(root);
  for (const dir of [
    'src',
    'src/__tests__',
    'src/__tests__/fixtures',
    'src/__tests__/__fixtures__',
  ]) {
    mkdirSync(join(root, dir), { recursive: true });
  }
  for (const file of [
    'src/index.ts',
    'src/view.tsx',
    'src/types.d.ts',
    'src/module.mts',
    'src/common.cts',
    'src/__tests__/unit.test.ts',
    'src/__tests__/fixtures/sample.ts',
    'src/__tests__/__fixtures__/golden.ts',
  ]) {
    writeFileSync(join(root, file), 'export const value = 1;\n');
  }
  return root;
}

function rel(root: string, files: readonly string[]): string[] {
  return files.map((file) => relative(root, file).split('\\').join('/')).sort();
}

describe('walkTypeScriptFiles', () => {
  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  it('excludes tests and fixtures unless includeTests is enabled', () => {
    const root = makeFixtureTree();

    expect(rel(root, walkTypeScriptFiles(root, false))).toEqual([
      'src/common.cts',
      'src/index.ts',
      'src/module.mts',
      'src/types.d.ts',
      'src/view.tsx',
    ]);
    expect(rel(root, walkTypeScriptFiles(root, true))).toEqual([
      'src/__tests__/__fixtures__/golden.ts',
      'src/__tests__/fixtures/sample.ts',
      'src/__tests__/unit.test.ts',
      'src/common.cts',
      'src/index.ts',
      'src/module.mts',
      'src/types.d.ts',
      'src/view.tsx',
    ]);
  });

  it('walks every source extension handled by the TypeScript language family', () => {
    const root = mkdtempSync(join(tmpdir(), 'opensip-yagni-walk-'));
    roots.push(root);
    mkdirSync(join(root, 'src'), { recursive: true });
    for (const file of [
      'a.ts',
      'b.tsx',
      'c.mts',
      'd.cts',
      'e.js',
      'f.jsx',
      'g.mjs',
      'h.cjs',
      'ignored.test.js',
      'ignored.spec.mjs',
    ]) {
      writeFileSync(join(root, 'src', file), 'export const value = 1;\n');
    }

    expect(rel(root, walkTypeScriptFiles(root, false))).toEqual([
      'src/a.ts',
      'src/b.tsx',
      'src/c.mts',
      'src/d.cts',
      'src/e.js',
      'src/f.jsx',
      'src/g.mjs',
      'src/h.cjs',
    ]);
    expect(rel(root, walkTypeScriptFiles(root, true))).toEqual([
      'src/a.ts',
      'src/b.tsx',
      'src/c.mts',
      'src/d.cts',
      'src/e.js',
      'src/f.jsx',
      'src/g.mjs',
      'src/h.cjs',
      'src/ignored.spec.mjs',
      'src/ignored.test.js',
    ]);
  });

  it('returns each file once when requested roots overlap', () => {
    const root = mkdtempSync(join(tmpdir(), 'opensip-yagni-walk-'));
    roots.push(root);
    const src = join(root, 'src');
    const nested = join(src, 'nested');
    mkdirSync(nested, { recursive: true });
    writeFileSync(join(src, 'root.ts'), 'export const root = true;\n');
    writeFileSync(join(nested, 'child.ts'), 'export const child = true;\n');

    expect(rel(root, walkTypeScriptFiles(root, true, [src, nested, src]))).toEqual([
      'src/nested/child.ts',
      'src/root.ts',
    ]);
  });
});
