/**
 * Logging-forcing consumers for the {@link Result} pattern.
 *
 * `Result<T, E>` (see `./errors.ts`) is deliberately a bare discriminated
 * union with no methods, so — like `ok`/`err`/`tryCatch` — these live as
 * free functions rather than instance methods. They exist to make the
 * failure path *observable by construction*: you cannot recover from a
 * `Result` failure through these without emitting a structured log event.
 *
 * The idea is borrowed from the chronoswap foundation `Result`
 * (`unwrapOrLog` / `matchLog`), adapted to OpenSIP's `logger` seam (the
 * house style carries `evt` as a field on the logged object).
 *
 * These complement — they do not replace — the `error-handling-quality`
 * fitness check, which catches silent handling that bypasses them (bare
 * `.value` access, empty catches, other error styles). Defense in depth:
 * the API makes the observable path the ergonomic default; the check
 * catches everything that routes around it.
 *
 * This module (not `errors.ts`) owns the logger coupling so the base
 * error/`Result` types stay dependency-free.
 */
import { formatUnknownErrorMessage, type Result } from './errors.js';
import { logger, type LogLevel } from './logger.js';

/**
 * Structured context for a `Result` failure log.
 *
 * `evt` — a stable dotted event name, e.g. `'recipe.load.failed'` — is
 * required so the failure is always attributable. `level` defaults to
 * `'warn'` (recovering with a fallback is a handled degradation, not a
 * fatal). Any further fields are emitted as structured log context;
 * `evt`/`level` are control fields and are never duplicated into it.
 */
export interface ResultLogContext {
  readonly evt: string;
  readonly level?: LogLevel;
  readonly [key: string]: unknown;
}

/**
 * Return the success value, or — on failure — log the error at
 * `logContext.level` (default `'warn'`) and return `defaultValue`. The
 * sanctioned way to recover from a `Result` with a fallback: the failure
 * cannot be swallowed without an event.
 *
 * @example
 * const recipe = unwrapOrLog(loadRecipe(id), null, { evt: 'recipe.load.failed', id });
 */
// eslint-disable-next-line sonarjs/function-return-type -- intentional value-or-fallback union (T | D); the canonical unwrap-with-default signature.
export function unwrapOrLog<T, E, D>(
  result: Result<T, E>,
  defaultValue: D,
  logContext: ResultLogContext,
): T | D {
  if (result.ok) {
    return result.value;
  }
  logResultFailure(result.error, logContext);
  return defaultValue;
}

/**
 * Pattern-match a `Result`, logging the error (at `logContext.level`,
 * default `'warn'`) before the `onErr` branch runs — so the error branch
 * is always observable even if `onErr` discards the error.
 *
 * @example
 * const name = matchLog(
 *   fetchUser(id),
 *   (user) => user.name,
 *   () => 'unknown',
 *   { evt: 'user.fetch.failed', id },
 * );
 */
export function matchLog<T, E, U>(
  result: Result<T, E>,
  onOk: (value: T) => U,
  onErr: (error: E) => U,
  logContext: ResultLogContext,
): U {
  if (result.ok) {
    return onOk(result.value);
  }
  logResultFailure(result.error, logContext);
  return onErr(result.error);
}

/**
 * Emit the one structured failure event shared by {@link unwrapOrLog} and
 * {@link matchLog}. A readable `message` is always included (the raw `err`
 * may serialize poorly), alongside the caller's context fields.
 */
function logResultFailure(error: unknown, logContext: ResultLogContext): void {
  const { evt, level = 'warn', ...context } = logContext;
  logger[level]({
    ...context,
    evt,
    message: formatUnknownErrorMessage(error),
    err: error,
  });
}
