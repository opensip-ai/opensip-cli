/**
 * @fileoverview Generic file-lock primitive for datastore, artifact, and runtime writes.
 *
 * Publishes complete JSON records through a private temp + hard-link create,
 * replaces heartbeats atomically, recovers unchanged abandoned records, and
 * emits injected lifecycle events. No CLI or diagnostics imports — callers
 * bridge events at the composition root.
 */

// @fitness-ignore-file file-length-limit -- single lock state machine; splitting would scatter the lease protocol

import { createHash } from 'node:crypto';
import {
  constants as fsConstants,
  closeSync,
  fchmodSync,
  fstatSync,
  fsyncSync,
  ftruncateSync,
  linkSync,
  lstatSync,
  openSync,
  readSync,
  renameSync,
  type BigIntStats,
  unlinkSync,
  writeSync,
} from 'node:fs';
import { hostname } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { performance } from 'node:perf_hooks';

import { SystemError, TimeoutError } from './errors.js';
import {
  createSafetyBiasedProcessInspector,
  defaultHostInstanceIdentity,
  deriveHostIdentity,
  inspectProcessIncarnation,
  type SafetyBiasedProcessInspector,
} from './host-process-identity.js';
import { generateUUID } from './ids.js';

/** Resolved lock timing policy (local vs CI overrides). */
export interface StateLockPolicy {
  readonly waitMs: number;
  readonly staleMs: number;
  readonly heartbeatMs: number;
}

/** Metadata written into a lockfile (safe to log — no secrets or payloads). */
export interface FileLockMetadata {
  ownerToken: string;
  pid: number;
  hostname: string;
  /** Opaque boot/namespace identity; absent from legacy lock records. */
  hostInstanceIdentity?: string;
  hostIdentityProven?: boolean;
  processIncarnation?: string;
  runId?: string;
  command?: string;
  cwdBasename: string;
  acquiredAt: number;
  lastHeartbeatAt: number;
  /** Owner-selected recovery horizon. Legacy records fall back to contender policy. */
  staleMs?: number;
}

/** Lock lifecycle event kinds emitted through {@link WithFileLockOptions.onEvent}. */
export type FileLockEventKind =
  'acquire.start' | 'acquire.wait' | 'acquire.complete' | 'acquire.timeout' | 'stale.recovered';

/** Resource category protected by a file lock. */
export type FileLockResource = 'datastore' | 'artifact' | 'runtime';

/** Structured lock lifecycle event emitted through the injected callback. */
export interface FileLockEvent {
  readonly kind: FileLockEventKind;
  readonly lockPath: string;
  readonly resource: FileLockResource;
  readonly operation?: string;
  readonly waitMs?: number;
  readonly ownerPid?: number;
  readonly ownerHostname?: string;
}

/** Options for {@link withFileLock} / {@link withFileLockAsync}. */
export interface WithFileLockOptions {
  readonly policy: StateLockPolicy;
  readonly resource: FileLockResource;
  readonly operation?: string;
  readonly runId?: string;
  readonly command?: string;
  readonly cwdBasename?: string;
  readonly onEvent?: (event: FileLockEvent) => void;
}

const POLL_MS = 50;

function monotonicNow(): number {
  return performance.now();
}

/**
 * Blocking sleep for the SYNC lock poll loop — yields the CPU instead of
 * busy-spinning. `Atomics.wait` on a throwaway SharedArrayBuffer parks the
 * thread in the kernel for the interval (the buffer value never changes, so
 * the wait always times out), so a second `opensip` run contending for the
 * same project DB no longer pegs a core for up to the full lock wait.
 * Falls back to a bounded spin only if Atomics.wait is unavailable in this
 * context (it throws in some embedder main threads).
 */
const sleepSyncCell = new Int32Array(new SharedArrayBuffer(4));
function sleepSync(ms: number): void {
  if (ms <= 0) return;
  try {
    Atomics.wait(sleepSyncCell, 0, 0, ms);
  } catch {
    // @swallow-ok Atomics.wait disallowed on this thread — degrade to the spin.
    const end = monotonicNow() + ms;
    while (monotonicNow() < end) {
      /* spin */
    }
  }
}

const MAX_LOCKFILE_BYTES = 4096;
const LOCKFILE_MODE = 0o600;
const MAX_TIMER_MS = 2_147_483_647;
const NO_FOLLOW = fsConstants.O_NOFOLLOW ?? 0;
const PROCESS_PROBE_CACHE_MS = 250;
const PROCESS_PROBE_CACHE_ENTRIES = 64;

interface LockFileIdentity {
  readonly dev: bigint;
  readonly ino: bigint;
  readonly size: bigint;
  readonly mtimeNs: bigint;
  readonly ctimeNs: bigint;
  readonly nlink: bigint;
}

interface LockSnapshotBase {
  readonly identity: LockFileIdentity;
  readonly raw?: string;
}

interface LockRecordSnapshot extends LockSnapshotBase {
  readonly kind: 'record';
  readonly raw: string;
  readonly metadata: FileLockMetadata;
}

type LockSnapshot =
  | { readonly kind: 'missing' }
  | { readonly kind: 'churn' }
  | { readonly kind: 'unsafe'; readonly reason: string }
  | ({ readonly kind: 'unreadable' } & LockSnapshotBase)
  | ({ readonly kind: 'invalid' } & LockSnapshotBase)
  | LockRecordSnapshot;

