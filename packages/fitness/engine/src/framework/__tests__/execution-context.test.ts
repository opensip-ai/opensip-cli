import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { LanguageRegistry, RunScope, ToolRegistry, runWithScopeSync } from '@opensip-cli/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createExecutionContext } from '../execution-context.js';
import { fileCache } from '../file-cache.js';
import { PathMatcher } from '../path-matcher.js';

import type { Logger, RunScopeOptions } from '@opensip-cli/core';

/** Fresh scope with empty registries — local equivalent of the retired
 *  `@opensip-cli/core/test-utils` helper. The fitness engine's own tests
 *  cannot use `@opensip-cli/test-support` (it depends on this package —
 *  the dev edge would make the package graph cyclic; ADR-0040). */
const makeTestScope = (opts: RunScopeOptions = {}): RunScope =>
  new RunScope({ languages: new LanguageRegistry(), tools: new ToolRegistry(), ...opts });
const withScopeSync = runWithScopeSync;

let testDir: string;

beforeEach(() => {
  testDir = mkdtempSync(join(tmpdir(), 'opensip-exec-ctx-'));
});

afterEach(() => {
  fileCache.clear();
  rmSync(testDir, { recursive: true, force: true });
});

describe('createExecutionContext > matchFiles fileCache fallback', () => {
  // Regression test for the scope-resolver bug surfaced during the
  // checks-builtin split: scope-empty checks (e.g. file-length-limit)
  // were scanning every prewarmed file, including paths the user had
  // explicitly listed in `globalExcludes`. The fix threads the run's
  // globalExcludes through RunOptions into the matchFiles fallback.

  // eslint-disable-next-line unicorn/consistent-function-scoping -- closes over describe-scoped `testDir`
  function setupCachedFiles(): void {
    mkdirSync(join(testDir, 'src'), { recursive: true });
    mkdirSync(join(testDir, 'docs'), { recursive: true });
    mkdirSync(join(testDir, 'tests', 'fixtures'), { recursive: true });

    writeFileSync(join(testDir, 'src', 'a.ts'), 'export const a = 1');
    writeFileSync(join(testDir, 'docs', 'design.md'), '# Design');
    writeFileSync(join(testDir, 'tests', 'fixtures', 'sample.json'), '{}');
  }

  async function runMatchFiles(globalExcludes?: readonly string[]): Promise<readonly string[]> {
    setupCachedFiles();
    await fileCache.prewarm(testDir, ['**/*.ts', '**/*.md', '**/*.json']);

    const matcher = PathMatcher.create({ cwd: testDir, include: [], exclude: [] });
    const ctx = createExecutionContext(
      { id: 'test-id', slug: 'test-slug', itemType: 'files' },
      testDir,
      matcher,
      globalExcludes ? { globalExcludes } : undefined,
    );
    return ctx.matchFiles();
  }

  it('returns every cached path when no globalExcludes are provided', async () => {
    const files = await runMatchFiles();
    expect(files.length).toBe(3);
    // Sanity: includes the docs and fixtures files that we'll exclude below
    expect(files.some((f) => f.endsWith('docs/design.md'))).toBe(true);
    expect(files.some((f) => f.endsWith('tests/fixtures/sample.json'))).toBe(true);
  });

  it('filters paths matching globalExcludes patterns out of the fallback', async () => {
    const files = await runMatchFiles(['docs/**', 'tests/fixtures/**']);
    expect(files.length).toBe(1);
    expect(files[0]).toMatch(/src\/a\.ts$/);
  });

  it('honors extension-style globalExcludes (*.md, *.json)', async () => {
    const files = await runMatchFiles(['**/*.md', '**/*.json']);
    expect(files.length).toBe(1);
    expect(files[0]).toMatch(/src\/a\.ts$/);
  });

  it('returns the unfiltered list when globalExcludes is an empty array', async () => {
    // Empty array must not engage the matcher at all — otherwise we
    // pay relative-path computation per file for no reason.
    const files = await runMatchFiles([]);
    expect(files.length).toBe(3);
  });
});

