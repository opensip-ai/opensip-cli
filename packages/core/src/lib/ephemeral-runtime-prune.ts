/**
 * @fileoverview Bounded, lease-aware retention for no-init runtime caches.
 *
 * The marker writer/reader remains in ephemeral-runtime.ts. This module owns
 * only destructive hygiene so its fail-closed proofs stay reviewable without
 * pushing the metadata surface past the repository's file-length guardrail.
 */

import { join } from 'node:path';
import { performance } from 'node:perf_hooks';

import { inspectEphemeralRuntimeRoot } from './ephemeral-runtime-directory.js';
import {
  PRUNE_PASS_BUDGET_MS,
  compareCandidatesByAge,
  inspectPruneCandidate,
  listPruneEntries,
  revalidateOverflowCandidate,
  remainingBudget,
  removeRevalidatedCandidate,
  sameCandidateSnapshot,
  type PruneCandidate,
  type PruneDeadline,
  type PruneVerdict,
} from './ephemeral-runtime-prune-candidates.js';
import { resolveProtectedCoordinationKeys } from './ephemeral-runtime-prune-protection.js';
import {
  createPruneExecution,
  emptyPruneResult,
  type PruneExecution,
} from './ephemeral-runtime-prune-state.js';
import {
  DEFAULT_EPHEMERAL_KEEP,
  DEFAULT_EPHEMERAL_MAX_AGE_DAYS,
  EPHEMERAL_RUNTIME_TEST_HOOKS,
  type EphemeralRuntimeTestHooks,
  type PruneEphemeralInput,
  type PruneEphemeralResult,
} from './ephemeral-runtime.js';
import { withFileLockAsync, type FileLockEvent } from './file-lock.js';
import { acquireRuntimeExclusiveLease, type RuntimeLeaseEvent } from './runtime-lease.js';

const MAX_PRUNE_LOCK_ATTEMPTS = 128;
const MAX_PRUNE_DELETIONS = 64;
const PRUNE_CANDIDATE_WAIT_MS = 200;
const PRUNE_PASS_LOCK_FILE = '.prune-pass.lock';
const PRUNE_PASS_LOCK_POLICY = Object.freeze({
  waitMs: 250,
  staleMs: 30_000,
  heartbeatMs: 5000,
});

type PruneEphemeralInputWithTestHooks = PruneEphemeralInput & {
  readonly [EPHEMERAL_RUNTIME_TEST_HOOKS]?: EphemeralRuntimeTestHooks;
};

interface CandidateDeletion {
  readonly root: string;
  readonly candidate: PruneCandidate;
  readonly reason: Exclude<PruneVerdict, 'keep'> | 'overflow';
  readonly protectedKeys: ReadonlySet<string>;
  readonly now: number;
  readonly maxAgeMs: number;
  readonly state: PruneExecution;
  readonly deadline: PruneDeadline;
  readonly onEvent?: (event: RuntimeLeaseEvent | FileLockEvent) => void;
  readonly hooks?: EphemeralRuntimeTestHooks;
  readonly overflowKeep?: number;
}

async function deleteCandidate(deletion: CandidateDeletion): Promise<boolean> {
  const {
    root,
    candidate,
    reason,
    protectedKeys,
    now,
    maxAgeMs,
    state,
    deadline,
    onEvent,
    hooks,
    overflowKeep,
  } = deletion;
  if (protectedKeys.has(candidate.coordinationKey)) {
    state.skippedActive.add(candidate.key);
    return false;
  }
  if (state.attempts >= MAX_PRUNE_LOCK_ATTEMPTS || state.deletions >= MAX_PRUNE_DELETIONS) {
    state.skippedChanged.add(candidate.key);
    return false;
  }
  const waitMs = remainingBudget(deadline, PRUNE_CANDIDATE_WAIT_MS);
  if (waitMs <= 0) {
    state.budgetExhausted = true;
    state.skippedChanged.add(candidate.key);
    return false;
  }
  state.attempts += 1;
  state.attemptedKeys.add(candidate.key);
  let lease;
  try {
    lease = await acquireRuntimeExclusiveLease({
      projectDir: candidate.projectDir,
      command: 'cache-prune',
      policy: { waitMs, pollMs: 5 },
      onEvent,
    });
  } catch {
    // @swallow-ok Contention or uncertain lease state classifies the cache as active.
    state.skippedActive.add(candidate.key);
    return false;
  }

  try {
    if (lease.coordinationKey !== candidate.coordinationKey) {
      state.skippedChanged.add(candidate.key);
      return false;
    }
    await hooks?.beforeCandidateRevalidation?.(candidate.key);
    if (remainingBudget(deadline, PRUNE_PASS_BUDGET_MS) <= 0) {
      state.budgetExhausted = true;
      state.skippedChanged.add(candidate.key);
      return false;
    }
    const revalidated =
      overflowKeep === undefined
        ? inspectPruneCandidate(root, candidate.key, now, maxAgeMs)
        : revalidateOverflowCandidate(root, candidate, overflowKeep, now, maxAgeMs, deadline);
    if (remainingBudget(deadline, PRUNE_PASS_BUDGET_MS) <= 0) {
      state.budgetExhausted = true;
      state.skippedChanged.add(candidate.key);
      return false;
    }
    const eligible =
      revalidated !== undefined &&
      sameCandidateSnapshot(candidate, revalidated) &&
      (reason === 'overflow' || revalidated.verdict === reason);
    if (!eligible || !removeRevalidatedCandidate(revalidated)) {
      state.skippedChanged.add(candidate.key);
      return false;
    }
    state.deletions += 1;
    state.removedKeys.add(candidate.key);
    if (reason === 'orphaned') state.removedOrphaned += 1;
    else if (reason === 'stale') state.removedStale += 1;
    else state.removedOverflow += 1;
    return true;
  } finally {
    void lease.release();
  }
}

