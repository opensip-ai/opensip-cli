/**
 * Integration tests for `loadDiscoveredCheckPackages`.
 *
 * Builds fixture node_modules layouts in tmpdir and asserts the loader
 * registers checks + recipes from packages discovered via the marker walk
 * (`opensipTools.kind: "fit-pack"`) or exact `plugins.checkPackages` entries.
 *
 * Pack ownership is partitioned by npm scope:
 *   - BUILT-IN (`@opensip-tools/*`) packs resolve from the CLI install tree
 *     (the injected `cliDir`), never the project — a project pin cannot shadow
 *     the bundled copy.
 *   - CUSTOM (any other scope, e.g. `@acme/*`) packs resolve from the project.
 *
 * Phase 7.4 of the marker-based-discovery plan; built-in/custom partition added
 * by the pack-resolution fix.
 */

import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { enterScope, RunScope } from '@opensip-tools/core';
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';

import { currentCheckRegistry, currentRecipeRegistry } from '../../framework/scope-registry.js';
import { fitnessTool } from '../../tool.js';
import { loadDiscoveredCheckPackages } from '../fit.js';

let testDir: string;
let cliDir: string;
let stderrSpy: MockInstance<typeof process.stderr.write>;

beforeEach(() => {
  // Fresh RunScope per test carrying fitness's contributed registries, so the
  // loader writes into an empty, isolated check + recipe registry each time
  // (replaces the prior shared-singleton + afterEach reset).
  const scope = new RunScope();
  Object.assign(scope, fitnessTool.contributeScope?.() ?? {});
  enterScope(scope);
  testDir = mkdtempSync(join(tmpdir(), 'opensip-fit-loader-'));
  // Isolated, EMPTY CLI install dir. Built-in (@opensip-tools/*) discovery is
  // anchored here instead of the real CLI install, so the actual bundled
  // built-ins never leak into these fixture-scoped count assertions. Tests that
  // exercise built-in resolution plant fixtures under this dir explicitly.
  cliDir = mkdtempSync(join(tmpdir(), 'opensip-fit-cli-'));
  // Suppress stderr "no readable package.json" / "no checks array" noise in
  // expected-error cases; tests inspect the spy when they care.
  stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
});

afterEach(() => {
  rmSync(testDir, { recursive: true, force: true });
  rmSync(cliDir, { recursive: true, force: true });
  stderrSpy.mockRestore();
});

/**
 * Drop a fixture check package into a node_modules tree. The fixture's
 * index.mjs exports `checks` and (optionally) `recipes` arrays matching the
 * minimal shapes the loader gates on (`isCheck` and the `id + name` recipe
 * shape check). Returns the unique IDs the fixture exposed so tests can query
 * the registries by them.
 */
