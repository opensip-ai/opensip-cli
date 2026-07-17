import { SystemError, ValidationError } from '@opensip-cli/core';
import { requireDrizzleHandle } from '@opensip-cli/datastore/internal';
import { and, countDistinct, eq, isNotNull, sql } from 'drizzle-orm';

import {
  countRunStepsFromTx,
  isResolvableStoredRunId,
  readRunByIdFromTx,
  readRunsPageFromTx,
  readRunStepsPageFromTx,
  readUnresolvableRunIdFromTx,
} from './run-repo.js';
import { runSteps } from './schema/runs.js';
import { sessions, sessionHostMetrics, sessionToolPayload } from './schema/sessions.js';
import { buildSession } from './session-hydrator.js';
import { projectHostMetrics } from './session-repo-host-metrics.js';

import type {
  StoredRun,
  StoredRunStep,
  StoredSession,
  StoredSessionHostMetrics,
} from '@opensip-cli/contracts';
import type { DataStore } from '@opensip-cli/datastore';
import type { DrizzleHandle } from '@opensip-cli/datastore/internal';

const PAYLOAD_PROPERTY_OVERHEAD_BYTES = 11;

export const DEFAULT_PARENT_RUN_LIST_LIMIT = 20;
export const DEFAULT_PARENT_RUN_STEP_LIMIT = 100;
export const MAX_PARENT_RUN_READ_LIMIT = 500;
export const DEFAULT_PARENT_RUN_EVIDENCE_BYTE_BUDGET = 8 * 1024 * 1024;
export const MAX_PARENT_RUN_EVIDENCE_BYTE_BUDGET = 8 * 1024 * 1024;

export interface ListParentRunsOptions {
  readonly limit?: number;
}

export interface ParentRunList {
  readonly runs: readonly StoredRun[];
  readonly requestedLimit: number;
  readonly effectiveLimit: number;
  readonly truncated: boolean;
}

export interface ResolveParentRunOptions {
  readonly runId: string;
  readonly offset?: number;
  readonly limit?: number;
}

export interface ParentRunFound {
  readonly status: 'found';
  readonly run: StoredRun;
  readonly steps: readonly StoredRunStep[];
  readonly total: number;
  readonly offset: number;
  readonly limit: number;
  readonly nextOffset?: number;
}

export interface ParentRunNotFound {
  readonly status: 'not-found';
}

export type ResolveParentRunResult = ParentRunFound | ParentRunNotFound;

export interface ResolveParentRunEvidenceOptions {
  readonly runId: string;
  readonly stepLimit?: number;
  readonly sessionLimit?: number;
  readonly byteBudget?: number;
}

export interface ParentRunEvidenceSnapshot {
  readonly run: StoredRun;
  readonly steps: readonly StoredRunStep[];
  /** Linked Sessions ordered by their first included RunStep. */
  readonly sessions: readonly StoredSession[];
}

export interface ParentRunEvidenceInclusion {
  readonly total: number;
  readonly included: number;
  readonly truncated: boolean;
}

export interface ParentRunEvidenceMetadata {
  readonly steps: ParentRunEvidenceInclusion;
  readonly sessions: ParentRunEvidenceInclusion;
  readonly byteBudget: number;
  /** Bytes required for the mandatory exact Run with empty detail arrays. */
  readonly baseBytes: number;
  /** Canonical JSON bytes of the complete returned `snapshot`. */
  readonly serializedBytes: number;
  /** True when mandatory exact Run metadata alone exceeds `byteBudget`. */
  readonly baseExceedsBudget: boolean;
  /**
   * True when a stored JSON byte-length preflight stopped before parsing a
   * linked payload. This check is intentionally conservative: legacy JSON
   * whitespace/escapes can make stored bytes larger than canonical output.
   */
  readonly conservativePayloadPreflightTruncated: boolean;
  readonly truncated: boolean;
}

export interface ParentRunEvidenceFound {
  readonly status: 'found';
  readonly snapshot: ParentRunEvidenceSnapshot;
  readonly metadata: ParentRunEvidenceMetadata;
}