function identityOf(stat: BigIntStats): LockFileIdentity {
  return {
    dev: stat.dev,
    ino: stat.ino,
    size: stat.size,
    mtimeNs: stat.mtimeNs,
    ctimeNs: stat.ctimeNs,
    nlink: stat.nlink,
  };
}

function sameInode(a: LockFileIdentity, b: LockFileIdentity): boolean {
  return a.dev === b.dev && a.ino === b.ino;
}

function sameIdentity(a: LockFileIdentity, b: LockFileIdentity): boolean {
  return (
    sameInode(a, b) &&
    a.size === b.size &&
    a.mtimeNs === b.mtimeNs &&
    a.ctimeNs === b.ctimeNs &&
    a.nlink === b.nlink
  );
}

function errnoCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException).code;
}

function readBoundedFd(fd: number): Buffer | undefined {
  const bytes = Buffer.allocUnsafe(MAX_LOCKFILE_BYTES + 1);
  let offset = 0;
  while (offset < bytes.length) {
    const count = readSync(fd, bytes, offset, bytes.length - offset, offset);
    if (count === 0) break;
    offset += count;
  }
  if (offset > MAX_LOCKFILE_BYTES) return undefined;
  return bytes.subarray(0, offset);
}

function isStructurallyValidMetadata(value: unknown): value is FileLockMetadata {
  if (typeof value !== 'object' || value === null) return false;
  const parsed = value as Partial<FileLockMetadata>;
  return (
    typeof parsed.ownerToken === 'string' &&
    parsed.ownerToken.length > 0 &&
    Number.isInteger(parsed.pid) &&
    (parsed.pid ?? 0) > 0 &&
    typeof parsed.hostname === 'string' &&
    (parsed.hostInstanceIdentity === undefined ||
      (typeof parsed.hostInstanceIdentity === 'string' &&
        parsed.hostInstanceIdentity.length > 0)) &&
    (parsed.hostIdentityProven === undefined || typeof parsed.hostIdentityProven === 'boolean') &&
    (parsed.processIncarnation === undefined ||
      (typeof parsed.processIncarnation === 'string' && parsed.processIncarnation.length > 0)) &&
    typeof parsed.cwdBasename === 'string' &&
    Number.isFinite(parsed.acquiredAt) &&
    Number.isFinite(parsed.lastHeartbeatAt) &&
    (parsed.staleMs === undefined ||
      (Number.isSafeInteger(parsed.staleMs) &&
        parsed.staleMs > 0 &&
        parsed.staleMs <= MAX_TIMER_MS)) &&
    (parsed.runId === undefined || typeof parsed.runId === 'string') &&
    (parsed.command === undefined || typeof parsed.command === 'string')
  );
}

function closeQuietly(fd: number): void {
  try {
    closeSync(fd);
  } catch {
    // @swallow-ok callers preserve their primary result or error
  }
}

function pathHasIdentity(lockPath: string, expected: LockFileIdentity): boolean {
  try {
    return sameIdentity(expected, identityOf(lstatSync(lockPath, { bigint: true })));
  } catch {
    // @swallow-ok Missing or unreadable paths cannot prove the expected identity.
    return false;
  }
}

function parseLockSnapshot(bytes: Buffer, identity: LockFileIdentity): LockSnapshot {
  const raw = bytes.toString('utf8');
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { kind: 'unreadable', identity, raw };
  }
  if (!isStructurallyValidMetadata(parsed)) {
    return { kind: 'invalid', identity, raw };
  }
  return { kind: 'record', identity, raw, metadata: parsed };
}

function readOpenedLockSnapshot(
  lockPath: string,
  fd: number,
  beforeIdentity: LockFileIdentity,
): LockSnapshot {
  const opened = fstatSync(fd, { bigint: true });
  const openedIdentity = identityOf(opened);
  if (!opened.isFile() || opened.nlink !== 1n || !sameIdentity(beforeIdentity, openedIdentity)) {
    return { kind: 'churn' };
  }

  const bytes = readBoundedFd(fd);
  if (bytes === undefined) {
    return { kind: 'unreadable', identity: openedIdentity };
  }

  const afterRead = identityOf(fstatSync(fd, { bigint: true }));
  if (!sameIdentity(openedIdentity, afterRead) || !pathHasIdentity(lockPath, afterRead)) {
    return { kind: 'churn' };
  }
  return parseLockSnapshot(bytes, afterRead);
}

function publicationTempPath(lockPath: string, ownerToken: string): string {
  const digest = createHash('sha256')
    .update(`${basename(lockPath)}\0${ownerToken}`)
    .digest('hex')
    .slice(0, 32);
  return join(dirname(lockPath), `.opensip-lock-${digest}.publish`);
}

function unlinkExactPath(path: string, expected: LockFileIdentity): boolean {
  try {
    if (!sameIdentity(identityOf(lstatSync(path, { bigint: true })), expected)) return false;
    unlinkSync(path);
    return true;
  } catch {
    // @swallow-ok Exact-path cleanup is best effort and never unlinks on uncertainty.
    return false;
  }
}

/**
 * Complete the one safe interrupted publication state: target and its
 * deterministic private publication temp are hard links to one fully written
 * regular file. A contender may remove only that exact second link.
 */
type PublicationSettlement = 'settled' | 'churn' | 'unsafe';

