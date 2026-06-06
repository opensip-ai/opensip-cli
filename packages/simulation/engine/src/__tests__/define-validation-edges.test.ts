// @fitness-ignore-file file-length-limit -- aggregate coverage-driven test fixture; splitting destroys the contract
/**
 * @fileoverview Edge-case tests for the `defineXxxScenario` validators.
 *
 * The "happy path" tests for each kind live in their dedicated test file.
 * This file fills coverage gaps:
 *   - Name-collision detection at registration time
 *   - Each kind's full set of required-field validation paths
 *
 * As of Phase 6 Task 6.1, `defineX` no longer auto-registers — it
 * returns the scenario object only. Uniqueness against an existing
 * scenario registry is checked at registration time
 * (`currentScenarioRegistry().register(scenario)`), not at definition time.
 */

import { enterScope } from '@opensip-tools/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ASSERTIONS } from '../framework/assertions.js';
import { persona } from '../framework/personas.js';
import { clearScenarioRegistry, currentScenarioRegistry } from '../framework/registry.js';
import {
  defineChaosScenario,
  validateChaosScenarioConfig,
} from '../kinds/chaos/define.js';
import {
  defineLoadScenario,
  validateLoadScenarioConfig,
} from '../kinds/load/define.js';

import { makeSimTestScope } from './test-utils/with-sim-scope.js';

import type { ChaosConfig } from '../types/base-types.js';

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

beforeEach(() => {
  // Item 1: scenarioRegistry is per-RunScope. Each test gets a fresh
  // scope with an empty scenario registry; enterScope (enterWith)
  // propagates it for the test body's async context.
  enterScope(makeSimTestScope());
});

afterEach(() => {
  clearScenarioRegistry();
});

// =============================================================================
// LOAD KIND
// =============================================================================

describe('load kind — validation edges', () => {
  it('registry rejects a name-collision (different id, same name)', () => {
    const first = defineLoadScenario({
      id: 'name-load-1',
      name: 'Shared Name',
      description: 'first',
      tags: [],
      personas: [persona('buyer', 1)],
      duration: 1,
      assertions: [ASSERTIONS.lowErrorRate()],
    });
    currentScenarioRegistry().register(first);

    const second = defineLoadScenario({
      id: 'name-load-2',
      name: 'Shared Name',
      description: 'second',
      tags: [],
      personas: [persona('buyer', 1)],
      duration: 1,
      assertions: [ASSERTIONS.lowErrorRate()],
    });
    expect(() => currentScenarioRegistry().register(second)).toThrow(/name collision/);
  });

  it('registry silent-skips a duplicate id (same id, same scenario)', () => {
    const scenario = defineLoadScenario({
      id: 'dup-load',
      name: 'Dup Load',
      description: 'first',
      tags: [],
      personas: [persona('buyer', 1)],
      duration: 1,
      assertions: [ASSERTIONS.lowErrorRate()],
    });
    currentScenarioRegistry().register(scenario);
    // Re-registering with the same id is a no-op under the
    // silent-skip duplicate policy.
    expect(() => currentScenarioRegistry().register(scenario)).not.toThrow();
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

  it('rejects when personas is empty', () => {
    expect(() =>
      validateLoadScenarioConfig({
        id: 'no-personas',
        name: 'No Personas',
        description: 'd',
        tags: [],
        personas: [],
        duration: 1,
        assertions: [ASSERTIONS.lowErrorRate()],
      }),
    ).toThrow(/at least one persona is required/);
  });

  it('rejects when a persona is missing its personaId', () => {
    expect(() =>
      validateLoadScenarioConfig({
        id: 'p-no-id',
        name: 'Persona No Id',
        description: 'd',
        tags: [],
        // personaId intentionally blank to trip the required-field path
        personas: [{ personaId: '', count: 1, spawnRate: 1, actions: ['random'] }],
        duration: 1,
        assertions: [ASSERTIONS.lowErrorRate()],
      }),
    ).toThrow(/personaId is required/);
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
  it('registry rejects a name-collision for chaos scenarios', () => {
    const first = defineChaosScenario({
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
    currentScenarioRegistry().register(first);

    const second = defineChaosScenario({
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
    });
    expect(() => currentScenarioRegistry().register(second)).toThrow(/name collision/);
  });

  it('defineChaosScenario does not auto-register (Phase 6 contract)', () => {
    const scenario = defineChaosScenario({
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
    expect(currentScenarioRegistry().get('chaos-noreg')).toBeUndefined();
  });

  it('defineChaosScenario still requires an id', () => {
    expect(() =>
      defineChaosScenario({
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
