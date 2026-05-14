/**
 * @fileoverview Tests for the deprecated `defineScenario` alias.
 *
 * The legacy entry point continues to compile + run for one release. It
 * routes to `defineLoadScenario`. Configs that exercise chaos via the legacy
 * `chaosConfig` field are explicitly rejected with a migration message
 * pointing at `defineChaosScenario`.
 */

import { afterEach, describe, expect, it } from 'vitest'

import { defineScenario } from '../framework/define-scenario.js'
import { clearScenarioRegistry } from '../framework/registry.js'
import { ASSERTIONS } from '../framework/assertions.js'
import { persona } from '../framework/personas.js'

afterEach(() => {
  clearScenarioRegistry()
})

describe('defineScenario (deprecated alias)', () => {
  it('routes to the load kind for legacy configs', () => {
    const scenario = defineScenario({
      id: 'legacy-1',
      name: 'Legacy 1',
      description: 'Routed to load.',
      type: 'happy-path',
      tags: ['legacy'],
      personas: [persona('buyer', 1)],
      duration: 1,
      assertions: [ASSERTIONS.lowErrorRate(1)],
    })
    expect(scenario.kind).toBe('load')
  })

  it('rejects a legacy config that enables chaosConfig', () => {
    expect(() =>
      defineScenario({
        id: 'legacy-2',
        name: 'Legacy 2',
        description: 'Chaos in legacy define.',
        type: 'chaos',
        tags: ['legacy'],
        personas: [persona('buyer', 1)],
        duration: 1,
        chaosConfig: {
          enabled: true,
          probability: 0.1,
          types: [],
        },
        assertions: [ASSERTIONS.lowErrorRate(1)],
      }),
    ).toThrow(/Migrate to `defineChaosScenario`/)
  })
})
