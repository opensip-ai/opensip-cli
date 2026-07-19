import { lstatSync, rmdirSync, unlinkSync } from 'node:fs';

import {
  assertStableAuthoredEntry,
  assertStableAuthoredRoot,
  authoredTransactionFailure,
  fsyncStableAuthoredDirectory,
  fsyncStableAuthoredRoot,
  readStableArtifactFile,
  type StableAuthoredEntry,
  type StableAuthoredRoot,
} from './authored-state-transaction-fs.js';
import { hasErrorCode } from './error-code.js';

const INCOMPLETE_ROOT_DESCRIPTION = 'an incomplete authored root';
const INCOMPLETE_MARKER_DESCRIPTION = 'an incomplete authored owner marker';
const INCOMPLETE_BLOB_DIRECTORY_DESCRIPTION = 'an incomplete authored blob directory';
const INCOMPLETE_BLOB_DESCRIPTION = 'an incomplete authored blob';

export interface RecoverableFileAuthority {
  readonly entry: StableAuthoredEntry;
  readonly digest: string;
  readonly mode: number;
}

export interface RecoverableBlobRoot {
  readonly root: StableAuthoredEntry;
  readonly marker: 'absent' | 'partial' | 'exact';
  readonly markerEntry: RecoverableFileAuthority | null;
  readonly blobDirectory: StableAuthoredEntry | null;
  readonly blobs: readonly RecoverableFileAuthority[];
}

export function assertIncompletePathAbsent(path: string, description: string): void {
  try {
    lstatSync(path);
  } catch (error) {
    if (hasErrorCode(error, 'ENOENT')) return;
    throw error;
  }
  authoredTransactionFailure(`${description} was replaced during incomplete cleanup`);
}

function unlinkRecoverableFile(
  file: RecoverableFileAuthority,
  parent: StableAuthoredEntry,
  description: string,
): void {
  assertStableAuthoredEntry(parent, `${description} parent`);
  assertStableAuthoredEntry(file.entry, description);
  const observed = readStableArtifactFile(file.entry.path);
  assertStableAuthoredEntry(file.entry, description);
  if (observed.mode !== file.mode || observed.digest !== file.digest) {
    authoredTransactionFailure(`${description} changed after its cleanup authority was captured`);
  }
  unlinkSync(file.entry.path);
  assertStableAuthoredEntry(parent, `${description} parent`);
  assertIncompletePathAbsent(file.entry.path, description);
  fsyncStableAuthoredDirectory(parent, `${description} parent`);
}

export function removeIncompleteBlobRoot(
  projectRoot: StableAuthoredRoot,
  inspected: RecoverableBlobRoot,
): void {
  assertStableAuthoredRoot(projectRoot);
  assertStableAuthoredEntry(inspected.root, INCOMPLETE_ROOT_DESCRIPTION);
  if (inspected.blobDirectory !== null) {
    assertStableAuthoredEntry(inspected.blobDirectory, INCOMPLETE_BLOB_DIRECTORY_DESCRIPTION);
    for (const blob of inspected.blobs) {
      unlinkRecoverableFile(blob, inspected.blobDirectory, INCOMPLETE_BLOB_DESCRIPTION);
    }
    assertStableAuthoredEntry(inspected.root, INCOMPLETE_ROOT_DESCRIPTION);
    assertStableAuthoredEntry(inspected.blobDirectory, INCOMPLETE_BLOB_DIRECTORY_DESCRIPTION);
    rmdirSync(inspected.blobDirectory.path);
    assertIncompletePathAbsent(inspected.blobDirectory.path, INCOMPLETE_BLOB_DIRECTORY_DESCRIPTION);
    fsyncStableAuthoredDirectory(inspected.root, INCOMPLETE_ROOT_DESCRIPTION);
  }
  if (inspected.markerEntry !== null) {
    unlinkRecoverableFile(inspected.markerEntry, inspected.root, INCOMPLETE_MARKER_DESCRIPTION);
  }
  assertStableAuthoredRoot(projectRoot);
  assertStableAuthoredEntry(inspected.root, INCOMPLETE_ROOT_DESCRIPTION);
  rmdirSync(inspected.root.path);
  assertIncompletePathAbsent(inspected.root.path, INCOMPLETE_ROOT_DESCRIPTION);
  fsyncStableAuthoredRoot(projectRoot);
}
