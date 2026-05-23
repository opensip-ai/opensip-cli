/**
 * @fileoverview Edge-case tests for the four `defineXxxScenario` validators.
 *
 * The "happy path" tests for each kind live in their dedicated test file.
 * This file fills coverage gaps:
 *   - Name-collision detection in `validateDuplicates`
 *   - The `*ScenarioWithoutRegistration` happy paths (no auto-registration)
 *   - Each kind's full set of required-field validation paths
 */

import { afterEach, describe, expect, it } from 'vitest';

import { ASSERTIONS } from '../framework/assertions.js';
import { persona } from '../framework/personas.js';
import { clearScenarioRegistry, getScenario } from '../framework/registry.js';
import {
  defineChaosScenario,
  defineChaosScenarioWithoutRegistration,
  validateChaosScenarioConfig,
} from '../kinds/chaos/define.js';
import {
  defineFixEvaluationScenario,
  defineFixEvaluationScenarioWithoutRegistration,
  validateFixEvaluationScenarioConfig,
  type FixEvaluationScenarioConfig,
} from '../kinds/fix-evaluation/define.js';
import { resetPredicateRegistryToBaseline } from '../kinds/fix-evaluation/predicates/index.js';
import {
  defineInvariantScenario,
  defineInvariantScenarioWithoutRegistration,
  validateInvariantScenarioConfig,
} from '../kinds/invariant/define.js';
import {
  defineLoadScenario,
  validateLoadScenarioConfig,
} from '../kinds/load/define.js';

import type { ChaosConfig } from '../types/base-types.js';

// Async no-op stubs reused across the invariant scenario tests below.
// Inlining them avoids @typescript-eslint/require-await on each call site.
// eslint-disable-next-line @typescript-eslint/require-await -- intentional async no-op stub for scenario phase hooks
const noopAsync = async (): Promise<void> => undefined;

const baseChaos: ChaosConfig = {
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
};

const baseFixEvalConfig: Omit<FixEvaluationScenarioConfig, 'id' | 'name' | 'predicate'> = {
  description: 'desc',
  tags: ['security'],
  category: 'security',
  score: 5,
  criteriaMet: [],
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
};

afterEach(() => {
  clearScenarioRegistry();
  resetPredicateRegistryToBaseline();
});

// =============================================================================
// LOAD KIND
// =============================================================================

