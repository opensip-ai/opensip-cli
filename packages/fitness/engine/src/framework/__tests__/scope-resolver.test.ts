import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { TargetRegistry } from '../../targets/target-registry.js';
import { buildScopeBasedFileMap } from '../scope-resolver.js';

import type { Target, TargetsConfig } from '../../targets/types.js';

let testDir: string;

function fixture(rel: string, content = ''): string {
  const abs = join(testDir, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content);
  return abs;
}

function makeRegistry(targets: Target[]): TargetRegistry {
  const reg = new TargetRegistry();
  for (const t of targets) reg.register(t);
  return reg;
}

function makeTarget(name: string, opts: Partial<Target['config']>): Target {
  return {
    config: {
      name,
      description: name,
      include: opts.include ?? [],
      exclude: opts.exclude ?? [],
      ...(opts.languages && { languages: opts.languages }),
      ...(opts.concerns && { concerns: opts.concerns }),
    },
  };
}

function makeConfig(overrides: Partial<TargetsConfig> = {}): TargetsConfig {
  return {
    globalExcludes: overrides.globalExcludes ?? [],
    checkOverrides: overrides.checkOverrides ?? {},
    ...overrides,
  };
}

beforeEach(() => {
   
  testDir = mkdtempSync(join(tmpdir(), 'opensip-scope-resolver-'));
});

afterEach(() => {
  rmSync(testDir, { recursive: true, force: true });
});

describe('buildScopeBasedFileMap', () => {
  it('returns an empty map when no checks have scopes or overrides', () => {
    const registry = makeRegistry([
      makeTarget('src', { include: ['src/**/*.ts'], languages: ['typescript'], concerns: ['backend'] }),
    ]);
    const out = buildScopeBasedFileMap([], registry, makeConfig(), testDir);
    expect(out.size).toBe(0);
  });

  it('matches checks to targets by scope.languages + concerns', () => {
    fixture('src/a.ts');
    fixture('src/b.ts');
    fixture('lib/c.rs');

    const registry = makeRegistry([
      makeTarget('ts-src', {
        include: ['src/**/*.ts'],
        languages: ['typescript'],
        concerns: ['backend'],
      }),
      makeTarget('rs-lib', {
        include: ['lib/**/*.rs'],
        languages: ['rust'],
        concerns: ['backend'],
      }),
    ]);

    const out = buildScopeBasedFileMap(
      [{ slug: 'ts-check', scope: { languages: ['typescript'], concerns: ['backend'] } }],
      registry,
      makeConfig(),
      testDir,
    );

    const tsFiles = out.get('ts-check');
    expect(tsFiles).toBeDefined();
    expect(tsFiles?.length).toBe(2);
    expect(tsFiles?.every((f) => f.endsWith('.ts'))).toBe(true);
  });

  it('returns empty when scope matches no targets', () => {
    fixture('src/a.ts');
    const registry = makeRegistry([
      makeTarget('ts-src', { include: ['src/**/*.ts'], languages: ['typescript'], concerns: ['backend'] }),
    ]);

    const out = buildScopeBasedFileMap(
      [{ slug: 'cobol-check', scope: { languages: ['cobol'], concerns: ['mainframe'] } }],
      registry,
      makeConfig(),
      testDir,
    );

    expect(out.get('cobol-check')).toEqual([]);
  });

  it('uses checkOverrides when present', () => {
    fixture('src/a.ts');
    fixture('test/b.ts');
    const registry = makeRegistry([
      makeTarget('src', { include: ['src/**/*.ts'] }),
      makeTarget('test', { include: ['test/**/*.ts'] }),
    ]);

    const out = buildScopeBasedFileMap(
      [{ slug: 'narrow-check', scope: { languages: [], concerns: [] } }],
      registry,
      makeConfig({ checkOverrides: { 'narrow-check': 'test' } }),
      testDir,
    );

    const files = out.get('narrow-check');
    expect(files?.length).toBe(1);
    expect(files?.[0]?.endsWith('test/b.ts')).toBe(true);
  });

  it('honors checkOverrides that point to multiple targets', () => {
    fixture('src/a.ts');
    fixture('test/b.ts');
    const registry = makeRegistry([
      makeTarget('src', { include: ['src/**/*.ts'] }),
      makeTarget('test', { include: ['test/**/*.ts'] }),
    ]);

    const out = buildScopeBasedFileMap(
      [{ slug: 'broad-check', scope: { languages: [], concerns: [] } }],
      registry,
      makeConfig({ checkOverrides: { 'broad-check': ['src', 'test'] } }),
      testDir,
    );

    expect(out.get('broad-check')?.length).toBe(2);
  });

  it('applies globalExcludes during pre-resolution', () => {
    fixture('src/a.ts');
    fixture('src/ignore-me/b.ts');
    const registry = makeRegistry([
      makeTarget('src', { include: ['src/**/*.ts'], languages: ['typescript'], concerns: ['backend'] }),
    ]);

    const out = buildScopeBasedFileMap(
      [{ slug: 'check', scope: { languages: ['typescript'], concerns: ['backend'] } }],
      registry,
      makeConfig({ globalExcludes: ['**/ignore-me/**'] }),
      testDir,
    );

    const files = out.get('check') ?? [];
    expect(files.some((f) => f.includes('ignore-me'))).toBe(false);
    expect(files.length).toBe(1);
  });

  it('applies per-target excludes', () => {
    fixture('src/a.ts');
    fixture('src/skip.ts');
    const registry = makeRegistry([
      makeTarget('src', {
        include: ['src/**/*.ts'],
        exclude: ['**/skip.ts'],
        languages: ['typescript'],
        concerns: ['backend'],
      }),
    ]);

    const out = buildScopeBasedFileMap(
      [{ slug: 'check', scope: { languages: ['typescript'], concerns: ['backend'] } }],
      registry,
      makeConfig(),
      testDir,
    );

    const files = out.get('check') ?? [];
    expect(files.some((f) => f.endsWith('skip.ts'))).toBe(false);
  });

  it('skips checks without a scope and without an override', () => {
    fixture('src/a.ts');
    const registry = makeRegistry([
      makeTarget('src', { include: ['src/**/*.ts'] }),
    ]);

    const out = buildScopeBasedFileMap(
      [{ slug: 'unscoped' }],
      registry,
      makeConfig(),
      testDir,
    );

    expect(out.has('unscoped')).toBe(false);
  });
});
