/**
 * @fileoverview Generic file-lock primitive for datastore and artifact writes.
 *
 * Uses atomic lockfile creation (`open(..., 'wx')`) with JSON metadata, heartbeat
 * updates, stale-lock recovery, and injected event callbacks. No CLI or diagnostics
 * imports — callers bridge events at the composition root.
 */

import { closeSync, openSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { basename } from 'node:path';

import { SystemError, TimeoutError } from './errors.js';
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
  runId?: string;
  command?: string;
  cwdBasename: string;
  acquiredAt: number;
  lastHeartbeatAt: number;
}

/** Lock lifecycle event kinds emitted through {@link WithFileLockOptions.onEvent}. */
export type FileLockEventKind =
  | 'acquire.start'
  | 'acquire.wait'
  | 'acquire.complete'
  | 'acquire.timeout'
  | 'stale.recovered';

/** Lock lifecycle event emitted through the injected callback. */
export interface FileLockEvent {
  readonly kind: FileLockEventKind;
  readonly lockPath: string;
  readonly resource: 'datastore' | 'artifact';
  readonly operation?: string;
  readonly waitMs?: number;
  readonly ownerPid?: number;
  readonly ownerHostname?: string;
}

/** Options for {@link withFileLock} / {@link withFileLockAsync}. */
export interface WithFileLockOptions {
  readonly policy: StateLockPolicy;
  readonly resource: 'datastore' | 'artifact';
  readonly operation?: string;
  readonly runId?: string;
  readonly command?: string;
  readonly cwdBasename?: string;
  readonly onEvent?: (event: FileLockEvent) => void;
}

const POLL_MS = 50;

function sleepSync(ms: number): void {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    /* spin */
  }
}

function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    // @swallow-ok process.kill(0) throws when pid is not running; treat as stale
    return false;
  }
}

const MAX_LOCKFILE_BYTES = 4096;

function readLockMetadata(lockPath: string): FileLockMetadata | undefined {
  try {
    if (statSync(lockPath).size > MAX_LOCKFILE_BYTES) return undefined;
    const raw = readFileSync(lockPath, 'utf8');
    const parsed = JSON.parse(raw) as FileLockMetadata;
    if (
      typeof parsed.ownerToken !== 'string' ||
      typeof parsed.pid !== 'number' ||
      typeof parsed.hostname !== 'string' ||
      typeof parsed.cwdBasename !== 'string' ||
      typeof parsed.acquiredAt !== 'number' ||
      typeof parsed.lastHeartbeatAt !== 'number'
    ) {
      return undefined;
    }
    return parsed;
  } catch {
    // @swallow-ok missing or corrupt lockfile reads as no lock held
    return undefined;
  }
}

function writeLockMetadata(lockPath: string, metadata: FileLockMetadata): void {
  writeFileSync(lockPath, JSON.stringify(metadata), 'utf8');
}

function isStale(metadata: FileLockMetadata, staleMs: number): boolean {
  if (!isProcessAlive(metadata.pid)) return true;
  return Date.now() - metadata.lastHeartbeatAt > staleMs;
}

function removeLockIfOwned(lockPath: string, ownerToken: string): void {
  const existing = readLockMetadata(lockPath);
  if (existing?.ownerToken === ownerToken) {
    try {
      unlinkSync(lockPath);
    } catch {
      // @swallow-ok best-effort lock release during teardown
    }
  }
}

function tryAcquireLock(lockPath: string, metadata: FileLockMetadata): boolean {
  try {
    const fd = openSync(lockPath, 'wx');
    writeFileSync(fd, JSON.stringify(metadata), 'utf8');
    closeSync(fd);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false;
    throw error;
  }
}

function recoverStaleLock(
  lockPath: string,
  metadata: FileLockMetadata | undefined,
  staleMs: number,
  onEvent?: (event: FileLockEvent) => void,
  resource: 'datastore' | 'artifact' = 'datastore',
  operation?: string,
): boolean {
  if (!metadata || !isStale(metadata, staleMs)) return false;
  try {
    unlinkSync(lockPath);
    onEvent?.({
      kind: 'stale.recovered',
      lockPath,
      resource,
      operation,
      ownerPid: metadata.pid,
      ownerHostname: metadata.hostname,
    });
    return true;
  } catch {
    // @swallow-ok concurrent stale recovery may race on unlink; retry on next poll
    return false;
  }
}

function emit(onEvent: WithFileLockOptions['onEvent'], event: FileLockEvent): void {
  onEvent?.(event);
}

type LockContentionOutcome = 'acquired' | 'retry' | 'timeout' | 'malformed';

