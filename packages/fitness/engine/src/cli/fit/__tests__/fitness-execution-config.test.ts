/**
 * Regression: the `fitness:` block's scheduling/targeting knobs were validated
 * by `FitnessNamespaceSchema`, typed on `ResolvedFitnessConfig`, and documented
 * in `docs/public/70-reference/03-configuration.md` — but nothing read them.
 *
 *  - `fitness.timeout`      — the recipe's hard-coded `timeout` (30s on the
 *    built-in `default`) won every run, so a user who granted a slow check 120s
 *    still saw it recorded as a `timeout` unit fault.
 *  - `fitness.maxParallel`  — parallelism came only from
 *    `os.availableParallelism()` via `DEFAULT_MAX_PARALLEL`.
 *  - `fitness.defaultTarget`— documented as "target used when a check has no
 *    `scope`", but `resolveFilesForCheck` returned `undefined` (whole-repo
 *    fileCache fallback) for those checks regardless.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';

import {
  LanguageRegistry,
  RunScope,
  applyToolContributeScope,
  runWithScope,
} from '@opensip-cli/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { buildScopeBasedFileMap } from '../../../framework/scope-resolver.js';
import { TargetRegistry } from '../../../targets/target-registry.js';
import { fitnessTool } from '../../../tool.js';
import { executeFit } from '../../fit.js';
import { applyFitnessExecutionOverrides } from '../resolved-fitness-config.js';

import type { FitnessRecipe } from '../../../recipes/types.js';
import type { Target, TargetsConfig } from '../../../targets/types.js';
import type * as CheckLoaderModule from '../check-loader.js';
import type { FitOptions } from '@opensip-cli/contracts';

/** slug → every filePath the check's `analyze` was handed this run. */
const analyzed = vi.hoisted(() => new Map<string, string[]>());
/**
 * Whether the run should also register the never-settling probe. Only the
 * timeout test wants it — everywhere else it would burn the recipe's budget.
 */
const probe = vi.hoisted(() => ({ registerNeverSettles: false }));

vi.mock('../check-loader.js', async (importOriginal) => {
  const actual = await importOriginal<typeof CheckLoaderModule>();
  const { currentCheckRegistry, currentFitnessLoadState } =
    await import('../../../framework/scope-registry.js');
  const { defineCheck } = await import('../../../framework/define-check.js');
  return {
    ...actual,
    ensureChecksLoaded: vi.fn((projectDir = '') => {
      const registry = currentCheckRegistry();
      if (registry.listEnabled().length === 0) {
        registry.register(
          defineCheck({
            id: '00000000-0000-4000-8000-0000000000b1',
            slug: 'scopeless-check',
            description: 'declares no scope at all',
            tags: ['test'],
            analyze: (_content: string, filePath: string) => {
              const seen = analyzed.get('scopeless-check') ?? [];
              seen.push(filePath);
              analyzed.set('scopeless-check', seen);
              return [];
            },
          }),
          '@opensip-cli/test',
        );
        if (probe.registerNeverSettles) {
          registry.register(
            defineCheck({
              id: '00000000-0000-4000-8000-0000000000b2',
              slug: 'never-settles',
              description: 'ignores the clock entirely — only the timeout ends it',
              tags: ['test'],
              // Deliberately never resolves: the ONLY thing that ends this unit
              // is the per-check timeout budget. That makes the assertion a fact
              // about the budget in force, not a race against wall-clock.
              // analyzeAll (not analyze) because it's the async analysis mode —
              // analyze() is typed synchronous, so it cannot itself hang.
              analyzeAll: async () => {
                await new Promise(() => {
                  /* never settles */
                });
                return [];
              },
            }),
            '@opensip-cli/test',
          );
        }
      }
      const load = currentFitnessLoadState();
      load.loadedFor = projectDir;
      load.pluginLoadErrors = [];
      load.checkPackErrors = [];
      load.loadWarnings = [];
      load.degradedDiagnostics = [];
      load.commandError = undefined;
      load.loadDegraded = undefined;
      load.outcomeFinalized = true;
    }),
  };
});

// ---------------------------------------------------------------------------
// applyFitnessExecutionOverrides — pure merge
// ---------------------------------------------------------------------------

function recipeWith(execution: FitnessRecipe['execution']): FitnessRecipe {
  return {
    id: 'RCP_test',
    name: 'test',
    displayName: 'Test',
    description: 'test',
    checks: { type: 'all' },
    execution,
    reporting: { format: 'table', verbose: false },
  };
}

describe('applyFitnessExecutionOverrides', () => {
  const base = recipeWith({ mode: 'parallel', stopOnFirstFailure: false, timeout: 30_000 });

  it('lets config-provided timeout/maxParallel win over the recipe defaults', () => {
    const merged = applyFitnessExecutionOverrides(base, { timeout: 120_000, maxParallel: 2 });
    expect(merged.execution.timeout).toBe(120_000);
    expect(merged.execution.maxParallel).toBe(2);
    // Everything else the recipe declared survives.
    expect(merged.execution.mode).toBe('parallel');
    expect(merged.execution.stopOnFirstFailure).toBe(false);
  });

  it('keeps the recipe value for a knob the config does not set', () => {
    const merged = applyFitnessExecutionOverrides(base, { maxParallel: 2 });
    expect(merged.execution.timeout).toBe(30_000);
    expect(merged.execution.maxParallel).toBe(2);
  });

  it('returns the recipe untouched when the config sets neither knob', () => {
    expect(applyFitnessExecutionOverrides(base, {})).toBe(base);
    expect(applyFitnessExecutionOverrides(base, undefined)).toBe(base);
  });
});

// ---------------------------------------------------------------------------
// fitness.defaultTarget — tier-3 fallback in scope resolution
// ---------------------------------------------------------------------------

