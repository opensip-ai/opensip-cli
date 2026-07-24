/**
 * Worker IPC failure wire projection (Plan 00 Phase 5).
 *
 * Serialize only machine-safe failure axes — never raw Error/cause objects.
 */

import { canonicalToolErrorCode, isToolErrorLike } from '../lib/errors.js';
import { normalizeFailure, toMachineFailureProjection } from '../lib/failure-envelope.js';

import { getWorkerErrorFailureClass } from './worker-error-failure-class.js';

/** Schema version for worker failure payloads. */
export const WORKER_FAILURE_WIRE_VERSION = 1;

export interface WorkerFailureWire {
  readonly wireVersion: typeof WORKER_FAILURE_WIRE_VERSION;
  readonly message: string;
  readonly code?: string;
  readonly detailCode?: string;
  readonly failureClass?: string;
  /** Machine projection of FailureEnvelope (no operatorDetail/stack). */
  readonly failure?: Readonly<Record<string, unknown>>;
}

/**
 * Build a structured-clone-safe failure payload from any thrown value.
 */
export function toWorkerFailureWire(error: unknown): WorkerFailureWire {
  const envelope = normalizeFailure(error);
  const machine = toMachineFailureProjection(envelope);
  const failureClass = getWorkerErrorFailureClass(error);

  let code: string | undefined;
  let detailCode: string | undefined;
  if (isToolErrorLike(error)) {
    code = canonicalToolErrorCode(error);
    detailCode = error.code === code ? undefined : error.code;
  } else if (envelope.known === 'known') {
    code = envelope.code;
  }

  return {
    wireVersion: WORKER_FAILURE_WIRE_VERSION,
    message: envelope.message,
    ...(code === undefined ? {} : { code }),
    ...(detailCode === undefined ? {} : { detailCode }),
    ...(failureClass === undefined ? {} : { failureClass }),
    failure: machine,
  };
}
