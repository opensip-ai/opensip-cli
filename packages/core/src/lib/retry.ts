/**
 * Canonical abort-aware retry with exponential backoff (Plan 00 Phase 4).
 *
 * Default retry classification uses FailureEnvelope / definition.retry when
 * available. Callers own max attempts, deadline, and idempotency policy.
 * Clock, random, and sleep are injectable for deterministic tests.
 */

import { coreSystemErrorCatalog } from './error-definition.js';
import {
  createToolError,
  formatUnknownErrorMessage,
  isToolErrorLike,
  normalizeToolErrorDefinition,
  type ToolError,
} from './errors.js';
import { executionInvariantError } from './execution-invariant-error.js';
import { normalizeFailure } from './failure-envelope.js';

const ABSOLUTE_ATTEMPT_BACKSTOP = 100;

/** Backoff jitter strategy applied to each computed delay. */
export type JitterMode = 'full' | 'equal' | 'decorrelated' | 'none';

/** Injectable time source for deterministic retry tests (clock, random, sleep). */
export interface RetryClock {
  readonly now: () => number;
  readonly random: () => number;
  readonly sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
}

/** Caller-owned retry policy: attempts, backoff, deadline, and classification. */
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
  /** Override a computed delay (for example an HTTP Retry-After hint). */
  retryDelayMs?: (error: unknown, attempt: number, computedDelayMs: number) => number | undefined;
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
  return createToolError(coreSystemErrorCatalog.require('CORE.SYSTEM.CANCELLED'), message);
}

/** Deadline / outer budget exhaustion. */
export function createDeadlineError(message = 'Operation deadline exceeded'): ToolError {
  const def = coreSystemErrorCatalog.require('CORE.SYSTEM.DEADLINE_EXCEEDED');
  return createToolError(def, message);
}

/**
 * Classify whether an error should be retried under definition defaults.
 * Untyped/native errors remain retryable (legacy network-client behavior).
 * Known ToolError definitions drive never/transient/caller-policy.
 */
export function defaultShouldRetry(error: unknown): boolean {
  if (isToolErrorLike(error)) {
    const definition = normalizeToolErrorDefinition(error.definition);
    if (definition === undefined) return false;
    if (error.code === 'CORE.SYSTEM.CANCELLED') return false;
    if (definition.kind === 'cancelled') return false;
    if (definition.retry === 'never') return false;
    if (definition.retry === 'transient') return true;
    // caller-policy: skip permanent user/application classes
    if (
      definition.kind === 'validation' ||
      definition.kind === 'not-found' ||
      definition.kind === 'permission'
    ) {
      return false;
    }
    return true;
  }
  // Native Error / primitives: allow retry (withRetry historical default).
  const envelope = normalizeFailure(error);
  return envelope.definition.kind !== 'cancelled';
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
  let random = 0;
  try {
    random = options.random();
  } catch {
    // @swallow-ok intentional degradation: a broken jitter source becomes zero
    // rather than masking the operation failure being retried.
  }
  const r = Number.isFinite(random) ? Math.min(1, Math.max(0, random)) : 0;
  switch (options.jitter) {
    case 'none': {
      return Math.min(base, options.maxDelayMs);
    }
    case 'equal': {
      return Math.min(base * 0.5 + r * base * 0.5, options.maxDelayMs);
    }
    case 'decorrelated': {
      const prev = options.prevDelay ?? options.initialDelayMs;
      const next = Math.min(options.maxDelayMs, r * (prev * 3));
      return Math.max(options.initialDelayMs, next);
    }
    case 'full': {
      return Math.min(r * base, options.maxDelayMs);
    }
    default: {
      return Math.min(r * base, options.maxDelayMs);
    }
  }
}

/** @throws {unknown} The attempt failure, cancellation reason, or deadline failure. */
async function runAbortableAttempt<T>(
  fn: () => Promise<T>,
  signal?: AbortSignal,
  deadline?: { readonly at: number; readonly now: () => number },
): Promise<T> {
  if (signal?.aborted) throw createCancelledError('Retry aborted before attempt');
  if (deadline !== undefined && deadline.now() >= deadline.at) throw createDeadlineError();

  let detach = (): void => undefined;
  const races: Promise<T>[] = [Promise.resolve().then(fn)];
  if (signal !== undefined) {
    races.push(
      new Promise<never>((_resolve, reject) => {
        const onAbort = () => reject(createCancelledError('Retry aborted during attempt'));
        signal.addEventListener('abort', onAbort, { once: true });
        detach = () => signal.removeEventListener('abort', onAbort);
      }),
    );
  }
  let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
  if (deadline !== undefined) {
    races.push(
      new Promise<never>((_resolve, reject) => {
        const checkDeadline = (): void => {
          const remaining = deadline.at - deadline.now();
          if (remaining <= 0) {
            reject(createDeadlineError());
            return;
          }
          deadlineTimer = setTimeout(checkDeadline, Math.min(remaining, 2_147_483_647));
        };
        checkDeadline();
      }),
    );
  }
  try {
    return await Promise.race(races);
  } finally {
    detach();
    if (deadlineTimer !== undefined) clearTimeout(deadlineTimer);
  }
}

