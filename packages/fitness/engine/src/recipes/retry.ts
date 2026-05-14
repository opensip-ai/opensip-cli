// @fitness-ignore-file error-handling-suite -- catch blocks delegate errors through established patterns
/**
 * @fileoverview Retry logic for fitness check execution
 *
 * Provides exponential backoff retry wrapper for transient check failures.
 */

import { CheckAbortedError } from '../framework/execution-context.js'

const BACKOFF_DELAYS_MS = [1000, 2000] as const

/** Configuration for retry behavior */
export interface RetryOptions {
  readonly enabled: boolean
  readonly maxRetries: number
  readonly checkId: string
  readonly checkSlug: string
}

/** Result of a retry-wrapped function execution */
export interface RetryResult<T> {
  readonly result: T | undefined
  readonly lastError: unknown
  readonly retryCount: number
  readonly wasRetried: boolean
}

function backoff(attempt: number): Promise<void> {
  const delay = BACKOFF_DELAYS_MS[attempt] ?? BACKOFF_DELAYS_MS[BACKOFF_DELAYS_MS.length - 1] ?? 2000
  return new Promise((resolve) => setTimeout(resolve, delay))
}

/**
 * Execute a function with retry logic.
 * Only retries when the function throws. CheckAbortedError is never retried.
 */
export async function executeWithRetry<T>(
  fn: () => Promise<T>,
  options: RetryOptions,
): Promise<RetryResult<T>> {
  try {
    const result = await fn()
    return { result, lastError: undefined, retryCount: 0, wasRetried: false }
  } catch (firstError) {
    if (firstError instanceof CheckAbortedError) {
      return { result: undefined, lastError: firstError, retryCount: 0, wasRetried: false }
    }

    if (!options.enabled || options.maxRetries <= 0) {
      return { result: undefined, lastError: firstError, retryCount: 0, wasRetried: false }
    }

    let lastError: unknown = firstError

    for (let attempt = 0; attempt < options.maxRetries; attempt++) {
      // @fitness-ignore-next-line performance-anti-patterns -- sequential retry with backoff is inherently serial
      await backoff(attempt)

      try {
        const result = await fn()
        return { result, lastError: undefined, retryCount: attempt + 1, wasRetried: true }
      } catch (retryError) {
        lastError = retryError
      }
    }

    return { result: undefined, lastError, retryCount: options.maxRetries, wasRetried: true }
  }
}
