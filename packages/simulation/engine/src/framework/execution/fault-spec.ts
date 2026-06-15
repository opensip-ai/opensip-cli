/**
 * @fileoverview `FaultSpec` — the author-facing, **client-side** fault
 * vocabulary for the chaos kind.
 *
 * The harness can honestly inject only client-side perturbations of the real
 * request stream:
 *
 *   - `latency` — delay the real call (a slow-dependency symptom).
 *   - `abort`   — abort the in-flight request (a timeout / cancellation).
 *   - `drop`    — skip the call entirely, counting a client-observed failure
 *                 (a dropped request / open circuit).
 *
 * Server-side faults (kill a pod, force 500s, sever a dependency) cannot be
 * injected honestly from the client. They are achieved by pointing the
 * `Target` at a **fault-injectable endpoint you control** (e.g. a Toxiproxy
 * proxy, a chaos-mesh'd staging env, a test-flagged endpoint) — the harness
 * drives and measures around it. That pattern is documented, not expressed
 * here.
 *
 * Leaf module: imports nothing from the type or runtime layers.
 */

/** The client-injectable fault kinds. */
export type FaultKind = 'latency' | 'abort' | 'drop';

/** A single client-side fault the model may apply to a request. */
export type Fault =
  | { readonly kind: 'latency'; readonly ms: number }
  | { readonly kind: 'abort' }
  | { readonly kind: 'drop' };

/** Probability-gated set of client-side faults for a chaos scenario. */
export interface FaultSpec {
  /** Candidate faults; one is selected when a request is perturbed. */
  readonly faults: readonly Fault[];
  /** Per-request probability `[0,1]` that a fault is applied. */
  readonly probability: number;
}