export type ResolveParentRunEvidenceResult = ParentRunEvidenceFound | ParentRunNotFound;

/**
 * Read a bounded newest-first parent-Run page. A limit+1 snapshot query proves
 * truncation without an unbounded count.
 */
export function listParentRuns(
  store: DataStore,
  options: ListParentRunsOptions = {},
): ParentRunList {
  const requestedLimit = options?.limit ?? DEFAULT_PARENT_RUN_LIST_LIMIT;
  const effectiveLimit = requirePositiveLimit(
    requestedLimit,
    MAX_PARENT_RUN_READ_LIMIT,
    'VALIDATION.RUN_READ.LIST_LIMIT_INVALID',
    'parent Run list limit',
  );
  const datastore = requireDrizzleHandle(store);
  return datastore.transaction((tx) => {
    if (readUnresolvableRunIdFromTx(tx) !== null) {
      throw new SystemError(
        'Stored parent Run history contains an unsupported legacy Run ID.',
        { code: 'SYSTEM.RUN_READ.UNSAFE_LEGACY_ID' },
      );
    }
    const rows = readRunsPageFromTx(tx, 0, effectiveLimit + 1);
    return deepFreeze({
      runs: rows.slice(0, effectiveLimit),
      requestedLimit,
      effectiveLimit,
      truncated: rows.length > effectiveLimit,
    });
  });
}

/** Resolve one exact parent Run and a bounded deterministic RunStep page. */
export function resolveParentRun(
  store: DataStore,
  options: ResolveParentRunOptions,
): ResolveParentRunResult {
  const runId = requireRunId(options?.runId);
  const offset = requireOffset(options?.offset ?? 0);
  const limit = requirePositiveLimit(
    options?.limit ?? DEFAULT_PARENT_RUN_STEP_LIMIT,
    MAX_PARENT_RUN_READ_LIMIT,
    'VALIDATION.RUN_READ.STEP_LIMIT_INVALID',
    'parent Run step limit',
  );
  const datastore = requireDrizzleHandle(store);
  return datastore.transaction((tx) => {
    const run = readRunByIdFromTx(tx, runId);
    if (run === null) return deepFreeze({ status: 'not-found' as const });
    const total = countRunStepsFromTx(tx, runId);
    const steps = readRunStepsPageFromTx(tx, runId, offset, limit);
    const next = offset + steps.length;
    return deepFreeze({
      status: 'found' as const,
      run,
      steps,
      total,
      offset,
      limit,
      ...(next < total ? { nextOffset: next } : {}),
    });
  });
}

/**
 * Resolve one immutable exact Run/RunStep/linked-Session snapshot.
 *
 * The mandatory exact Run is never dropped. Ordered step/session pairs are
 * admitted only while count caps and the canonical snapshot byte budget hold.
 * When the mandatory base alone exceeds the requested budget, the result
 * truthfully reports `serializedBytes > byteBudget` and returns no detail.
 */
export function resolveParentRunEvidence(
  store: DataStore,
  options: ResolveParentRunEvidenceOptions,
): ResolveParentRunEvidenceResult {
  const normalized = normalizeEvidenceOptions(options);
  const datastore = requireDrizzleHandle(store);
  return datastore.transaction((tx) => {
    const run = readRunByIdFromTx(tx, normalized.runId);
    if (run === null) return deepFreeze({ status: 'not-found' as const });
    return projectEvidenceSnapshot(tx, run, normalized);
  });
}

interface NormalizedEvidenceOptions {
  readonly runId: string;
  readonly stepLimit: number;
  readonly sessionLimit: number;
  readonly byteBudget: number;
}

