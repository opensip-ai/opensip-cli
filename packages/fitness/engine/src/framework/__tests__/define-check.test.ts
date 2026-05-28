// @fitness-ignore-file file-length-limit -- aggregate coverage-driven test fixture; splitting destroys the contract
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { LanguageRegistry, RunScope, runWithScopeSync } from '@opensip-tools/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { defineCheck } from '../define-check.js';
import { fileCache } from '../file-cache.js';

import type { LanguageAdapter } from '@opensip-tools/core';

const stubAdapter = (id: string, aliases: readonly string[] = []): LanguageAdapter => ({
  id,
  fileExtensions: [`.${id}`],
  aliases,
  parse: () => null,
  stripStrings: (s) => s,
  stripComments: (s) => s,
});

describe('defineCheck', () => {
  describe('analyze mode', () => {
    const noFooCheck = defineCheck({
      id: '11111111-1111-4111-8111-111111111111',
      slug: 'no-foo',
      description: 'flag any line containing FOO',
      tags: ['quality'],
      analyze: (content, filePath) => {
        const out: { line: number; message: string; severity: 'error' | 'warning'; filePath: string }[] = [];
        const lines = content.split('\n');
        for (const [i, line] of lines.entries()) {
          if (line?.includes('FOO')) {
            out.push({ line: i + 1, message: 'FOO not allowed', severity: 'error', filePath });
          }
        }
        return out;
      },
    });

    it('returns a Check with the configured slug and id', () => {
      expect(noFooCheck.config.slug).toBe('no-foo');
      expect(noFooCheck.config.id).toBe('11111111-1111-4111-8111-111111111111');
    });

    it('defaults itemType to "files"', () => {
      expect(noFooCheck.config.itemType).toBe('files');
    });

    it('marks scansFiles=true for analyze mode', () => {
      expect(noFooCheck.config.scansFiles).toBe(true);
    });

    it('records analysisMode "analyze"', () => {
      expect(noFooCheck.config.analysisMode).toBe('analyze');
    });

    it('preserves user-supplied tags', () => {
      expect(noFooCheck.config.tags).toEqual(['quality']);
    });

    it('exposes a getScope() and getMatcher() pair', () => {
      const scope = noFooCheck.getScope();
      expect(scope.include).toEqual([]);
      expect(noFooCheck.getMatcher('/tmp')).toBeDefined();
    });
  });

  describe('analyzeAll mode', () => {
    const allCheck = defineCheck({
      id: '22222222-2222-4222-8222-222222222222',
      slug: 'all-mode-check',
      description: 'returns no violations',
      tags: ['demo'],
      // eslint-disable-next-line @typescript-eslint/require-await -- stub for shape verification
      analyzeAll: async () => [],
    });

    it('records analysisMode "analyzeAll"', () => {
      expect(allCheck.config.analysisMode).toBe('analyzeAll');
    });

    it('marks scansFiles=true for analyzeAll mode', () => {
      expect(allCheck.config.scansFiles).toBe(true);
    });
  });

  describe('command mode', () => {
    const cmd = defineCheck({
      id: '33333333-3333-4333-8333-333333333333',
      slug: 'cmd-check',
      description: 'shells out',
      tags: ['demo'],
      command: { bin: 'echo', args: ['hello'], parseOutput: () => [] },
    });

    it('records analysisMode "command"', () => {
      expect(cmd.config.analysisMode).toBe('command');
    });

    it('marks scansFiles=false for command mode', () => {
      expect(cmd.config.scansFiles).toBe(false);
    });
  });

  describe('scope handling', () => {
    it('passes through scope.languages and scope.concerns', () => {
      const c = defineCheck({
        id: '44444444-4444-4444-8444-444444444444',
        slug: 'scoped',
        description: 's',
        tags: ['demo'],
        scope: { languages: ['typescript', 'rust'], concerns: ['backend'] },
        analyze: () => [],
      });
      expect(c.config.checkScope?.languages).toEqual(['typescript', 'rust']);
      expect(c.config.checkScope?.concerns).toEqual(['backend']);
    });

    it('leaves checkScope undefined when scope is omitted', () => {
      const c = defineCheck({
        id: '55555555-5555-4555-8555-555555555555',
        slug: 'unscoped',
        description: 's',
        tags: ['demo'],
        analyze: () => [],
      });
      expect(c.config.checkScope).toBeUndefined();
    });
  });

  // Cross-pack alias regression — closes Layer 1 Phase 2 / Layer 3
  // plan Phase A2. A check declared with `scope: { languages: ['rs'] }`
  // should be canonicalised to `'rust'` at intake so target-side
  // matching (also canonicalised) finds it. `stubAdapter` is at module
  // scope above.
  describe('scope canonicalisation through registry aliases', () => {
    let testScope: RunScope;

    beforeEach(() => {
      const reg = new LanguageRegistry();
      reg.register(stubAdapter('cpp', ['c', 'c++']));
      reg.register(stubAdapter('rust', ['rs']));
      reg.register(stubAdapter('go', ['golang']));
      reg.register(stubAdapter('python', ['py']));
      testScope = new RunScope({ languages: reg });
    });

    it.each([
      ['c', 'cpp'],
      ['c++', 'cpp'],
      ['rs', 'rust'],
      ['golang', 'go'],
      ['py', 'python'],
    ])('canonicalises scope.languages: ["%s"] → "%s"', (alias, canonical) => {
      const c = runWithScopeSync(testScope, () =>
        defineCheck({
          id: '77777777-7777-4777-8777-777777777777',
          slug: 'aliased',
          description: 'd',
          tags: ['demo'],
          scope: { languages: [alias], concerns: ['backend'] },
          analyze: () => [],
        }),
      );
      expect(c.config.checkScope?.languages).toEqual([canonical]);
    });

    it('leaves canonical ids unchanged', () => {
      const c = runWithScopeSync(testScope, () =>
        defineCheck({
          id: '88888888-8888-4888-8888-888888888888',
          slug: 'canonical',
          description: 'd',
          tags: ['demo'],
          scope: { languages: ['cpp', 'rust'], concerns: [] },
          analyze: () => [],
        }),
      );
      expect(c.config.checkScope?.languages).toEqual(['cpp', 'rust']);
    });

    it('passes unknown languages through (case-folded) so checks still register', () => {
      const c = runWithScopeSync(testScope, () =>
        defineCheck({
          id: '99999999-9999-4999-8999-999999999999',
          slug: 'unknown-lang',
          description: 'd',
          tags: ['demo'],
          scope: { languages: ['Ada'], concerns: [] },
          analyze: () => [],
        }),
      );
      expect(c.config.checkScope?.languages).toEqual(['ada']);
    });

    it('falls back to lowercase when no scope is bound at defineCheck time', () => {
      // No runWithScope wrapper — defineCheck should not throw, just lowercase.
      const c = defineCheck({
        id: '77777777-aaaa-4777-8777-aaaaaaaaaaaa',
        slug: 'no-scope',
        description: 'd',
        tags: ['demo'],
        scope: { languages: ['RS'], concerns: [] },
        analyze: () => [],
      });
      // Lowercase the alias since no registry is available to canonicalise it.
      expect(c.config.checkScope?.languages).toEqual(['rs']);
    });
  });

  describe('runtime metadata passthrough', () => {
    it('preserves docs, disabled, confidence, and timeout', () => {
      const c = defineCheck({
        id: '66666666-6666-4666-8666-666666666666',
        slug: 'with-meta',
        description: 'meta',
        tags: ['demo'],
        docs: 'https://example.com/x',
        disabled: true,
        confidence: 'high',
        timeout: 1234,
        analyze: () => [],
      });
      expect(c.config.docs).toBe('https://example.com/x');
      expect(c.config.disabled).toBe(true);
      expect(c.config.confidence).toBe('high');
      expect(c.config.timeout).toBe(1234);
    });

    it('copies fileTypes when provided', () => {
      const c = defineCheck({
        id: '77777777-7777-4777-8777-777777777777',
        slug: 'typed',
        description: 'd',
        tags: ['demo'],
        fileTypes: ['ts', 'tsx'],
        analyze: () => [],
      });
      expect(c.config.fileTypes).toEqual(['ts', 'tsx']);
    });
  });

  describe('validation', () => {
    it('throws when id is missing', () => {
      expect(() =>
        // @ts-expect-error — testing the runtime guard
        defineCheck({ slug: 'no-id', description: 'd', tags: [], analyze: () => [] }),
      ).toThrow();
    });

    it('throws when id is not a UUID', () => {
      expect(() =>
        defineCheck({
          id: 'not-a-uuid',
          slug: 'bad-id',
          description: 'd',
          tags: ['demo'],
          analyze: () => [],
        }),
      ).toThrow();
    });

    it('throws when slug is missing', () => {
      expect(() =>
        defineCheck({
          id: '88888888-8888-4888-8888-888888888888',
          // @ts-expect-error — testing the runtime guard
          slug: undefined,
          description: 'd',
          tags: ['demo'],
          analyze: () => [],
        }),
      ).toThrow();
    });
  });
});

