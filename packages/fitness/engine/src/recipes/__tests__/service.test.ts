/**
 * @fileoverview Integration tests for FitnessRecipeService.
 *
 * Drives the full orchestration path (parallel/sequential execution,
 * file cache prewarm, AST parse cache, directive application,
 * disabled-checks filtering) against fixture projects so coverage
 * reflects the orchestrator code, not just the per-check pure
 * analyzer functions.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import {
  ConfigurationError,
  currentScope,
  enterScope,
  RunScope,
  applyToolContributeScope,
} from '@opensip-cli/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { defineCheck } from '../../framework/define-check.js';
import { FileCache } from '../../framework/file-cache.js';
import { CheckRegistry } from '../../framework/registry.js';
import { fitnessTool } from '../../tool.js';
import { FitnessRecipeRegistry } from '../registry.js';
import { FitnessRecipeService } from '../service.js';

import type { Check } from '../../framework/check-types.js';
import type { FitnessRecipe } from '../types.js';

// =============================================================================
// FIXTURE HELPERS
// =============================================================================

let testDir: string;

function writeFixture(relPath: string, content: string): string {
  const abs = join(testDir, relPath);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content);
  return abs;
}

beforeEach(() => {
  // Enter a fresh RunScope with fitness's contributed registries so the
  // FitnessRecipeService constructor's default-registry path
  // (`currentCheckRegistry()` / `currentRecipeRegistry()`) resolves — the
  // production behaviour (a fit run always executes inside a scope). Tests that
  // pass explicit registries override these and are unaffected.
  const scope = new RunScope();
  applyToolContributeScope(scope, fitnessTool);
  enterScope(scope);
  testDir = mkdtempSync(join(tmpdir(), 'opensip-recipe-svc-'));
});

afterEach(() => {
  rmSync(testDir, { recursive: true, force: true });
});

// =============================================================================
// CHECK FIXTURES
// =============================================================================

let nextId = 0;
function uid(): string {
  // Deterministic UUID v4 shape per test run, unique per call.
  nextId++;
  const id = nextId.toString(16).padStart(12, '0');
  return `00000000-0000-4000-8000-${id}`;
}

/** A simple check that flags any line containing the marker. */
function makeMarkerCheck(
  slug: string,
  marker: string,
  severity: 'error' | 'warning' = 'warning',
  tags: string[] = ['quality'],
): Check {
  return defineCheck({
    id: uid(),
    slug,
    description: `Flag any line containing ${marker}`,
    tags,
    analyze: (content, filePath) => {
      const out: {
        line: number;
        message: string;
        severity: 'error' | 'warning';
        filePath: string;
      }[] = [];
      const lines = content.split('\n');
      for (const [i, line] of lines.entries()) {
        if (line.includes(marker)) {
          out.push({
            line: i + 1,
            message: `Found ${marker}`,
            severity,
            filePath,
          });
        }
      }
      return out;
    },
  });
}

function makeRecipe(overrides: Partial<FitnessRecipe> = {}): FitnessRecipe {
  return {
    id: 'URCP_test',
    name: 'test',
    displayName: 'Test',
    description: 'integration test recipe',
    checks: { type: 'all', exclude: [] },
    execution: {
      mode: 'parallel',
      stopOnFirstFailure: false,
      timeout: 30_000,
      maxParallel: 4,
    },
    reporting: { format: 'table', verbose: false },
    ...overrides,
  };
}

// =============================================================================
// CONSTRUCTOR + CONFIG
// =============================================================================

