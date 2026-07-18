import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  readdirSync,
  realpathSync,
} from 'node:fs';
import { join, resolve } from 'node:path';

import { isSafeAuthoredPathMode, normalizeAuthoredPathMode } from './authored-path-mode.js';
import {
  INIT_AUTHORED_OPAQUE_DIRECTORY_NAMES,
  INIT_AUTHORED_PLAN_CAPS,
  authoredPlanFailure,
  caseFoldPath,
  compareUtf8,
  directoryDigest,
  isRuntimeAuthoredPath,
  normalizeProjectRelativePath,
  sha256Bytes,
} from './init-authored-plan-types.js';
import { isWindowsDirectoryHandleFallback } from './runtime-directory-handle-fallback.js';

import type {
  InitAuthoredSnapshot,
  InitAuthoredSnapshotHooks,
  InitAuthoredSnapshotRecord,
  InitAuthoredWorkingDirState,
  ReadInitAuthoredSnapshotInput,
} from './init-authored-plan-types.js';
import type { BigIntStats } from 'node:fs';

interface SnapshotBudget {
  entries: number;
  bytes: number;
}

function statMode(stat: BigIntStats, type: 'file' | 'directory'): number {
  return normalizeAuthoredPathMode(stat.mode, type);
}

function sameStat(left: BigIntStats, right: BigIntStats): boolean {
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

function validateSafeStat(stat: BigIntStats, expected: 'file' | 'directory', path: string): void {
  const correctType = expected === 'file' ? stat.isFile() : stat.isDirectory();
  if (!correctType) authoredPlanFailure(`${path} is not a ${expected}`);
  if (!safeOwner(stat)) authoredPlanFailure(`${path} is not owned by the current user`);
  if (!isSafeAuthoredPathMode(stat.mode)) {
    authoredPlanFailure(`${path} is group/world writable`);
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

function stableDirectoryNames(
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
  validateSafeStat(before, 'directory', relativePath);
  const descriptor = openInitAuthoredSnapshotPath(absolutePath, true);
  if (descriptor !== undefined) {
    try {
      const opened = fstatSync(descriptor, { bigint: true });
      if (!sameStat(before, opened)) authoredPlanFailure(`${relativePath} changed before listing`);
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
  if (!sameStat(before, after)) authoredPlanFailure(`${relativePath} changed while planning`);
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
  validateSafeStat(before, 'file', relativePath);
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
    if (!sameStat(before, opened)) authoredPlanFailure(`${relativePath} changed before reading`);
    bytes = Buffer.alloc(size);
    let offset = 0;
    while (offset < size) {
      const count = readSync(descriptor, bytes, offset, size - offset, null);
      if (count === 0) authoredPlanFailure(`${relativePath} changed while reading`);
      offset += count;
    }
    hooks?.afterFileRead?.(relativePath);
    const afterRead = fstatSync(descriptor, { bigint: true });
    if (!sameStat(before, afterRead)) authoredPlanFailure(`${relativePath} changed while reading`);
  } finally {
    closeSync(descriptor);
  }
  let after: BigIntStats;
  try {
    after = lstatSync(absolutePath, { bigint: true });
  } catch {
    authoredPlanFailure(`${relativePath} disappeared while planning`);
  }
  if (!sameStat(before, after)) authoredPlanFailure(`${relativePath} changed while planning`);
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
      if (!sameStat(before, opened)) authoredPlanFailure(`${relativePath} changed while opening`);
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
  if (!sameStat(before, after)) authoredPlanFailure(`${relativePath} changed while planning`);
}

function inspectExistingPath(
  absolutePath: string,
  relativePath: string,
  budget: SnapshotBudget,
  hooks: InitAuthoredSnapshotHooks | undefined,
): InitAuthoredSnapshotRecord {
  let stat: BigIntStats;
  try {
    stat = lstatSync(absolutePath, { bigint: true });
  } catch {
    authoredPlanFailure(`could not inspect ${relativePath}`);
  }
  addBudgetEntry(budget);
  if (stat.isSymbolicLink()) authoredPlanFailure(`${relativePath} is a symbolic link`);
  if (stat.isFile()) return readStableFile(absolutePath, relativePath, budget, hooks);
  if (!stat.isDirectory()) authoredPlanFailure(`${relativePath} has an unsupported file type`);
  validateSafeStat(stat, 'directory', relativePath);
  revalidateDirectory(absolutePath, relativePath, stat);
  return directoryRecord(relativePath, stat);
}

function isOpaqueGeneratedEntry(
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
    validateSafeStat(before, 'directory', relativePath);
    revalidateDirectory(absolutePath, relativePath, before);
    return true;
  }
  let after: BigIntStats;
  try {
    after = lstatSync(absolutePath, { bigint: true });
  } catch {
    authoredPlanFailure(`${relativePath} disappeared while planning`);
  }
  if (!sameStat(before, after)) authoredPlanFailure(`${relativePath} changed while planning`);
  return true;
}

function addRecord(
  records: Map<string, InitAuthoredSnapshotRecord>,
  folded: Map<string, string>,
  record: InitAuthoredSnapshotRecord,
): void {
  const prior = folded.get(caseFoldPath(record.path));
  if (prior !== undefined && prior !== record.path) {
    authoredPlanFailure(`case-folded path collision between '${prior}' and '${record.path}'`);
  }
  folded.set(caseFoldPath(record.path), record.path);
  const existing = records.get(record.path);
  if (existing !== undefined && JSON.stringify(existing) !== JSON.stringify(record)) {
    authoredPlanFailure(`${record.path} changed between snapshot observations`);
  }
  records.set(record.path, record);
}

function walkAuthoredTree(
  root: string,
  records: Map<string, InitAuthoredSnapshotRecord>,
  folded: Map<string, string>,
  budget: SnapshotBudget,
  opaquePaths: Set<string>,
  hooks: InitAuthoredSnapshotHooks | undefined,
): void {
  const visit = (relativePath: string): void => {
    const absolutePath = join(root, ...relativePath.split('/'));
    const record = inspectExistingPath(absolutePath, relativePath, budget, hooks);
    addRecord(records, folded, record);
    if (!record.exists || record.type !== 'directory') return;
    const names = stableDirectoryNames(absolutePath, relativePath, hooks);
    const localFolded = new Map<string, string>();
    for (const name of names) {
      const normalizedName = name.normalize('NFC');
      if (normalizedName !== name || name.includes('/') || name.includes('\\') || name === '..') {
        authoredPlanFailure(`${relativePath} contains a noncanonical entry name`);
      }
      const foldedName = caseFoldPath(name);
      const prior = localFolded.get(foldedName);
      if (prior !== undefined && prior !== name) {
        authoredPlanFailure(`case-folded sibling collision in ${relativePath}`);
      }
      localFolded.set(foldedName, name);
      const child = `${relativePath}/${name}`;
      if (isRuntimeAuthoredPath(child)) {
        const runtimeStat = inspectExistingPath(
          join(root, ...child.split('/')),
          child,
          budget,
          hooks,
        );
        if (!runtimeStat.exists || runtimeStat.type !== 'directory') {
          authoredPlanFailure('opensip-cli/.runtime must be a real directory');
        }
        continue;
      }
      if (
        isOpaqueGeneratedEntry(
          join(root, ...child.split('/')),
          normalizeProjectRelativePath(child),
          budget,
        )
      ) {
        opaquePaths.add(normalizeProjectRelativePath(child));
        continue;
      }
      visit(normalizeProjectRelativePath(child));
    }
  };

  const authoredRoot = join(root, 'opensip-cli');
  try {
    lstatSync(authoredRoot);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    authoredPlanFailure('could not inspect opensip-cli');
  }
  visit('opensip-cli');
}

function snapshotWorkingDirState(
  records: ReadonlyMap<string, InitAuthoredSnapshotRecord>,
  opaquePaths: ReadonlySet<string>,
): InitAuthoredWorkingDirState {
  const hasConfig = records.get('opensip-cli.config.yml')?.exists === true;
  const hasAuthoredDirectoryContent =
    opaquePaths.size > 0 ||
    [...records.values()].some(
      (record) =>
        record.exists &&
        record.path.startsWith('opensip-cli/') &&
        !isRuntimeAuthoredPath(record.path),
    );
  if (!hasConfig && !hasAuthoredDirectoryContent) return 'pristine';
  if (hasConfig && hasAuthoredDirectoryContent) return 'fully-initialized';
  return hasConfig ? 'partial-config-only' : 'partial-dir-only';
}

function observeTarget(
  root: string,
  relativePath: string,
  records: Map<string, InitAuthoredSnapshotRecord>,
  folded: Map<string, string>,
  budget: SnapshotBudget,
  hooks: InitAuthoredSnapshotHooks | undefined,
): void {
  if (records.has(relativePath)) return;
  const segments = relativePath.split('/');
  let parent = root;
  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index];
    const parentRelative = index === 0 ? '<project-root>' : segments.slice(0, index).join('/');
    const names = stableDirectoryNames(parent, parentRelative, hooks);
    const exact = names.includes(segment);
    const colliding = names.find(
      (name) => name !== segment && caseFoldPath(name) === caseFoldPath(segment),
    );
    if (colliding !== undefined) {
      authoredPlanFailure(`case-folded path collision between '${colliding}' and '${segment}'`);
    }
    if (!exact) {
      addRecord(records, folded, {
        path: relativePath,
        exists: false,
        type: null,
        mode: null,
        digest: null,
        contentBase64: null,
      });
      return;
    }
    const currentRelative = segments.slice(0, index + 1).join('/');
    const absolutePath = join(parent, segment);
    if (index < segments.length - 1) {
      const ancestor = inspectExistingPath(absolutePath, currentRelative, budget, hooks);
      if (!ancestor.exists || ancestor.type !== 'directory') {
        authoredPlanFailure(`${currentRelative} is not a directory`);
      }
      parent = absolutePath;
      continue;
    }
    addRecord(records, folded, inspectExistingPath(absolutePath, relativePath, budget, hooks));
  }
}

export function readInitAuthoredSnapshot(
  input: ReadInitAuthoredSnapshotInput,
): InitAuthoredSnapshot {
  const requestedRoot = resolve(input.projectRoot);
  let requestedStat: BigIntStats;
  try {
    requestedStat = lstatSync(requestedRoot, { bigint: true });
  } catch {
    authoredPlanFailure('project root is unreadable');
  }
  if (requestedStat.isSymbolicLink()) authoredPlanFailure('project root must not be a symlink');
  validateSafeStat(requestedStat, 'directory', '<project-root>');
  const root = realpathSync(requestedRoot);
  const rootBefore = lstatSync(root, { bigint: true });
  if (!sameStat(requestedStat, rootBefore))
    authoredPlanFailure('project root changed while opening');

  const records = new Map<string, InitAuthoredSnapshotRecord>();
  const folded = new Map<string, string>();
  const opaquePaths = new Set<string>();
  const budget: SnapshotBudget = { entries: 0, bytes: 0 };
  walkAuthoredTree(root, records, folded, budget, opaquePaths, input.hooks);
  const targets = [...new Set(input.targetPaths.map(normalizeProjectRelativePath))].sort(
    compareUtf8,
  );
  for (const target of targets) {
    observeTarget(root, target, records, folded, budget, input.hooks);
  }
  const rootAfter = lstatSync(root, { bigint: true });
  if (!sameStat(rootBefore, rootAfter)) authoredPlanFailure('project root changed while planning');

  return {
    records: Object.freeze(
      [...records.values()].sort((left, right) => compareUtf8(left.path, right.path)),
    ),
    opaquePaths: Object.freeze([...opaquePaths].sort(compareUtf8)),
    workingDirState: snapshotWorkingDirState(records, opaquePaths),
  };
}
