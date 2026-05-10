/**
 * @fileoverview Tests for `defineChaosScenario` — chaos-kind entry point.
 */

import { afterEach, describe, expect, it } from 'vitest'

import { defineChaosScenario, validateChaosScenarioConfig } from '../kinds/chaos/define.js'
import { clearScenarioRegistry } from '../framework/registry.js'
import { ASSERTIONS } from '../framework/assertions.js'
import { persona } from '../framework/personas.js'
import type { ChaosConfig } from '../types/base-types.js'

const baseChaos: ChaosConfig = {
  enabled: true,
  probability: 0.1,
  types: [
    {
      type: 'error',
      target: '*',
      probability: 0.5,
      config: { type: 'error', statusCode: 500, message: 'injected' },
    },
  ],
}

afterEach(() => {
  clearScenarioRegistry()
})

describe('defineChaosScenario', () => {
  it('produces a runnable scenario tagged with kind="chaos"', () => {
    const scenario = defineChaosScenario({
      id: 'chaos-test-1',
      name: 'Chaos Test 1',
      description: 'Chaos kind smoke.',
      tags: ['chaos'],
      personas: [persona('buyer', 1)],
      duration: 1,
      chaos: baseChaos,
      steadyStateAssertions: [ASSERTIONS.lowErrorRate(1)],
      recoveryAssertions: [ASSERTIONS.lowErrorRate(0.5)],
      recoveryWindow: 100,
    })

    expect(scenario.kind).toBe('chaos')
    expect(scenario.tags).toContain('chaos')
  })

  it('emits a chaos-kind result envelope with steady-state + recovery metrics', async () => {
    const scenario = defineChaosScenario({
      id: 'chaos-test-2',
      name: 'Chaos Test 2',
      description: 'Result envelope.',
      tags: ['chaos'],
      personas: [persona('buyer', 1)],
      duration: 1,
      targetRps: 1,
      chaos: baseChaos,
      steadyStateAssertions: [ASSERTIONS.lowErrorRate(1)],
      recoveryAssertions: [ASSERTIONS.lowErrorRate(1)],
      recoveryWindow: 100,
    })

    const controller = new AbortController()
    const result = await scenario.run(controller.signal)

    expect(result.kind).toBe('chaos')
    if (result.kind === 'chaos') {
      expect(result.outcome.steadyStateMetrics).toBeDefined()
      expect(result.outcome.recoveryMetrics).toBeDefined()
      expect(result.outcome.recoveryWindowMs).toBe(100)
      expect(Array.isArray(result.outcome.chaosEvents)).toBe(true)
    }
  })

  it('rejects a config without recovery assertions', () => {
    expect(() => {
      validateChaosScenarioConfig({
        id: 'chaos-bad',
        name: 'Bad',
        description: 'Bad',
        tags: [],
        personas: [persona('buyer', 1)],
        duration: 1,
        chaos: baseChaos,
        steadyStateAssertions: [ASSERTIONS.lowErrorRate()],
        recoveryAssertions: [],
        recoveryWindow: 100,
      })
    }).toThrow(/recovery assertion is required/)
  })

  it('rejects a config with invalid chaos.probability', () => {
    expect(() => {
      validateChaosScenarioConfig({
        id: 'chaos-bad-2',
        name: 'Bad 2',
        description: 'Bad',
        tags: [],
        personas: [persona('buyer', 1)],
        duration: 1,
        chaos: { ...baseChaos, probability: 5 },
        steadyStateAssertions: [ASSERTIONS.lowErrorRate()],
        recoveryAssertions: [ASSERTIONS.lowErrorRate()],
        recoveryWindow: 100,
      })
    }).toThrow(/chaos.probability must be in/)
  })
})
