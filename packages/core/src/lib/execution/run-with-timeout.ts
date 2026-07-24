/**
 * runWithTimeout — the per-unit timeout/abort/retry wrapper of the execution
 * substrate (north-star §5.8, launch).
 *
 * One unit's lifecycle: install an `AbortController` + `setTimeout`, run the
 * domain function under that signal (optionally with retry), and classify the
 * outcome as `ok` / `timeout` / `error`. The single-source abort invariant is
 * preserved from fitness's `runOneCheck`: the controller is aborted ONLY by the
 * timeout, so a post-run `signal.aborted` IS a timeout.
 *
 * This is the shared primitive that makes "a declared `timeout` actually aborts"
 * true in every domain — the §4.3 fix for simulation, whose `runSingle` declared
 * `execution.timeout` but never installed one.
 */

import { currentScope } from '../scope-storage.js';

import { runWithRetry, type PipelineRetryOptions } from './retry.js';

/** Result of one unit run. `timeout` and `error` are distinct so callers can map each. */
export type UnitRunOutcome<R> =
  | { readonly status: 'ok'; readonly result: R; readonly durationMs: number }
  | {
      readonly status: 'timeout';
      readonly durationMs: number;
      readonly timeoutMs: number;
    }
  | {
      readonly status: 'error';
      readonly error: unknown;
      readonly durationMs: number;
    };

export interface RunWithTimeoutOptions<R> {
  /** The domain run — receives the abort signal the timeout fires on. */
  readonly run: (signal: AbortSignal) => Promise<R>;
  /** Per-unit timeout (ms). A run that exceeds it is aborted → `status:'timeout'`. */
  readonly timeoutMs: number;
  /** Optional retry (fitness); omitted ⇒ the run executes exactly once. */
  readonly retry?: PipelineRetryOptions;
  /**
   * Parent cancel signal (Plan 00). Composed with the timeout controller so an
   * outer deadline / OS interrupt aborts unit work without leaking listeners.
   * When omitted it DEFAULTS to the host-owned per-invocation root cancel signal
   * (`currentScope()?.abortSignal`), so every tool that runs on this substrate
   * gets OS-interrupt cancellation for free — no per-tool wiring. Pass an
   * explicit signal to compose an additional outer deadline.
   */
  readonly parentSignal?: AbortSignal;
}

/**
 * Compose a child AbortController that aborts when either parent or timeout fires.
 * Returns cleanup to remove the parent listener.
 */
const noopCleanup = (): void => {
  /* no parent signal to detach */
};

export function composeAbortSignals(
  parent: AbortSignal | undefined,
  child: AbortController,
): () => void {
  if (!parent) return noopCleanup;
  if (parent.aborted) {
    child.abort(parent.reason);
    return noopCleanup;
  }
  const onAbort = () => {
    child.abort(parent.reason);
  };
  parent.addEventListener('abort', onAbort, { once: true });
  return () => parent.removeEventListener('abort', onAbort);
}

/**
 * Run one unit under a timeout, returning a classified outcome (never throws for
 * a domain error — it is returned as `status:'error'`). Mirrors the proven
 * timeout-detection of fitness's `runOneCheck` (clear the timer, then a
 * `signal.aborted` check is canonical-timeout because the controller has a single
 * abort source).
 */
