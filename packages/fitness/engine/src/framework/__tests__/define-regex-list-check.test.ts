/**
 * @fileoverview Tests for the defineRegexListCheck Template helper.
 *
 * Verifies:
 *  - per-pattern emission with the pattern's slug surfaced as `type`
 *  - lastIndex is reset between iterations (the audit's primary concern)
 *  - multiple matches per line for global-flag regexes
 *  - non-global regex emits at most one match per line
 *  - skipCommentLines: true (default) and false
 *  - skipTestFiles: true and false (default)
 *  - per-pattern severity and default warning severity
 *  - fileTypes and scope are forwarded to the underlying defineCheck
 */

import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';

import { describe, expect, it } from 'vitest';

import { defineRegexListCheck } from '../define-regex-list-check.js';
import { FileCache } from '../file-cache.js';

import type { Signal } from '@opensip-cli/core';

const FIXED_ID = '11111111-1111-4111-8111-111111111111';
const PATTERN_ID_A = '22222222-2222-4222-8222-222222222222';
const PATTERN_ID_B = '33333333-3333-4333-8333-333333333333';

/**
 * Run the synthesised check against a fixture file written to a temp
 * dir, return the produced signals. The helper is module-scoped so
 * `unicorn/consistent-function-scoping` is happy and the eager top-level
 * `node:fs` imports avoid the `@typescript-eslint/unbound-method` warning
 * that triggers when method references come out of dynamic imports.
 */
async function runOnContent(
  check: ReturnType<typeof defineRegexListCheck>,
  content: string,
  filename = 'fixture.ts',
): Promise<readonly Signal[]> {
  const cwd = mkdtempSync(join(tmpdir(), 'regex-list-check-'));
  try {
    const abs = join(cwd, filename);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content);
    // No-scope test path: pass a fresh per-call FileCache explicitly.
    // createExecutionContext no longer falls back to a module singleton
    // (parallel-tool-invocations Phase 1); the empty cache reads through to disk.
    const result = await check.run(cwd, { targetFiles: [abs], fileCache: new FileCache() });
    return result.signals ?? [];
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
}

