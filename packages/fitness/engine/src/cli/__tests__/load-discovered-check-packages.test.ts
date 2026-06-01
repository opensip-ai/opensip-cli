/**
 * Integration tests for `loadDiscoveredCheckPackages`.
 *
 * Builds fixture node_modules layouts in tmpdir and asserts the loader
 * registers checks + recipes from packages discovered via either the
 * name-pattern walk (legacy @opensip-tools/checks-* / packageScopes) or
 * the marker walk (`opensipTools.kind: "fit-pack"`).
 *
 * Phase 7.4 of the marker-based-discovery plan.
 */

import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';

import { defaultRegistry } from '../../framework/registry.js';
import { defaultRecipeRegistry } from '../../recipes/registry.js';
import { loadDiscoveredCheckPackages } from '../fit.js';

let testDir: string;
let stderrSpy: MockInstance<typeof process.stderr.write>;

beforeEach(() => {
  testDir = mkdtempSync(join(tmpdir(), 'opensip-fit-loader-'));
  // Suppress stderr "no readable package.json" / "no checks array" noise in
  // expected-error cases; tests inspect the spy when they care.
  stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
});

afterEach(() => {
  rmSync(testDir, { recursive: true, force: true });
  defaultRecipeRegistry.reset();
  stderrSpy.mockRestore();
});

/**
 * Drop a fixture check package into the tmpdir's node_modules. The
 * fixture's index.mjs exports `checks` and (optionally) `recipes` arrays
 * matching the minimal shapes the loader gates on (`isCheck` and the
 * `id + name` recipe shape check). Returns the unique IDs the fixture
 * exposed so tests can query the registries by them.
 */
function writeFixturePack(opts: {
  packageDir: string;            // absolute path under testDir/node_modules
  packageName: string;
  marker?: 'fit-pack' | 'sim-pack' | 'tool';
  recipesFragment?: string;      // raw JS literal for `export const recipes = ...`
  omitChecks?: boolean;
  withForeignCore?: boolean;     // plant a nested @opensip-tools/core so the pack resolves a DIFFERENT core
}): { checkId: string; checkSlug: string; recipeId: string; recipeName: string } {
  const checkId = randomUUID();
  const checkSlug = `fix-${checkId.slice(0, 8)}`;
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

  const checksExport = opts.omitChecks
    ? `export const checks = "not-an-array";`
    : `export const checks = [{
        config: {
          id: ${JSON.stringify(checkId)},
          slug: ${JSON.stringify(checkSlug)},
          execute: async () => ({ status: 'pass', findings: [] }),
        },
        run: async () => ({ status: 'pass', findings: [] }),
        getScope: () => ({ languages: [], concerns: [] }),
        getMatcher: () => ({ matches: () => false }),
      }];`;

  const recipesExport = opts.recipesFragment === undefined
    ? `export const recipes = [{
        id: ${JSON.stringify(recipeId)},
        name: ${JSON.stringify(recipeName)},
        displayName: ${JSON.stringify(recipeName)},
        description: 'fixture recipe',
        checks: { include: [] },
        execution: { mode: 'parallel' },
        reporting: {},
      }];`
    : `export const recipes = ${opts.recipesFragment};`;

  writeFileSync(
    join(opts.packageDir, 'index.mjs'),
    `${checksExport}\n${recipesExport}\n`,
  );

  if (opts.withForeignCore) {
    // Plant a self-contained @opensip-tools/core under the pack's own
    // node_modules so `require.resolve('@opensip-tools/core')` anchored in the
    // pack resolves THIS copy — a different physical path than the engine's
    // real core. This is the dual-core condition the single-core guard refuses.
    const coreDir = join(opts.packageDir, 'node_modules', '@opensip-tools', 'core');
    mkdirSync(coreDir, { recursive: true });
    writeFileSync(
      join(coreDir, 'package.json'),
      JSON.stringify({ name: '@opensip-tools/core', version: '0.0.0-fixture', main: './index.js' }),
    );
    writeFileSync(join(coreDir, 'index.js'), 'export {}\n');
  }

  return { checkId, checkSlug, recipeId, recipeName };
}

