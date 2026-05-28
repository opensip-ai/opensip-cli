/**
 * @fileoverview Tests for `defineFixEvaluationScenario` — fix-evaluation entry point.
 */

import { enterScope } from '@opensip-tools/core'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  defineFixEvaluationScenario,
  validateFixEvaluationScenarioConfig,
  type FixEvaluationScenarioConfig,
} from '../kinds/fix-evaluation/define.js'
import {
  listPredicateIds,
  registerPredicate,
  resetPredicateRegistryToBaseline,
} from '../kinds/fix-evaluation/predicates/index.js'

import { makeSimTestScope } from './test-utils/with-sim-scope.js'

const baseConfig: Omit<FixEvaluationScenarioConfig, 'id' | 'name' | 'predicate'> = {
  description: 'sql injection fix predicate test',
  tags: ['security'],
  category: 'security',
  score: 5,
  criteriaMet: ['code-file', 'code-line', 'suggestion'],
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
    ruleId: 'corpus:sql-injection-strong',
    message: 'Direct string concatenation builds an SQL query',
  },
  targets: ['src/db.ts'],
}

beforeEach(() => {
  // Item 1: scenarioRegistry is per-RunScope. Enter a fresh scope.
  enterScope(makeSimTestScope())
})

afterEach(() => {
  resetPredicateRegistryToBaseline()
})

describe('defineFixEvaluationScenario', () => {
  it('produces a runnable scenario tagged with kind="fix-evaluation"', () => {
    const scenario = defineFixEvaluationScenario({
      ...baseConfig,
      id: 'fe-test-1',
      name: 'Fix Eval Test 1',
      predicate: {
        all_of: [{ id: 'tests-pass' }, { id: 'no-tests-modified' }],
      },
    })

    expect(scenario.kind).toBe('fix-evaluation')
  })

  it('emits a fix-evaluation result envelope with placeholder verdict tree', async () => {
    const scenario = defineFixEvaluationScenario({
      ...baseConfig,
      id: 'fe-test-2',
      name: 'Fix Eval Test 2',
      predicate: {
        all_of: [
          { id: 'tests-pass' },
          { id: 'regex-in-file', path: 'src/db.ts', pattern: String.raw`\$\d+` },
          { id: 'no-files-outside-target', targets: ['src/db.ts'] },
        ],
      },
    })

    const result = await scenario.run(new AbortController().signal)
    expect(result.kind).toBe('fix-evaluation')
    if (result.kind === 'fix-evaluation') {
      expect(result.outcome.predicateMatched).toBe(false)
      // verdict tree mirrors input structure
      expect(result.outcome.verdict?.type).toBe('composite')
      if (result.outcome.verdict?.type === 'composite') {
        expect(result.outcome.verdict.combinator).toBe('all_of')
        expect(result.outcome.verdict.children).toHaveLength(3)
      }
      expect(result.passed).toBe(false)
    }
  })

  it('rejects an unknown predicate id at definition time', () => {
    expect(() =>
      validateFixEvaluationScenarioConfig({
        ...baseConfig,
        id: 'fe-bad-1',
        name: 'fe bad 1',
        predicate: {
          all_of: [{ id: 'no-tests-modified' }, { id: 'made-up-predicate' }],
        },
      }),
    ).toThrow(/unknown predicate id 'made-up-predicate'/)
  })

  it('rejects predicate-match without a gaming-defense leaf', () => {
    expect(() =>
      validateFixEvaluationScenarioConfig({
        ...baseConfig,
        id: 'fe-bad-2',
        name: 'fe bad 2',
        predicate: {
          all_of: [{ id: 'tests-pass' }, { id: 'lint-clean' }],
        },
      }),
    ).toThrow(/gaming-defense leaf/)
  })

  it('rejects a non-predicate-match scenario that supplies a predicate', () => {
    expect(() =>
      validateFixEvaluationScenarioConfig({
        ...baseConfig,
        id: 'fe-bad-3',
        name: 'fe bad 3',
        judgmentMode: 'human-review',
        predicate: { all_of: [{ id: 'tests-pass' }] },
      }),
    ).toThrow(/predicate must be omitted/)
  })

  it('accepts a custom predicate registered at composition time', () => {
    // eslint-disable-next-line @typescript-eslint/require-await -- predicate signature requires `() => Promise<PredicateResult>`
    registerPredicate('my-custom-predicate', async () => ({ passed: true }))
    expect(listPredicateIds()).toContain('my-custom-predicate')

    expect(() =>
      defineFixEvaluationScenario({
        ...baseConfig,
        id: 'fe-test-3',
        name: 'fe test 3',
        predicate: {
          all_of: [{ id: 'no-tests-modified' }, { id: 'my-custom-predicate' }],
        },
      }),
    ).not.toThrow()
  })
})

describe('predicate registry baseline', () => {
  it('ships the framework predicate ids', () => {
    const ids = listPredicateIds()
    expect(ids).toEqual(
      expect.arrayContaining([
        'tests-pass',
        'regex-in-file',
        'no-tests-modified',
        'no-files-outside-target',
        'function-exists',
        'lint-clean',
        'typecheck-clean',
        'file-unchanged',
      ]),
    )
  })

  it('resetPredicateRegistryToBaseline reinstates the baseline ids', () => {
    // eslint-disable-next-line @typescript-eslint/require-await -- predicate signature requires `() => Promise<PredicateResult>`
    registerPredicate('temporary', async () => ({ passed: true }))
    expect(listPredicateIds()).toContain('temporary')

    resetPredicateRegistryToBaseline()
    expect(listPredicateIds()).not.toContain('temporary')
    expect(listPredicateIds()).toContain('tests-pass')
  })
})
