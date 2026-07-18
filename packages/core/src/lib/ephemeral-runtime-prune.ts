/**
 * @fileoverview Bounded, lease-aware retention for no-init runtime caches.
 *
 * The marker writer/reader remains in ephemeral-runtime.ts. This module owns
 * only destructive hygiene so its fail-closed proofs stay reviewable without
 * pushing the metadata surface past the repository's file-length guardrail.
 */

import { createHash } from 'node:crypto';
import { existsSync, lstatSync, opendirSync, realpathSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';

import { inspectEphemeralRuntimeRoot } from './ephemeral-runtime-directory.js';
import {
  DEFAULT_EPHEMERAL_KEEP,
  DEFAULT_EPHEMERAL_MAX_AGE_DAYS,
  EPHEMERAL_MARKER_FILE,
  EPHEMERAL_MARKER_MAX_BYTES,
  EPHEMERAL_RUNTIME_TEST_HOOKS,
  parseEphemeralMarker,
  type EphemeralMarker,
  type EphemeralMarkerReadResult,
  type EphemeralRuntimeTestHooks,
  type PruneEphemeralInput,
  type PruneEphemeralResult,
} from './ephemeral-runtime.js';
import { withFileLockAsync, type FileLockEvent } from './file-lock.js';
import { projectCoordinationKey } from './paths.js';
import {
  acquireRuntimeExclusiveLease,
  listActiveRuntimeLeaseKeys,
  readAnchoredRecord,
  type RuntimeLeaseEvent,
} from './runtime-lease.js';

import type { BigIntStats } from 'node:fs';

const CACHE_KEY_PATTERN = /^[a-f0-9]{24}$/u;
const MAX_PROTECTED_COORDINATION_KEYS = 256;
const MAX_PRUNE_LOCK_ATTEMPTS = 128;
const MAX_PRUNE_DELETIONS = 64;
const PRUNE_ENUMERATION_WAIT_MS = 200;
const PRUNE_CANDIDATE_WAIT_MS = 200;
const PRUNE_PASS_BUDGET_MS = 1000;
const MAX_PRUNE_SCAN_ENTRIES = 1024;
const PRUNE_PASS_LOCK_FILE = '.prune-pass.lock';
const CACHE_PERMISSION_POSTURE = 'owner-controlled' as const;
const PRUNE_PASS_LOCK_POLICY = Object.freeze({
  waitMs: 250,
  staleMs: 30_000,
  heartbeatMs: 5000,
});

type PruneEphemeralInputWithTestHooks = PruneEphemeralInput & {
  readonly [EPHEMERAL_RUNTIME_TEST_HOOKS]?: EphemeralRuntimeTestHooks;
};

interface PruneDeadline {
  readonly expiresAt: number;
  readonly monotonicNow: () => number;
}

function remainingBudget(deadline: PruneDeadline, cap: number): number {
  return Math.max(0, Math.min(cap, Math.floor(deadline.expiresAt - deadline.monotonicNow())));
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function isMissingFsError(error: unknown): boolean {
  return (
    error instanceof Error && 'code' in error && (error as NodeJS.ErrnoException).code === 'ENOENT'
  );
}

/**
 * Bounded cache-entry enumeration. `undefined` means the scan could not prove a
 * complete view, so callers must grant no deletion authority.
 */
function listEntries(root: string): string[] | undefined {
  let directory;
  try {
    directory = opendirSync(root);
  } catch (error) {
    return isMissingFsError(error) ? [] : undefined;
  }
  const entries: string[] = [];
  let inspected = 0;
  let complete = true;
  try {
    for (;;) {
      const entry = directory.readSync();
      if (entry === null) break;
      inspected += 1;
      if (inspected > MAX_PRUNE_SCAN_ENTRIES) {
        complete = false;
        break;
      }
      if (entry.isDirectory()) entries.push(entry.name);
    }
  } catch {
    complete = false;
  }
  try {
    directory.closeSync();
  } catch {
    complete = false;
  }
  return complete ? entries : undefined;
}

type Verdict = 'orphaned' | 'stale' | 'keep';
type ProjectPresence = 'present' | 'absent' | 'uncertain';

function inspectProjectPresence(projectDir: string): ProjectPresence {
  try {
    const stat = lstatSync(projectDir);
    if (!stat.isDirectory() || stat.isSymbolicLink()) return 'uncertain';
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code === 'ENOENT' || code === 'ENOTDIR' ? 'absent' : 'uncertain';
  }
  try {
    realpathSync(projectDir);
    return 'present';
  } catch {
    // A path that changes or becomes inaccessible after lstat is not proof of
    // orphanhood; preserve it for a later pass.
    return 'uncertain';
  }
}

function classifyEntry(
  projectPresence: Exclude<ProjectPresence, 'uncertain'>,
  usedAt: number,
  now: number,
  maxAgeMs: number,
): Verdict {
  if (projectPresence === 'absent') return 'orphaned';
  if (now - usedAt > maxAgeMs) return 'stale';
  return 'keep';
}

interface DirectoryIdentity {
  readonly dev: bigint;
  readonly ino: bigint;
  readonly mtimeNs: bigint;
  readonly ctimeNs: bigint;
}

interface PruneCandidate {
  readonly key: string;
  readonly entryDir: string;
  readonly projectDir: string;
  readonly coordinationKey: string;
  readonly usedAt: number;
  readonly markerSha256: string;
  readonly directoryIdentity: DirectoryIdentity;
  readonly verdict: Verdict;
}

function directoryIdentity(stat: BigIntStats): DirectoryIdentity {
  return {
    dev: stat.dev,
    ino: stat.ino,
    mtimeNs: stat.mtimeNs,
    ctimeNs: stat.ctimeNs,
  };
}

function sameDirectoryIdentity(left: DirectoryIdentity, right: DirectoryIdentity): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  );
}