describe('FitnessRecipeService — construction', () => {
  it('builds with no config', () => {
    const svc = new FitnessRecipeService();
    expect(svc.getActiveSession()).toBeNull();
  });

  it('uses provided check + recipe registries', async () => {
    const checkRegistry = new CheckRegistry();
    checkRegistry.register(makeMarkerCheck('flag-foo', 'FOO'));
    const recipeRegistry = new FitnessRecipeRegistry();

    const svc = new FitnessRecipeService({
      cwd: testDir,
      checkRegistry,
      recipeRegistry,
      prewarmCache: false,
    });
    writeFixture('a.ts', 'const x = "FOO";');

    const result = await svc.start(makeRecipe());
    expect(result.summary.totalChecks).toBe(1);
  });

  it('listRecipes exposes the recipe registry contents', () => {
    const recipeRegistry = new FitnessRecipeRegistry();
    const svc = new FitnessRecipeService({ recipeRegistry });
    expect(svc.listRecipes().length).toBeGreaterThan(0);
  });

  it('getRecipe resolves a recipe by name and ID', () => {
    const recipeRegistry = new FitnessRecipeRegistry();
    const svc = new FitnessRecipeService({ recipeRegistry });
    expect(svc.getRecipe('default')).toBeDefined();
    expect(svc.getRecipe('NOT_REAL')).toBeUndefined();
  });
});

// =============================================================================
// EXECUTION — PARALLEL
// =============================================================================

describe('FitnessRecipeService — parallel execution', () => {
  it('runs every registered check against fixture files', async () => {
    const checkRegistry = new CheckRegistry();
    checkRegistry.register(makeMarkerCheck('flag-foo', 'FOO'));
    checkRegistry.register(makeMarkerCheck('flag-bar', 'BAR'));

    writeFixture('a.ts', 'const x = "FOO";\nconst y = "BAR";');

    const svc = new FitnessRecipeService({
      cwd: testDir,
      checkRegistry,
      recipeRegistry: new FitnessRecipeRegistry(),
      prewarmCache: true,
    });

    const result = await svc.start(makeRecipe());
    expect(result.summary.totalChecks).toBe(2);
    expect(result.summary.totalViolations).toBeGreaterThanOrEqual(2);
  });

  it('calls onCheckStart / onCheckComplete / onComplete callbacks', async () => {
    const starts: string[] = [];
    const completes: string[] = [];
    let onComplete = false;

    const checkRegistry = new CheckRegistry();
    checkRegistry.register(makeMarkerCheck('flag-x', 'X'));
    writeFixture('a.ts', 'const x = "X";');

    const svc = new FitnessRecipeService({
      cwd: testDir,
      checkRegistry,
      recipeRegistry: new FitnessRecipeRegistry(),
      prewarmCache: false,
      callbacks: {
        onCheckStart: (slug) => starts.push(slug),
        onCheckComplete: (slug) => completes.push(slug),
        onComplete: () => {
          onComplete = true;
        },
      },
    });

    await svc.start(makeRecipe());
    expect(starts).toContain('flag-x');
    expect(completes).toContain('flag-x');
    expect(onComplete).toBe(true);
  });

  it('a throwing onCheckStart does not abort the session or the checks after it', async () => {
    // Regression: onCheckStart used to run outside runOneCheck's try/catch,
    // so a throwing observer callback rejected the check-scheduling promise
    // entirely — the whole session was caught by executeRecipeInScope's
    // top-level catch, marked 'failed', and every remaining check was
    // aborted. `svc.start()` must still resolve, and BOTH checks (including
    // the one after the throwing callback's check, run sequentially) must
    // complete.
    const completes: string[] = [];

    const checkRegistry = new CheckRegistry();
    checkRegistry.register(makeMarkerCheck('first', 'X'));
    checkRegistry.register(makeMarkerCheck('second', 'X'));
    writeFixture('a.ts', 'const x = "X";');

    const svc = new FitnessRecipeService({
      cwd: testDir,
      checkRegistry,
      recipeRegistry: new FitnessRecipeRegistry(),
      prewarmCache: false,
      callbacks: {
        onCheckStart: (slug) => {
          if (slug === 'first') throw new Error('onCheckStart exploded');
        },
        onCheckComplete: (slug) => completes.push(slug),
      },
    });

    const result = await svc.start(
      makeRecipe({
        execution: {
          mode: 'sequential',
          stopOnFirstFailure: false,
          timeout: 30_000,
        },
      }),
    );

    expect(completes.sort()).toEqual(['first', 'second']);
    expect(result.summary.totalChecks).toBe(2);
    expect(result.checkResults.every((cr) => cr.error === undefined)).toBe(true);
  });

  it('returns a result with success=false when score < threshold', async () => {
    const checkRegistry = new CheckRegistry();
    checkRegistry.register(makeMarkerCheck('flag-fail', 'FAIL', 'error'));
    writeFixture('a.ts', 'const x = "FAIL";');

    const svc = new FitnessRecipeService({
      cwd: testDir,
      checkRegistry,
      recipeRegistry: new FitnessRecipeRegistry(),
      prewarmCache: true,
    });

    const result = await svc.start(
      makeRecipe({
        execution: {
          mode: 'parallel',
          successThreshold: 100,
          stopOnFirstFailure: false,
          timeout: 30_000,
        },
      }),
    );
    expect(result.success).toBe(false);
    expect(result.summary.failedChecks).toBe(1);
  });

  it('completes a run with no registered checks', async () => {
    const svc = new FitnessRecipeService({
      cwd: testDir,
      checkRegistry: new CheckRegistry(),
      recipeRegistry: new FitnessRecipeRegistry(),
      prewarmCache: false,
    });

    const result = await svc.start(makeRecipe());
    expect(result.summary.totalChecks).toBe(0);
    expect(result.summary.failedChecks).toBe(0);
    expect(result.summary.totalViolations).toBe(0);
  });

  it('marks the session completed (not stuck "running") on a legitimate empty run', async () => {
    // Regression: the zero-checks early return in executeRecipeInScope used to
    // skip the session.status = 'completed' transition applied on every other
    // path, leaving the session stuck 'running'. `buildRecipeResult`'s
    // `success` field requires `status === 'completed'`, so before the fix an
    // empty (but legitimate, e.g. a non-cli-adhoc recipe with zero matched
    // checks) run always reported `success: false` regardless of its 100%
    // (0-total) passRate — and any consumer reading session status directly
    // would see it never leave 'running'.
    const svc = new FitnessRecipeService({
      cwd: testDir,
      checkRegistry: new CheckRegistry(),
      recipeRegistry: new FitnessRecipeRegistry(),
      prewarmCache: false,
    });

    const result = await svc.start(makeRecipe());
    expect(result.success).toBe(true);
    // The session is cleared (activeSession = null) once execution finishes —
    // for either an empty or a non-empty run — so `getActiveSession()` is the
    // externally-observable confirmation the run reached a terminal state
    // rather than hanging mid-flight.
    expect(svc.getActiveSession()).toBeNull();
  });
});

