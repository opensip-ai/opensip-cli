/**
 * Canonical failure envelope + total normalizer (Plan 00 Phase 3).
 *
 * One normalize path for thrown values; public / machine / operator projections
 * share definition axes without message-substring classification.
 */

import {
  type ErrorDefinition,
  definitionFromLegacyCode,
  coreSystemErrorCatalog,
  FAILURE_PROJECTION_SCHEMA_VERSION,
} from './error-definition.js';
import { isToolErrorLike, sanitizeErrorMetadata, type ToolError } from './errors.js';
import { toJsonRecord, type JsonRecord } from './json-value.js';

export const FAILURE_ENVELOPE_VERSION = FAILURE_PROJECTION_SCHEMA_VERSION;

const MAX_CAUSE_DEPTH = 4;
const MAX_AGGREGATE = 16;
const MAX_MESSAGE = 1000;
const MAX_OPERATOR_DETAIL = 2000;

export type FailureKnownStatus = 'known' | 'unknown';

export interface FailureCauseSummary {
  readonly code?: string;
  readonly name?: string;
  readonly message: string;
  readonly known: FailureKnownStatus;
}

export interface FailureEnvelope {
  readonly schemaVersion: typeof FAILURE_ENVELOPE_VERSION;
  readonly known: FailureKnownStatus;
  readonly message: string;
  readonly operatorAction: string;
  readonly code: string;
  readonly definition: ErrorDefinition;
  readonly metadata: Readonly<Record<string, unknown>>;
  readonly failureClass?: string;
  readonly causes: readonly FailureCauseSummary[];
  /** Sibling failures from parallel fan-in (not a cause chain). */
  readonly aggregate?: readonly FailureEnvelope[];
  readonly aggregateTruncated?: boolean;
  /** Operator-only detail (never public/worker by default). */
  readonly operatorDetail?: string;
}

export interface NormalizeFailureContext {
  readonly projectRoot?: string;
  /** Optional sibling failures for aggregate envelopes. */
  readonly siblings?: readonly unknown[];
}

const UNKNOWN = coreSystemErrorCatalog.require('UNKNOWN_FAILURE');

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  // Match report-failure style: length exactly `max` with ASCII ellipsis suffix.
  if (max <= 3) return text.slice(0, max);
  return `${text.slice(0, max - 3)}...`;
}

function safeMessage(value: unknown): string {
  try {
    if (typeof value === 'string') return truncate(value, MAX_MESSAGE);
    if (value instanceof Error) return truncate(value.message || value.name || 'Error', MAX_MESSAGE);
    if (value === null) return 'null';
    if (value === undefined) return 'undefined';
    return truncate(String(value), MAX_MESSAGE);
  } catch {
    return '<unstringifiable>';
  }
}

function readField<T>(obj: object, key: string, read: () => T, fallback: T): T {
  try {
    return read();
  } catch {
    return fallback;
  }
}

/**
 * Total normalizer: never throws. Per-node degradation for hostile shapes.
 */
export function normalizeFailure(
  value: unknown,
  context: NormalizeFailureContext = {},
  seen: WeakSet<object> = new WeakSet(),
  depth = 0,
): FailureEnvelope {
  try {
    return normalizeFailureInner(value, context, seen, depth);
  } catch {
    return unknownEnvelope('normalize-emergency', undefined);
  }
}

function normalizeFailureInner(
  value: unknown,
  context: NormalizeFailureContext,
  seen: WeakSet<object>,
  depth: number,
): FailureEnvelope {
  if (depth > MAX_CAUSE_DEPTH + 2) {
    return unknownEnvelope('max-depth', undefined);
  }

  // AggregateError or explicit siblings
  if (typeof AggregateError !== 'undefined' && value instanceof AggregateError) {
    return buildAggregate(value.errors, context, seen, depth, safeMessage(value));
  }
  if (context.siblings && context.siblings.length > 0 && depth === 0) {
    return buildAggregate([value, ...context.siblings], context, seen, depth, 'aggregate failure');
  }

  if (isToolErrorLike(value)) {
    return fromToolError(value, context, seen, depth);
  }

  if (value instanceof Error) {
    return fromNativeError(value, context, seen, depth);
  }

  if (typeof value === 'object' && value !== null) {
    if (seen.has(value)) {
      return unknownEnvelope('circular', undefined);
    }
    seen.add(value);
    // AbortSignal reason / DOMException-like
    const name = readField(value, 'name', () => String((value as { name?: unknown }).name ?? ''), '');
    const message = readField(
      value,
      'message',
      () => String((value as { message?: unknown }).message ?? safeMessage(value)),
      safeMessage(value),
    );
    if (name === 'AbortError' || message === 'This operation was aborted') {
      const def = definitionFromLegacyCode('TIMEOUT');
      // Prefer cancelled when we add it; map timeout-like abort for now via kind
      return freezeEnvelope({
        schemaVersion: FAILURE_ENVELOPE_VERSION,
        known: 'known',
        message: truncate(message || 'Operation aborted', MAX_MESSAGE),
        operatorAction: 'The operation was cancelled or aborted.',
        code: 'CORE.SYSTEM.CANCELLED',
        definition: {
          ...def,
          code: 'CORE.SYSTEM.CANCELLED',
          kind: 'cancelled',
          exitClass: 'cancelled',
          retry: 'never',
        },
        metadata: {},
        causes: [],
      });
    }
  }

  return unknownEnvelope(safeMessage(value), value);
}