describe('buildScopeBasedFileMap — fitness.defaultTarget', () => {
  let testDir: string;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), 'opensip-default-target-'));
    mkdirSync(join(testDir, 'src'));
    mkdirSync(join(testDir, 'vendor'));
    writeFileSync(join(testDir, 'src', 'a.ts'), 'export const a = 1;\n');
    writeFileSync(join(testDir, 'vendor', 'b.ts'), 'export const b = 2;\n');
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  function registryWithSource(): TargetRegistry {
    const reg = new TargetRegistry();
    const target: Target = {
      config: {
        name: 'source',
        description: 'source',
        include: ['src/**/*.ts'],
        exclude: [],
        languages: ['typescript'],
        concerns: ['backend'],
      },
    };
    reg.register(target);
    return reg;
  }

  const config: TargetsConfig = { globalExcludes: [], checkOverrides: {} };

  it('resolves a scope-less check to the configured default target', () => {
    const out = buildScopeBasedFileMap([{ slug: 'unscoped' }], registryWithSource(), config, testDir, {
      defaultTarget: 'source',
    });
    expect(out.get('unscoped')).toEqual([join(testDir, 'src', 'a.ts')]);
  });

  it('still returns no entry for a scope-less check when no default target is configured', () => {
    const out = buildScopeBasedFileMap([{ slug: 'unscoped' }], registryWithSource(), config, testDir);
    expect(out.has('unscoped')).toBe(false);
  });

  it('ignores an unknown default-target name rather than resolving it to zero files', () => {
    const out = buildScopeBasedFileMap([{ slug: 'unscoped' }], registryWithSource(), config, testDir, {
      defaultTarget: 'typo',
    });
    // Resolving a typo to `[]` would silently mute every scope-less check; the
    // file-cache fallback stands instead (and `executeFit` warns).
    expect(out.has('unscoped')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// executeFit — the knobs actually reach the run
// ---------------------------------------------------------------------------

let projectDir: string;

function makeArgs(overrides: Partial<FitOptions> = {}): FitOptions {
  return {
    json: false,
    list: false,
    recipes: false,
    verbose: false,
    debug: false,
    quiet: true,
    open: false,
    cwd: projectDir,
    exclude: [],
    gateSave: false,
    gateCompare: false,
    ...overrides,
  };
}

/**
 * Build a project whose config carries the given `fitness:` block. Both the
 * on-disk YAML and `scope.configDocument` are written so the run resolves the
 * same document whichever reader wins.
 */
function writeProject(fitnessBlock: Record<string, unknown>): Record<string, unknown> {
  const targets = {
    source: {
      description: 'project source',
      languages: ['typescript'],
      concerns: ['backend'],
      include: ['src/**/*.ts'],
    },
  };
  writeFileSync(
    join(projectDir, 'opensip-cli.config.yml'),
    JSON.stringify({ targets, fitness: fitnessBlock }, null, 2),
  );
  return { targets, fitness: fitnessBlock };
}

function withFitScope<T>(configDocument: Record<string, unknown>, fn: () => Promise<T>): Promise<T> {
  const scope = new RunScope({ languages: new LanguageRegistry() });
  applyToolContributeScope(scope, fitnessTool);
  Object.assign(scope, { configDocument });
  return runWithScope(scope, fn);
}

describe('executeFit — fitness config knobs reach the run', () => {
  beforeEach(() => {
    analyzed.clear();
    probe.registerNeverSettles = false;
    projectDir = mkdtempSync(join(tmpdir(), 'opensip-fit-exec-config-'));
    mkdirSync(join(projectDir, 'src'));
    mkdirSync(join(projectDir, 'vendor'));
    writeFileSync(join(projectDir, 'src', 'a.ts'), 'export const a = 1;\n');
    writeFileSync(join(projectDir, 'vendor', 'b.ts'), 'export const b = 2;\n');
  });

  afterEach(() => {
    rmSync(projectDir, { recursive: true, force: true });
  });

  it(
    'enforces fitness.timeout instead of the recipe default',
    { timeout: 15_000 },
    async () => {
      // The built-in `default` recipe declares 30s. With the config knob inert
      // the never-settling check burns that full budget (and this test exceeds
      // its own 15s allowance); with it honoured the unit is a 1s timeout.
      probe.registerNeverSettles = true;
      const doc = writeProject({ timeout: 1000 });
      const fit = await withFitScope(doc, () => executeFit(makeArgs()));

      expect(fit.result.type).not.toBe('error');
      const unit = fit.envelope?.units.find((u) => u.slug === 'never-settles');
      expect(unit).toBeDefined();
      expect(unit?.passed).toBe(false);
      expect(String(unit?.error)).toMatch(/tim(ed|e)[- ]?out/i);
    },
  );

  it('scopes a scope-less check to fitness.defaultTarget instead of the whole project', async () => {
    const doc = writeProject({ defaultTarget: 'source' });
    const fit = await withFitScope(doc, () => executeFit(makeArgs()));

    expect(fit.result.type).not.toBe('error');
    const seen = (analyzed.get('scopeless-check') ?? []).map((f) => basename(f));
    expect(seen).toContain('a.ts');
    // `vendor/b.ts` is outside the default target — before the fix the
    // scope-less check scanned the whole prewarmed file universe.
    expect(seen).not.toContain('b.ts');
  });

  it('warns (and keeps the fallback) when fitness.defaultTarget names no target', async () => {
    const doc = writeProject({ defaultTarget: 'no-such-target' });
    const fit = await withFitScope(doc, () => executeFit(makeArgs()));

    expect(fit.result.type).not.toBe('error');
    expect(fit.warnings?.join('\n')).toContain('no-such-target');
  });
});