// =============================================================================
// EXECUTION — SEQUENTIAL
// =============================================================================

describe('FitnessRecipeService — sequential execution', () => {
  it('runs checks one at a time when execution.mode === "sequential"', async () => {
    const order: string[] = [];

    const checkRegistry = new CheckRegistry();
    checkRegistry.register(
      defineCheck({
        id: uid(),
        slug: 'first',
        description: 'first',
        tags: ['demo'],
        analyze: () => {
          order.push('first');
          return [];
        },
      }),
    );
    checkRegistry.register(
      defineCheck({
        id: uid(),
        slug: 'second',
        description: 'second',
        tags: ['demo'],
        analyze: () => {
          order.push('second');
          return [];
        },
      }),
    );
    writeFixture('a.ts', 'export const x = 1;');

    const svc = new FitnessRecipeService({
      cwd: testDir,
      checkRegistry,
      recipeRegistry: new FitnessRecipeRegistry(),
      prewarmCache: true,
    });

    await svc.start(
      makeRecipe({
        execution: {
          mode: 'sequential',
          stopOnFirstFailure: false,
          timeout: 30_000,
        },
      }),
    );
    expect(order).toEqual(['first', 'second']);
  });
});

// =============================================================================
// SELECTOR TYPES
// =============================================================================

describe('FitnessRecipeService — selector types', () => {
  it('selector type=explicit runs only the listed checks', async () => {
    const checkRegistry = new CheckRegistry();
    checkRegistry.register(makeMarkerCheck('selected', 'A'));
    checkRegistry.register(makeMarkerCheck('not-selected', 'B'));
    writeFixture('a.ts', '');

    const svc = new FitnessRecipeService({
      cwd: testDir,
      checkRegistry,
      recipeRegistry: new FitnessRecipeRegistry(),
      prewarmCache: false,
    });

    const result = await svc.start(
      makeRecipe({
        checks: { type: 'explicit', checkIds: ['selected'] },
      }),
    );
    expect(result.summary.totalChecks).toBe(1);
    expect(result.checkResults[0]?.checkSlug).toBe('selected');
  });

  it('selector type=tags filters by tag', async () => {
    const checkRegistry = new CheckRegistry();
    checkRegistry.register(makeMarkerCheck('q1', 'A', 'warning', ['quality']));
    checkRegistry.register(makeMarkerCheck('s1', 'B', 'warning', ['security']));
    writeFixture('a.ts', '');

    const svc = new FitnessRecipeService({
      cwd: testDir,
      checkRegistry,
      recipeRegistry: new FitnessRecipeRegistry(),
      prewarmCache: false,
    });

    const result = await svc.start(
      makeRecipe({
        checks: { type: 'tags', include: ['security'] },
      }),
    );
    expect(result.summary.totalChecks).toBe(1);
    expect(result.checkResults[0]?.checkSlug).toBe('s1');
  });

  it('selector type=all with exclude removes listed checks', async () => {
    const checkRegistry = new CheckRegistry();
    checkRegistry.register(makeMarkerCheck('keep-me', 'A'));
    checkRegistry.register(makeMarkerCheck('drop-me', 'B'));
    writeFixture('a.ts', '');

    const svc = new FitnessRecipeService({
      cwd: testDir,
      checkRegistry,
      recipeRegistry: new FitnessRecipeRegistry(),
      prewarmCache: false,
    });

    const result = await svc.start(
      makeRecipe({
        checks: { type: 'all', exclude: ['drop-me'] },
      }),
    );
    expect(result.summary.totalChecks).toBe(1);
    expect(result.checkResults[0]?.checkSlug).toBe('keep-me');
  });
});

