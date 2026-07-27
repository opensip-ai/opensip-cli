/**
 * @fileoverview Filesystem/marker leaf helpers for user-level uninstall.
 *
 * Split out of user-removal.ts (file-length-limit soft cap): the primitives
 * with no dependency on the receipt-transaction state machine — safe
 * existence checks, exclusive-marker publish/verify, and owned-tombstone
 * deletion. Shared by user-removal.ts (orchestration) and
 * user-removal-transaction.ts (the receipt-transaction state machine).
 */

import {
  existsSync,
  linkSync,
  lstatSync,
  readFileSync,
  readdirSync,
  rmSync,
  rmdirSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { join, sep } from 'node:path';

import { SystemError } from '@opensip-cli/core';

import { hostErrorCatalog } from '../../errors/host-error-catalog.js';

import { digestMarkerContent, USER_UNINSTALL_MARKER_BASENAME } from './user-uninstall-receipt.js';

const USER_RECOVERY_UNSAFE = hostErrorCatalog.require('CLI.UNINSTALL.USER_RECOVERY_UNSAFE');

/**
 * The single classification point for every fail-closed refusal in the user-uninstall recovery
 * path — roughly two dozen conditions across this file, `user-removal-transaction.ts` and
 * `user-removal.ts`.
 *
 * It threw a bare `Error`, which normalizes to `SYSTEM_ERROR` with `exposure: 'redacted'`, so
 * every one of those messages reached the user as "The operation failed." — on a command that
 * had just stopped partway through deleting their OpenSIP state. The messages are specific and
 * actionable ("the final operation marker path is occupied by a foreign entry"); the projection
 * was throwing them away.
 *
 * `condition` is optional and exists for callers whose consumers need to BRANCH. Most do not:
 * the message carries the detail, and inventing two dozen labels nobody switches on would be
 * ceremony, not machine semantics.
 *
 * @throws {SystemError} Always (`CLI.UNINSTALL.USER_RECOVERY_UNSAFE`) — a resume precondition
 *   the recovery path cannot satisfy safely.
 */
export function recoveryFailure(message: string, condition?: string): never {
  throw new SystemError(`Cannot recover user uninstall safely: ${message}`, {
    code: USER_RECOVERY_UNSAFE.code,
    definition: USER_RECOVERY_UNSAFE,
    ...(condition === undefined ? {} : { metadata: { condition } }),
  });
}

export function safeDirectoryExists(path: string): boolean {
  let stat: ReturnType<typeof lstatSync>;
  try {
    stat = lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    recoveryFailure(`expected an owned directory at ${path}`);
  }
  return true;
}

function regularFileMatches(path: string, expectedDigest: string): boolean {
  try {
    const st = lstatSync(path);
    if (st.isSymbolicLink() || !st.isFile()) return false;
    const body = readFileSync(path);
    return digestMarkerContent(body) === expectedDigest;
  } catch {
    return false;
  }
}

export function markerMatches(root: string, expectedDigest: string): boolean {
  return regularFileMatches(join(root, USER_UNINSTALL_MARKER_BASENAME), expectedDigest);
}

function markerTempPath(userRoot: string, operationId: string): string {
  return join(userRoot, `${USER_UNINSTALL_MARKER_BASENAME}.tmp-${operationId}`);
}

export function publishExclusiveMarker(
  userRoot: string,
  operationId: string,
  content: Buffer,
): void {
  const markerPath = join(userRoot, USER_UNINSTALL_MARKER_BASENAME);
  const tempPath = markerTempPath(userRoot, operationId);
  const expectedDigest = digestMarkerContent(content);

  if (existsSync(tempPath) && !regularFileMatches(tempPath, expectedDigest)) {
    const tempStat = lstatSync(tempPath);
    if (tempStat.isSymbolicLink() || !tempStat.isFile()) {
      recoveryFailure('the operation marker temporary path is not a regular file');
    }
    unlinkSync(tempPath);
  }
  if (!existsSync(tempPath)) {
    // A failed/partial write remains operation-bound at the temporary path and
    // is safely replaced on retry; the final marker is published atomically.
    writeFileSync(tempPath, content, { flag: 'wx', mode: 0o600 });
  }
  if (!regularFileMatches(tempPath, expectedDigest)) {
    recoveryFailure('the operation marker temporary file could not be verified');
  }

  try {
    linkSync(tempPath, markerPath);
  } catch (error) {
    if (
      (error as NodeJS.ErrnoException).code !== 'EEXIST' ||
      !markerMatches(userRoot, expectedDigest)
    ) {
      recoveryFailure('the final operation marker path is occupied by a foreign entry');
    }
  }
  if (!markerMatches(userRoot, expectedDigest)) {
    recoveryFailure('the published operation marker could not be verified');
  }
  unlinkSync(tempPath);
}

/**
 * Content sha256 of a JSON receipt string (for replace/unlink CAS).
 * Prefer digest of the exact bytes we wrote via serializeReceipt.
 */
export function contentSha256(content: string): string {
  return digestMarkerContent(content);
}

type TombstoneEntryName = string | Buffer;
type TombstoneEntryPath = string | Buffer;

interface TombstoneRemovalOperations {
  readonly listEntries: (path: string) => readonly TombstoneEntryName[];
  readonly removeEntry: (path: TombstoneEntryPath) => void;
  readonly unlinkMarker: (path: string) => void;
  readonly removeDirectory: (path: string) => void;
}

const DEFAULT_TOMBSTONE_REMOVAL_OPERATIONS: TombstoneRemovalOperations = {
  listEntries: (path) => readdirSync(path, { encoding: 'buffer' }),
  removeEntry: (path) => rmSync(path, { recursive: true, force: true }),
  unlinkMarker: (path) => unlinkSync(path),
  removeDirectory: (path) => rmdirSync(path),
};
const USER_UNINSTALL_MARKER_BASENAME_BYTES = Buffer.from(USER_UNINSTALL_MARKER_BASENAME);

function isTombstoneMarkerEntry(entry: TombstoneEntryName | undefined): boolean {
  return typeof entry === 'string'
    ? entry === USER_UNINSTALL_MARKER_BASENAME
    : entry?.equals(USER_UNINSTALL_MARKER_BASENAME_BYTES) === true;
}

function tombstoneEntryPath(tombstonePath: string, entry: TombstoneEntryName): TombstoneEntryPath {
  return typeof entry === 'string'
    ? join(tombstonePath, entry)
    : Buffer.concat([Buffer.from(tombstonePath), Buffer.from(sep), entry]);
}

/**
 * Delete a verified tombstone while preserving its ownership marker until every
 * other entry is gone. If the process stops after unlinking the marker but
 * before removing the root, recovery may remove only that empty directory.
 */
export function removeOwnedTombstone(
  tombstonePath: string,
  expectedMarkerDigest: string,
  operations: TombstoneRemovalOperations = DEFAULT_TOMBSTONE_REMOVAL_OPERATIONS,
): void {
  const markerPath = join(tombstonePath, USER_UNINSTALL_MARKER_BASENAME);

  if (!markerMatches(tombstonePath, expectedMarkerDigest)) {
    if (operations.listEntries(tombstonePath).length > 0) {
      recoveryFailure('the markerless recovery tombstone is not empty');
    }
    operations.removeDirectory(tombstonePath);
    return;
  }

  for (const entry of operations.listEntries(tombstonePath)) {
    if (!isTombstoneMarkerEntry(entry)) {
      operations.removeEntry(tombstoneEntryPath(tombstonePath, entry));
    }
  }

  const remaining = operations.listEntries(tombstonePath);
  if (
    remaining.length !== 1 ||
    !isTombstoneMarkerEntry(remaining[0]) ||
    !markerMatches(tombstonePath, expectedMarkerDigest)
  ) {
    recoveryFailure('the recovery tombstone changed during deletion');
  }

  operations.unlinkMarker(markerPath);
  operations.removeDirectory(tombstonePath);
}
