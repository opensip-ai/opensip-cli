/**
 * Canonical abort-aware retry with exponential backoff (Plan 00 Phase 4).
 *
 * Default retry classification uses FailureEnvelope / definition.retry when
 * available. Callers own max attempts, deadline, and idempotency policy.
 * Clock, random, and sleep are injectable for deterministic tests.
 */

import { normalizeFailure } from './failure-envelope.js';
import { ToolError, createToolError } from './errors.js';
import { coreSystemErrorCatalog } from './error-definition.js';

const ABSOLUTE_ATTEMPT_BACKSTOP = 100;

export type JitterMode = 'full' | 'equal' | 'decorrelated' | 'none';

export interface RetryClock {
  readonly now: () => number;
  readonly random: () => number;
  readonly sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
}

export interface RetryOptions {
  /** Maximum number of attempts (including the first). Default: 3 */
  maxAttempts?: number;
  /** Initial delay in ms before first retry. Default: 500 */
  initialDelayMs?: number;
  /** Maximum delay in ms. Default: 10000 */
  maxDelayMs?: number;
  /** Multiplier for exponential backoff. Default: 2 */
  backoffMultiplier?: number;
  /** Jitter strategy. Default: full (0..base). */
  jitter?: JitterMode;
  /** Abort entire retry train (operation + backoff). */
  signal?: AbortSignal;
  /** Absolute deadline (epoch ms). Retries stop when exceeded. */
  deadlineMs?: number;
  /**
   * When true (default), use definition.retry: never/transient/caller-policy.
   * caller-policy retries unless shouldRetry returns false.
   */
  useDefinitionRetry?: boolean;
  /** Override classification; return false to stop retrying. */
  shouldRetry?: (error: unknown, attempt: number) => boolean;
  /**
   * Called before each retry. Isolated — throws are swallowed and cannot
   * change the operation outcome.
   */
  onRetry?: (attempt: number, error: Error, delayMs: number) => void;
  /** Injectable clock/random/sleep for tests. */
  clock?: RetryClock;
}

function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(createCancelledError('Retry aborted during backoff'));
      return;
    }
    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);
    // Do not keep short-lived CLI processes alive for pending backoff.
    timer.unref?.();
    const onAbort = () => {
      cleanup();
      reject(createCancelledError('Retry aborted during backoff'));
    };
    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

const defaultClock: RetryClock = {
  now: () => Date.now(),
  random: () => Math.random(),
  sleep: defaultSleep,
};

/** Typed cancellation failure (definition-backed). */
export function createCancelledError(message = 'Operation cancelled'): ToolError {
  const base = coreSystemErrorCatalog.get('TIMEOUT');
  const def = {
    ...(base ?? coreSystemErrorCatalog.require('SYSTEM_ERROR')),
    code: 'CORE.SYSTEM.CANCELLED',
    kind: 'cancelled' as const,
    retry: 'never' as const,
    exitClass: 'cancelled' as const,
    operatorAction: 'The operation was cancelled. Re-run if the work is still needed.',
    source: 'application' as const,
    defaultResponsibility: 'user' as const,
    severity: 'error' as const,
    exposure: 'public' as const,
    stability: 'public' as const,
    lifecycle: 'active' as const,
    owner: coreSystemErrorCatalog.owner,
  };
  return createToolError(def, message);
}

/** Deadline / outer budget exhaustion. */
export function createDeadlineError(message = 'Operation deadline exceeded'): ToolError {
  const def = coreSystemErrorCatalog.require('TIMEOUT');
  return createToolError(def, message);
}

/**
 * Classify whether an error should be retried under definition defaults.
 * Untyped/native errors remain retryable (legacy network-client behavior).
 * Known ToolError definitions drive never/transient/caller-policy.
 */