// =============================================================================
// DISABLED CHECKS
// =============================================================================

describe('FitnessRecipeService — disabled checks', () => {
  it('skips checks listed in disabledChecks config', async () => {
    const checkRegistry = new CheckRegistry();
    checkRegistry.register(makeMarkerCheck('runs', 'A'));
    checkRegistry.register(makeMarkerCheck('disabled', 'B'));
    writeFixture('a.ts', '');

    const svc = new FitnessRecipeService({
      cwd: testDir,
      checkRegistry,
      recipeRegistry: new FitnessRecipeRegistry(),
      prewarmCache: false,
      disabledChecks: ['disabled'],
    });

    const result = await svc.start(makeRecipe());
    expect(result.summary.totalChecks).toBe(1);
    expect(result.checkResults[0]?.checkSlug).toBe('runs');
  });

  it('runs checks in disabledChecks when listed in recipe.includeDisabled', async () => {
    const checkRegistry = new CheckRegistry();
    checkRegistry.register(makeMarkerCheck('forced', 'A'));
    writeFixture('a.ts', '');

    const svc = new FitnessRecipeService({
      cwd: testDir,
      checkRegistry,
      recipeRegistry: new FitnessRecipeRegistry(),
      prewarmCache: false,
      disabledChecks: ['forced'],
    });

    const result = await svc.start(makeRecipe({ includeDisabled: ['forced'] }));
    expect(result.summary.totalChecks).toBe(1);
  });
});

// =============================================================================
// ERRORS + EDGE CASES
// =============================================================================

