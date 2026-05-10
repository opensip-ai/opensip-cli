/**
 * @fileoverview Tests for `defineLoadScenario` — load-kind entry point.
 */

import { afterEach, describe, expect, it } from 'vitest'

import {
  defineLoadScenario,
  defineLoadScenarioWithoutRegistration,
  validateLoadScenarioConfig,
} from '../kinds/load/define.js'
import { clearScenarioRegistry, getScenario } from '../framework/registry.js'
import { ASSERTIONS } from '../framework/assertions.js'
import { persona } from '../framework/personas.js'

afterEach(() => {
  clearScenarioRegistry()
})

describe('defineLoadScenario', () => {
  it('produces a runnable scenario tagged with kind="load"', () => {
    const scenario = defineLoadScenario({
      id: 'load-test-1',
      name: 'Load Test 1',
      description: 'Smoke test for load kind.',
      tags: ['smoke'],
      personas: [persona('buyer', 1)],
      duration: 1,
      assertions: [ASSERTIONS.lowErrorRate(0.5)],
    })

    expect(scenario.kind).toBe('load')
    expect(scenario.id).toBe('load-test-1')
    expect(typeof scenario.run).toBe('function')
  })

  it('registers the scenario with the cross-kind registry', () => {
    defineLoadScenario({
      id: 'load-test-2',
      name: 'Load Test 2',
      description: 'Registry test.',
      tags: ['smoke'],
      personas: [persona('buyer', 1)],
      duration: 1,
      assertions: [ASSERTIONS.lowErrorRate(0.5)],
    })

    expect(getScenario('load-test-2')).toBeDefined()
    expect(getScenario('Load Test 2')).toBeDefined()
  })

  it('emits a load-kind result envelope when run', async () => {
    const scenario = defineLoadScenario({
      id: 'load-test-3',
      name: 'Load Test 3',
      description: 'Run-time test.',
      tags: ['smoke'],
      personas: [persona('buyer', 1)],
      duration: 1,
      targetRps: 1,
      assertions: [ASSERTIONS.lowErrorRate(1)],
    })

    const controller = new AbortController()
    const result = await scenario.run(controller.signal)

    expect(result.kind).toBe('load')
    if (result.kind === 'load') {
      expect(result.outcome.metrics).toBeDefined()
      expect(result.outcome.assertions.passed).toBeDefined()
      expect(result.outcome.assertions.failed).toBeDefined()
      expect(result.scenarioId).toBe('load-test-3')
    }
  })

  it('rejects an invalid id', () => {
    expect(() => {
      validateLoadScenarioConfig({
        id: 'INVALID ID',
        name: 'x',
        description: 'x',
        tags: [],
        personas: [persona('buyer', 1)],
        duration: 1,
        assertions: [ASSERTIONS.lowErrorRate()],
      })
    }).toThrow(/id must be lowercase/)
  })
})

describe('defineLoadScenarioWithoutRegistration', () => {
  it('does NOT register the scenario', () => {
    const scenario = defineLoadScenarioWithoutRegistration({
      id: 'load-test-no-reg',
      name: 'Load Test No Reg',
      description: 'No-reg test.',
      tags: [],
      personas: [persona('buyer', 1)],
      duration: 1,
      assertions: [ASSERTIONS.lowErrorRate(0.5)],
    })

    expect(scenario.kind).toBe('load')
    expect(getScenario('load-test-no-reg')).toBeUndefined()
  })

  it('still requires an id', () => {
    expect(() => {
      defineLoadScenarioWithoutRegistration({
        id: '',
        name: 'x',
        description: 'x',
        tags: [],
        personas: [persona('buyer', 1)],
        duration: 1,
        assertions: [ASSERTIONS.lowErrorRate()],
      })
    }).toThrow(/id is required/)
  })
})
