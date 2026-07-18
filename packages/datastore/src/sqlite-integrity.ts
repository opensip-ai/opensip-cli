/**
 * @fileoverview Closed SQLite checkpointing and bounded, read-only integrity
 * inspection. This module deliberately exposes evidence, never a native handle.
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

import { withFileLock } from '@opensip-cli/core';
import Database from 'better-sqlite3';

import {
  checkpointAndCloseSqlite,
  sqliteConnectionProvenClosed,
  type SqliteLifecycleConnection,
} from './backends/shared.js';
import { LOGICAL_SCHEMA_VERSION } from './schema-version.js';

import type { DataStoreLockContext, DatastoreCloseResult } from './data-store.js';

/** Maximum quick-check failures retained in the bounded result. */
export const SQLITE_QUICK_CHECK_MAX_ISSUES = 16;
/** Maximum foreign-key violation samples retained in the bounded result. */
export const SQLITE_FOREIGN_KEY_MAX_SAMPLES = 16;

const HASH_CHUNK_BYTES = 64 * 1024;
const MAX_IDENTIFIER_BYTES = 256;
const INVALID_FILE_TYPE_KIND = 'invalid-file-type' as const;

/** Bounded sidecar observation; filesystem uncertainty is never called absent. */
export type SqliteSidecarState = 'absent' | 'present' | 'unknown';

/** Presence observed before and after the read-only SQLite connection. */
export interface SqliteSidecarPresence {
  readonly before: {
    readonly wal: SqliteSidecarState;
    readonly shm: SqliteSidecarState;
  };
  readonly after: {
    readonly wal: SqliteSidecarState;
    readonly shm: SqliteSidecarState;
  };
}

/** Bounded summary of `PRAGMA quick_check`. Native diagnostic text is omitted. */
export interface SqliteQuickCheckResult {
  readonly ok: boolean;
  readonly issueCount: number;
  readonly truncated: boolean;
}

/** Public, JSON-safe row identifier from a foreign-key violation. */
export type SqliteForeignKeyRowId = number | string | null;

/** Sanitized identity for one bounded foreign-key violation sample. */
export interface SqliteForeignKeyViolation {
  readonly table: string;
  readonly parent: string;
  readonly rowId: SqliteForeignKeyRowId;
  readonly foreignKeyIndex: number;
}

/** Bounded summary of `pragma_foreign_key_check`. */
export interface SqliteForeignKeyCheckResult {
  readonly ok: boolean;
  /**
   * Number observed by the capped query. When `truncated` is true, this is a
   * lower bound rather than an unbounded exact count.
   */
  readonly violationCount: number;
  readonly sampleCap: number;
  readonly truncated: boolean;
  readonly samples: readonly SqliteForeignKeyViolation[];
}

/** Facts available after a stable SQLite inspection completed. */
export interface SqliteIntegrityFacts {
  readonly sizeBytes: number;
  readonly sha256: string;
  readonly userVersion: number;
  readonly supportedVersion: number;
  readonly supported: boolean;
  readonly quickCheck: SqliteQuickCheckResult;
  readonly foreignKeys: SqliteForeignKeyCheckResult;
  readonly sidecars: SqliteSidecarPresence;
}

/**
 * Stable integrity result. No branch carries native errors or handles; the
 * `native-close-failed` branch explicitly proves that native closure failed.
 */
export type SqliteIntegrityResult =
  | ({ readonly status: 'valid' } & SqliteIntegrityFacts)
  | ({
      readonly status: 'unsupported';
      readonly reason: 'schema-newer-than-cli';
    } & SqliteIntegrityFacts)
  | ({
      readonly status: 'corrupt';
      readonly reason: 'quick-check-failed' | 'foreign-key-violations';
    } & SqliteIntegrityFacts)
  | {
      readonly status: 'absent';
      readonly reason: 'file-absent';
      readonly sidecars: SqliteSidecarPresence;
    }
  | {
      readonly status: 'not-sqlite';
      readonly reason: 'invalid-sqlite-header';
      readonly sidecars: SqliteSidecarPresence;
    }
  | {
      readonly status: 'corrupt';
      readonly reason: 'sqlite-corrupt' | 'invalid-file-type';
      readonly sidecars: SqliteSidecarPresence;
    }
  | {
      readonly status: 'unreadable';
      readonly reason:
        | 'inspection-failed'
        | 'file-changed-during-inspection'
        | 'native-close-failed'
        | 'sidecar-inspection-failed';
      readonly sidecars: SqliteSidecarPresence;
    };