describe('loadDiscoveredCheckPackages', () => {
  it('discovers and loads a marker-only fit-pack package (any scope)', async () => {
    const { checkSlug, recipeId } = writeFixturePack({
      packageDir: join(testDir, 'node_modules', '@acme', 'fit'),
      packageName: '@acme/fit',
      marker: 'fit-pack',
    });

    const { totalRegistered: registered } = await loadDiscoveredCheckPackages(testDir);

    expect(registered).toBe(1);
    expect(defaultRegistry.getBySlug(checkSlug)).toBeDefined();
    expect(defaultRecipeRegistry.has(recipeId)).toBe(true);
  });

  it('discovers and loads a name-pattern-only package (@opensip-tools/checks-*)', async () => {
    const { checkSlug, recipeId } = writeFixturePack({
      packageDir: join(testDir, 'node_modules', '@opensip-tools', 'checks-fixture'),
      packageName: '@opensip-tools/checks-fixture',
      // No marker — discovery is via the legacy scope+name walk.
    });

    const { totalRegistered: registered } = await loadDiscoveredCheckPackages(testDir);

    expect(registered).toBe(1);
    expect(defaultRegistry.getBySlug(checkSlug)).toBeDefined();
    expect(defaultRecipeRegistry.has(recipeId)).toBe(true);
  });

  it('loads a pack matching BOTH name-pattern and marker only once (dedupe by name)', async () => {
    // A pack named @opensip-tools/checks-foo that ALSO declares the marker.
    // The name-pattern walk finds it first; the marker walk also finds it;
    // dedupe-by-name keeps a single load.
    const { checkSlug, recipeId } = writeFixturePack({
      packageDir: join(testDir, 'node_modules', '@opensip-tools', 'checks-dual'),
      packageName: '@opensip-tools/checks-dual',
      marker: 'fit-pack',
    });

    const { totalRegistered: registered } = await loadDiscoveredCheckPackages(testDir);

    expect(registered).toBe(1);
    expect(defaultRegistry.getBySlug(checkSlug)).toBeDefined();
    expect(defaultRecipeRegistry.has(recipeId)).toBe(true);
  });

  it('loads a pack that exports `checks` but no `recipes` (recipesRegistered=0)', async () => {
    const { checkSlug } = writeFixturePack({
      packageDir: join(testDir, 'node_modules', '@acme', 'fit-no-recipes'),
      packageName: '@acme/fit-no-recipes',
      marker: 'fit-pack',
      recipesFragment: 'undefined',
    });

    const { totalRegistered: registered } = await loadDiscoveredCheckPackages(testDir);

    expect(registered).toBe(1);
    expect(defaultRegistry.getBySlug(checkSlug)).toBeDefined();
  });

  it('emits plugin.recipe.invalid_item warning for malformed recipes; still registers valid checks', async () => {
    // The shape check is `id + name`. We pass one valid, one missing name.
    const recipeIdValid = `valid-${randomUUID()}`;
    const recipeNameValid = `valid-name-${randomUUID()}`;
    const malformedFragment = `[
      { id: ${JSON.stringify(recipeIdValid)}, name: ${JSON.stringify(recipeNameValid)}, displayName: 'v', description: 'd', checks: { include: [] }, execution: { mode: 'parallel' }, reporting: {} },
      { id: 'missing-name' },
    ]`;
    const { checkSlug } = writeFixturePack({
      packageDir: join(testDir, 'node_modules', '@acme', 'fit-malformed-recipe'),
      packageName: '@acme/fit-malformed-recipe',
      marker: 'fit-pack',
      recipesFragment: malformedFragment,
    });

    const { totalRegistered: registered } = await loadDiscoveredCheckPackages(testDir);

    expect(registered).toBe(1);
    expect(defaultRegistry.getBySlug(checkSlug)).toBeDefined();
    // Valid recipe still landed:
    expect(defaultRecipeRegistry.has(recipeIdValid)).toBe(true);
    // Malformed one was skipped:
    expect(defaultRecipeRegistry.has('missing-name')).toBe(false);
  });

  it('skips a marker-discovered pack that fails to export a `checks` array (records a load warning)', async () => {
    writeFixturePack({
      packageDir: join(testDir, 'node_modules', '@acme', 'fit-broken'),
      packageName: '@acme/fit-broken',
      marker: 'fit-pack',
      omitChecks: true,
    });

    const { totalRegistered, warnings } = await loadDiscoveredCheckPackages(testDir);

    expect(totalRegistered).toBe(0);
    // Warning now returned from loadDiscoveredCheckPackages rather than written
    // to stderr — direct stderr writes during the Ink live view desync the
    // renderer; warnings flow through FitDoneResult.warnings instead.
    expect(warnings.some((m) => m.includes('@acme/fit-broken') && m.includes('checks'))).toBe(true);
  });

  it('ignores a sim-pack marker when discovering fit-packs', async () => {
    writeFixturePack({
      packageDir: join(testDir, 'node_modules', '@acme', 'sim-only'),
      packageName: '@acme/sim-only',
      marker: 'sim-pack',
    });

    const { totalRegistered: registered } = await loadDiscoveredCheckPackages(testDir);

    expect(registered).toBe(0);
  });

  it('returns 0 when no packages are discoverable', async () => {
    const { totalRegistered: registered } = await loadDiscoveredCheckPackages(testDir);
    expect(registered).toBe(0);
  });

  it('refuses a pack that resolves a DIFFERENT @opensip-tools/core (single-core guard, B)', async () => {
    // A pack that ships its own nested @opensip-tools/core resolves a second
    // core instance. Loading it would split the run scope (AsyncLocalStorage),
    // silently degrading content filters to raw and producing false positives.
    // The guard refuses it at load time with an actionable warning.
    const { checkSlug } = writeFixturePack({
      packageDir: join(testDir, 'node_modules', '@opensip-tools', 'checks-foreigncore'),
      packageName: '@opensip-tools/checks-foreigncore',
      withForeignCore: true,
    });

    const { totalRegistered, warnings } = await loadDiscoveredCheckPackages(testDir);

    expect(totalRegistered).toBe(0);
    expect(defaultRegistry.getBySlug(checkSlug)).toBeUndefined();
    expect(
      warnings.some(
        (m) => m.includes('@opensip-tools/checks-foreigncore') && m.includes('different @opensip-tools/core'),
      ),
    ).toBe(true);
  });

  it('still loads a same-core pack that does NOT vendor its own core (no false skip)', async () => {
    // Sibling of the guard test: a pack with no nested core resolves the
    // engine's own core (or none), so it must load normally — proving the
    // guard does not over-skip.
    const { checkSlug } = writeFixturePack({
      packageDir: join(testDir, 'node_modules', '@opensip-tools', 'checks-samecore'),
      packageName: '@opensip-tools/checks-samecore',
    });

    const { totalRegistered } = await loadDiscoveredCheckPackages(testDir);

    expect(totalRegistered).toBe(1);
    expect(defaultRegistry.getBySlug(checkSlug)).toBeDefined();
  });
});