function evaluateLockContention(
  lockPath: string,
  metadata: FileLockMetadata,
  options: WithFileLockOptions,
  deadline: number,
): LockContentionOutcome {
  if (tryAcquireLock(lockPath, metadata)) return 'acquired';

  const existing = readLockMetadata(lockPath);
  if (!existing) return Date.now() >= deadline ? 'timeout' : 'retry';

  if (
    recoverStaleLock(
      lockPath,
      existing,
      options.policy.staleMs,
      options.onEvent,
      options.resource,
      options.operation,
    )
  ) {
    return 'retry';
  }

  if (!existing.ownerToken) return 'malformed';
  if (Date.now() >= deadline) return 'timeout';

  emit(options.onEvent, {
    kind: 'acquire.wait',
    lockPath,
    resource: options.resource,
    operation: options.operation,
    waitMs: Date.now() - metadata.acquiredAt,
    ownerPid: existing.pid,
    ownerHostname: existing.hostname,
  });
  return 'retry';
}

function throwLockTimeout(lockPath: string, options: WithFileLockOptions): never {
  const existing = readLockMetadata(lockPath);
  emit(options.onEvent, {
    kind: 'acquire.timeout',
    lockPath,
    resource: options.resource,
    operation: options.operation,
    waitMs: options.policy.waitMs,
    ownerPid: existing?.pid,
    ownerHostname: existing?.hostname,
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
  return setInterval(() => {
    metadata.lastHeartbeatAt = Date.now();
    try {
      writeLockMetadata(lockPath, { ...metadata, lastHeartbeatAt: Date.now() });
    } catch {
      // @swallow-ok heartbeat update is best-effort; stale recovery handles abandoned locks
    }
  }, heartbeatMs);
}

/**
 * Acquire an exclusive file lock, run `fn`, and release the lock in `finally`.
 *
 * @throws {TimeoutError} when live contention exceeds `policy.waitMs`.
 * @throws {SystemError} when lock metadata is malformed and cannot be recovered.
 */
export function withFileLock<T>(lockPath: string, options: WithFileLockOptions, fn: () => T): T {
  const ownerToken = generateUUID();
  const cwdBasename = options.cwdBasename ?? basename(process.cwd());
  const metadata: FileLockMetadata = {
    ownerToken,
    pid: process.pid,
    hostname: hostname(),
    runId: options.runId,
    command: options.command,
    cwdBasename,
    acquiredAt: Date.now(),
    lastHeartbeatAt: Date.now(),
  };

  emit(options.onEvent, {
    kind: 'acquire.start',
    lockPath,
    resource: options.resource,
    operation: options.operation,
  });

  const deadline = Date.now() + options.policy.waitMs;
  let acquired = false;

  while (!acquired) {
    const outcome = evaluateLockContention(lockPath, metadata, options, deadline);
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
    sleepSync(Math.min(POLL_MS, Math.max(0, deadline - Date.now())));
  }

  if (!acquired) throwLockTimeout(lockPath, options);

  const heartbeatTimer = startLockHeartbeat(lockPath, metadata, options.policy.heartbeatMs);

  try {
    const result = fn();
    emit(options.onEvent, {
      kind: 'acquire.complete',
      lockPath,
      resource: options.resource,
      operation: options.operation,
      waitMs: Date.now() - metadata.acquiredAt,
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
  const ownerToken = generateUUID();
  const cwdBasename = options.cwdBasename ?? basename(process.cwd());
  const metadata: FileLockMetadata = {
    ownerToken,
    pid: process.pid,
    hostname: hostname(),
    runId: options.runId,
    command: options.command,
    cwdBasename,
    acquiredAt: Date.now(),
    lastHeartbeatAt: Date.now(),
  };

  emit(options.onEvent, {
    kind: 'acquire.start',
    lockPath,
    resource: options.resource,
    operation: options.operation,
  });

  const deadline = Date.now() + options.policy.waitMs;
  let acquired = false;

  const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

  while (!acquired) {
    const outcome = evaluateLockContention(lockPath, metadata, options, deadline);
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
    await sleep(Math.min(POLL_MS, Math.max(0, deadline - Date.now())));
  }

  if (!acquired) throwLockTimeout(lockPath, options);

  const heartbeatTimer = startLockHeartbeat(lockPath, metadata, options.policy.heartbeatMs);

  try {
    const result = await fn();
    emit(options.onEvent, {
      kind: 'acquire.complete',
      lockPath,
      resource: options.resource,
      operation: options.operation,
      waitMs: Date.now() - metadata.acquiredAt,
    });
    return result;
  } finally {
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    removeLockIfOwned(lockPath, ownerToken);
  }
}