function normalizeEvidenceOptions(
  options: ResolveParentRunEvidenceOptions,
): NormalizedEvidenceOptions {
  return {
    runId: requireRunId(options?.runId),
    stepLimit: requirePositiveLimit(
      options?.stepLimit ?? MAX_PARENT_RUN_READ_LIMIT,
      MAX_PARENT_RUN_READ_LIMIT,
      'VALIDATION.RUN_READ.EVIDENCE_STEP_LIMIT_INVALID',
      'parent Run evidence step limit',
    ),
    sessionLimit: requirePositiveLimit(
      options?.sessionLimit ?? MAX_PARENT_RUN_READ_LIMIT,
      MAX_PARENT_RUN_READ_LIMIT,
      'VALIDATION.RUN_READ.EVIDENCE_SESSION_LIMIT_INVALID',
      'parent Run evidence Session limit',
    ),
    byteBudget: requirePositiveLimit(
      options?.byteBudget ?? DEFAULT_PARENT_RUN_EVIDENCE_BYTE_BUDGET,
      MAX_PARENT_RUN_EVIDENCE_BYTE_BUDGET,
      'VALIDATION.RUN_READ.EVIDENCE_BYTE_BUDGET_INVALID',
      'parent Run evidence byte budget',
    ),
  };
}

function projectEvidenceSnapshot(
  tx: DrizzleHandle,
  run: StoredRun,
  options: NormalizedEvidenceOptions,
): ParentRunEvidenceFound {
  const totalSteps = countRunStepsFromTx(tx, run.id);
  const totalSessions =
    tx
      .select({ value: countDistinct(runSteps.session_id) })
      .from(runSteps)
      .where(and(eq(runSteps.run_id, run.id), isNotNull(runSteps.session_id)))
      .get()?.value ?? 0;
  const retainedLinkedSessions =
    tx
      .select({ value: countDistinct(runSteps.session_id) })
      .from(runSteps)
      .innerJoin(sessions, eq(sessions.id, runSteps.session_id))
      .where(eq(runSteps.run_id, run.id))
      .get()?.value ?? 0;
  if (retainedLinkedSessions !== totalSessions) {
    throw new SystemError(`Parent Run ${run.id} contains a missing retained Session link.`, {
      code: 'SYSTEM.RUN_READ.LINKED_SESSION_MISSING',
    });
  }
  const candidates = readRunStepsPageFromTx(tx, run.id, 0, options.stepLimit);
  const baseBytes = measureSnapshotBytes({ run, steps: [], sessions: [] });
  const admitted = admitEvidencePrefix(tx, candidates, baseBytes, options);
  const snapshot: ParentRunEvidenceSnapshot = {
    run,
    steps: admitted.steps,
    sessions: admitted.sessions,
  };
  const serializedBytes = measureSnapshotBytes(snapshot);
  const stepMetadata = inclusion(totalSteps, admitted.steps.length);
  const sessionMetadata = inclusion(totalSessions, admitted.sessions.length);
  const baseExceedsBudget = admitted.baseBytes > options.byteBudget;
  return deepFreeze({
    status: 'found',
    snapshot,
    metadata: {
      steps: stepMetadata,
      sessions: sessionMetadata,
      byteBudget: options.byteBudget,
      baseBytes: admitted.baseBytes,
      serializedBytes,
      baseExceedsBudget,
      conservativePayloadPreflightTruncated: admitted.conservativePayloadPreflightTruncated,
      truncated:
        baseExceedsBudget ||
        admitted.conservativePayloadPreflightTruncated ||
        stepMetadata.truncated ||
        sessionMetadata.truncated,
    },
  });
}

interface AdmittedEvidencePrefix {
  readonly steps: readonly StoredRunStep[];
  readonly sessions: readonly StoredSession[];
  readonly baseBytes: number;
  readonly conservativePayloadPreflightTruncated: boolean;
}

interface EvidenceAdmissionState {
  readonly steps: StoredRunStep[];
  readonly sessions: StoredSession[];
  readonly sessionIds: Set<string>;
  serializedBytes: number;
}

interface LazySessionCandidate {
  readonly row: typeof sessions.$inferSelect;
  readonly metrics: StoredSessionHostMetrics | undefined;
  readonly baseSession: StoredSession;
  readonly storedPayloadBytes?: number;
  readonly payloadVersion?: number | null;
}

