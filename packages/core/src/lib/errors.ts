/**
 * Typed error classes and Result pattern for opensip-tools.
 */

// =============================================================================
// ERROR CLASSES
// =============================================================================

/**
 * Closed union of canonical error codes carried by `ToolError` and its
 * subclasses. Open by intent at the consumer layer — callers may pass
 * any string in `ToolErrorOptions.code` (subclass-specific subcodes
 * like `'VALIDATION.RECIPE.DUPLICATE'` are common) — but the base
 * default for each subclass is one of these literals, which means an
 * `instanceof` check pairs naturally with an exhaustive switch on
 * `code` for the no-override case.
 */
export type ToolErrorCode =
  | 'VALIDATION_ERROR'
  | 'NOT_FOUND'
  | 'SYSTEM_ERROR'
  | 'TIMEOUT'
  | 'NETWORK_ERROR'
  | 'CONFIGURATION_ERROR'
  | 'UNKNOWN_LIVE_VIEW';

/** Constructor options for {@link ToolError}: `code` plus arbitrary diagnostic metadata. */
export interface ToolErrorOptions extends ErrorOptions {
  code?: string;
  [key: string]: unknown;
}

/** Base class for all opensip-tools errors; carries a `code` for programmatic dispatch. */
export class ToolError extends Error {
  /**
   * Error code. Typed as a `string` super-set of `ToolErrorCode` because
   * subclass call sites may opt into a more specific subcode via
   * `ToolErrorOptions.code` (e.g. `'VALIDATION.RECIPE.DUPLICATE'`). For
   * exhaustive-switch use cases, narrow with the `ToolErrorCode` union
   * after an `instanceof` check.
   */
  readonly code: string;

  constructor(message: string, code: string, options?: ToolErrorOptions) {
    super(message, options);
    this.name = 'ToolError';
    this.code = code;
  }
}

/** Thrown when user-supplied input (config, CLI flags, recipes) fails schema or domain validation. */
export class ValidationError extends ToolError {
  constructor(message: string, options?: ToolErrorOptions) {
    super(message, options?.code ?? 'VALIDATION_ERROR', options);
    this.name = 'ValidationError';
  }
}

/** Thrown when a named resource (check, recipe, file, session) cannot be located. */
export class NotFoundError extends ToolError {
  constructor(message: string, options?: ToolErrorOptions) {
    super(message, options?.code ?? 'NOT_FOUND', options);
    this.name = 'NotFoundError';
  }
}

/** Thrown for internal invariant violations or unexpected runtime failures. */
export class SystemError extends ToolError {
  constructor(message: string, options?: ToolErrorOptions) {
    super(message, options?.code ?? 'SYSTEM_ERROR', options);
    this.name = 'SystemError';
  }
}

/** Thrown when an operation exceeds its allotted time budget. */
export class TimeoutError extends ToolError {
  readonly timeoutMs?: number;

  constructor(message: string, timeoutOrOptions?: number | ToolErrorOptions) {
    const options = typeof timeoutOrOptions === 'number' ? undefined : timeoutOrOptions;
    super(message, options?.code ?? 'TIMEOUT', options);
    this.name = 'TimeoutError';
    this.timeoutMs = typeof timeoutOrOptions === 'number' ? timeoutOrOptions : undefined;
  }
}

/** Thrown for HTTP or socket-level failures during outbound requests. */
export class NetworkError extends ToolError {
  readonly statusCode?: number;

  constructor(message: string, options?: ToolErrorOptions & { statusCode?: number }) {
    super(message, options?.code ?? 'NETWORK_ERROR', options);
    this.name = 'NetworkError';
    this.statusCode = options?.statusCode;
  }
}

/** Thrown when project or tool configuration is missing, malformed, or contradictory. */
export class ConfigurationError extends ToolError {
  constructor(message: string, options?: ToolErrorOptions) {
    super(message, options?.code ?? 'CONFIGURATION_ERROR', options);
    this.name = 'ConfigurationError';
  }
}

// =============================================================================
// RESULT PATTERN
// =============================================================================

export type Result<T, E = ToolError> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: E };

/** Constructs a success {@link Result} carrying `value`. */
export function ok<T>(value: T): Result<T, never> {
  return { ok: true, value };
}

/** Constructs a failure {@link Result} carrying `error`. */
export function err<E>(error: E): Result<never, E> {
  return { ok: false, error };
}

/** Wraps an async function in a try/catch, returning a Result instead of throwing. */
export async function tryCatchAsync<T>(fn: () => Promise<T>): Promise<Result<T, Error>> {
  try {
    return ok(await fn());
  } catch (error) {
    return err(error instanceof Error ? error : new Error(String(error)));
  }
}

/** Wraps a sync function in a try/catch, returning a Result instead of throwing. */
export function tryCatch<T>(fn: () => T): Result<T, Error> {
  try {
    return ok(fn());
  } catch (error) {
    return err(error instanceof Error ? error : new Error(String(error)));
  }
}
