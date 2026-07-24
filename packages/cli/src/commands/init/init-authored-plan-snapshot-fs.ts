import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  readdirSync,
} from 'node:fs';

import { MAX_AGENT_GUIDANCE_FILE_BYTES } from './agent-guidance-renderer.js';
import { isSafeAuthoredPathMode, normalizeAuthoredPathMode } from './authored-path-mode.js';
import {
  INIT_AUTHORED_OPAQUE_DIRECTORY_NAMES,
  INIT_AUTHORED_PLAN_CAPS,
  authoredPlanFailure,
  compareUtf8,
  directoryDigest,
  sha256Bytes,
} from './init-authored-plan-types.js';
import { isWindowsDirectoryHandleFallback } from './runtime-directory-handle-fallback.js';

import type {
  InitAuthoredSnapshotHooks,
  InitAuthoredSnapshotRecord,
} from './init-authored-plan-types.js';
import type { BigIntStats } from 'node:fs';

export interface SnapshotBudget {
  entries: number;
  bytes: number;
}

function statMode(stat: BigIntStats, type: 'file' | 'directory'): number {
  return normalizeAuthoredPathMode(stat.mode, type);
}

export function sameSnapshotStat(left: BigIntStats, right: BigIntStats): boolean {
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

function safeOwner(stat: BigIntStats): boolean {
  const getuid = process.getuid;
  return getuid === undefined || stat.uid === BigInt(getuid.call(process));
}

export function validateSafeSnapshotStat(
  stat: BigIntStats,
  expected: 'file' | 'directory',
  path: string,
): void {
  const correctType = expected === 'file' ? stat.isFile() : stat.isDirectory();
  if (!correctType) authoredPlanFailure(`${path} is not a ${expected}`);
  if (!safeOwner(stat)) authoredPlanFailure(`${path} is not owned by the current user`);
  if (!isSafeAuthoredPathMode(stat.mode)) {
    authoredPlanFailure(
      `${path} is world writable (or carries setuid/setgid/sticky bits) — run 'chmod o-w' on it`,
    );
  }
  if (expected === 'file' && stat.nlink !== 1n) {
    authoredPlanFailure(`${path} is hard-linked`);
  }
}

export interface InitAuthoredSnapshotOpenDependencies {
  readonly platform?: NodeJS.Platform;
  readonly open?: (path: string, flags: number) => number;
}

export function openInitAuthoredSnapshotPath(
  path: string,
  directory: boolean,
  dependencies: InitAuthoredSnapshotOpenDependencies = {},
): number | undefined {
  const flags = constants.O_RDONLY | constants.O_NOFOLLOW | (directory ? constants.O_DIRECTORY : 0);
  try {
    return (dependencies.open ?? openSync)(path, flags);
  } catch (error) {
    if (
      directory &&
      isWindowsDirectoryHandleFallback(error, dependencies.platform ?? process.platform)
    ) {
      return undefined;
    }
    authoredPlanFailure(`could not safely open ${path}`);
  }
}

export function stableSnapshotDirectoryNames(
  absolutePath: string,
  relativePath: string,
  hooks: InitAuthoredSnapshotHooks | undefined,
): readonly string[] {
  let before: BigIntStats;
  try {
    before = lstatSync(absolutePath, { bigint: true });
  } catch {
    authoredPlanFailure(`could not inspect ${relativePath}`);
  }
  validateSafeSnapshotStat(before, 'directory', relativePath);
  const descriptor = openInitAuthoredSnapshotPath(absolutePath, true);
  if (descriptor !== undefined) {
    try {
      const opened = fstatSync(descriptor, { bigint: true });
      if (!sameSnapshotStat(before, opened)) {
        authoredPlanFailure(`${relativePath} changed before listing`);
      }
    } finally {
      closeSync(descriptor);
    }
  }
  let names: string[];
  try {
    names = readdirSync(absolutePath);
  } catch {
    authoredPlanFailure(`could not read directory ${relativePath}`);
  }
  hooks?.afterDirectoryRead?.(relativePath);
  let after: BigIntStats;
  try {
    after = lstatSync(absolutePath, { bigint: true });
  } catch {
    authoredPlanFailure(`${relativePath} disappeared while planning`);
  }
  if (!sameSnapshotStat(before, after)) {
    authoredPlanFailure(`${relativePath} changed while planning`);
  }
  return names.sort(compareUtf8);
}

function addBudgetEntry(budget: SnapshotBudget): void {
  budget.entries += 1;
  if (budget.entries > INIT_AUTHORED_PLAN_CAPS.maxTraversalEntries) {
    authoredPlanFailure(
      `snapshot traversal exceeds ${String(INIT_AUTHORED_PLAN_CAPS.maxTraversalEntries)} entries`,
    );
  }
}

function readStableFile(
  absolutePath: string,
  relativePath: string,
  budget: SnapshotBudget,
  hooks: InitAuthoredSnapshotHooks | undefined,
): InitAuthoredSnapshotRecord {
  let before: BigIntStats;
  try {
    before = lstatSync(absolutePath, { bigint: true });
  } catch {
    authoredPlanFailure(`could not inspect ${relativePath}`);
  }
  validateSafeSnapshotStat(before, 'file', relativePath);
  const size = Number(before.size);
  if (!Number.isSafeInteger(size) || size > INIT_AUTHORED_PLAN_CAPS.maxFileBytes) {
    authoredPlanFailure(
      `${relativePath} exceeds ${String(INIT_AUTHORED_PLAN_CAPS.maxFileBytes)} bytes`,
    );
  }
  budget.bytes += size;
  if (budget.bytes > INIT_AUTHORED_PLAN_CAPS.maxAggregateBlobBytes) {
    authoredPlanFailure(
      `snapshot content exceeds ${String(INIT_AUTHORED_PLAN_CAPS.maxAggregateBlobBytes)} bytes`,
    );
  }
  const descriptor = openInitAuthoredSnapshotPath(absolutePath, false);
  if (descriptor === undefined) authoredPlanFailure(`could not safely open ${relativePath}`);
  let bytes: Buffer;
  try {
    const opened = fstatSync(descriptor, { bigint: true });
    if (!sameSnapshotStat(before, opened)) {
      authoredPlanFailure(`${relativePath} changed before reading`);
    }
    bytes = Buffer.alloc(size);
    let offset = 0;
    while (offset < size) {
      const count = readSync(descriptor, bytes, offset, size - offset, null);
      if (count === 0) authoredPlanFailure(`${relativePath} changed while reading`);
      offset += count;
    }
    hooks?.afterFileRead?.(relativePath);
    const afterRead = fstatSync(descriptor, { bigint: true });
    if (!sameSnapshotStat(before, afterRead)) {
      authoredPlanFailure(`${relativePath} changed while reading`);
    }
  } finally {
    closeSync(descriptor);
  }
  let after: BigIntStats;
  try {
    after = lstatSync(absolutePath, { bigint: true });
  } catch {
    authoredPlanFailure(`${relativePath} disappeared while planning`);
  }
  if (!sameSnapshotStat(before, after))
    authoredPlanFailure(`${relativePath} changed while planning`);
  return {
    path: relativePath,
    exists: true,
    type: 'file',
    mode: statMode(before, 'file'),
    digest: sha256Bytes(bytes),
    contentBase64: bytes.toString('base64'),
  };
}

function directoryRecord(path: string, stat: BigIntStats): InitAuthoredSnapshotRecord {
  const mode = statMode(stat, 'directory');
  return {
    path,
    exists: true,
    type: 'directory',
    mode,
    digest: directoryDigest(mode),
    contentBase64: null,
  };
}

function revalidateDirectory(
  absolutePath: string,
  relativePath: string,
  before: BigIntStats,
): void {
  const descriptor = openInitAuthoredSnapshotPath(absolutePath, true);
  if (descriptor !== undefined) {
    try {
      const opened = fstatSync(descriptor, { bigint: true });
      if (!sameSnapshotStat(before, opened)) {
        authoredPlanFailure(`${relativePath} changed while opening`);
      }
    } finally {
      closeSync(descriptor);
    }
  }
  let after: BigIntStats;
  try {
    after = lstatSync(absolutePath, { bigint: true });
  } catch {
    authoredPlanFailure(`${relativePath} disappeared while planning`);
  }
  if (!sameSnapshotStat(before, after))
    authoredPlanFailure(`${relativePath} changed while planning`);
}

/** The present-but-unmanaged record for a tolerated guidance target. */
function unmanagedRecord(
  relativePath: string,
  reason: 'symlink' | 'oversize',
): InitAuthoredSnapshotRecord {
  return {
    path: relativePath,
    exists: true,
    type: 'unmanaged',
    mode: null,
    digest: null,
    contentBase64: null,
    unmanagedReason: reason,
  };
}

export function inspectExistingSnapshotPath(
  absolutePath: string,
  relativePath: string,
  budget: SnapshotBudget,
  hooks: InitAuthoredSnapshotHooks | undefined,
  tolerantGuidancePaths: ReadonlySet<string> = new Set(),
): InitAuthoredSnapshotRecord {
  let stat: BigIntStats;
  try {
    stat = lstatSync(absolutePath, { bigint: true });
  } catch {
    authoredPlanFailure(`could not inspect ${relativePath}`);
  }
  addBudgetEntry(budget);
  const tolerant = tolerantGuidancePaths.has(relativePath);
  if (stat.isSymbolicLink()) {
    // A symlinked guidance file (CLAUDE.md → dotfiles repo, etc.) is a normal
    // setup: init must never write THROUGH the link, so the target becomes
    // present-but-unmanaged instead of failing the whole init.
    if (tolerant) return unmanagedRecord(relativePath, 'symlink');
    authoredPlanFailure(`${relativePath} is a symbolic link`);
  }
  if (stat.isFile()) {
    if (tolerant && stat.size > BigInt(MAX_AGENT_GUIDANCE_FILE_BYTES)) {
      // Beyond the managed guidance cap: leave the customer's file alone
      // (no read, no budget charge) rather than refusing init.
      return unmanagedRecord(relativePath, 'oversize');
    }
    return readStableFile(absolutePath, relativePath, budget, hooks);
  }
  if (!stat.isDirectory()) authoredPlanFailure(`${relativePath} has an unsupported file type`);
  validateSafeSnapshotStat(stat, 'directory', relativePath);
  revalidateDirectory(absolutePath, relativePath, stat);
  return directoryRecord(relativePath, stat);
}

export function isOpaqueGeneratedSnapshotEntry(
  absolutePath: string,
  relativePath: string,
  budget: SnapshotBudget,
): boolean {
  const name = relativePath.slice(relativePath.lastIndexOf('/') + 1);
  if (!(INIT_AUTHORED_OPAQUE_DIRECTORY_NAMES as readonly string[]).includes(name)) return false;
  let before: BigIntStats;
  try {
    before = lstatSync(absolutePath, { bigint: true });
  } catch {
    authoredPlanFailure(`could not inspect ${relativePath}`);
  }
  if (!before.isDirectory() && !before.isSymbolicLink()) return false;
  addBudgetEntry(budget);
  if (!safeOwner(before)) authoredPlanFailure(`${relativePath} is not owned by the current user`);
  if (before.isDirectory()) {
    validateSafeSnapshotStat(before, 'directory', relativePath);
    revalidateDirectory(absolutePath, relativePath, before);
    return true;
  }
  let after: BigIntStats;
  try {
    after = lstatSync(absolutePath, { bigint: true });
  } catch {
    authoredPlanFailure(`${relativePath} disappeared while planning`);
  }
  if (!sameSnapshotStat(before, after))
    authoredPlanFailure(`${relativePath} changed while planning`);
  return true;
}
