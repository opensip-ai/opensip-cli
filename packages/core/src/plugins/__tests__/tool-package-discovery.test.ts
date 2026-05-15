import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { discoverToolPackages, readToolPackageMetadata } from '../tool-package-discovery.js';

let testDir: string;

function writePkg(dir: string, json: object): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'package.json'), JSON.stringify(json));
}

beforeEach(() => {
   
  testDir = mkdtempSync(join(tmpdir(), 'opensip-tool-discover-'));
});

afterEach(() => {
  rmSync(testDir, { recursive: true, force: true });
});

describe('discoverToolPackages', () => {
  it('returns an empty list when node_modules is missing', () => {
    expect(discoverToolPackages({ projectDir: testDir })).toEqual([]);
  });

  it('finds an unscoped package marked as a tool', () => {
    writePkg(join(testDir, 'node_modules', 'audit'), {
      name: 'audit',
      opensipTools: { kind: 'tool' },
    });
    const out = discoverToolPackages({ projectDir: testDir });
    expect(out.map((t) => t.name)).toEqual(['audit']);
  });

  it('finds a scoped package marked as a tool', () => {
    writePkg(join(testDir, 'node_modules', '@opensip-tools', 'fitness'), {
      name: '@opensip-tools/fitness',
      opensipTools: { kind: 'tool' },
    });
    const out = discoverToolPackages({ projectDir: testDir });
    expect(out.map((t) => t.name)).toEqual(['@opensip-tools/fitness']);
  });

  it('skips packages that are not marked as tools', () => {
    writePkg(join(testDir, 'node_modules', 'random-pkg'), { name: 'random-pkg' });
    expect(discoverToolPackages({ projectDir: testDir })).toEqual([]);
  });

  it('skips dot-prefixed entries (.bin, .pnpm, etc.)', () => {
    writePkg(join(testDir, 'node_modules', '.bin', 'fake-tool'), {
      name: 'fake-tool',
      opensipTools: { kind: 'tool' },
    });
    expect(discoverToolPackages({ projectDir: testDir })).toEqual([]);
  });

  it('walks ancestor node_modules and dedupes by package name', () => {
    const nested = join(testDir, 'project');
    mkdirSync(nested, { recursive: true });

    writePkg(join(testDir, 'node_modules', '@opensip-tools', 'fitness'), {
      name: '@opensip-tools/fitness',
      opensipTools: { kind: 'tool' },
    });
    writePkg(join(nested, 'node_modules', '@opensip-tools', 'fitness'), {
      name: '@opensip-tools/fitness',
      opensipTools: { kind: 'tool' },
    });

    const out = discoverToolPackages({ projectDir: nested });
    expect(out).toHaveLength(1);
    // Nearest-ancestor wins: the inner copy
    expect(out[0]?.packageDir).toBe(join(nested, 'node_modules', '@opensip-tools', 'fitness'));
  });

  it('treats malformed package.json as non-tool (no crash)', () => {
    const dir = join(testDir, 'node_modules', 'broken');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'package.json'), '{not-json');
    expect(discoverToolPackages({ projectDir: testDir })).toEqual([]);
  });
});

describe('readToolPackageMetadata', () => {
  let pkgDir: string;
  beforeEach(() => {
    pkgDir = join(testDir, 'pkg');
    mkdirSync(pkgDir, { recursive: true });
  });

  it('returns undefined when package.json is missing', () => {
    expect(readToolPackageMetadata(pkgDir)).toBeUndefined();
  });

  it('returns undefined when package.json is malformed', () => {
    writeFileSync(join(pkgDir, 'package.json'), '{');
    expect(readToolPackageMetadata(pkgDir)).toBeUndefined();
  });

  it('returns undefined when name is missing', () => {
    writeFileSync(join(pkgDir, 'package.json'), JSON.stringify({}));
    expect(readToolPackageMetadata(pkgDir)).toBeUndefined();
  });

  it('falls back to ./index.js when no exports or main are declared', () => {
    writeFileSync(join(pkgDir, 'package.json'), JSON.stringify({ name: 'pkg' }));
    expect(readToolPackageMetadata(pkgDir)).toEqual({
      name: 'pkg',
      mainEntry: join(pkgDir, './index.js'),
    });
  });

  it('uses pkg.main when declared', () => {
    writeFileSync(join(pkgDir, 'package.json'), JSON.stringify({ name: 'pkg', main: './lib/main.js' }));
    expect(readToolPackageMetadata(pkgDir)?.mainEntry).toBe(join(pkgDir, './lib/main.js'));
  });

  it('uses string-form exports when declared', () => {
    writeFileSync(
      join(pkgDir, 'package.json'),
      JSON.stringify({ name: 'pkg', exports: './dist/index.js' }),
    );
    expect(readToolPackageMetadata(pkgDir)?.mainEntry).toBe(join(pkgDir, './dist/index.js'));
  });

  it('uses object-form exports["."]', () => {
    writeFileSync(
      join(pkgDir, 'package.json'),
      JSON.stringify({ name: 'pkg', exports: { '.': './dist/dot.js' } }),
    );
    expect(readToolPackageMetadata(pkgDir)?.mainEntry).toBe(join(pkgDir, './dist/dot.js'));
  });

  it('uses exports["."]["import"] when present', () => {
    writeFileSync(
      join(pkgDir, 'package.json'),
      JSON.stringify({
        name: 'pkg',
        exports: { '.': { import: './dist/import.js', default: './dist/default.js' } },
      }),
    );
    expect(readToolPackageMetadata(pkgDir)?.mainEntry).toBe(join(pkgDir, './dist/import.js'));
  });

  it('falls back to exports["."]["default"] when import is absent', () => {
    writeFileSync(
      join(pkgDir, 'package.json'),
      JSON.stringify({
        name: 'pkg',
        exports: { '.': { default: './dist/default.js' } },
      }),
    );
    expect(readToolPackageMetadata(pkgDir)?.mainEntry).toBe(join(pkgDir, './dist/default.js'));
  });
});
