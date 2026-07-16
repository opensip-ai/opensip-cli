import { lstat, opendir } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import { isPathInside } from '@opensip-cli/core';

import { byCodePoint } from './freeze.js';

import type { Dir, Dirent } from 'node:fs';

/** Maximum entries read and retained from one directory batch. */
export const MAX_MANIFEST_ENTRIES_PER_DIRECTORY = 4096;

/** Maximum directory entries inspected during one manifest walk. */
export const MAX_MANIFEST_WALK_ENTRIES = 200_000;

/** Maximum directories opened during one manifest walk. */
export const MAX_MANIFEST_WALK_DIRECTORIES = 50_000;

/** Maximum pending deterministic DFS items retained at once. */
export const MAX_MANIFEST_WALK_FRONTIER = 65_536;

/** Fixed Node directory read buffer; it does not grow with repository size. */
export const MANIFEST_DIRECTORY_READ_BUFFER_SIZE = 32;

const CHECKPOINT_INTERVAL = 128;
const DIRECTORY_OPEN_FAILED = Symbol('directory-open-failed');
const PLATFORM_NOCASE = process.platform === 'darwin' || process.platform === 'win32';
const COMMON_IGNORED_DIRECTORIES = new Set([
  '.git',
  '.opensip-cli',
  'coverage',
  'dist',
  'node_modules',
]);

export interface ManifestWalkCandidate {
  readonly manifestPath: string;
  /** Project-relative POSIX directory containing package.json. */
  readonly packageRoot: string;
}

export interface ManifestWalkMetrics {
  readonly visitedDirectories: number;
  readonly visitedEntries: number;
  readonly peakDirectoryBatchEntries: number;
  readonly peakFrontierEntries: number;
}

export interface ManifestWalkResult {
  readonly cancelled: boolean;
  readonly capped: boolean;
  readonly readFailed: boolean;
  readonly stoppedByVisitor: boolean;
  readonly metrics: ManifestWalkMetrics;
}

interface MutableWalkState {
  cancelled: boolean;
  capped: boolean;
  readFailed: boolean;
  stoppedByVisitor: boolean;
  visitedDirectories: number;
  visitedEntries: number;
  peakDirectoryBatchEntries: number;
  peakFrontierEntries: number;
}

interface DirectoryWork {
  readonly depth: number;
  readonly relativeDirectory: string;
  readonly type: 'directory';
}

interface ManifestWork {
  readonly manifestPath: string;
  readonly packageRoot: string;
  readonly type: 'manifest';
}

type WalkWork = DirectoryWork | ManifestWork;

interface ClassifiedEntry {
  readonly kind: 'directory' | 'manifest';
  readonly name: string;
}

interface WalkContext {
  readonly projectRoot: string;
  readonly maxDepth: number;
  readonly signal?: AbortSignal;
  readonly shouldEnterDirectory: (relativeDirectory: string) => boolean;
  readonly state: MutableWalkState;
  readonly visitor: (candidate: ManifestWalkCandidate) => boolean | void | Promise<boolean | void>;
}

function observeManifestWalkCancellation(context: WalkContext): boolean {
  if (context.signal?.aborted !== true) return false;
  context.state.cancelled = true;
  return true;
}

async function checkpoint(context: WalkContext): Promise<boolean> {
  if (observeManifestWalkCancellation(context)) return false;
  if (context.state.visitedEntries % CHECKPOINT_INTERVAL !== 0) return true;
  await new Promise<void>((resolveNow) => setImmediate(resolveNow));
  return !observeManifestWalkCancellation(context);
}

function ignoredDirectory(relativeDirectory: string, name: string): boolean {
  const candidate = PLATFORM_NOCASE ? name.toLowerCase() : name;
  const parent = PLATFORM_NOCASE ? relativeDirectory.toLowerCase() : relativeDirectory;
  return (
    COMMON_IGNORED_DIRECTORIES.has(candidate) ||
    ((parent === 'opensip-cli' || parent.endsWith('/opensip-cli')) && candidate === '.runtime')
  );
}

function relativeChild(relativeDirectory: string, name: string): string {
  return relativeDirectory.length === 0 ? name : `${relativeDirectory}/${name}`;
}