describe('createExecutionContext > extractSnippet, log, checkAborted', () => {
  it('extractSnippet delegates to result-builder.extractSnippet with a default of 2 context lines', () => {
    const matcher = PathMatcher.create({ cwd: testDir, include: [], exclude: [] });
    const ctx = createExecutionContext(
      { id: 'test-id', slug: 'test-slug', itemType: 'files' },
      testDir,
      matcher,
    );
    const out = ctx.extractSnippet('a\nb\nc\nd\ne', 3);
    expect(out.snippet).toBeDefined();
    expect(out.contextLines).toBeGreaterThan(0);
  });

  it('log routes verbose output through the scope logger only when verbose is true', () => {
    const matcher = PathMatcher.create({ cwd: testDir, include: [], exclude: [] });
    const infoSpy = vi.fn();
    const stubLogger = {
      debug: vi.fn(),
      info: infoSpy,
      warn: vi.fn(),
      error: vi.fn(),
    } satisfies Logger;
    const scope = makeTestScope({ logger: stubLogger });

    withScopeSync(scope, () => {
      const verboseCtx = createExecutionContext(
        { id: 'id', slug: 'slug', itemType: 'files' },
        testDir,
        matcher,
        { verbose: true },
      );
      verboseCtx.log('hello');

      const quietCtx = createExecutionContext(
        { id: 'id', slug: 'slug', itemType: 'files' },
        testDir,
        matcher,
      );
      quietCtx.log('silent');
    });

    expect(infoSpy).toHaveBeenCalledTimes(1);
    expect(infoSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        evt: 'fitness.check.verbose',
        checkSlug: 'slug',
        message: 'hello',
      }),
    );
  });

  it('checkAborted throws CheckAbortedError when the signal is aborted', () => {
    const matcher = PathMatcher.create({ cwd: testDir, include: [], exclude: [] });
    const ac = new AbortController();
    const ctx = createExecutionContext(
      { id: 'id', slug: 'slug', itemType: 'files' },
      testDir,
      matcher,
      { signal: ac.signal },
    );
    expect(() => {
      ctx.checkAborted();
    }).not.toThrow();
    ac.abort();
    expect(() => {
      ctx.checkAborted();
    }).toThrow();
  });

  it('readFile rejects files that exceed the 10MB limit', async () => {
    const matcher = PathMatcher.create({ cwd: testDir, include: [], exclude: [] });
    const ctx = createExecutionContext(
      { id: 'id', slug: 'slug', itemType: 'files' },
      testDir,
      matcher,
    );
    // Read a non-existent file — fs.stat will throw, which propagates.
    await expect(ctx.readFile('/nonexistent/path/file.ts')).rejects.toThrow();
  });

  it('fileExists delegates to fileCache', async () => {
    const matcher = PathMatcher.create({ cwd: testDir, include: [], exclude: [] });
    const ctx = createExecutionContext(
      { id: 'id', slug: 'slug', itemType: 'files' },
      testDir,
      matcher,
    );
    const result = await ctx.fileExists('/nonexistent.ts');
    expect(typeof result).toBe('boolean');
  });

  it('getMatcher returns the same matcher passed in', () => {
    const matcher = PathMatcher.create({ cwd: testDir, include: [], exclude: [] });
    const ctx = createExecutionContext(
      { id: 'id', slug: 'slug', itemType: 'files' },
      testDir,
      matcher,
    );
    expect(ctx.getMatcher()).toBe(matcher);
  });

  it('matchFiles with explicit patterns ignores the targetFiles override', async () => {
    mkdirSync(join(testDir, 'src'), { recursive: true });
    writeFileSync(join(testDir, 'src', 'a.ts'), 'x');
    const matcher = PathMatcher.create({ cwd: testDir, include: [], exclude: [] });
    const ctx = createExecutionContext(
      { id: 'id', slug: 'slug', itemType: 'files' },
      testDir,
      matcher,
      { targetFiles: ['/some/preresolved/file.ts'] },
    );
    // Custom patterns path skips targetFiles fallback.
    const out = await ctx.matchFiles(['src/**/*.ts']);
    expect(out.length).toBeGreaterThan(0);
    expect(out[0]).not.toBe('/some/preresolved/file.ts');
  });
});
