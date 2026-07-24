/**
 * Leaf envelope builders + shared bounded-text primitives for the canonical
 * failure envelope (Plan 00 Phase 3). Split from `failure-envelope.ts`, which
 * keeps the recursive normalizer/aggregate plan; this module owns the
 * per-error-shape construction (`fromToolError` / `fromNativeError`) and the
 * budget constants both halves (and `failure-projection.ts`) share.
 */

import {
  coreSystemErrorCatalog,
  deepFreeze,
  definitionFromLegacyCode,
  FAILURE_PROJECTION_SCHEMA_VERSION,
} from './error-definition.js';
import { normalizeToolErrorDefinition, sanitizeErrorMetadata, type ToolError } from './errors.js';

import type {
  FailureCauseSummary,
  FailureEnvelope,
  FailureKnownStatus,
} from './failure-envelope-types.js';

export const FAILURE_ENVELOPE_VERSION = FAILURE_PROJECTION_SCHEMA_VERSION;

export const MAX_MESSAGE = 1000;
/** Shared with the projection egress layer (`failure-projection.ts`). */
export const MAX_OPERATOR_DETAIL = 2000;

/** Shared with the projection egress layer (`failure-projection.ts`). */
export function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  // Match report-failure style: length exactly `max` with ASCII ellipsis suffix.
  if (max <= 3) return text.slice(0, max);
  return `${text.slice(0, max - 3)}...`;
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
  return freezeEnvelope({
    schemaVersion: FAILURE_ENVELOPE_VERSION,
    known: 'known',
    message: truncate(message || definition.code, MAX_MESSAGE),
    operatorAction: definition.operatorAction,
    code: code || definition.code,
    definition,
    metadata,
    ...(failureClass === undefined ? {} : { failureClass }),
    causes,
    ...(stderrTail === undefined
      ? {}
      : { operatorDetail: truncate(stderrTail, MAX_OPERATOR_DETAIL) }),
  });
}

export function fromNativeError(
  error: Error,
  causes: readonly FailureCauseSummary[],
): FailureEnvelope {
  const errno = readField(
    error,
    'code',
    () => {
      const code = (error as NodeJS.ErrnoException).code;
      return typeof code === 'string' ? code : undefined;
    },
    undefined,
  );
  let definition = definitionFromLegacyCode('SYSTEM_ERROR');
  let known: FailureKnownStatus = 'unknown';
  if (typeof errno === 'string') {
    if (errno === 'ENOENT' || errno === 'ENOTDIR') {
      definition = definitionFromLegacyCode('NOT_FOUND');
      known = 'known';
    } else if (errno === 'EACCES' || errno === 'EPERM') {
      definition = coreSystemErrorCatalog.require('CORE.SYSTEM.PERMISSION');
      known = 'known';
    } else if (errno === 'ENOSPC' || errno === 'EMFILE' || errno === 'ENOMEM') {
      definition = coreSystemErrorCatalog.require('CORE.SYSTEM.RESOURCE');
      known = 'known';
    }
  }

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
    operatorDetail: truncate(
      [name, message, typeof errno === 'string' ? `errno=${errno}` : '']
        .filter(Boolean)
        .join(' | '),
      MAX_OPERATOR_DETAIL,
    ),
  });
}
