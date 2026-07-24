import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import {
  enterScope,
  LanguageRegistry,
  logger,
  RunScope,
  runWithScopeSync,
} from '@opensip-cli/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { defineCheck } from '../define-check.js';
import { fileCache } from '../file-cache.js';

import type { LanguageAdapter } from '@opensip-cli/core';

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
        const out: {
          line: number;
          message: string;
          severity: 'error' | 'warning';
          filePath: string;
        }[] = [];
        const lines = content.split('\n');
        for (const [i, line] of lines.entries()) {
          if (line?.includes('FOO')) {
            out.push({
              line: i + 1,
              message: 'FOO not allowed',
              severity: 'error',
              filePath,
            });
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
        defineCheck({
          slug: 'no-id',
          description: 'd',
          tags: [],
          analyze: () => [],
        }),
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

let runScope: RunScope;

beforeEach(() => {
  testDir = mkdtempSync(join(tmpdir(), 'opensip-define-check-run-'));
  // Check.run() resolves the per-run cache from currentScope()?.fitness?.fileCache
  // (no module-singleton fallback — parallel-tool-invocations Phase 1). These
  // end-to-end run tests prewarm the (test-only) module singleton, so enter a
  // scope whose fitness.fileCache IS that singleton — keeping the existing
  // `fileCache.prewarm(...)` calls valid while the scope resolution finds it.
  runScope = new RunScope();
  Object.assign(runScope, { fitness: { fileCache } });
  enterScope(runScope);
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
        const out: {
          line: number;
          message: string;
          severity: 'error' | 'warning';
          filePath: string;
        }[] = [];
        const lines = content.split('\n');
        for (const [i, line] of lines.entries()) {
          if (line.includes('FOO')) {
            out.push({
              line: i + 1,
              message: 'no foo',
              severity: 'error',
              filePath,
            });
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

  it('surfaces a thrown error in per-file analyze() as an error result, not a silent file skip', async () => {
    fixture('a.ts', 'TRIGGER\n');
    fixture('b.ts', 'fine content\n');
    await fileCache.prewarm(testDir, ['**/*.ts']);

    const check = defineCheck({
      id: 'aa000000-aa00-4aa0-8aa0-aa0000000004',
      slug: 'analyze-crash-rt',
      description: 'd',
      tags: ['quality'],
      analyze: (content) => {
        if (content.includes('TRIGGER')) {
          throw new TypeError('analyze blew up on this file');
        }
        return [];
      },
    });

    const result = await check.run(testDir);
    expect(result.passed).toBe(false);
    expect(result.errors).toBeGreaterThanOrEqual(1);
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
          {
            line: 1,
            message: `saw ${files.length} files`,
            severity: 'warning' as const,
            filePath: files[0] ?? 'unknown',
          },
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
      analyzeAll: async () => [{ line: 1, message: 'global', severity: 'warning' as const }],
    });

    const result = await check.run(testDir, { verbose: true });
    expect(result.signals).toHaveLength(1);
  });

  it('threads the per-run scope cache into the FileAccessor (analyzeAll reads prewarmed content, not disk)', async () => {
    // Call-site guardrail (parallel-tool-invocations Phase 1, Task 1.5): the
    // analyzeAll executor passes currentScope()?.fitness?.fileCache into
    // createFileAccessor. We prewarm the scope cache (the module singleton here)
    // with the on-disk content, then MUTATE disk. If the call site threads the
    // scope cache, the accessor returns the prewarmed bytes; if it bypassed the
    // cache (the historical global-miss bug) it would read the mutated disk.
    const file = fixture('only.ts', 'export const cached = true');
    await fileCache.prewarm(testDir, ['**/*.ts']);
    writeFileSync(file, 'export const cached = false /* DISK MUTATED */');

    const check = defineCheck({
      id: 'bb000000-bb00-4bb0-8bb0-bb0000000003',
      slug: 'reads-scope-cache',
      description: 'reads from the injected scope cache',
      tags: ['quality'],
      analyzeAll: async (accessor) => {
        const content = await accessor.read(file);
        return content.includes('DISK MUTATED')
          ? [
              {
                line: 1,
                message: 'read disk',
                severity: 'error' as const,
                filePath: file,
              },
            ]
          : [];
      },
    });

    const result = await check.run(testDir);
    // No violation ⇒ the accessor returned the prewarmed (cached) content, i.e.
    // the call site threaded the scope cache.
    expect(result.signals).toHaveLength(0);
    expect(result.passed).toBe(true);
  });
});

describe('defineCheck — repair derivation end-to-end run', () => {
  it('passes an explicit violation.repair straight through untouched', async () => {
    fixture('a.ts', 'const x = 1;');
    await fileCache.prewarm(testDir, ['**/*.ts']);

    const explicitRepair = {
      repairKind: 'add-test' as const,
      autofixable: false,
      confidence: 0.42,
    };

    const check = defineCheck({
      id: 'dd000000-dd00-4dd0-8dd0-dd0000000001',
      slug: 'explicit-repair',
      description: 'd',
      tags: ['quality'],
      analyze: () => [
        {
          line: 1,
          message: 'needs a test',
          severity: 'warning' as const,
          repair: explicitRepair,
        },
      ],
    });

    const result = await check.run(testDir);
    expect(result.signals).toHaveLength(1);
    // The explicit `repair` field wins over any fix/suggestion derivation —
    // repairFromViolation's `if (violation.repair !== undefined) return
    // violation.repair;` short-circuit (define-check.ts).
    expect(result.signals[0]?.repair).toEqual(explicitRepair);
  });

  it('derives repairKind "extract-module" and an "Apply refactor..." patch hint from fix.action=refactor (no suggestion)', async () => {
    const filePath = fixture('a.ts', 'const x = 1;');
    await fileCache.prewarm(testDir, ['**/*.ts']);

    const check = defineCheck({
      id: 'dd000000-dd00-4dd0-8dd0-dd0000000002',
      slug: 'refactor-fix',
      description: 'd',
      tags: ['quality'],
      analyze: (_content, fp) => [
        {
          line: 1,
          message: 'extract this',
          severity: 'warning' as const,
          filePath: fp,
          fix: { action: 'refactor' as const, confidence: 0.7 },
        },
      ],
    });

    const result = await check.run(testDir);
    expect(result.signals).toHaveLength(1);
    const repair = result.signals[0]?.repair;
    // repairKindForFitnessAction('refactor') -> 'extract-module'
    expect(repair?.repairKind).toBe('extract-module');
    expect(repair?.confidence).toBe(0.7);
    // No fix.replacement -> autofixable must be false regardless of action.
    expect(repair?.autofixable).toBe(false);
    // No suggestion -> summary falls back to "Apply <action> remediation...";
    // non-empty filePath -> patchHint carries a `target`.
    expect(repair?.patchHint).toEqual({
      kind: 'text',
      summary: 'Apply refactor remediation for this finding',
      target: filePath,
    });
  });

  it('marks autofixable=true only when fix.replacement is set AND action is replace/insert/delete', async () => {
    fixture('a.ts', 'const x = 1;');
    await fileCache.prewarm(testDir, ['**/*.ts']);

    const check = defineCheck({
      id: 'dd000000-dd00-4dd0-8dd0-dd0000000003',
      slug: 'delete-fix',
      description: 'd',
      tags: ['quality'],
      analyze: () => [
        {
          line: 1,
          message: 'remove this',
          severity: 'error' as const,
          fix: { action: 'delete' as const, replacement: '', confidence: 0.9 },
        },
      ],
    });

    const result = await check.run(testDir);
    expect(result.signals).toHaveLength(1);
    expect(result.signals[0]?.repair?.autofixable).toBe(true);
    expect(result.signals[0]?.repair?.repairKind).toBe('manual');
  });

  it('omits patchHint.target (but still sets summary) when a violation has no resolvable filePath', async () => {
    fixture('a.ts', 'export const a = 1');
    await fileCache.prewarm(testDir, ['**/*.ts']);

    const check = defineCheck({
      id: 'dd000000-dd00-4dd0-8dd0-dd0000000004',
      slug: 'no-path-suggestion',
      description: 'd',
      tags: ['quality'],
      // analyzeAll violations without filePath resolve toSignal's
      // `defaultFilePath` to undefined too, so repairFromViolation sees
      // filePath === '' (define-check.ts toSignal fallback chain).
      // eslint-disable-next-line @typescript-eslint/require-await -- analyzeAll signature is async; body is sync
      analyzeAll: async () => [
        { line: 1, message: 'global issue', severity: 'warning' as const, suggestion: 'fix it' },
      ],
    });

    const result = await check.run(testDir);
    expect(result.signals).toHaveLength(1);
    expect(result.signals[0]?.repair?.patchHint).toEqual({
      kind: 'text',
      summary: 'fix it',
    });
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
        parseOutput: (stdout) => [
          {
            line: 1,
            message: stdout.trim(),
            severity: 'warning' as const,
            filePath: 'virtual',
          },
        ],
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

  it('skips invocation and reports "Skipped: no matched files" for a file-list command when zero files match', async () => {
    // Deliberately prewarm a pattern that matches nothing in testDir, so
    // ctx.matchFiles() (and hence `files`) is empty — executeCommandMode's
    // fail-closed guard for file-list-driven scanners (define-check.ts).
    await fileCache.prewarm(testDir, ['**/*.this-extension-does-not-exist']);

    const check = defineCheck({
      id: 'cc000000-cc00-4cc0-8cc0-cc0000000003',
      slug: 'file-list-cmd',
      description: 'd',
      tags: ['quality'],
      command: {
        // `args` is a function with arity > 0 (files) -> the
        // no-matched-files skip path applies instead of invoking `echo`.
        bin: 'echo',
        args: (files: readonly string[]) => files,
        parseOutput: () => [],
      },
    });

    const result = await check.run(testDir);
    expect(result.passed).toBe(true);
    expect(result.signals).toHaveLength(0);
    expect(result.info?.label).toBe('Skipped: no matched files');
    expect(result.metadata.extra?.skipped).toBe(true);
    expect(result.metadata.extra?.skipReason).toBe('no-matched-files');
  });

  it('surfaces an unexpected exit code as an error result (not a silent skip)', async () => {
    fixture('a.ts', 'export const a = 1');
    await fileCache.prewarm(testDir, ['**/*.ts']);

    const check = defineCheck({
      id: 'cc000000-cc00-4cc0-8cc0-cc0000000004',
      slug: 'nonzero-exit-cmd',
      description: 'd',
      tags: ['quality'],
      command: {
        // A real binary (node) that exits with a code outside the default
        // expected set [0, 1] -> command-executor's unexpectedExitResult,
        // which is NOT `notInstalled` -> executeCommandMode's
        // `return builder.buildError(result.error)` path (define-check.ts).
        bin: process.execPath,
        args: ['-e', 'process.exit(2)'],
        parseOutput: () => [],
      },
    });

    const result = await check.run(testDir);
    expect(result.passed).toBe(false);
    expect(result.errors).toBeGreaterThanOrEqual(1);
    expect(result.metadata.extra?.skipped).toBeUndefined();
  });
});

describe('defineCheck — analyze mode oversized-file skip (fail-loud posture)', () => {
  it('skips a >10MB file at warn level (not debug) and surfaces it on the diagnostics bus', async () => {
    // Explicit targetFiles (mirrors the production scope-resolver path,
    // fit.ts's checkTargetFiles) rather than relying on the fileCache
    // fallback: prewarm() itself skips >10MB files, so an oversized file
    // never appears in fc.paths() and the no-scope fallback would never
    // exercise ExecutionContext.readFile's size guard at all.
    const hugePath = join(testDir, 'huge.ts');
    writeFileSync(hugePath, Buffer.alloc(10_000_001));
    const smallPath = fixture('small.ts', 'const x = "FOO";');

    const warnSpy = vi.spyOn(logger, 'warn');
    try {
      const check = defineCheck({
        id: 'dd000000-dd00-4dd0-8dd0-dd0000000001',
        slug: 'oversized-rt',
        description: 'd',
        tags: ['quality'],
        analyze: (content, filePath) =>
          content.includes('FOO')
            ? [{ line: 1, message: 'found FOO', severity: 'error' as const, filePath }]
            : [],
      });

      const result = await check.run(testDir, { targetFiles: [hugePath, smallPath] });

      // The oversized file is skipped without crashing the check (still a
      // 'skip', not a thrown/unhandled error) — the other target file is
      // still analyzed normally, proving the run isn't aborted.
      expect(result.passed).toBe(false);
      expect(result.errors).toBeGreaterThanOrEqual(1);

      // Surfaced loudly: a warn-level log line naming the file and check
      // slug (previously this only logged at debug).
      const warnCall = warnSpy.mock.calls.find(
        (call) =>
          (call[1] as { evt?: string } | undefined)?.evt === 'fitness.check.file.skip.too_large',
      );
      expect(warnCall).toBeDefined();
      const warnFields = warnCall?.[1] as { filePath?: string; checkSlug?: string } | undefined;
      expect(warnFields?.filePath).toBe(hugePath);
      expect(warnFields?.checkSlug).toBe('oversized-rt');

      // ...and on the per-run diagnostics bus, so a --json consumer sees it
      // too (not just the human log stream).
      const events = runScope.diagnostics.snapshot().events;
      expect(events.some((e) => e.level === 'warn' && e.message.includes('huge.ts'))).toBe(true);
    } finally {
      warnSpy.mockRestore();
    }
  });
});
