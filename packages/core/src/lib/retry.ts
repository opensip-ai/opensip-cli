/**
 * Retry with exponential backoff for opensip-tools.
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
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  options: RetryOptions = {},
): Promise<T> {
  const {
    maxAttempts = 3,
    initialDelayMs = 500,
    maxDelayMs = 10_000,
    backoffMultiplier = 2,
    onRetry,
  } = options;

  const effectiveMaxAttempts = Math.max(1, maxAttempts);
  let lastError: Error | undefined;

  for (let attempt = 1; attempt <= effectiveMaxAttempts; attempt++) {
    try {
      return await fn();
    } catch (e) {
      lastError = e instanceof Error ? e : new Error(String(e));

      if (attempt >= maxAttempts) break;

      // Exponential backoff with jitter
      const baseDelay = initialDelayMs * Math.pow(backoffMultiplier, attempt - 1);
      const jitter = Math.random() * baseDelay * 0.5;
      const delay = Math.min(baseDelay + jitter, maxDelayMs);

      onRetry?.(attempt, lastError, delay);

      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }

  throw lastError!;
}
