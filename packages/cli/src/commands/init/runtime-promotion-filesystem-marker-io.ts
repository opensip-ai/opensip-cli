import { createHash } from 'node:crypto';
import {
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  openSync,
  readSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import { dirname } from 'node:path';

import {
  assertPromotionPathIdentity,
  assertPromotionCurrentOwner,
  assertStablePromotionDirectory,
  capturePromotionPathIdentity,
  classifyRuntimePromotionPath,
  fsyncPromotionDirectory,
  promotionFilesystemCheckpoint,
  promotionIdentityOf,
  runtimePromotionFilesystemFailure,
  samePromotionEntryIdentity,
  withPromotionMutation,
} from './runtime-promotion-filesystem-io.js';
import {
  RUNTIME_PROMOTION_ARTIFACT_MARKER_MAX_BYTES,
  RUNTIME_PROMOTION_ARTIFACT_MARKER_MODE,
} from './runtime-promotion-filesystem-marker.js';

import type { StablePromotionDirectory } from './runtime-promotion-filesystem-io.js';
import type {
  RuntimePromotionFilesystemDependencies,
  RuntimePromotionFilesystemMutation,
} from './runtime-promotion-filesystem-types.js';

const READ_CHUNK_BYTES = 64 * 1024;
const OPERATION_MARKER_DESCRIPTION = 'an operation marker';

export type ExactMarkerInspection =
  | { readonly status: 'absent' }
  | { readonly status: 'exact' }
  | { readonly status: 'partial-prefix' }
  | { readonly status: 'mismatch' };

function readStableBoundedFile(path: string, maxBytes: number): Buffer {
  const before = lstatSync(path, { bigint: true });
  assertPromotionCurrentOwner(before, OPERATION_MARKER_DESCRIPTION);
  if (
    !before.isFile() ||
    before.isSymbolicLink() ||
    before.nlink !== 1n ||
    before.size > BigInt(maxBytes) ||
    (process.platform !== 'win32' &&
      Number(before.mode & 0o7777n) !== RUNTIME_PROMOTION_ARTIFACT_MARKER_MODE)
  ) {
    runtimePromotionFilesystemFailure('an operation marker has an unsafe identity');
  }
  const size = Number(before.size);
  let descriptor: number | undefined;
  try {
    descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const opened = fstatSync(descriptor, { bigint: true });
    if (!samePromotionEntryIdentity(promotionIdentityOf(before), promotionIdentityOf(opened))) {
      runtimePromotionFilesystemFailure('an operation marker changed before read');
    }
    const bytes = Buffer.alloc(size);
    let offset = 0;
    while (offset < size) {
      const read = readSync(descriptor, bytes, offset, size - offset, null);
      if (read < 1) runtimePromotionFilesystemFailure('an operation marker read was truncated');
      offset += read;
    }
    const after = fstatSync(descriptor, { bigint: true });
    const pathAfter = lstatSync(path, { bigint: true });
    if (
      !samePromotionEntryIdentity(promotionIdentityOf(opened), promotionIdentityOf(after)) ||
      !samePromotionEntryIdentity(promotionIdentityOf(after), promotionIdentityOf(pathAfter))
    ) {
      runtimePromotionFilesystemFailure('an operation marker changed during read');
    }
    return bytes;
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

export function readStablePromotionMarkerContent(markerPath: string): string {
  return readStableBoundedFile(markerPath, RUNTIME_PROMOTION_ARTIFACT_MARKER_MAX_BYTES).toString(
    'utf8',
  );
}

/** Stable no-follow digest for a journal-bound cache marker. */
export function digestStablePromotionFile(path: string, maxBytes: number): string {
  const before = lstatSync(path, { bigint: true });
  assertPromotionCurrentOwner(before, 'a journal-bound marker');
  const mode = Number(before.mode & 0o7777n);
  if (
    !before.isFile() ||
    before.isSymbolicLink() ||
    before.nlink !== 1n ||
    before.size > BigInt(maxBytes) ||
    (process.platform !== 'win32' && ((mode & 0o7000) !== 0 || (mode & 0o022) !== 0))
  ) {
    runtimePromotionFilesystemFailure('a journal-bound marker has an unsafe identity');
  }
  let descriptor: number | undefined;
  const digest = createHash('sha256');
  try {
    descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const opened = fstatSync(descriptor, { bigint: true });
    if (!samePromotionEntryIdentity(promotionIdentityOf(before), promotionIdentityOf(opened))) {
      runtimePromotionFilesystemFailure('a journal-bound marker changed before read');
    }
    const buffer = Buffer.allocUnsafe(READ_CHUNK_BYTES);
    for (;;) {
      const count = readSync(descriptor, buffer, 0, buffer.length, null);
      if (count === 0) break;
      digest.update(buffer.subarray(0, count));
    }
    const after = fstatSync(descriptor, { bigint: true });
    const pathAfter = lstatSync(path, { bigint: true });
    if (
      !samePromotionEntryIdentity(promotionIdentityOf(opened), promotionIdentityOf(after)) ||
      !samePromotionEntryIdentity(promotionIdentityOf(after), promotionIdentityOf(pathAfter))
    ) {
      runtimePromotionFilesystemFailure('a journal-bound marker changed during read');
    }
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
  return digest.digest('hex');
}

export function inspectExactPromotionMarker(
  markerPath: string,
  expectedContent: string,
): ExactMarkerInspection {
  const classification = classifyRuntimePromotionPath(markerPath);
  if (classification.status === 'absent') return { status: 'absent' };
  if (
    classification.status !== 'file' ||
    classification.mode !== RUNTIME_PROMOTION_ARTIFACT_MARKER_MODE ||
    classification.links !== 1 ||
    classification.owner !== 'current'
  ) {
    return { status: 'mismatch' };
  }
  const bytes = readStableBoundedFile(
    markerPath,
    Math.max(RUNTIME_PROMOTION_ARTIFACT_MARKER_MAX_BYTES, Buffer.byteLength(expectedContent)),
  );
  const expected = Buffer.from(expectedContent, 'utf8');
  if (bytes.equals(expected)) return { status: 'exact' };
  if (bytes.length < expected.length && expected.subarray(0, bytes.length).equals(bytes)) {
    return { status: 'partial-prefix' };
  }
  return { status: 'mismatch' };
}

function writeAll(
  descriptor: number,
  bytes: Buffer,
  start: number,
  end: number,
  dependencies: RuntimePromotionFilesystemDependencies,
  operation: RuntimePromotionFilesystemMutation,
): void {
  let offset = start;
  while (offset < end) {
    const written = withPromotionMutation(dependencies, operation, () =>
      writeSync(descriptor, bytes, offset, end - offset),
    );
    if (written < 1) runtimePromotionFilesystemFailure('an operation marker write stalled');
    offset += written;
  }
}

export function publishPromotionMarker(
  parent: StablePromotionDirectory,
  markerPath: string,
  content: string,
  dependencies: RuntimePromotionFilesystemDependencies,
  operation: RuntimePromotionFilesystemMutation,
  revalidateBeforeCreate?: () => void,
): void {
  assertStablePromotionDirectory(parent, 'an operation marker parent');
  if (dirname(markerPath) !== parent.path) {
    runtimePromotionFilesystemFailure('an operation marker is not a direct child of its parent');
  }
  const bytes = Buffer.from(content, 'utf8');
  if (bytes.length > RUNTIME_PROMOTION_ARTIFACT_MARKER_MAX_BYTES) {
    runtimePromotionFilesystemFailure('an operation marker exceeds its byte cap');
  }
  let descriptor: number | undefined;
  try {
    descriptor = withPromotionMutation(dependencies, operation, () => {
      assertStablePromotionDirectory(parent, 'an operation marker parent');
      if (classifyRuntimePromotionPath(markerPath).status !== 'absent') {
        runtimePromotionFilesystemFailure('an operation marker path is no longer absent');
      }
      revalidateBeforeCreate?.();
      return openSync(
        markerPath,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
        RUNTIME_PROMOTION_ARTIFACT_MARKER_MODE,
      );
    });
    const split = bytes.length === 0 ? 0 : Math.max(1, Math.floor(bytes.length / 2));
    writeAll(descriptor, bytes, 0, split, dependencies, operation);
    writeAll(descriptor, bytes, split, bytes.length, dependencies, operation);
    withPromotionMutation(dependencies, operation, () =>
      fchmodSync(descriptor!, RUNTIME_PROMOTION_ARTIFACT_MARKER_MODE),
    );
    promotionFilesystemCheckpoint(dependencies, 'before', 'fsync', 'file');
    fsyncSync(descriptor);
    promotionFilesystemCheckpoint(dependencies, 'after', 'fsync', 'file');
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
  fsyncPromotionDirectory(parent, dependencies);
  if (inspectExactPromotionMarker(markerPath, content).status !== 'exact') {
    runtimePromotionFilesystemFailure('an operation marker was not durably published');
  }
}

/**
 * Turn exact bytes observed after a prior crash into a fresh durability
 * barrier before the marker authorizes any destructive continuation.
 */
export function ensureDurableExactPromotionMarker(
  parent: StablePromotionDirectory,
  markerPath: string,
  expectedContent: string,
  dependencies: RuntimePromotionFilesystemDependencies,
): void {
  if (inspectExactPromotionMarker(markerPath, expectedContent).status !== 'exact') {
    runtimePromotionFilesystemFailure('an operation marker is not exact');
  }
  const identity = capturePromotionPathIdentity(markerPath, OPERATION_MARKER_DESCRIPTION);
  let descriptor: number | undefined;
  try {
    descriptor = openSync(markerPath, constants.O_RDONLY | constants.O_NOFOLLOW);
    const opened = promotionIdentityOf(fstatSync(descriptor, { bigint: true }));
    if (!samePromotionEntryIdentity(identity, opened)) {
      runtimePromotionFilesystemFailure('an operation marker changed before durability sync');
    }
    promotionFilesystemCheckpoint(dependencies, 'before', 'fsync', 'file');
    fsyncSync(descriptor);
    promotionFilesystemCheckpoint(dependencies, 'after', 'fsync', 'file');
    const after = promotionIdentityOf(fstatSync(descriptor, { bigint: true }));
    if (!samePromotionEntryIdentity(opened, after)) {
      runtimePromotionFilesystemFailure('an operation marker changed during durability sync');
    }
    assertPromotionPathIdentity(markerPath, after, OPERATION_MARKER_DESCRIPTION);
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
  fsyncPromotionDirectory(parent, dependencies);
  if (inspectExactPromotionMarker(markerPath, expectedContent).status !== 'exact') {
    runtimePromotionFilesystemFailure('an operation marker changed after durability sync');
  }
}

export function removeExactPromotionMarker(
  parent: StablePromotionDirectory,
  markerPath: string,
  expectedContent: string,
  dependencies: RuntimePromotionFilesystemDependencies,
  operation: RuntimePromotionFilesystemMutation = 'owned-marker-unlink',
): boolean {
  const inspection = inspectExactPromotionMarker(markerPath, expectedContent);
  if (inspection.status === 'absent') {
    fsyncPromotionDirectory(parent, dependencies);
    return false;
  }
  if (inspection.status !== 'exact') {
    runtimePromotionFilesystemFailure('an operation marker does not match its journal identity');
  }
  ensureDurableExactPromotionMarker(parent, markerPath, expectedContent, dependencies);
  const markerIdentity = capturePromotionPathIdentity(markerPath, OPERATION_MARKER_DESCRIPTION);
  withPromotionMutation(dependencies, operation, () => {
    assertStablePromotionDirectory(parent, 'an operation marker parent');
    assertPromotionPathIdentity(markerPath, markerIdentity, OPERATION_MARKER_DESCRIPTION);
    if (inspectExactPromotionMarker(markerPath, expectedContent).status !== 'exact') {
      runtimePromotionFilesystemFailure('an operation marker changed before unlink');
    }
    assertPromotionPathIdentity(markerPath, markerIdentity, OPERATION_MARKER_DESCRIPTION);
    unlinkSync(markerPath);
  });
  fsyncPromotionDirectory(parent, dependencies);
  return true;
}

export function removePartialPromotionMarker(
  parent: StablePromotionDirectory,
  markerPath: string,
  expectedContent: string,
  dependencies: RuntimePromotionFilesystemDependencies,
): void {
  if (inspectExactPromotionMarker(markerPath, expectedContent).status !== 'partial-prefix') {
    runtimePromotionFilesystemFailure('only an exact partial operation marker may be discarded');
  }
  const markerIdentity = capturePromotionPathIdentity(markerPath, 'a partial operation marker');
  withPromotionMutation(dependencies, 'owned-marker-unlink', () => {
    assertStablePromotionDirectory(parent, 'an operation marker parent');
    assertPromotionPathIdentity(markerPath, markerIdentity, 'a partial operation marker');
    if (inspectExactPromotionMarker(markerPath, expectedContent).status !== 'partial-prefix') {
      runtimePromotionFilesystemFailure('a partial operation marker changed before unlink');
    }
    assertPromotionPathIdentity(markerPath, markerIdentity, 'a partial operation marker');
    unlinkSync(markerPath);
  });
  fsyncPromotionDirectory(parent, dependencies);
}