export function defaultShouldRetry(error: unknown): boolean {
  if (error instanceof ToolError) {
    if (error.code === 'CORE.SYSTEM.CANCELLED') return false;
    if (error.definition.kind === 'cancelled') return false;
    if (error.definition.retry === 'never') return false;
    if (error.definition.retry === 'transient') return true;
    // caller-policy: skip permanent user/application classes
    if (
      error.definition.kind === 'validation' ||
      error.definition.kind === 'not-found' ||
      error.definition.kind === 'permission'
    ) {
      return false;
    }
    return true;
  }
  // Native Error / primitives: allow retry (withRetry historical default).
  const envelope = normalizeFailure(error);
  if (envelope.definition.kind === 'cancelled') return false;
  return true;
}

function computeDelay(
  attempt: number,
  options: {
    initialDelayMs: number;
    maxDelayMs: number;
    backoffMultiplier: number;
    jitter: JitterMode;
    random: () => number;
    prevDelay?: number;
  },
): number {
  // Overflow-safe exponent: cap growth
  const exp = Math.min(attempt - 1, 20);
  const base = Math.min(
    options.initialDelayMs * Math.pow(options.backoffMultiplier, exp),
    options.maxDelayMs,
  );
  const r = options.random();
  switch (options.jitter) {
    case 'none':
      return Math.min(base, options.maxDelayMs);
    case 'equal':
      return Math.min(base * 0.5 + r * base * 0.5, options.maxDelayMs);
    case 'decorrelated': {
      const prev = options.prevDelay ?? options.initialDelayMs;
      const next = Math.min(options.maxDelayMs, r * (prev * 3));
      return Math.max(options.initialDelayMs, next);
    }
    case 'full':
    default:
      return Math.min(r * base, options.maxDelayMs);
  }
}

function safeOnRetry(
  onRetry: RetryOptions['onRetry'],
  attempt: number,
  error: Error,
  delayMs: number,
): void {
  if (!onRetry) return;
  try {
    onRetry(attempt, error, delayMs);
  } catch {
    // Observer isolation — never corrupt the operation outcome.
  }
}

/**
 * Execute an async function with exponential backoff retry.
 * Throws the last error if all attempts fail, or a cancellation/deadline error.
 */
export async function withRetry<T>(fn: () => Promise<T>, options: RetryOptions = {}): Promise<T> {
  const {
    maxAttempts = 3,
    initialDelayMs = 500,
    maxDelayMs = 10_000,
    backoffMultiplier = 2,
    jitter = 'full',
    signal,
    deadlineMs,
    useDefinitionRetry = true,
    shouldRetry: shouldRetryOverride,
    onRetry,
    clock = defaultClock,
  } = options;

  const effectiveMaxAttempts = Number.isFinite(maxAttempts)
    ? Math.max(1, Math.floor(maxAttempts))
    : 1;
  const hardCap = Math.min(effectiveMaxAttempts, ABSOLUTE_ATTEMPT_BACKSTOP);
  let lastError: Error | undefined;
  let prevDelay: number | undefined;

  for (let attempt = 1; attempt <= hardCap; attempt++) {
    if (signal?.aborted) {
      throw createCancelledError('Retry aborted before attempt');
    }
    if (deadlineMs !== undefined && clock.now() >= deadlineMs) {
      throw createDeadlineError();
    }

    try {
      return await fn();
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));

      if (attempt >= hardCap) break;

      const allowByDef = useDefinitionRetry ? defaultShouldRetry(error) : true;
      const allowByCaller =
        shouldRetryOverride === undefined ? true : shouldRetryOverride(error, attempt);
      if (!allowByDef || !allowByCaller) {
        throw lastError;
      }

      let delay = computeDelay(attempt, {
        initialDelayMs,
        maxDelayMs,
        backoffMultiplier,
        jitter,
        random: clock.random,
        prevDelay,
      });
      prevDelay = delay;

      if (deadlineMs !== undefined) {
        const remaining = deadlineMs - clock.now();
        if (remaining <= 0) throw createDeadlineError();
        delay = Math.min(delay, remaining);
      }

      safeOnRetry(onRetry, attempt, lastError, delay);
      await clock.sleep(delay, signal);
    }
  }

  if (!lastError) throw new Error('withRetry: unreachable — no attempts ran');
  throw lastError;
}

/**
 * Abort-aware sleep used by execution retry and withRetry.
 */
export function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return defaultSleep(ms, signal);
}
