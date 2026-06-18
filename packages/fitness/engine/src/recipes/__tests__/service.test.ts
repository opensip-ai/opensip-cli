// @fitness-ignore-file file-length-limit -- behavior fixture suite; related scenarios stay together while covered domains are split into focused tests.
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

import { ConfigurationError, enterScope, RunScope } from '@opensip-cli/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { defineCheck } from '../../framework/define-check.js';
import { CheckRegistry } from '../../framework/registry.js';
import { installFitnessSubscope } from '../../framework/scope-registry.js';
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
  installFitnessSubscope(scope, fitnessTool.contributeScope?.() ?? {});
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
    let secondRan = false;
    checkRegistry.register(
      defineCheck({
        id: uid(),
        slug: 'first',
        description: 'first',
        tags: ['demo'],
        analyzeAll: async () => {
          await new Promise((r) => setTimeout(r, 10));
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
    setTimeout(() => svc.abort(), 5);
    await promise;

    // Whether or not the second ran is timing-dependent, but abort()
    // should not throw and the run should complete.
    expect(typeof secondRan).toBe('boolean');
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
// includeViolations CONFIG
// =============================================================================

describe('FitnessRecipeService — includeViolations', () => {
  it('omits per-violation detail by default', async () => {
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
    expect(cr?.violations).toBeUndefined();
  });

  it('carries violation detail when includeViolations is true', async () => {
    const checkRegistry = new CheckRegistry();
    checkRegistry.register(makeMarkerCheck('flag-x', 'X'));
    writeFixture('a.ts', 'const a = "X";');

    const svc = new FitnessRecipeService({
      cwd: testDir,
      checkRegistry,
      recipeRegistry: new FitnessRecipeRegistry(),
      prewarmCache: true,
      includeViolations: true,
    });

    const result = await svc.start(makeRecipe());
    const cr = result.checkResults[0];
    expect(cr?.violations).toBeDefined();
    expect(cr?.violations?.length).toBeGreaterThan(0);
  });
});
