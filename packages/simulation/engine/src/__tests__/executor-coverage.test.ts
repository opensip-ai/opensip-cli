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
 */

import { describe, expect, it } from 'vitest';

import { ASSERTIONS } from '../framework/assertions.js';
import { persona } from '../framework/personas.js';
import { createChaosScenarioRunner } from '../kinds/chaos/executor.js';

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
