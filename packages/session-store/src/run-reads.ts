import { SystemError } from '@opensip-cli/core';
import { requireDrizzleHandle } from '@opensip-cli/datastore/internal';

import { sessionStoreErrorCatalog } from './errors/session-store-error-catalog.js';
import {
  deepFreeze,
  DEFAULT_PARENT_RUN_LIST_LIMIT,
  DEFAULT_PARENT_RUN_STEP_LIMIT,
  MAX_PARENT_RUN_READ_LIMIT,
  requireOffset,
  requirePositiveLimit,
  requireRunId,
} from './run-read-validation.js';
import {
  countRunStepsFromTx,
  readRunByIdFromTx,
  readRunsPageFromTx,
  readRunStepsPageFromTx,
  readUnresolvableRunIdFromTx,
} from './run-repo.js';
import { isSessionCwdWithin } from './session-cwd-scope.js';

import type { StoredRun, StoredRunStep } from '@opensip-cli/contracts';
import type { DataStore } from '@opensip-cli/datastore';

// Plan 01: 22 literals become five registered definitions; the branch lives in metadata.
const UNSAFE_LEGACY = sessionStoreErrorCatalog.require('SESSION.EVIDENCE.UNSAFE_LEGACY_VALUE');

export {
  resolveParentRunEvidence,
  type ParentRunEvidenceFound,
  type ParentRunEvidenceInclusion,
  type ParentRunEvidenceMetadata,
  type ParentRunEvidenceSnapshot,
  type ResolveParentRunEvidenceOptions,
  type ResolveParentRunEvidenceResult,
} from './run-evidence-read.js';
export {
  DEFAULT_PARENT_RUN_EVIDENCE_BYTE_BUDGET,
  DEFAULT_PARENT_RUN_LIST_LIMIT,
  DEFAULT_PARENT_RUN_STEP_LIMIT,
  MAX_PARENT_RUN_EVIDENCE_BYTE_BUDGET,
  MAX_PARENT_RUN_READ_LIMIT,
} from './run-read-validation.js';

/** Filters for a bounded newest-first parent-Run page. */
export interface ListParentRunsOptions {
  readonly limit?: number;
  /** Optional fail-closed project-root scope, applied before the public limit. */
  readonly cwdWithin?: string;
}

/** Bounded newest-first parent-Run page and truncation metadata. */
export interface ParentRunList {
  readonly runs: readonly StoredRun[];
  readonly requestedLimit: number;
  readonly effectiveLimit: number;
  readonly truncated: boolean;
}

/** Exact parent-Run identity, pagination, and optional project scope. */
export interface ResolveParentRunOptions {
  readonly runId: string;
  readonly offset?: number;
  readonly limit?: number;
  /** Optional fail-closed project-root scope for the exact parent. */
  readonly cwdWithin?: string;
}

/** Successful exact parent-Run and deterministic RunStep page. */
export interface ParentRunFound {
  readonly status: 'found';
  readonly run: StoredRun;
  readonly steps: readonly StoredRunStep[];
  readonly total: number;
  readonly offset: number;
  readonly limit: number;
  readonly nextOffset?: number;
}

/** Exact parent-Run read that found no in-scope identity. */
export interface ParentRunNotFound {
  readonly status: 'not-found';
}

/** Exact parent-Run read result. */
export type ResolveParentRunResult = ParentRunFound | ParentRunNotFound;

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
    'list-limit',
    'parent Run list limit',
  );
  const datastore = requireDrizzleHandle(store);
  return datastore.transaction((tx) => {
    const cwdWithin = options.cwdWithin;
    if (readUnresolvableRunIdFromTx(tx, cwdWithin) !== null) {
      throw new SystemError('Stored parent Run history contains an unsupported legacy Run ID.', {
        code: UNSAFE_LEGACY.code,
        definition: UNSAFE_LEGACY,
        metadata: { field: 'legacy-id' },
      });
    }
    const rows = readRunsPageFromTx(tx, 0, effectiveLimit + 1, cwdWithin);
    if (cwdWithin !== undefined && rows.some((run) => !isSessionCwdWithin(run.cwd, cwdWithin))) {
      throw new SystemError('Stored parent Run history contains an unsupported legacy cwd.', {
        code: UNSAFE_LEGACY.code,
        definition: UNSAFE_LEGACY,
        metadata: { field: 'legacy-cwd' },
      });
    }
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
    'step-limit',
    'parent Run step limit',
  );
  const datastore = requireDrizzleHandle(store);
  return datastore.transaction((tx) => {
    const run = readRunByIdFromTx(tx, runId);
    if (
      run === null ||
      (options.cwdWithin !== undefined && !isSessionCwdWithin(run.cwd, options.cwdWithin))
    ) {
      return deepFreeze({ status: 'not-found' as const });
    }
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