function expectedCurrentCacheKey(marker: EphemeralMarker): string {
  if (marker.identityStrength === 'path-only') return marker.canonicalRootDigest.slice(0, 24);
  return sha256(
    `opensip-ephemeral-cache-v2\0${marker.canonicalRootDigest}\0${marker.generationDigest}`,
  ).slice(0, 24);
}

function markerCoordinationProof(
  key: string,
  marker: EphemeralMarkerReadResult,
): { readonly projectDir: string; readonly coordinationKey: string } | undefined {
  if (marker.status === 'current') {
    if (sha256(marker.marker.projectDir) !== marker.marker.canonicalRootDigest) return;
    const coordinationKey = marker.marker.canonicalRootDigest.slice(0, 24);
    if (
      key !== expectedCurrentCacheKey(marker.marker) ||
      projectCoordinationKey(marker.marker.projectDir) !== coordinationKey
    ) {
      return;
    }
    return { projectDir: marker.marker.projectDir, coordinationKey };
  }
  if (marker.status !== 'legacy') return;
  const coordinationKey = projectCoordinationKey(marker.marker.projectDir);
  if (key !== coordinationKey) return;
  return { projectDir: marker.marker.projectDir, coordinationKey };
}

function inspectPruneCandidate(
  root: string,
  key: string,
  now: number,
  maxAgeMs: number,
): PruneCandidate | undefined {
  if (!CACHE_KEY_PATTERN.test(key)) return;
  const entryDir = join(root, key);
  try {
    const before = lstatSync(entryDir, { bigint: true });
    if (!before.isDirectory() || before.isSymbolicLink()) return;
    const observed = readAnchoredRecord({
      trustedAnchorDir: root,
      parentDir: entryDir,
      basename: EPHEMERAL_MARKER_FILE,
      maxBytes: EPHEMERAL_MARKER_MAX_BYTES,
      permissionPosture: CACHE_PERMISSION_POSTURE,
    });
    if (observed.status !== 'present') return;
    const marker = parseEphemeralMarker(observed.content);
    if (marker.status !== 'current' && marker.status !== 'legacy') return;
    const proof = markerCoordinationProof(key, marker);
    if (proof === undefined) return;
    const projectPresence = inspectProjectPresence(proof.projectDir);
    if (projectPresence === 'uncertain') return;
    const after = lstatSync(entryDir, { bigint: true });
    const beforeIdentity = directoryIdentity(before);
    if (
      !after.isDirectory() ||
      after.isSymbolicLink() ||
      !sameDirectoryIdentity(beforeIdentity, directoryIdentity(after))
    ) {
      return;
    }
    const usedAt = Date.parse(marker.marker.lastUsedAt);
    return {
      key,
      entryDir,
      ...proof,
      usedAt,
      markerSha256: observed.sha256,
      directoryIdentity: beforeIdentity,
      verdict: classifyEntry(projectPresence, usedAt, now, maxAgeMs),
    };
  } catch {
    return;
  }
}

function sameCandidateSnapshot(left: PruneCandidate, right: PruneCandidate): boolean {
  return (
    left.key === right.key &&
    left.projectDir === right.projectDir &&
    left.coordinationKey === right.coordinationKey &&
    left.usedAt === right.usedAt &&
    left.markerSha256 === right.markerSha256 &&
    sameDirectoryIdentity(left.directoryIdentity, right.directoryIdentity)
  );
}

function compareCandidatesByAge(left: PruneCandidate, right: PruneCandidate): number {
  return left.usedAt - right.usedAt || left.key.localeCompare(right.key);
}

