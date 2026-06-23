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

    expect(rel(root, walkTypeScriptFiles(root, false))).toEqual(['src/index.ts']);
    expect(rel(root, walkTypeScriptFiles(root, true))).toEqual([
      'src/__tests__/__fixtures__/golden.ts',
      'src/__tests__/fixtures/sample.ts',
      'src/__tests__/unit.test.ts',
      'src/index.ts',
    ]);
  });
});