type StepAdmission =
  | { readonly status: 'admitted' }
  | {
      readonly status: 'stopped';
      readonly conservativePayloadPreflightTruncated: boolean;
    };

function admitEvidencePrefix(
  tx: DrizzleHandle,
  candidates: readonly StoredRunStep[],
  baseBytes: number,
  options: NormalizedEvidenceOptions,
): AdmittedEvidencePrefix {
  const state: EvidenceAdmissionState = {
    steps: [],
    sessions: [],
    sessionIds: new Set<string>(),
    serializedBytes: baseBytes,
  };
  const candidateCache = new Map<string, LazySessionCandidate>();
  let conservativePayloadPreflightTruncated = false;

  if (baseBytes <= options.byteBudget) {
    for (const step of candidates) {
      const admission = admitStep(tx, step, state, candidateCache, options);
      if (admission.status === 'admitted') continue;
      conservativePayloadPreflightTruncated = admission.conservativePayloadPreflightTruncated;
      break;
    }
  }
  return {
    steps: state.steps,
    sessions: state.sessions,
    baseBytes,
    conservativePayloadPreflightTruncated,
  };
}

function admitStep(
  tx: DrizzleHandle,
  step: StoredRunStep,
  state: EvidenceAdmissionState,
  candidateCache: Map<string, LazySessionCandidate>,
  options: NormalizedEvidenceOptions,
): StepAdmission {
  const afterStepBytes = state.serializedBytes + arrayItemBytes(step, state.steps.length);
  if (afterStepBytes > options.byteBudget) return stopped(false);
  if (step.sessionId === undefined || state.sessionIds.has(step.sessionId)) {
    state.steps.push(step);
    state.serializedBytes = afterStepBytes;
    return { status: 'admitted' };
  }
  if (state.sessions.length >= options.sessionLimit) return stopped(false);
  const candidate =
    candidateCache.get(step.sessionId) ?? readLazySessionCandidate(tx, step.sessionId);
  candidateCache.set(step.sessionId, candidate);
  const baseSessionBytes = arrayItemBytes(candidate.baseSession, state.sessions.length);
  const remainingPayloadBytes =
    options.byteBudget - afterStepBytes - baseSessionBytes - PAYLOAD_PROPERTY_OVERHEAD_BYTES;
  if (
    candidate.storedPayloadBytes !== undefined &&
    candidate.storedPayloadBytes > remainingPayloadBytes
  ) {
    return stopped(true);
  }
  const linkedSession = hydrateLazySessionCandidate(tx, candidate);
  const nextBytes = afterStepBytes + arrayItemBytes(linkedSession, state.sessions.length);
  if (nextBytes > options.byteBudget) return stopped(false);
  state.steps.push(step);
  state.sessions.push(linkedSession);
  state.sessionIds.add(step.sessionId);
  state.serializedBytes = nextBytes;
  return { status: 'admitted' };
}

function stopped(conservativePayloadPreflightTruncated: boolean): StepAdmission {
  return {
    status: 'stopped',
    conservativePayloadPreflightTruncated,
  };
}

function readLazySessionCandidate(tx: DrizzleHandle, sessionId: string): LazySessionCandidate {
  const row = tx.select().from(sessions).where(eq(sessions.id, sessionId)).get();
  if (row === undefined) {
    throw new SystemError(`Parent Run links missing retained Session ${sessionId}.`, {
      code: 'SYSTEM.RUN_READ.LINKED_SESSION_MISSING',
    });
  }
  const metricsRow = tx
    .select()
    .from(sessionHostMetrics)
    .where(eq(sessionHostMetrics.sessionId, sessionId))
    .get();
  const metrics = metricsRow === undefined ? undefined : projectHostMetrics(metricsRow);
  // Read only scalar payload metadata here. Raw JSON is fetched and parsed
  // after the cumulative byte preflight admits this exact ordered candidate.
  const payloadRow = tx
    .select({
      storedPayloadBytes: sql<number>`length(CAST(${sessionToolPayload.payload} AS BLOB))`,
      payloadVersion: sessionToolPayload.payload_version,
    })
    .from(sessionToolPayload)
    .where(eq(sessionToolPayload.sessionId, sessionId))
    .get();
  return {
    row,
    metrics,
    baseSession: buildSession(row, undefined, metrics),
    ...(payloadRow === undefined
      ? {}
      : {
          storedPayloadBytes: payloadRow.storedPayloadBytes,
          payloadVersion: payloadRow.payloadVersion,
        }),
  };
}

