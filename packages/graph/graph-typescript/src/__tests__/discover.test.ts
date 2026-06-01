/**
 * Stage 0 discovery (discover.ts).
 *
 * Covers tsconfig resolution (default path, explicit relative override,
 * explicit ABSOLUTE override), the missing-config error, and the
 * source-file filter (drops non-.ts/.tsx and .d.ts, dedups, sorts).
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ConfigurationError } from '@opensip-tools/core';
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

  it('throws ConfigurationError when the tsconfig does not exist', () => {
    // No tsconfig.json written into `dir`.
    expect(() => discoverFiles({ projectDir: dir })).toThrow(ConfigurationError);
  });
});
