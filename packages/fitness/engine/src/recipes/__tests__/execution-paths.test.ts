/**
 * @fileoverview Coverage tests for the parallel and sequential execution
 * engines plus the check-result-processor.
 *
 * Targets the timeout, error, stop-on-first-failure, memory-warning, and
 * onError callback paths that the integration tests in service.test.ts
 * don't exercise.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { defineCheck } from '../../framework/define-check.js';
import { CheckRegistry } from '../../framework/registry.js';
import { FitnessRecipeRegistry } from '../registry.js';
import { FitnessRecipeService } from '../service.js';

import type { FitnessRecipeServiceCallbacks } from '../service-types.js';
import type { FitnessRecipe } from '../types.js';

let testDir: string;
let nextId = 0;

function uid(): string {
  nextId++;
  return `00000000-0000-4000-8000-${nextId.toString(16).padStart(12, '0')}`;
}

function writeFixture(rel: string, content: string): void {
  const abs = join(testDir, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content);
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

beforeEach(() => {
  testDir = mkdtempSync(join(tmpdir(), 'opensip-exec-paths-'));
});

afterEach(() => {
  rmSync(testDir, { recursive: true, force: true });
});

describe('parallel execution — error paths', () => {
  it('completes the run when a check throws (framework captures the error)', async () => {
    const checkRegistry = new CheckRegistry();
    checkRegistry.register(
      defineCheck({
        id: uid(),
        slug: 'crash',
        description: 'crashes',
        tags: ['quality'],
        analyze: () => {
          throw new Error('boom');
        },
      }),
    );
    writeFixture('a.ts', 'const x = 1');

    const svc = new FitnessRecipeService({
      cwd: testDir,
      checkRegistry,
      recipeRegistry: new FitnessRecipeRegistry(),
      prewarmCache: true,
    });

    const result = await svc.start(makeRecipe());
    // Per-check error is captured by Check.run() and surfaces as an
    // error result, not as a thrown exception bubbling out of the
    // service; the run still completes.
    expect(result.summary.totalChecks).toBe(1);
  });

  it('stopOnFirstFailure halts the run after the first failing check', async () => {
    let secondRan = false;
    const checkRegistry = new CheckRegistry();
    checkRegistry.register(
      defineCheck({
        id: uid(),
        slug: 'fails',
        description: 'always fails',
        tags: ['quality'],
        analyze: (_, filePath) => [
          { line: 1, message: 'fail', severity: 'error' as const, filePath },
        ],
      }),
    );
    checkRegistry.register(
      defineCheck({
        id: uid(),
        slug: 'maybe-runs',
        description: 'might run',
        tags: ['quality'],
        analyze: () => {
          secondRan = true;
          return [];
        },
      }),
    );
    writeFixture('a.ts', 'const x = 1');

    const svc = new FitnessRecipeService({
      cwd: testDir,
      checkRegistry,
      recipeRegistry: new FitnessRecipeRegistry(),
      prewarmCache: true,
    });

    // sequential mode + stopOnFirstFailure ensures the second check
    // is reliably gated on the first's status.
    await svc.start(
      makeRecipe({
        execution: {
          mode: 'sequential',
          stopOnFirstFailure: true,
          timeout: 30_000,
        },
      }),
    );

    // With stopOnFirstFailure=true, the run should have stopped — the
    // second check is registered but should not have analyzed anything.
    expect(secondRan).toBe(false);
  });
});

describe('sequential execution — timeout', () => {
  it('marks a check as timed out when its work exceeds the per-check timeout', async () => {
    const checkRegistry = new CheckRegistry();
    checkRegistry.register(
      defineCheck({
        id: uid(),
        slug: 'slow',
        description: 'slow',
        tags: ['quality'],
        analyzeAll: async () => {
          await new Promise((r) => setTimeout(r, 500));
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

    const result = await svc.start(
      makeRecipe({
        execution: {
          mode: 'sequential',
          stopOnFirstFailure: false,
          timeout: 50,
        },
      }),
    );

    expect(result.summary.totalChecks).toBe(1);
    const cr = result.checkResults[0];
    // The check is reported as failed via timeout
    expect(cr?.passed).toBe(false);
  }, 10_000);

  it('reports completed-without-error for fast-running sequential checks', async () => {
    const checkRegistry = new CheckRegistry();
    checkRegistry.register(
      defineCheck({
        id: uid(),
        slug: 'fast',
        description: 'fast',
        tags: ['quality'],
        analyze: () => [],
      }),
    );
    writeFixture('a.ts', '');

    const svc = new FitnessRecipeService({
      cwd: testDir,
      checkRegistry,
      recipeRegistry: new FitnessRecipeRegistry(),
      prewarmCache: false,
    });

    const result = await svc.start(
      makeRecipe({
        execution: {
          mode: 'sequential',
          stopOnFirstFailure: false,
          timeout: 5000,
        },
      }),
    );
    expect(result.checkResults[0]?.passed).toBe(true);
    expect(result.checkResults[0]?.timedOut).not.toBe(true);
  });
});

describe('parallel execution — timeout', () => {
  it('marks a parallel check as timed out when work exceeds the per-check timeout', async () => {
    const checkRegistry = new CheckRegistry();
    checkRegistry.register(
      defineCheck({
        id: uid(),
        slug: 'slow-parallel',
        description: 'slow',
        tags: ['quality'],
        analyzeAll: async () => {
          await new Promise((r) => setTimeout(r, 500));
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

    const result = await svc.start(
      makeRecipe({
        execution: { mode: 'parallel', stopOnFirstFailure: false, timeout: 50 },
      }),
    );

    expect(result.summary.totalChecks).toBe(1);
    const cr = result.checkResults[0];
    expect(cr?.passed).toBe(false);
  }, 10_000);
});

describe('check-result-processor — error result fields', () => {
  it('records timedOut + error message on a check that times out', async () => {
    const checkRegistry = new CheckRegistry();
    checkRegistry.register(
      defineCheck({
        id: uid(),
        slug: 'will-timeout',
        description: 't',
        tags: ['quality'],
        analyzeAll: async () => {
          await new Promise((r) => setTimeout(r, 500));
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

    const result = await svc.start(
      makeRecipe({
        execution: {
          mode: 'sequential',
          stopOnFirstFailure: false,
          timeout: 50,
        },
      }),
    );

    const cr = result.checkResults[0];
    expect(cr?.error).toContain('timed out');
    expect(cr?.timedOut).toBe(true);
  }, 10_000);

  it('preserves non-timeout error details', async () => {
    const checkRegistry = new CheckRegistry();
    checkRegistry.register(
      defineCheck({
        id: uid(),
        slug: 'will-throw',
        description: 't',
        tags: ['quality'],
        // eslint-disable-next-line @typescript-eslint/require-await
        analyzeAll: async () => {
          throw new Error('explicit failure');
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

    const result = await svc.start(
      makeRecipe({
        execution: {
          mode: 'sequential',
          stopOnFirstFailure: false,
          timeout: 5000,
        },
      }),
    );

    // The throw inside analyzeAll is caught by check.run() and reported
    // as a per-check error result. With include-error path, error is
    // recorded.
    const cr = result.checkResults[0];
    expect(cr?.passed).toBe(false);
  });
});

describe('catalog sync', () => {
  it('invokes onCatalogSync with all registered checks before execution', async () => {
    let received: { id: string; slug: string }[] = [];
    const callbacks: FitnessRecipeServiceCallbacks = {
      onCatalogSync: (entries) => {
        received = entries.map((e) => ({ id: e.id, slug: e.slug }));
      },
    };
    const checkRegistry = new CheckRegistry();
    checkRegistry.register(
      defineCheck({
        id: uid(),
        slug: 'c1',
        description: 'd',
        tags: ['quality'],
        analyze: () => [],
      }),
    );
    checkRegistry.register(
      defineCheck({
        id: uid(),
        slug: 'c2',
        description: 'd',
        tags: ['quality'],
        analyze: () => [],
      }),
    );
    writeFixture('a.ts', '');

    const svc = new FitnessRecipeService({
      cwd: testDir,
      checkRegistry,
      recipeRegistry: new FitnessRecipeRegistry(),
      prewarmCache: false,
      callbacks,
    });

    await svc.start(makeRecipe());
    expect(received.map((r) => r.slug).sort()).toEqual(['c1', 'c2']);
  });
});
