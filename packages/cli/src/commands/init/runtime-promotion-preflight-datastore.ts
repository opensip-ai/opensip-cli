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
import { RuntimePromotionDatastoreError } from './runtime-promotion-preflight-datastore-error.js';
import {
  assertExactDatabaseSet,
  assertExactFileSnapshot,
  assertPostCloseSnapshot,
  assertSameSidecarObjects,
  captureCurrentDatabaseAuthority,
  databaseSetSnapshot,
  runtimePromotionFileSnapshot,
  type RuntimePromotionDatabaseSetSnapshot,
} from './runtime-promotion-preflight-datastore-snapshot.js';
import { assertRuntimePromotionProjectRootAuthority } from './runtime-promotion-root-authority.js';

import type { RuntimePromotionJournal } from './runtime-promotion-journal-schema.js';
import type {
  RuntimePromotionDatastoreCheckpointInput,
  RuntimePromotionDatastoreDependencies,
  RuntimePromotionDatastoreIdentity,
  RuntimePromotionDatastoreKind,
} from './runtime-promotion-preflight-datastore-types.js';

export { RuntimePromotionDatastoreError } from './runtime-promotion-preflight-datastore-error.js';

const DATABASE_INVALID_REASON = 'database-invalid';

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

/** @throws {RuntimePromotionDatastoreError} When the open journal lacks exact datastore authority. */
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

/** @throws {RuntimePromotionDatastoreError} When a datastore checkpoint or close is incomplete. */
function assertCheckpointComplete(result: DatastoreCloseResult): void {
  if (!result.checkpointed || !result.closed) {
    throw new RuntimePromotionDatastoreError('checkpoint-incomplete', result);
  }
}

/** @throws {RuntimePromotionDatastoreError} When integrity inspection bypasses its authority guard. */
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

/** @throws {RuntimePromotionDatastoreError} When SQLite integrity inspection cannot be proven safe. */
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

/** @throws {RuntimePromotionDatastoreError} When SQLite integrity evidence is incomplete or unsafe. */
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
 *
 * @throws {RuntimePromotionDatastoreError} When checkpoint or integrity authority cannot be proven.
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
          /** @throws {RuntimePromotionDatastoreError} When open-database authority was not captured. */
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