function fromToolError(
  error: ToolError,
  context: NormalizeFailureContext,
  seen: WeakSet<object>,
  depth: number,
): FailureEnvelope {
  const definition = error.definition ?? definitionFromLegacyCode(error.code);
  const causes = collectCauses(error.cause, context, seen, depth + 1);
  const metadata = sanitizeErrorMetadata(error.metadata ?? {});
  return freezeEnvelope({
    schemaVersion: FAILURE_ENVELOPE_VERSION,
    known: 'known',
    message: truncate(error.message || definition.code, MAX_MESSAGE),
    operatorAction: definition.operatorAction,
    code: error.code || definition.code,
    definition,
    metadata,
    ...(error.failureClass === undefined ? {} : { failureClass: error.failureClass }),
    causes,
    ...(typeof error.stderrTail === 'string'
      ? { operatorDetail: truncate(error.stderrTail, MAX_OPERATOR_DETAIL) }
      : {}),
  });
}

function fromNativeError(
  error: Error,
  context: NormalizeFailureContext,
  seen: WeakSet<object>,
  depth: number,
): FailureEnvelope {
  if (seen.has(error)) {
    return unknownEnvelope('circular-error', undefined);
  }
  seen.add(error);

  const errno = (error as NodeJS.ErrnoException).code;
  let definition = definitionFromLegacyCode('SYSTEM_ERROR');
  if (typeof errno === 'string') {
    if (errno === 'ENOENT' || errno === 'ENOTDIR') {
      definition = definitionFromLegacyCode('NOT_FOUND');
    } else if (errno === 'EACCES' || errno === 'EPERM') {
      definition = {
        ...definitionFromLegacyCode('SYSTEM_ERROR'),
        kind: 'permission',
        code: 'CORE.SYSTEM.PERMISSION',
        exitClass: 'runtime',
        operatorAction: 'Check filesystem permissions for the affected path.',
      };
    } else if (errno === 'ENOSPC' || errno === 'EMFILE' || errno === 'ENOMEM') {
      definition = {
        ...definitionFromLegacyCode('SYSTEM_ERROR'),
        kind: 'resource',
        code: 'CORE.SYSTEM.RESOURCE',
        source: 'infrastructure',
        defaultResponsibility: 'environment',
        operatorAction: 'Free resources (disk, FDs, memory) and retry.',
      };
    }
  }

  const causes = collectCauses(error.cause, context, seen, depth + 1);
  return freezeEnvelope({
    schemaVersion: FAILURE_ENVELOPE_VERSION,
    known: 'unknown',
    message: truncate(error.message || error.name || 'Error', MAX_MESSAGE),
    operatorAction: definition.operatorAction,
    code: definition.code,
    definition,
    metadata: typeof errno === 'string' ? { errno } : {},
    causes,
    operatorDetail: truncate(
      [error.name, error.message, typeof errno === 'string' ? `errno=${errno}` : '']
        .filter(Boolean)
        .join(' | '),
      MAX_OPERATOR_DETAIL,
    ),
  });
}

function collectCauses(
  cause: unknown,
  context: NormalizeFailureContext,
  seen: WeakSet<object>,
  depth: number,
): FailureCauseSummary[] {
  if (cause === undefined || cause === null || depth > MAX_CAUSE_DEPTH) return [];
  const nested = normalizeFailure(cause, context, seen, depth);
  return [
    {
      ...(nested.code ? { code: nested.code } : {}),
      message: nested.message,
      known: nested.known,
    },
    ...nested.causes.slice(0, Math.max(0, MAX_CAUSE_DEPTH - depth)),
  ].slice(0, MAX_CAUSE_DEPTH);
}

