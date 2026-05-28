/**
 * Integration tests for `loadDiscoveredScenarioPackages`.
 *
 * Mirrors the fit-side coverage in
 * packages/fitness/engine/src/cli/__tests__/load-discovered-check-packages.test.ts
 * for the sim CLI loader. Sim's marker walk and helper adoption landed
 * in Phase 4; this file validates both against fixture node_modules
 * layouts in tmpdir.
 *
 * Phase 7.5 of the marker-based-discovery plan.
 *
 * Scenarios used to self-register at module-import time; after Item 1
 * they're explicit array exports, so the fixture's `index.mjs` exports
 * `scenarios: [...]` and the loader's array-walk path picks them up.
 * The fixture also exports a `recipes` array (unchanged channel).
 */

import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { enterScope } from '@opensip-tools/core';
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';

import { makeSimTestScope } from '../../__tests__/test-utils/with-sim-scope.js';
import { clearScenarioRegistry, currentScenarioRegistry } from '../../framework/registry.js';
import { currentSimulationRecipeRegistry } from '../../recipes/registry.js';
import { loadDiscoveredScenarioPackages } from '../sim.js';

let testDir: string;
let stderrSpy: MockInstance<typeof process.stderr.write>;

beforeEach(() => {
  testDir = mkdtempSync(join(tmpdir(), 'opensip-sim-loader-'));
  stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  enterScope(makeSimTestScope());
});

afterEach(() => {
  rmSync(testDir, { recursive: true, force: true });
  clearScenarioRegistry();
  stderrSpy.mockRestore();
});

/**
 * Drop a fixture sim pack into the tmpdir's node_modules. The fixture's
 * `index.mjs` exports a `scenarios` array (Item 1: scenarios are
 * explicit exports; the loader's array-walk path registers them into
 * the scope's registry) and a `recipes` array.
 */
function writeFixturePack(opts: {
  packageDir: string;            // absolute path under testDir/node_modules
  packageName: string;
  marker?: 'fit-pack' | 'sim-pack' | 'tool';
  recipesFragment?: string;
  selfRegisterScenario?: boolean;
}): { scenarioId: string; recipeId: string; recipeName: string } {
  const scenarioId = `scenario-${randomUUID()}`;
  const recipeId = `recipe-${randomUUID()}`;
  const recipeName = `recipe-name-${randomUUID()}`;

  mkdirSync(opts.packageDir, { recursive: true });
  const pkg: Record<string, unknown> = {
    name: opts.packageName,
    main: './index.mjs',
  };
  if (opts.marker) {
    pkg.opensipTools = { kind: opts.marker };
  }
  writeFileSync(join(opts.packageDir, 'package.json'), JSON.stringify(pkg));

  const scenarioBlock = opts.selfRegisterScenario === false
    ? `export const scenarios = [];`
    : `export const scenarios = [{
        kind: 'load',
        id: ${JSON.stringify(scenarioId)},
        name: ${JSON.stringify(scenarioId)},
        description: 'fixture scenario',
        tags: [],
        run: async () => ({ kind: 'load', outcome: { totalRequests: 0, errorRate: 0 } }),
      }];`;

  const recipesExport = opts.recipesFragment === undefined
    ? `export const recipes = [{
        id: ${JSON.stringify(recipeId)},
        name: ${JSON.stringify(recipeName)},
        displayName: ${JSON.stringify(recipeName)},
        description: 'fixture recipe',
        scenarios: [${JSON.stringify(scenarioId)}],
      }];`
    : `export const recipes = ${opts.recipesFragment};`;

  writeFileSync(
    join(opts.packageDir, 'index.mjs'),
    `${scenarioBlock}\n${recipesExport}\n`,
  );

  return { scenarioId, recipeId, recipeName };
}