interface FileIdentity {
  readonly dev: bigint;
  readonly ino: bigint;
  readonly mode: bigint;
  readonly nlink: bigint;
  readonly size: bigint;
  readonly mtimeNs: bigint;
  readonly ctimeNs: bigint;
}

interface HashedFile {
  readonly identity: FileIdentity;
  readonly sizeBytes: number;
  readonly sha256: string;
}

interface ForeignKeyRow {
  readonly table?: unknown;
  readonly rowid?: unknown;
  readonly parent?: unknown;
  readonly fkid?: unknown;
}

type SqliteInspectionErrorKind =
  | 'absent'
  | 'not-sqlite'
  | 'corrupt'
  | 'invalid-file-type'
  | 'changed'
  | 'close-failed'
  | 'sidecar-unknown'
  | 'unreadable';

class SqliteInspectionError extends Error {
  constructor(readonly kind: SqliteInspectionErrorKind) {
    super(kind);
    this.name = 'SqliteInspectionError';
  }
}

/** @internal Deterministic transition seams for datastore-owned fault tests. */
export interface SqliteInspectionOptions {
  /** Reasserts caller authority immediately before the native read-only open. */
  readonly beforeOpen?: () => void;
}

/** @internal Deterministic transition seams for datastore-owned fault tests. */
export interface SqliteInspectionDependencies extends SqliteInspectionOptions {
  readonly afterHash?: () => void;
  readonly afterFailure?: () => void;
  readonly openDatabase?: (path: string) => Database.Database;
}

/** @internal
 * Optional maintenance authority for callers that already hold a stronger
 * lifecycle lease. Ordinary datastore callers retain the adjacent lock path.
 */
export interface SqliteCheckpointOptions {
  /** Stable, caller-owned lock location outside a runtime tree being moved. */
  readonly lockPath?: string;
  /** Runs inside the acquired lock immediately before the native open. */
  readonly beforeOpen?: () => void;
  /** Runs after native open and before checkpointing; deterministic fault seam. */
  readonly afterOpen?: () => void;
  /** Reasserts authority after the fault seam and immediately before checkpoint. */
  readonly beforeCheckpoint?: () => void;
  /** Runs inside the acquired lock after checkpoint and native close. */
  readonly afterClose?: () => void;
}

/** @internal Native-open seam used only by datastore-owned lifecycle tests. */
export interface SqliteCheckpointDependencies {
  readonly openDatabase: (path: string) => SqliteLifecycleConnection;
}

class SqliteCheckpointLifecycleError extends Error {
  constructor(readonly result: DatastoreCloseResult) {
    super('Unable to open the existing SQLite file for checkpointing');
    this.name = 'SqliteCheckpointLifecycleError';
  }
}

/**
 * Recover the bounded native-close proof from a checkpoint failure.
 *
 * Callers must treat `undefined` conservatively: only this datastore-owned
 * error proves whether a native handle was closed.
 */
export function sqliteCheckpointFailureResult(error: unknown): DatastoreCloseResult | undefined {
  return error instanceof SqliteCheckpointLifecycleError ? error.result : undefined;
}

function failedCheckpointResult(closed: boolean): DatastoreCloseResult {
  return closed
    ? { checkpointed: false, closed: true, reason: 'checkpoint-failed' }
    : {
        checkpointed: false,
        closed: false,
        reason: 'checkpoint-and-close-failed',
      };
}

function closeWithoutCheckpoint(sqlite: SqliteLifecycleConnection): DatastoreCloseResult {
  try {
    sqlite.close();
  } catch {
    // The native `open` state below remains the authority-bearing proof.
  }
  return failedCheckpointResult(sqliteConnectionProvenClosed(sqlite));
}

