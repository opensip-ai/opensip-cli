import { lstatSync } from 'node:fs';

import { normalizeAuthoredPathMode } from './authored-path-mode.js';
import {
  assertSafeAuthoredAncestors,
  assertSafeAuthoredOwnerMode,
  authoredTransactionFailure,
  readStableArtifactFile,
  resolveAuthoredTarget,
  type StableAuthoredRoot,
} from './authored-state-transaction-fs.js';
import { hasErrorCode } from './error-code.js';
import { directoryDigest } from './init-authored-plan-types.js';

import type { InitAuthoredPathState } from './init-authored-plan.js';
import type { BigIntStats } from 'node:fs';

export function observeAuthoredPath(
  root: StableAuthoredRoot,
  relativePath: string,
): InitAuthoredPathState {
  if (!assertSafeAuthoredAncestors(root, relativePath, true)) {
    return { exists: false, type: null, mode: null, digest: null };
  }
  const path = resolveAuthoredTarget(root, relativePath);
  let stat: BigIntStats;
  try {
    stat = lstatSync(path, { bigint: true });
  } catch (error) {
    if (hasErrorCode(error, 'ENOENT')) {
      return { exists: false, type: null, mode: null, digest: null };
    }
    authoredTransactionFailure('a target could not be inspected', error);
  }
  if (stat.isSymbolicLink()) authoredTransactionFailure('a target is a symbolic link');
  assertSafeAuthoredOwnerMode(stat, 'a target');
  const mode = normalizeAuthoredPathMode(stat.mode, stat.isDirectory() ? 'directory' : 'file');
  if (stat.isDirectory()) {
    return {
      exists: true,
      type: 'directory',
      mode,
      digest: directoryDigest(mode),
    };
  }
  if (!stat.isFile()) authoredTransactionFailure('a target has an unsupported type');
  const file = readStableArtifactFile(path);
  return { exists: true, type: 'file', mode, digest: file.digest };
}

export function sameAuthoredPathState(
  left: InitAuthoredPathState,
  right: InitAuthoredPathState,
): boolean {
  return (
    left.exists === right.exists &&
    left.type === right.type &&
    left.mode === right.mode &&
    left.digest === right.digest
  );
}