function classifiedEntryOrder(left: ClassifiedEntry, right: ClassifiedEntry): number {
  const leftKey = left.kind === 'directory' ? `${left.name}/` : left.name;
  const rightKey = right.kind === 'directory' ? `${right.name}/` : right.name;
  return byCodePoint(leftKey, rightKey);
}

async function classifyUnknownEntry(
  entry: Dirent<string>,
  directoryPath: string,
  context: WalkContext,
): Promise<ClassifiedEntry | undefined> {
  try {
    const entryStat = await lstat(join(directoryPath, entry.name));
    if (observeManifestWalkCancellation(context)) return undefined;
    if (entryStat.isDirectory()) return { kind: 'directory', name: entry.name };
    if (entry.name === 'package.json' && (entryStat.isFile() || entryStat.isSymbolicLink())) {
      return { kind: 'manifest', name: entry.name };
    }
  } catch {
    context.state.readFailed = true;
    context.state.capped = true;
  }
  return undefined;
}

async function classifyEntry(
  entry: Dirent<string>,
  directoryPath: string,
  context: WalkContext,
): Promise<ClassifiedEntry | undefined> {
  if (entry.isDirectory()) return { kind: 'directory', name: entry.name };
  if (entry.name === 'package.json' && (entry.isFile() || entry.isSymbolicLink())) {
    return { kind: 'manifest', name: entry.name };
  }
  if (
    entry.isFile() ||
    entry.isSymbolicLink() ||
    entry.isBlockDevice() ||
    entry.isCharacterDevice() ||
    entry.isFIFO() ||
    entry.isSocket()
  ) {
    return undefined;
  }
  return classifyUnknownEntry(entry, directoryPath, context);
}

function reserveEntry(state: MutableWalkState, directoryEntries: number): boolean {
  if (
    directoryEntries >= MAX_MANIFEST_ENTRIES_PER_DIRECTORY ||
    state.visitedEntries >= MAX_MANIFEST_WALK_ENTRIES
  ) {
    state.capped = true;
    return false;
  }
  state.visitedEntries += 1;
  state.peakDirectoryBatchEntries = Math.max(state.peakDirectoryBatchEntries, directoryEntries + 1);
  return true;
}

async function readDirectoryBatch(
  directory: Dir,
  directoryPath: string,
  context: WalkContext,
): Promise<readonly ClassifiedEntry[] | undefined> {
  const selected: ClassifiedEntry[] = [];
  let directoryEntries = 0;
  while (!observeManifestWalkCancellation(context)) {
    let entry: Dirent<string> | null;
    try {
      entry = await directory.read();
    } catch {
      // @swallow-ok a directory can become unreadable after opendir; discard
      // its incomplete batch and qualify the walk rather than rejecting it.
      context.state.readFailed = true;
      context.state.capped = true;
      return undefined;
    }
    if (observeManifestWalkCancellation(context)) return undefined;
    if (entry === null) return selected.sort(classifiedEntryOrder);
    if (!reserveEntry(context.state, directoryEntries)) return undefined;
    directoryEntries += 1;
    const classified = await classifyEntry(entry, directoryPath, context);
    if (context.state.capped || context.state.cancelled) return undefined;
    if (classified !== undefined) selected.push(classified);
    if (!(await checkpoint(context))) return undefined;
  }
  return undefined;
}

async function openDirectory(
  directoryPath: string,
  context: WalkContext,
): Promise<Dir | typeof DIRECTORY_OPEN_FAILED | undefined> {
  if (context.state.visitedDirectories >= MAX_MANIFEST_WALK_DIRECTORIES) {
    context.state.capped = true;
    return undefined;
  }
  context.state.visitedDirectories += 1;
  try {
    return await opendir(directoryPath, { bufferSize: MANIFEST_DIRECTORY_READ_BUFFER_SIZE });
  } catch {
    context.state.readFailed = true;
    context.state.capped = true;
    return DIRECTORY_OPEN_FAILED;
  }
}

