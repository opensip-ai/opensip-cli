/**
 * @fileoverview Tests for cross-kind registry behavior — tag filtering,
 * kind filtering, and discriminated-union exhaustiveness.
 */

import { afterEach, describe, expect, it } from 'vitest'

import { defineLoadScenario } from '../kinds/load/define.js'
import { defineChaosScenario } from '../kinds/chaos/define.js'
import { defineInvariantScenario } from '../kinds/invariant/define.js'
import { defineFixEvaluationScenario } from '../kinds/fix-evaluation/define.js'
import { resetPredicateRegistryToBaseline } from '../kinds/fix-evaluation/predicates/index.js'
import {
  clearScenarioRegistry,
  getRegisteredScenarios,
  getScenariosByKind,
  getScenariosByTag,
} from '../framework/registry.js'
import { renderScenarioResultView } from '../framework/result-renderers.js'
import type { ScenarioExecutorResult } from '../framework/scenario-executor-result.js'
import { ASSERTIONS } from '../framework/assertions.js'
import { persona } from '../framework/personas.js'
import { SCENARIO_KINDS } from '../types/kind-types.js'

afterEach(() => {
  clearScenarioRegistry()
  resetPredicateRegistryToBaseline()
})

function defineOneOfEachKind(): void {
  defineLoadScenario({
    id: 'cross-load',
    name: 'cross load',
    description: 'load',
    tags: ['shared-tag', 'load-only'],
    personas: [persona('buyer', 1)],
    duration: 1,
    assertions: [ASSERTIONS.lowErrorRate(1)],
  })

  defineChaosScenario({
    id: 'cross-chaos',
    name: 'cross chaos',
    description: 'chaos',
    tags: ['shared-tag', 'chaos-only'],
    personas: [persona('buyer', 1)],
    duration: 1,
    chaos: {
      enabled: true,
      probability: 0.1,
      types: [
        {
          type: 'error',
          target: '*',
          probability: 0.5,
          config: { type: 'error', statusCode: 500, message: 'x' },
        },
      ],
    },
    steadyStateAssertions: [ASSERTIONS.lowErrorRate(1)],
    recoveryAssertions: [ASSERTIONS.lowErrorRate(1)],
    recoveryWindow: 100,
  })

  defineInvariantScenario({
    id: 'cross-invariant',
    name: 'cross invariant',
    description: 'invariant',
    tags: ['shared-tag', 'invariant-only'],
    relatesToInvariant: 'doc.md#anchor',
    setup: async () => {},
    act: async () => {},
    assert: async () => {},
  })

  defineFixEvaluationScenario({
    id: 'cross-fix-eval',
    name: 'cross fix eval',
    description: 'fix-evaluation',
    tags: ['shared-tag', 'fix-eval-only'],
    category: 'security',
    score: 3,
    criteriaMet: ['code-file'],
    source: 'simulation',
    severity: 'high',
    expectedDifficulty: 'trivial',
    signalIntent: 'actionable',
    judgmentMode: 'predicate-match',
    provenance: 'real-world-inspired',
    expectedOutcome: 'success',
    signal: {
      source: 'simulation',
      severity: 'high',
      category: 'security',
      ruleId: 'corpus:test',
      message: 'test',
    },
    predicate: { all_of: [{ id: 'tests-pass' }, { id: 'no-tests-modified' }] },
  })
}

describe('cross-kind registry', () => {
  it('registers all four kinds in the same registry', () => {
    defineOneOfEachKind()
    expect(getRegisteredScenarios().size).toBe(4)
  })

  it('SCENARIO_KINDS enumerates exactly the four supported kinds', () => {
    expect(SCENARIO_KINDS).toEqual(['load', 'chaos', 'invariant', 'fix-evaluation'])
  })

  it('getScenariosByKind filters by kind', () => {
    defineOneOfEachKind()
    expect(getScenariosByKind('load').map((s) => s.id)).toEqual(['cross-load'])
    expect(getScenariosByKind('chaos').map((s) => s.id)).toEqual(['cross-chaos'])
    expect(getScenariosByKind('invariant').map((s) => s.id)).toEqual(['cross-invariant'])
    expect(getScenariosByKind('fix-evaluation').map((s) => s.id)).toEqual(['cross-fix-eval'])
  })

  it('getScenariosByTag works across kinds', () => {
    defineOneOfEachKind()
    const all = getScenariosByTag('shared-tag').map((s) => s.id).sort()
    expect(all).toEqual(['cross-chaos', 'cross-fix-eval', 'cross-invariant', 'cross-load'])
  })
})

describe('result discriminated union', () => {
  it('renderScenarioResultView produces a uniform view per kind', async () => {
    defineOneOfEachKind()
    const all = [...getRegisteredScenarios().values()]
    const results: ScenarioExecutorResult[] = []
    for (const s of all) {
      results.push(await s.run(new AbortController().signal))
    }
    const views = results.map(renderScenarioResultView)
    expect(views).toHaveLength(4)
    for (const v of views) {
      expect(typeof v.outcomeLabel).toBe('string')
      expect(typeof v.assertionsPassed).toBe('number')
      expect(typeof v.assertionsFailed).toBe('number')
    }
    expect(views.map((v) => v.kind).sort()).toEqual(
      ['chaos', 'fix-evaluation', 'invariant', 'load'].sort(),
    )
  })
})
