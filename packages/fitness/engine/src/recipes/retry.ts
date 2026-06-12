/**
 * @fileoverview Retry logic for fitness check execution.
 *
 * Release 2.13.0: the retry implementation was hoisted into the shared execution
 * substrate (`runWithRetry`, `@opensip-cli/core`). This module is now a thin
 * fitness-flavoured wrapper that pins the abort-aware predicate (a
 * `CheckAbortedError` is never retried) and preserves the historical return shape,
 * so call sites and tests are unchanged.
 */

import { runWithRetry } from '@opensip-cli/core';

import { CheckAbortedError } from '../framework/execution-context.js';

/** Configuration for retry behavior */
export interface RetryOptions {
  readonly enabled: boolean;
  readonly maxRetries: number;
  readonly checkId: string;
  readonly checkSlug: string;
}

/** Result of a retry-wrapped function execution */
export interface RetryResult<T> {
  readonly result: T | undefined;
  readonly lastError: unknown;
  readonly retryCount: number;
  readonly wasRetried: boolean;
}

/**
 * Execute a function with retry logic via the shared substrate.
 * Only retries when the function throws. CheckAbortedError is never retried.
 */
export async function executeWithRetry<T>(
  fn: () => Promise<T>,
  options: RetryOptions,
): Promise<RetryResult<T>> {
  return runWithRetry(fn, {
    enabled: options.enabled,
    maxRetries: options.maxRetries,
    shouldNotRetry: (error) => error instanceof CheckAbortedError,
  });
}
