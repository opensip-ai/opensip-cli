import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { applyGlobalExcludes, preResolveAllTargets, resolveTargets } from '../resolve.js';
import { TargetRegistry } from '../target-registry.js';

import type { Target } from '@opensip-cli/config';

let testDir: string;

function fixture(rel: string, content = ''): string {
  const abs = join(testDir, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content);
  return abs;
}

function makeTarget(name: string, opts: Partial<Target['config']>): Target {
  return {
    config: {
      name,
      description: name,
      include: opts.include ?? [],
      exclude: opts.exclude ?? [],
      ...(opts.tags && { tags: opts.tags }),
      ...(opts.languages && { languages: opts.languages }),
      ...(opts.concerns && { concerns: opts.concerns }),
    },
  };
}

/** Relativize absolute results back to `rel/path` for stable assertions. */
function rel(files: readonly string[]): string[] {
  return files.map((f) => f.slice(testDir.length + 1)).sort();
}

beforeEach(() => {
  testDir = mkdtempSync(join(tmpdir(), 'opensip-targeting-resolve-'));
});

afterEach(() => {
  rmSync(testDir, { recursive: true, force: true });
});

describe('resolveTargets', () => {
  it('expands include globs to absolute paths', () => {
    fixture('src/a.ts');
    fixture('src/b.ts');
    const out = resolveTargets([makeTarget('src', { include: ['src/**/*.ts'] })], testDir, []);
    expect(rel(out)).toEqual(['src/a.ts', 'src/b.ts']);
  });

  it('applies per-target exclude', () => {
    fixture('src/a.ts');
    fixture('src/a.test.ts');
    const out = resolveTargets(
      [makeTarget('src', { include: ['src/**/*.ts'], exclude: ['**/*.test.ts'] })],
      testDir,
      [],
    );
    expect(rel(out)).toEqual(['src/a.ts']);
  });

  it('dedupes across targets and returns sorted output', () => {
    fixture('src/a.ts');
    fixture('src/b.ts');
    const out = resolveTargets(
      [
        makeTarget('t1', { include: ['src/**/*.ts'] }),
        makeTarget('t2', { include: ['src/a.ts'] }), // overlaps t1
      ],
      testDir,
      [],
    );
    expect(rel(out)).toEqual(['src/a.ts', 'src/b.ts']);
  });

  it('returns [] for a pattern that matches nothing', () => {
    const out = resolveTargets([makeTarget('none', { include: ['nope/**/*.ts'] })], testDir, []);
    expect(out).toEqual([]);
  });

  // Regression: the dead `resolveTargetFiles` omitted globalExcludes. The single
  // substrate resolver applies them UNIFORMLY — a file matched only by
  // globalExcludes must be filtered out (ADR-0037 acceptance).
  it('applies globalExcludes uniformly (the dead path bug cannot return)', () => {
    fixture('src/keep.ts');
    fixture('src/generated/big.ts');
    const out = resolveTargets(
      [makeTarget('src', { include: ['src/**/*.ts'] })],
      testDir,
      ['**/generated/**'], // not in the target's own exclude — only a globalExclude
    );
    expect(rel(out)).toEqual(['src/keep.ts']);
  });
});

describe('preResolveAllTargets', () => {
  it('partitions files per target with a single deduped glob pass', () => {
    fixture('a/x.ts');
    fixture('b/y.ts');
    const reg = new TargetRegistry();
    reg.register(makeTarget('a', { include: ['a/**/*.ts'] }));
    reg.register(makeTarget('b', { include: ['b/**/*.ts'] }));
    const map = preResolveAllTargets(reg, [], testDir);
    expect(rel(map.get('a') ?? [])).toEqual(['a/x.ts']);
    expect(rel(map.get('b') ?? [])).toEqual(['b/y.ts']);
  });

  it('applies globalExcludes uniformly across every target', () => {
    fixture('a/keep.ts');
    fixture('a/generated/skip.ts');
    const reg = new TargetRegistry();
    reg.register(makeTarget('a', { include: ['a/**/*.ts'] }));
    const map = preResolveAllTargets(reg, ['**/generated/**'], testDir);
    expect(rel(map.get('a') ?? [])).toEqual(['a/keep.ts']);
  });

  it('returns an empty map when the registry is empty', () => {
    const map = preResolveAllTargets(new TargetRegistry(), [], testDir);
    expect(map.size).toBe(0);
  });
});

describe('applyGlobalExcludes', () => {
  it('returns equivalent list (value equality) and drops outside-root paths when there are no excludes', () => {
    // Create real files so the realpath-based isPathInside guard (defense against
    // escape) can succeed for paths that are legitimately inside.
    fixture('a.ts');
    fixture('b.ts');
    const files = [join(testDir, 'a.ts'), join(testDir, 'b.ts')];
    const out = applyGlobalExcludes(files, testDir, []);
    expect(out).not.toBe(files); // new array (we always filter for the containment guard)
    expect(out).toEqual(files);
  });

  it('filters rootDir-relative matches with dot: true (and guards containment)', () => {
    fixture('src/a.ts');
    fixture('.hidden/b.ts'); // would be kept without the global exclude, but we test drop by pattern
    const files = [join(testDir, 'src/a.ts'), join(testDir, '.hidden/b.ts')];
    expect(rel(applyGlobalExcludes(files, testDir, ['.hidden/**']))).toEqual(['src/a.ts']);
  });

  it('drops paths that are not inside the rootDir even if no globalExcludes (symlink/escape guard)', () => {
    fixture('inside.ts');
    const inside = join(testDir, 'inside.ts');
    const outside = join(testDir, '..', 'outside.ts'); // non-existing is fine; isPathInside will fail realpath and drop
    const files = [inside, outside];
    const out = applyGlobalExcludes(files, testDir, []);
    expect(rel(out)).toEqual(['inside.ts']);
  });
});
