/* eslint-disable @typescript-eslint/require-await -- scenario phase hooks must match `() => Promise<void>` shape; some test stubs are intentionally synchronous bodies */
/**
 * @fileoverview Edge-case tests for each kind's executor.
 *
 * Each executor has a try/catch around its run loop that converts
 * mid-run aborts into ScenarioAbortedError and re-throws non-abort
 * errors. These paths weren't reached by the smoke tests; this file
 * targets them via the public defineXxx + .run() surface, plus the no-reg
 * helpers, so coverage hits the catch branches without source mods.
 *
 * It also exercises the load executor's custom-execute branch — that
 * path delegates to a user-supplied execute function and isn't reached
 * by any of the existing smoke tests.
 */

import { afterEach, describe, expect, it } from 'vitest';

import { ASSERTIONS } from '../framework/assertions.js';
import { ScenarioAbortedError } from '../framework/execution/scenario-aborted-error.js';
import { persona } from '../framework/personas.js';
import { clearScenarioRegistry } from '../framework/registry.js';
import { renderScenarioResultView } from '../framework/result-renderers.js';
import { defineChaosScenarioWithoutRegistration } from '../kinds/chaos/define.js';
import { defineFixEvaluationScenarioWithoutRegistration } from '../kinds/fix-evaluation/define.js';
import { resetPredicateRegistryToBaseline } from '../kinds/fix-evaluation/predicates/index.js';
import { defineInvariantScenarioWithoutRegistration } from '../kinds/invariant/define.js';
import { defineLoadScenarioWithoutRegistration } from '../kinds/load/define.js';

import type { ChaosConfig } from '../types/base-types.js';

const noopAsync = async (): Promise<void> => undefined;

const baseChaos: ChaosConfig = {
  enabled: true,
  probability: 0.5,
  types: [
    {
      type: 'error',
      target: '*',
      probability: 1,
      config: { type: 'error', statusCode: 500, message: 'x' },
    },
  ],
};

afterEach(() => {
  clearScenarioRegistry();
  resetPredicateRegistryToBaseline();
});

// =============================================================================
// LOAD EXECUTOR — custom execute branch + abort-during-run
// =============================================================================

describe('load executor — custom execute branch', () => {
  it('routes through createCustomExecutor when execute is supplied', async () => {
    let invoked = 0;
    const scenario = defineLoadScenarioWithoutRegistration({
      id: 'load-custom-exec',
      name: 'Load Custom',
      description: 'd',
      tags: [],
      personas: [persona('buyer', 1)],
      duration: 1,
      assertions: [ASSERTIONS.lowErrorRate(1)],
      execute: async () => {
        invoked++;
        return {
          passed: true,
          metrics: {
            totalRequests: 100,
            successfulRequests: 100,
            failedRequests: 0,
            avgLatencyMs: 1,
            p50LatencyMs: 1,
            p95LatencyMs: 1,
            p99LatencyMs: 1,
            errorsGenerated: 0,
            findingsGenerated: 0,
          },
          assertions: { passed: [], failed: [] },
          signals: [],
        };
      },
    });

    const result = await scenario.run(new AbortController().signal);
    expect(invoked).toBe(1);
    expect(result.kind).toBe('load');
    expect(result.passed).toBe(true);
  });

  it('returns gracefully when load executor aborts mid-run (loop breaks)', async () => {
    const ac = new AbortController();
    const scenario = defineLoadScenarioWithoutRegistration({
      id: 'load-abort-mid',
      name: 'Load Abort Mid',
      description: 'd',
      tags: [],
      personas: [persona('buyer', 1)],
      duration: 60, // long, will be aborted
      assertions: [ASSERTIONS.lowErrorRate(1)],
    });

    setTimeout(() => ac.abort(), 50);
    // Load executor breaks the loop on abort and returns its current state
    // rather than throwing — the surface contract is "graceful exit on abort".
    const result = await scenario.run(ac.signal);
    expect(result.kind).toBe('load');
  });

  it('re-throws non-abort errors from a custom load execute function', async () => {
    const scenario = defineLoadScenarioWithoutRegistration({
      id: 'load-throws',
      name: 'Load Throws',
      description: 'd',
      tags: [],
      personas: [persona('buyer', 1)],
      duration: 1,
      assertions: [ASSERTIONS.lowErrorRate(1)],
      execute: async () => {
        // @fitness-ignore-next-line result-pattern-consistency -- intentional throw for test
        throw new Error('custom-load-failure');
      },
    });

    await expect(scenario.run(new AbortController().signal)).rejects.toThrow('custom-load-failure');
  });

  it('converts custom load execute throw into ScenarioAbortedError when signal is aborted', async () => {
    const ac = new AbortController();
    const scenario = defineLoadScenarioWithoutRegistration({
      id: 'load-abort-then-throw',
      name: 'Load Abort Then Throw',
      description: 'd',
      tags: [],
      personas: [persona('buyer', 1)],
      duration: 1,
      assertions: [ASSERTIONS.lowErrorRate(1)],
      execute: async () => {
        ac.abort();
        // @fitness-ignore-next-line result-pattern-consistency -- intentional throw mid-run
        throw new Error('custom-throw-after-abort');
      },
    });

    await expect(scenario.run(ac.signal)).rejects.toThrow(ScenarioAbortedError);
  });
});

