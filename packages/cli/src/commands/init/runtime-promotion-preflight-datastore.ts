import { lstatSync, type BigIntStats } from 'node:fs';

import {
  checkpointSqliteFile,
  inspectSqliteFile,
  sqliteCheckpointFailureResult,
  type DatastoreCloseResult,
  type SqliteIntegrityResult,
} from '@opensip-cli/datastore';

import {
  assertBoundRuntimePromotionDatastoreSet,
  bindRuntimePromotionDatastoreSet,
  closeBoundRuntimePromotionDatastoreSet,
} from './runtime-promotion-preflight-datastore-authority.js';
import { assertRuntimePromotionProjectRootAuthority } from './runtime-promotion-root-authority.js';

import type { RuntimePromotionJournal } from './runtime-promotion-journal-schema.js';
import type {
  RuntimePromotionDatastoreCheckpointInput,
  RuntimePromotionDatastoreDependencies,
  RuntimePromotionDatastoreFailureReason,
  RuntimePromotionDatastoreIdentity,
  RuntimePromotionDatastoreKind,
} from './runtime-promotion-preflight-datastore-types.js';

const DATABASE_INVALID_REASON = 'database-invalid';

export class RuntimePromotionDatastoreError extends Error {
  readonly releaseSafe: boolean;

  constructor(
    readonly reason: RuntimePromotionDatastoreFailureReason,
    readonly closeResult?: DatastoreCloseResult,
  ) {
    super(`Runtime promotion datastore preparation failed (${reason}).`);
    this.name = 'RuntimePromotionDatastoreError';
    this.releaseSafe = closeResult?.closed !== false;
  }
}

function mainFilePresence(path: string): 'absent' | 'file' | 'unsafe' {
  const snapshot = runtimePromotionFileSnapshot(path);
  return snapshot.status;
}

const DEFAULT_DEPENDENCIES: RuntimePromotionDatastoreDependencies = Object.freeze({
  checkpoint: checkpointSqliteFile,
  inspect: inspectSqliteFile,
  mainFilePresence,
});

function assertProjectRootAuthority(input: RuntimePromotionDatastoreCheckpointInput): void {
  assertRuntimePromotionProjectRootAuthority({
    lease: input.lease,
    authority: input.projectRootAuthority,
  });
}

function candidateSetValid(
  input: RuntimePromotionDatastoreCheckpointInput,
  journal: RuntimePromotionJournal,
): boolean {
  const expectedKinds: RuntimePromotionDatastoreKind[] = [];
  if (journal.source.classification !== 'none') expectedKinds.push('source');
  if (journal.destinationRuntimePreexisting) expectedKinds.push('destination');
  return (
    input.candidates.length === expectedKinds.length &&
    input.candidates.every((candidate, index) => candidate.kind === expectedKinds[index]) &&
    new Set(input.candidates.map((candidate) => candidate.runtimeDir)).size ===
      input.candidates.length
  );
}

function assertVerifiedOpenJournal(
  journal: RuntimePromotionJournal,
  input: RuntimePromotionDatastoreCheckpointInput,
): void {
  if (
    journal.state !== 'open' ||
    journal.operationId !== input.receipt.operationId ||
    journal.revision !== input.receipt.revision ||
    journal.coordinationKey !== input.receipt.coordinationKey ||
    journal.coordinationKey !== input.projectRootAuthority.coordinationKey ||
    journal.coordinationKey !== input.lease.coordinationKey
  ) {
    throw new RuntimePromotionDatastoreError('candidate-set-invalid');
  }
}

interface RuntimePromotionDatabaseAuthority {
  readonly dev: bigint;
  readonly ino: bigint;
  readonly uid: bigint;
  readonly mode: bigint;
  readonly nlink: bigint;
  readonly size: bigint;
  readonly mtimeNs: bigint;
  readonly ctimeNs: bigint;
}