type LinkedPublicationInspection =
  | {
      readonly kind: 'linked';
      readonly ownerToken: string;
      readonly identity: LockFileIdentity;
    }
  | { readonly kind: Exclude<PublicationSettlement, 'settled'> };

function inspectLinkedPublication(
  lockPath: string,
  fd: number,
  beforeIdentity: LockFileIdentity,
): LinkedPublicationInspection {
  const opened = fstatSync(fd, { bigint: true });
  const openedIdentity = identityOf(opened);
  if (!opened.isFile() || opened.nlink !== 2n || !sameIdentity(beforeIdentity, openedIdentity)) {
    return { kind: 'churn' };
  }
  const bytes = readBoundedFd(fd);
  if (bytes === undefined) return { kind: 'unsafe' };
  const parsed = parseLockSnapshot(bytes, openedIdentity);
  if (parsed.kind !== 'record') return { kind: 'unsafe' };
  const afterRead = identityOf(fstatSync(fd, { bigint: true }));
  if (!sameIdentity(openedIdentity, afterRead) || !pathHasIdentity(lockPath, afterRead)) {
    return { kind: 'churn' };
  }
  return {
    kind: 'linked',
    ownerToken: parsed.metadata.ownerToken,
    identity: afterRead,
  };
}

function classifySinglePublishedLink(
  lockPath: string,
  publishedIdentity: LockFileIdentity,
): PublicationSettlement {
  try {
    const current = lstatSync(lockPath, { bigint: true });
    return current.isFile() &&
      current.nlink === 1n &&
      sameInode(identityOf(current), publishedIdentity)
      ? 'settled'
      : 'unsafe';
  } catch (error) {
    return errnoCode(error) === 'ENOENT' ? 'churn' : 'unsafe';
  }
}

function settlePublicationTempLink(
  lockPath: string,
  ownerToken: string,
  publishedIdentity: LockFileIdentity,
): PublicationSettlement {
  const tempPath = publicationTempPath(lockPath, ownerToken);
  let tempIdentity: LockFileIdentity;
  try {
    const temp = lstatSync(tempPath, { bigint: true });
    tempIdentity = identityOf(temp);
    if (!temp.isFile() || !sameIdentity(publishedIdentity, tempIdentity)) return 'unsafe';
  } catch (error) {
    return errnoCode(error) === 'ENOENT'
      ? classifySinglePublishedLink(lockPath, publishedIdentity)
      : 'unsafe';
  }
  if (!unlinkExactPath(tempPath, tempIdentity)) return 'churn';
  return classifySinglePublishedLink(lockPath, publishedIdentity) === 'settled'
    ? 'settled'
    : 'churn';
}

function settleLinkedPublication(lockPath: string, before: BigIntStats): PublicationSettlement {
  const beforeIdentity = identityOf(before);
  let fd: number | undefined;
  try {
    fd = openSync(lockPath, fsConstants.O_RDONLY | NO_FOLLOW);
    const inspection = inspectLinkedPublication(lockPath, fd, beforeIdentity);
    return inspection.kind === 'linked'
      ? settlePublicationTempLink(lockPath, inspection.ownerToken, inspection.identity)
      : inspection.kind;
  } catch (error) {
    return errnoCode(error) === 'ENOENT' ? 'churn' : 'unsafe';
  } finally {
    if (fd !== undefined) closeQuietly(fd);
  }
}

/**
 * Read a bounded regular lock record through a descriptor anchored to the
 * lstat-observed inode. Symlinks, hard links, and non-files fail closed.
 */
function readLockSnapshot(lockPath: string): LockSnapshot {
  let before: BigIntStats;
  try {
    before = lstatSync(lockPath, { bigint: true });
  } catch (error) {
    return errnoCode(error) === 'ENOENT'
      ? { kind: 'missing' }
      : { kind: 'unsafe', reason: errnoCode(error) ?? 'lstat' };
  }

  if (!before.isFile()) {
    return { kind: 'unsafe', reason: 'not-owned-regular-file' };
  }
  if (before.nlink === 2n) {
    const settled = settleLinkedPublication(lockPath, before);
    if (settled === 'settled') return readLockSnapshot(lockPath);
    return settled === 'churn'
      ? { kind: 'churn' }
      : { kind: 'unsafe', reason: 'unproven-linked-publication' };
  }
  if (before.nlink !== 1n) {
    return { kind: 'unsafe', reason: 'not-owned-regular-file' };
  }

  const beforeIdentity = identityOf(before);
  if (before.size > BigInt(MAX_LOCKFILE_BYTES)) {
    return { kind: 'unreadable', identity: beforeIdentity };
  }

  let fd: number | undefined;
  try {
    fd = openSync(lockPath, fsConstants.O_RDONLY | NO_FOLLOW);
    return readOpenedLockSnapshot(lockPath, fd, beforeIdentity);
  } catch (error) {
    if (errnoCode(error) === 'ENOENT') return { kind: 'churn' };
    return { kind: 'unsafe', reason: errnoCode(error) ?? 'read' };
  } finally {
    if (fd !== undefined) closeQuietly(fd);
  }
}

function sameSnapshot(a: LockSnapshotBase, b: LockSnapshotBase): boolean {
  return (
    sameIdentity(a.identity, b.identity) &&
    (a.raw === undefined || b.raw === undefined || a.raw === b.raw)
  );
}

