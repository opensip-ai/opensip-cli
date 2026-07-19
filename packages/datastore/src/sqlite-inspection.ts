/**
 * @fileoverview Read-only SQLite inspection orchestration and bounded native
 * query normalization.
 */

import Database from 'better-sqlite3';

import { sqliteConnectionProvenClosed } from './backends/shared.js';
import { LOGICAL_SCHEMA_VERSION } from './schema-version.js';
import {
  sqliteInspectionEvidence,
  SqliteInspectionError,
  type HashedSqliteFile,
} from './sqlite-inspection-evidence.js';
import {
  SQLITE_FOREIGN_KEY_MAX_SAMPLES,
  SQLITE_QUICK_CHECK_MAX_ISSUES,
  type SqliteForeignKeyCheckResult,
  type SqliteForeignKeyRowId,
  type SqliteForeignKeyViolation,
  type SqliteIntegrityFacts,
  type SqliteIntegrityResult,
  type SqliteQuickCheckResult,
  type SqliteSidecarPresence,
} from './sqlite-integrity-contract.js';

const MAX_IDENTIFIER_BYTES = 256;

interface ForeignKeyRow {
  readonly table?: unknown;
  readonly rowid?: unknown;
  readonly parent?: unknown;
  readonly fkid?: unknown;
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
  const before = sqliteInspectionEvidence.inspectSidecars(path);
  let after = before;
  let hashed: HashedSqliteFile | undefined;

  try {
    sqliteInspectionEvidence.assertSidecarsKnown(before);
    hashed = sqliteInspectionEvidence.hashStableRegularFile(path);
    dependencies.afterHash?.();
    const inspected = inspectDatabase(path, dependencies.openDatabase, dependencies.beforeOpen);
    after = sqliteInspectionEvidence.inspectSidecars(path);
    sqliteInspectionEvidence.assertSidecarsKnown(after);
    sqliteInspectionEvidence.assertUnchangedPath(path, hashed.identity);

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
  hashed: HashedSqliteFile | undefined,
  dependencies: SqliteInspectionDependencies,
): SqliteIntegrityResult {
  try {
    dependencies.afterFailure?.();
  } catch {
    // @swallow-ok secondary diagnostics must not replace the primary bounded result
  }
  const sidecars: SqliteSidecarPresence = {
    before,
    after: sqliteInspectionEvidence.inspectSidecars(path),
  };
  // Native lifecycle evidence is stronger than every secondary diagnostic.
  // Losing it to a concurrent identity/sidecar failure would let promotion
  // release its process-owned lease while the SQLite handle remains open.
  if (error instanceof SqliteInspectionError && error.kind === 'close-failed') {
    return sqliteInspectionEvidence.mapInspectionFailure(error, sidecars);
  }
  const identityFailure = sqliteInspectionEvidence.classifyFailureIdentity(path, error, hashed);
  if (identityFailure !== undefined) {
    return sqliteInspectionEvidence.mapInspectionFailure(
      new SqliteInspectionError(identityFailure),
      sidecars,
    );
  }
  if (sqliteInspectionEvidence.hasUnknownSidecar(sidecars)) {
    return sqliteInspectionEvidence.mapInspectionFailure(
      new SqliteInspectionError('sidecar-unknown'),
      sidecars,
    );
  }
  return sqliteInspectionEvidence.mapInspectionFailure(error, sidecars);
}

/**
 * @throws {SqliteInspectionError} When the database cannot be inspected and closed safely.
 */
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
        // @swallow-ok the native `open` state below is authoritative; a failed
        // probe or still-open handle is promoted to the stronger close-failed result.
      }
      closeFailed = !sqliteConnectionProvenClosed(sqlite);
    }
  }

  if (closeFailed) throw new SqliteInspectionError('close-failed');
  if (failure !== undefined) throw sqliteInspectionEvidence.classifyNativeFailure(failure);
  if (!result) throw new SqliteInspectionError('unreadable');
  return result;
}

function openReadonlyDatabase(path: string): Database.Database {
  return new Database(path, { readonly: true, fileMustExist: true });
}

/** @throws {SqliteInspectionError} When SQLite reports an invalid user-version value. */
function readUserVersion(sqlite: Database.Database): number {
  const value = Number(sqlite.pragma('user_version', { simple: true }));
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new SqliteInspectionError('corrupt');
  }
  return value;
}

/** @throws {SqliteInspectionError} When SQLite returns a malformed quick-check result. */
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
