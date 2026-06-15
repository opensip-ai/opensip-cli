/**
 * @fileoverview `Target` — the BYO (bring-your-own) seam for the simulation
 * harness.
 *
 * A `Target` is the single outside-world contract: the load-window driver calls
 * it once per request. It is intentionally protocol-agnostic — an `async`
 * function that **resolves on success and throws on failure**. The harness
 * measures wall-clock latency around the call and classifies the outcome from
 * resolve/throw. HTTP users reach for the `httpTarget()` helper, but any async
 * function (gRPC, in-process, a shell-out) is a valid target.
 *
 * A well-behaved target passes `ctx.signal` to its I/O and rejects when the
 * signal aborts (scenario abort + `abort` faults rely on this). The fault model
 * additionally guarantees an `abort` fault counts as a failure even for a
 * target that ignores the signal (see `fault-model.ts`).
 *
 * This is a leaf module: it imports nothing from the type or runtime layers so
 * the driver, fault model, and helpers can depend on it without cycles.
 */

/** Context handed to a `Target` for each request. */
export interface TargetContext {
  /** Abort signal for the request; aborts on scenario abort or an `abort` fault. */
  readonly signal: AbortSignal;
  /** Correlation id for the enclosing scenario run. */
  readonly correlationId: string;
}

/**
 * A user-supplied target the driver invokes once per request.
 *
 * Resolve = the request succeeded. Throw (or reject on `ctx.signal` abort) =
 * the request failed. The harness times the call and never inspects a return
 * value, so `Promise<void>` is the whole contract.
 */
export type Target = (ctx: TargetContext) => Promise<void>;
