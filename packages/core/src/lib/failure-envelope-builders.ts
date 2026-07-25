/**
 * Leaf envelope builders + shared bounded-text primitives for the canonical
 * failure envelope (Plan 00 Phase 3). Split from `failure-envelope.ts`, which
 * keeps the recursive normalizer/aggregate plan; this module owns the
 * per-error-shape construction (`fromToolError` / `fromNativeError`) and the
 * budget constants both halves (and `failure-projection.ts`) share.
 */

import { sliceAvoidingSurrogateSplit } from './bounded-text.js';
import {
  coreSystemErrorCatalog,
  deepFreeze,
  definitionFromLegacyCode,
  FAILURE_PROJECTION_SCHEMA_VERSION,
} from './error-definition.js';
import {
  normalizeToolErrorDefinition,
  redactCredentialText,
  sanitizeErrorMetadata,
  type ToolError,
} from './errors.js';

import type {
  FailureCauseSummary,
  FailureEnvelope,
  FailureKnownStatus,
} from './failure-envelope-types.js';

export const FAILURE_ENVELOPE_VERSION = FAILURE_PROJECTION_SCHEMA_VERSION;

export const MAX_MESSAGE = 1000;
/** Shared with the projection egress layer (`failure-projection.ts`). */
export const MAX_OPERATOR_DETAIL = 2000;

/**
 * Shared with the projection egress layer (`failure-projection.ts`).
 *
 * Cuts on a code-point boundary. A bare `slice` can split a surrogate pair and leave a lone
 * high surrogate at the cut — the M18 hazard `bounded-text.ts` already guards for the
 * streaming capture path, reproduced here because failure text is exactly where astral
 * characters arrive (a file path, a commit message, a scanner's output).
 */
export function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  // Match report-failure style: length exactly `max` with ASCII ellipsis suffix.
  if (max <= 3) return sliceAvoidingSurrogateSplit(text, max);
  return `${sliceAvoidingSurrogateSplit(text, max - 3)}...`;
}

export function readField<T>(obj: object, key: string, read: () => T, fallback: T): T {
  try {
    return read();
  } catch {
    return fallback;
  }
}

export function freezeEnvelope(envelope: FailureEnvelope): FailureEnvelope {
  return deepFreeze(envelope);
}

export function fromToolError(
  error: ToolError,
  causes: readonly FailureCauseSummary[],
): FailureEnvelope {
  const code = readField(
    error,
    'code',
    () => (typeof error.code === 'string' ? error.code : 'SYSTEM_ERROR'),
    'SYSTEM_ERROR',
  );
  const definition =
    readField(
      error,
      'definition',
      () => normalizeToolErrorDefinition(error.definition),
      undefined,
    ) ?? definitionFromLegacyCode(code);
  const metadataInput = readField(error, 'metadata', () => error.metadata, {});
  const metadata = sanitizeErrorMetadata(metadataInput);
  const message = readField(
    error,
    'message',
    () => (typeof error.message === 'string' ? error.message : definition.code),
    definition.code,
  );
  const failureClass = readField(
    error,
    'failureClass',
    () => (typeof error.failureClass === 'string' ? error.failureClass : undefined),
    undefined,
  );
  const stderrTail = readField(
    error,
    'stderrTail',
    () => (typeof error.stderrTail === 'string' ? error.stderrTail : undefined),
    undefined,
  );
  // `known` is derived from DEFINITION RESOLUTION, not from ToolError-ness. Hardcoding
  // 'known' for every ToolError-like value contradicted the documented FailureKnownStatus
  // contract and the sibling fromNativeError, and — worse — it made Task 1.2's whole class of
  // defect invisible at runtime: a code whose head nobody mapped fell through to
  // UNKNOWN_FAILURE and was still reported as a confidently classified failure.
  const known: FailureKnownStatus =
    definition.code === 'CORE.SYSTEM.UNKNOWN_FAILURE' ? 'unknown' : 'known';
  return freezeEnvelope({
    schemaVersion: FAILURE_ENVELOPE_VERSION,
    known,
    message: truncate(message || definition.code, MAX_MESSAGE),
    operatorAction: definition.operatorAction,
    code: code || definition.code,
    definition,
    metadata,
    ...(failureClass === undefined ? {} : { failureClass }),
    causes,
    ...(stderrTail === undefined
      ? {}
      : { operatorDetail: truncate(redactCredentialText(stderrTail), MAX_OPERATOR_DETAIL) }),
  });
}

/**
 * Network errnos that mean "the peer or the resolver failed", not "your input is wrong".
 *
 * `NETWORK_ERROR` has been registered all along — `retry: 'transient'`, `exitClass:
 * 'report-failed'` — and nothing routed to it, so a refused connection during report egress
 * was reported as an internal invariant that must not be retried.
 *
 * `ETIMEDOUT` is deliberately absent: it is classified as a timeout above, which is the more
 * actionable of the two readings for the operator.
 */
