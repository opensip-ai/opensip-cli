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
      // ADR-0011: per-scenario facts live on the envelope's `units` sidecar
      // (one unit per scenario, slug === scenarioId).
      expect(result.envelope.units).toHaveLength(1);
      expect(result.envelope.units[0]?.slug).toBe('load-a');
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
      expect(result.envelope.units).toHaveLength(1);
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
      expect(result.envelope.units).toHaveLength(0);
      expect(result.shouldFail).toBe(false);
    }
  });

  it('fails fast on an unknown --kind, running nothing', async () => {
    // Previously an unknown --kind was silently ignored and every scenario
    // ran. Now it is a configuration error raised BEFORE any scenario runs.
    let executed = false;
    currentScenarioRegistry().register({
      id: 'should-not-run',
      name: 'should-not-run',
      description: 'x',
      kind: 'load',
      tags: [],
      run: () => {
        executed = true;
        return Promise.reject(new Error('must not run on an invalid --kind'));
      },
    });
    const { result } = await executeSim(args({ kind: 'fake-kind' }));
    expect(result.type).toBe('error');
    if (result.type === 'error') {
      expect(result.exitCode).toBe(2);
      expect(result.message).toContain('fake-kind');
    }
    expect(executed).toBe(false);
  });

  it('does NOT execute scenarios filtered out by --kind (no side effects)', async () => {
    // Regression for the execute-then-filter bug: a scenario of a different
    // kind must never run when --kind narrows it out. The tripwire rejects if
    // executed, so reaching it at all would surface here.
    let executed = false;
    currentScenarioRegistry().register({
      id: 'tripwire',
      name: 'tripwire',
      description: 'must not run when filtered out',
      kind: 'load',
      tags: [],
      run: () => {
        executed = true;
        return Promise.reject(new Error('filtered-out scenario executed'));
      },
    });
    // The default recipe selects all registered scenarios; --kind invariant
    // narrows the 'load' tripwire out before execution.
    const { result } = await executeSim(args({ kind: 'invariant' }));
    expect(result.type).toBe('sim-done');
    expect(executed).toBe(false);
    if (result.type === 'sim-done') {
      expect(result.envelope.units).toHaveLength(0);
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

  it('returns shouldFail=false for an empty scenario set', async () => {
    const { result } = await executeSim(args());
    expect(result.type).toBe('sim-done');
    if (result.type === 'sim-done') {
      expect(result.envelope.units).toHaveLength(0);
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
      // The scenario's thrown error is carried on its unit (slug === scenarioId).
      expect(result.envelope.units[0]?.error).toContain('a-specific-message');
    }
  });
});
