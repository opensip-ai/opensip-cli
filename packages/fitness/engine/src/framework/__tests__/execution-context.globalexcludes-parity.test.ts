import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { applyGlobalExcludes } from '@opensip-cli/targeting';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createExecutionContext } from '../execution-context.js';
import { fileCache } from '../file-cache.js';
import { PathMatcher } from '../path-matcher.js';

/**
 * Phase 2 Task 2.4 replaced createMatchFilesFunction's OWN inline Minimatch
 * exclusion (for the scope-empty fileCache fallback) with the substrate's single
 * `applyGlobalExcludes`. This test PINS that the swap is exclusion-equivalent:
 * the fileCache-fallback result equals the substrate `applyGlobalExcludes` over
 * the same `fileCache.paths()` + `cwd` + `globalExcludes`. It catches any
 * `relative(cwd, …)` vs `relative(rootDir, …)` or `Minimatch`-vs-`minimatch`
 * drift a future reintroduction of a second exclusion path would create.
 */

let testDir: string;

function fixture(rel: string): void {
  const abs = join(testDir, rel);
  mkdirSync(join(abs, '..'), { recursive: true });
  writeFileSync(abs, '');
}

beforeEach(() => {
  testDir = mkdtempSync(join(tmpdir(), 'opensip-exec-parity-'));
});

afterEach(() => {
  fileCache.clear();
  rmSync(testDir, { recursive: true, force: true });
});

describe('fileCache-fallback excludes match the substrate applyGlobalExcludes', () => {
  it('the scope-empty matchFiles fallback equals the substrate exclusion', async () => {
    // Files inside and outside a non-trivial globalExcludes set: a docs dir,
    // a snapshot suffix, and a dot-dir (exercises dot: true matching).
    fixture('src/a.ts');
    fixture('src/b.ts');
    fixture('docs/design.md');
    fixture('src/__snapshots__/x.snap');
    fixture('.cache/stale.ts');

    await fileCache.prewarm(testDir, ['**/*.ts', '**/*.md', '**/*.snap']);

    const globalExcludes = ['docs/**', '**/*.snap', '.cache/**'];

    // The scope-empty fallback (empty include patterns → fileCache fallback).
    const matcher = PathMatcher.create({ cwd: testDir, include: [], exclude: [] });
    const ctx = createExecutionContext(
      { id: 'test-id', slug: 'test-slug', itemType: 'files' },
      testDir,
      matcher,
      { globalExcludes },
    );
    const fallback = await ctx.matchFiles();

    // The substrate's single exclusion implementation over the same inputs.
    const substrate = applyGlobalExcludes(fileCache.paths(), testDir, globalExcludes);

    expect([...fallback].sort()).toEqual([...substrate].sort());

    // And the result is correct: only the two src/*.ts files survive.
    expect([...fallback].map((f) => f.slice(testDir.length + 1)).sort()).toEqual([
      'src/a.ts',
      'src/b.ts',
    ]);
  });
});
