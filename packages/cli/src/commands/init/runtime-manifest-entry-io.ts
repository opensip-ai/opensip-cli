import { createHash } from 'node:crypto';
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readlinkSync,
  readSync,
  realpathSync,
} from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';

import { hasErrorCode } from './error-code.js';
import { isPathContained } from './path-containment.js';
import {
  RUNTIME_MANIFEST_MAX_DIGEST_BYTES,
  RUNTIME_MANIFEST_MAX_FILE_BYTES,
  RUNTIME_MANIFEST_MAX_TOTAL_BYTES,
  RuntimeManifestError,
} from './runtime-manifest-model.js';

import type { BigIntStats } from 'node:fs';

const READ_CHUNK_BYTES = 64 * 1024;

export interface RuntimeManifestEntryIdentity {
  readonly dev: bigint;
  readonly ino: bigint;
  readonly uid: bigint;
  readonly mode: bigint;
  readonly nlink: bigint;
  readonly size: bigint;
  readonly mtimeNs: bigint;
  readonly ctimeNs: bigint;
}

export interface RuntimeManifestBudget {
  entries: number;
  discoveredEntries: number;
  totalBytes: number;
  pathBytes: number;
  digestBytes: number;
}

/** @throws {RuntimeManifestError} Always; the entry violates manifest safety policy. */
function entryIoFailure(reason: ConstructorParameters<typeof RuntimeManifestError>[0]): never {
  throw new RuntimeManifestError(reason);
}

function currentUid(): bigint | undefined {
  return typeof process.getuid === 'function' ? BigInt(process.getuid()) : undefined;
}

export function runtimeManifestEntryIdentity(stat: BigIntStats): RuntimeManifestEntryIdentity {
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

export function sameRuntimeManifestEntryIdentity(
  left: RuntimeManifestEntryIdentity,
  right: RuntimeManifestEntryIdentity,
): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.uid === right.uid &&
    left.mode === right.mode &&
    left.nlink === right.nlink &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  );
}

export function safeRuntimeManifestMode(stat: BigIntStats): number {
  const uid = currentUid();
  if (uid !== undefined && stat.uid !== uid) entryIoFailure('unsafe-owner');
  const mode = Number(stat.mode & 0o7777n);
  if (stat.isSymbolicLink()) return mode & 0o777;
  if (
    !Number.isSafeInteger(mode) ||
    (process.platform !== 'win32' &&
      ((mode & 0o7000) !== 0 ||
        (mode & 0o022) !== 0 ||
        (stat.isDirectory() && (mode & 0o700) !== 0o700) ||
        (stat.isFile() && (mode & 0o400) === 0)))
  ) {
    entryIoFailure('mode');
  }
  return mode & 0o777;
}

function chargeFileBudget(expected: BigIntStats, budget: RuntimeManifestBudget): number {
  if (expected.nlink !== 1n) entryIoFailure('hardlink');
  if (expected.size > BigInt(RUNTIME_MANIFEST_MAX_FILE_BYTES)) entryIoFailure('size-cap');
  const sizeBytes = Number(expected.size);
  if (!Number.isSafeInteger(sizeBytes) || sizeBytes < 0) entryIoFailure('size-cap');
  budget.totalBytes += sizeBytes;
  budget.digestBytes += sizeBytes;
  if (budget.totalBytes > RUNTIME_MANIFEST_MAX_TOTAL_BYTES) entryIoFailure('size-cap');
  if (budget.digestBytes > RUNTIME_MANIFEST_MAX_DIGEST_BYTES) entryIoFailure('digest-cap');
  return sizeBytes;
}

function hashOpenedFile(descriptor: number, expected: BigIntStats, sizeBytes: number): string {
  const opened = fstatSync(descriptor, { bigint: true });
  if (
    !opened.isFile() ||
    opened.nlink !== 1n ||
    !sameRuntimeManifestEntryIdentity(
      runtimeManifestEntryIdentity(expected),
      runtimeManifestEntryIdentity(opened),
    )
  ) {
    entryIoFailure('changed');
  }
  const digest = createHash('sha256');
  const chunk = Buffer.allocUnsafe(READ_CHUNK_BYTES);
  let observed = 0;
  for (;;) {
    const bytesRead = readSync(descriptor, chunk, 0, chunk.length, null);
    if (bytesRead === 0) break;
    observed += bytesRead;
    digest.update(chunk.subarray(0, bytesRead));
  }
  const after = fstatSync(descriptor, { bigint: true });
  if (
    observed !== sizeBytes ||
    !sameRuntimeManifestEntryIdentity(
      runtimeManifestEntryIdentity(opened),
      runtimeManifestEntryIdentity(after),
    )
  ) {
    entryIoFailure('changed');
  }
  return digest.digest('hex');
}

export function readStableRuntimeManifestFile(
  path: string,
  expected: BigIntStats,
  budget: RuntimeManifestBudget,
): {
  readonly sizeBytes: number;
  readonly sha256: string;
} {
  const sizeBytes = chargeFileBudget(expected, budget);
  let descriptor: number | undefined;
  try {
    descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    return {
      sizeBytes,
      sha256: hashOpenedFile(descriptor, expected, sizeBytes),
    };
  } catch (error) {
    if (error instanceof RuntimeManifestError) throw error;
    if (hasErrorCode(error, 'ELOOP')) entryIoFailure('special-entry');
    throw error;
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

export function readSafeRuntimeManifestSymlink(
  root: string,
  path: string,
  expected: BigIntStats,
): string {
  const target = readlinkSync(path);
  if (target.length === 0 || target.includes('\0') || isAbsolute(target)) {
    entryIoFailure('symlink-invalid');
  }
  const targetPath = resolve(join(path, '..'), target);
  if (!isPathContained(root, targetPath)) entryIoFailure('symlink-escape');
  let canonicalTarget: string;
  try {
    canonicalTarget = realpathSync(targetPath);
  } catch {
    entryIoFailure('symlink-invalid');
  }
  if (!isPathContained(root, canonicalTarget)) entryIoFailure('symlink-escape');
  const after = lstatSync(path, { bigint: true });
  if (
    !after.isSymbolicLink() ||
    !sameRuntimeManifestEntryIdentity(
      runtimeManifestEntryIdentity(expected),
      runtimeManifestEntryIdentity(after),
    )
  ) {
    entryIoFailure('changed');
  }
  return target;
}
