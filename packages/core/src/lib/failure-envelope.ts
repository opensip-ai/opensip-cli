/**
 * Canonical failure envelope + total normalizer (Plan 00 Phase 3).
 *
 * One normalize path for thrown values; public / machine / operator projections
 * share definition axes without message-substring classification.
 */

import { coreSystemErrorCatalog } from './error-definition.js';
import { isToolErrorLike, type ToolError } from './errors.js';
import {
  FAILURE_ENVELOPE_VERSION,
  freezeEnvelope,
  fromNativeError,
  fromToolError,
  MAX_MESSAGE,
  MAX_OPERATOR_DETAIL,
  readField,
  truncate,
} from './failure-envelope-builders.js';

import type {
  FailureCauseSummary,
  FailureEnvelope,
  NormalizeFailureContext,
} from './failure-envelope-types.js';

export type {
  FailureCauseSummary,
  FailureEnvelope,
  FailureKnownStatus,
  NormalizeFailureContext,
} from './failure-envelope-types.js';

// Re-exported from the builders split so existing importers keep one home.
export {
  FAILURE_ENVELOPE_VERSION,
  MAX_OPERATOR_DETAIL,
  truncate,
} from './failure-envelope-builders.js';

const MAX_CAUSE_DEPTH = 4;
const MAX_AGGREGATE = 16;
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

const UNKNOWN = coreSystemErrorCatalog.require('UNKNOWN_FAILURE');

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

  const aggregatePlan = prepareAggregatePlan(value, context, depth, seen);
  if (aggregatePlan !== undefined) {
    if (aggregatePlan.kind === 'terminal') return aggregatePlan.envelope;
    const aggregate = normalizeNestedValues({
      values: aggregatePlan.members,
      context: { ...context, siblings: undefined },
      seen,
      depth: depth + 1,
      budget,
    });
    return buildAggregate({
      aggregate,
      memberCount: aggregatePlan.memberCount,
      headline: aggregatePlan.headline,
      truncated: aggregatePlan.truncated,
    });
  }

  const errorPlan = prepareErrorPlan(value, seen);
  if (errorPlan !== undefined) {
    if (errorPlan.kind === 'terminal') return errorPlan.envelope;
    const nested = normalizeNestedValues({
      values: boundedCauseMembers(errorPlan.cause, depth),
      context,
      seen,
      depth: depth + 1,
      budget,
    })[0];
    const causes = nested === undefined ? [] : summarizeCause(nested, depth + 1);
    return fromPreparedError(errorPlan, causes);
  }

  if (typeof value === 'object' && value !== null) {
    return fromUnknownObject(value, seen);
  }

  return unknownEnvelope(safeMessage(value), value);
}

interface TerminalNormalizationPlan {
  readonly kind: 'terminal';
  readonly envelope: FailureEnvelope;
}

interface AggregateNormalizationPlan {
  readonly kind: 'aggregate';
  readonly members: readonly unknown[];
  readonly memberCount: number;
  readonly headline: string;
  readonly truncated: boolean;
}

function prepareAggregatePlan(
  value: unknown,
  context: NormalizeFailureContext,
  depth: number,
  seen: WeakSet<object>,
): AggregateNormalizationPlan | TerminalNormalizationPlan | undefined {
  if (typeof AggregateError !== 'undefined' && value instanceof AggregateError) {
    if (seen.has(value)) {
      return { kind: 'terminal', envelope: unknownEnvelope('circular-aggregate', undefined) };
    }
    seen.add(value);
    const inspected = inspectAggregateMembers(value);
    return {
      kind: 'aggregate',
      members: inspected.members,
      memberCount: inspected.total,
      headline: safeMessage(value),
      truncated: inspected.total > MAX_AGGREGATE,
    };
  }
  if (context.siblings === undefined || context.siblings.length === 0 || depth !== 0) {
    return undefined;
  }
  const memberCount = context.siblings.length + 1;
  return {
    kind: 'aggregate',
    members: [value, ...context.siblings.slice(0, MAX_AGGREGATE - 1)],
    memberCount,
    headline: 'aggregate failure',
    truncated: memberCount > MAX_AGGREGATE,
  };
}

interface ToolErrorNormalizationPlan {
  readonly kind: 'tool';
  readonly error: ToolError;
  readonly cause: unknown;
}

interface NativeErrorNormalizationPlan {
  readonly kind: 'native';
  readonly error: Error;
  readonly cause: unknown;
}

function boundedCauseMembers(cause: unknown, depth: number): readonly unknown[] {
  return cause === undefined || cause === null || depth >= MAX_CAUSE_DEPTH ? [] : [cause];
}