/**
 * Best portable pathname guard before unlink. Node has no atomic
 * unlink-if-inode-matches primitive, so this narrows (but cannot eliminate) the
 * final lstat-to-unlink race on a hostile shared filesystem.
 */
function unlinkSnapshotIfCurrent(lockPath: string, expected: LockSnapshotBase): boolean {
  const current = readLockSnapshot(lockPath);
  if (
    (current.kind !== 'record' && current.kind !== 'unreadable' && current.kind !== 'invalid') ||
    !sameSnapshot(expected, current)
  ) {
    return false;
  }

  try {
    const immediate = identityOf(lstatSync(lockPath, { bigint: true }));
    if (!sameIdentity(current.identity, immediate)) return false;
    unlinkSync(lockPath);
    return true;
  } catch {
    // @swallow-ok Snapshot churn or unlink failure means the contender must retry.
    return false;
  }
}

function serializeLockMetadata(metadata: FileLockMetadata): Buffer {
  const bytes = Buffer.from(JSON.stringify(metadata), 'utf8');
  if (bytes.length > MAX_LOCKFILE_BYTES) {
    throw new SystemError(`Lock metadata exceeds the ${MAX_LOCKFILE_BYTES}-byte limit`, {
      code: 'SYSTEM.LOCK.METADATA_TOO_LARGE',
    });
  }
  return bytes;
}

function hardenLockMode(fd: number): void {
  if (process.platform === 'win32') return;
  fchmodSync(fd, LOCKFILE_MODE);
  if (Number(fstatSync(fd, { bigint: true }).mode & 0o777n) !== LOCKFILE_MODE) {
    throw new SystemError('Lockfile mode could not be restricted to 0600', {
      code: 'SYSTEM.LOCK.UNSAFE_MODE',
    });
  }
}

function writeAllAtStart(fd: number, bytes: Buffer): void {
  let offset = 0;
  while (offset < bytes.length) {
    const count = writeSync(fd, bytes, offset, bytes.length - offset, offset);
    if (count === 0) {
      throw new SystemError('Lock metadata write made no progress', {
        code: 'SYSTEM.LOCK.WRITE_STALLED',
      });
    }
    offset += count;
  }
  ftruncateSync(fd, bytes.length);
}

/**
 * Create and durably populate a private one-link publication temporary.
 * @throws {SystemError} When the temporary cannot be proven private and complete.
 */
function createCompletePrivateTemp(path: string, bytes: Buffer): LockFileIdentity {
  let fd: number | undefined;
  let identity: LockFileIdentity | undefined;
  try {
    fd = openSync(path, 'wx', LOCKFILE_MODE);
    identity = identityOf(fstatSync(fd, { bigint: true }));
    hardenLockMode(fd);
    writeAllAtStart(fd, bytes);
    fsyncSync(fd);
    identity = identityOf(fstatSync(fd, { bigint: true }));
    if (identity.nlink !== 1n || identity.size !== BigInt(bytes.length)) {
      throw new SystemError('Lock temporary record could not be proven complete', {
        code: 'SYSTEM.LOCK.UNSAFE_TEMP',
      });
    }
    closeSync(fd);
    fd = undefined;
    return identity;
  } catch (error) {
    if (fd !== undefined) {
      try {
        identity = identityOf(fstatSync(fd, { bigint: true }));
      } catch {
        // @swallow-ok the original creation/write error remains primary
      }
      closeQuietly(fd);
    }
    if (identity !== undefined) unlinkExactPath(path, identity);
    throw error;
  }
}

/**
 * Publish a complete heartbeat replacement only while the exact owner snapshot
 * remains current. Node has no portable rename-if-inode-matches primitive, so
 * the final recheck-to-rename syscall window remains within the documented
 * cooperative same-UID boundary.
 */
function writeLockMetadataIfOwner(
  lockPath: string,
  metadata: FileLockMetadata,
  ownerToken: string,
): boolean {
  const bytes = serializeLockMetadata(metadata);
  const observed = readLockSnapshot(lockPath);
  if (observed.kind !== 'record' || observed.metadata.ownerToken !== ownerToken) {
    return false;
  }
  const tempPath = join(dirname(lockPath), `.opensip-lock-${generateUUID()}.heartbeat`);
  let tempIdentity: LockFileIdentity | undefined;
  try {
    tempIdentity = createCompletePrivateTemp(tempPath, bytes);
    const current = readLockSnapshot(lockPath);
    if (
      current.kind !== 'record' ||
      current.metadata.ownerToken !== ownerToken ||
      !sameSnapshot(observed, current)
    ) {
      return false;
    }
    const immediate = readLockSnapshot(lockPath);
    if (
      immediate.kind !== 'record' ||
      immediate.metadata.ownerToken !== ownerToken ||
      !sameSnapshot(current, immediate)
    ) {
      return false;
    }
    renameSync(tempPath, lockPath);
    tempIdentity = undefined;
    const published = readLockSnapshot(lockPath);
    return (
      published.kind === 'record' &&
      published.metadata.ownerToken === ownerToken &&
      published.raw === bytes.toString('utf8')
    );
  } catch {
    // @swallow-ok Failed heartbeat publication leaves liveness probes authoritative.
    return false;
  } finally {
    if (tempIdentity !== undefined) unlinkExactPath(tempPath, tempIdentity);
  }
}

function currentHostIdentity(): ReturnType<typeof deriveHostIdentity> {
  return deriveHostIdentity(hostname(), defaultHostInstanceIdentity());
}

