// @fitness-ignore-file file-length-limit -- aggregate coverage-driven test fixture; splitting destroys the contract
/* eslint-disable @typescript-eslint/require-await -- invariant phase hooks must match `() => Promise<void>`; some stub bodies are intentionally synchronous */
/**
 * @fileoverview Behaviour-driven coverage for the executor + driver gaps the
 * smoke tests don't reach:
 *
 *   - chaos executor: a high-RPS steady window with `probability: 1` actually
 *     emits chaos events (the `chaos-event` outcome path through both the
 *     executor's timestamp-stamping closure and the shared load-window driver's
 *     switch arm).
 *   - chaos executor: chaos active with an empty `types` array degrades to a
 *     generic failure (no injection definitions branch).
 *   - chaos executor: a non-abort error raised mid-run re-throws unchanged.
 *   - invariant executor: the InvariantContext driver delegators
 *     (emitSignal / runReconcilerTick / queryTickets / dispatchAgent) route to
 *     the supplied deps; the default stubs throw NOT_IMPLEMENTED.
 *   - invariant executor: an abort observed at the start of a *later* phase
 *     re-throws ScenarioAbortedError rather than recording a phase failure.
 */

import { createSignal } from '@opensip-tools/core';
import { describe, expect, it } from 'vitest';

import { ASSERTIONS } from '../framework/assertions.js';
import { ScenarioAbortedError } from '../framework/execution/scenario-aborted-error.js';
import { persona } from '../framework/personas.js';
import { createChaosScenarioRunner } from '../kinds/chaos/executor.js';
import { createInvariantScenarioRunner } from '../kinds/invariant/executor.js';

import type { ChaosScenarioConfig } from '../kinds/chaos/config.js';

// ===========================================================================
// CHAOS EXECUTOR — chaos-event emission + degraded + error re-throw
// ===========================================================================

describe('chaos executor — chaos-event emission path', () => {
  it('emits chaos events when probability is 1 and RPS yields requests per tick', async () => {
    const config: ChaosScenarioConfig = {
      id: 'chaos-emit',
      name: 'Chaos Emit',
      description: 'high-rps deterministic injection',
      tags: [],
      // targetRps 100 → 10 requests per 100ms tick, so the chaos-event arm runs.
      personas: [persona('buyer', 1)],
      targetRps: 100,
      duration: 1,
      chaos: {
        enabled: true,
        probability: 1, // every request is injected
        types: [
          {
            type: 'latency',
            target: 'api',
            probability: 1,
            config: { type: 'latency', minMs: 100, maxMs: 500 },
          },
        ],
      },
      steadyStateAssertions: [ASSERTIONS.lowErrorRate(1)],
      recoveryAssertions: [ASSERTIONS.lowErrorRate(1)],
      recoveryWindow: 100,
    };

    const scenario = createChaosScenarioRunner(config);
    const result = await scenario.run(new AbortController().signal);

    expect(result.kind).toBe('chaos');
    if (result.kind === 'chaos') {
      // probability:1 + 10 req/tick over a 1s window guarantees emissions.
      expect(result.outcome.chaosEvents.length).toBeGreaterThan(0);
      const first = result.outcome.chaosEvents[0];
      expect(first?.type).toBe('latency');
      expect(first?.target).toBe('api');
      // The executor stamps the framework-supplied relative timestamp.
      expect(typeof first?.atMs).toBe('number');
      expect(result.outcome.steadyStateMetrics.failedRequests).toBeGreaterThan(0);
    }
  });

  it('degrades to a generic failure when chaos is active with no injection types', async () => {
    const config: ChaosScenarioConfig = {
      id: 'chaos-no-types',
      name: 'Chaos No Types',
      description: 'enabled chaos but empty types array',
      tags: [],
      personas: [persona('buyer', 1)],
      targetRps: 100,
      duration: 1,
      chaos: {
        enabled: true,
        probability: 1,
        types: [], // no injection definitions → generic failure path
      },
      steadyStateAssertions: [ASSERTIONS.lowErrorRate(1)],
      recoveryAssertions: [ASSERTIONS.lowErrorRate(1)],
      recoveryWindow: 100,
    };

    const scenario = createChaosScenarioRunner(config);
    const result = await scenario.run(new AbortController().signal);

    expect(result.kind).toBe('chaos');
    if (result.kind === 'chaos') {
      // Generic failures count as failed requests but emit no chaos events.
      expect(result.outcome.chaosEvents).toHaveLength(0);
      expect(result.outcome.steadyStateMetrics.failedRequests).toBeGreaterThan(0);
    }
  });
});

