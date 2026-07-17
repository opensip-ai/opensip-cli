import { requireDrizzleHandle } from '@opensip-cli/datastore/internal';
import { inArray } from 'drizzle-orm';

import {
  prepareRunStepWrite,
  prepareRunWrite,
  writePreparedRun,
  writePreparedRunStep,
  type PreparedRunStepWrite,
  type PreparedRunWrite,
} from './run-repo.js';
import { sessions } from './schema/sessions.js';
import {
  prepareHostMetricsWrite,
  writeHostMetricsRowOrThrow,
} from './session-repo-host-metrics.js';
import {
  prepareSessionWrite,
  reportPreparedSessionWrite,
  writePreparedSession,
  type PreparedSessionWrite,
} from './session-write-repo.js';

import type {
  StoredRun,
  StoredRunStep,
  StoredSession,
  StoredSessionHostMetrics,
} from '@opensip-cli/contracts';
import type { DataStore } from '@opensip-cli/datastore';
import type { DrizzleHandle } from '@opensip-cli/datastore/internal';

/** Maximum Sessions accepted by one all-or-nothing host evidence commit. */
export const MAX_EVIDENCE_BUNDLE_SESSIONS = 256;

/** Maximum ordered RunSteps accepted by one all-or-nothing evidence commit. */
export const MAX_EVIDENCE_BUNDLE_STEPS = 512;

/** Maximum canonical serialized input size accepted by one evidence commit. */
export const MAX_EVIDENCE_BUNDLE_BYTES = 8 * 1024 * 1024;

const INVALID_INPUT_REASON = 'invalid-input' as const;

export interface EvidenceBundleSession {
  readonly session: StoredSession;
  readonly hostMetrics: StoredSessionHostMetrics;
}

export interface EvidenceBundleRun {
  readonly run: StoredRun;
  readonly steps: readonly StoredRunStep[];
}

/**
 * A synchronous, read-only condition evaluated after both the datastore write
 * lock and SQLite transaction are active. Returning false rejects the bundle
 * without writing any row.
 */
export type EvidenceBundlePrecondition = () => boolean;

export interface EvidenceBundleInput {
  readonly sessions: readonly EvidenceBundleSession[];
  readonly run?: EvidenceBundleRun;
  readonly precondition?: EvidenceBundlePrecondition;
}

export type EvidenceBundleFailureReason =
  'invalid-input' | 'limit-exceeded' | 'duplicate-id' | 'missing-session-link' | 'write-failed';

export type EvidenceBundleCommitResult =
  | {
      readonly status: 'committed';
      readonly sessionIds: readonly string[];
      readonly runId?: string;
      readonly sessionCount: number;
      readonly stepCount: number;
      readonly serializedBytes: number;
      readonly persistMs: number;
    }
  | {
      readonly status: 'precondition-rejected';
    }
  | {
      readonly status: 'failed';
      readonly reason: EvidenceBundleFailureReason;
    };

interface PreparedEvidenceBundle {
  readonly sessions: readonly {
    readonly prepared: PreparedSessionWrite;
    readonly hostMetrics: StoredSessionHostMetrics;
  }[];
  readonly run?: {
    readonly prepared: PreparedRunWrite;
    readonly steps: readonly PreparedRunStepWrite[];
  };
  readonly serializedBytes: number;
}

type PreparationResult =
  | { readonly ok: true; readonly bundle: PreparedEvidenceBundle }
  | { readonly ok: false; readonly reason: EvidenceBundleFailureReason };

type TransactionResult =
  | { readonly status: 'committed'; readonly persistMs: number }
  | { readonly status: 'precondition-rejected' }
  | { readonly status: 'missing-session-link' };

/**
 * Atomically commit host-owned evidence without exposing raw SQL or datastore
 * handles. All shape, count, identity, mapping, and byte checks complete before
 * the first insert. Retained Session-link checks and the optional precondition
 * execute inside the same write lock and transaction as every insert.
 */
export function commitEvidenceBundle(
  store: DataStore,
  input: EvidenceBundleInput,
): EvidenceBundleCommitResult {
  let preparation: PreparationResult;
  try {
    preparation = prepareEvidenceBundle(input);
  } catch {
    return { status: 'failed', reason: INVALID_INPUT_REASON };
  }
  if (!preparation.ok) {
    return { status: 'failed', reason: preparation.reason };
  }

  const { bundle } = preparation;
  let transactionResult: TransactionResult;
  try {
    const datastore = requireDrizzleHandle(store);
    transactionResult = datastore.withWriteLock('evidence-bundle.commit', () =>
      datastore.transaction((tx) => commitPreparedBundle(tx, bundle, input.precondition)),
    );
  } catch {
    return { status: 'failed', reason: 'write-failed' };
  }

  if (transactionResult.status === 'precondition-rejected') {
    return { status: 'precondition-rejected' };
  }
  if (transactionResult.status === 'missing-session-link') {
    return { status: 'failed', reason: 'missing-session-link' };
  }

  for (const entry of bundle.sessions) {
    try {
      reportPreparedSessionWrite(entry.prepared);
    } catch {
      // @swallow-ok the transaction is already committed. Diagnostics are
      // best-effort and must not escape or relabel durable evidence as failed.
    }
  }
  return {
    status: 'committed',
    sessionIds: bundle.sessions.map((entry) => entry.prepared.sessionId),
    ...(bundle.run === undefined ? {} : { runId: bundle.run.prepared.runId }),
    sessionCount: bundle.sessions.length,
    stepCount: bundle.run?.steps.length ?? 0,
    serializedBytes: bundle.serializedBytes,
    persistMs: transactionResult.persistMs,
  };
}