function writeFixturePack(opts: {
  packageDir: string;            // absolute path under a node_modules tree
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

    const { totalRegistered: registered } = await loadDiscoveredCheckPackages(testDir, { cliDir });

    expect(registered).toBe(1);
    expect(currentCheckRegistry().getBySlug(checkSlug)).toBeDefined();
    expect(currentRecipeRegistry().has(recipeId)).toBe(true);
  });

  it('does not load a prefix-only package without the fit-pack marker', async () => {
    const { checkSlug } = writeFixturePack({
      packageDir: join(testDir, 'node_modules', '@acme', 'checks-fixture'),
      packageName: '@acme/checks-fixture',
    });

    const { totalRegistered: registered } = await loadDiscoveredCheckPackages(testDir, { cliDir });

    expect(registered).toBe(0);
    expect(currentCheckRegistry().getBySlug(checkSlug)).toBeUndefined();
  });

  it('loads a non-marker package when explicitly listed in plugins.checkPackages', async () => {
    const { checkSlug, recipeId } = writeFixturePack({
      packageDir: join(testDir, 'node_modules', '@acme', 'checks-fixture'),
      packageName: '@acme/checks-fixture',
    });
    writeFileSync(
      join(testDir, 'opensip-tools.config.yml'),
      `plugins:
  checkPackages:
    - "@acme/checks-fixture"
`,
    );

    const { totalRegistered: registered } = await loadDiscoveredCheckPackages(testDir, { cliDir });

    expect(registered).toBe(1);
    expect(currentCheckRegistry().getBySlug(checkSlug)).toBeDefined();
    expect(currentRecipeRegistry().has(recipeId)).toBe(true);
  });

  it('loads a checks-prefixed pack when it declares the fit-pack marker', async () => {
    const { checkSlug, recipeId } = writeFixturePack({
      packageDir: join(testDir, 'node_modules', '@acme', 'checks-dual'),
      packageName: '@acme/checks-dual',
      marker: 'fit-pack',
    });

    const { totalRegistered: registered } = await loadDiscoveredCheckPackages(testDir, { cliDir });

    expect(registered).toBe(1);
    expect(currentCheckRegistry().getBySlug(checkSlug)).toBeDefined();
    expect(currentRecipeRegistry().has(recipeId)).toBe(true);
  });

  it('loads a pack that exports `checks` but no `recipes` (recipesRegistered=0)', async () => {
    const { checkSlug } = writeFixturePack({
      packageDir: join(testDir, 'node_modules', '@acme', 'fit-no-recipes'),
      packageName: '@acme/fit-no-recipes',
      marker: 'fit-pack',
      recipesFragment: 'undefined',
    });

    const { totalRegistered: registered } = await loadDiscoveredCheckPackages(testDir, { cliDir });

    expect(registered).toBe(1);
    expect(currentCheckRegistry().getBySlug(checkSlug)).toBeDefined();
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

    const { totalRegistered: registered } = await loadDiscoveredCheckPackages(testDir, { cliDir });

    expect(registered).toBe(1);
    expect(currentCheckRegistry().getBySlug(checkSlug)).toBeDefined();
    // Valid recipe still landed:
    expect(currentRecipeRegistry().has(recipeIdValid)).toBe(true);
    // Malformed one was skipped:
    expect(currentRecipeRegistry().has('missing-name')).toBe(false);
  });

  it('skips a marker-discovered pack that fails to export a `checks` array (records a load warning)', async () => {
    writeFixturePack({
      packageDir: join(testDir, 'node_modules', '@acme', 'fit-broken'),
      packageName: '@acme/fit-broken',
      marker: 'fit-pack',
      omitChecks: true,
    });

    const { totalRegistered, warnings } = await loadDiscoveredCheckPackages(testDir, { cliDir });

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

    const { totalRegistered: registered } = await loadDiscoveredCheckPackages(testDir, { cliDir });

    expect(registered).toBe(0);
  });

  it('returns 0 when no packages are discoverable', async () => {
    const { totalRegistered: registered } = await loadDiscoveredCheckPackages(testDir, { cliDir });
    expect(registered).toBe(0);
  });

  it('refuses CUSTOM packs that resolve a DIFFERENT @opensip-tools/core, in ONE consolidated warning (single-core guard, B)', async () => {
    // Custom packs that ship their own nested @opensip-tools/core resolve a
    // second core instance. Loading them would split the run scope
    // (AsyncLocalStorage), silently degrading content filters to raw and
    // producing false positives. The guard refuses them at load time — and
    // reports all skips in a single warning that lists each pack, rather than a
    // verbose paragraph per pack. (Project-vendored @opensip-tools/* packs no
    // longer reach this guard — they're dropped earlier as built-in shadows.)
    const a = writeFixturePack({
      packageDir: join(testDir, 'node_modules', '@acme', 'checks-foreigncore-a'),
      packageName: '@acme/checks-foreigncore-a',
      marker: 'fit-pack',
      withForeignCore: true,
    });
    const b = writeFixturePack({
      packageDir: join(testDir, 'node_modules', '@acme', 'checks-foreigncore-b'),
      packageName: '@acme/checks-foreigncore-b',
      marker: 'fit-pack',
      withForeignCore: true,
    });

    const { totalRegistered, warnings, coreMismatchSkips } = await loadDiscoveredCheckPackages(testDir, {
      cliDir,
    });

    expect(totalRegistered).toBe(0);
    expect(currentCheckRegistry().getBySlug(a.checkSlug)).toBeUndefined();
    expect(currentCheckRegistry().getBySlug(b.checkSlug)).toBeUndefined();
    // Both packs reported via the structured skip list…
    expect([...coreMismatchSkips].sort()).toEqual([
      '@acme/checks-foreigncore-a',
      '@acme/checks-foreigncore-b',
    ]);
    // …and surfaced in exactly ONE consolidated warning naming both.
    const mismatchWarnings = warnings.filter((m) => m.includes('different @opensip-tools/core'));
    expect(mismatchWarnings).toHaveLength(1);
    expect(mismatchWarnings[0]).toContain('@acme/checks-foreigncore-a');
    expect(mismatchWarnings[0]).toContain('@acme/checks-foreigncore-b');
    expect(mismatchWarnings[0]).toContain('pnpm fit');
  });

  it('still loads a same-core CUSTOM pack that does NOT vendor its own core (no false skip)', async () => {
    // Sibling of the guard test: a pack with no nested core resolves the
    // engine's own core (or none), so it must load normally — proving the
    // guard does not over-skip.
    const { checkSlug } = writeFixturePack({
      packageDir: join(testDir, 'node_modules', '@acme', 'checks-samecore'),
      packageName: '@acme/checks-samecore',
      marker: 'fit-pack',
    });

    const { totalRegistered, coreMismatchSkips } = await loadDiscoveredCheckPackages(testDir, { cliDir });

    expect(totalRegistered).toBe(1);
    expect(currentCheckRegistry().getBySlug(checkSlug)).toBeDefined();
    expect(coreMismatchSkips).toEqual([]);
  });

  // ── Built-in vs custom partition (the pack-resolution fix) ────────────────

  it('loads a built-in @opensip-tools/* pack from the CLI install dir, not the project', async () => {
    const { checkSlug } = writeFixturePack({
      packageDir: join(cliDir, 'node_modules', '@opensip-tools', 'checks-builtin'),
      packageName: '@opensip-tools/checks-builtin',
      marker: 'fit-pack',
    });

    const { totalRegistered } = await loadDiscoveredCheckPackages(testDir, { cliDir });

    expect(totalRegistered).toBe(1);
    expect(currentCheckRegistry().getBySlug(checkSlug)).toBeDefined();
  });

  it('drops a project-vendored @opensip-tools/* pack — it cannot shadow the bundled built-in', async () => {
    // The SAME built-in name exists in BOTH the CLI install (the real bundled
    // copy) and the project tree (a stale version a consumer pinned). Only the
    // CLI copy may win; the project shadow is ignored entirely — this is the
    // core guarantee: on CLI 2.x the built-in IS 2.x, regardless of project pins.
    const builtin = writeFixturePack({
      packageDir: join(cliDir, 'node_modules', '@opensip-tools', 'checks-typescript'),
      packageName: '@opensip-tools/checks-typescript',
      marker: 'fit-pack',
    });
    const shadow = writeFixturePack({
      packageDir: join(testDir, 'node_modules', '@opensip-tools', 'checks-typescript'),
      packageName: '@opensip-tools/checks-typescript',
      marker: 'fit-pack',
    });

    const { totalRegistered } = await loadDiscoveredCheckPackages(testDir, { cliDir });

    // Exactly one copy loaded — the CLI's — and it is the CLI's check, not the shadow's.
    expect(totalRegistered).toBe(1);
    expect(currentCheckRegistry().getBySlug(builtin.checkSlug)).toBeDefined();
    expect(currentCheckRegistry().getBySlug(shadow.checkSlug)).toBeUndefined();
  });

  it('still discovers a CUSTOM pack from the project while built-ins come from the CLI', async () => {
    // Both origins active at once: a bundled built-in in the CLI dir AND a
    // consumer custom pack in the project. Both load; neither is dropped.
    const builtin = writeFixturePack({
      packageDir: join(cliDir, 'node_modules', '@opensip-tools', 'checks-universal'),
      packageName: '@opensip-tools/checks-universal',
      marker: 'fit-pack',
    });
    const custom = writeFixturePack({
      packageDir: join(testDir, 'node_modules', '@acme', 'fit'),
      packageName: '@acme/fit',
      marker: 'fit-pack',
    });

    const { totalRegistered } = await loadDiscoveredCheckPackages(testDir, { cliDir });

    expect(totalRegistered).toBe(2);
    expect(currentCheckRegistry().getBySlug(builtin.checkSlug)).toBeDefined();
    expect(currentCheckRegistry().getBySlug(custom.checkSlug)).toBeDefined();
  });
});