describe('FitnessRecipeService — errors', () => {
  it('throws NotFoundError when run() receives an unknown recipe name', async () => {
    const svc = new FitnessRecipeService({
      cwd: testDir,
      recipeRegistry: new FitnessRecipeRegistry(),
      prewarmCache: false,
    });
    await expect(svc.start('does-not-exist')).rejects.toThrow(/Recipe not found/);
  });

  it('throws ConfigurationError when a CLI ad-hoc explicit check is unknown', async () => {
    const svc = new FitnessRecipeService({
      cwd: testDir,
      checkRegistry: new CheckRegistry(),
      recipeRegistry: new FitnessRecipeRegistry(),
      prewarmCache: false,
    });

    await expect(
      svc.start(FitnessRecipeService.createAdHocRecipe({ check: 'ghost-check' })),
    ).rejects.toBeInstanceOf(ConfigurationError);
  });

  it('throws ConfigurationError when --tags matches zero registered checks', async () => {
    // Regression: the zero-matched guard originally only covered the
    // `explicit` selector arm (an unknown exact --check slug). A --tags
    // filter that matches nothing fell through unguarded, resolving to zero
    // checks with no error — the run then silently completed as a clean
    // (green) zero-check pass instead of surfacing the typo/mismatch.
    const checkRegistry = new CheckRegistry();
    checkRegistry.register(makeMarkerCheck('has-quality-tag', 'X', 'warning', ['quality']));
    writeFixture('a.ts', '');

    const svc = new FitnessRecipeService({
      cwd: testDir,
      checkRegistry,
      recipeRegistry: new FitnessRecipeRegistry(),
      prewarmCache: false,
    });

    await expect(
      svc.start(FitnessRecipeService.createAdHocRecipe({ tagFilters: ['no-such-tag'] })),
    ).rejects.toBeInstanceOf(ConfigurationError);
  });

  it('throws ConfigurationError when a --check glob matches zero registered checks', async () => {
    // Regression: same guard gap as --tags above, for the `pattern` selector
    // arm (a --check value containing '*'/'?').
    const checkRegistry = new CheckRegistry();
    checkRegistry.register(makeMarkerCheck('flag-foo', 'X'));
    writeFixture('a.ts', '');

    const svc = new FitnessRecipeService({
      cwd: testDir,
      checkRegistry,
      recipeRegistry: new FitnessRecipeRegistry(),
      prewarmCache: false,
    });

    await expect(
      svc.start(FitnessRecipeService.createAdHocRecipe({ check: 'nonexistent-*' })),
    ).rejects.toBeInstanceOf(ConfigurationError);
  });

  it('throws SystemError when start() is called twice in parallel', async () => {
    const checkRegistry = new CheckRegistry();
    checkRegistry.register(
      defineCheck({
        id: uid(),
        slug: 'slow',
        description: 's',
        tags: ['demo'],
        analyzeAll: async () => {
          await new Promise((r) => setTimeout(r, 50));
          return [];
        },
      }),
    );
    writeFixture('a.ts', '');

    const svc = new FitnessRecipeService({
      cwd: testDir,
      checkRegistry,
      recipeRegistry: new FitnessRecipeRegistry(),
      prewarmCache: false,
    });

    const p1 = svc.start(makeRecipe());
    await expect(svc.start(makeRecipe())).rejects.toThrow(/already in progress/);
    await p1;
  });

  it('captures errors thrown inside a check without aborting the run', async () => {
    const checkRegistry = new CheckRegistry();
    checkRegistry.register(
      defineCheck({
        id: uid(),
        slug: 'crashes',
        description: 'c',
        tags: ['demo'],
        analyze: () => {
          throw new Error('check exploded');
        },
      }),
    );
    checkRegistry.register(makeMarkerCheck('survives', 'X'));
    writeFixture('a.ts', 'export const x = "X";');

    const svc = new FitnessRecipeService({
      cwd: testDir,
      checkRegistry,
      recipeRegistry: new FitnessRecipeRegistry(),
      prewarmCache: true,
    });

    const result = await svc.start(makeRecipe());
    expect(result.summary.totalChecks).toBe(2);
    // The crash is contained: "survives" still completes
    const survives = result.checkResults.find((r) => r.checkSlug === 'survives');
    expect(survives?.error).toBeUndefined();
  });
});