const NETWORK_ERRNOS = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'EAI_AGAIN',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'ENOTFOUND',
  'EPIPE',
]);

/**
 * Recognize a cancellation without relying on `instanceof DOMException`.
 *
 * `AbortSignal.prototype.throwIfAborted()` and `new DOMException(…, 'AbortError')` are
 * `instanceof Error` but carry a NUMERIC `code` (20), so the errno switch below — guarded by
 * `typeof code === 'string'` — rejected them outright and every cancellation degraded to
 * `SYSTEM_ERROR` with `known: 'unknown'`. A cancelled run therefore looked exactly like an
 * internal invariant violation, which is the opposite of the truth: it is the most expected
 * failure a CLI has.
 *
 * The test is the `name`, read defensively, because that is the one field the platform,
 * userland polyfills and cross-realm copies all agree on.
 */
function isAbortLike(error: Error): boolean {
  const name = readField(error, 'name', () => error.name, '');
  return name === 'AbortError' || name === 'TimeoutError';
}

/** Structural read of a node errno, ignoring the numeric `code` DOMException carries. */
function readErrno(error: Error): string | undefined {
  return readField(
    error,
    'code',
    () => {
      const code = (error as NodeJS.ErrnoException).code;
      return typeof code === 'string' ? code : undefined;
    },
    undefined,
  );
}

/**
 * Classify an unclassified throwable into a registered definition.
 *
 * Order matters: cancellation and timeout are decided BEFORE the errno table, because an
 * abort carries no errno at all and would otherwise fall through to the catch-all.
 */
function classifyNative(error: Error, errno: string | undefined) {
  if (isAbortLike(error)) {
    const name = readField(error, 'name', () => error.name, '');
    // D5: cancellation has exactly one code. A `TimeoutError` abort is a deadline, which is
    // a distinct outcome — the caller can retry a deadline, never a user cancellation.
    return {
      definition: coreSystemErrorCatalog.require(
        name === 'TimeoutError' ? 'CORE.SYSTEM.DEADLINE_EXCEEDED' : 'CORE.SYSTEM.CANCELLED',
      ),
      known: 'known' as FailureKnownStatus,
    };
  }
  if (errno === 'ETIMEDOUT') {
    return {
      definition: coreSystemErrorCatalog.require('CORE.SYSTEM.DEADLINE_EXCEEDED'),
      known: 'known' as FailureKnownStatus,
    };
  }
  if (errno === 'ENOENT' || errno === 'ENOTDIR') {
    return {
      definition: definitionFromLegacyCode('NOT_FOUND'),
      known: 'known' as FailureKnownStatus,
    };
  }
  if (errno === 'EACCES' || errno === 'EPERM') {
    return {
      definition: coreSystemErrorCatalog.require('CORE.SYSTEM.PERMISSION'),
      known: 'known' as FailureKnownStatus,
    };
  }
  if (errno === 'ENOSPC' || errno === 'EMFILE' || errno === 'ENOMEM') {
    return {
      definition: coreSystemErrorCatalog.require('CORE.SYSTEM.RESOURCE'),
      known: 'known' as FailureKnownStatus,
    };
  }
  if (errno !== undefined && NETWORK_ERRNOS.has(errno)) {
    return {
      definition: definitionFromLegacyCode('NETWORK_ERROR'),
      known: 'known' as FailureKnownStatus,
    };
  }
  return {
    definition: definitionFromLegacyCode('SYSTEM_ERROR'),
    known: 'unknown' as FailureKnownStatus,
  };
}

export function fromNativeError(
  error: Error,
  causes: readonly FailureCauseSummary[],
): FailureEnvelope {
  const errno = readErrno(error);
  const { definition, known } = classifyNative(error, errno);

  const name = readField(
    error,
    'name',
    () => (typeof error.name === 'string' ? error.name : 'Error'),
    'Error',
  );
  const message = readField(
    error,
    'message',
    () => (typeof error.message === 'string' ? error.message : name),
    name,
  );
  return freezeEnvelope({
    schemaVersion: FAILURE_ENVELOPE_VERSION,
    known,
    message: truncate(message || name || 'Error', MAX_MESSAGE),
    operatorAction: definition.operatorAction,
    code: definition.code,
    definition,
    metadata: typeof errno === 'string' ? { errno } : {},
    causes,
    // Scrubbed: operator detail is assembled from raw error text, which routinely carries a
    // URL with an embedded token or a connection string (D8 — the host redacts at a choke
    // point rather than asking every caller to remember).
    operatorDetail: truncate(
      redactCredentialText(
        [name, message, typeof errno === 'string' ? `errno=${errno}` : '']
          .filter(Boolean)
          .join(' | '),
      ),
      MAX_OPERATOR_DETAIL,
    ),
  });
}
