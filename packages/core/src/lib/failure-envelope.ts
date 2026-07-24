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

export const FAILURE_ENVELOPE_VERSION = FAILURE_PROJECTION_SCHEMA_VERSION;

const MAX_CAUSE_DEPTH = 4;
const MAX_AGGREGATE = 16;
const MAX_MESSAGE = 1000;
/** Shared with the projection egress layer (`failure-projection.ts`). */
export const MAX_OPERATOR_DETAIL = 2000;
/**
 * Total-work ceiling across one normalize call. Depth (`MAX_CAUSE_DEPTH`) and
 * per-level width (`MAX_AGGREGATE`) bound a *tree*, but a shared-node
 * `AggregateError` DAG (the same child referenced at many parents) would
 * re-expand `width^depth` times from a tiny input. This shared, mutable node
 * budget caps the total nodes any single normalize traverses so the "never
 * crash on hostile input" contract holds structurally, not per-branch.
 */
const MAX_TOTAL_NODES = 1000;

/** Shared mutable work counter threaded through the recursion (parallel to `seen`). */
interface NodeBudget {
  remaining: number;
}

/** Whether a normalized failure matched a known error definition or degraded to unknown. */
export type FailureKnownStatus = 'known' | 'unknown';

/** One entry in a failure's bounded cause chain (see {@link FailureEnvelope.causes}). */
export interface FailureCauseSummary {
  readonly code?: string;
  readonly name?: string;
  readonly message: string;
  readonly known: FailureKnownStatus;
}

/**
 * Canonical, frozen representation of any thrown value produced by
 * {@link normalizeFailure}. Projection helpers render it for a specific audience
 * (public / machine / operator) without leaking operator-only detail.
 */
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

/** Optional context passed to {@link normalizeFailure} (project root, sibling failures). */
export interface NormalizeFailureContext {
  readonly projectRoot?: string;
  /** Optional sibling failures for aggregate envelopes. */
  readonly siblings?: readonly unknown[];
}

const UNKNOWN = coreSystemErrorCatalog.require('UNKNOWN_FAILURE');

/** Shared with the projection egress layer (`failure-projection.ts`). */
export function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  // Match report-failure style: length exactly `max` with ASCII ellipsis suffix.
  if (max <= 3) return text.slice(0, max);
  return `${text.slice(0, max - 3)}...`;
}

function safePrimitiveString(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
    return String(value);
  }
  if (value === null) return 'null';
  if (value === undefined) return 'undefined';
  if (typeof value === 'symbol') return value.description ?? 'Symbol';
  return typeof value;
}

function safeMessage(value: unknown): string {
  try {
    if (typeof value === 'string') return truncate(value, MAX_MESSAGE);
    if (value instanceof Error)
      return truncate(value.message || value.name || 'Error', MAX_MESSAGE);
    return truncate(safePrimitiveString(value), MAX_MESSAGE);
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
  seen = new WeakSet<object>(),
  depth = 0,
  budget?: NodeBudget,
): FailureEnvelope {
  // A fresh budget per top-level call; recursion threads the same object so the
  // node ceiling is shared across the whole DAG (never per-branch).
  const activeBudget = budget ?? { remaining: MAX_TOTAL_NODES };
  try {
    return normalizeFailureInner(value, context, seen, depth, activeBudget);
  } catch {
    return unknownEnvelope('normalize-emergency', undefined);
  }
}

function normalizeFailureInner(
  value: unknown,
  context: NormalizeFailureContext,
  seen: WeakSet<object>,
  depth: number,
  budget: NodeBudget,
): FailureEnvelope {
  // Structural work ceiling: a shared-node aggregate DAG can reference the same
  // child at every parent, so depth+width caps alone do not bound total work.
  if (budget.remaining <= 0) {
    return unknownEnvelope('node-budget-exhausted', undefined);
  }
  budget.remaining -= 1;

  if (depth > MAX_CAUSE_DEPTH + 2) {
    return unknownEnvelope('max-depth', undefined);
  }

  // AggregateError or explicit siblings
  if (typeof AggregateError !== 'undefined' && value instanceof AggregateError) {
    return fromAggregateError(value, context, seen, depth, budget);
  }
  if (context.siblings && context.siblings.length > 0 && depth === 0) {
    return buildAggregate(
      [value, ...context.siblings],
      context,
      seen,
      depth,
      budget,
      'aggregate failure',
    );
  }

  if (isToolErrorLike(value)) {
    return fromToolError(value, context, seen, depth, budget);
  }

  if (value instanceof Error) {
    return fromNativeError(value, context, seen, depth, budget);
  }

  if (typeof value === 'object' && value !== null) {
    if (seen.has(value)) {
      return unknownEnvelope('circular', undefined);
    }
    seen.add(value);
    // AbortSignal reason / DOMException-like
    const name = readField(
      value,
      'name',
      () => {
        const n = (value as { name?: unknown }).name;
        return typeof n === 'string' ? n : '';
      },
      '',
    );
    const message = readField(
      value,
      'message',
      () => {
        const m = (value as { message?: unknown }).message;
        return typeof m === 'string' ? m : safeMessage(value);
      },
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
  budget: NodeBudget,
): FailureEnvelope {
  const definition = error.definition ?? definitionFromLegacyCode(error.code);
  const causes = collectCauses(error.cause, context, seen, depth + 1, budget);
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
  budget: NodeBudget,
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

  const causes = collectCauses(error.cause, context, seen, depth + 1, budget);
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
  budget: NodeBudget,
): FailureCauseSummary[] {
  if (cause === undefined || cause === null || depth > MAX_CAUSE_DEPTH) return [];
  const nested = normalizeFailure(cause, context, seen, depth, budget);
  return [
    {
      ...(nested.code ? { code: nested.code } : {}),
      message: nested.message,
      known: nested.known,
    },
    ...nested.causes.slice(0, Math.max(0, MAX_CAUSE_DEPTH - depth)),
  ].slice(0, MAX_CAUSE_DEPTH);
}

function fromAggregateError(
  value: AggregateError,
  context: NormalizeFailureContext,
  seen: WeakSet<object>,
  depth: number,
  budget: NodeBudget,
): FailureEnvelope {
  // Dedup the aggregate node itself: a shared-node DAG re-references the same
  // AggregateError under many parents; expanding it once collapses width^depth
  // fan-out to O(distinct nodes) (the object/native-Error branches already do this).
  if (seen.has(value)) {
    return unknownEnvelope('circular-aggregate', undefined);
  }
  seen.add(value);
  return buildAggregate(value.errors, context, seen, depth, budget, safeMessage(value));
}

function buildAggregate(
  members: readonly unknown[],
  context: NormalizeFailureContext,
  seen: WeakSet<object>,
  depth: number,
  budget: NodeBudget,
  headline: string,
): FailureEnvelope {
  const sliced = members.slice(0, MAX_AGGREGATE);
  const aggregate = sliced.map((m) =>
    normalizeFailure(m, { ...context, siblings: undefined }, seen, depth + 1, budget),
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
    metadata: {
      aggregateCount: members.length,
      ...(truncated ? { aggregateTruncated: true } : {}),
    },
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
      original === undefined ? undefined : truncate(safeMessage(original), MAX_OPERATOR_DETAIL),
  });
}

function freezeEnvelope(envelope: FailureEnvelope): FailureEnvelope {
  return Object.freeze(envelope);
}