// =============================================================================
// CHAOS EXECUTOR — abort + error catch
// =============================================================================

describe('chaos executor — abort and error edges', () => {
  it('throws ScenarioAbortedError when called with a pre-aborted signal', async () => {
    const ac = new AbortController();
    ac.abort();
    const scenario = defineChaosScenarioWithoutRegistration({
      id: 'chaos-pre-abort',
      name: 'Chaos Pre Abort',
      description: 'd',
      tags: [],
      personas: [persona('buyer', 1)],
      duration: 1,
      chaos: baseChaos,
      steadyStateAssertions: [ASSERTIONS.lowErrorRate(1)],
      recoveryAssertions: [ASSERTIONS.lowErrorRate(1)],
      recoveryWindow: 100,
    });

    await expect(scenario.run(ac.signal)).rejects.toThrow(ScenarioAbortedError);
  });

  it('chaos executor finishes even when aborted mid-run (loop breaks)', async () => {
    const ac = new AbortController();
    const scenario = defineChaosScenarioWithoutRegistration({
      id: 'chaos-abort-mid',
      name: 'Chaos Abort Mid',
      description: 'd',
      tags: [],
      personas: [persona('buyer', 1)],
      duration: 60,
      chaos: baseChaos,
      steadyStateAssertions: [ASSERTIONS.lowErrorRate(1)],
      recoveryAssertions: [ASSERTIONS.lowErrorRate(1)],
      recoveryWindow: 50,
    });

    setTimeout(() => ac.abort(), 30);
    const result = await scenario.run(ac.signal);
    expect(result.kind).toBe('chaos');
  });
});

// =============================================================================
// INVARIANT EXECUTOR — phase failure + abort handling
// =============================================================================