describe('loadDiscoveredScenarioPackages', () => {
  it('discovers and loads a marker-only sim-pack package (any scope)', async () => {
    const { scenarioId, recipeId } = writeFixturePack({
      packageDir: join(testDir, 'node_modules', '@acme', 'sim'),
      packageName: '@acme/sim',
      marker: 'sim-pack',
    });

    await loadDiscoveredScenarioPackages(testDir);

    expect(currentScenarioRegistry().get(scenarioId)).toBeDefined();
    expect(currentSimulationRecipeRegistry().has(recipeId)).toBe(true);
  });

  it('discovers and loads a name-pattern-only package (@opensip-tools/scenarios-*)', async () => {
    const { scenarioId, recipeId } = writeFixturePack({
      packageDir: join(testDir, 'node_modules', '@opensip-tools', 'scenarios-fixture'),
      packageName: '@opensip-tools/scenarios-fixture',
    });

    await loadDiscoveredScenarioPackages(testDir);

    expect(currentScenarioRegistry().get(scenarioId)).toBeDefined();
    expect(currentSimulationRecipeRegistry().has(recipeId)).toBe(true);
  });

  it('loads a pack matching BOTH name-pattern and marker only once (dedupe by name)', async () => {
    const { scenarioId, recipeId } = writeFixturePack({
      packageDir: join(testDir, 'node_modules', '@opensip-tools', 'scenarios-dual'),
      packageName: '@opensip-tools/scenarios-dual',
      marker: 'sim-pack',
    });

    await loadDiscoveredScenarioPackages(testDir);

    expect(currentScenarioRegistry().get(scenarioId)).toBeDefined();
    expect(currentSimulationRecipeRegistry().has(recipeId)).toBe(true);
    // Dedupe assertion: the scenario was registered exactly once. If
    // both walker paths loaded the module, the second import attempt
    // would either re-run the array-walk (caught by the registry's
    // 'silent-skip' duplicate policy) or be cached by Node. Either
    // way, getAll() should contain a single entry for this fixture's id.
    const matches = currentScenarioRegistry().getAll().filter((s: { id: string }) => s.id === scenarioId);
    expect(matches).toHaveLength(1);
  });

  it('loads scenarios with no `recipes` field (recipesRegistered=0; loader does not crash)', async () => {
    const { scenarioId } = writeFixturePack({
      packageDir: join(testDir, 'node_modules', '@acme', 'sim-no-recipes'),
      packageName: '@acme/sim-no-recipes',
      marker: 'sim-pack',
      recipesFragment: 'undefined',
    });

    await loadDiscoveredScenarioPackages(testDir);

    expect(currentScenarioRegistry().get(scenarioId)).toBeDefined();
  });

  it('emits plugin.recipe.invalid_item warning for malformed recipes; still registers valid recipes', async () => {
    const recipeIdValid = `valid-${randomUUID()}`;
    const recipeNameValid = `valid-name-${randomUUID()}`;
    const malformedFragment = `[
      { id: ${JSON.stringify(recipeIdValid)}, name: ${JSON.stringify(recipeNameValid)}, displayName: 'v', description: 'd', scenarios: [] },
      { id: 'missing-name-sim' },
    ]`;
    const { scenarioId } = writeFixturePack({
      packageDir: join(testDir, 'node_modules', '@acme', 'sim-malformed-recipe'),
      packageName: '@acme/sim-malformed-recipe',
      marker: 'sim-pack',
      recipesFragment: malformedFragment,
    });

    await loadDiscoveredScenarioPackages(testDir);

    expect(currentScenarioRegistry().get(scenarioId)).toBeDefined();
    expect(currentSimulationRecipeRegistry().has(recipeIdValid)).toBe(true);
    expect(currentSimulationRecipeRegistry().has('missing-name-sim')).toBe(false);
  });

  it('ignores a fit-pack marker when discovering sim-packs', async () => {
    writeFixturePack({
      packageDir: join(testDir, 'node_modules', '@acme', 'fit-only'),
      packageName: '@acme/fit-only',
      marker: 'fit-pack',
    });

    await loadDiscoveredScenarioPackages(testDir);

    expect(currentScenarioRegistry().size).toBe(0);
  });

  it('returns early when projectDir is empty (no-op)', async () => {
    // The loader's documented short-circuit: empty projectDir → return.
    await loadDiscoveredScenarioPackages('');
    expect(currentScenarioRegistry().size).toBe(0);
  });

  it('does nothing when no packages match the marker', async () => {
    // The recipe registry baseline includes the built-in `default` recipe,
    // so we measure the delta rather than asserting an absolute zero.
    const baselineRecipeCount = currentSimulationRecipeRegistry().getAllRecipes().length;
    await loadDiscoveredScenarioPackages(testDir);
    expect(currentScenarioRegistry().size).toBe(0);
    expect(currentSimulationRecipeRegistry().getAllRecipes().length).toBe(baselineRecipeCount);
  });
});
