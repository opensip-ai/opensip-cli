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
 * Scenarios self-register at module-import time inside the fixture's
 * `index.mjs`. To do that without symlinking the workspace package into
 * the tmpdir, the test stashes the live `scenarioRegistry` on
 * `globalThis.__OPENSIP_TEST_SCENARIO_REGISTRY__` before calling the
 * loader; the fixture reads it back and registers a scenario directly.
 * Cleanup deletes the global between tests.
 */

import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';

import { clearScenarioRegistry, scenarioRegistry } from '../../framework/registry.js';
import { defaultSimulationRecipeRegistry } from '../../recipes/registry.js';
import { loadDiscoveredScenarioPackages } from '../sim.js';

const REGISTRY_GLOBAL_KEY = '__OPENSIP_TEST_SCENARIO_REGISTRY__';

declare global {
  // Test-only global. Documented in the file-header docstring.
  var __OPENSIP_TEST_SCENARIO_REGISTRY__: typeof scenarioRegistry | undefined;
}

let testDir: string;
let stderrSpy: MockInstance<typeof process.stderr.write>;

beforeEach(() => {
  testDir = mkdtempSync(join(tmpdir(), 'opensip-sim-loader-'));
  stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  globalThis[REGISTRY_GLOBAL_KEY] = scenarioRegistry;
});

afterEach(() => {
  rmSync(testDir, { recursive: true, force: true });
  clearScenarioRegistry();
  defaultSimulationRecipeRegistry.reset();
  globalThis[REGISTRY_GLOBAL_KEY] = undefined;
  stderrSpy.mockRestore();
});

/**
 * Drop a fixture sim pack into the tmpdir's node_modules. The fixture's
 * `index.mjs` registers exactly one scenario (via the globalThis-injected
 * registry handle) and exports a `recipes` array using the fragment
 * passed in. Returns the IDs the fixture used so tests can assert on
 * them.
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
    ? ''
    : `
      const reg = globalThis[${JSON.stringify(REGISTRY_GLOBAL_KEY)}];
      if (reg) {
        reg.register({
          kind: 'load',
          id: ${JSON.stringify(scenarioId)},
          name: ${JSON.stringify(scenarioId)},
          description: 'fixture scenario',
          tags: [],
          run: async () => ({ kind: 'load', outcome: { totalRequests: 0, errorRate: 0 } }),
        });
      }
    `;

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

    expect(scenarioRegistry.get(scenarioId)).toBeDefined();
    expect(defaultSimulationRecipeRegistry.has(recipeId)).toBe(true);
  });

  it('discovers and loads a name-pattern-only package (@opensip-tools/scenarios-*)', async () => {
    const { scenarioId, recipeId } = writeFixturePack({
      packageDir: join(testDir, 'node_modules', '@opensip-tools', 'scenarios-fixture'),
      packageName: '@opensip-tools/scenarios-fixture',
    });

    await loadDiscoveredScenarioPackages(testDir);

    expect(scenarioRegistry.get(scenarioId)).toBeDefined();
    expect(defaultSimulationRecipeRegistry.has(recipeId)).toBe(true);
  });

  it('loads a pack matching BOTH name-pattern and marker only once (dedupe by name)', async () => {
    const { scenarioId, recipeId } = writeFixturePack({
      packageDir: join(testDir, 'node_modules', '@opensip-tools', 'scenarios-dual'),
      packageName: '@opensip-tools/scenarios-dual',
      marker: 'sim-pack',
    });

    await loadDiscoveredScenarioPackages(testDir);

    expect(scenarioRegistry.get(scenarioId)).toBeDefined();
    expect(defaultSimulationRecipeRegistry.has(recipeId)).toBe(true);
    // Dedupe assertion: the scenario was registered exactly once. If
    // both walker paths loaded the module, the second import attempt
    // would either re-run the side-effect (causing an
    // IdNameTagRegistry name-collision throw) or be cached by Node.
    // Either way, scenarioRegistry.getAll() should contain a single
    // entry for this fixture's id.
    const matches = scenarioRegistry.getAll().filter((s) => s.id === scenarioId);
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

    expect(scenarioRegistry.get(scenarioId)).toBeDefined();
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

    expect(scenarioRegistry.get(scenarioId)).toBeDefined();
    expect(defaultSimulationRecipeRegistry.has(recipeIdValid)).toBe(true);
    expect(defaultSimulationRecipeRegistry.has('missing-name-sim')).toBe(false);
  });

  it('ignores a fit-pack marker when discovering sim-packs', async () => {
    writeFixturePack({
      packageDir: join(testDir, 'node_modules', '@acme', 'fit-only'),
      packageName: '@acme/fit-only',
      marker: 'fit-pack',
    });

    await loadDiscoveredScenarioPackages(testDir);

    expect(scenarioRegistry.size).toBe(0);
  });

  it('returns early when projectDir is empty (no-op)', async () => {
    // The loader's documented short-circuit: empty projectDir → return.
    await loadDiscoveredScenarioPackages('');
    expect(scenarioRegistry.size).toBe(0);
  });

  it('does nothing when no packages match the marker', async () => {
    // The recipe registry baseline includes the built-in `default` recipe,
    // so we measure the delta rather than asserting an absolute zero.
    const baselineRecipeCount = defaultSimulationRecipeRegistry.getAllRecipes().length;
    await loadDiscoveredScenarioPackages(testDir);
    expect(scenarioRegistry.size).toBe(0);
    expect(defaultSimulationRecipeRegistry.getAllRecipes().length).toBe(baselineRecipeCount);
  });
});
