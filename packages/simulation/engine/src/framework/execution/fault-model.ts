/**
 * @fileoverview `FaultModel` — real client-side fault injection as a
 * `Target` decorator.
 *
 * Replaces the old synthetic `injectChaos`. Where that fabricated failure
 * outcomes, the fault model perturbs the **real** request:
 *
 *   - `latency` — delay the real call by `ms` (the underlying target still
 *                 runs; the added latency shows up in the measured snapshot).
 *   - `abort`   — abort the in-flight request, so it fails as a timeout /
 *                 cancellation. Enforced even for targets that ignore the
 *                 abort signal (we race the call against an abort rejection).
 *   - `drop`    — skip the call entirely and throw, so the driver counts a
 *                 real client-observed failure.
 *
 * The probability gate is driven by an injected RNG (`deps.rng`, default
 * `Math.random`) so tests can pass a stubbed sequence and assert the exact set
 * of perturbed requests. Fault selection among `spec.faults` is round-robin —
 * deterministic without consuming extra RNG draws.
 */

import type { Target, TargetContext } from './target.js'
import type { Fault, FaultKind, FaultSpec } from './fault-spec.js'

/** A fault occurrence recorded for diagnostics (→ `ChaosEvent`). */
export interface FiredFault {
  readonly kind: FaultKind
  /** Absolute wall-clock time the fault fired (ms). */
  readonly at: number
}

/** Dependencies for the fault model. */
export interface FaultModelDeps {
  /** Probability-gate RNG in `[0,1)`. Defaults to `Math.random`. */
  readonly rng?: () => number
}

/** A fault model bound to a `FaultSpec`. */
export interface FaultModel {
  /** Decorate a target so each call may be perturbed at `spec.probability`. */
  wrap(target: Target): Target
  /** The faults that fired so far, in order. */
  drained(): readonly FiredFault[]
}

function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise<void>((resolve) => {
    if (signal.aborted) {
      resolve()
      return
    }
    const timeout = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = (): void => {
      clearTimeout(timeout)
      resolve()
    }
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

/**
 * Build a fault model for a `FaultSpec`.
 *
 * The returned `wrap` is intended to be called once (for the steady-state
 * window); the recovery window uses the bare target. `drained()` reports the
 * faults that fired, for the chaos result's `ChaosEvent[]`.
 */
export function createFaultModel(spec: FaultSpec, deps: FaultModelDeps = {}): FaultModel {
  const rng = deps.rng ?? Math.random
  const fired: FiredFault[] = []
  let perturbCount = 0

  const applyFault = async (
    fault: Fault,
    target: Target,
    ctx: TargetContext,
  ): Promise<void> => {
    fired.push({ kind: fault.kind, at: Date.now() })
    switch (fault.kind) {
      case 'latency': {
        await delay(fault.ms, ctx.signal)
        await target(ctx)
        return
      }
      case 'abort': {
        // Abort the request: hand a well-behaved target an already-aborted
        // signal so it cancels, but guarantee the request fails regardless of
        // whether the target honours the signal (we throw deterministically).
        const controller = new AbortController()
        controller.abort()
        const signal =
          typeof AbortSignal.any === 'function'
            ? AbortSignal.any([ctx.signal, controller.signal])
            : controller.signal
        // Fire the call so a signal-aware target observes the abort; ignore how
        // it settles — this request is counted as a failure either way.
        void Promise.resolve(target({ signal, correlationId: ctx.correlationId })).catch(
          () => undefined,
        )
        throw new Error('fault:abort')
      }
      case 'drop': {
        // Never reach the target; the driver counts a client-observed failure.
        throw new Error('fault:drop')
      }
    }
  }

  return {
    wrap(target: Target): Target {
      return async (ctx: TargetContext): Promise<void> => {
        if (rng() >= spec.probability || spec.faults.length === 0) {
          await target(ctx)
          return
        }
        const fault = spec.faults[perturbCount % spec.faults.length]
        perturbCount++
        if (!fault) {
          await target(ctx)
          return
        }
        await applyFault(fault, target, ctx)
      }
    },
    drained(): readonly FiredFault[] {
      return fired
    },
  }
}
