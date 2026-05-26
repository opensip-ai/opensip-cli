/**
 * @fileoverview Shared load-window driver used by the load and chaos kinds.
 *
 * Both kinds run a tick-driven RPS loop with ramp-up, latency tracking, and
 * a 95% baseline success rate. The chaos kind additionally interposes a
 * per-tick `injectChaos` callback that can override the request outcome
 * (e.g. force-fail) and emit a `LoadWindowEvent`. Centralising the loop here is
 * the Template Method shape called for in Layer 3 Phase E2 — kind executors
 * supply the failure-injection variation point, the framework owns the
 * loop lifecycle.
 */

import { getEstimatedRps } from '../personas.js'

import { LatencyTracker } from './latency-tracker.js'

import type { SimulationMetrics } from '../../types/base-types.js'
import type { PersonaConfig, ScenarioExecutionContext } from '../../types/framework-types.js'

/**
 * Diagnostic event the chaos kind emits when `injectChaos` returns a
 * `chaos-event` outcome. The `type` discriminator is left generic over a
 * caller-supplied string-literal union — chaos parameterises this with its
 * own `ChaosType` so the boundary is type-safe and no runtime cast is
 * required when the framework hands events back to the kind.
 */
interface LoadWindowEvent<T extends string = string> {
  readonly type: T
  readonly atMs: number
  readonly target: string
}

// =============================================================================
// PUBLIC TYPES
// =============================================================================

/** Subset of a kind config the load-window driver actually consumes. */
export interface LoadWindowConfig {
  readonly duration: number
  readonly rampUp?: number
  readonly targetRps?: number
  readonly personas: readonly PersonaConfig[]
}

/**
 * Outcome of a single tick request, returned by the optional `injectChaos`
 * callback. Encodes how the loop should account for the request:
 *
 *   - `'success'`     — counted as a successful request.
 *   - `'failure'`     — counted as a failed request (no chaos event).
 *   - `'chaos-event'` — counted as a failed request **and** emits a
 *                       `LoadWindowEvent` carrying the supplied diagnostic
 *                       payload.
 *   - `null`          — defer to the default 95%-success roll.
 */
export type TickOutcome<T extends string = string> =
  | { readonly kind: 'success' }
  | { readonly kind: 'failure' }
  | { readonly kind: 'chaos-event'; readonly event: LoadWindowEvent<T> }
  | null

/**
 * Per-tick injection hook. Called once per request the loop attempts to
 * issue. Receiving `tickStartMs` gives implementations a relative timestamp
 * for `LoadWindowEvent.atMs`.
 */
type InjectChaos<T extends string = string> = (args: {
  readonly tickStartMs: number
}) => TickOutcome<T>

/** Options passed to `runLoadWindow`. */
export interface RunLoadWindowOptions<T extends string = string> {
  /** Duration the window runs for, in milliseconds. */
  readonly windowMs: number
  /**
   * Optional per-request hook letting a kind override the default
   * 95%-success roll (chaos uses this to inject failures).
   */
  readonly injectChaos?: InjectChaos<T>
}

/** Aggregated outcome of a single load window. */
export interface LoadWindowResult<T extends string = string> {
  readonly metrics: SimulationMetrics
  readonly events: readonly LoadWindowEvent<T>[]
}

// =============================================================================
// IMPLEMENTATION
// =============================================================================

const TICK_INTERVAL_MS = 100

function createMetrics(): SimulationMetrics {
  return {
    totalRequests: 0,
    successfulRequests: 0,
    failedRequests: 0,
    avgLatencyMs: 0,
    p50LatencyMs: 0,
    p95LatencyMs: 0,
    p99LatencyMs: 0,
    errorsGenerated: 0,
    findingsGenerated: 0,
  }
}

function applyOutcome<T extends string>(
  metrics: SimulationMetrics,
  events: LoadWindowEvent<T>[],
  outcome: TickOutcome<T>,
): void {
  if (outcome === null) {
    // Default 95% success rate.
    if (Math.random() < 0.95) {
      metrics.successfulRequests++
    } else {
      metrics.failedRequests++
      metrics.errorsGenerated++
    }
    return
  }

  switch (outcome.kind) {
    case 'success': {
      metrics.successfulRequests++
      return
    }
    case 'failure': {
      metrics.failedRequests++
      metrics.errorsGenerated++
      return
    }
    case 'chaos-event': {
      metrics.failedRequests++
      metrics.errorsGenerated++
      events.push(outcome.event)
      return
    }
  }
}

function sleepTick(intervalMs: number, signal: AbortSignal): Promise<void> {
  return new Promise<void>((resolve) => {
    const timeout = setTimeout(resolve, intervalMs)
    if (signal.aborted) {
      clearTimeout(timeout)
      resolve()
    }
  })
}

/**
 * Run a single load-style window. Returns the aggregated metrics + any
 * chaos events collected during the run.
 *
 * The default request outcome is the load kind's 95% success roll. A chaos
 * kind passes `injectChaos` to override per-tick outcomes and emit
 * `LoadWindowEvent`s. The driver does not produce signals today —
 * kind executors assemble their own signal lists in their result wrappers,
 * so a `signals` slot here would always be empty (and previously caused
 * `findingsGenerated` to silently always be 0).
 */
export async function runLoadWindow<T extends string = string>(
  config: LoadWindowConfig,
  context: ScenarioExecutionContext,
  options: RunLoadWindowOptions<T>,
): Promise<LoadWindowResult<T>> {
  const targetRps = config.targetRps ?? getEstimatedRps(config.personas)
  const metrics = createMetrics()
  const latencyTracker = new LatencyTracker()
  const events: LoadWindowEvent<T>[] = []
  const start = Date.now()
  const rampUpMs = (config.rampUp ?? 0) * 1000

  while (Date.now() - start < options.windowMs) {
    if (context.abortSignal.aborted) break

    const elapsed = Date.now() - start
    const rampUpProgress = rampUpMs > 0 ? Math.min(1, elapsed / rampUpMs) : 1
    const currentRps = targetRps * rampUpProgress
    const requestsThisTick = Math.floor(currentRps / (1000 / TICK_INTERVAL_MS))

    for (let i = 0; i < requestsThisTick; i++) {
      if (context.abortSignal.aborted) break
      const latency = Math.random() * 50 + 1
      metrics.totalRequests++
      latencyTracker.record(latency)

      const outcome = options.injectChaos
        ? options.injectChaos({ tickStartMs: elapsed })
        : null
      applyOutcome(metrics, events, outcome)
    }

    await sleepTick(TICK_INTERVAL_MS, context.abortSignal)
  }

  const snapshot = latencyTracker.getLatencySnapshot()
  metrics.avgLatencyMs = snapshot.avgLatencyMs
  metrics.p50LatencyMs = snapshot.p50LatencyMs
  metrics.p95LatencyMs = snapshot.p95LatencyMs
  metrics.p99LatencyMs = snapshot.p99LatencyMs

  return { metrics, events }
}
