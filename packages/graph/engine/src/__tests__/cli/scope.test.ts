/**
 * Tests for the `--package` scope resolver.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { discoverWorkspacePackages, resolvePackageScope } from '../../cli/scope.js';

const TSCONFIG = JSON.stringify({ compilerOptions: { target: 'ES2022' } });

describe('resolvePackageScope', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'graph-scope-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('resolves an explicit relative path with a tsconfig.json', () => {
    const pkg = join(dir, 'packages', 'core');
    mkdirSync(pkg, { recursive: true });
    writeFileSync(join(pkg, 'tsconfig.json'), TSCONFIG, 'utf8');
    const out = resolvePackageScope({ cwd: dir, packageArg: 'packages/core' });
    expect(out.packageDirAbs).toBe(pkg);
    expect(out.tsConfigPathAbs).toBe(join(pkg, 'tsconfig.json'));
  });

  it('resolves an explicit absolute path with a tsconfig.json', () => {
    const pkg = join(dir, 'packages', 'core');
    mkdirSync(pkg, { recursive: true });
    writeFileSync(join(pkg, 'tsconfig.json'), TSCONFIG, 'utf8');
    const out = resolvePackageScope({ cwd: dir, packageArg: pkg });
    expect(out.packageDirAbs).toBe(pkg);
  });

  it('searches packages/** by basename when given a bare name', () => {
    const pkg = join(dir, 'packages', 'fitness', 'engine');
    mkdirSync(pkg, { recursive: true });
    writeFileSync(join(pkg, 'tsconfig.json'), TSCONFIG, 'utf8');
    const out = resolvePackageScope({ cwd: dir, packageArg: 'engine' });
    expect(out.packageDirAbs).toBe(pkg);
  });

  it('throws on an empty argument', () => {
    expect(() => resolvePackageScope({ cwd: dir, packageArg: '   ' })).toThrow(
      /requires a non-empty argument/,
    );
  });

  it('throws when an explicit path lacks a tsconfig.json', () => {
    const pkg = join(dir, 'packages', 'core');
    mkdirSync(pkg, { recursive: true });
    expect(() => resolvePackageScope({ cwd: dir, packageArg: 'packages/core' })).toThrow(
      /no tsconfig\.json/,
    );
  });

  it('throws when a bare name does not resolve and no packages/ tree exists', () => {
    expect(() => resolvePackageScope({ cwd: dir, packageArg: 'engine' })).toThrow(
      /did not resolve to a directory/,
    );
  });

  it('throws when a bare name is ambiguous across multiple packages', () => {
    const a = join(dir, 'packages', 'fitness', 'engine');
    const b = join(dir, 'packages', 'graph', 'engine');
    mkdirSync(a, { recursive: true });
    mkdirSync(b, { recursive: true });
    writeFileSync(join(a, 'tsconfig.json'), TSCONFIG, 'utf8');
    writeFileSync(join(b, 'tsconfig.json'), TSCONFIG, 'utf8');
    expect(() => resolvePackageScope({ cwd: dir, packageArg: 'engine' })).toThrow(/ambiguous/);
  });

  it('throws when no matching basename is found', () => {
    mkdirSync(join(dir, 'packages', 'core'), { recursive: true });
    writeFileSync(join(dir, 'packages', 'core', 'tsconfig.json'), TSCONFIG, 'utf8');
    expect(() => resolvePackageScope({ cwd: dir, packageArg: 'nonexistent' })).toThrow(
      /no matching package directory/,
    );
  });

  it('skips node_modules during the basename search', () => {
    // Real package
    const real = join(dir, 'packages', 'core');
    mkdirSync(real, { recursive: true });
    writeFileSync(join(real, 'tsconfig.json'), TSCONFIG, 'utf8');
    // Bait: a basename match inside node_modules
    const bait = join(dir, 'packages', 'something', 'node_modules', 'core');
    mkdirSync(bait, { recursive: true });
    writeFileSync(join(bait, 'tsconfig.json'), TSCONFIG, 'utf8');
    const out = resolvePackageScope({ cwd: dir, packageArg: 'core' });
    expect(out.packageDirAbs).toBe(real);
  });
});

describe('discoverWorkspacePackages', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'graph-discover-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('returns empty when no packages/ tree exists', () => {
    expect(discoverWorkspacePackages(dir)).toEqual([]);
  });

  it('finds top-level packages with tsconfig.json', () => {
    mkdirSync(join(dir, 'packages', 'core'), { recursive: true });
    writeFileSync(join(dir, 'packages', 'core', 'tsconfig.json'), TSCONFIG, 'utf8');
    mkdirSync(join(dir, 'packages', 'cli'), { recursive: true });
    writeFileSync(join(dir, 'packages', 'cli', 'tsconfig.json'), TSCONFIG, 'utf8');
    const out = discoverWorkspacePackages(dir);
    expect(out).toHaveLength(2);
    expect(out.some((p) => p.endsWith('packages/cli'))).toBe(true);
    expect(out.some((p) => p.endsWith('packages/core'))).toBe(true);
  });

  it('finds nested packages (e.g. packages/<group>/<pkg>)', () => {
    const a = join(dir, 'packages', 'fitness', 'engine');
    const b = join(dir, 'packages', 'graph', 'engine');
    mkdirSync(a, { recursive: true });
    mkdirSync(b, { recursive: true });
    writeFileSync(join(a, 'tsconfig.json'), TSCONFIG, 'utf8');
    writeFileSync(join(b, 'tsconfig.json'), TSCONFIG, 'utf8');
    const out = discoverWorkspacePackages(dir);
    expect(out).toHaveLength(2);
    expect(out).toEqual([a, b].sort());
  });

  it('does not recurse into a directory that already has a tsconfig.json', () => {
    // packages/core has a tsconfig; packages/core/sub also has one
    // (e.g. an old leftover from a sub-package). The walker must
    // record packages/core and stop, not double-count by recording
    // both.
    mkdirSync(join(dir, 'packages', 'core', 'sub'), { recursive: true });
    writeFileSync(join(dir, 'packages', 'core', 'tsconfig.json'), TSCONFIG, 'utf8');
    writeFileSync(join(dir, 'packages', 'core', 'sub', 'tsconfig.json'), TSCONFIG, 'utf8');
    const out = discoverWorkspacePackages(dir);
    expect(out).toHaveLength(1);
    expect(out[0]).toBe(join(dir, 'packages', 'core'));
  });

  it('skips node_modules / dist / build', () => {
    const real = join(dir, 'packages', 'core');
    mkdirSync(real, { recursive: true });
    writeFileSync(join(real, 'tsconfig.json'), TSCONFIG, 'utf8');
    const bait = join(dir, 'packages', 'something', 'node_modules', 'pkg');
    mkdirSync(bait, { recursive: true });
    writeFileSync(join(bait, 'tsconfig.json'), TSCONFIG, 'utf8');
    const out = discoverWorkspacePackages(dir);
    expect(out).toHaveLength(1);
    expect(out[0]).toBe(real);
  });

  it('returns absolute paths sorted lexicographically', () => {
    const z = join(dir, 'packages', 'zebra');
    const a = join(dir, 'packages', 'alpha');
    const m = join(dir, 'packages', 'mango');
    for (const p of [z, a, m]) {
      mkdirSync(p, { recursive: true });
      writeFileSync(join(p, 'tsconfig.json'), TSCONFIG, 'utf8');
    }
    const out = discoverWorkspacePackages(dir);
    expect(out).toEqual([a, m, z]);
  });
});
