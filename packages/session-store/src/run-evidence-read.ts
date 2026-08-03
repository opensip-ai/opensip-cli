import { SystemError } from '@opensip-cli/core';
import { requireDrizzleHandle } from '@opensip-cli/datastore/internal';
import { and, countDistinct, eq, isNotNull, sql } from 'drizzle-orm';

import { sessionStoreErrorCatalog } from './errors/session-store-error-catalog.js';
import {
  canonicalArrayItemBytes,
  evidenceInclusion,
  measureCanonicalJsonBytes,
} from './run-evidence-bytes.js';
import {
  deepFreeze,
  DEFAULT_PARENT_RUN_EVIDENCE_BYTE_BUDGET,
  MAX_PARENT_RUN_EVIDENCE_BYTE_BUDGET,
  MAX_PARENT_RUN_READ_LIMIT,
  requirePositiveLimit,
  requireRunId,
} from './run-read-validation.js';
import { countRunStepsFromTx, readRunByIdFromTx, readRunStepsPageFromTx } from './run-repo.js';
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

// Plan 01: 22 literals become five registered definitions; the branch lives in metadata.
const UNREADABLE = sessionStoreErrorCatalog.require('SESSION.EVIDENCE.UNREADABLE');

const PAYLOAD_PROPERTY_OVERHEAD_BYTES = 11;

/** Bounds for one exact parent-Run evidence snapshot. */
export interface ResolveParentRunEvidenceOptions {
  readonly runId: string;
  readonly stepLimit?: number;
  readonly sessionLimit?: number;
  readonly byteBudget?: number;
}

/** Exact parent Run plus its admitted ordered steps and linked Sessions. */
export interface ParentRunEvidenceSnapshot {
  readonly run: StoredRun;
  readonly steps: readonly StoredRunStep[];
  /** Linked Sessions ordered by their first included RunStep. */
  readonly sessions: readonly StoredSession[];
}

/** Count and truncation facts for one evidence collection. */
export interface ParentRunEvidenceInclusion {
  readonly total: number;
  readonly included: number;
  readonly truncated: boolean;
}

/** Bounded byte and inclusion evidence for one parent-Run snapshot. */
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

/** Successful exact parent-Run evidence projection. */
export interface ParentRunEvidenceFound {
  readonly status: 'found';
  readonly snapshot: ParentRunEvidenceSnapshot;
  readonly metadata: ParentRunEvidenceMetadata;
}

/** Exact evidence read result without leaking persistence errors. */
export type ResolveParentRunEvidenceResult =
  ParentRunEvidenceFound | { readonly status: 'not-found' };

interface NormalizedEvidenceOptions {
  readonly runId: string;
  readonly stepLimit: number;
  readonly sessionLimit: number;
  readonly byteBudget: number;
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

function normalizeEvidenceOptions(
  options: ResolveParentRunEvidenceOptions,
): NormalizedEvidenceOptions {
  return {
    runId: requireRunId(options?.runId),
    stepLimit: requirePositiveLimit(
      options?.stepLimit ?? MAX_PARENT_RUN_READ_LIMIT,
      MAX_PARENT_RUN_READ_LIMIT,
      'evidence-step-limit',
      'parent Run evidence step limit',
    ),
    sessionLimit: requirePositiveLimit(
      options?.sessionLimit ?? MAX_PARENT_RUN_READ_LIMIT,
      MAX_PARENT_RUN_READ_LIMIT,
      'evidence-session-limit',
      'parent Run evidence Session limit',
    ),
    byteBudget: requirePositiveLimit(
      options?.byteBudget ?? DEFAULT_PARENT_RUN_EVIDENCE_BYTE_BUDGET,
      MAX_PARENT_RUN_EVIDENCE_BYTE_BUDGET,
      'evidence-byte-budget',
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
      code: UNREADABLE.code,
      definition: UNREADABLE,
      metadata: { field: 'linked-session-missing' },
    });
  }
  const candidates = readRunStepsPageFromTx(tx, run.id, 0, options.stepLimit);
  const baseBytes = measureCanonicalJsonBytes({
    run,
    steps: [],
    sessions: [],
  });
  const admitted = admitEvidencePrefix(tx, candidates, baseBytes, options);
  const snapshot: ParentRunEvidenceSnapshot = {
    run,
    steps: admitted.steps,
    sessions: admitted.sessions,
  };
  const serializedBytes = measureCanonicalJsonBytes(snapshot);
  const stepMetadata = evidenceInclusion(totalSteps, admitted.steps.length);
  const sessionMetadata = evidenceInclusion(totalSessions, admitted.sessions.length);
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
  const afterStepBytes = state.serializedBytes + canonicalArrayItemBytes(step, state.steps.length);
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
  const baseSessionBytes = canonicalArrayItemBytes(candidate.baseSession, state.sessions.length);
  const remainingPayloadBytes =
    options.byteBudget - afterStepBytes - baseSessionBytes - PAYLOAD_PROPERTY_OVERHEAD_BYTES;
  if (
    candidate.storedPayloadBytes !== undefined &&
    candidate.storedPayloadBytes > remainingPayloadBytes
  ) {
    return stopped(true);
  }
  const linkedSession = hydrateLazySessionCandidate(tx, candidate);
  const nextBytes = afterStepBytes + canonicalArrayItemBytes(linkedSession, state.sessions.length);
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
      code: UNREADABLE.code,
      definition: UNREADABLE,
      metadata: { field: 'linked-session-missing' },
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
      code: UNREADABLE.code,
      definition: UNREADABLE,
      metadata: { field: 'payload-missing' },
    });
  }
  let payload: unknown;
  try {
    payload = JSON.parse(payloadRow.rawPayload) as unknown;
  } catch (error) {
    throw new SystemError(`Stored Session ${candidate.row.id} has invalid JSON payload.`, {
      code: UNREADABLE.code,
      definition: UNREADABLE,
      metadata: { field: 'payload-invalid' },
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