function callerAllowsRetry(
  shouldRetry: RetryOptions['shouldRetry'],
  error: unknown,
  attempt: number,
): boolean {
  if (shouldRetry === undefined) return true;
  try {
    return shouldRetry(error, attempt);
  } catch {
    // @swallow-ok probe/optional capability: a broken policy callback stops retry and preserves the original failure.
    return false;
  }
}

function callerDelay(
  override: RetryOptions['retryDelayMs'],
  error: unknown,
  attempt: number,
  computed: number,
): number {
  if (override === undefined) return computed;
  try {
    const value = override(error, attempt, computed);
    return value !== undefined && Number.isFinite(value) ? Math.max(0, value) : computed;
  } catch {
    return computed;
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
 * @throws {ToolError} CORE.SYSTEM.CANCELLED when the signal aborts, or CORE.SYSTEM.DEADLINE_EXCEEDED when the deadline is exceeded.
 * @throws The last thrown error when all attempts are exhausted or retry is declined.
 */
// eslint-disable-next-line sonarjs/cognitive-complexity -- attempt/deadline/signal branches are load-bearing and clearer inline
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
    retryDelayMs,
    onRetry,
    clock = defaultClock,
  } = options;

  const effectiveMaxAttempts = Number.isFinite(maxAttempts)
    ? Math.max(1, Math.floor(maxAttempts))
    : 1;
  const hardCap = Math.min(effectiveMaxAttempts, ABSOLUTE_ATTEMPT_BACKSTOP);
  const effectiveInitialDelay =
    Number.isFinite(initialDelayMs) && initialDelayMs >= 0 ? initialDelayMs : 500;
  const effectiveMaxDelay = Number.isFinite(maxDelayMs) && maxDelayMs >= 0 ? maxDelayMs : 10_000;
  const effectiveMultiplier =
    Number.isFinite(backoffMultiplier) && backoffMultiplier >= 1 ? backoffMultiplier : 2;
  const effectiveDeadlineMs =
    deadlineMs !== undefined && Number.isFinite(deadlineMs) ? deadlineMs : undefined;
  let lastError: Error | undefined;
  let prevDelay: number | undefined;

  for (let attempt = 1; attempt <= hardCap; attempt++) {
    if (signal?.aborted) {
      throw createCancelledError('Retry aborted before attempt');
    }
    if (effectiveDeadlineMs !== undefined && clock.now() >= effectiveDeadlineMs) {
      throw createDeadlineError();
    }

    try {
      return await runAbortableAttempt(
        fn,
        signal,
        effectiveDeadlineMs === undefined ? undefined : { at: effectiveDeadlineMs, now: clock.now },
      );
    } catch (error) {
      try {
        lastError = error instanceof Error ? error : new Error(formatUnknownErrorMessage(error));
      } catch {
        lastError = new Error(formatUnknownErrorMessage(error));
      }

      if (attempt >= hardCap) break;

      const allowByDef = useDefinitionRetry ? defaultShouldRetry(error) : true;
      const allowByCaller = callerAllowsRetry(shouldRetryOverride, error, attempt);
      if (!allowByDef || !allowByCaller) {
        throw lastError;
      }

      let delay = computeDelay(attempt, {
        initialDelayMs: effectiveInitialDelay,
        maxDelayMs: effectiveMaxDelay,
        backoffMultiplier: effectiveMultiplier,
        jitter,
        random: clock.random,
        prevDelay,
      });
      delay = callerDelay(retryDelayMs, error, attempt, delay);
      delay = Math.min(delay, effectiveMaxDelay);
      prevDelay = delay;

      if (effectiveDeadlineMs !== undefined) {
        const remaining = effectiveDeadlineMs - clock.now();
        if (remaining <= 0) throw createDeadlineError();
        delay = Math.min(delay, remaining);
      }

      safeOnRetry(onRetry, attempt, lastError, delay);
      // Enforce cancellation even when an injected/adapted clock accidentally
      // ignores the signal. The losing sleep promise remains observed by the
      // race, so a late rejection cannot become unhandled.
      await runAbortableAttempt(
        () => clock.sleep(delay, signal),
        signal,
        effectiveDeadlineMs === undefined ? undefined : { at: effectiveDeadlineMs, now: clock.now },
      );
    }
  }

  if (!lastError)
    throw executionInvariantError(
      'with-retry-no-attempts',
      'withRetry: unreachable — no attempts ran',
    );
  throw lastError;
}

/**
 * Abort-aware sleep used by execution retry and withRetry.
 */
export function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return defaultSleep(ms, signal);
}