function currentProcessIncarnation(): string | undefined {
  const inspection = inspectProcessIncarnation(process.pid);
  return inspection.status === 'present' ? inspection.identity : undefined;
}

/**
 * One inspector per acquisition attempt. Positive observations must survive the
 * full wait budget plus scheduler overshoot on `Atomics.wait` / `setTimeout` —
 * a fixed short global TTL re-probes live owners when the final timeout poll
 * lands after the cache expires even though `waitMs` itself is shorter.
 */
function createAcquisitionProcessInspector(waitMs: number): SafetyBiasedProcessInspector {
  return createSafetyBiasedProcessInspector({
    inspect: inspectProcessIncarnation,
    monotonicNow,
    ttlMs: Math.max(PROCESS_PROBE_CACHE_MS, waitMs + POLL_MS * 8 + 1_000),
    maxEntries: PROCESS_PROBE_CACHE_ENTRIES,
  });
}

type OwnerRecoveryClassification = 'live' | 'proven-dead' | 'observe-unchanged';
const OBSERVE_UNCHANGED: OwnerRecoveryClassification = 'observe-unchanged';

function classifyOwnerForRecovery(
  metadata: FileLockMetadata,
  processInspector: SafetyBiasedProcessInspector,
  freshProcessProbe = false,
): OwnerRecoveryClassification {
  const localHost = currentHostIdentity();
  const sameProvenHost =
    metadata.hostIdentityProven === true &&
    localHost.proven &&
    metadata.hostInstanceIdentity === localHost.id;
  const provenDifferentHost =
    metadata.hostIdentityProven === true &&
    localHost.proven &&
    metadata.hostInstanceIdentity !== localHost.id;
  if (provenDifferentHost) return OBSERVE_UNCHANGED;

  const canUseLocalPidAsLiveVeto = sameProvenHost || metadata.hostname === hostname();
  if (!canUseLocalPidAsLiveVeto) return OBSERVE_UNCHANGED;

  const current = freshProcessProbe
    ? processInspector.inspectFresh(metadata.pid)
    : processInspector.inspect(metadata.pid);
  if (current.status === 'unknown') return 'live';
  if (current.status === 'present') {
    // A legacy/malformed-old-version record has no way to prove that a reused
    // PID is still the original owner. Its changing heartbeat snapshot is the
    // only ownership signal, so an exact unchanged stale horizon is required.
    if (metadata.processIncarnation === undefined) return OBSERVE_UNCHANGED;
    return current.identity === metadata.processIncarnation ? 'live' : 'proven-dead';
  }
  // A process-incarnation marker plus a proven current boot makes ESRCH an
  // immediate owner-death proof. Legacy/unproven records still require the
  // bounded unchanged-observation contract before removal.
  return sameProvenHost && metadata.processIncarnation !== undefined
    ? 'proven-dead'
    : OBSERVE_UNCHANGED;
}

interface LockStaleObservation {
  readonly snapshot: LockSnapshotBase;
  readonly firstObservedAt: number;
  readonly horizonMs: number;
}

interface LockStaleTracker {
  observation?: LockStaleObservation;
}

function resetStaleObservation(tracker: LockStaleTracker): void {
  tracker.observation = undefined;
}

function unchangedForRecoveryHorizon(
  tracker: LockStaleTracker,
  snapshot: LockSnapshotBase,
  horizonMs: number,
): boolean {
  const now = monotonicNow();
  const previous = tracker.observation;
  const sameObservation =
    previous?.horizonMs === horizonMs && sameSnapshot(previous.snapshot, snapshot);
  if (!sameObservation) {
    tracker.observation = {
      snapshot,
      firstObservedAt: now,
      horizonMs,
    };
    return false;
  }
  return now - previous.firstObservedAt >= horizonMs;
}

function removeLockIfOwned(lockPath: string, ownerToken: string): void {
  const existing = readLockSnapshot(lockPath);
  if (existing.kind === 'record' && existing.metadata.ownerToken === ownerToken) {
    unlinkSnapshotIfCurrent(lockPath, existing);
  }
}

/**
 * Attempt one atomic hard-link publication of a complete lock record.
 * @throws {SystemError} When publication identity or durability cannot be proven.
 */
function tryAcquireLock(lockPath: string, metadata: FileLockMetadata): boolean {
  const bytes = serializeLockMetadata(metadata);
  const tempPath = publicationTempPath(lockPath, metadata.ownerToken);
  let tempIdentity: LockFileIdentity | undefined;
  let published = false;
  try {
    tempIdentity = createCompletePrivateTemp(tempPath, bytes);
    try {
      linkSync(tempPath, lockPath);
      published = true;
    } catch (error) {
      if (errnoCode(error) === 'EEXIST') return false;
      throw error;
    }
    const target = lstatSync(lockPath, { bigint: true });
    const targetIdentity = identityOf(target);
    const linkedTempIdentity = identityOf(lstatSync(tempPath, { bigint: true }));
    if (
      !target.isFile() ||
      target.nlink !== 2n ||
      !sameIdentity(targetIdentity, linkedTempIdentity)
    ) {
      throw new SystemError('Published lock record does not match its complete temporary record', {
        code: 'SYSTEM.LOCK.UNSAFE_PUBLICATION',
      });
    }
    tempIdentity = linkedTempIdentity;
    if (!unlinkExactPath(tempPath, targetIdentity)) {
      throw new SystemError('Published lock temporary link could not be retired', {
        code: 'SYSTEM.LOCK.UNSAFE_PUBLICATION',
      });
    }
    tempIdentity = undefined;
    const settled = readLockSnapshot(lockPath);
    if (
      settled.kind !== 'record' ||
      settled.metadata.ownerToken !== metadata.ownerToken ||
      settled.raw !== bytes.toString('utf8')
    ) {
      throw new SystemError('Published lock record could not be revalidated', {
        code: 'SYSTEM.LOCK.UNSAFE_PUBLICATION',
      });
    }
    return true;
  } catch (error) {
    if (published) removeLockIfOwned(lockPath, metadata.ownerToken);
    throw error;
  } finally {
    if (tempIdentity !== undefined) unlinkExactPath(tempPath, tempIdentity);
  }
}