export async function runWithTimeout<R>(
  opts: RunWithTimeoutOptions<R>,
): Promise<UnitRunOutcome<R>> {
  const controller = new AbortController();
  // Host-owned cancellation plane (Plan 00 Phase 4): default the parent to the
  // per-invocation root cancel signal so OS interrupt / outer deadline aborts
  // this unit for free — every substrate-based tool inherits it, no per-tool
  // wiring. An explicit opts.parentSignal (an additional outer deadline) wins.
  const parentSignal = opts.parentSignal ?? currentScope()?.abortSignal;
  const detachParent = composeAbortSignals(parentSignal, controller);
  let detachParentRace = noopCleanup;
  const startTime = Date.now();
  let timeoutId: ReturnType<typeof setTimeout> | undefined;

  const finish = (): number => {
    if (timeoutId !== undefined) {
      clearTimeout(timeoutId);
      timeoutId = undefined;
    }
    detachParent();
    detachParentRace();
    return Date.now() - startTime;
  };

  // Parent already aborted → cancelled-as-error (distinct from unit timeout).
  if (parentSignal?.aborted) {
    const durationMs = finish();
    return {
      status: 'error',
      error: parentSignal.reason ?? new Error('Parent signal aborted'),
      durationMs,
    };
  }

  // Execute the domain work (retry or direct) and always classify to an outcome.
  // This promise may never settle if the callee ignores the abort signal.
  const workPromise = (async (): Promise<UnitRunOutcome<R>> => {
    try {
      if (opts.retry) {
        const retry = await runWithRetry(() => opts.run(controller.signal), {
          ...opts.retry,
          signal: controller.signal,
        });
        const durationMs = finish();
        if (controller.signal.aborted && !parentSignal?.aborted) {
          return { status: 'timeout', durationMs, timeoutMs: opts.timeoutMs };
        }
        if (parentSignal?.aborted) {
          return {
            status: 'error',
            error: parentSignal.reason ?? retry.lastError,
            durationMs,
          };
        }
        if (retry.result === undefined) {
          return { status: 'error', error: retry.lastError, durationMs };
        }
        return { status: 'ok', result: retry.result, durationMs };
      }

      const result = await opts.run(controller.signal);
      const durationMs = finish();
      // A run that resolved AFTER the timeout fired is reported as a timeout
      // (single-source abort invariant), matching fitness's post-run check.
      if (controller.signal.aborted && !parentSignal?.aborted) {
        return { status: 'timeout', durationMs, timeoutMs: opts.timeoutMs };
      }
      if (parentSignal?.aborted) {
        return {
          status: 'error',
          error: parentSignal.reason ?? new Error('Parent signal aborted'),
          durationMs,
        };
      }
      return { status: 'ok', result, durationMs };
    } catch (error) {
      const durationMs = finish();
      if (controller.signal.aborted && !parentSignal?.aborted) {
        return { status: 'timeout', durationMs, timeoutMs: opts.timeoutMs };
      }
      return { status: 'error', error, durationMs };
    }
  })();

  // Hard timeout: this settles the *function* with a timeout outcome even if
  // the domain work never settles. We still abort the controller so cooperative
  // callees can stop. Report the exact budget as duration for the timeout case
  // (avoids sampling skew from the setTimeout fire time).
  const hardTimeout = new Promise<UnitRunOutcome<R>>((resolve) => {
    timeoutId = setTimeout(() => {
      timeoutId = undefined;
      controller.abort();
      resolve({
        status: 'timeout',
        durationMs: opts.timeoutMs,
        timeoutMs: opts.timeoutMs,
      });
    }, opts.timeoutMs);
    timeoutId.unref?.();
  });

  // Parent cancellation is a terminal race of its own. Merely aborting the
  // child signal is insufficient when a non-cooperative domain function ignores
  // it; without this arm an OS interrupt can remain stuck until the unit timeout.
  const hardParentAbort = new Promise<UnitRunOutcome<R>>((resolve) => {
    if (parentSignal === undefined) return;
    const onAbort = () => {
      resolve({
        status: 'error',
        error: parentSignal.reason ?? new Error('Parent signal aborted'),
        durationMs: Date.now() - startTime,
      });
    };
    if (parentSignal.aborted) {
      onAbort();
      return;
    }
    parentSignal.addEventListener('abort', onAbort, { once: true });
    detachParentRace = () => parentSignal.removeEventListener('abort', onAbort);
  });

  // Race so a non-settling domain cannot hang the scheduler/recipe.
  let outcome: UnitRunOutcome<R>;
  try {
    outcome = await Promise.race([workPromise, hardTimeout, hardParentAbort]);
  } finally {
    // Release the parent-signal listener + timer even when the hard timeout wins
    // and the (non-cooperative) domain promise never settles. Otherwise `finish()`
    // only runs inside the workPromise branches, leaking one listener per such unit
    // on the long-lived shared parent signal (violating the parentSignal contract).
    // `finish()` is idempotent, so the workPromise branch that also calls it is safe.
    finish();
  }

  // If the hard timeout won, the domain promise may still settle (or reject) later.
  // Attach a no-op handler so a late rejection does not become an unhandled promise rejection.
  workPromise.catch(() => {
    /* late settlement after timeout is expected and ignored; the abort signal was delivered */
  });

  return outcome;
}
