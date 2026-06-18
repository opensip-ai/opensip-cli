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

import { enterScope, RunScope } from '@opensip-cli/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { defineCheck } from '../../framework/define-check.js';
import { CheckAbortedError } from '../../framework/execution-context.js';
import { installFitnessSubscope } from '../../framework/scope-registry.js';
import { fitnessTool } from '../../tool.js';
import { runOneCheck } from '../run-one-check.js';

import type { ProcessorContext } from '../check-result-processor.js';
import type { FitnessRecipeServiceCallbacks, FitnessRecipeSession } from '../service-types.js';
import type { FitnessRecipe } from '../types.js';

// `runOneCheck` drives `check.run()`, which builds an ExecutionContext that
// resolves the per-run cache from `currentScope()?.fitness?.fileCache` (no
// module-singleton fallback — parallel-tool-invocations Phase 1). Enter a fresh
// RunScope carrying fitness's subscope so file-reading checks resolve a cache.
let scope: RunScope;
beforeEach(() => {
  scope = new RunScope();
  installFitnessSubscope(scope, fitnessTool.contributeScope?.() ?? {});
  enterScope(scope);
});
afterEach(() => {
  scope.dispose();
});

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

  it('reports a CheckAbortedError (retryResult.result === undefined, not a timeout) as a non-timeout error', async () => {
    // defineCheck re-throws CheckAbortedError; executeWithRetry surfaces it as
    // `{ result: undefined, lastError }` WITHOUT aborting runOneCheck's own
    // controller. So runOneCheck takes the undefined-result error branch with
    // `signal.aborted === false` → timedOut must be false (the timeout never
    // fired). This is the branch that distinguishes "errored" from "timed out".
    const aborting = vi.fn(() => {
      throw new CheckAbortedError('aborted-check');
    });
    const check = defineCheck({
      id: uid(),
      slug: 'aborted-check',
      description: 'throws CheckAbortedError',
      tags: ['quality'],
      analyzeAll: aborting,
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
    expect(cr?.passed).toBe(false);
    expect(cr?.timedOut).toBe(false);
    expect(cr?.error).toBeDefined();
  });

  it('catches a throw raised while processing a successful result (catch path)', async () => {
    // The success path calls processSuccessResult, which invokes
    // onCheckComplete. We make that callback throw ONLY on the success
    // summary (passed === true); the throw escapes the try block and is
    // handled by runOneCheck's catch, which re-dispatches to
    // processErrorResult. Since the controller never aborted, the recovered
    // result is reported as a non-timeout error.
    const passing = vi.fn(() => Promise.resolve([]));
    const check = defineCheck({
      id: uid(),
      slug: 'ok-but-callback-throws',
      description: 'passes',
      tags: ['quality'],
      analyzeAll: passing,
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
      makeProcessorContext({
        onCheckComplete: (_slug, summary) => {
          if (summary.passed) throw new Error('callback exploded');
        },
      }),
    );

    const cr = outcome.processOutput?.checkResult;
    expect(cr).toBeDefined();
    // Callback errors raised from onCheckComplete during success processing are now
    // swallowed inside processSuccessResult (to keep the check as a success for session
    // counts and avoid double-counting). The error is only logged as a warning
    // ('fitness.check.callback_error'). The returned processOutput remains the success one.
    expect(cr?.timedOut).toBeUndefined();
    expect(cr?.passed).toBe(true);
    expect(cr?.error).toBeUndefined();
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