interface StaleLockRecoveryContext {
  readonly lockPath: string;
  readonly snapshot: LockRecordSnapshot;
  readonly policy: StateLockPolicy;
  readonly tracker: LockStaleTracker;
  readonly processInspector: SafetyBiasedProcessInspector;
  readonly onEvent?: (event: FileLockEvent) => void;
  readonly resource: FileLockResource;
  readonly operation?: string;
}

function recoverStaleLock({
  lockPath,
  snapshot,
  policy,
  tracker,
  processInspector,
  onEvent,
  resource,
  operation,
}: StaleLockRecoveryContext): boolean {
  const classification = classifyOwnerForRecovery(snapshot.metadata, processInspector);
  if (classification === 'live') {
    resetStaleObservation(tracker);
    return false;
  }
  const recoveryHorizonMs = Math.max(snapshot.metadata.staleMs ?? 0, policy.staleMs);
  if (
    classification === 'observe-unchanged' &&
    !unchangedForRecoveryHorizon(tracker, snapshot, recoveryHorizonMs)
  ) {
    return false;
  }

  try {
    const current = readLockSnapshot(lockPath);
    if (
      current.kind !== 'record' ||
      !sameSnapshot(snapshot, current) ||
      current.metadata.ownerToken !== snapshot.metadata.ownerToken
    ) {
      resetStaleObservation(tracker);
      return false;
    }

    // Cached process observations may delay recovery, but may never authorize
    // deletion. Re-probe after the exact record re-read and immediately before
    // the final exact-snapshot unlink guard.
    const freshClassification = classifyOwnerForRecovery(current.metadata, processInspector, true);
    if (freshClassification === 'live') {
      resetStaleObservation(tracker);
      return false;
    }
    if (
      freshClassification === 'observe-unchanged' &&
      !unchangedForRecoveryHorizon(tracker, current, recoveryHorizonMs)
    ) {
      return false;
    }
    if (!unlinkSnapshotIfCurrent(lockPath, current)) {
      return false;
    }
    resetStaleObservation(tracker);
    emit(onEvent, {
      kind: 'stale.recovered',
      lockPath,
      resource,
      operation,
      ownerPid: current.metadata.pid,
      ownerHostname: current.metadata.hostname,
    });
    return true;
  } catch {
    // @swallow-ok concurrent stale recovery may race on unlink; retry on next poll
    return false;
  }
}

function emit(onEvent: WithFileLockOptions['onEvent'], event: FileLockEvent): void {
  try {
    onEvent?.(event);
  } catch {
    // @swallow-ok diagnostics must not own or strand the lock lifecycle
  }
}

type LockContentionOutcome = 'acquired' | 'retry' | 'timeout' | 'malformed';
type NonRecordLockSnapshot = Exclude<LockSnapshot, LockRecordSnapshot>;

function deadlineOutcome(deadline: number): Extract<LockContentionOutcome, 'retry' | 'timeout'> {
  return monotonicNow() >= deadline ? 'timeout' : 'retry';
}

function recoverCorruptSnapshot(
  lockPath: string,
  snapshot: Extract<NonRecordLockSnapshot, { readonly kind: 'unreadable' | 'invalid' }>,
  options: WithFileLockOptions,
  tracker: LockStaleTracker,
  deadline: number,
): LockContentionOutcome {
  if (!unchangedForRecoveryHorizon(tracker, snapshot, options.policy.staleMs)) {
    return deadlineOutcome(deadline);
  }
  const current = readLockSnapshot(lockPath);
  if (
    (current.kind !== 'unreadable' && current.kind !== 'invalid') ||
    !sameSnapshot(snapshot, current)
  ) {
    resetStaleObservation(tracker);
    return deadlineOutcome(deadline);
  }
  if (!unlinkSnapshotIfCurrent(lockPath, current)) return 'retry';
  resetStaleObservation(tracker);
  emit(options.onEvent, {
    kind: 'stale.recovered',
    lockPath,
    resource: options.resource,
    operation: options.operation,
  });
  return 'retry';
}

