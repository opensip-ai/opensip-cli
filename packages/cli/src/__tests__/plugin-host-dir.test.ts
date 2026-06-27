/**
 * Tests for plugin/host-dir — the plugin host directory + installed-package
 * introspection helpers extracted from commands/plugin.ts.
 *
 * Every exported helper here is pure filesystem work (create host
 * package.json, read its dependencies, resolve an installed package's real
 * name by spec or by diffing the host deps). The only npm-touching path is
 * `installMissingPeers`, which we exercise in the "all peers already present"
 * and "nothing installed" branches so it never actually shells out — the npm
 * `install` call is the documented best-effort tail and is covered separately
 * by the e2e plugin flow.
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { resolveProjectPaths } from '@opensip-cli/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  HOST_PACKAGE_JSON,
  ensurePluginHostDir,
  findInstalledName,
  installMissingPeers,
  isSafeNpmSpec,
  readHostDependencies,
} from '../commands/plugin/host-dir.js';

let projectRoot: string;

beforeEach(() => {
  projectRoot = mkdtempSync(join(tmpdir(), 'opensip-host-dir-'));
});

afterEach(() => {
  rmSync(projectRoot, { recursive: true, force: true });
});

/** Write a package.json under `<dir>/node_modules/<name>/package.json`. */
function writeInstalledPackage(
  nodeModulesDir: string,
  name: string,
  pkg: Record<string, unknown>,
): void {
  const pkgDir = join(nodeModulesDir, name);
  mkdirSync(pkgDir, { recursive: true });
  writeFileSync(join(pkgDir, HOST_PACKAGE_JSON), JSON.stringify({ name, ...pkg }), 'utf8');
}

describe('isSafeNpmSpec', () => {
  it('rejects empty specs', () => {
    expect(isSafeNpmSpec('')).toBe(false);
  });

  it('rejects specs that would be consumed as an npm flag', () => {
    expect(isSafeNpmSpec('-g')).toBe(false);
    expect(isSafeNpmSpec('--prefix=/etc')).toBe(false);
  });

  it('accepts ordinary package specs', () => {
    expect(isSafeNpmSpec('@org/pkg')).toBe(true);
    expect(isSafeNpmSpec('lodash@4.17.21')).toBe(true);
    expect(isSafeNpmSpec('file:../local')).toBe(true);
  });
});

describe('ensurePluginHostDir', () => {
  it('creates the plugin dir and writes a private host package.json', () => {
    const dir = ensurePluginHostDir('fit', projectRoot);
    const expected = resolveProjectPaths(projectRoot).pluginsDir('fit');
    expect(dir).toBe(expected);
    expect(existsSync(dir)).toBe(true);

    const hostPkg = JSON.parse(readFileSync(join(dir, HOST_PACKAGE_JSON), 'utf8')) as {
      name: string;
      private: boolean;
      type: string;
      dependencies: Record<string, string>;
    };
    expect(hostPkg.name).toBe('opensip-cli-fit-plugins');
    expect(hostPkg.private).toBe(true);
    expect(hostPkg.type).toBe('module');
    expect(hostPkg.dependencies).toEqual({});
  });

  it('does not overwrite an existing host package.json', () => {
    const dir = ensurePluginHostDir('sim', projectRoot);
    writeFileSync(
      join(dir, HOST_PACKAGE_JSON),
      JSON.stringify({
        name: 'sim-plugins',
        dependencies: { '@org/keep': '1.0.0' },
      }),
      'utf8',
    );
    // Second call must be idempotent — the existing file is preserved.
    ensurePluginHostDir('sim', projectRoot);
    expect(readHostDependencies(dir)).toEqual(new Set(['@org/keep']));
  });
});

describe('readHostDependencies', () => {
  it('returns the empty set when no host package.json exists', () => {
    const dir = join(projectRoot, 'empty');
    mkdirSync(dir, { recursive: true });
    expect(readHostDependencies(dir)).toEqual(new Set());
  });

  it('reads the dependency keys from the host package.json', () => {
    const dir = ensurePluginHostDir('fit', projectRoot);
    writeFileSync(
      join(dir, HOST_PACKAGE_JSON),
      JSON.stringify({
        name: 'x',
        dependencies: { '@org/a': '1.0.0', '@org/b': '2.0.0' },
      }),
      'utf8',
    );
    expect(readHostDependencies(dir)).toEqual(new Set(['@org/a', '@org/b']));
  });
});

