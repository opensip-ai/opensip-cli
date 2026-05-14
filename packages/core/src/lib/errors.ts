/**
 * Typed error classes and Result pattern for opensip-tools.
 */

// =============================================================================
// ERROR CLASSES
// =============================================================================

export interface ToolErrorOptions extends ErrorOptions {
  code?: string;
  [key: string]: unknown;
}

export class ToolError extends Error {
  readonly code: string;

  constructor(message: string, code: string, options?: ToolErrorOptions) {
    super(message, options);
    this.name = 'ToolError';
    this.code = code;
  }
}

export class ValidationError extends ToolError {
  constructor(message: string, options?: ToolErrorOptions) {
    super(message, options?.code ?? 'VALIDATION_ERROR', options);
    this.name = 'ValidationError';
  }
}

export class NotFoundError extends ToolError {
  constructor(message: string, options?: ToolErrorOptions) {
    super(message, options?.code ?? 'NOT_FOUND', options);
    this.name = 'NotFoundError';
  }
}

export class SystemError extends ToolError {
  constructor(message: string, options?: ToolErrorOptions) {
    super(message, options?.code ?? 'SYSTEM_ERROR', options);
    this.name = 'SystemError';
  }
}

export class TimeoutError extends ToolError {
  readonly timeoutMs?: number;

  constructor(message: string, timeoutOrOptions?: number | ToolErrorOptions) {
    const options = typeof timeoutOrOptions === 'number' ? undefined : timeoutOrOptions;
    super(message, options?.code ?? 'TIMEOUT', options);
    this.name = 'TimeoutError';
    this.timeoutMs = typeof timeoutOrOptions === 'number' ? timeoutOrOptions : undefined;
  }
}

export class NetworkError extends ToolError {
  readonly statusCode?: number;

  constructor(message: string, options?: ToolErrorOptions & { statusCode?: number }) {
    super(message, options?.code ?? 'NETWORK_ERROR', options);
    this.name = 'NetworkError';
    this.statusCode = options?.statusCode;
  }
}

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

export function ok<T>(value: T): Result<T, never> {
  return { ok: true, value };
}

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