const DEFAULT_CHECKPOINT_DEPENDENCIES: SqliteCheckpointDependencies = Object.freeze({
  openDatabase: (path: string) => new Database(path, { fileMustExist: true }),
});

/**
 * Checkpoint and close an existing SQLite file while serialized by its normal
 * datastore write lock.
 *
 * The caller must already hold the runtime's exclusive maintenance lease. This
 * function uses `fileMustExist`, does not migrate or vacuum, and reports whether
 * the native connection is proven closed.
 */
export function checkpointSqliteFile(
  path: string,
  lockContext: DataStoreLockContext,
  options: SqliteCheckpointOptions = {},
): DatastoreCloseResult {
  return checkpointSqliteFileWithDependencies(
    path,
    lockContext,
    options,
    DEFAULT_CHECKPOINT_DEPENDENCIES,
  );
}

/** @internal Use {@link checkpointSqliteFile} outside datastore tests. */
export function checkpointSqliteFileWithDependencies(
  path: string,
  lockContext: DataStoreLockContext,
  options: SqliteCheckpointOptions,
  dependencies: SqliteCheckpointDependencies,
): DatastoreCloseResult {
  try {
    return withFileLock(
      options.lockPath ?? `${path}.write.lock`,
      {
        policy: lockContext.policy,
        resource: 'datastore',
        operation: 'datastore.checkpoint',
        runId: lockContext.runId,
        command: lockContext.command,
        cwdBasename: lockContext.cwdBasename,
        onEvent: lockContext.onLockEvent,
      },
      () => {
        try {
          options.beforeOpen?.();
        } catch {
          throw new SqliteCheckpointLifecycleError(failedCheckpointResult(true));
        }

        let sqlite: SqliteLifecycleConnection;
        try {
          sqlite = dependencies.openDatabase(path);
        } catch {
          throw new SqliteCheckpointLifecycleError(failedCheckpointResult(true));
        }

        try {
          options.afterOpen?.();
          options.beforeCheckpoint?.();
        } catch {
          throw new SqliteCheckpointLifecycleError(closeWithoutCheckpoint(sqlite));
        }

        let result: DatastoreCloseResult;
        try {
          result = checkpointAndCloseSqlite(sqlite);
        } catch {
          throw new SqliteCheckpointLifecycleError(closeWithoutCheckpoint(sqlite));
        }
        try {
          options.afterClose?.();
        } catch {
          throw new SqliteCheckpointLifecycleError(result);
        }
        return result;
      },
    );
  } catch (error) {
    if (error instanceof SqliteCheckpointLifecycleError) throw error;
    // File-lock/open failures before a native handle is returned are safe to
    // release. Every post-open failure above carries its own close proof.
    throw new SqliteCheckpointLifecycleError(failedCheckpointResult(true));
  }
}

/**
 * Inspect an existing SQLite file through a read-only, file-must-exist handle.
 *
 * No migrations, schema writes, vacuum, or auto-vacuum conversion occur here.
 * SQLite may itself materialize a zero-byte `-shm`/`-wal` sidecar while opening
 * an existing WAL database, so sidecar presence is captured both before and
 * after rather than claiming this path has no filesystem effects.
 */
export function inspectSqliteFile(
  path: string,
  options: SqliteInspectionOptions = {},
): SqliteIntegrityResult {
  return inspectSqliteFileWithDependencies(path, options);
}

