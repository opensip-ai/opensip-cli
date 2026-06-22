import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { _resetPublicApiGraphCache, isInPublicApiSurface } from '../public-api-surface.js';

function tempPackage(): string {
  const dir = mkdtempSync(join(tmpdir(), 'opensip-public-api-surface-'));
  mkdirSync(join(dir, 'src'), { recursive: true });
  return dir;
}

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

describe('public API surface discovery', () => {
  it('maps package export targets to source and follows local re-export chains only', () => {
    const root = tempPackage();
    try {
      mkdirSync(join(root, 'src', 'dir'), { recursive: true });
      writeJson(join(root, 'package.json'), {
        name: 'fixture-public-api',
        exports: {
          '.': {
            types: './dist/index.d.ts',
            default: './dist/index.js',
          },
          './alt': ['./build/alt.cjs', './dist/*.js'],
          './direct': './src/direct.ts',
        },
      });
      writeFileSync(
        join(root, 'src', 'index.ts'),
        [
          "export { PublicThing } from './public.js';",
          "export type { PublicType } from './types.mjs';",
          "export * from './dir';",
          "export * as external from 'external-package';",
          "import './private.js';",
        ].join('\n'),
      );
      writeFileSync(join(root, 'src', 'public.ts'), "export { Nested } from './nested.cjs';\n");
      writeFileSync(join(root, 'src', 'types.mts'), 'export interface PublicType {}\n');
      writeFileSync(join(root, 'src', 'nested.cts'), 'export const Nested = 1;\n');
      writeFileSync(join(root, 'src', 'dir', 'index.ts'), 'export const FromDir = 1;\n');
      writeFileSync(join(root, 'src', 'alt.cts'), 'export const Alt = 1;\n');
      writeFileSync(join(root, 'src', 'direct.ts'), 'export const Direct = 1;\n');
      writeFileSync(join(root, 'src', 'private.ts'), 'export const Private = 1;\n');

      _resetPublicApiGraphCache();
      expect(isInPublicApiSurface(join(root, 'src', 'index.ts'))).toBe(true);
      expect(isInPublicApiSurface(join(root, 'src', 'public.ts'))).toBe(true);
      expect(isInPublicApiSurface(join(root, 'src', 'types.mts'))).toBe(true);
      expect(isInPublicApiSurface(join(root, 'src', 'nested.cts'))).toBe(true);
      expect(isInPublicApiSurface(join(root, 'src', 'dir', 'index.ts'))).toBe(true);
      expect(isInPublicApiSurface(join(root, 'src', 'alt.cts'))).toBe(true);
      expect(isInPublicApiSurface(join(root, 'src', 'direct.ts'))).toBe(true);
      expect(isInPublicApiSurface(join(root, 'src', 'private.ts'))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
      _resetPublicApiGraphCache();
    }
  });

  it('uses main/module fallback entries when exports is absent', () => {
    const root = tempPackage();
    try {
      writeJson(join(root, 'package.json'), {
        name: 'fixture-main-module',
        main: './dist/main.js',
        module: './build/module.js',
      });
      writeFileSync(join(root, 'src', 'main.ts'), 'export const main = 1;\n');
      writeFileSync(join(root, 'src', 'module.tsx'), 'export const Module = () => null;\n');
      writeFileSync(join(root, 'src', 'hidden.ts'), 'export const hidden = 1;\n');

      _resetPublicApiGraphCache();
      expect(isInPublicApiSurface(join(root, 'src', 'main.ts'))).toBe(true);
      expect(isInPublicApiSurface(join(root, 'src', 'module.tsx'))).toBe(true);
      expect(isInPublicApiSurface(join(root, 'src', 'hidden.ts'))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
      _resetPublicApiGraphCache();
    }
  });

  it('treats binary-only packages as having no public source surface', () => {
    const root = tempPackage();
    try {
      writeJson(join(root, 'package.json'), {
        name: 'fixture-binary',
        bin: { fixture: './dist/cli.js' },
      });
      writeFileSync(join(root, 'src', 'cli.ts'), 'export const run = 1;\n');

      _resetPublicApiGraphCache();
      expect(isInPublicApiSurface(join(root, 'src', 'cli.ts'))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
      _resetPublicApiGraphCache();
    }
  });

  it('fails open when package surface cannot be determined', () => {
    const noPackageRoot = tempPackage();
    const malformedRoot = tempPackage();
    const wildcardRoot = tempPackage();
    try {
      writeFileSync(join(noPackageRoot, 'src', 'file.ts'), 'export const x = 1;\n');
      expect(isInPublicApiSurface(join(noPackageRoot, 'src', 'file.ts'))).toBe(true);

      writeFileSync(join(malformedRoot, 'package.json'), '{not-json');
      writeFileSync(join(malformedRoot, 'src', 'file.ts'), 'export const x = 1;\n');
      _resetPublicApiGraphCache();
      expect(isInPublicApiSurface(join(malformedRoot, 'src', 'file.ts'))).toBe(true);

      writeJson(join(wildcardRoot, 'package.json'), {
        name: 'fixture-wildcard',
        exports: './dist/*.js',
      });
      writeFileSync(join(wildcardRoot, 'src', 'file.ts'), 'export const x = 1;\n');
      _resetPublicApiGraphCache();
      expect(isInPublicApiSurface(join(wildcardRoot, 'src', 'file.ts'))).toBe(true);
    } finally {
      rmSync(noPackageRoot, { recursive: true, force: true });
      rmSync(malformedRoot, { recursive: true, force: true });
      rmSync(wildcardRoot, { recursive: true, force: true });
      _resetPublicApiGraphCache();
    }
  });
});