type RuntimePromotionFileSnapshot =
  | { readonly status: 'absent' }
  | {
      readonly status: 'file';
      readonly identity: RuntimePromotionDatabaseAuthority;
    }
  | { readonly status: 'unsafe' };

function databaseIdentity(stat: BigIntStats): RuntimePromotionDatabaseAuthority {
  return {
    dev: stat.dev,
    ino: stat.ino,
    uid: stat.uid,
    mode: stat.mode,
    nlink: stat.nlink,
    size: stat.size,
    mtimeNs: stat.mtimeNs,
    ctimeNs: stat.ctimeNs,
  };
}

function runtimePromotionFileSnapshot(path: string): RuntimePromotionFileSnapshot {
  try {
    const stat = lstatSync(path, { bigint: true });
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1n) {
      return { status: 'unsafe' };
    }
    const uid = typeof process.getuid === 'function' ? BigInt(process.getuid()) : undefined;
    if (uid !== undefined && stat.uid !== uid) return { status: 'unsafe' };
    return { status: 'file', identity: databaseIdentity(stat) };
  } catch (error) {
    return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT'
      ? { status: 'absent' }
      : { status: 'unsafe' };
  }
}

function sameFileIdentity(
  expected: RuntimePromotionDatabaseAuthority,
  observed: RuntimePromotionDatabaseAuthority,
): boolean {
  return (
    expected.dev === observed.dev &&
    expected.ino === observed.ino &&
    expected.uid === observed.uid &&
    expected.mode === observed.mode &&
    expected.nlink === observed.nlink &&
    expected.size === observed.size &&
    expected.mtimeNs === observed.mtimeNs &&
    expected.ctimeNs === observed.ctimeNs
  );
}

function sameFileObject(
  expected: RuntimePromotionDatabaseAuthority,
  observed: RuntimePromotionDatabaseAuthority,
): boolean {
  return (
    expected.dev === observed.dev &&
    expected.ino === observed.ino &&
    expected.uid === observed.uid &&
    expected.mode === observed.mode &&
    expected.nlink === observed.nlink
  );
}

interface RuntimePromotionDatabaseSetSnapshot {
  readonly main: RuntimePromotionFileSnapshot;
  readonly wal: RuntimePromotionFileSnapshot;
  readonly shm: RuntimePromotionFileSnapshot;
}

function databaseSetSnapshot(path: string): RuntimePromotionDatabaseSetSnapshot {
  return {
    main: runtimePromotionFileSnapshot(path),
    wal: runtimePromotionFileSnapshot(`${path}-wal`),
    shm: runtimePromotionFileSnapshot(`${path}-shm`),
  };
}

function assertExactFileSnapshot(path: string, expected: RuntimePromotionFileSnapshot): void {
  const observed = runtimePromotionFileSnapshot(path);
  if (
    expected.status !== observed.status ||
    (expected.status === 'file' &&
      (observed.status !== 'file' || !sameFileIdentity(expected.identity, observed.identity)))
  ) {
    throw new RuntimePromotionDatastoreError(DATABASE_INVALID_REASON);
  }
}

function assertExactDatabaseSet(path: string, expected: RuntimePromotionDatabaseSetSnapshot): void {
  assertExactFileSnapshot(path, expected.main);
  assertExactFileSnapshot(`${path}-wal`, expected.wal);
  assertExactFileSnapshot(`${path}-shm`, expected.shm);
}

function assertMainDatabaseObject(path: string, expected: RuntimePromotionFileSnapshot): void {
  const observed = runtimePromotionFileSnapshot(path);
  if (
    expected.status !== observed.status ||
    (expected.status === 'file' &&
      (observed.status !== 'file' || !sameFileObject(expected.identity, observed.identity)))
  ) {
    throw new RuntimePromotionDatastoreError(DATABASE_INVALID_REASON);
  }
}