function buildAggregate(
  members: readonly unknown[],
  context: NormalizeFailureContext,
  seen: WeakSet<object>,
  depth: number,
  headline: string,
): FailureEnvelope {
  const sliced = members.slice(0, MAX_AGGREGATE);
  const aggregate = sliced.map((m) =>
    normalizeFailure(m, { ...context, siblings: undefined }, seen, depth + 1),
  );
  const truncated = members.length > MAX_AGGREGATE;
  const first = aggregate[0] ?? unknownEnvelope(headline, undefined);
  return freezeEnvelope({
    schemaVersion: FAILURE_ENVELOPE_VERSION,
    known: aggregate.every((a) => a.known === 'known') ? 'known' : 'unknown',
    message: truncate(headline || first.message, MAX_MESSAGE),
    operatorAction: first.operatorAction,
    code: first.code,
    definition: first.definition,
    metadata: { aggregateCount: members.length, ...(truncated ? { aggregateTruncated: true } : {}) },
    causes: [],
    aggregate,
    ...(truncated ? { aggregateTruncated: true } : {}),
  });
}

function unknownEnvelope(message: string, original: unknown): FailureEnvelope {
  return freezeEnvelope({
    schemaVersion: FAILURE_ENVELOPE_VERSION,
    known: 'unknown',
    message: truncate(message || 'Unknown failure', MAX_MESSAGE),
    operatorAction: UNKNOWN.operatorAction,
    code: UNKNOWN.code,
    definition: UNKNOWN,
    metadata: {},
    causes: [],
    operatorDetail:
      original === undefined
        ? undefined
        : truncate(safeMessage(original), MAX_OPERATOR_DETAIL),
  });
}

function freezeEnvelope(envelope: FailureEnvelope): FailureEnvelope {
  return Object.freeze(envelope);
}

/** Public projection — no operatorDetail, metadata allowlisted by definition. */
export function toPublicFailureProjection(envelope: FailureEnvelope): JsonRecord {
  const allow = new Set(envelope.definition.publicMetadataKeys ?? []);
  /** @type {Record<string, unknown>} */
  const meta: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(envelope.metadata)) {
    if (allow.has(k)) meta[k] = v;
  }
  return toJsonRecord({
    schemaVersion: envelope.schemaVersion,
    code: envelope.code,
    message: envelope.message,
    action: envelope.operatorAction,
    source: envelope.definition.source,
    responsibility: envelope.definition.defaultResponsibility,
    kind: envelope.definition.kind,
    retry: envelope.definition.retry,
    severity: envelope.definition.severity,
    known: envelope.known,
    ...(Object.keys(meta).length > 0 ? { metadata: meta } : {}),
    ...(envelope.aggregate
      ? { aggregate: envelope.aggregate.map((a) => toPublicFailureProjection(a)) }
      : {}),
  });
}

/** Machine / worker-safe projection (redacted metadata, no operatorDetail/stack). */
export function toMachineFailureProjection(envelope: FailureEnvelope): JsonRecord {
  return toJsonRecord({
    schemaVersion: envelope.schemaVersion,
    code: envelope.code,
    message: envelope.message,
    action: envelope.operatorAction,
    source: envelope.definition.source,
    responsibility: envelope.definition.defaultResponsibility,
    kind: envelope.definition.kind,
    retry: envelope.definition.retry,
    severity: envelope.definition.severity,
    exposure: envelope.definition.exposure,
    exitClass: envelope.definition.exitClass,
    known: envelope.known,
    ...(envelope.failureClass === undefined ? {} : { failureClass: envelope.failureClass }),
    metadata: sanitizeErrorMetadata(envelope.metadata),
    causes: envelope.causes.map((c) => ({
      message: c.message,
      known: c.known,
      ...(c.code ? { code: c.code } : {}),
    })),
    ...(envelope.aggregate
      ? {
          aggregate: envelope.aggregate.map((a) => toMachineFailureProjection(a)),
          ...(envelope.aggregateTruncated ? { aggregateTruncated: true } : {}),
        }
      : {}),
  });
}

/** Local operator projection — may include operatorDetail; still no raw Error objects. */
export function toOperatorFailureProjection(envelope: FailureEnvelope): JsonRecord {
  return toJsonRecord({
    ...toMachineFailureProjection(envelope),
    ...(envelope.operatorDetail === undefined
      ? {}
      : { operatorDetail: truncate(envelope.operatorDetail, MAX_OPERATOR_DETAIL) }),
  });
}
