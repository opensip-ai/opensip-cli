import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir, platform } from 'node:os';
import { dirname, join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { preResolveAllTargets, resolveTargets } from '../resolve.js';
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

beforeEach(() => {
  testDir = mkdtempSync(join(tmpdir(), 'opensip-targeting-equivalence-'));
});

afterEach(() => {
  rmSync(testDir, { recursive: true, force: true });
});

describe('resolveTargets/preResolveAllTargets equivalence', () => {
  it('returns the same ordered files for each target slice', () => {
    fixture('src/a.ts');
    fixture('src/a.test.ts');
    fixture('src/components/a.ts');
    fixture('src/components/b.ts');
    fixture('src/components/c.ts');
    fixture('src/components/.hidden.ts');
    fixture('src/generated/skip.ts');
    fixture('src/nested/value.ts');
    fixture('src/nested/.secret.ts');
    fixture('.config/tool.ts');
    fixture('.cache/skip.ts');
    fixture('lib/x.ts');
    fixture('lib/x.js');
    fixture('README.md');

    const targets = [
      makeTarget('source', {
        include: ['./src/**/*.[tj]s', 'src/components/[ab].ts'],
        exclude: ['**/*.test.ts', 'src/components/b.ts'],
      }),
      makeTarget('hidden', {
        include: ['src/**/.*.ts', './.config/**/*.ts'],
        exclude: [],
      }),
      makeTarget('library', {
        include: ['lib/**/*.ts', 'src/components/[ac].ts'],
        exclude: ['src/components/c.ts'],
      }),
    ];
    const globalExcludes = ['**/generated/**', '**/.cache/**', 'src/**/.secret.ts'];
    const registry = new TargetRegistry();
    for (const target of targets) registry.register(target);

    const preResolved = preResolveAllTargets(registry, globalExcludes, testDir);

    for (const target of targets) {
      expect(resolveTargets([target], testDir, globalExcludes)).toEqual(
        preResolved.get(target.config.name),
      );
    }
  });

  // Regression: resolveTargets fed a target's `exclude` into globSync's `ignore`
  // option, which is nocase on darwin/win32 (glob's platform default), while
  // preResolveAllTargets relied solely on the shared post-glob Minimatch filter,
  // which defaulted to always-case-sensitive. A differently-cased exclude then
  // excluded a file via one path but not the other — breaking the "identical
  // output sets for equivalent inputs" contract this module documents. Assert
  // BOTH parity between the two paths AND the platform-correct outcome (rather
  // than only parity) so the test cannot pass by both paths agreeing on the
  // wrong answer.
  it('applies a differently-cased target exclude identically across both resolution paths', () => {
    fixture('src/keep.ts');
    fixture('src/DROP.ts');
    const target = makeTarget('src', {
      // Lower-case pattern against an upper-case on-disk file: only matches
      // (and excludes) on nocase platforms (darwin/win32), matching glob's own
      // platform-derived default for the `ignore` option resolveTargets uses.
      include: ['src/**/*.ts'],
      exclude: ['src/drop.ts'],
    });
    const registry = new TargetRegistry();
    registry.register(target);

    const viaResolveTargets = resolveTargets([target], testDir, []);
    const viaPreResolve = preResolveAllTargets(registry, [], testDir).get('src');

    const isNocasePlatform = platform() === 'darwin' || platform() === 'win32';
    const expected = isNocasePlatform
      ? [join(testDir, 'src/keep.ts')]
      : [join(testDir, 'src/DROP.ts'), join(testDir, 'src/keep.ts')];

    expect(viaResolveTargets).toEqual(expected);
    // The bug: before the fix, this equality failed on nocase platforms because
    // preResolveAllTargets's case-sensitive-only post-filter kept `DROP.ts`
    // while resolveTargets's nocase glob `ignore` had already dropped it.
    expect(viaPreResolve).toEqual(viaResolveTargets);
  });
});
