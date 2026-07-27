/**
 * @fileoverview Shared load-window driver used by the load and chaos kinds.
 *
 * Both kinds run a tick-driven RPS loop with ramp-up and latency tracking that
 * issues **real requests** against a user-supplied {@link Target}: each request
 * is awaited, timed, and classified from resolve (success) / throw (failure).
 * Requests are dispatched concurrently up to the workload's in-flight cap so
 * real latency overlaps instead of serializing.
 *
 * The driver is fault-agnostic. The chaos kind injects faults by wrapping its
 * `Target` with the fault model (`fault-model.ts`) before handing it here — the
 * driver just drives whatever `Target` it is given. Centralising the loop here
 * keeps both kinds on one real driver (the Template Method shape: kinds supply
 * the `Target`, the framework owns the loop lifecycle).
 */

import {
  createCancelledError,
  createDeadlineError,
  normalizeFailure,
  toPublicFailureProjection,
  type FailureEnvelope,
} from '@opensip-cli/core';

import { resolveConcurrency } from '../../types/workload.js';
import { createEmptyMetrics } from '../result-builder.js';

import { LatencyTracker } from './latency-tracker.js';

import type { Target } from './target.js';
import type { SimulationMetrics } from '../../types/base-types.js';
import type { ScenarioExecutionContext } from '../../types/framework-types.js';
import type { Workload } from '../../types/workload.js';

// =============================================================================
// PUBLIC TYPES
// =============================================================================

/** Subset of a kind config the load-window driver actually consumes. */
export interface LoadWindowConfig {
  readonly workload: Workload;
}

/** Options passed to `runLoadWindow`. */
export interface RunLoadWindowOptions {
  /** Duration the window runs for, in milliseconds. */
  readonly windowMs: number;
  /** The (possibly fault-decorated) target driven once per request. */
  readonly target: Target;
}

/** Aggregated outcome of a single load window. */
export interface LoadWindowResult {
  readonly metrics: SimulationMetrics;
  /** First normalized target failure, retained as bounded diagnostic evidence. */
  readonly firstFailure?: FailureEnvelope;
}

// =============================================================================
// IMPLEMENTATION
// =============================================================================

const TICK_INTERVAL_MS = 100;
const IN_FLIGHT_DRAIN_TIMEOUT_MS = 5000;

