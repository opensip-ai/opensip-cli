import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { buildTargets } from '../bootstrap/build-targets.js';

/**
 * Unit coverage for the host's pure `buildTargets` builder (ADR-0037 Phase 1):
 * the `toTarget` normalization matrix (default vs explicit exclude;
 * tags/languages/concerns optionals) and every TargetResolver method
 * (getAll/getByTag/applyGlobalExcludes/resolveTargets unknown-name filter).
 */

let testDir: string;

function fixture(rel: string): void {
  const abs = join(testDir, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, '');
}

beforeEach(() => {
  testDir = mkdtempSync(join(tmpdir(), 'opensip-build-targets-'));
});

afterEach(() => {
  rmSync(testDir, { recursive: true, force: true });
});

describe('buildTargets — toTarget normalization', () => {
  it('defaults exclude to node_modules/dist when a target declares none', () => {
    const targets = buildTargets({
      document: { targets: { backend: { description: 'b', include: ['src/**/*.ts'] } } },
    });
    expect(targets?.getByName('backend')?.config.exclude).toEqual([
      '**/node_modules/**',
      '**/dist/**',
    ]);
  });

  it('preserves an explicit exclude and the tags/languages/concerns optionals', () => {
    const targets = buildTargets({
      document: {
        targets: {
          backend: {
            description: 'b',
            include: ['src/**/*.ts'],
            exclude: ['**/*.spec.ts'],
            tags: ['fast'],
            languages: ['typescript'],
            concerns: ['backend'],
          },
        },
      },
    });
    const t = targets?.getByName('backend')?.config;
    expect(t?.exclude).toEqual(['**/*.spec.ts']);
    expect(t?.tags).toEqual(['fast']);
    expect(t?.languages).toEqual(['typescript']);
    expect(t?.concerns).toEqual(['backend']);
  });
});

describe('buildTargets — TargetResolver surface', () => {
  it('getAll returns every registered target', () => {
    const targets = buildTargets({
      document: {
        targets: {
          a: { description: 'a', include: ['a/**'] },
          b: { description: 'b', include: ['b/**'] },
        },
      },
    });
    expect(
      targets
        ?.getAll()
        .map((t) => t.config.name)
        .sort(),
    ).toEqual(['a', 'b']);
  });

  it('applyGlobalExcludes filters cwd-relative paths', () => {
    // Real files are required for the isPathInside(realpath) containment guard
    // inside applyGlobalExcludes (prevents escaped paths from ever being kept).
    fixture('src/a.ts');
    fixture('dist/b.ts');
    const targets = buildTargets({
      document: {
        targets: { a: { description: 'a', include: ['a/**'] } },
        globalExcludes: ['dist/**'],
      },
    });
    const files = [join(testDir, 'src/a.ts'), join(testDir, 'dist/b.ts')];
    expect(targets?.applyGlobalExcludes(files, testDir)).toEqual([join(testDir, 'src/a.ts')]);
  });

  it('returns undefined for a non-object or targets-less document', () => {
    expect(buildTargets({ document: null })).toBeUndefined();
    expect(buildTargets({ document: [] })).toBeUndefined();
    expect(buildTargets({ document: {} })).toBeUndefined();
    expect(buildTargets({ document: { globalExcludes: ['dist/**'] } })).toBeUndefined();
  });

  it('resolveTargets drops unknown names and applies globalExcludes', () => {
    fixture('src/keep.ts');
    fixture('src/dist/drop.ts');
    const targets = buildTargets({
      document: {
        targets: { src: { description: 's', include: ['src/**/*.ts'] } },
        globalExcludes: ['**/dist/**'],
      },
    });
    const resolved = targets?.resolveTargets(['src', 'does-not-exist'], testDir) ?? [];
    expect(resolved.map((f) => f.slice(testDir.length + 1))).toEqual(['src/keep.ts']);
  });
});

describe('buildTargets — invalid blocks surface as ConfigurationError', () => {
  it('throws CONFIGURATION.TARGETS.INVALID on a malformed targets: block', () => {
    let caught: unknown;
    try {
      // targets must be a record of target specs; a scalar fails the schema.
      buildTargets({ document: { targets: 'not-a-record' } });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toMatch(/Invalid 'targets:' block/);
    expect((caught as { code?: string }).code).toBe('CONFIGURATION.TARGETS.INVALID');
  });

  it('throws CONFIGURATION.TARGETS.INVALID on a malformed globalExcludes: block', () => {
    expect(() =>
      buildTargets({
        document: {
          targets: { ok: { description: 'd', include: ['src/**/*.ts'] } },
          // globalExcludes must be a string[]; a scalar fails the schema.
          globalExcludes: 123,
        },
      }),
    ).toThrow(/Invalid 'globalExcludes:' block/);
  });
});
