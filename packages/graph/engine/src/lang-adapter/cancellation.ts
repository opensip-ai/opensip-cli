import {
  createCancelledError,
  createDeadlineError,
  currentScope,
  isToolErrorLike,
} from '@opensip-cli/core';

/** Resolve an explicit adapter signal, falling back to the active host invocation. */
export function graphAdapterSignal(signal?: AbortSignal): AbortSignal | undefined {
  return signal ?? currentScope()?.abortSignal;
}

/**
 * Cooperative checkpoint shared by graph adapters.
 *
 * A typed host reason is already the most precise failure and must not be
 * downgraded. Native `AbortSignal.timeout()` reasons become the registered
 * deadline definition; every other abort uses the one core cancellation code.
 *
 * @throws {ToolError} When the effective signal is aborted.
 */
export function throwIfGraphAdapterAborted(signal: AbortSignal | undefined, stage: string): void {
  const effectiveSignal = graphAdapterSignal(signal);
  if (effectiveSignal?.aborted !== true) return;

  const reason: unknown = effectiveSignal.reason;
  if (isToolErrorLike(reason)) throw reason;
  if (reason instanceof Error && reason.name === 'TimeoutError') {
    throw createDeadlineError(`Graph adapter deadline exceeded during ${stage}.`);
  }
  throw createCancelledError(`Graph adapter cancelled during ${stage}.`);
}
