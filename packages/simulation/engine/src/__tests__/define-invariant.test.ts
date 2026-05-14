/* eslint-disable @typescript-eslint/require-await, @typescript-eslint/no-empty-function -- scenario phase hooks must match `() => Promise<void>` shape; many test scenarios are intentionally no-op stubs */
/**
 * @fileoverview Tests for `defineInvariantScenario` — invariant-kind entry point.
 */

import { afterEach, describe, expect, it } from 'vitest'

import { clearScenarioRegistry } from '../framework/registry.js'
import {
  defineInvariantScenario,
  validateInvariantScenarioConfig,
} from '../kinds/invariant/define.js'

afterEach(() => {
  clearScenarioRegistry()
})

describe('defineInvariantScenario', () => {
  it('produces a runnable scenario tagged with kind="invariant"', () => {
    const scenario = defineInvariantScenario({
      id: 'inv-test-1',
      name: 'Invariant Test 1',
      description: 'Smoke test.',
      tags: ['reconciler'],
      relatesToInvariant: 'CLAUDE.md#signal-reconciliation/scenario-1',
      setup: async () => {},
      act: async () => {},
      assert: async (ctx) => {
        ctx.assertThat(true, 'trivial truth')
      },
    })

    expect(scenario.kind).toBe('invariant')
    expect(scenario.tags).toContain('reconciler')
  })

  it('runs all three phases and records assertions', async () => {
    const log: string[] = []
    const scenario = defineInvariantScenario({
      id: 'inv-test-2',
      name: 'Invariant Test 2',
      description: 'Phase order test.',
      tags: [],
      relatesToInvariant: 'doc.md#anchor',
      setup: async () => {
        log.push('setup')
      },
      act: async () => {
        log.push('act')
      },
      assert: async (ctx) => {
        log.push('assert')
        ctx.assertThat(true, 'always true')
        ctx.assertEquals(1 + 1, 2, '1 + 1 = 2')
      },
    })

    const controller = new AbortController()
    const result = await scenario.run(controller.signal)

    expect(log).toEqual(['setup', 'act', 'assert'])
    expect(result.kind).toBe('invariant')
    if (result.kind === 'invariant') {
      expect(result.outcome.relatesToInvariant).toBe('doc.md#anchor')
      expect(result.outcome.phases).toHaveLength(3)
      expect(result.outcome.phases.map((p) => p.phase)).toEqual(['setup', 'act', 'assert'])
      expect(result.outcome.phases.every((p) => p.status === 'passed')).toBe(true)
      expect(result.outcome.assertions).toHaveLength(2)
      expect(result.outcome.assertions.every((a) => a.held)).toBe(true)
    }
    expect(result.passed).toBe(true)
  })

  it('marks the scenario as failed when any assertion does not hold', async () => {
    const scenario = defineInvariantScenario({
      id: 'inv-test-3',
      name: 'Invariant Test 3',
      description: 'Failed assertion.',
      tags: [],
      relatesToInvariant: 'doc.md#anchor',
      setup: async () => {},
      act: async () => {},
      assert: async (ctx) => {
        ctx.assertThat(false, 'false on purpose')
      },
    })

    const result = await scenario.run(new AbortController().signal)
    expect(result.passed).toBe(false)
  })

  it('captures act-phase failure and skips assert', async () => {
    let assertRan = false
    const scenario = defineInvariantScenario({
      id: 'inv-test-4',
      name: 'Invariant Test 4',
      description: 'Failure handling.',
      tags: [],
      relatesToInvariant: 'doc.md#anchor',
      setup: async () => {},
      act: async () => {
        // @fitness-ignore-next-line result-pattern-consistency -- intentional throw to test phase failure capture
        throw new Error('act blew up')
      },
      assert: async () => {
        assertRan = true
      },
    })

    const result = await scenario.run(new AbortController().signal)
    expect(assertRan).toBe(false)
    expect(result.passed).toBe(false)
    if (result.kind === 'invariant') {
      const actPhase = result.outcome.phases.find((p) => p.phase === 'act')
      expect(actPhase?.status).toBe('failed')
      expect(actPhase?.error).toContain('act blew up')
    }
  })

  it('rejects a config without relatesToInvariant', () => {
    expect(() => {
      validateInvariantScenarioConfig({
        id: 'inv-bad',
        name: 'Bad',
        description: 'Bad',
        tags: [],
        relatesToInvariant: '',
        setup: async () => {},
        act: async () => {},
        assert: async () => {},
      })
    }).toThrow(/relatesToInvariant is required/)
  })

  it('default deps throw a clear NOT_IMPLEMENTED error', async () => {
    const scenario = defineInvariantScenario({
      id: 'inv-test-deps',
      name: 'Invariant Test Deps',
      description: 'Default deps surface.',
      tags: [],
      relatesToInvariant: 'doc.md#anchor',
      setup: async (ctx) => {
        await ctx.seedTenant()
      },
      act: async () => {},
      assert: async () => {},
    })

    const result = await scenario.run(new AbortController().signal)
    if (result.kind === 'invariant') {
      const setupPhase = result.outcome.phases.find((p) => p.phase === 'setup')
      expect(setupPhase?.status).toBe('failed')
      expect(setupPhase?.error).toMatch(/seedTenant.*not yet implemented/)
    }
  })
})
