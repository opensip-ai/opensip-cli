// @fitness-ignore-file performance-anti-patterns -- same: sequential await is the entire point of a retry/backoff loop (same waiver as lib/retry.ts and the fitness retry this hoists)
/**
 * runWithRetry — the generic retry-with-backoff primitive the execution substrate
 * uses (north-star §5.8, launch).
 *
 * Hoisted from fitness's `executeWithRetry` (the proven shape): retry ONLY on a
 * thrown error, never re-throw (return `lastError` instead), and skip retry for a
 * caller-named class of errors (fitness: an abort). The hardcoded
 * `CheckAbortedError` check becomes a `shouldNotRetry` predicate, and the fixed
 * backoff is configurable — so fitness re-points to this with byte-identical
 * behaviour (default backoff `[1000, 2000]`, the same delays it used).
 *
 * Distinct from `withRetry` (`lib/retry.ts`), which is the network-oriented
 * throw-on-exhaustion retry for `--report-to`; this one returns an outcome and is
 * the per-unit execution retry.
 */

/** Default per-attempt backoff delays (ms) — fitness's historical `[1000, 2000]`. */
const DEFAULT_BACKOFF_MS = [1000, 2000] as const;

export interface PipelineRetryOptions {
  /** When false (or `maxRetries <= 0`), the function runs once with no retry. */
  readonly enabled: boolean;
  readonly maxRetries: number;
  /** Errors for which retry is skipped entirely (e.g. an abort). Default: none. */
  readonly shouldNotRetry?: (error: unknown) => boolean;
  /** Per-attempt backoff delays (ms). Default `[1000, 2000]` (last value repeats). */
  readonly backoffMs?: readonly number[];
}

/** Outcome of a retry-wrapped run. `result === undefined` ⇔ every attempt threw. */
export interface PipelineRetryOutcome<T> {
  readonly result: T | undefined;
  readonly lastError: unknown;
  readonly retryCount: number;
  readonly wasRetried: boolean;
}

function backoff(attempt: number, delays: readonly number[]): Promise<void> {
  const delay = delays[attempt] ?? delays.at(-1) ?? 2000;
  return new Promise((resolve) => setTimeout(resolve, delay));
}

/**
 * Run `fn` with retry. Retries only on a thrown error (up to `maxRetries`), never
 * re-throws, and short-circuits for `shouldNotRetry` errors. Mirrors fitness's
 * former `executeWithRetry` exactly (same default backoff, same return shape).
 */
export async function runWithRetry<T>(
  fn: () => Promise<T>,
  options: PipelineRetryOptions,
): Promise<PipelineRetryOutcome<T>> {
  const delays = options.backoffMs ?? DEFAULT_BACKOFF_MS;
  try {
    const result = await fn();
    return { result, lastError: undefined, retryCount: 0, wasRetried: false };
  } catch (firstError) {
    if (options.shouldNotRetry?.(firstError) === true) {
      return { result: undefined, lastError: firstError, retryCount: 0, wasRetried: false };
    }
    if (!options.enabled || options.maxRetries <= 0) {
      return { result: undefined, lastError: firstError, retryCount: 0, wasRetried: false };
    }

    let lastError: unknown = firstError;
    for (let attempt = 0; attempt < options.maxRetries; attempt++) {
      await backoff(attempt, delays);
      try {
        const result = await fn();
        return { result, lastError: undefined, retryCount: attempt + 1, wasRetried: true };
      } catch (retryError) {
        lastError = retryError;
      }
    }
    return { result: undefined, lastError, retryCount: options.maxRetries, wasRetried: true };
  }
}