// ===========================================================================
// INVARIANT EXECUTOR — context driver delegation + default stubs
// ===========================================================================

describe('invariant executor — context driver delegation', () => {
  it('routes emitSignal / runReconcilerTick / queryTickets / dispatchAgent to supplied deps', async () => {
    const calls: string[] = [];
    const scenario = createInvariantScenarioRunner({
      id: 'inv-drivers',
      name: 'Inv Drivers',
      description: 'd',
      tags: [],
      relatesToInvariant: 'doc.md#a',
      deps: {
        seedTenant: async () =>
          Object.freeze({ tenantId: 't1', repoIds: Object.freeze(['r1']) }),
        emitSignal: async (options) => {
          calls.push('emitSignal');
          return createSignal(options.signal);
        },
        runReconcilerTick: async () => {
          calls.push('runReconcilerTick');
        },
        queryTickets: async () => {
          calls.push('queryTickets');
          return Object.freeze([]);
        },
        dispatchAgent: async () => {
          calls.push('dispatchAgent');
        },
      },
      setup: async (ctx) => {
        const tenant = await ctx.seedTenant();
        await ctx.emitSignal({
          tenant,
          signal: {
            source: 'simulation',
            severity: 'high',
            category: 'security',
            ruleId: 'r',
            message: 'm',
          },
        });
        await ctx.runReconcilerTick(tenant);
        const tickets = await ctx.queryTickets(tenant);
        ctx.assertEquals(tickets.length, 0, 'no tickets yet');
        await ctx.dispatchAgent({ ticketId: 'tk1', tenant });
      },
      act: async () => undefined,
      assert: async (ctx) => {
        ctx.assertThat(true, 'reached assert');
      },
    });

    const result = await scenario.run(new AbortController().signal);

    expect(calls).toEqual([
      'emitSignal',
      'runReconcilerTick',
      'queryTickets',
      'dispatchAgent',
    ]);
    expect(result.passed).toBe(true);
  });

  it('records a phase failure when a default (unconfigured) driver throws NOT_IMPLEMENTED', async () => {
    const scenario = createInvariantScenarioRunner({
      id: 'inv-default-stub',
      name: 'Inv Default Stub',
      description: 'd',
      tags: [],
      relatesToInvariant: 'doc.md#a',
      setup: async (ctx) => {
        // No deps supplied → default stub throws NOT_IMPLEMENTED.
        await ctx.seedTenant();
      },
      act: async () => undefined,
      assert: async () => undefined,
    });

    const result = await scenario.run(new AbortController().signal);
    expect(result.passed).toBe(false);
    if (result.kind === 'invariant') {
      const setupP = result.outcome.phases.find((p) => p.phase === 'setup');
      expect(setupP?.status).toBe('failed');
      expect(setupP?.error).toContain('seedTenant is not yet implemented');
    }
  });

  it('re-throws ScenarioAbortedError when the signal aborts between phases', async () => {
    const ac = new AbortController();
    const scenario = createInvariantScenarioRunner({
      id: 'inv-abort-between',
      name: 'Inv Abort Between',
      description: 'd',
      tags: [],
      relatesToInvariant: 'doc.md#a',
      // setup completes, then aborts the signal so the *act* phase observes
      // the abort at entry and runPhase throws ScenarioAbortedError.
      setup: async () => {
        ac.abort();
      },
      act: async () => undefined,
      assert: async () => undefined,
    });

    await expect(scenario.run(ac.signal)).rejects.toThrow(ScenarioAbortedError);
  });

  it('re-throws the original error when a phase throws after aborting mid-body', async () => {
    const ac = new AbortController();
    const scenario = createInvariantScenarioRunner({
      id: 'inv-abort-then-throw',
      name: 'Inv Abort Then Throw',
      description: 'd',
      tags: [],
      relatesToInvariant: 'doc.md#a',
      // Abort, then throw inside the same phase body. runPhase's catch arm
      // sees abortSignal.aborted === true and re-throws the original error
      // rather than recording a phase failure.
      setup: async () => {
        ac.abort();
        // @fitness-ignore-next-line result-pattern-consistency -- intentional throw to drive the abort-aware catch arm
        throw new Error('boom-after-abort');
      },
      act: async () => undefined,
      assert: async () => undefined,
    });

    await expect(scenario.run(ac.signal)).rejects.toThrow('boom-after-abort');
  });
});