describe('load kind — validation edges', () => {
  it('rejects when the same id is already registered', () => {
    defineLoadScenario({
      id: 'dup-load',
      name: 'Dup Load',
      description: 'first',
      tags: [],
      personas: [persona('buyer', 1)],
      duration: 1,
      assertions: [ASSERTIONS.lowErrorRate()],
    });

    expect(() =>
      validateLoadScenarioConfig({
        id: 'dup-load',
        name: 'Other Name',
        description: 'second',
        tags: [],
        personas: [persona('buyer', 1)],
        duration: 1,
        assertions: [ASSERTIONS.lowErrorRate()],
      }),
    ).toThrow(/already registered/);
  });

  it('rejects when the same name is already registered', () => {
    defineLoadScenario({
      id: 'name-load-1',
      name: 'Shared Name',
      description: 'first',
      tags: [],
      personas: [persona('buyer', 1)],
      duration: 1,
      assertions: [ASSERTIONS.lowErrorRate()],
    });

    expect(() =>
      validateLoadScenarioConfig({
        id: 'name-load-2',
        name: 'Shared Name',
        description: 'second',
        tags: [],
        personas: [persona('buyer', 1)],
        duration: 1,
        assertions: [ASSERTIONS.lowErrorRate()],
      }),
    ).toThrow(/already registered/);
  });

  it('rejects when rampUp exceeds duration', () => {
    expect(() =>
      validateLoadScenarioConfig({
        id: 'ramp-bad',
        name: 'Ramp Bad',
        description: 'd',
        tags: [],
        personas: [persona('buyer', 1)],
        duration: 1,
        rampUp: 5,
        assertions: [ASSERTIONS.lowErrorRate()],
      }),
    ).toThrow(/rampUp cannot exceed duration/);
  });

  it('rejects when rampUp is negative', () => {
    expect(() =>
      validateLoadScenarioConfig({
        id: 'ramp-neg',
        name: 'Ramp Neg',
        description: 'd',
        tags: [],
        personas: [persona('buyer', 1)],
        duration: 1,
        rampUp: -1,
        assertions: [ASSERTIONS.lowErrorRate()],
      }),
    ).toThrow(/rampUp must be a non-negative number/);
  });

  it('rejects when persona count is non-positive', () => {
    expect(() =>
      validateLoadScenarioConfig({
        id: 'p-bad',
        name: 'Persona Bad',
        description: 'd',
        tags: [],
        personas: [{ personaId: 'x', count: 0, spawnRate: 1, actions: ['random'] }],
        duration: 1,
        assertions: [ASSERTIONS.lowErrorRate()],
      }),
    ).toThrow(/count must be a positive number/);
  });

  it('rejects when name is empty', () => {
    expect(() =>
      validateLoadScenarioConfig({
        id: 'no-name',
        name: '',
        description: 'd',
        tags: [],
        personas: [persona('buyer', 1)],
        duration: 1,
        assertions: [ASSERTIONS.lowErrorRate()],
      }),
    ).toThrow(/name is required/);
  });

  it('rejects when description is whitespace-only', () => {
    expect(() =>
      validateLoadScenarioConfig({
        id: 'no-desc',
        name: 'name',
        description: '   ',
        tags: [],
        personas: [persona('buyer', 1)],
        duration: 1,
        assertions: [ASSERTIONS.lowErrorRate()],
      }),
    ).toThrow(/description is required/);
  });

  it('rejects when assertions list is empty', () => {
    expect(() =>
      validateLoadScenarioConfig({
        id: 'no-assertions',
        name: 'name',
        description: 'd',
        tags: [],
        personas: [persona('buyer', 1)],
        duration: 1,
        assertions: [],
      }),
    ).toThrow(/at least one assertion is required/);
  });

  it('rejects when duration is zero', () => {
    expect(() =>
      validateLoadScenarioConfig({
        id: 'no-dur',
        name: 'name',
        description: 'd',
        tags: [],
        personas: [persona('buyer', 1)],
        duration: 0,
        assertions: [ASSERTIONS.lowErrorRate()],
      }),
    ).toThrow(/duration must be a positive number/);
  });
});

// =============================================================================
// CHAOS KIND
// =============================================================================