/** @internal Use {@link inspectSqliteFile} outside datastore tests. */
export function inspectSqliteFileWithDependencies(
  path: string,
  dependencies: SqliteInspectionDependencies = {},
): SqliteIntegrityResult {
  const before = inspectSidecars(path);
  let after = before;
  let hashed: HashedFile | undefined;

  try {
    assertSidecarsKnown(before);
    hashed = hashStableRegularFile(path);
    dependencies.afterHash?.();
    const inspected = inspectDatabase(path, dependencies.openDatabase, dependencies.beforeOpen);
    after = inspectSidecars(path);
    assertSidecarsKnown(after);
    assertUnchangedPath(path, hashed.identity);

    const facts: SqliteIntegrityFacts = {
      sizeBytes: hashed.sizeBytes,
      sha256: hashed.sha256,
      userVersion: inspected.userVersion,
      supportedVersion: LOGICAL_SCHEMA_VERSION,
      supported: inspected.userVersion <= LOGICAL_SCHEMA_VERSION,
      quickCheck: inspected.quickCheck,
      foreignKeys: inspected.foreignKeys,
      sidecars: { before, after },
    };
    return classifyCompletedInspection(facts);
  } catch (error) {
    return classifyFailedInspection(path, error, before, hashed, dependencies);
  }
}

function classifyCompletedInspection(facts: SqliteIntegrityFacts): SqliteIntegrityResult {
  if (!facts.quickCheck.ok) {
    return { status: 'corrupt', reason: 'quick-check-failed', ...facts };
  }
  if (!facts.foreignKeys.ok) {
    return { status: 'corrupt', reason: 'foreign-key-violations', ...facts };
  }
  if (!facts.supported) {
    return {
      status: 'unsupported',
      reason: 'schema-newer-than-cli',
      ...facts,
    };
  }
  return { status: 'valid', ...facts };
}

function classifyFailedInspection(
  path: string,
  error: unknown,
  before: SqliteSidecarPresence['before'],
  hashed: HashedFile | undefined,
  dependencies: SqliteInspectionDependencies,
): SqliteIntegrityResult {
  try {
    dependencies.afterFailure?.();
  } catch {
    // @swallow-ok secondary diagnostics must not replace the primary bounded result
  }
  const sidecars: SqliteSidecarPresence = {
    before,
    after: inspectSidecars(path),
  };
  // Native lifecycle evidence is stronger than every secondary diagnostic.
  // Losing it to a concurrent identity/sidecar failure would let promotion
  // release its process-owned lease while the SQLite handle remains open.
  if (error instanceof SqliteInspectionError && error.kind === 'close-failed') {
    return mapInspectionFailure(error, sidecars);
  }
  const identityFailure = classifyFailureIdentity(path, error, hashed);
  if (identityFailure !== undefined) {
    return mapInspectionFailure(new SqliteInspectionError(identityFailure), sidecars);
  }
  if (hasUnknownSidecar(sidecars)) {
    return mapInspectionFailure(new SqliteInspectionError('sidecar-unknown'), sidecars);
  }
  return mapInspectionFailure(error, sidecars);
}

function classifyFailureIdentity(
  path: string,
  error: unknown,
  hashed: HashedFile | undefined,
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

function inspectDatabase(
  path: string,
  openDatabase: (path: string) => Database.Database = openReadonlyDatabase,
  beforeOpen?: () => void,
): {
  readonly userVersion: number;
  readonly quickCheck: SqliteQuickCheckResult;
  readonly foreignKeys: SqliteForeignKeyCheckResult;
} {
  let sqlite: Database.Database | undefined;
  let result:
    | {
        readonly userVersion: number;
        readonly quickCheck: SqliteQuickCheckResult;
        readonly foreignKeys: SqliteForeignKeyCheckResult;
      }
    | undefined;
  let failure: unknown;
  let closeFailed = false;

  try {
    beforeOpen?.();
    sqlite = openDatabase(path);
    result = {
      userVersion: readUserVersion(sqlite),
      quickCheck: runQuickCheck(sqlite),
      foreignKeys: runForeignKeyCheck(sqlite),
    };
  } catch (error) {
    failure = error;
  } finally {
    if (sqlite) {
      try {
        sqlite.close();
      } catch {
        // The native `open` state below is the authority-bearing proof.
      }
      closeFailed = !sqliteConnectionProvenClosed(sqlite);
    }
  }

  if (closeFailed) throw new SqliteInspectionError('close-failed');
  if (failure !== undefined) throw classifyNativeFailure(failure);
  if (!result) throw new SqliteInspectionError('unreadable');
  return result;
}

function openReadonlyDatabase(path: string): Database.Database {
  return new Database(path, { readonly: true, fileMustExist: true });
}

function readUserVersion(sqlite: Database.Database): number {
  const value = Number(sqlite.pragma('user_version', { simple: true }));
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new SqliteInspectionError('corrupt');
  }
  return value;
}