function evaluateNonRecordContention(
  lockPath: string,
  metadata: FileLockMetadata,
  snapshot: NonRecordLockSnapshot,
  options: WithFileLockOptions,
  tracker: LockStaleTracker,
  deadline: number,
): LockContentionOutcome {
  if (snapshot.kind === 'missing') {
    resetStaleObservation(tracker);
    if (tryAcquireLock(lockPath, metadata)) return 'acquired';
    return deadlineOutcome(deadline);
  }
  if (snapshot.kind === 'churn') {
    resetStaleObservation(tracker);
    return deadlineOutcome(deadline);
  }
  if (snapshot.kind === 'unsafe') {
    resetStaleObservation(tracker);
    return 'malformed';
  }

  // Invalid and unreadable records carry no trustworthy owner identity. They
  // become recoverable only after the exact inode/content remains unchanged
  // for one complete local-monotonic stale horizon. Wall time is irrelevant.
  return recoverCorruptSnapshot(lockPath, snapshot, options, tracker, deadline);
}

function evaluateLockContention(
  lockPath: string,
  metadata: FileLockMetadata,
  options: WithFileLockOptions,
  tracker: LockStaleTracker,
  processInspector: SafetyBiasedProcessInspector,
  deadline: number,
  acquisitionStartedAt: number,
): LockContentionOutcome {
  if (tryAcquireLock(lockPath, metadata)) return 'acquired';

  const existing = readLockSnapshot(lockPath);
  // Lockfile exists but may be unsafe, unreadable, or structurally invalid.
  // Unsafe path types fail closed; corrupt regular-file snapshots require an
  // exact unchanged monotonic stale horizon before guarded removal.
  if (existing.kind !== 'record') {
    return evaluateNonRecordContention(lockPath, metadata, existing, options, tracker, deadline);
  }

  if (
    recoverStaleLock({
      lockPath,
      snapshot: existing,
      policy: options.policy,
      tracker,
      processInspector,
      onEvent: options.onEvent,
      resource: options.resource,
      operation: options.operation,
    })
  ) {
    return 'retry';
  }

  if (monotonicNow() >= deadline) return 'timeout';

  emit(options.onEvent, {
    kind: 'acquire.wait',
    lockPath,
    resource: options.resource,
    operation: options.operation,
    waitMs: monotonicNow() - acquisitionStartedAt,
    ownerPid: existing.metadata.pid,
    ownerHostname: existing.metadata.hostname,
  });
  return 'retry';
}

function throwLockTimeout(lockPath: string, options: WithFileLockOptions): never {
  const existing = readLockSnapshot(lockPath);
  const owner = existing.kind === 'record' ? existing.metadata : undefined;
  emit(options.onEvent, {
    kind: 'acquire.timeout',
    lockPath,
    resource: options.resource,
    operation: options.operation,
    waitMs: options.policy.waitMs,
    ownerPid: owner?.pid,
    ownerHostname: owner?.hostname,
  });
  throw new TimeoutError(
    `Timed out waiting for ${options.resource} write lock (${options.operation ?? 'write'}) after ${options.policy.waitMs}ms`,
    { code: 'TIMEOUT.STATE_LOCK' },
  );
}

function startLockHeartbeat(
  lockPath: string,
  metadata: FileLockMetadata,
  heartbeatMs: number,
): ReturnType<typeof setInterval> {
  const timer = setInterval(() => {
    let stillOwned = false;
    try {
      metadata.lastHeartbeatAt = Date.now();
      stillOwned = writeLockMetadataIfOwner(
        lockPath,
        { ...metadata, lastHeartbeatAt: metadata.lastHeartbeatAt },
        metadata.ownerToken,
      );
    } catch {
      // @swallow-ok heartbeat update is best-effort; stale recovery handles abandoned locks
    }
    if (!stillOwned) clearInterval(timer);
  }, heartbeatMs);
  return timer;
}

function normalizePolicyDuration(value: number, name: string): number {
  if (!Number.isFinite(value) || value < 0 || value > MAX_TIMER_MS) {
    throw new SystemError(
      `${name} must be a finite non-negative duration no greater than ${MAX_TIMER_MS}ms`,
      { code: 'SYSTEM.LOCK.INVALID_POLICY' },
    );
  }
  return Math.floor(value);
}

function normalizeLockPolicy(policy: StateLockPolicy): StateLockPolicy {
  // Retain the historical heartbeat/stale relationship for policy
  // compatibility. Recovery itself now requires host/process-incarnation proof
  // and never treats wall-clock heartbeat age as ownership evidence.
  const heartbeatMs = Math.max(1, normalizePolicyDuration(policy.heartbeatMs, 'heartbeatMs'));
  const minStale = heartbeatMs * 3;
  const staleMs = Math.max(minStale, normalizePolicyDuration(policy.staleMs, 'staleMs'));
  if (staleMs > MAX_TIMER_MS) {
    throw new SystemError(
      `staleMs must remain no greater than ${MAX_TIMER_MS}ms after heartbeat safety normalization`,
      { code: 'SYSTEM.LOCK.INVALID_POLICY' },
    );
  }
  const waitMs = normalizePolicyDuration(policy.waitMs, 'waitMs');
  return { waitMs, staleMs, heartbeatMs };
}

/**
 * Acquire an exclusive file lock, run `fn`, and release the lock in `finally`.
 *
 * This is a cooperative file lease, not an OS-level fence. In particular, a
 * synchronous callback blocks its in-process heartbeat. Proven-dead owners can
 * be reclaimed immediately; legacy and foreign records require one exact,
 * unchanged local-monotonic stale horizon before guarded removal.
 *
 * @throws {TimeoutError} when live contention exceeds `policy.waitMs`.
 * @throws {SystemError} when lock metadata is malformed and cannot be recovered.
 */