describe('chaos kind — validation edges', () => {
  it('rejects when the same id is already registered (validateDuplicates)', () => {
    defineChaosScenario({
      id: 'dup-chaos',
      name: 'Dup Chaos',
      description: 'first',
      tags: [],
      personas: [persona('buyer', 1)],
      duration: 1,
      chaos: baseChaos,
      steadyStateAssertions: [ASSERTIONS.lowErrorRate(1)],
      recoveryAssertions: [ASSERTIONS.lowErrorRate(1)],
      recoveryWindow: 100,
    });

    expect(() =>
      validateChaosScenarioConfig({
        id: 'dup-chaos',
        name: 'Other Name',
        description: 'second',
        tags: [],
        personas: [persona('buyer', 1)],
        duration: 1,
        chaos: baseChaos,
        steadyStateAssertions: [ASSERTIONS.lowErrorRate(1)],
        recoveryAssertions: [ASSERTIONS.lowErrorRate(1)],
        recoveryWindow: 100,
      }),
    ).toThrow(/already registered/);
  });

  it('rejects when the same name is already registered (validateDuplicates)', () => {
    defineChaosScenario({
      id: 'chaos-n-1',
      name: 'Shared Chaos Name',
      description: 'first',
      tags: [],
      personas: [persona('buyer', 1)],
      duration: 1,
      chaos: baseChaos,
      steadyStateAssertions: [ASSERTIONS.lowErrorRate(1)],
      recoveryAssertions: [ASSERTIONS.lowErrorRate(1)],
      recoveryWindow: 100,
    });

    expect(() =>
      validateChaosScenarioConfig({
        id: 'chaos-n-2',
        name: 'Shared Chaos Name',
        description: 'second',
        tags: [],
        personas: [persona('buyer', 1)],
        duration: 1,
        chaos: baseChaos,
        steadyStateAssertions: [ASSERTIONS.lowErrorRate(1)],
        recoveryAssertions: [ASSERTIONS.lowErrorRate(1)],
        recoveryWindow: 100,
      }),
    ).toThrow(/already registered/);
  });

  it('defineChaosScenarioWithoutRegistration does NOT register the scenario', () => {
    const scenario = defineChaosScenarioWithoutRegistration({
      id: 'chaos-noreg',
      name: 'Chaos No Reg',
      description: 'd',
      tags: [],
      personas: [persona('buyer', 1)],
      duration: 1,
      chaos: baseChaos,
      steadyStateAssertions: [ASSERTIONS.lowErrorRate(1)],
      recoveryAssertions: [ASSERTIONS.lowErrorRate(1)],
      recoveryWindow: 100,
    });
    expect(scenario.kind).toBe('chaos');
    expect(getScenario('chaos-noreg')).toBeUndefined();
  });

  it('defineChaosScenarioWithoutRegistration still requires an id', () => {
    expect(() =>
      defineChaosScenarioWithoutRegistration({
        id: '',
        name: 'x',
        description: 'd',
        tags: [],
        personas: [persona('buyer', 1)],
        duration: 1,
        chaos: baseChaos,
        steadyStateAssertions: [ASSERTIONS.lowErrorRate(1)],
        recoveryAssertions: [ASSERTIONS.lowErrorRate(1)],
        recoveryWindow: 100,
      }),
    ).toThrow(/id is required/);
  });

  it('rejects when chaos.types is not an array', () => {
    expect(() =>
      validateChaosScenarioConfig({
        id: 'chaos-bad-types',
        name: 'Bad Types',
        description: 'd',
        tags: [],
        personas: [persona('buyer', 1)],
        duration: 1,
        // @ts-expect-error -- intentionally invalid for validation test
        chaos: { ...baseChaos, types: 'nope' },
        steadyStateAssertions: [ASSERTIONS.lowErrorRate(1)],
        recoveryAssertions: [ASSERTIONS.lowErrorRate(1)],
        recoveryWindow: 100,
      }),
    ).toThrow(/chaos.types must be an array/);
  });

  it('rejects when chaos config is missing', () => {
    expect(() =>
      validateChaosScenarioConfig({
        id: 'chaos-missing',
        name: 'Missing',
        description: 'd',
        tags: [],
        personas: [persona('buyer', 1)],
        duration: 1,
        // @ts-expect-error -- intentionally missing chaos
        chaos: undefined,
        steadyStateAssertions: [ASSERTIONS.lowErrorRate(1)],
        recoveryAssertions: [ASSERTIONS.lowErrorRate(1)],
        recoveryWindow: 100,
      }),
    ).toThrow(/chaos config is required/);
  });

  it('rejects when chaos.enabled is not a boolean', () => {
    expect(() =>
      validateChaosScenarioConfig({
        id: 'chaos-enabled-bad',
        name: 'Bad Enabled',
        description: 'd',
        tags: [],
        personas: [persona('buyer', 1)],
        duration: 1,
        // @ts-expect-error -- intentionally invalid type
        chaos: { ...baseChaos, enabled: 'yes' },
        steadyStateAssertions: [ASSERTIONS.lowErrorRate(1)],
        recoveryAssertions: [ASSERTIONS.lowErrorRate(1)],
        recoveryWindow: 100,
      }),
    ).toThrow(/chaos.enabled must be boolean/);
  });

  it('rejects when recoveryWindow is negative', () => {
    expect(() =>
      validateChaosScenarioConfig({
        id: 'chaos-rw-neg',
        name: 'Bad RW',
        description: 'd',
        tags: [],
        personas: [persona('buyer', 1)],
        duration: 1,
        chaos: baseChaos,
        steadyStateAssertions: [ASSERTIONS.lowErrorRate(1)],
        recoveryAssertions: [ASSERTIONS.lowErrorRate(1)],
        recoveryWindow: -10,
      }),
    ).toThrow(/recoveryWindow must be a non-negative/);
  });

  it('rejects empty steady-state assertions', () => {
    expect(() =>
      validateChaosScenarioConfig({
        id: 'chaos-no-steady',
        name: 'No Steady',
        description: 'd',
        tags: [],
        personas: [persona('buyer', 1)],
        duration: 1,
        chaos: baseChaos,
        steadyStateAssertions: [],
        recoveryAssertions: [ASSERTIONS.lowErrorRate(1)],
        recoveryWindow: 100,
      }),
    ).toThrow(/steady-state assertion is required/);
  });

  it('rejects when name is empty', () => {
    expect(() =>
      validateChaosScenarioConfig({
        id: 'chaos-noname',
        name: '',
        description: 'd',
        tags: [],
        personas: [persona('buyer', 1)],
        duration: 1,
        chaos: baseChaos,
        steadyStateAssertions: [ASSERTIONS.lowErrorRate(1)],
        recoveryAssertions: [ASSERTIONS.lowErrorRate(1)],
        recoveryWindow: 100,
      }),
    ).toThrow(/name is required/);
  });
});