function runQuickCheck(sqlite: Database.Database): SqliteQuickCheckResult {
  const rows: unknown = sqlite.pragma(`quick_check(${SQLITE_QUICK_CHECK_MAX_ISSUES + 1})`);
  if (!Array.isArray(rows) || rows.length === 0) {
    throw new SqliteInspectionError('corrupt');
  }

  const issues = rows.filter((row: unknown) => readQuickCheckValue(row) !== 'ok');
  return {
    ok: issues.length === 0,
    issueCount: Math.min(issues.length, SQLITE_QUICK_CHECK_MAX_ISSUES),
    truncated: issues.length > SQLITE_QUICK_CHECK_MAX_ISSUES,
  };
}

function readQuickCheckValue(row: unknown): unknown {
  if (typeof row !== 'object' || row === null || !('quick_check' in row)) {
    return undefined;
  }
  return (row as Record<string, unknown>).quick_check;
}

function runForeignKeyCheck(sqlite: Database.Database): SqliteForeignKeyCheckResult {
  const rows = sqlite
    .prepare('SELECT "table", "rowid", "parent", "fkid" FROM pragma_foreign_key_check LIMIT ?')
    .all(SQLITE_FOREIGN_KEY_MAX_SAMPLES + 1) as readonly ForeignKeyRow[];
  const truncated = rows.length > SQLITE_FOREIGN_KEY_MAX_SAMPLES;
  const samples = rows
    .slice(0, SQLITE_FOREIGN_KEY_MAX_SAMPLES)
    .map((row) => sanitizeForeignKeyViolation(row));
  return {
    ok: rows.length === 0,
    violationCount: rows.length,
    sampleCap: SQLITE_FOREIGN_KEY_MAX_SAMPLES,
    truncated,
    samples,
  };
}

function sanitizeForeignKeyViolation(row: ForeignKeyRow): SqliteForeignKeyViolation {
  return {
    table: boundedIdentifier(row.table),
    parent: boundedIdentifier(row.parent),
    rowId: safeRowId(row.rowid),
    foreignKeyIndex:
      typeof row.fkid === 'number' && Number.isSafeInteger(row.fkid) && row.fkid >= 0
        ? row.fkid
        : -1,
  };
}

function boundedIdentifier(value: unknown): string {
  if (typeof value !== 'string') return '';
  return Buffer.from(value).subarray(0, MAX_IDENTIFIER_BYTES).toString('utf8');
}

function safeRowId(value: unknown): SqliteForeignKeyRowId {
  let rowId: SqliteForeignKeyRowId = null;
  if (typeof value === 'number' && Number.isSafeInteger(value)) rowId = value;
  if (typeof value === 'bigint') rowId = value.toString();
  return rowId;
}

function hashStableRegularFile(path: string): HashedFile {
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

function readInitialIdentity(path: string): FileIdentity {
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

function hashOpenedDescriptor(descriptor: number, expected: FileIdentity): HashedFile {
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

function assertUnchangedPath(path: string, expected: FileIdentity): void {
  const comparison = compareCurrentPath(path, expected);
  if (comparison === 'same') return;
  throw new SqliteInspectionError(comparison === 'changed' ? 'changed' : 'unreadable');
}

function compareCurrentPath(
  path: string,
  expected: FileIdentity,
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

function fileIdentity(stats: BigIntStats): FileIdentity {
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

function sameIdentity(left: FileIdentity, right: FileIdentity): boolean {
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

function assertSidecarsKnown(
  sidecars: SqliteSidecarPresence['before'] | SqliteSidecarPresence['after'],
): void {
  if (sidecars.wal === 'unknown' || sidecars.shm === 'unknown') {
    throw new SqliteInspectionError('sidecar-unknown');
  }
}

function classifyNativeFailure(error: unknown): SqliteInspectionError {
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
