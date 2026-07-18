import {
  chmodSync,
  lstatSync,
  mkdirSync,
  renameSync,
  rmdirSync,
  unlinkSync,
} from "node:fs";
import { dirname } from "node:path";

import {
  assertSafeAuthoredAncestors,
  assertStableAuthoredRoot,
  authoredTransactionFailure,
  fsyncDirectory,
  readStableArtifactFile,
  resolveAuthoredTarget,
  type StableAuthoredRoot,
} from "./authored-state-transaction-fs.js";

function hasCode(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === code
  );
}

export function applyAuthoredFile(
  root: StableAuthoredRoot,
  relativePath: string,
  blobPath: string,
): void {
  assertSafeAuthoredAncestors(root, relativePath);
  readStableArtifactFile(blobPath);
  renameSync(blobPath, resolveAuthoredTarget(root, relativePath));
  fsyncDirectory(dirname(resolveAuthoredTarget(root, relativePath)));
  assertStableAuthoredRoot(root);
}

export function applyAuthoredDirectory(
  root: StableAuthoredRoot,
  relativePath: string,
  mode: number,
): void {
  assertSafeAuthoredAncestors(root, relativePath);
  const path = resolveAuthoredTarget(root, relativePath);
  try {
    mkdirSync(path, { recursive: false, mode });
  } catch (error) {
    if (!hasCode(error, "EEXIST")) throw error;
  }
  const stat = lstatSync(path, { bigint: true });
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    authoredTransactionFailure("a directory target has the wrong type");
  }
  chmodSync(path, mode);
  fsyncDirectory(path);
  fsyncDirectory(dirname(path));
  assertStableAuthoredRoot(root);
}

export function removeAuthoredTarget(
  root: StableAuthoredRoot,
  relativePath: string,
  type: "file" | "directory",
): void {
  assertSafeAuthoredAncestors(root, relativePath);
  const path = resolveAuthoredTarget(root, relativePath);
  if (type === "file") unlinkSync(path);
  else rmdirSync(path);
  fsyncDirectory(dirname(path));
  assertStableAuthoredRoot(root);
}
