/**
 * Stage 0 discovery (discover.ts).
 *
 * Covers tsconfig resolution (default path, explicit relative override,
 * explicit ABSOLUTE override), the missing-config error, and the
 * TypeScript-family source filter (drops declarations and non-source files,
 * dedups, sorts).
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { discoverFiles } from '../discover.js';

const TSCONFIG = JSON.stringify({
  compilerOptions: {
    target: 'ES2022',
    module: 'Node16',
    moduleResolution: 'Node16',
    strict: true,
    rootDir: '.',
  },
  include: ['**/*.ts', '**/*.tsx'],
});

describe('discoverFiles', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'graph-ts-discover-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('resolves the default tsconfig.json and returns project source files', () => {
    writeFileSync(join(dir, 'tsconfig.json'), TSCONFIG, 'utf8');
    writeFileSync(join(dir, 'a.ts'), 'export const a = 1;\n', 'utf8');
    writeFileSync(join(dir, 'b.tsx'), 'export const b = 2;\n', 'utf8');

    const out = discoverFiles({ projectDir: dir });
    expect(out.tsConfigPathAbs.endsWith('tsconfig.json')).toBe(true);
    expect(out.files.some((f) => f.endsWith('a.ts'))).toBe(true);
    expect(out.files.some((f) => f.endsWith('b.tsx'))).toBe(true);
  });

  it('drops .d.ts files and non-TypeScript files from the source set', () => {
    writeFileSync(join(dir, 'tsconfig.json'), TSCONFIG, 'utf8');
    writeFileSync(join(dir, 'keep.ts'), 'export const k = 1;\n', 'utf8');
    writeFileSync(join(dir, 'types.d.ts'), 'export declare const t: number;\n', 'utf8');
    writeFileSync(join(dir, 'readme.md'), '# not a source file\n', 'utf8');
    writeFileSync(join(dir, 'data.json'), '{}\n', 'utf8');

    const out = discoverFiles({ projectDir: dir });
    expect(out.files.some((f) => f.endsWith('keep.ts'))).toBe(true);
    expect(out.files.some((f) => f.endsWith('.d.ts'))).toBe(false);
    expect(out.files.some((f) => f.endsWith('.md'))).toBe(false);
    expect(out.files.some((f) => f.endsWith('.json'))).toBe(false);
  });

  it('admits every TypeScript and allowJs source extension handled by the adapter', () => {
    writeFileSync(
      join(dir, 'tsconfig.json'),
      JSON.stringify({
        compilerOptions: {
          allowJs: true,
          target: 'ES2022',
          module: 'NodeNext',
          moduleResolution: 'NodeNext',
        },
        include: ['**/*'],
      }),
      'utf8',
    );
    for (const file of ['a.ts', 'b.tsx', 'c.mts', 'd.cts', 'e.js', 'f.jsx', 'g.mjs', 'h.cjs']) {
      writeFileSync(join(dir, file), 'export const value = 1;\n', 'utf8');
    }
    writeFileSync(join(dir, 'types.d.mts'), 'export declare const value: number;\n', 'utf8');
    writeFileSync(join(dir, 'types.d.cts'), 'export declare const value: number;\n', 'utf8');

    const out = discoverFiles({ projectDir: dir });
    const names = out.files.map((file) => relative(out.projectDirAbs, file));

    expect(names).toEqual(['a.ts', 'b.tsx', 'c.mts', 'd.cts', 'e.js', 'f.jsx', 'g.mjs', 'h.cjs']);
  });

  it('accepts an explicit RELATIVE tsConfigPath override', () => {
    writeFileSync(join(dir, 'custom.tsconfig.json'), TSCONFIG, 'utf8');
    writeFileSync(join(dir, 'a.ts'), 'export const a = 1;\n', 'utf8');

    const out = discoverFiles({ projectDir: dir, tsConfigPath: 'custom.tsconfig.json' });
    expect(out.tsConfigPathAbs.endsWith('custom.tsconfig.json')).toBe(true);
    expect(out.files.some((f) => f.endsWith('a.ts'))).toBe(true);
  });

  it('accepts an explicit ABSOLUTE tsConfigPath override', () => {
    const absConfig = join(dir, 'abs.tsconfig.json');
    writeFileSync(absConfig, TSCONFIG, 'utf8');
    writeFileSync(join(dir, 'a.ts'), 'export const a = 1;\n', 'utf8');

    const out = discoverFiles({ projectDir: dir, tsConfigPath: absConfig });
    expect(out.tsConfigPathAbs.endsWith('abs.tsconfig.json')).toBe(true);
  });

  it('uses the registered not-found definition without exposing the absolute path', () => {
    // No tsconfig.json written into `dir`.
    expect(() => discoverFiles({ projectDir: dir })).toThrow(
      expect.objectContaining({
        code: 'GRAPH.TSCONFIG.NOT_FOUND',
        message: 'TypeScript configuration was not found.',
      }),
    );
  });

  it('uses the registered validation definition for malformed JSON', () => {
    writeFileSync(join(dir, 'tsconfig.json'), '{"compilerOptions": {', 'utf8');

    expect(() => discoverFiles({ projectDir: dir })).toThrow(
      expect.objectContaining({
        code: 'GRAPH.TSCONFIG.INVALID',
        message: 'TypeScript configuration is invalid.',
      }),
    );
  });

  it('classifies a non-file config anchor at the config-load boundary', () => {
    mkdirSync(join(dir, 'tsconfig.json'));

    expect(() => discoverFiles({ projectDir: dir })).toThrow(
      expect.objectContaining({
        code: 'GRAPH.TSCONFIG.LOAD_FAILED',
        message: 'TypeScript configuration is not a regular file.',
      }),
    );
  });

  it('does not silently treat an unreadable extends target as absent', () => {
    writeFileSync(join(dir, 'tsconfig.json'), '{"extends":"./base.json"}', 'utf8');
    mkdirSync(join(dir, 'base.json'));

    expect(() => discoverFiles({ projectDir: dir })).toThrow(
      expect.objectContaining({ code: 'GRAPH.TSCONFIG.LOAD_FAILED' }),
    );
  });
});