function prepareEvidenceBundle(input: EvidenceBundleInput): PreparationResult {
  if (
    !isObjectRecord(input) ||
    !isReadonlyArray(input.sessions) ||
    input.sessions.some(
      (entry) =>
        !isObjectRecord(entry) ||
        !isObjectRecord(entry.session) ||
        !isObjectRecord(entry.hostMetrics),
    ) ||
    (input.run !== undefined &&
      (!isObjectRecord(input.run) ||
        !isObjectRecord(input.run.run) ||
        !isReadonlyArray(input.run.steps) ||
        input.run.steps.some((step) => !isObjectRecord(step)))) ||
    (input.precondition !== undefined && typeof input.precondition !== 'function')
  ) {
    return { ok: false, reason: INVALID_INPUT_REASON };
  }
  if (
    input.sessions.length > MAX_EVIDENCE_BUNDLE_SESSIONS ||
    (input.run?.steps.length ?? 0) > MAX_EVIDENCE_BUNDLE_STEPS
  ) {
    return { ok: false, reason: 'limit-exceeded' };
  }

  const ids = [
    ...input.sessions.map((entry) => entry.session.id),
    ...(input.run === undefined ? [] : [input.run.run.id]),
    ...(input.run?.steps.map((step) => step.id) ?? []),
  ];
  if (new Set(ids).size !== ids.length) {
    return { ok: false, reason: 'duplicate-id' };
  }
  const linkedSessionIds =
    input.run?.steps.flatMap((step) => (step.sessionId === undefined ? [] : [step.sessionId])) ??
    [];
  if (new Set(linkedSessionIds).size !== linkedSessionIds.length) {
    return { ok: false, reason: 'duplicate-id' };
  }
  if (input.run?.steps.some((step) => step.runId !== input.run?.run.id)) {
    return { ok: false, reason: INVALID_INPUT_REASON };
  }

  let serializedBytes: number;
  try {
    serializedBytes = measureEvidenceBundleBytes(input);
  } catch {
    return { ok: false, reason: INVALID_INPUT_REASON };
  }
  if (serializedBytes > MAX_EVIDENCE_BUNDLE_BYTES) {
    return { ok: false, reason: 'limit-exceeded' };
  }

  try {
    return {
      ok: true,
      bundle: {
        sessions: input.sessions.map(prepareSessionEntry),
        ...(input.run === undefined
          ? {}
          : {
              run: {
                prepared: prepareRunWrite(input.run.run),
                steps: input.run.steps.map(prepareRunStepWrite),
              },
            }),
        serializedBytes,
      },
    };
  } catch {
    return { ok: false, reason: INVALID_INPUT_REASON };
  }
}

function prepareSessionEntry(entry: EvidenceBundleSession): {
  readonly prepared: PreparedSessionWrite;
  readonly hostMetrics: StoredSessionHostMetrics;
} {
  const prepared = prepareSessionWrite(entry.session);
  prepareHostMetricsWrite(entry.session.id, entry.hostMetrics);
  return { prepared, hostMetrics: entry.hostMetrics };
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isReadonlyArray(value: unknown): value is readonly unknown[] {
  return Array.isArray(value);
}

function commitPreparedBundle(
  tx: DrizzleHandle,
  bundle: PreparedEvidenceBundle,
  precondition: EvidenceBundlePrecondition | undefined,
): TransactionResult {
  if (precondition !== undefined && !precondition()) {
    return { status: 'precondition-rejected' };
  }
  if (!allSessionLinksResolve(tx, bundle)) {
    return { status: 'missing-session-link' };
  }

  const persistStartedAt = performance.now();
  for (const entry of bundle.sessions) writePreparedSession(tx, entry.prepared);
  if (bundle.run !== undefined) {
    writePreparedRun(tx, bundle.run.prepared);
    for (const step of bundle.run.steps) writePreparedRunStep(tx, step);
  }

  // Freeze one bundle-wide persistence delta immediately before metrics. Every
  // sibling row receives the same host-write cost regardless of input order;
  // metric insertion order must not become observable timing vocabulary.
  const persistMs = Math.max(0, performance.now() - persistStartedAt);
  for (const entry of bundle.sessions) {
    writeHostMetricsRowOrThrow(tx, entry.prepared.sessionId, {
      ...entry.hostMetrics,
      persistMs: (entry.hostMetrics.persistMs ?? 0) + persistMs,
    });
  }
  return { status: 'committed', persistMs };
}

function allSessionLinksResolve(tx: DrizzleHandle, bundle: PreparedEvidenceBundle): boolean {
  if (bundle.run === undefined) return true;
  const inBundle = new Set(bundle.sessions.map((entry) => entry.prepared.sessionId));
  const retainedIds = [
    ...new Set(
      bundle.run.steps.flatMap((entry) => {
        const { sessionId } = entry;
        return sessionId === undefined || inBundle.has(sessionId) ? [] : [sessionId];
      }),
    ),
  ];
  if (retainedIds.length === 0) return true;
  const retained = tx
    .select({ id: sessions.id })
    .from(sessions)
    .where(inArray(sessions.id, retainedIds))
    .all();
  return retained.length === retainedIds.length;
}

/**
 * Measure an input with the exact canonical byte accounting enforced by
 * {@link commitEvidenceBundle}. Host accumulators can use this pure seam to
 * reject an over-budget contribution before finalization.
 */
export function measureEvidenceBundleBytes(input: EvidenceBundleInput): number {
  const canonical = canonicalJson({
    sessions: input.sessions,
    ...(input.run === undefined ? {} : { run: input.run }),
  });
  return Buffer.byteLength(canonical, 'utf8');
}

function canonicalJson(value: unknown): string {
  const ordinary = JSON.stringify(value);
  if (ordinary === undefined) throw new TypeError('Evidence bundle is not JSON serializable.');
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