// =============================================================================
// RUNTIME EXECUTION (Check.run)
// =============================================================================

let testDir: string;

function fixture(rel: string, content: string): string {
  const abs = join(testDir, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content);
  return abs;
}

beforeEach(() => {
  testDir = mkdtempSync(join(tmpdir(), 'opensip-define-check-run-'));
});

afterEach(() => {
  fileCache.clear();
  rmSync(testDir, { recursive: true, force: true });
});

describe('defineCheck — analyze mode end-to-end run', () => {
  it('produces signals for matched lines via Check.run()', async () => {
    fixture('a.ts', 'const x = "FOO";\nconst y = 2;');
    await fileCache.prewarm(testDir, ['**/*.ts']);

    const check = defineCheck({
      id: 'aa000000-aa00-4aa0-8aa0-aa0000000001',
      slug: 'flag-foo-rt',
      description: 'd',
      tags: ['quality'],
      analyze: (content, filePath) => {
        const out: { line: number; message: string; severity: 'error' | 'warning'; filePath: string }[] = [];
        const lines = content.split('\n');
        for (const [i, line] of lines.entries()) {
          if (line.includes('FOO')) {
            out.push({ line: i + 1, message: 'no foo', severity: 'error', filePath });
          }
        }
        return out;
      },
    });

    const result = await check.run(testDir);
    expect(result.passed).toBe(false);
    expect(result.signals.length).toBeGreaterThanOrEqual(1);
    expect(result.errors).toBeGreaterThanOrEqual(1);
  });

  it('returns a passing result when analyze returns nothing', async () => {
    fixture('a.ts', 'const x = 1;');
    await fileCache.prewarm(testDir, ['**/*.ts']);

    const check = defineCheck({
      id: 'aa000000-aa00-4aa0-8aa0-aa0000000002',
      slug: 'pass-rt',
      description: 'd',
      tags: ['quality'],
      analyze: () => [],
    });

    const result = await check.run(testDir);
    expect(result.passed).toBe(true);
    expect(result.errors).toBe(0);
  });

  it('captures a thrown error in analyzeAll and surfaces it as an error result', async () => {
    fixture('a.ts', 'const x = 1;');
    await fileCache.prewarm(testDir, ['**/*.ts']);

    const check = defineCheck({
      id: 'aa000000-aa00-4aa0-8aa0-aa0000000003',
      slug: 'crash-rt',
      description: 'd',
      tags: ['quality'],
      // eslint-disable-next-line @typescript-eslint/require-await
      analyzeAll: async () => {
        throw new Error('analyze blew up');
      },
    });

    const result = await check.run(testDir);
    expect(result.passed).toBe(false);
    expect(result.errors).toBeGreaterThanOrEqual(1);
  });
});

