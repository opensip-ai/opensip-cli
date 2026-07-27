import {
  createCancelledError,
  createDeadlineError,
  currentScope,
  isToolErrorLike,
} from '@opensip-cli/core';

/**
 * Definition-preserving cooperative checkpoint for the TypeScript graph adapter.
 *
 * @throws {ToolError} When the effective adapter signal is aborted.
 */
export function throwIfGraphAdapterAborted(signal: AbortSignal | undefined, stage: string): void {
  const effectiveSignal = signal ?? currentScope()?.abortSignal;
  if (effectiveSignal?.aborted !== true) return;

  const reason: unknown = effectiveSignal.reason;
  if (isToolErrorLike(reason)) throw reason;
  if (reason instanceof Error && reason.name === 'TimeoutError') {
    throw createDeadlineError(`Graph adapter deadline exceeded during ${stage}.`);
  }
  throw createCancelledError(`Graph adapter cancelled during ${stage}.`);
}