function revalidateOverflowCandidate(
  root: string,
  candidate: PruneCandidate,
  keep: number,
  now: number,
  maxAgeMs: number,
  deadline: PruneDeadline,
): PruneCandidate | undefined {
  const keys = listEntries(root);
  if (keys === undefined || keys.length <= keep) return;
  const currentCandidates: PruneCandidate[] = [];
  for (const key of keys) {
    if (remainingBudget(deadline, PRUNE_PASS_BUDGET_MS) <= 0) return;
    const current = inspectPruneCandidate(root, key, now, maxAgeMs);
    if (current === undefined) return;
    currentCandidates.push(current);
  }
  currentCandidates.sort(compareCandidatesByAge);
  const oldest = currentCandidates.slice(0, keys.length - keep);
  const current = oldest.find((entry) => entry.key === candidate.key);
  if (current === undefined || !sameCandidateSnapshot(candidate, current)) return;
  return current;
}

function removeRevalidatedCandidate(candidate: PruneCandidate): boolean {
  try {
    const immediatelyBefore = lstatSync(candidate.entryDir, { bigint: true });
    if (
      !immediatelyBefore.isDirectory() ||
      immediatelyBefore.isSymbolicLink() ||
      !sameDirectoryIdentity(candidate.directoryIdentity, directoryIdentity(immediatelyBefore))
    ) {
      return false;
    }
    rmSync(candidate.entryDir, { recursive: true });
    return !existsSync(candidate.entryDir);
  } catch {
    return false;
  }
}

function emptyPruneResult(): PruneEphemeralResult {
  return {
    scanned: 0,
    removedOrphaned: 0,
    removedStale: 0,
    removedOverflow: 0,
    skippedActive: 0,
    skippedChanged: 0,
  };
}

async function resolveProtectedCoordinationKeys(
  requested: readonly string[],
  deadline: PruneDeadline,
  onEvent?: (event: RuntimeLeaseEvent | FileLockEvent) => void,
  hooks?: EphemeralRuntimeTestHooks,
): Promise<ReadonlySet<string> | undefined> {
  if (
    requested.length > MAX_PROTECTED_COORDINATION_KEYS ||
    requested.some((key) => !CACHE_KEY_PATTERN.test(key))
  ) {
    return;
  }
  try {
    const waitMs = remainingBudget(deadline, PRUNE_ENUMERATION_WAIT_MS);
    if (waitMs <= 0) return;
    const active = await listActiveRuntimeLeaseKeys({
      policy: { waitMs, pollMs: 5 },
      onEvent,
    });
    await hooks?.afterActiveSnapshot?.();
    if (remainingBudget(deadline, PRUNE_PASS_BUDGET_MS) <= 0) return;
    const protectedKeys = new Set([...requested, ...active]);
    if (protectedKeys.size > MAX_PROTECTED_COORDINATION_KEYS) return;
    return protectedKeys;
  } catch {
    return;
  }
}

interface PruneExecution {
  attempts: number;
  deletions: number;
  budgetExhausted: boolean;
  removedOrphaned: number;
  removedStale: number;
  removedOverflow: number;
  readonly removedKeys: Set<string>;
  readonly attemptedKeys: Set<string>;
  readonly skippedActive: Set<string>;
  readonly skippedChanged: Set<string>;
}

async function deleteCandidate(
  root: string,
  candidate: PruneCandidate,
  reason: Exclude<Verdict, 'keep'> | 'overflow',
  protectedKeys: ReadonlySet<string>,
  now: number,
  maxAgeMs: number,
  state: PruneExecution,
  deadline: PruneDeadline,
  onEvent?: (event: RuntimeLeaseEvent | FileLockEvent) => void,
  hooks?: EphemeralRuntimeTestHooks,
  overflowKeep?: number,
): Promise<boolean> {
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
    lease.release();
  }
}

function createPruneExecution(): PruneExecution {
  return {
    attempts: 0,
    deletions: 0,
    budgetExhausted: false,
    removedOrphaned: 0,
    removedStale: 0,
    removedOverflow: 0,
    removedKeys: new Set(),
    attemptedKeys: new Set(),
    skippedActive: new Set(),
    skippedChanged: new Set(),
  };
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
    await deleteCandidate(
      input.root,
      candidate,
      candidate.verdict,
      input.protectedKeys,
      input.now,
      input.maxAgeMs,
      input.state,
      input.deadline,
      input.onEvent,
      input.hooks,
    );
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
    await deleteCandidate(
      input.root,
      candidate,
      'overflow',
      input.protectedKeys,
      input.now,
      input.maxAgeMs,
      input.state,
      input.deadline,
      input.onEvent,
      input.hooks,
      input.keep,
    );
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
  const entries = listEntries(input.root);
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
  const initialEntries = listEntries(root);
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
