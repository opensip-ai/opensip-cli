/**
 * @fileoverview `fault.*` — ergonomic builders for a {@link FaultSpec}.
 *
 * Authors describe client-side faults declaratively:
 *
 * ```ts
 * fault.of([fault.latency({ ms: 800 }), fault.drop()], { probability: 0.1 })
 * ```
 */

import type { Fault, FaultSpec } from './fault-spec.js'

/** Builders for the client-side fault vocabulary + a `FaultSpec` assembler. */
export const fault = {
  /** Delay the real call by `ms` (a slow-dependency symptom). */
  latency: (o: { ms: number }): Fault => ({ kind: 'latency', ms: o.ms }),
  /** Abort the in-flight request (a timeout / cancellation). */
  abort: (): Fault => ({ kind: 'abort' }),
  /** Skip the call entirely, counting a client-observed failure. */
  drop: (): Fault => ({ kind: 'drop' }),
  /** Assemble a probability-gated set of candidate faults. */
  of: (faults: readonly Fault[], o: { probability: number }): FaultSpec => ({
    faults,
    probability: o.probability,
  }),
} as const
