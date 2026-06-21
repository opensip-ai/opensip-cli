/**
 * @fileoverview Tests for cross-kind registry behavior — tag filtering,
 * kind filtering, and discriminated-union exhaustiveness.
 */

import { enterScope } from '@opensip-cli/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ASSERTIONS } from '../framework/assertions.js';
import { fault } from '../framework/execution/fault-builders.js';
import {
  clearScenarioRegistry,
  currentScenarioRegistry,
  getRegisteredScenarios,
  getScenariosByKind,
  getScenariosByTag,
} from '../framework/registry.js';
import { renderScenarioResultView } from '../framework/result-renderers.js';
import { defineChaosScenario } from '../kinds/chaos/define.js';
import { defineLoadScenario } from '../kinds/load/define.js';
import { SCENARIO_KINDS } from '../types/kind-types.js';

import { makeSimTestScope } from './test-utils/with-sim-scope.js';

import type { ScenarioExecutorResult } from '../framework/scenario-executor-result.js';

beforeEach(() => {
  enterScope(makeSimTestScope());
});

afterEach(() => {
  clearScenarioRegistry();
});

const noopTarget = (): Promise<void> => Promise.resolve();

function defineOneOfEachKind(): void {
  currentScenarioRegistry().register(
    defineLoadScenario({
      id: 'cross-load',
      name: 'cross load',
      description: 'load',
      tags: ['shared-tag', 'load-only'],
      target: noopTarget,
      workload: { rps: 1 },
      duration: 1,
      assertions: [ASSERTIONS.lowErrorRate(1)],
    }),
  );

  currentScenarioRegistry().register(
    defineChaosScenario({
      id: 'cross-chaos',
      name: 'cross chaos',
      description: 'chaos',
      tags: ['shared-tag', 'chaos-only'],
      target: noopTarget,
      workload: { rps: 1 },
      duration: 1,
      fault: fault.of([fault.drop()], { probability: 0.1 }),
      steadyStateAssertions: [ASSERTIONS.lowErrorRate(1)],
      recoveryAssertions: [ASSERTIONS.lowErrorRate(1)],
      recoveryWindowMs: 100,
    }),
  );
}

describe('cross-kind registry', () => {
  it('registers both kinds in the same registry', () => {
    defineOneOfEachKind();
    expect(getRegisteredScenarios().size).toBe(2);
  });

  it('SCENARIO_KINDS enumerates exactly the supported kinds', () => {
    expect(SCENARIO_KINDS).toEqual(['load', 'chaos']);
  });

  it('getScenariosByKind filters by kind', () => {
    defineOneOfEachKind();
    expect(getScenariosByKind('load').map((s) => s.id)).toEqual(['cross-load']);
    expect(getScenariosByKind('chaos').map((s) => s.id)).toEqual(['cross-chaos']);
  });

  it('getScenariosByTag works across kinds', () => {
    defineOneOfEachKind();
    const all = getScenariosByTag('shared-tag')
      .map((s) => s.id)
      .sort();
    expect(all).toEqual(['cross-chaos', 'cross-load']);
  });
});

describe('result discriminated union', () => {
  it('renderScenarioResultView produces a uniform view per kind', async () => {
    defineOneOfEachKind();
    const all = [...getRegisteredScenarios().values()];
    const results: ScenarioExecutorResult[] = [];
    for (const s of all) {
      results.push(await s.run(new AbortController().signal));
    }
    const views = results.map(renderScenarioResultView);
    expect(views).toHaveLength(2);
    for (const v of views) {
      expect(typeof v.outcomeLabel).toBe('string');
      expect(typeof v.assertionsPassed).toBe('number');
      expect(typeof v.assertionsFailed).toBe('number');
    }
    expect(views.map((v) => v.kind).sort()).toEqual(['chaos', 'load'].sort());
  });
});