describe('findInstalledName', () => {
  it('returns undefined when node_modules does not exist', () => {
    const dir = ensurePluginHostDir('fit', projectRoot);
    expect(findInstalledName(dir, '@org/pkg', new Set())).toBeUndefined();
  });

  it('resolves a scoped, versioned spec to the installed package name', () => {
    const dir = ensurePluginHostDir('fit', projectRoot);
    const nm = join(dir, 'node_modules');
    writeInstalledPackage(nm, '@org/scoped', { version: '1.2.3' });
    expect(findInstalledName(dir, '@org/scoped@^1.0.0', new Set())).toBe('@org/scoped');
  });

  it('resolves an unscoped, versioned spec by stripping the @version', () => {
    const dir = ensurePluginHostDir('fit', projectRoot);
    const nm = join(dir, 'node_modules');
    writeInstalledPackage(nm, 'flatpkg', { version: '0.1.0' });
    expect(findInstalledName(dir, 'flatpkg@1.0.0', new Set())).toBe('flatpkg');
  });

  it('resolves a local-path spec by diffing host deps before vs after', () => {
    const dir = ensurePluginHostDir('fit', projectRoot);
    const nm = join(dir, 'node_modules');
    // The installed package's real name is unknowable from the file: path,
    // so it is recovered as the new key in the host package.json.
    writeInstalledPackage(nm, '@org/from-local', { version: '0.0.1' });
    writeFileSync(
      join(dir, HOST_PACKAGE_JSON),
      JSON.stringify({
        name: 'host',
        dependencies: { '@org/from-local': 'file:../local' },
      }),
      'utf8',
    );
    const depsBefore = new Set<string>(); // nothing was installed before
    expect(findInstalledName(dir, 'file:../local', depsBefore)).toBe('@org/from-local');
  });

  it('returns undefined for a local-path spec when the new dep is not on disk', () => {
    const dir = ensurePluginHostDir('fit', projectRoot);
    mkdirSync(join(dir, 'node_modules'), { recursive: true });
    writeFileSync(
      join(dir, HOST_PACKAGE_JSON),
      JSON.stringify({
        name: 'host',
        dependencies: { '@org/ghost': 'file:../local' },
      }),
      'utf8',
    );
    expect(findInstalledName(dir, 'file:../local', new Set())).toBeUndefined();
  });
});

describe('installMissingPeers', () => {
  it('returns early when the requested package cannot be located', () => {
    const dir = ensurePluginHostDir('fit', projectRoot);
    // No node_modules ⇒ findInstalledPackage returns undefined ⇒ no npm call.
    expect(() => installMissingPeers(dir, '@org/missing', new Set())).not.toThrow();
  });

  it('does nothing when the package declares no peerDependencies', () => {
    const dir = ensurePluginHostDir('fit', projectRoot);
    const nm = join(dir, 'node_modules');
    writeInstalledPackage(nm, '@org/no-peers', { version: '1.0.0' });
    expect(() => installMissingPeers(dir, '@org/no-peers', new Set())).not.toThrow();
  });

  it('does nothing when every declared peer is already installed', () => {
    const dir = ensurePluginHostDir('fit', projectRoot);
    const nm = join(dir, 'node_modules');
    writeInstalledPackage(nm, '@org/has-peers', {
      version: '1.0.0',
      peerDependencies: { '@org/peer': '^1.0.0', flatpeer: '^2.0.0' },
    });
    // Both peers are present (one scoped, one flat) ⇒ the missing set is empty
    // and no npm install is attempted.
    writeInstalledPackage(nm, '@org/peer', { version: '1.0.0' });
    writeInstalledPackage(nm, 'flatpeer', { version: '2.0.0' });
    expect(() => installMissingPeers(dir, '@org/has-peers', new Set())).not.toThrow();
  });

  it('skips peers whose name or version range is unsafe (no npm install)', () => {
    const dir = ensurePluginHostDir('fit', projectRoot);
    const nm = join(dir, 'node_modules');
    writeInstalledPackage(nm, '@org/sketchy-peers', {
      version: '1.0.0',
      peerDependencies: {
        // Name that npm would parse as a flag — skipped by isSafeNpmSpec.
        '-evil': '1.0.0',
        // A genuinely missing peer whose range is a flag-like string —
        // skipped because the range is unsafe, so no npm call fires.
        legit: '--malicious',
      },
    });
    // No matching entry installed ⇒ both are "missing", but both are rejected
    // by the safety guards, so installMissingPeers performs no npm install.
    expect(() => installMissingPeers(dir, '@org/sketchy-peers', new Set())).not.toThrow();
  });
});