function hydrateLazySessionCandidate(
  tx: DrizzleHandle,
  candidate: LazySessionCandidate,
): StoredSession {
  if (candidate.storedPayloadBytes === undefined) return candidate.baseSession;
  const payloadRow = tx
    .select({
      rawPayload: sql<string>`CAST(${sessionToolPayload.payload} AS TEXT)`,
    })
    .from(sessionToolPayload)
    .where(eq(sessionToolPayload.sessionId, candidate.row.id))
    .get();
  if (payloadRow === undefined) {
    throw new SystemError(`Stored Session ${candidate.row.id} lost its payload during read.`, {
      code: 'SYSTEM.RUN_READ.SESSION_PAYLOAD_MISSING',
    });
  }
  let payload: unknown;
  try {
    payload = JSON.parse(payloadRow.rawPayload) as unknown;
  } catch (error) {
    throw new SystemError(`Stored Session ${candidate.row.id} has invalid JSON payload.`, {
      code: 'SYSTEM.RUN_READ.SESSION_PAYLOAD_INVALID',
      cause: error,
    });
  }
  return buildSession(
    candidate.row,
    {
      payload,
      payload_version: candidate.payloadVersion ?? null,
    },
    candidate.metrics,
  );
}

function inclusion(total: number, included: number): ParentRunEvidenceInclusion {
  return {
    total,
    included,
    truncated: included < total,
  };
}

function arrayItemBytes(value: unknown, existingLength: number): number {
  return Buffer.byteLength(canonicalJson(value), 'utf8') + (existingLength === 0 ? 0 : 1);
}

function measureSnapshotBytes(snapshot: ParentRunEvidenceSnapshot): number {
  return Buffer.byteLength(canonicalJson(snapshot), 'utf8');
}

function canonicalJson(value: unknown): string {
  const ordinary = JSON.stringify(value);
  if (ordinary === undefined) {
    throw new ValidationError('Stored parent Run evidence is not JSON serializable.', {
      code: 'VALIDATION.RUN_READ.EVIDENCE_NOT_SERIALIZABLE',
    });
  }
  return canonicalParsedJson(JSON.parse(ordinary) as unknown);
}

function canonicalParsedJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalParsedJson).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalParsedJson(record[key])}`)
    .join(',')}}`;
}

function requireRunId(value: unknown): string {
  if (!isResolvableStoredRunId(value)) {
    throw new ValidationError(
      'Parent Run ID must contain 1-128 letters, numbers, underscores, or hyphens.',
      { code: 'VALIDATION.RUN_READ.RUN_ID_INVALID' },
    );
  }
  return value;
}

function requireOffset(value: number): number {
  const maximum = Number.MAX_SAFE_INTEGER - MAX_PARENT_RUN_READ_LIMIT;
  if (!Number.isSafeInteger(value) || value < 0 || value > maximum) {
    throw new ValidationError(
      `Parent Run step offset must be a non-negative integer no greater than ${String(maximum)}.`,
      {
        code: 'VALIDATION.RUN_READ.OFFSET_INVALID',
      },
    );
  }
  return value;
}

function requirePositiveLimit(value: number, maximum: number, code: string, label: string): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new ValidationError(`${label} must be an integer between 1 and ${String(maximum)}.`, {
      code,
    });
  }
  return value;
}

function deepFreeze<T>(value: T, seen = new WeakSet<object>()): T {
  if (value === null || typeof value !== 'object' || seen.has(value)) return value;
  seen.add(value);
  for (const child of Object.values(value)) deepFreeze(child, seen);
  return Object.freeze(value);
}