export function withFileLock<T>(lockPath: string, options: WithFileLockOptions, fn: () => T): T {
  const policy = normalizeLockPolicy(options.policy);
  const normalizedOptions: WithFileLockOptions = { ...options, policy };
  const ownerToken = generateUUID();
  const cwdBasename = options.cwdBasename ?? basename(process.cwd());
  const hostnameValue = hostname();
  const hostIdentity = deriveHostIdentity(hostnameValue, defaultHostInstanceIdentity());
  const metadata: FileLockMetadata = {
    ownerToken,
    pid: process.pid,
    hostname: hostnameValue,
    hostInstanceIdentity: hostIdentity.id,
    hostIdentityProven: hostIdentity.proven,
    processIncarnation: currentProcessIncarnation(),
    runId: options.runId,
    command: options.command,
    cwdBasename,
    acquiredAt: Date.now(),
    lastHeartbeatAt: Date.now(),
    staleMs: policy.staleMs,
  };

  emit(options.onEvent, {
    kind: 'acquire.start',
    lockPath,
    resource: options.resource,
    operation: options.operation,
  });

  const acquisitionStartedAt = monotonicNow();
  const deadline = acquisitionStartedAt + policy.waitMs;
  const tracker: LockStaleTracker = {};
  const processInspector = createAcquisitionProcessInspector(policy.waitMs);
  let acquired = false;

  while (!acquired) {
    const outcome = evaluateLockContention(
      lockPath,
      metadata,
      normalizedOptions,
      tracker,
      processInspector,
      deadline,
      acquisitionStartedAt,
    );
    if (outcome === 'acquired') {
      acquired = true;
      break;
    }
    if (outcome === 'malformed') {
      throw new SystemError(`Malformed lockfile at ${lockPath}`, {
        code: 'SYSTEM.LOCK.MALFORMED',
      });
    }
    if (outcome === 'timeout') break;
    sleepSync(Math.min(POLL_MS, Math.max(0, deadline - monotonicNow())));
  }

  if (!acquired) throwLockTimeout(lockPath, normalizedOptions);

  const heartbeatTimer = startLockHeartbeat(lockPath, metadata, policy.heartbeatMs);
  try {
    heartbeatTimer.unref?.();
  } catch {
    // @swallow-ok unref is optional (not all timers support it)
  }

  try {
    const result = fn();
    emit(options.onEvent, {
      kind: 'acquire.complete',
      lockPath,
      resource: options.resource,
      operation: options.operation,
      waitMs: monotonicNow() - acquisitionStartedAt,
    });
    return result;
  } finally {
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    removeLockIfOwned(lockPath, ownerToken);
  }
}

/**
 * Async variant for artifact writes that may await I/O while holding the lock.
 */
export async function withFileLockAsync<T>(
  lockPath: string,
  options: WithFileLockOptions,
  fn: () => Promise<T>,
): Promise<T> {
  const policy = normalizeLockPolicy(options.policy);
  const normalizedOptions: WithFileLockOptions = { ...options, policy };
  const ownerToken = generateUUID();
  const cwdBasename = options.cwdBasename ?? basename(process.cwd());
  const hostnameValue = hostname();
  const hostIdentity = deriveHostIdentity(hostnameValue, defaultHostInstanceIdentity());
  const metadata: FileLockMetadata = {
    ownerToken,
    pid: process.pid,
    hostname: hostnameValue,
    hostInstanceIdentity: hostIdentity.id,
    hostIdentityProven: hostIdentity.proven,
    processIncarnation: currentProcessIncarnation(),
    runId: options.runId,
    command: options.command,
    cwdBasename,
    acquiredAt: Date.now(),
    lastHeartbeatAt: Date.now(),
    staleMs: policy.staleMs,
  };

  emit(options.onEvent, {
    kind: 'acquire.start',
    lockPath,
    resource: options.resource,
    operation: options.operation,
  });

  const acquisitionStartedAt = monotonicNow();
  const deadline = acquisitionStartedAt + policy.waitMs;
  const tracker: LockStaleTracker = {};
  const processInspector = createAcquisitionProcessInspector(policy.waitMs);
  let acquired = false;

  const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

  while (!acquired) {
    const outcome = evaluateLockContention(
      lockPath,
      metadata,
      normalizedOptions,
      tracker,
      processInspector,
      deadline,
      acquisitionStartedAt,
    );
    if (outcome === 'acquired') {
      acquired = true;
      break;
    }
    if (outcome === 'malformed') {
      throw new SystemError(`Malformed lockfile at ${lockPath}`, {
        code: 'SYSTEM.LOCK.MALFORMED',
      });
    }
    if (outcome === 'timeout') break;
    await sleep(Math.min(POLL_MS, Math.max(0, deadline - monotonicNow())));
  }

  if (!acquired) throwLockTimeout(lockPath, normalizedOptions);

  const heartbeatTimer = startLockHeartbeat(lockPath, metadata, policy.heartbeatMs);
  try {
    heartbeatTimer.unref?.();
  } catch {
    // @swallow-ok unref is optional
  }

  try {
    const result = await fn();
    emit(options.onEvent, {
      kind: 'acquire.complete',
      lockPath,
      resource: options.resource,
      operation: options.operation,
      waitMs: monotonicNow() - acquisitionStartedAt,
    });
    return result;
  } finally {
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    removeLockIfOwned(lockPath, ownerToken);
  }
}