function sleepTick(intervalMs: number, signal: AbortSignal): Promise<void> {
  return new Promise<void>((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const timeout = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, intervalMs);
    const onAbort = (): void => {
      clearTimeout(timeout);
      resolve();
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

/** State the dispatch loop threads through to each in-flight request. */
interface DispatchState {
  readonly target: Target;
  readonly context: ScenarioExecutionContext;
  readonly metrics: SimulationMetrics;
  readonly latencyTracker: LatencyTracker;
  readonly inFlight: Set<Promise<void>>;
  firstFailure?: FailureEnvelope;
  acceptResults: boolean;
}

function recordRejectedRequest(state: DispatchState, error: unknown): void {
  if (!state.acceptResults) return;
  const failure = normalizeFailure(error);
  if (state.context.abortSignal.aborted || failure.definition.kind === 'cancelled') {
    // Cancelled requests are incomplete measurements, not SLO failures.
    state.metrics.totalRequests = Math.max(0, state.metrics.totalRequests - 1);
    return;
  }
  state.firstFailure ??= failure;
  state.metrics.failedRequests++;
  // `errorsGenerated` currently mirrors every request throw (natural target
  // failures and fault-injected failures alike). The load window is
  // fault-agnostic — it does not distinguish client-side fault injections
  // from ordinary target errors — so `recovery_rate`
  // (`1 - failedRequests / errorsGenerated`) is only meaningful when a
  // caller stamps `errorsGenerated` independently as a pure fault-injection
  // count. Chaos assertions that need that distinction must not rely on
  // this driver-side increment alone.
  state.metrics.errorsGenerated++;
}

/** Issue one request: time it, classify resolve/throw, track it in-flight. */
function dispatchRequest(state: DispatchState): void {
  const { target, context, metrics, latencyTracker, inFlight } = state;
  const t0 = Date.now();
  metrics.totalRequests++;
  const run = (async (): Promise<void> => {
    try {
      await target({
        signal: context.abortSignal,
        correlationId: context.correlationId,
      });
      if (state.acceptResults) metrics.successfulRequests++;
    } catch (error) {
      recordRejectedRequest(state, error);
    } finally {
      if (state.acceptResults) latencyTracker.record(Date.now() - t0);
    }
  })();
  inFlight.add(run);
  void run.finally(() => inFlight.delete(run));
}

/** Block until fewer than `cap` requests are in flight (or the run aborts). */
async function awaitBelowCap(
  inFlight: Set<Promise<void>>,
  cap: number,
  signal: AbortSignal,
): Promise<void> {
  // Cap must be ≥ 1: with cap 0, `size >= 0` is always true and an empty
  // `Promise.race` hangs forever. resolveConcurrency already clamps; this is
  // defense in depth for any direct caller.
  const effectiveCap = Math.max(1, cap);
  while (inFlight.size >= effectiveCap && !signal.aborted) {
    // @sequential-ok -- intentional backpressure: each await frees one bounded in-flight slot before dispatch continues.
    await settleOneOrAbort(inFlight, signal);
  }
}

/** Wait for one request or cancellation without leaking abort listeners. */
function settleOneOrAbort(inFlight: Set<Promise<void>>, signal: AbortSignal): Promise<void> {
  if (signal.aborted || inFlight.size === 0) return Promise.resolve();
  return new Promise((resolve) => {
    let settled = false;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', finish);
      resolve();
    };
    signal.addEventListener('abort', finish, { once: true });
    void Promise.race(inFlight).then(finish, finish);
  });
}

type DrainOutcome = 'complete' | 'aborted' | 'deadline-exceeded';

/** Bound the terminal drain even when a supported BYO target ignores cancellation. */
function drainInFlight(inFlight: Set<Promise<void>>, signal: AbortSignal): Promise<DrainOutcome> {
  if (inFlight.size === 0) return Promise.resolve('complete');
  if (signal.aborted) return Promise.resolve('aborted');
  return new Promise((resolve) => {
    let settled = false;
    const finish = (outcome: DrainOutcome): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      resolve(outcome);
    };
    const onAbort = (): void => finish('aborted');
    const timer = setTimeout(() => finish('deadline-exceeded'), IN_FLIGHT_DRAIN_TIMEOUT_MS);
    signal.addEventListener('abort', onAbort, { once: true });
    void Promise.allSettled([...inFlight]).then(
      () => finish('complete'),
      () => finish('complete'),
    );
  });
}

/**
 * Classify a bounded terminal drain and mutate its aggregate counters.
 *
 * @throws {Error} When the run was cancelled so cancellation reaches the host boundary.
 */
function handleTerminalDrain(drainOutcome: DrainOutcome, state: DispatchState): void {
  const { context, inFlight, metrics } = state;
  if (context.abortSignal.aborted || drainOutcome === 'aborted') {
    const abandoned = inFlight.size;
    state.acceptResults = false;
    metrics.totalRequests = Math.max(0, metrics.totalRequests - abandoned);
    const reason = context.abortSignal.reason as unknown;
    if (normalizeFailure(reason).definition.kind === 'cancelled') throw reason;
    throw createCancelledError(`Simulation scenario '${context.scenarioId}' was cancelled.`);
  }
  if (drainOutcome !== 'deadline-exceeded') return;

  const abandoned = inFlight.size;
  state.acceptResults = false;
  metrics.failedRequests += abandoned;
  metrics.errorsGenerated += abandoned;
  state.firstFailure ??= normalizeFailure(
    createDeadlineError(`Abandoned ${String(abandoned)} target request(s) after drain deadline.`),
  );
  context.logger.warn('Target requests exceeded the in-flight drain deadline', {
    abandonedRequests: abandoned,
    timeoutMs: IN_FLIGHT_DRAIN_TIMEOUT_MS,
  });
}

/**
 * Run a single load-style window against a real `Target`.
 *
 * Per request: time the awaited `target` call, count success on resolve and
 * failure on non-cancellation throws, and record the measured latency. The
 * driver paces toward `workload.rps` with optional ramp-up and never exceeds
 * `resolveConcurrency(workload)` in-flight requests. In-flight requests are
 * drained before the latency snapshot is taken so it reflects the full window.
 */
export async function runLoadWindow(
  config: LoadWindowConfig,
  context: ScenarioExecutionContext,
  options: RunLoadWindowOptions,
): Promise<LoadWindowResult> {
  const { workload } = config;
  const targetRps = workload.rps;
  const maxInFlight = resolveConcurrency(workload);
  const metrics = createEmptyMetrics();
  const latencyTracker = new LatencyTracker();
  const inFlight = new Set<Promise<void>>();
  const state: DispatchState = {
    target: options.target,
    context,
    metrics,
    latencyTracker,
    inFlight,
    acceptResults: true,
  };
  const start = Date.now();
  const rampUpMs = (workload.rampUp ?? 0) * 1000;
  let cumulativeRateWeight = 0;
  let weightError = 0;
  let dispatchedRequests = 0;

  while (Date.now() - start < options.windowMs && !context.abortSignal.aborted) {
    const elapsed = Date.now() - start;
    const rampUpProgress = rampUpMs > 0 ? Math.min(1, elapsed / rampUpMs) : 1;
    // Accumulate dimensionless tick weights, then apply the target rate once.
    // Repeatedly adding the already-divided fractional request budget loses
    // exact long-window boundaries (3.3 RPS for ten seconds can stop at 32).
    // Keeping the target separate also preserves the floor for a rate that is
    // genuinely just below a whole-request boundary.
    const correctedWeight = rampUpProgress - weightError;
    const nextWeight = cumulativeRateWeight + correctedWeight;
    weightError = nextWeight - cumulativeRateWeight - correctedWeight;
    cumulativeRateWeight = nextWeight;
    const dueRequestTotal = Math.floor(
      (targetRps * cumulativeRateWeight) / (1000 / TICK_INTERVAL_MS),
    );
    const requestsThisTick = dueRequestTotal - dispatchedRequests;

    for (let i = 0; i < requestsThisTick; i++) {
      // Backpressure: block until below the in-flight cap, which paces RPS
      // toward what latency + concurrency actually allow.
      await awaitBelowCap(inFlight, maxInFlight, context.abortSignal);
      if (context.abortSignal.aborted) break;
      dispatchRequest(state);
      dispatchedRequests++;
    }

    await sleepTick(TICK_INTERVAL_MS, context.abortSignal);
  }

  // Drain any still-in-flight requests so the latency snapshot covers them,
  // but never beyond the bounded terminal budget.
  const drainOutcome = await drainInFlight(inFlight, context.abortSignal);
  handleTerminalDrain(drainOutcome, state);

  if (state.firstFailure !== undefined) {
    const projected = toPublicFailureProjection(state.firstFailure);
    context.logger.warn('Target request failed during the load window', {
      code: state.firstFailure.code,
      ...(typeof projected.message === 'string' ? { message: projected.message } : {}),
    });
  }

  const snapshot = latencyTracker.getLatencySnapshot();
  metrics.avgLatencyMs = snapshot.avgLatencyMs;
  metrics.p50LatencyMs = snapshot.p50LatencyMs;
  metrics.p95LatencyMs = snapshot.p95LatencyMs;
  metrics.p99LatencyMs = snapshot.p99LatencyMs;

  return {
    metrics,
    ...(state.firstFailure === undefined ? {} : { firstFailure: state.firstFailure }),
  };
}
