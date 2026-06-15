// @fitness-ignore-file performance-anti-patterns -- sequential await is the entire point of a retry/backoff loop; running attempts in parallel would defeat retry semantics
/**
 * Retry with exponential backoff for opensip-cli.
 * Designed for network calls (e.g., --report-to SARIF POST).
 */

export interface RetryOptions {
  /** Maximum number of attempts (including the first). Default: 3 */
  maxAttempts?: number;
  /** Initial delay in ms before first retry. Default: 500 */
  initialDelayMs?: number;
  /** Maximum delay in ms. Default: 10000 */
  maxDelayMs?: number;
  /** Multiplier for exponential backoff. Default: 2 */
  backoffMultiplier?: number;
  /** Called before each retry with attempt number, error, and delay. */
  onRetry?: (attempt: number, error: Error, delayMs: number) => void;
}

/**
 * Execute an async function with exponential backoff retry.
 * Throws the last error if all attempts fail.
 *
 * @throws {Error} The last error thrown by `fn` after exhausting
 *   `effectiveMaxAttempts` attempts. Non-Error throws are wrapped in
 *   an `Error` whose message is `String(value)`.
 */
export async function withRetry<T>(fn: () => Promise<T>, options: RetryOptions = {}): Promise<T> {
  const {
    maxAttempts = 3,
    initialDelayMs = 500,
    maxDelayMs = 10_000,
    backoffMultiplier = 2,
    onRetry,
  } = options;

  // Floor defensively against zero/negative/NaN/non-integer values. Math.max(1, NaN)
  // returns NaN per spec, so an unguarded `Math.max(1, maxAttempts)` would let
  // NaN reach the loop condition (attempt <= NaN is false) and throw
  // `undefined` for `lastError!`. Compare against effectiveMaxAttempts everywhere
  // so the original maxAttempts can never re-enter the comparison.
  const effectiveMaxAttempts = Number.isFinite(maxAttempts)
    ? Math.max(1, Math.floor(maxAttempts))
    : 1;
  let lastError: Error | undefined;

  for (let attempt = 1; attempt <= effectiveMaxAttempts; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));

      if (attempt >= effectiveMaxAttempts) break;

      // Exponential backoff with jitter
      const baseDelay = initialDelayMs * Math.pow(backoffMultiplier, attempt - 1);
      const jitter = Math.random() * baseDelay * 0.5;
      const delay = Math.min(baseDelay + jitter, maxDelayMs);

      onRetry?.(attempt, lastError, delay);

      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }

  // `lastError` is always assigned before reaching here: the loop runs
  // `effectiveMaxAttempts >= 1` times and assigns `lastError` on every catch
  // path before the loop terminates. Guard explicitly for type-safety.
  if (!lastError) throw new Error('withRetry: unreachable — no attempts ran');
  throw lastError;
}
