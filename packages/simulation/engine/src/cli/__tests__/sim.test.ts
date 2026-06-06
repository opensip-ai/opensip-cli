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
    // Register a scenario so the default recipe has something to run — an
    // empty selection now fails closed (see the zero-scenario guard tests
    // below), so this test must supply work to exercise the happy path.
    currentScenarioRegistry().register(defineLoadScenario({
      id: 'default-probe',
      name: 'default-probe',
      description: 'default-probe',
      tags: [],
      personas: [persona('user', 1)],
      duration: 1,
      assertions: [ASSERTIONS.lowErrorRate(1)],
    }));
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
      // ADR-0011: per-scenario facts live on the envelope's `units` sidecar
      // (one unit per scenario, slug === scenarioId).
      expect(result.envelope.units).toHaveLength(1);
      expect(result.envelope.units[0]?.slug).toBe('load-a');
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
      expect(result.envelope.verdict.summary.failed).toBe(1);
      expect(result.shouldFail).toBe(true);
    }
  });

  it('fails closed (exit 2) when the scenario registry is empty (audit P1c)', async () => {
    // "Empty work is not success": with no scenarios registered at all, a run
    // simulated nothing. That must be a configuration/unavailable error (exit
    // 2), never a green sim-done pass that masks a misconfig/missing-dep.
    const { result } = await executeSim(args());
    expect(result.type).toBe('error');
    if (result.type === 'error') {
      expect(result.exitCode).toBe(2);
      // Registry-empty cause → install/scaffold guidance.
      expect(result.message).toContain('No scenarios were loaded');
      expect(result.suggestion).toContain('init');
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
      // The scenario's thrown error is carried on its unit (slug === scenarioId).
      expect(result.envelope.units[0]?.error).toContain('a-specific-message');
    }
  });
});