// =============================================================================
// AD-HOC RECIPE FACTORY
// =============================================================================

describe('FitnessRecipeService.createAdHocRecipe', () => {
  it('builds an explicit-selector recipe when --check is passed', () => {
    const recipe = FitnessRecipeService.createAdHocRecipe({
      check: 'no-console-log',
    });
    expect(recipe.checks.type).toBe('explicit');
    if (recipe.checks.type === 'explicit') {
      expect(recipe.checks.checkIds).toEqual(['no-console-log']);
    }
    expect(recipe.includeDisabled).toEqual(['no-console-log']);
  });

  it('builds a pattern-selector recipe when --check contains wildcard', () => {
    const recipe = FitnessRecipeService.createAdHocRecipe({ check: 'no-*' });
    expect(recipe.checks.type).toBe('pattern');
  });

  it('builds a tags-selector recipe when --tags is passed', () => {
    const recipe = FitnessRecipeService.createAdHocRecipe({
      tagFilters: ['security', 'quality'],
    });
    expect(recipe.checks.type).toBe('tags');
    if (recipe.checks.type === 'tags') {
      expect(recipe.checks.include).toEqual(['security', 'quality']);
    }
  });

  it('falls back to all-selector when nothing is passed', () => {
    const recipe = FitnessRecipeService.createAdHocRecipe({});
    expect(recipe.checks.type).toBe('all');
  });

  it('honors --parallel=false', () => {
    const recipe = FitnessRecipeService.createAdHocRecipe({ parallel: false });
    expect(recipe.execution.mode).toBe('sequential');
  });

  it('respects --json + --unified for reporting format', () => {
    const json = FitnessRecipeService.createAdHocRecipe({ json: true });
    expect(json.reporting.format).toBe('json');
    const unified = FitnessRecipeService.createAdHocRecipe({
      json: true,
      unified: true,
    });
    expect(unified.reporting.format).toBe('unified');
  });
});

// =============================================================================
// ABORT
// =============================================================================

describe('FitnessRecipeService — abort', () => {
  it('abort() while no session is running is a no-op', () => {
    const svc = new FitnessRecipeService();
    expect(() => svc.abort()).not.toThrow();
  });

  it('abort() during a run cancels remaining checks', async () => {
    const checkRegistry = new CheckRegistry();
    let activeSignal: AbortSignal | undefined;
    let secondRan = false;
    let markStarted: () => void = () => undefined;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    let releaseFirst: () => void = () => undefined;
    const released = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const first = defineCheck({
      id: uid(),
      slug: 'first',
      description: 'first',
      tags: ['demo'],
      analyzeAll: async () => {
        await released;
        return [];
      },
    });
    checkRegistry.register({
      ...first,
      run: (cwd, options) => {
        activeSignal = options?.signal;
        markStarted();
        return first.run(cwd, options);
      },
    });
    checkRegistry.register(
      defineCheck({
        id: uid(),
        slug: 'second',
        description: 'second',
        tags: ['demo'],
        analyze: () => {
          secondRan = true;
          return [];
        },
      }),
    );
    writeFixture('a.ts', '');

    const svc = new FitnessRecipeService({
      cwd: testDir,
      checkRegistry,
      recipeRegistry: new FitnessRecipeRegistry(),
      prewarmCache: false,
    });

    // sequential mode lets us reliably interrupt mid-run
    const promise = svc.start(
      makeRecipe({
        execution: {
          mode: 'sequential',
          stopOnFirstFailure: false,
          timeout: 30_000,
        },
      }),
    );
    await started;

    svc.abort();
    const activeCheckWasAborted = activeSignal?.aborted;
    releaseFirst();
    await promise;

    expect(activeCheckWasAborted).toBe(true);
    expect(secondRan).toBe(false);
  });
});

// =============================================================================
// PER-CHECK TIMEOUT
// =============================================================================

