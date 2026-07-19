/**
 * @fileoverview Stable filesystem identity, sidecar, and bounded failure
 * evidence used by the read-only SQLite inspector.
 */

import { createHash } from 'node:crypto';
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  type BigIntStats,
} from 'node:fs';

import type {
  SqliteIntegrityResult,
  SqliteSidecarPresence,
  SqliteSidecarState,
} from './sqlite-integrity-contract.js';

const HASH_CHUNK_BYTES = 64 * 1024;
const INVALID_FILE_TYPE_KIND = 'invalid-file-type' as const;

/** @internal Stable identity fields checked across every file transition. */
export interface SqliteFileIdentity {
  readonly dev: bigint;
  readonly ino: bigint;
  readonly mode: bigint;
  readonly nlink: bigint;
  readonly size: bigint;
  readonly mtimeNs: bigint;
  readonly ctimeNs: bigint;
}

/** @internal Hash evidence bound to the file identity that produced it. */
export interface HashedSqliteFile {
  readonly identity: SqliteFileIdentity;
  readonly sizeBytes: number;
  readonly sha256: string;
}

/** @internal Bounded classification used instead of propagating native details. */
export type SqliteInspectionErrorKind =
  | 'absent'
  | 'not-sqlite'
  | 'corrupt'
  | 'invalid-file-type'
  | 'changed'
  | 'close-failed'
  | 'sidecar-unknown'
  | 'unreadable';

/** @internal Error carrying only a bounded SQLite inspection classification. */
export class SqliteInspectionError extends Error {
  constructor(readonly kind: SqliteInspectionErrorKind) {
    super(kind);
    this.name = 'SqliteInspectionError';
  }
}

/**
 * Hash a regular, singly linked file while proving that its descriptor identity
 * remains stable.
 *
 * @throws {SqliteInspectionError} When the path is absent, unsafe, unreadable, or changes.
 */
function hashStableRegularFile(path: string): HashedSqliteFile {
  const initialIdentity = readInitialIdentity(path);
  let descriptor: number | undefined;
  try {
    descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    return hashOpenedDescriptor(descriptor, initialIdentity);
  } catch (error) {
    if (error instanceof SqliteInspectionError) throw error;
    if (hasCode(error, 'ENOENT')) throw new SqliteInspectionError('absent');
    if (hasCode(error, 'ELOOP')) throw new SqliteInspectionError(INVALID_FILE_TYPE_KIND);
    throw new SqliteInspectionError('unreadable');
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

/** @throws {SqliteInspectionError} When the path is absent, unreadable, or not a safe file. */
function readInitialIdentity(path: string): SqliteFileIdentity {
  let initial: BigIntStats;
  try {
    initial = lstatSync(path, { bigint: true });
  } catch (error) {
    if (hasCode(error, 'ENOENT')) throw new SqliteInspectionError('absent');
    throw new SqliteInspectionError('unreadable');
  }
  if (!initial.isFile() || initial.isSymbolicLink() || initial.nlink !== 1n) {
    throw new SqliteInspectionError(INVALID_FILE_TYPE_KIND);
  }
  return fileIdentity(initial);
}

/**
 * @throws {SqliteInspectionError} When the descriptor is unsafe, changes identity, or is unreadable.
 */
function hashOpenedDescriptor(descriptor: number, expected: SqliteFileIdentity): HashedSqliteFile {
  const opened = fstatSync(descriptor, { bigint: true });
  if (!opened.isFile() || opened.nlink !== 1n) {
    throw new SqliteInspectionError(INVALID_FILE_TYPE_KIND);
  }
  const openedIdentity = fileIdentity(opened);
  if (!sameIdentity(expected, openedIdentity)) {
    throw new SqliteInspectionError('changed');
  }

  const digest = createHash('sha256');
  const chunk = Buffer.allocUnsafe(HASH_CHUNK_BYTES);
  for (;;) {
    const bytesRead = readSync(descriptor, chunk, 0, chunk.length, null);
    if (bytesRead === 0) break;
    digest.update(chunk.subarray(0, bytesRead));
  }

  const finalIdentity = fileIdentity(fstatSync(descriptor, { bigint: true }));
  if (!sameIdentity(openedIdentity, finalIdentity)) {
    throw new SqliteInspectionError('changed');
  }
  const sizeBytes = Number(finalIdentity.size);
  if (!Number.isSafeInteger(sizeBytes) || sizeBytes < 0) {
    throw new SqliteInspectionError('unreadable');
  }
  return { identity: finalIdentity, sizeBytes, sha256: digest.digest('hex') };
}

/** @throws {SqliteInspectionError} When the path no longer has the expected identity. */
function assertUnchangedPath(path: string, expected: SqliteFileIdentity): void {
  const comparison = compareCurrentPath(path, expected);
  if (comparison === 'same') return;
  throw new SqliteInspectionError(comparison === 'changed' ? 'changed' : 'unreadable');
}

function compareCurrentPath(
  path: string,
  expected: SqliteFileIdentity,
): 'same' | 'changed' | 'unreadable' {
  try {
    const current = lstatSync(path, { bigint: true });
    return current.isFile() &&
      !current.isSymbolicLink() &&
      current.nlink === 1n &&
      sameIdentity(expected, fileIdentity(current))
      ? 'same'
      : 'changed';
  } catch (error) {
    return hasCode(error, 'ENOENT') ? 'changed' : 'unreadable';
  }
}

function fileIdentity(stats: BigIntStats): SqliteFileIdentity {
  return {
    dev: stats.dev,
    ino: stats.ino,
    mode: stats.mode,
    nlink: stats.nlink,
    size: stats.size,
    mtimeNs: stats.mtimeNs,
    ctimeNs: stats.ctimeNs,
  };
}

function sameIdentity(left: SqliteFileIdentity, right: SqliteFileIdentity): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.mode === right.mode &&
    left.nlink === right.nlink &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  );
}