// =============================================================================
// INVARIANT KIND
// =============================================================================

describe('invariant kind — validation edges', () => {
  it('rejects duplicate id (validateDuplicates branch)', () => {
    defineInvariantScenario({
      id: 'dup-inv',
      name: 'Dup Inv',
      description: 'd',
      tags: [],
      relatesToInvariant: 'doc.md#a',
      setup: noopAsync,
      act: noopAsync,
      assert: noopAsync,
    });

    expect(() =>
      validateInvariantScenarioConfig({
        id: 'dup-inv',
        name: 'Different Name',
        description: 'd',
        tags: [],
        relatesToInvariant: 'doc.md#a',
        setup: noopAsync,
        act: noopAsync,
        assert: noopAsync,
      }),
    ).toThrow(/already registered/);
  });

  it('rejects duplicate name (validateDuplicates branch)', () => {
    defineInvariantScenario({
      id: 'inv-n-1',
      name: 'Shared Inv Name',
      description: 'd',
      tags: [],
      relatesToInvariant: 'doc.md#a',
      setup: noopAsync,
      act: noopAsync,
      assert: noopAsync,
    });

    expect(() =>
      validateInvariantScenarioConfig({
        id: 'inv-n-2',
        name: 'Shared Inv Name',
        description: 'd',
        tags: [],
        relatesToInvariant: 'doc.md#a',
        setup: noopAsync,
        act: noopAsync,
        assert: noopAsync,
      }),
    ).toThrow(/already registered/);
  });

  it('defineInvariantScenarioWithoutRegistration produces a runner that does not register', () => {
    const scenario = defineInvariantScenarioWithoutRegistration({
      id: 'inv-noreg',
      name: 'Inv No Reg',
      description: 'd',
      tags: [],
      relatesToInvariant: 'doc.md#a',
      setup: noopAsync,
      act: noopAsync,
      assert: noopAsync,
    });
    expect(scenario.kind).toBe('invariant');
    expect(getScenario('inv-noreg')).toBeUndefined();
  });

  it('defineInvariantScenarioWithoutRegistration still requires id', () => {
    expect(() =>
      defineInvariantScenarioWithoutRegistration({
        id: '',
        name: 'x',
        description: 'd',
        tags: [],
        relatesToInvariant: 'doc.md#a',
        setup: noopAsync,
        act: noopAsync,
        assert: noopAsync,
      }),
    ).toThrow(/id is required/);
  });

  it('rejects setup that is not a function', () => {
    expect(() =>
      validateInvariantScenarioConfig({
        id: 'inv-no-setup',
        name: 'No Setup',
        description: 'd',
        tags: [],
        relatesToInvariant: 'doc.md#a',
        // @ts-expect-error -- intentional invalid
        setup: 'not-a-function',
        act: noopAsync,
        assert: noopAsync,
      }),
    ).toThrow(/setup must be an async function/);
  });

  it('rejects when name is empty', () => {
    expect(() =>
      validateInvariantScenarioConfig({
        id: 'inv-noname',
        name: '',
        description: 'd',
        tags: [],
        relatesToInvariant: 'doc.md#a',
        setup: noopAsync,
        act: noopAsync,
        assert: noopAsync,
      }),
    ).toThrow(/name is required/);
  });

  it('rejects when description is whitespace-only', () => {
    expect(() =>
      validateInvariantScenarioConfig({
        id: 'inv-nodesc',
        name: 'name',
        description: '   ',
        tags: [],
        relatesToInvariant: 'doc.md#a',
        setup: noopAsync,
        act: noopAsync,
        assert: noopAsync,
      }),
    ).toThrow(/description is required/);
  });

  it('rejects act that is not a function', () => {
    expect(() =>
      validateInvariantScenarioConfig({
        id: 'inv-no-act',
        name: 'No Act',
        description: 'd',
        tags: [],
        relatesToInvariant: 'doc.md#a',
        setup: noopAsync,
        // @ts-expect-error -- intentional invalid
        act: null,
        assert: noopAsync,
      }),
    ).toThrow(/act must be an async function/);
  });

  it('rejects assert that is not a function', () => {
    expect(() =>
      validateInvariantScenarioConfig({
        id: 'inv-no-assert',
        name: 'No Assert',
        description: 'd',
        tags: [],
        relatesToInvariant: 'doc.md#a',
        setup: noopAsync,
        act: noopAsync,
        // @ts-expect-error -- intentional invalid
        assert: 42,
      }),
    ).toThrow(/assert must be an async function/);
  });
});