describe('FitnessRecipeService — timeout', () => {
  it('exposes a per-check timeout option in the recipe execution config', async () => {
    const checkRegistry = new CheckRegistry();
    checkRegistry.register(makeMarkerCheck('q', 'X'));
    writeFixture('a.ts', 'const a = "X";');

    const svc = new FitnessRecipeService({
      cwd: testDir,
      checkRegistry,
      recipeRegistry: new FitnessRecipeRegistry(),
      prewarmCache: true,
    });

    // A non-timing-out run still completes cleanly when timeout is set.
    const result = await svc.start(
      makeRecipe({
        execution: {
          mode: 'parallel',
          stopOnFirstFailure: false,
          timeout: 5000,
        },
      }),
    );
    expect(result.summary.totalChecks).toBe(1);
    expect(result.checkResults[0]?.timedOut).not.toBe(true);
  });
});

// =============================================================================
// EFFECTIVE SIGNALS
// =============================================================================

describe('FitnessRecipeService — effectiveSignals', () => {
  it('carries filtered signal detail by default', async () => {
    const checkRegistry = new CheckRegistry();
    checkRegistry.register(makeMarkerCheck('flag-x', 'X'));
    writeFixture('a.ts', 'const a = "X";');

    const svc = new FitnessRecipeService({
      cwd: testDir,
      checkRegistry,
      recipeRegistry: new FitnessRecipeRegistry(),
      prewarmCache: true,
    });

    const result = await svc.start(makeRecipe());
    const cr = result.checkResults[0];
    expect(cr?.effectiveSignals).toHaveLength(1);
    expect(cr?.effectiveSignals[0]?.ruleId).toBe('fit:flag-x');
    expect(cr?.effectiveSignals[0]?.line).toBe(1);
    expect(cr?.effectiveSignals[0]?.metadata.checkSlug).toBe('flag-x');
  });
});

// =============================================================================
// CACHE-INSTANCE IDENTITY (parallel-tool-invocations Phase 1)
// =============================================================================

describe('FitnessRecipeService — per-run FileCache identity', () => {
  it('prewarm, exec read, and scope.fitness.fileCache are the SAME instance', async () => {
    // The `beforeEach` entered a RunScope carrying fitness's subscope, so
    // `currentScope()?.fitness?.fileCache` is the canonical per-run cache. The
    // service must resolve THAT instance for prewarm AND the exec read AND clear
    // THAT instance in `finally` — never a divergent function-local. We spy on
    // prewarm + get (keeping the real behaviour) and read each call's receiver
    // from the spy's `mock.contexts`, then assert both equal the scope cache.
    const scopeCache = currentScope()?.fitness?.fileCache;
    expect(scopeCache).toBeInstanceOf(FileCache);

    const prewarmSpy = vi.spyOn(FileCache.prototype, 'prewarm');
    const getSpy = vi.spyOn(FileCache.prototype, 'get');

    try {
      const checkRegistry = new CheckRegistry();
      checkRegistry.register(makeMarkerCheck('flag-id', 'IDMARK'));
      writeFixture('id.ts', 'const x = "IDMARK";');

      const svc = new FitnessRecipeService({
        cwd: testDir,
        checkRegistry,
        recipeRegistry: new FitnessRecipeRegistry(),
        prewarmCache: true,
      });

      await svc.start(makeRecipe());

      // Vitest records the `this` receiver of every call in `mock.contexts`.
      const prewarmedInstance = prewarmSpy.mock.contexts[0] as FileCache | undefined;
      const execReadInstance = getSpy.mock.contexts[0] as FileCache | undefined;

      expect(prewarmSpy).toHaveBeenCalled();
      expect(getSpy).toHaveBeenCalled();
      // prewarmed === execOpts.fileCache (the exec read) === scope cache.
      expect(prewarmedInstance).toBe(scopeCache);
      expect(execReadInstance).toBe(scopeCache);
      expect(Object.is(prewarmedInstance, execReadInstance)).toBe(true);
    } finally {
      prewarmSpy.mockRestore();
      getSpy.mockRestore();
    }
  });
});