function inspectSidecars(path: string): {
  readonly wal: SqliteSidecarState;
  readonly shm: SqliteSidecarState;
} {
  return {
    wal: inspectPathPresence(`${path}-wal`),
    shm: inspectPathPresence(`${path}-shm`),
  };
}

function inspectPathPresence(path: string): SqliteSidecarState {
  try {
    lstatSync(path);
    return 'present';
  } catch (error) {
    return hasCode(error, 'ENOENT') || hasCode(error, 'ENOTDIR') ? 'absent' : 'unknown';
  }
}

function inspectMainPathPresence(path: string): SqliteSidecarState {
  return inspectPathPresence(path);
}

function hasUnknownSidecar(sidecars: SqliteSidecarPresence): boolean {
  return (
    sidecars.before.wal === 'unknown' ||
    sidecars.before.shm === 'unknown' ||
    sidecars.after.wal === 'unknown' ||
    sidecars.after.shm === 'unknown'
  );
}

/** @throws {SqliteInspectionError} When either SQLite sidecar cannot be classified safely. */
function assertSidecarsKnown(
  sidecars: SqliteSidecarPresence['before'] | SqliteSidecarPresence['after'],
): void {
  if (sidecars.wal === 'unknown' || sidecars.shm === 'unknown') {
    throw new SqliteInspectionError('sidecar-unknown');
  }
}

function classifyFailureIdentity(
  path: string,
  error: unknown,
  hashed: HashedSqliteFile | undefined,
): 'changed' | 'unreadable' | undefined {
  if (hashed !== undefined) {
    const identity = compareCurrentPath(path, hashed.identity);
    return identity === 'same' ? undefined : identity;
  }
  if (!(error instanceof SqliteInspectionError) || error.kind !== 'absent') {
    return undefined;
  }
  const presence = inspectMainPathPresence(path);
  if (presence === 'present') return 'changed';
  return presence === 'unknown' ? 'unreadable' : undefined;
}

function classifyNativeFailure(error: unknown): SqliteInspectionError {
  if (error instanceof SqliteInspectionError) return error;
  const code = readErrorCode(error);
  if (code === 'SQLITE_NOTADB') return new SqliteInspectionError('not-sqlite');
  if (code?.startsWith('SQLITE_CORRUPT')) return new SqliteInspectionError('corrupt');
  return new SqliteInspectionError('unreadable');
}

function hasCode(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === code;
}

function readErrorCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null || !('code' in error)) return undefined;
  return typeof error.code === 'string' ? error.code : undefined;
}

function mapInspectionFailure(
  error: unknown,
  sidecars: SqliteSidecarPresence,
): SqliteIntegrityResult {
  const kind = error instanceof SqliteInspectionError ? error.kind : 'unreadable';
  switch (kind) {
    case 'absent': {
      return { status: 'absent', reason: 'file-absent', sidecars };
    }
    case 'not-sqlite': {
      return {
        status: 'not-sqlite',
        reason: 'invalid-sqlite-header',
        sidecars,
      };
    }
    case 'corrupt': {
      return { status: 'corrupt', reason: 'sqlite-corrupt', sidecars };
    }
    case INVALID_FILE_TYPE_KIND: {
      return { status: 'corrupt', reason: INVALID_FILE_TYPE_KIND, sidecars };
    }
    case 'changed': {
      return {
        status: 'unreadable',
        reason: 'file-changed-during-inspection',
        sidecars,
      };
    }
    case 'close-failed': {
      return { status: 'unreadable', reason: 'native-close-failed', sidecars };
    }
    case 'sidecar-unknown': {
      return {
        status: 'unreadable',
        reason: 'sidecar-inspection-failed',
        sidecars,
      };
    }
    default: {
      return { status: 'unreadable', reason: 'inspection-failed', sidecars };
    }
  }
}

/**
 * @internal Cohesive filesystem evidence operations used by the inspector.
 * Keeping this object module-private to the datastore package avoids widening
 * the public package barrel while retaining independently testable seams.
 */
export const sqliteInspectionEvidence = Object.freeze({
  assertSidecarsKnown,
  assertUnchangedPath,
  classifyFailureIdentity,
  classifyNativeFailure,
  hashStableRegularFile,
  hasUnknownSidecar,
  inspectSidecars,
  mapInspectionFailure,
});