async function pruneAgedCandidates(input: {
  readonly root: string;
  readonly entries: readonly string[];
  readonly now: number;
  readonly maxAgeMs: number;
  readonly protectedKeys: ReadonlySet<string>;
  readonly state: PruneExecution;
  readonly deadline: PruneDeadline;
  readonly onEvent?: (event: RuntimeLeaseEvent | FileLockEvent) => void;
  readonly hooks?: EphemeralRuntimeTestHooks;
}): Promise<readonly PruneCandidate[]> {
  const candidates: PruneCandidate[] = [];
  for (const key of input.entries) {
    if (remainingBudget(input.deadline, PRUNE_PASS_BUDGET_MS) <= 0) {
      input.state.budgetExhausted = true;
      break;
    }
    const candidate = inspectPruneCandidate(input.root, key, input.now, input.maxAgeMs);
    if (candidate === undefined) {
      input.state.skippedChanged.add(key);
      continue;
    }
    candidates.push(candidate);
    if (candidate.verdict === 'keep') continue;
    await deleteCandidate({
      root: input.root,
      candidate,
      reason: candidate.verdict,
      protectedKeys: input.protectedKeys,
      now: input.now,
      maxAgeMs: input.maxAgeMs,
      state: input.state,
      deadline: input.deadline,
      onEvent: input.onEvent,
      hooks: input.hooks,
    });
  }
  return candidates;
}

async function pruneOverflowCandidates(input: {
  readonly root: string;
  readonly entries: readonly string[];
  readonly candidates: readonly PruneCandidate[];
  readonly keep: number;
  readonly now: number;
  readonly maxAgeMs: number;
  readonly protectedKeys: ReadonlySet<string>;
  readonly state: PruneExecution;
  readonly deadline: PruneDeadline;
  readonly onEvent?: (event: RuntimeLeaseEvent | FileLockEvent) => void;
  readonly hooks?: EphemeralRuntimeTestHooks;
}): Promise<void> {
  if (input.keep <= 0 || input.state.budgetExhausted) return;
  const remaining = input.entries.length - input.state.deletions;
  const overflowNeeded = Math.max(0, remaining - input.keep);
  const oldestFirst = [...input.candidates];
  oldestFirst.sort(compareCandidatesByAge);
  for (const candidate of oldestFirst) {
    if (remainingBudget(input.deadline, PRUNE_PASS_BUDGET_MS) <= 0) {
      input.state.budgetExhausted = true;
      return;
    }
    if (input.state.removedOverflow >= overflowNeeded) return;
    if (
      input.state.removedKeys.has(candidate.key) ||
      input.state.attemptedKeys.has(candidate.key)
    ) {
      continue;
    }
    await deleteCandidate({
      root: input.root,
      candidate,
      reason: 'overflow',
      protectedKeys: input.protectedKeys,
      now: input.now,
      maxAgeMs: input.maxAgeMs,
      state: input.state,
      deadline: input.deadline,
      onEvent: input.onEvent,
      hooks: input.hooks,
      overflowKeep: input.keep,
    });
  }
}

