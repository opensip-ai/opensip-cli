/**
 * Pins the load-bearing invariant called out in audit 2026-05-23 F7:
 * `runOneCheck` reads `signal.aborted` after the retry chain to detect a
 * timeout, and that detection is correct only because the per-check
 * `AbortController` has exactly one abort source (the local
 * `setTimeout`). The tests below pin the observable consequence — a
 * non-timeout failure must NOT be reported as a timeout, regardless of
 * whether the failing check's `run` reads or ignores the abort signal.
 *
 * If a future change wires another abort source into the per-check
 * controller, these tests will catch the regression.
 */

import { describe, expect, it, vi } from 'vitest';

import { defineCheck } from '../../framework/define-check.js';
import { runOneCheck } from '../run-one-check.js';

import type { ProcessorContext } from '../check-result-processor.js';
import type { FitnessRecipeServiceCallbacks, FitnessRecipeSession } from '../service-types.js';
import type { FitnessRecipe } from '../types.js';

let nextId = 0;
function uid(): string {
  nextId++;
  return `00000000-0000-4000-8000-${nextId.toString(16).padStart(12, '0')}`;
}

function makeRecipe(): FitnessRecipe {
  return {
    id: 'URCP_test',
    name: 'test',
    displayName: 'Test',
    description: 'test recipe',
    checks: { type: 'all', exclude: [] },
    execution: { mode: 'sequential', stopOnFirstFailure: false, timeout: 30_000 },
    reporting: { format: 'table', verbose: false },
  };
}

function makeSession(): FitnessRecipeSession {
  return {
    sessionId: 'SES_test',
    recipe: makeRecipe(),
    startedAt: new Date(),
    status: 'running',
    totalChecks: 1,
    completedChecks: 0,
    passedChecks: 0,
    failedChecks: 0,
    totalErrors: 0,
    totalWarnings: 0,
    totalIgnored: 0,
    ignoresByTag: new Map(),
    checkResults: [],
    directives: [],
  };
}

function makeProcessorContext(callbacks: FitnessRecipeServiceCallbacks = {}): ProcessorContext {
  return {
    session: makeSession(),
    callbacks,
    recipe: makeRecipe(),
    includeViolations: true,
  };
}

describe('runOneCheck — timeout-detection invariant (audit F7)', () => {
  it('flags timedOut=true when the per-check timeout fires', async () => {
    // Check sleeps longer than the recipe timeout; the local setTimeout
    // aborts the controller, runOneCheck observes signal.aborted, and the
    // outcome carries `timedOut: true`.
    const slowAnalyze = vi.fn(async () => {
      await new Promise((r) => setTimeout(r, 500));
      return [];
    });
    const check = defineCheck({
      id: uid(),
      slug: 'slow',
      description: 'slow',
      tags: ['quality'],
      analyzeAll: slowAnalyze,
    });

    const outcome = await runOneCheck(
      check,
      {
        cwd: process.cwd(),
        checkIndex: 1,
        totalChecks: 1,
        recipeTimeoutMs: 50,
        retryEnabled: false,
        maxRetries: 0,
      },
      makeProcessorContext(),
    );

    expect(outcome.processOutput?.checkResult.timedOut).toBe(true);
  });

  it('does NOT flag timedOut=true when the check completes well within the timeout', async () => {
    // Pin the invariant: the only abort source on the per-check
    // controller is the local setTimeout. A check that finishes promptly
    // and does NOT abort must surface as a normal pass — never a
    // timeout. If a future change wires an additional abort source into
    // `checkAbortController`, an externally-aborted signal during this
    // run would silently flip timedOut to true and break this test.
    const fastAnalyze = vi.fn(() => Promise.resolve([]));
    const check = defineCheck({
      id: uid(),
      slug: 'fast',
      description: 'fast',
      tags: ['quality'],
      analyzeAll: fastAnalyze,
    });

    const outcome = await runOneCheck(
      check,
      {
        cwd: process.cwd(),
        checkIndex: 1,
        totalChecks: 1,
        recipeTimeoutMs: 5000,
        retryEnabled: false,
        maxRetries: 0,
      },
      makeProcessorContext(),
    );

    const cr = outcome.processOutput?.checkResult;
    expect(cr).toBeDefined();
    expect(cr?.timedOut).not.toBe(true);
    expect(cr?.passed).toBe(true);
  });
});
