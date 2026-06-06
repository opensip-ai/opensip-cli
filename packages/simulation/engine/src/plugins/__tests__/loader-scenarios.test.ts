/**
 * @fileoverview Covers the simulation plugin loader's SCENARIO registration
 * path (the recipe path is covered by ../../__tests__/plugin-loader.test.ts).
 *
 * A discovered `.mjs` plugin that exports a `scenarios` array drives
 * `registerScenariosArray` → `isValidScenario` → `tryRegisterScenario`. We
 * assert the real behaviour: well-shaped scenarios register into the live
 * scope registry, malformed items are skipped (not registered, not fatal), and
 * a non-array `scenarios` export is rejected without registering anything.
 */

import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { enterScope, RunScope } from '@opensip-tools/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { currentScenarioRegistry } from '../../framework/registry.js';
import { simulationTool } from '../../tool.js';
import { loadAllSimPlugins } from '../loader.js';

let testDir: string;

beforeEach(() => {
  const scope = new RunScope();
  Object.assign(scope, simulationTool.contributeScope?.() ?? {});
  enterScope(scope);
  testDir = mkdtempSync(join(tmpdir(), 'sim-loader-scenarios-'));
});

afterEach(() => {
  rmSync(testDir, { recursive: true, force: true });
});

function writeScenarioPlugin(body: string): void {
  const dir = join(testDir, 'opensip-tools', 'sim', 'scenarios');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'plugin.mjs'), body);
}

describe('loadAllSimPlugins — scenario registration', () => {
  it('registers well-shaped scenarios from a plugin export into the scope registry', async () => {
    writeScenarioPlugin(
      'export const scenarios = [' +
        '{ id: "plug-load-1", name: "plug-load-1", kind: "load", tags: [], run: async () => ({ kind: "load", scenarioId: "plug-load-1", passed: true, durationMs: 0, signals: [] }) }' +
      '];\n',
    );

    const result = await loadAllSimPlugins(testDir);

    expect(result.totals.scenarios).toBe(1);
    expect(currentScenarioRegistry().get('plug-load-1')).toBeDefined();
  });

  it('skips malformed scenario items but still registers the valid ones', async () => {
    writeScenarioPlugin(
      'export const scenarios = [' +
        '{ id: "missing-run" },' + // not a valid RunnableScenario (no kind/run) → skipped
        '{ id: "plug-load-2", name: "plug-load-2", kind: "load", tags: [], run: async () => ({ kind: "load", scenarioId: "plug-load-2", passed: true, durationMs: 0, signals: [] }) }' +
      '];\n',
    );

    const result = await loadAllSimPlugins(testDir);

    // Only the well-shaped scenario registers; the malformed item is dropped.
    expect(result.totals.scenarios).toBe(1);
    expect(currentScenarioRegistry().get('plug-load-2')).toBeDefined();
    expect(currentScenarioRegistry().get('missing-run')).toBeUndefined();
  });

  it('rejects a non-array scenarios export without registering anything', async () => {
    writeScenarioPlugin('export const scenarios = "not-an-array";\n');

    const result = await loadAllSimPlugins(testDir);

    expect(result.totals.scenarios ?? 0).toBe(0);
    expect(currentScenarioRegistry().size).toBe(0);
  });
});