// =============================================================================
// FIX-EVALUATION KIND
// =============================================================================

describe('fix-evaluation kind — validation edges', () => {
  it('rejects duplicate id', () => {
    defineFixEvaluationScenario({
      ...baseFixEvalConfig,
      id: 'dup-fe',
      name: 'Dup FE',
      predicate: { all_of: [{ id: 'tests-pass' }, { id: 'no-tests-modified' }] },
    });

    expect(() =>
      validateFixEvaluationScenarioConfig({
        ...baseFixEvalConfig,
        id: 'dup-fe',
        name: 'Different Name',
        predicate: { all_of: [{ id: 'tests-pass' }, { id: 'no-tests-modified' }] },
      }),
    ).toThrow(/already registered/);
  });

  it('rejects duplicate name', () => {
    defineFixEvaluationScenario({
      ...baseFixEvalConfig,
      id: 'fe-n-1',
      name: 'Shared FE Name',
      predicate: { all_of: [{ id: 'tests-pass' }, { id: 'no-tests-modified' }] },
    });

    expect(() =>
      validateFixEvaluationScenarioConfig({
        ...baseFixEvalConfig,
        id: 'fe-n-2',
        name: 'Shared FE Name',
        predicate: { all_of: [{ id: 'tests-pass' }, { id: 'no-tests-modified' }] },
      }),
    ).toThrow(/already registered/);
  });

  it('defineFixEvaluationScenarioWithoutRegistration does not register', () => {
    const scenario = defineFixEvaluationScenarioWithoutRegistration({
      ...baseFixEvalConfig,
      id: 'fe-noreg',
      name: 'FE No Reg',
      predicate: { all_of: [{ id: 'tests-pass' }, { id: 'no-tests-modified' }] },
    });
    expect(scenario.kind).toBe('fix-evaluation');
    expect(getScenario('fe-noreg')).toBeUndefined();
  });

  it('defineFixEvaluationScenarioWithoutRegistration still requires id', () => {
    expect(() =>
      defineFixEvaluationScenarioWithoutRegistration({
        ...baseFixEvalConfig,
        id: '',
        name: 'x',
        predicate: { all_of: [{ id: 'tests-pass' }, { id: 'no-tests-modified' }] },
      }),
    ).toThrow(/id is required/);
  });

  it('rejects predicate-match without a predicate', () => {
    expect(() =>
      validateFixEvaluationScenarioConfig({
        ...baseFixEvalConfig,
        id: 'fe-no-pred',
        name: 'No Pred',
        // predicate intentionally omitted
      }),
    ).toThrow(/predicate is required when judgmentMode/);
  });

  it('rejects predicate node that declares both all_of and any_of', () => {
    expect(() =>
      validateFixEvaluationScenarioConfig({
        ...baseFixEvalConfig,
        id: 'fe-both',
        name: 'Both',
        predicate: {
          all_of: [{ id: 'tests-pass' }],
          any_of: [{ id: 'no-tests-modified' }],
        },
      }),
    ).toThrow(/either all_of or any_of, not both/);
  });

  it('rejects a leaf with a non-string id', () => {
    expect(() =>
      validateFixEvaluationScenarioConfig({
        ...baseFixEvalConfig,
        id: 'fe-bad-leaf',
        name: 'Bad Leaf',
        predicate: {
          // @ts-expect-error -- intentional invalid leaf
          all_of: [{ id: 42 }, { id: 'no-tests-modified' }],
        },
      }),
    ).toThrow(/predicate leaf must have a string id/);
  });

  it('rejects when name is empty', () => {
    expect(() =>
      validateFixEvaluationScenarioConfig({
        ...baseFixEvalConfig,
        id: 'fe-noname',
        name: '',
        predicate: { all_of: [{ id: 'tests-pass' }, { id: 'no-tests-modified' }] },
      }),
    ).toThrow(/name is required/);
  });

  it('rejects when description is whitespace-only', () => {
    expect(() =>
      validateFixEvaluationScenarioConfig({
        ...baseFixEvalConfig,
        description: '   ',
        id: 'fe-nodesc',
        name: 'name',
        predicate: { all_of: [{ id: 'tests-pass' }, { id: 'no-tests-modified' }] },
      }),
    ).toThrow(/description is required/);
  });

  it('walks any_of branches', () => {
    expect(() =>
      validateFixEvaluationScenarioConfig({
        ...baseFixEvalConfig,
        id: 'fe-anyof',
        name: 'AnyOf',
        predicate: {
          any_of: [
            { id: 'tests-pass' },
            { id: 'no-tests-modified' }, // gaming-defense leaf
          ],
        },
      }),
    ).not.toThrow();
  });

  it('walks deep nested predicate trees', () => {
    expect(() =>
      validateFixEvaluationScenarioConfig({
        ...baseFixEvalConfig,
        id: 'fe-deep',
        name: 'Deep',
        predicate: {
          all_of: [
            {
              any_of: [{ id: 'tests-pass' }, { id: 'no-tests-modified' }],
            },
          ],
        },
      }),
    ).not.toThrow();
  });

  it('rejects when signal payload is missing', () => {
    expect(() =>
      validateFixEvaluationScenarioConfig({
        ...baseFixEvalConfig,
        id: 'fe-no-sig',
        name: 'No Sig',
        // @ts-expect-error -- intentional missing
        signal: undefined,
        predicate: { all_of: [{ id: 'tests-pass' }, { id: 'no-tests-modified' }] },
      }),
    ).toThrow(/signal payload is required/);
  });
});