describe('defineCheck — analyzeAll mode end-to-end run', () => {
  it('runs analyzeAll once with a FileAccessor and returns its violations', async () => {
    fixture('a.ts', 'export const a = 1');
    fixture('b.ts', 'export const b = 2');
    await fileCache.prewarm(testDir, ['**/*.ts']);

    const check = defineCheck({
      id: 'bb000000-bb00-4bb0-8bb0-bb0000000001',
      slug: 'all-rt',
      description: 'all-mode',
      tags: ['quality'],
      // eslint-disable-next-line @typescript-eslint/require-await -- analyzeAll signature is Promise<Violation[]>; this body is synchronous
      analyzeAll: async (accessor) => {
        const files = accessor.paths;
        return [
          { line: 1, message: `saw ${files.length} files`, severity: 'warning' as const, filePath: files[0] ?? 'unknown' },
        ];
      },
    });

    const result = await check.run(testDir);
    expect(result.signals).toHaveLength(1);
    expect(result.signals[0]?.message).toContain('saw');
  });

  it('warns (via log) when an analyzeAll violation is missing filePath', async () => {
    fixture('a.ts', 'export const a = 1');
    await fileCache.prewarm(testDir, ['**/*.ts']);

    const check = defineCheck({
      id: 'bb000000-bb00-4bb0-8bb0-bb0000000002',
      slug: 'no-filepath',
      description: 'd',
      tags: ['quality'],
      // eslint-disable-next-line @typescript-eslint/require-await -- analyzeAll signature is Promise<Violation[]>; this body is synchronous
      analyzeAll: async () => [
        { line: 1, message: 'global', severity: 'warning' as const },
      ],
    });

    const result = await check.run(testDir, { verbose: true });
    expect(result.signals).toHaveLength(1);
  });
});

describe('defineCheck — command mode end-to-end run', () => {
  it('runs the configured external command and parses output', async () => {
    fixture('a.ts', 'export const a = 1');
    await fileCache.prewarm(testDir, ['**/*.ts']);

    const check = defineCheck({
      id: 'cc000000-cc00-4cc0-8cc0-cc0000000001',
      slug: 'echo-cmd',
      description: 'echo',
      tags: ['quality'],
      command: {
        bin: 'echo',
        args: ['1 finding'],
        parseOutput: (stdout) => [{
          line: 1,
          message: stdout.trim(),
          severity: 'warning' as const,
          filePath: 'virtual',
        }],
      },
    });

    const result = await check.run(testDir);
    expect(result.signals.length).toBeGreaterThanOrEqual(1);
    expect(result.signals[0]?.message).toBe('1 finding');
  });

  it('runs the command-mode error path when the bin is missing (ENOENT)', async () => {
    fixture('a.ts', 'export const a = 1');
    await fileCache.prewarm(testDir, ['**/*.ts']);

    const check = defineCheck({
      id: 'cc000000-cc00-4cc0-8cc0-cc0000000002',
      slug: 'missing-cmd',
      description: 'd',
      tags: ['quality'],
      command: {
        bin: 'definitely-not-a-real-binary-zzz',
        args: [],
        parseOutput: () => [],
      },
    });

    // The command-executor surfaces the missing-bin error and the
    // builder converts it to an error result. After the directive
    // filter pass, the result still completes (no exception) — exercising
    // executeCommandMode's `if (result.error)` branch is the goal.
    const result = await check.run(testDir);
    expect(result).toBeDefined();
    expect(Array.isArray(result.signals)).toBe(true);
  });
});