function captureCurrentDatabaseAuthority(
  input: RuntimePromotionDatastoreCheckpointInput,
  bound: Parameters<typeof assertBoundRuntimePromotionDatastoreSet>[1],
  path: string,
  expectedMain: RuntimePromotionFileSnapshot,
): RuntimePromotionDatabaseSetSnapshot {
  assertBoundRuntimePromotionDatastoreSet(input, bound);
  assertMainDatabaseObject(path, expectedMain);
  const observed = databaseSetSnapshot(path);
  if (observed.wal.status === 'unsafe' || observed.shm.status === 'unsafe') {
    throw new RuntimePromotionDatastoreError(DATABASE_INVALID_REASON);
  }
  return observed;
}

function assertSameSidecarObjects(
  expected: RuntimePromotionDatabaseSetSnapshot,
  observed: RuntimePromotionDatabaseSetSnapshot,
): void {
  for (const sidecar of ['wal', 'shm'] as const) {
    const expectedSidecar = expected[sidecar];
    const observedSidecar = observed[sidecar];
    if (
      expectedSidecar.status !== observedSidecar.status ||
      (expectedSidecar.status === 'file' &&
        (observedSidecar.status !== 'file' ||
          !sameFileObject(expectedSidecar.identity, observedSidecar.identity)))
    ) {
      throw new RuntimePromotionDatastoreError(DATABASE_INVALID_REASON);
    }
  }
}

function assertPostCloseSnapshot(
  path: string,
  snapshot: RuntimePromotionDatabaseSetSnapshot | undefined,
): void {
  if (snapshot !== undefined) assertExactDatabaseSet(path, snapshot);
}

function assertCheckpointComplete(result: DatastoreCloseResult): void {
  if (!result.checkpointed || !result.closed) {
    throw new RuntimePromotionDatastoreError('checkpoint-incomplete', result);
  }
}

function assertInspectionAuthorityAccepted(invoked: boolean, accepted: boolean): void {
  if (!invoked || !accepted) {
    throw new RuntimePromotionDatastoreError(DATABASE_INVALID_REASON);
  }
}

const UNKNOWN_UNCLOSED_RESULT: DatastoreCloseResult = Object.freeze({
  checkpointed: false,
  closed: false,
  reason: 'checkpoint-and-close-failed',
});

function inspectWithLifecycleProof(
  dependencies: RuntimePromotionDatastoreDependencies,
  path: string,
  options: Parameters<RuntimePromotionDatastoreDependencies['inspect']>[1],
): SqliteIntegrityResult {
  let integrity: SqliteIntegrityResult;
  try {
    integrity = dependencies.inspect(path, options);
  } catch {
    // A foreign inspector can throw after native open. Without an explicit
    // close proof, promotion must retain its process-owned lifecycle lease.
    throw new RuntimePromotionDatastoreError('database-unreadable', UNKNOWN_UNCLOSED_RESULT);
  }
  if (integrity.status === 'unreadable' && integrity.reason === 'native-close-failed') {
    throw new RuntimePromotionDatastoreError('database-unreadable', {
      checkpointed: true,
      closed: false,
      reason: 'native-close-failed',
    });
  }
  return integrity;
}

function sidecarsAbsent(result: SqliteIntegrityResult): boolean {
  return (
    result.sidecars.before.wal === 'absent' &&
    result.sidecars.before.shm === 'absent' &&
    result.sidecars.after.wal === 'absent' &&
    result.sidecars.after.shm === 'absent'
  );
}

function classifyIntegrity(
  kind: RuntimePromotionDatastoreKind,
  integrity: SqliteIntegrityResult,
): RuntimePromotionDatastoreIdentity {
  if (integrity.status === 'absent') {
    if (!sidecarsAbsent(integrity)) {
      throw new RuntimePromotionDatastoreError(DATABASE_INVALID_REASON);
    }
    return { kind, status: 'absent' };
  }
  if (integrity.status === 'unsupported') {
    throw new RuntimePromotionDatastoreError('database-unsupported');
  }
  if (integrity.status === 'unreadable') {
    if (integrity.reason === 'native-close-failed') {
      throw new RuntimePromotionDatastoreError('database-unreadable', {
        checkpointed: true,
        closed: false,
        reason: 'native-close-failed',
      });
    }
    throw new RuntimePromotionDatastoreError('database-unreadable');
  }
  if (integrity.status !== 'valid' || !integrity.supported) {
    throw new RuntimePromotionDatastoreError(DATABASE_INVALID_REASON);
  }
  return {
    kind,
    status: 'verified',
    sha256: integrity.sha256,
    sizeBytes: integrity.sizeBytes,
    userVersion: integrity.userVersion,
    supportedVersion: integrity.supportedVersion,
  };
}

