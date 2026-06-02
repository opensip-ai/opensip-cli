import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  discoverScopedPackages,
  hasPackageJson,
  resolvePackageDir,
  safeReaddir,
} from '../node-modules-walk.js';

let root: string;

/** Create node_modules/<scope>/<name>/package.json under `base`. */
function installPkg(base: string, scope: string, name: string, withManifest = true): void {
  const dir = join(base, 'node_modules', scope, name);
  mkdirSync(dir, { recursive: true });
  if (withManifest) writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: `${scope}/${name}` }), 'utf8');
}

beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'opensip-nmw-')); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

describe('discoverScopedPackages', () => {
  it('returns prefix-matching packages with a package.json, skipping the rest', () => {
    installPkg(root, '@scope', 'checks-a');           // matches
    installPkg(root, '@scope', 'checks-b', false);    // no package.json → skip
    installPkg(root, '@scope', 'lang-x');             // wrong prefix → skip
    const found = discoverScopedPackages({ projectDir: root, scopes: ['@scope'], prefix: 'checks-' });
    expect(found.map((p) => p.name)).toEqual(['@scope/checks-a']);
    expect(found[0]?.packageDir).toBe(join(root, 'node_modules', '@scope', 'checks-a'));
  });

  it('walks ancestor node_modules and dedupes (nearest wins)', () => {
    installPkg(root, '@scope', 'checks-a');                  // ancestor copy
    const sub = join(root, 'apps', 'web');
    mkdirSync(sub, { recursive: true });
    installPkg(sub, '@scope', 'checks-a');                   // nearer copy (same name)
    installPkg(sub, '@scope', 'checks-near');
    const found = discoverScopedPackages({ projectDir: sub, scopes: ['@scope'], prefix: 'checks-' });
    expect(found.map((p) => p.name).sort()).toEqual(['@scope/checks-a', '@scope/checks-near']);
    // dedup: the nearer (sub) copy of checks-a wins
    expect(found.find((p) => p.name === '@scope/checks-a')?.packageDir).toBe(
      join(sub, 'node_modules', '@scope', 'checks-a'),
    );
  });

  it('returns [] when no scope directory exists', () => {
    expect(discoverScopedPackages({ projectDir: root, scopes: ['@scope'], prefix: 'checks-' })).toEqual([]);
  });
});

describe('resolvePackageDir', () => {
  it('resolves an explicit name by ancestor walk; undefined when absent', () => {
    installPkg(root, '@scope', 'checks-a');
    const sub = join(root, 'a', 'b');
    mkdirSync(sub, { recursive: true });
    expect(resolvePackageDir(sub, '@scope/checks-a')).toBe(join(root, 'node_modules', '@scope', 'checks-a'));
    expect(resolvePackageDir(sub, '@scope/missing')).toBeUndefined();
  });
});

describe('hasPackageJson / safeReaddir', () => {
  it('hasPackageJson is true only when the dir + manifest exist', () => {
    installPkg(root, '@scope', 'checks-a');
    expect(hasPackageJson(join(root, 'node_modules', '@scope', 'checks-a'))).toBe(true);
    expect(hasPackageJson(join(root, 'node_modules', '@scope', 'nope'))).toBe(false);
  });

  it('safeReaddir returns entries, or [] on a missing directory', () => {
    installPkg(root, '@scope', 'checks-a');
    expect(safeReaddir(join(root, 'node_modules', '@scope'))).toContain('checks-a');
    expect(safeReaddir(join(root, 'does', 'not', 'exist'))).toEqual([]);
  });
});