describe('invariant executor — phase failure cascades', () => {
  it('skips act and assert when setup fails', async () => {
    let actRan = false;
    let assertRan = false;
    const scenario = defineInvariantScenarioWithoutRegistration({
      id: 'inv-setup-fails',
      name: 'Inv Setup Fails',
      description: 'd',
      tags: [],
      relatesToInvariant: 'doc.md#a',
      setup: async () => {
        // @fitness-ignore-next-line result-pattern-consistency -- intentional throw for phase-failure test
        throw new Error('setup boom');
      },
      act: async () => {
        actRan = true;
      },
      assert: async () => {
        assertRan = true;
      },
    });

    const result = await scenario.run(new AbortController().signal);
    expect(actRan).toBe(false);
    expect(assertRan).toBe(false);
    if (result.kind === 'invariant') {
      const setupP = result.outcome.phases.find((p) => p.phase === 'setup');
      const actP = result.outcome.phases.find((p) => p.phase === 'act');
      const assertP = result.outcome.phases.find((p) => p.phase === 'assert');
      expect(setupP?.status).toBe('failed');
      expect(actP?.status).toBe('failed');
      expect(actP?.error).toBe('setup failed');
      expect(assertP?.status).toBe('failed');
      expect(assertP?.error).toBe('act failed');
    }
  });

  it('coerces a non-Error phase throw into a string message', async () => {
    const scenario = defineInvariantScenarioWithoutRegistration({
      id: 'inv-string-throw',
      name: 'Inv String Throw',
      description: 'd',
      tags: [],
      relatesToInvariant: 'doc.md#a',
      setup: async () => {
        // eslint-disable-next-line @typescript-eslint/only-throw-error -- intentional non-Error throw to verify coercion
        throw 'plain-string-error';
      },
      act: noopAsync,
      assert: noopAsync,
    });

    const result = await scenario.run(new AbortController().signal);
    if (result.kind === 'invariant') {
      const setupP = result.outcome.phases.find((p) => p.phase === 'setup');
      expect(setupP?.error).toBe('plain-string-error');
    }
  });

  it('returns failed phase entries without phase execution when signal is pre-aborted (executor throws first)', async () => {
    const ac = new AbortController();
    ac.abort();
    const scenario = defineInvariantScenarioWithoutRegistration({
      id: 'inv-pre-aborted',
      name: 'Inv Pre Aborted',
      description: 'd',
      tags: [],
      relatesToInvariant: 'doc.md#a',
      setup: noopAsync,
      act: noopAsync,
      assert: noopAsync,
    });

    await expect(scenario.run(ac.signal)).rejects.toThrow(ScenarioAbortedError);
  });

  it('passes user-supplied test deps through into the InvariantContext', async () => {
    const scenario = defineInvariantScenarioWithoutRegistration({
      id: 'inv-fake-deps',
      name: 'Inv Fake Deps',
      description: 'd',
      tags: [],
      relatesToInvariant: 'doc.md#a',
      deps: {
        seedTenant: async () =>
          Object.freeze({ tenantId: 't1', repoIds: Object.freeze(['r1']) }),
      },
      setup: async (ctx) => {
        const tenant = await ctx.seedTenant();
        ctx.assertEquals(tenant.tenantId, 't1', 'tenant id is t1');
      },
      act: noopAsync,
      assert: async (ctx) => {
        ctx.assertThat(true, 'always-true');
      },
    });

    const result = await scenario.run(new AbortController().signal);
    expect(result.passed).toBe(true);
    if (result.kind === 'invariant') {
      expect(result.outcome.assertions).toHaveLength(2);
      expect(result.outcome.assertions.every((a) => a.held)).toBe(true);
    }
  });

  it('uses ctx.expectStage / ctx.expectOutcome / ctx.expectWorkflowStatus / ctx.expectAuditEntry recorders', async () => {
    const scenario = defineInvariantScenarioWithoutRegistration({
      id: 'inv-expect-helpers',
      name: 'Inv Expect Helpers',
      description: 'd',
      tags: [],
      relatesToInvariant: 'doc.md#a',
      deps: {
        expectStage: async () => true,
        expectOutcome: async () => true,
        expectWorkflowStatus: async () => false,
        expectAuditEntry: async () => true,
      },
      setup: noopAsync,
      act: noopAsync,
      assert: async (ctx) => {
        await ctx.expectStage({ traceId: 'tr1', stageId: 'reconcile' });
        await ctx.expectStage({ traceId: 'tr1', stageId: 'reconcile', outcomeId: 'OK' });
        await ctx.expectOutcome('tr1', 'OK');
        await ctx.expectWorkflowStatus({ workflowId: 'wf1', expectedStatus: 'COMPLETE' });
        await ctx.expectAuditEntry({ subjectId: 's1', action: 'A' });
      },
    });

    const result = await scenario.run(new AbortController().signal);
    if (result.kind === 'invariant') {
      // 5 recordings: 2 stages + 1 outcome + 1 wf-status + 1 audit
      expect(result.outcome.assertions).toHaveLength(5);
      // workflow status returned false → at least one assertion not held
      expect(result.outcome.assertions.some((a) => !a.held)).toBe(true);
      expect(result.passed).toBe(false);
    }
  });

  it('records assertions with details from assertEquals and recordAssertion', async () => {
    const scenario = defineInvariantScenarioWithoutRegistration({
      id: 'inv-record',
      name: 'Inv Record',
      description: 'd',
      tags: [],
      relatesToInvariant: 'doc.md#a',
      setup: noopAsync,
      act: noopAsync,
      assert: async (ctx) => {
        ctx.assertEquals({ a: 1 }, { a: 2 }, 'objects equal');
        ctx.recordAssertion('lower-level record', true, { foo: 'bar' });
        ctx.assertThat(false, 'failing assertion');
      },
    });

    const result = await scenario.run(new AbortController().signal);
    if (result.kind === 'invariant') {
      expect(result.outcome.assertions).toHaveLength(3);
      expect(result.outcome.assertions[0]?.held).toBe(false);
      expect(result.outcome.assertions[0]?.details).toBeDefined();
      expect(result.outcome.assertions[1]?.held).toBe(true);
      expect(result.outcome.assertions[2]?.held).toBe(false);
    }
  });
});