function pushDirectoryBatch(
  stack: WalkWork[],
  work: DirectoryWork,
  entries: readonly ClassifiedEntry[],
  context: WalkContext,
): void {
  const retained: ClassifiedEntry[] = [];
  for (const entry of entries) {
    if (entry.kind === 'manifest') {
      retained.push(entry);
      continue;
    }
    if (retainDirectoryEntry(entry, work, context)) retained.push(entry);
    if (context.state.capped) return;
  }
  if (stack.length + retained.length > MAX_MANIFEST_WALK_FRONTIER) {
    context.state.capped = true;
    return;
  }
  for (let index = retained.length - 1; index >= 0; index -= 1) {
    const entry = retained[index];
    if (entry === undefined) continue;
    if (entry.kind === 'directory') {
      stack.push({
        depth: work.depth + 1,
        relativeDirectory: relativeChild(work.relativeDirectory, entry.name),
        type: 'directory',
      });
    } else if (work.relativeDirectory.length > 0) {
      stack.push({
        manifestPath: join(context.projectRoot, work.relativeDirectory, 'package.json'),
        packageRoot: work.relativeDirectory,
        type: 'manifest',
      });
    }
  }
  context.state.peakFrontierEntries = Math.max(context.state.peakFrontierEntries, stack.length);
}

function retainDirectoryEntry(
  entry: ClassifiedEntry,
  work: DirectoryWork,
  context: WalkContext,
): boolean {
  if (ignoredDirectory(work.relativeDirectory, entry.name)) return false;
  const relativeDirectory = relativeChild(work.relativeDirectory, entry.name);
  if (!context.shouldEnterDirectory(relativeDirectory)) return false;
  if (work.depth < context.maxDepth) return true;
  context.state.capped = true;
  return false;
}

async function processDirectory(
  work: DirectoryWork,
  stack: WalkWork[],
  context: WalkContext,
): Promise<void> {
  const directoryPath =
    work.relativeDirectory.length === 0
      ? context.projectRoot
      : join(context.projectRoot, work.relativeDirectory);
  if (!isPathInside(directoryPath, context.projectRoot)) {
    context.state.capped = true;
    return;
  }
  const directory = await openDirectory(directoryPath, context);
  if (directory === undefined || directory === DIRECTORY_OPEN_FAILED) return;
  try {
    const entries = await readDirectoryBatch(directory, directoryPath, context);
    if (entries !== undefined) pushDirectoryBatch(stack, work, entries, context);
  } finally {
    try {
      await directory.close();
    } catch {
      // @swallow-ok close can race a filesystem failure too. Any work pushed
      // from this directory remains unprocessed because capped stops the walk.
      context.state.readFailed = true;
      context.state.capped = true;
    }
  }
}

function frozenResult(state: MutableWalkState): ManifestWalkResult {
  return Object.freeze({
    cancelled: state.cancelled,
    capped: state.capped,
    readFailed: state.readFailed,
    stoppedByVisitor: state.stoppedByVisitor,
    metrics: Object.freeze({
      visitedDirectories: state.visitedDirectories,
      visitedEntries: state.visitedEntries,
      peakDirectoryBatchEntries: state.peakDirectoryBatchEntries,
      peakFrontierEntries: state.peakFrontierEntries,
    }),
  });
}

/**
 * Walk a project once in deterministic path order and offer only nested
 * package.json candidates. Directory symlinks are never followed; every work
 * and retained-state dimension has a hard ceiling independent of match count.
 */
export async function walkManifestFilesystem(
  projectRoot: string,
  maxDepth: number,
  shouldEnterDirectory: (relativeDirectory: string) => boolean,
  visitor: (candidate: ManifestWalkCandidate) => boolean | void | Promise<boolean | void>,
  signal?: AbortSignal,
): Promise<ManifestWalkResult> {
  const state: MutableWalkState = {
    cancelled: false,
    capped: false,
    readFailed: false,
    stoppedByVisitor: false,
    visitedDirectories: 0,
    visitedEntries: 0,
    peakDirectoryBatchEntries: 0,
    peakFrontierEntries: 1,
  };
  const context: WalkContext = {
    projectRoot: resolve(projectRoot),
    maxDepth,
    ...(signal === undefined ? {} : { signal }),
    shouldEnterDirectory,
    state,
    visitor,
  };
  const stack: WalkWork[] = [{ depth: 0, relativeDirectory: '', type: 'directory' }];
  observeManifestWalkCancellation(context);
  while (stack.length > 0 && !state.cancelled && !state.capped && !state.stoppedByVisitor) {
    const work = stack.pop();
    if (work === undefined) break;
    if (work.type === 'directory') {
      await processDirectory(work, stack, context);
    } else if ((await visitor(work)) === false) {
      state.stoppedByVisitor = true;
    }
    if (observeManifestWalkCancellation(context)) break;
  }
  return frozenResult(state);
}