/**
 * Checkpoint, close, and inspect SQLite candidates one at a time.
 *
 * This helper is deliberately separate from read-only preflight: callers invoke
 * it only after the durable open journal exists. It binds every candidate to
 * that receipt before any datastore callback and holds no-follow directory
 * handles through checkpoint and inspection. Node/better-sqlite3 has no openat
 * API, so this closes deterministic process-level swap windows rather than
 * claiming an OS sandbox against a concurrently racing local process.
 */
export async function checkpointRuntimePromotionDatastores(
  input: RuntimePromotionDatastoreCheckpointInput,
  dependencyOverrides: Partial<RuntimePromotionDatastoreDependencies> = {},
): Promise<readonly RuntimePromotionDatastoreIdentity[]> {
  const dependencies = { ...DEFAULT_DEPENDENCIES, ...dependencyOverrides };
  assertProjectRootAuthority(input);
  input.controller.assertBoundLease(input.lease);
  const journal = await input.controller.verifyOpen(input.receipt);
  assertVerifiedOpenJournal(journal, input);
  if (!candidateSetValid(input, journal)) {
    throw new RuntimePromotionDatastoreError('candidate-set-invalid');
  }

  let bound;
  try {
    bound = bindRuntimePromotionDatastoreSet({
      candidates: input.candidates,
      journal,
      lease: input.lease,
      projectRootAuthority: input.projectRootAuthority,
    });
  } catch {
    throw new RuntimePromotionDatastoreError('candidate-set-invalid');
  }

  const results: RuntimePromotionDatastoreIdentity[] = [];
  try {
    const prebound = bound.candidates.map((candidate) => {
      assertBoundRuntimePromotionDatastoreSet(input, bound);
      const database = databaseSetSnapshot(candidate.databasePath);
      if (
        database.main.status === 'unsafe' ||
        database.wal.status === 'unsafe' ||
        database.shm.status === 'unsafe' ||
        (database.main.status === 'absent' &&
          (database.wal.status !== 'absent' || database.shm.status !== 'absent'))
      ) {
        throw new RuntimePromotionDatastoreError(DATABASE_INVALID_REASON);
      }
      return { candidate, database };
    });
    const assertAllExpected = (): void => {
      assertBoundRuntimePromotionDatastoreSet(input, bound);
      for (const expected of prebound) {
        assertExactDatabaseSet(expected.candidate.databasePath, expected.database);
      }
    };
    assertBoundRuntimePromotionDatastoreSet(input, bound);

    for (const [index, current] of prebound.entries()) {
      const { candidate, database } = current;
      const assertOtherExpected = (): void => {
        for (const [otherIndex, other] of prebound.entries()) {
          if (otherIndex === index) continue;
          assertExactDatabaseSet(other.candidate.databasePath, other.database);
        }
      };
      const assertInitialAuthority = (): void => {
        assertBoundRuntimePromotionDatastoreSet(input, bound);
        assertExactDatabaseSet(candidate.databasePath, database);
      };
      assertAllExpected();
      const reportedPresence = dependencies.mainFilePresence(candidate.databasePath);
      assertAllExpected();
      if (reportedPresence !== database.main.status) {
        throw new RuntimePromotionDatastoreError(DATABASE_INVALID_REASON);
      }

      if (database.main.status === 'absent') {
        const integrity = inspectWithLifecycleProof(dependencies, candidate.databasePath, {
          beforeOpen: assertInitialAuthority,
        });
        assertInitialAuthority();
        assertOtherExpected();
        results.push(classifyIntegrity(candidate.candidate.kind, integrity));
        dependencies.afterCandidate?.(candidate.candidate.kind);
        assertAllExpected();
        continue;
      }

      dependencies.beforeCheckpoint?.(candidate.candidate.kind);
      assertAllExpected();
      let closeResult: DatastoreCloseResult;
      let postOpenDatabase: RuntimePromotionDatabaseSetSnapshot | undefined;
      let postCloseDatabase: RuntimePromotionDatabaseSetSnapshot | undefined;
      try {
        closeResult = await dependencies.checkpoint(candidate.databasePath, input.lockContext, {
          lockPath: bound.lockPath,
          beforeOpen: assertInitialAuthority,
          afterOpen: () => {
            postOpenDatabase = captureCurrentDatabaseAuthority(
              input,
              bound,
              candidate.databasePath,
              database.main,
            );
          },
          beforeCheckpoint: () => {
            if (postOpenDatabase === undefined) {
              throw new RuntimePromotionDatastoreError(DATABASE_INVALID_REASON);
            }
            const observed = captureCurrentDatabaseAuthority(
              input,
              bound,
              candidate.databasePath,
              database.main,
            );
            assertSameSidecarObjects(postOpenDatabase, observed);
          },
          afterClose: () => {
            postCloseDatabase = captureCurrentDatabaseAuthority(
              input,
              bound,
              candidate.databasePath,
              database.main,
            );
          },
        });
      } catch (error) {
        throw new RuntimePromotionDatastoreError(
          'checkpoint-incomplete',
          sqliteCheckpointFailureResult(error) ?? UNKNOWN_UNCLOSED_RESULT,
        );
      }
      const checkpointedDatabase = captureCurrentDatabaseAuthority(
        input,
        bound,
        candidate.databasePath,
        database.main,
      );
      assertPostCloseSnapshot(candidate.databasePath, postCloseDatabase);
      assertOtherExpected();
      assertCheckpointComplete(closeResult);
      let inspectionGuardInvoked = false;
      let inspectionAuthorityAccepted = false;
      const integrity = inspectWithLifecycleProof(dependencies, candidate.databasePath, {
        beforeOpen: () => {
          inspectionGuardInvoked = true;
          assertBoundRuntimePromotionDatastoreSet(input, bound);
          assertExactDatabaseSet(candidate.databasePath, checkpointedDatabase);
          assertOtherExpected();
          inspectionAuthorityAccepted = true;
        },
      });
      const finalDatabase = captureCurrentDatabaseAuthority(
        input,
        bound,
        candidate.databasePath,
        database.main,
      );
      assertExactFileSnapshot(candidate.databasePath, checkpointedDatabase.main);
      assertOtherExpected();
      assertInspectionAuthorityAccepted(inspectionGuardInvoked, inspectionAuthorityAccepted);
      results.push(classifyIntegrity(candidate.candidate.kind, integrity));
      if (
        finalDatabase.main.status !== 'file' ||
        finalDatabase.wal.status === 'unsafe' ||
        finalDatabase.shm.status === 'unsafe'
      ) {
        throw new RuntimePromotionDatastoreError(DATABASE_INVALID_REASON);
      }
      prebound[index] = { candidate, database: finalDatabase };
      dependencies.afterCandidate?.(candidate.candidate.kind);
      assertAllExpected();
    }
    assertBoundRuntimePromotionDatastoreSet(input, bound);
    return results;
  } finally {
    closeBoundRuntimePromotionDatastoreSet(bound);
  }
}

export type {
  RuntimePromotionDatastoreCandidate,
  RuntimePromotionDatastoreCheckpointInput,
  RuntimePromotionDatastoreDependencies,
  RuntimePromotionDatastoreFailureReason,
  RuntimePromotionDatastoreIdentity,
  RuntimePromotionDatastoreKind,
} from './runtime-promotion-preflight-datastore-types.js';