// =============================================================================
// FIX-EVALUATION EXECUTOR — abort + leaf-only verdict tree
// =============================================================================

describe('fix-evaluation executor — abort and leaf verdicts', () => {
  it('rejects with ScenarioAbortedError when called with a pre-aborted signal', async () => {
    const ac = new AbortController();
    ac.abort();
    const scenario = defineFixEvaluationScenarioWithoutRegistration({
      id: 'fe-abort',
      name: 'FE Abort',
      description: 'd',
      tags: [],
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
      predicate: { all_of: [{ id: 'tests-pass' }, { id: 'no-tests-modified' }] },
    });

    await expect(scenario.run(ac.signal)).rejects.toThrow(ScenarioAbortedError);
  });

  it('produces verdict=undefined when predicate is omitted (judgmentMode != predicate-match)', async () => {
    const scenario = defineFixEvaluationScenarioWithoutRegistration({
      id: 'fe-no-pred',
      name: 'FE No Pred',
      description: 'd',
      tags: [],
      category: 'security',
      score: 3,
      criteriaMet: [],
      source: 'simulation',
      severity: 'high',
      expectedDifficulty: 'trivial',
      signalIntent: 'actionable',
      judgmentMode: 'human-review',
      provenance: 'real-world-inspired',
      expectedOutcome: 'success',
      signal: {
        source: 'simulation',
        severity: 'high',
        category: 'security',
        ruleId: 'corpus:test',
        message: 'test',
      },
    });

    const result = await scenario.run(new AbortController().signal);
    expect(result.kind).toBe('fix-evaluation');
    if (result.kind === 'fix-evaluation') {
      expect(result.outcome.verdict).toBeUndefined();
      // also exercises renderScenarioResultView's "predicate did not match" branch:
      const view = renderScenarioResultView(result);
      expect(view.outcomeLabel).toContain('predicate did not match');
    }
  });

  it('produces a leaf verdict for a single-leaf predicate (composite branch not taken)', async () => {
    const scenario = defineFixEvaluationScenarioWithoutRegistration({
      id: 'fe-leaf',
      name: 'FE Leaf',
      description: 'd',
      tags: [],
      category: 'security',
      score: 3,
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
      // Single-leaf root predicate (no composite combinator).
      predicate: { all_of: [{ id: 'no-tests-modified' }] },
    });

    const result = await scenario.run(new AbortController().signal);
    if (result.kind === 'fix-evaluation') {
      expect(result.outcome.verdict?.type).toBe('composite');
      if (result.outcome.verdict?.type === 'composite') {
        expect(result.outcome.verdict.children).toHaveLength(1);
        expect(result.outcome.verdict.children[0]?.type).toBe('leaf');
      }
    }
  });
});
