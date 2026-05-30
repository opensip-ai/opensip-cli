import { enterScope } from '@opensip-tools/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { makeSimTestScope } from '../../__tests__/test-utils/with-sim-scope.js';
import { ASSERTIONS } from '../../framework/assertions.js';
import { persona } from '../../framework/personas.js';
import { clearScenarioRegistry, currentScenarioRegistry } from '../../framework/registry.js';
import { defineLoadScenario } from '../../kinds/load/define.js';
import { executeSim } from '../sim.js';

import type { ToolOptions } from '@opensip-tools/contracts';

const args = (overrides: Partial<ToolOptions> = {}): ToolOptions => ({
  json: false,
  cwd: process.cwd(),
  debug: false,
  ...overrides,
});

beforeEach(() => {
  // Item 1: registries are per-RunScope. Enter a fresh scope per test.
  enterScope(makeSimTestScope());
});

afterEach(() => {
  clearScenarioRegistry();
});

describe('executeSim', () => {
  it('returns ErrorResult when the recipe name is unknown', async () => {
    const { result } = await executeSim(args({ recipe: 'does-not-exist' }));
    expect(result.type).toBe('error');
    if (result.type === 'error') {
      expect(result.message).toContain('does-not-exist');
      expect(result.exitCode).toBe(2);
    }
  });

  it('runs the built-in default recipe when no --recipe is passed', async () => {
    const { result } = await executeSim(args());
    expect(result.type).toBe('sim-done');
    if (result.type === 'sim-done') {
      expect(result.recipeName).toBe('default');
    }
  });

  it('returns SimDoneResult with per-scenario outcomes', async () => {
    currentScenarioRegistry().register(defineLoadScenario({
      id: 'load-a',
      name: 'load-a',
      description: 'load a',
      tags: ['demo'],
      personas: [persona('user', 1)],
      duration: 1,
      assertions: [ASSERTIONS.lowErrorRate(1)],
    }));
    const { result } = await executeSim(args());
    expect(result.type).toBe('sim-done');
    if (result.type === 'sim-done') {
      expect(result.totalScenarios).toBe(1);
      expect(result.scenarios[0]?.scenarioId).toBe('load-a');
    }
  });

  it('honors the --kind filter when set to a valid kind', async () => {
    currentScenarioRegistry().register(defineLoadScenario({
      id: 'load-only',
      name: 'load-only',
      description: 'load',
      tags: [],
      personas: [persona('user', 1)],
      duration: 1,
      assertions: [ASSERTIONS.lowErrorRate(1)],
    }));
    const { result } = await executeSim(args({ kind: 'load' }));
    expect(result.type).toBe('sim-done');
    if (result.type === 'sim-done') {
      expect(result.totalScenarios).toBe(1);
    }
  });

  it('--kind filter eliminates scenarios of other kinds', async () => {
    currentScenarioRegistry().register(defineLoadScenario({
      id: 'load-x',
      name: 'load-x',
      description: 'load',
      tags: [],
      personas: [persona('user', 1)],
      duration: 1,
      assertions: [ASSERTIONS.lowErrorRate(1)],
    }));
    const { result } = await executeSim(args({ kind: 'chaos' }));
    expect(result.type).toBe('sim-done');
    if (result.type === 'sim-done') {
      expect(result.totalScenarios).toBe(0);
      expect(result.shouldFail).toBe(false);
    }
  });

  it('ignores unknown --kind values (passes everything through)', async () => {
    currentScenarioRegistry().register(defineLoadScenario({
      id: 'pass-through',
      name: 'pass-through',
      description: 'load',
      tags: [],
      personas: [persona('user', 1)],
      duration: 1,
      assertions: [ASSERTIONS.lowErrorRate(1)],
    }));
    const { result } = await executeSim(args({ kind: 'fake-kind' }));
    expect(result.type).toBe('sim-done');
    if (result.type === 'sim-done') {
      expect(result.totalScenarios).toBe(1);
    }
  });

  it('registers shouldFail=true when at least one scenario fails', async () => {
    // A bare RunnableScenario whose run() rejects to force a failure
    currentScenarioRegistry().register({
      id: 'crashes',
      name: 'crashes',
      description: 'crashes',
      kind: 'load',
      tags: [],
      run: () => Promise.reject(new Error('boom')),
    });
    const { result } = await executeSim(args());
    expect(result.type).toBe('sim-done');
    if (result.type === 'sim-done') {
      expect(result.failedScenarios).toBe(1);
      expect(result.shouldFail).toBe(true);
    }
  });

  it('returns shouldFail=false for an empty scenario set', async () => {
    const { result } = await executeSim(args());
    expect(result.type).toBe('sim-done');
    if (result.type === 'sim-done') {
      expect(result.totalScenarios).toBe(0);
      expect(result.shouldFail).toBe(false);
    }
  });

  it('preserves error messages on failed scenarios', async () => {
    currentScenarioRegistry().register({
      id: 'msg',
      name: 'msg',
      description: 'msg',
      kind: 'load',
      tags: [],
      run: () => Promise.reject(new Error('a-specific-message')),
    });
    const { result } = await executeSim(args());
    if (result.type === 'sim-done') {
      expect(result.scenarios[0]?.error).toContain('a-specific-message');
    }
  });
});
