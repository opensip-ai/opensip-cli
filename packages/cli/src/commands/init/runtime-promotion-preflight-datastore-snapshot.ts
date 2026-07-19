import { lstatSync } from 'node:fs';

import { hasErrorCode } from './error-code.js';
import { assertBoundRuntimePromotionDatastoreSet } from './runtime-promotion-preflight-datastore-authority.js';
import { RuntimePromotionDatastoreError } from './runtime-promotion-preflight-datastore-error.js';

import type { BoundRuntimePromotionDatastoreSet } from './runtime-promotion-preflight-datastore-authority.js';
import type { RuntimePromotionDatastoreCheckpointInput } from './runtime-promotion-preflight-datastore-types.js';
import type { BigIntStats } from 'node:fs';

const DATABASE_INVALID_REASON = 'database-invalid';

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

export type RuntimePromotionFileSnapshot =
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

export function runtimePromotionFileSnapshot(path: string): RuntimePromotionFileSnapshot {
  try {
    const stat = lstatSync(path, { bigint: true });
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1n) {
      return { status: 'unsafe' };
    }
    const uid = typeof process.getuid === 'function' ? BigInt(process.getuid()) : undefined;
    if (uid !== undefined && stat.uid !== uid) return { status: 'unsafe' };
    return { status: 'file', identity: databaseIdentity(stat) };
  } catch (error) {
    return hasErrorCode(error, 'ENOENT') ? { status: 'absent' } : { status: 'unsafe' };
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

export interface RuntimePromotionDatabaseSetSnapshot {
  readonly main: RuntimePromotionFileSnapshot;
  readonly wal: RuntimePromotionFileSnapshot;
  readonly shm: RuntimePromotionFileSnapshot;
}

export function databaseSetSnapshot(path: string): RuntimePromotionDatabaseSetSnapshot {
  return {
    main: runtimePromotionFileSnapshot(path),
    wal: runtimePromotionFileSnapshot(`${path}-wal`),
    shm: runtimePromotionFileSnapshot(`${path}-shm`),
  };
}

/** @throws {RuntimePromotionDatastoreError} When a file's exact snapshot changes. */
export function assertExactFileSnapshot(
  path: string,
  expected: RuntimePromotionFileSnapshot,
): void {
  const observed = runtimePromotionFileSnapshot(path);
  if (
    expected.status !== observed.status ||
    (expected.status === 'file' &&
      (observed.status !== 'file' || !sameFileIdentity(expected.identity, observed.identity)))
  ) {
    throw new RuntimePromotionDatastoreError(DATABASE_INVALID_REASON);
  }
}

export function assertExactDatabaseSet(
  path: string,
  expected: RuntimePromotionDatabaseSetSnapshot,
): void {
  assertExactFileSnapshot(path, expected.main);
  assertExactFileSnapshot(`${path}-wal`, expected.wal);
  assertExactFileSnapshot(`${path}-shm`, expected.shm);
}

/** @throws {RuntimePromotionDatastoreError} When the main database object changes. */
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

/** @throws {RuntimePromotionDatastoreError} When current database authority cannot be captured. */
export function captureCurrentDatabaseAuthority(
  input: RuntimePromotionDatastoreCheckpointInput,
  bound: BoundRuntimePromotionDatastoreSet,
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

/** @throws {RuntimePromotionDatastoreError} When SQLite sidecar object identity changes. */
export function assertSameSidecarObjects(
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

export function assertPostCloseSnapshot(
  path: string,
  snapshot: RuntimePromotionDatabaseSetSnapshot | undefined,
): void {
  if (snapshot !== undefined) assertExactDatabaseSet(path, snapshot);
}