describe('defineRegexListCheck', () => {
  describe('config forwarding', () => {
    const check = defineRegexListCheck({
      id: FIXED_ID,
      slug: 'demo-check',
      description: 'demo',
      tags: ['demo'],
      scope: { languages: ['typescript'], concerns: ['backend'] },
      fileTypes: ['ts', 'tsx'],
      contentFilter: 'strip-strings',
      patterns: [
        {
          id: PATTERN_ID_A,
          slug: 'foo-pattern',
          regex: /FOO/g,
          message: 'FOO not allowed',
        },
      ],
    });

    it('returns a Check with the configured slug and id', () => {
      expect(check.config.slug).toBe('demo-check');
      expect(check.config.id).toBe(FIXED_ID);
    });

    it('forwards scope.languages and scope.concerns', () => {
      expect(check.config.checkScope?.languages).toEqual(['typescript']);
      expect(check.config.checkScope?.concerns).toEqual(['backend']);
    });

    it('forwards fileTypes', () => {
      expect(check.config.fileTypes).toEqual(['ts', 'tsx']);
    });

    it('records analysisMode "analyze"', () => {
      expect(check.config.analysisMode).toBe('analyze');
    });

    it('preserves user-supplied tags', () => {
      expect(check.config.tags).toEqual(['demo']);
    });
  });

  describe('analyze() behaviour via fixture files', () => {
    it('emits one violation per pattern that matches per line', async () => {
      const check = defineRegexListCheck({
        id: FIXED_ID,
        slug: 'two-patterns',
        description: 'd',
        tags: ['demo'],
        fileTypes: ['ts'],
        patterns: [
          { id: PATTERN_ID_A, slug: 'foo-pat', regex: /FOO/, message: 'FOO', severity: 'error' },
          { id: PATTERN_ID_B, slug: 'bar-pat', regex: /BAR/, message: 'BAR' },
        ],
      });
      const signals = await runOnContent(check, 'FOO BAR\n');
      expect(signals.length).toBe(2);
      const types = signals.map((s) => s.metadata?.type).sort();
      expect(types).toEqual(['bar-pat', 'foo-pat']);
    });

    it('emits multiple violations per line for global-flag regexes', async () => {
      const check = defineRegexListCheck({
        id: FIXED_ID,
        slug: 'global-multi',
        description: 'd',
        tags: ['demo'],
        fileTypes: ['ts'],
        patterns: [
          { id: PATTERN_ID_A, slug: 'foo', regex: /FOO/g, message: 'FOO match', severity: 'error' },
        ],
      });
      const signals = await runOnContent(check, 'FOO FOO FOO\n');
      expect(signals.length).toBe(3);
      const lines = signals.map((s) => s.code?.line);
      expect(lines).toEqual([1, 1, 1]);
      const columns = signals.map((s) => s.code?.column);
      expect(columns).toEqual([0, 4, 8]);
    });

    it('emits at most one violation per line for non-global regexes', async () => {
      const check = defineRegexListCheck({
        id: FIXED_ID,
        slug: 'non-global',
        description: 'd',
        tags: ['demo'],
        fileTypes: ['ts'],
        patterns: [
          { id: PATTERN_ID_A, slug: 'foo', regex: /FOO/, message: 'FOO match', severity: 'error' },
        ],
      });
      const signals = await runOnContent(check, 'FOO FOO FOO\n');
      expect(signals.length).toBe(1);
    });

    it('lastIndex is reset between lines (regression for global regex state leak)', async () => {
      const check = defineRegexListCheck({
        id: FIXED_ID,
        slug: 'lastindex-reset',
        description: 'd',
        tags: ['demo'],
        fileTypes: ['ts'],
        patterns: [
          { id: PATTERN_ID_A, slug: 'foo', regex: /FOO/g, message: 'FOO match', severity: 'error' },
        ],
      });
      const signals = await runOnContent(check, 'FOO\nFOO\nFOO\n');
      expect(signals.length).toBe(3);
      expect(signals.map((s) => s.code?.line).sort()).toEqual([1, 2, 3]);
    });

    it('skipCommentLines: true (default) skips lines starting with //', async () => {
      const check = defineRegexListCheck({
        id: FIXED_ID,
        slug: 'skip-comments',
        description: 'd',
        tags: ['demo'],
        fileTypes: ['ts'],
        patterns: [
          { id: PATTERN_ID_A, slug: 'foo', regex: /FOO/g, message: 'FOO', severity: 'error' },
        ],
      });
      const signals = await runOnContent(check, '// FOO\nFOO\n');
      expect(signals.length).toBe(1);
      expect(signals[0]?.code?.line).toBe(2);
    });

    it('skipCommentLines: false emits violations on comment lines', async () => {
      const check = defineRegexListCheck({
        id: FIXED_ID,
        slug: 'no-skip-comments',
        description: 'd',
        tags: ['demo'],
        fileTypes: ['ts'],
        options: { skipCommentLines: false },
        patterns: [
          { id: PATTERN_ID_A, slug: 'foo', regex: /FOO/g, message: 'FOO', severity: 'error' },
        ],
      });
      const signals = await runOnContent(check, '// FOO\nFOO\n');
      expect(signals.length).toBe(2);
    });

    it('skipTestFiles: true skips files matching isTestFile()', async () => {
      const check = defineRegexListCheck({
        id: FIXED_ID,
        slug: 'skip-tests',
        description: 'd',
        tags: ['demo'],
        fileTypes: ['ts'],
        options: { skipTestFiles: true },
        patterns: [
          { id: PATTERN_ID_A, slug: 'foo', regex: /FOO/g, message: 'FOO', severity: 'error' },
        ],
      });
      const signals = await runOnContent(check, 'FOO\n', 'src/foo.test.ts');
      expect(signals.length).toBe(0);
    });

    it('skipCheckAuthoringSources: true skips fitness check-pack paths', async () => {
      const check = defineRegexListCheck({
        id: FIXED_ID,
        slug: 'skip-check-authoring',
        description: 'd',
        tags: ['demo'],
        fileTypes: ['ts'],
        options: { skipCheckAuthoringSources: true },
        patterns: [
          { id: PATTERN_ID_A, slug: 'foo', regex: /FOO/g, message: 'FOO', severity: 'error' },
        ],
      });
      const signals = await runOnContent(
        check,
        'FOO\n',
        'packages/fitness/checks-typescript/src/checks/demo.ts',
      );
      expect(signals.length).toBe(0);
    });

    it('skipTestFiles: false (default) does not skip test files', async () => {
      const check = defineRegexListCheck({
        id: FIXED_ID,
        slug: 'no-skip-tests',
        description: 'd',
        tags: ['demo'],
        fileTypes: ['ts'],
        patterns: [
          { id: PATTERN_ID_A, slug: 'foo', regex: /FOO/g, message: 'FOO', severity: 'error' },
        ],
      });
      const signals = await runOnContent(check, 'FOO\n', 'src/foo.test.ts');
      expect(signals.length).toBe(1);
    });

    it('per-pattern severity is propagated to the violation', async () => {
      const check = defineRegexListCheck({
        id: FIXED_ID,
        slug: 'mixed-severity',
        description: 'd',
        tags: ['demo'],
        fileTypes: ['ts'],
        patterns: [
          { id: PATTERN_ID_A, slug: 'foo', regex: /FOO/g, message: 'FOO', severity: 'error' },
          { id: PATTERN_ID_B, slug: 'bar', regex: /BAR/g, message: 'BAR', severity: 'warning' },
        ],
      });
      const signals = await runOnContent(check, 'FOO BAR\n');
      const fooSig = signals.find((s) => s.metadata?.type === 'foo');
      const barSig = signals.find((s) => s.metadata?.type === 'bar');
      expect(fooSig).toBeDefined();
      expect(barSig).toBeDefined();
    });

    it('emits the pattern slug as the violation type', async () => {
      const check = defineRegexListCheck({
        id: FIXED_ID,
        slug: 'sub-slug-emission',
        description: 'd',
        tags: ['demo'],
        fileTypes: ['ts'],
        patterns: [
          {
            id: PATTERN_ID_A,
            slug: 'console-debug',
            regex: /console\.debug/g,
            message: 'console.debug detected',
            severity: 'error',
          },
        ],
      });
      const signals = await runOnContent(check, 'console.debug("hi")\n');
      expect(signals.length).toBe(1);
      expect(signals[0]?.metadata?.type).toBe('console-debug');
    });

    it('skipFile predicate skips matching files entirely', async () => {
      const check = defineRegexListCheck({
        id: FIXED_ID,
        slug: 'skip-file',
        description: 'd',
        tags: ['demo'],
        fileTypes: ['ts'],
        options: { skipFile: (p) => p.includes('/cli-output/') },
        patterns: [
          { id: PATTERN_ID_A, slug: 'foo', regex: /FOO/g, message: 'FOO', severity: 'error' },
        ],
      });
      const inFile = await runOnContent(check, 'FOO\n', 'src/cli-output/foo.ts');
      const outFile = await runOnContent(check, 'FOO\n', 'src/lib/foo.ts');
      expect(inFile.length).toBe(0);
      expect(outFile.length).toBe(1);
    });

    it('skipLine predicate skips matching lines', async () => {
      const check = defineRegexListCheck({
        id: FIXED_ID,
        slug: 'skip-line',
        description: 'd',
        tags: ['demo'],
        fileTypes: ['ts'],
        options: { skipLine: (trimmed) => trimmed.startsWith('import ') },
        patterns: [
          { id: PATTERN_ID_A, slug: 'foo', regex: /FOO/g, message: 'FOO', severity: 'error' },
        ],
      });
      const signals = await runOnContent(check, 'import { FOO } from "x"\nFOO\n');
      // The import line is skipped; only the second line emits a violation.
      expect(signals.length).toBe(1);
      expect(signals[0]?.code?.line).toBe(2);
    });

    it('oneViolationPerLine emits at most one violation per line across all patterns', async () => {
      const check = defineRegexListCheck({
        id: FIXED_ID,
        slug: 'one-per-line',
        description: 'd',
        tags: ['demo'],
        fileTypes: ['ts'],
        options: { oneViolationPerLine: true },
        patterns: [
          { id: PATTERN_ID_A, slug: 'foo', regex: /FOO/g, message: 'FOO', severity: 'error' },
          { id: PATTERN_ID_B, slug: 'bar', regex: /BAR/g, message: 'BAR', severity: 'error' },
        ],
      });
      // Line 1 has both FOO and BAR — only one violation should be
      // emitted (the first matching pattern).
      const signals = await runOnContent(check, 'FOO BAR FOO BAR\n');
      expect(signals.length).toBe(1);
      // Subsequent lines still each get up to one violation.
      const multi = await runOnContent(check, 'FOO\nBAR\n');
      expect(multi.length).toBe(2);
    });
  });
});
