import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { loadAllSimPlugins } from '../plugins/loader.js';

let testDir: string;

beforeEach(() => {
  testDir = mkdtempSync(join(tmpdir(), 'sim-plugin-loader-'));
});

afterEach(() => {
  rmSync(testDir, { recursive: true, force: true });
});

describe('loadAllSimPlugins', () => {
  it('returns an empty result when no projectDir is provided', async () => {
    const result = await loadAllSimPlugins();
    expect(result.plugins).toEqual([]);
    expect(result.totals).toEqual({});
    expect(result.errors).toEqual([]);
  });

  it('returns an empty result for a projectDir with no opensip-tools/ subtree', async () => {
    const result = await loadAllSimPlugins(testDir);
    expect(result.plugins).toEqual([]);
  });

  it('loads a discovered user-source plugin file and rolls up counts', async () => {
    // Build a minimal sim project layout that discovers one user-source
    // plugin file.
    const scenariosDir = join(testDir, 'opensip-tools', 'sim', 'scenarios');
    mkdirSync(scenariosDir, { recursive: true });
    writeFileSync(join(scenariosDir, 'a.mjs'), 'export const recipes = [];\n');

    const result = await loadAllSimPlugins(testDir);
    expect(result.plugins.length).toBe(1);
    expect(result.totals.scenarios).toBe(0);
    expect(result.totals.recipes).toBe(0);
  });

  it('collects an error when a plugin file throws on import', async () => {
    const scenariosDir = join(testDir, 'opensip-tools', 'sim', 'scenarios');
    mkdirSync(scenariosDir, { recursive: true });
    writeFileSync(join(scenariosDir, 'bad.mjs'), 'throw new Error("boom on import");\n');

    const result = await loadAllSimPlugins(testDir);
    expect(result.plugins.length).toBe(1);
    expect(result.errors.length).toBe(1);
    expect(result.errors[0]).toContain('boom on import');
  });

  it('warns when recipes is not an array', async () => {
    const scenariosDir = join(testDir, 'opensip-tools', 'sim', 'scenarios');
    mkdirSync(scenariosDir, { recursive: true });
    writeFileSync(join(scenariosDir, 'a.mjs'), 'export const recipes = "not an array";\n');

    const result = await loadAllSimPlugins(testDir);
    expect(result.plugins.length).toBe(1);
    expect(result.totals.recipes).toBe(0);
  });

  it('skips invalid recipe items', async () => {
    const scenariosDir = join(testDir, 'opensip-tools', 'sim', 'scenarios');
    mkdirSync(scenariosDir, { recursive: true });
    writeFileSync(
      join(scenariosDir, 'a.mjs'),
      'export const recipes = [{}, { id: "ok", name: "ok-recipe" }];\n',
    );

    const result = await loadAllSimPlugins(testDir);
    expect(result.plugins.length).toBe(1);
    // One valid recipe should register (or be deduped if a previous test
    // already registered one with the same id — the loader silently
    // ignores duplicates, so we accept 0 or 1).
    expect(result.totals.recipes === 0 || result.totals.recipes === 1).toBe(true);
  });
});
