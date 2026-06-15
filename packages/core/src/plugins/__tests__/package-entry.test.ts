/**
 * @fileoverview Tests for `resolvePackageEntryPoint`.
 *
 * Covers the three documented `exports` shapes (string, object with
 * string `.`, object with conditioned `.`), the `pkg.main` fallback,
 * the `./index.js` fallback, and the absent / malformed cases.
 */

import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import { resolvePackageEntryPoint } from '../package-entry.js';

let testDir: string;

beforeEach(() => {
  testDir = mkdtempSync(join(tmpdir(), 'opensip-package-entry-test-'));
});

afterEach(() => {
  rmSync(testDir, { recursive: true, force: true });
});

function writePkg(json: object): string {
  const dir = join(testDir, 'pkg');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'package.json'), JSON.stringify(json));
  return dir;
}

describe('resolvePackageEntryPoint', () => {
  it('returns undefined when package.json is missing', () => {
    const dir = join(testDir, 'absent');
    mkdirSync(dir, { recursive: true });
    expect(resolvePackageEntryPoint(dir)).toBeUndefined();
  });

  it('returns undefined when package.json is malformed JSON', () => {
    const dir = join(testDir, 'pkg');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'package.json'), '{not json');
    expect(resolvePackageEntryPoint(dir)).toBeUndefined();
  });

  it('returns undefined when pkg.name is missing and no fallback supplied', () => {
    const dir = writePkg({ main: './main.js' });
    expect(resolvePackageEntryPoint(dir)).toBeUndefined();
  });

  it('uses the supplied fallback name when pkg.name is missing', () => {
    const dir = writePkg({ main: './main.js' });
    const r = resolvePackageEntryPoint(dir, 'fallback-name');
    expect(r?.name).toBe('fallback-name');
    expect(r?.entry).toBe(join(dir, './main.js'));
  });

  it('resolves a string `exports` value', () => {
    const dir = writePkg({ name: 'p', exports: './dist/index.js' });
    const r = resolvePackageEntryPoint(dir);
    expect(r).toMatchObject({
      name: 'p',
      entry: join(dir, './dist/index.js'),
      rawEntry: './dist/index.js',
    });
  });

  it('resolves an `exports[".]` string value', () => {
    const dir = writePkg({ name: 'p', exports: { '.': './dist/main.js' } });
    const r = resolvePackageEntryPoint(dir);
    expect(r?.entry).toBe(join(dir, './dist/main.js'));
  });

  it('prefers `import` over `default` in conditioned exports', () => {
    const dir = writePkg({
      name: 'p',
      exports: { '.': { import: './esm.js', default: './cjs.js' } },
    });
    const r = resolvePackageEntryPoint(dir);
    expect(r?.entry).toBe(join(dir, './esm.js'));
  });

  it('falls back to `default` when `import` is absent', () => {
    const dir = writePkg({
      name: 'p',
      exports: { '.': { default: './fallback.js' } },
    });
    const r = resolvePackageEntryPoint(dir);
    expect(r?.entry).toBe(join(dir, './fallback.js'));
  });

  it('falls back to `node` when neither `import` nor `default` is present', () => {
    const dir = writePkg({
      name: 'p',
      exports: { '.': { node: './node-entry.js' } },
    });
    const r = resolvePackageEntryPoint(dir);
    expect(r?.entry).toBe(join(dir, './node-entry.js'));
  });

  it('falls back to pkg.main when conditioned exports has no recognised condition', () => {
    const dir = writePkg({
      name: 'p',
      main: './main.js',
      exports: { '.': { types: './types.d.ts' } },
    });
    const r = resolvePackageEntryPoint(dir);
    expect(r?.entry).toBe(join(dir, './main.js'));
  });

  it('falls back to pkg.main when exports `.` is a non-string, non-object value', () => {
    const dir = writePkg({ name: 'p', main: './main.js', exports: { '.': 123 } });
    const r = resolvePackageEntryPoint(dir);
    expect(r?.entry).toBe(join(dir, './main.js'));
  });

  it('falls back to pkg.main when exports is absent', () => {
    const dir = writePkg({ name: 'p', main: './lib/main.js' });
    const r = resolvePackageEntryPoint(dir);
    expect(r?.entry).toBe(join(dir, './lib/main.js'));
  });

  it('falls back to ./index.js when neither exports nor main is set', () => {
    const dir = writePkg({ name: 'p' });
    const r = resolvePackageEntryPoint(dir);
    expect(r?.rawEntry).toBe('./index.js');
    expect(r?.entry).toBe(join(dir, './index.js'));
  });

  it('falls back to pkg.main when exports has no `.` key', () => {
    const dir = writePkg({ name: 'p', main: './main.js', exports: { './sub': './sub.js' } });
    const r = resolvePackageEntryPoint(dir);
    expect(r?.entry).toBe(join(dir, './main.js'));
  });
});