function validPruneInput(now: number, maxAgeDays: number, keep: number): boolean {
  return (
    Number.isSafeInteger(now) &&
    now >= 0 &&
    Number.isFinite(maxAgeDays) &&
    maxAgeDays >= 0 &&
    maxAgeDays <= Number.MAX_SAFE_INTEGER / (24 * 60 * 60 * 1000) &&
    Number.isSafeInteger(keep) &&
    keep >= 0
  );
}

async function executePrunePass(input: {
  readonly root: string;
  readonly now: number;
  readonly maxAgeDays: number;
  readonly keep: number;
  readonly protectedKeys: ReadonlySet<string>;
  readonly deadline: PruneDeadline;
  readonly onEvent?: (event: RuntimeLeaseEvent | FileLockEvent) => void;
  readonly hooks?: EphemeralRuntimeTestHooks;
}): Promise<PruneEphemeralResult> {
  const entries = listPruneEntries(input.root);
  if (entries === undefined) return emptyPruneResult();
  const maxAgeMs =
    input.maxAgeDays <= 0 ? Number.POSITIVE_INFINITY : input.maxAgeDays * 24 * 60 * 60 * 1000;
  const state = createPruneExecution();
  const candidates = await pruneAgedCandidates({
    root: input.root,
    entries,
    now: input.now,
    maxAgeMs,
    protectedKeys: input.protectedKeys,
    state,
    deadline: input.deadline,
    onEvent: input.onEvent,
    hooks: input.hooks,
  });
  await pruneOverflowCandidates({
    root: input.root,
    entries,
    candidates,
    keep: input.keep,
    now: input.now,
    maxAgeMs,
    protectedKeys: input.protectedKeys,
    state,
    deadline: input.deadline,
    onEvent: input.onEvent,
    hooks: input.hooks,
  });
  return {
    scanned: entries.length,
    removedOrphaned: state.removedOrphaned,
    removedStale: state.removedStale,
    removedOverflow: state.removedOverflow,
    skippedActive: state.skippedActive.size,
    skippedChanged: state.skippedChanged.size,
  };
}

/**
 * Drop ephemeral cache entries that can no longer be useful. Active
 * path-stable coordination keys are preserved from an advisory snapshot, then
 * every deletion is re-authorized by a same-key exclusive lease.
 */
export async function pruneEphemeralRuntimes(
  input: PruneEphemeralInput = {},
): Promise<PruneEphemeralResult> {
  const internalInput = input as PruneEphemeralInputWithTestHooks;
  const hooks = internalInput[EPHEMERAL_RUNTIME_TEST_HOOKS];
  const now = input.now ?? Date.now();
  const maxAgeDays = input.maxAgeDays ?? DEFAULT_EPHEMERAL_MAX_AGE_DAYS;
  const keep = input.keep ?? DEFAULT_EPHEMERAL_KEEP;
  if (!validPruneInput(now, maxAgeDays, keep)) return emptyPruneResult();
  const monotonicNow = hooks?.pruneMonotonicNow ?? (() => performance.now());
  const deadline = {
    monotonicNow,
    expiresAt: monotonicNow() + PRUNE_PASS_BUDGET_MS,
  };
  let userPaths;
  try {
    userPaths = inspectEphemeralRuntimeRoot();
  } catch {
    return emptyPruneResult();
  }
  if (userPaths === undefined) return emptyPruneResult();
  const root = userPaths.ephemeralProjectsDir;
  const protectedKeys = await resolveProtectedCoordinationKeys(
    input.protectedCoordinationKeys ?? [],
    deadline,
    input.onEvent,
    hooks,
  );
  if (protectedKeys === undefined) return emptyPruneResult();
  const initialEntries = listPruneEntries(root);
  if (initialEntries === undefined || initialEntries.length === 0) return emptyPruneResult();
  const passLockWaitMs = remainingBudget(deadline, PRUNE_PASS_LOCK_POLICY.waitMs);
  if (passLockWaitMs <= 0) return emptyPruneResult();
  try {
    return await withFileLockAsync(
      join(userPaths.cacheDir, PRUNE_PASS_LOCK_FILE),
      {
        policy: { ...PRUNE_PASS_LOCK_POLICY, waitMs: passLockWaitMs },
        resource: 'runtime',
        operation: 'ephemeral-prune-pass',
        onEvent: input.onEvent,
      },
      () =>
        executePrunePass({
          root,
          now,
          maxAgeDays,
          keep,
          protectedKeys,
          deadline,
          onEvent: input.onEvent,
          hooks,
        }),
    );
  } catch {
    return emptyPruneResult();
  }
}