function fromPreparedError(
  plan: ToolErrorNormalizationPlan | NativeErrorNormalizationPlan,
  causes: readonly FailureCauseSummary[],
): FailureEnvelope {
  return plan.kind === 'tool'
    ? fromToolError(plan.error, causes)
    : fromNativeError(plan.error, causes);
}

function prepareErrorPlan(
  value: unknown,
  seen: WeakSet<object>,
):
  | ToolErrorNormalizationPlan
  | NativeErrorNormalizationPlan
  | TerminalNormalizationPlan
  | undefined {
  const toolError = isToolErrorLike(value) ? value : undefined;
  if (toolError !== undefined) {
    if (seen.has(toolError)) {
      return { kind: 'terminal', envelope: unknownEnvelope('circular-error', undefined) };
    }
    seen.add(toolError);
    return {
      kind: 'tool',
      error: toolError,
      cause: readField(toolError, 'cause', () => toolError.cause, undefined),
    };
  }
  if (!(value instanceof Error)) return undefined;
  if (seen.has(value)) {
    return { kind: 'terminal', envelope: unknownEnvelope('circular-error', undefined) };
  }
  seen.add(value);
  return {
    kind: 'native',
    error: value,
    cause: readField(value, 'cause', () => value.cause, undefined),
  };
}

interface NestedNormalizationInput {
  readonly values: readonly unknown[];
  readonly context: NormalizeFailureContext;
  readonly seen: WeakSet<object>;
  readonly depth: number;
  readonly budget: NodeBudget;
}

function normalizeNestedValues(input: NestedNormalizationInput): readonly FailureEnvelope[] {
  const normalized: FailureEnvelope[] = [];
  for (const value of input.values) {
    normalized.push(
      normalizeFailureInner(value, input.context, input.seen, input.depth, input.budget),
    );
  }
  return normalized;
}

function fromUnknownObject(value: object, seen: WeakSet<object>): FailureEnvelope {
  if (seen.has(value)) return unknownEnvelope('circular', undefined);
  seen.add(value);
  const name = readField(
    value,
    'name',
    () => {
      const candidate = (value as { name?: unknown }).name;
      return typeof candidate === 'string' ? candidate : '';
    },
    '',
  );
  const message = readField(
    value,
    'message',
    () => {
      const candidate = (value as { message?: unknown }).message;
      return typeof candidate === 'string' ? candidate : safeMessage(value);
    },
    safeMessage(value),
  );
  if (name !== 'AbortError' && message !== 'This operation was aborted') {
    return unknownEnvelope(safeMessage(value), value);
  }
  const definition = coreSystemErrorCatalog.require('CORE.SYSTEM.CANCELLED');
  return freezeEnvelope({
    schemaVersion: FAILURE_ENVELOPE_VERSION,
    known: 'known',
    message: truncate(message || 'Operation aborted', MAX_MESSAGE),
    operatorAction: definition.operatorAction,
    code: definition.code,
    definition,
    metadata: {},
    causes: [],
  });
}

function summarizeCause(nested: FailureEnvelope, depth: number): FailureCauseSummary[] {
  return [
    {
      ...(nested.code ? { code: nested.code } : {}),
      message: nested.message,
      known: nested.known,
    },
    ...nested.causes.slice(0, Math.max(0, MAX_CAUSE_DEPTH - depth)),
  ].slice(0, MAX_CAUSE_DEPTH);
}

interface InspectedAggregateMembers {
  readonly members: readonly unknown[];
  readonly total: number;
}

function inspectAggregateMembers(value: AggregateError): InspectedAggregateMembers {
  return readField(
    value,
    'errors',
    () => {
      const errors: unknown = value.errors;
      if (!Array.isArray(errors)) return { members: [], total: 0 };
      return { members: errors.slice(0, MAX_AGGREGATE), total: errors.length };
    },
    { members: [], total: 0 },
  );
}

interface AggregateBuildInput {
  readonly aggregate: readonly FailureEnvelope[];
  readonly memberCount: number;
  readonly headline: string;
  readonly truncated: boolean;
}

function buildAggregate(input: AggregateBuildInput): FailureEnvelope {
  const { aggregate, headline, memberCount, truncated } = input;
  const first = aggregate[0] ?? unknownEnvelope(headline, undefined);
  return freezeEnvelope({
    schemaVersion: FAILURE_ENVELOPE_VERSION,
    known: aggregate.every((a) => a.known === 'known') ? 'known' : 'unknown',
    message: truncate(headline || first.message, MAX_MESSAGE),
    operatorAction: first.operatorAction,
    code: first.code,
    definition: first.definition,
    metadata: {
      aggregateCount: memberCount,
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
