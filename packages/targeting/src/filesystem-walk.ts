import { lstat, opendir, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import { isPathInside } from '@opensip-cli/core';

import { compareCodePointStrings } from './code-point-order.js';

import type { Dir, Dirent } from 'node:fs';

/** Maximum entries retained while fully enumerating one directory. */
export const TARGET_WALK_MAX_ENTRIES_PER_DIRECTORY = 4096;

/** Maximum directory depth below the project root. */
export const TARGET_WALK_MAX_DEPTH = 64;

/** Maximum directories opened over one walk. */
export const TARGET_WALK_MAX_VISITED_DIRECTORIES = 50_000;

/** Maximum directory entries retained over one walk. */
export const TARGET_WALK_MAX_VISITED_ENTRIES = 200_000;

/** Maximum pending entry/directory work items retained at once. */
export const TARGET_WALK_MAX_FRONTIER_ENTRIES = 65_536;

/** Maximum entries Node may internally buffer for the active directory. */
export const TARGET_WALK_DIRECTORY_READ_BUFFER_SIZE = 32;

const TARGET_WALK_CHECKPOINT_INTERVAL = 128;
const PLATFORM_NOCASE = process.platform === 'darwin' || process.platform === 'win32';
const COMMON_IGNORED_ENTRY_NAMES = new Set(['node_modules', 'dist', '.git']);

/** Observable proof of the filesystem walk's retained-state and work bounds. */
export interface TargetFilesystemWalkMetrics {
  /** Total directory entries retained in complete or discarded batches. */
  readonly visitedEntries: number;
  /** Total safe regular files offered to the caller. */
  readonly visitedFiles: number;
  /** Total directories opened over the lifetime of the walk. */
  readonly visitedDirectories: number;
  /** Greatest complete directory batch retained before sorting. */
  readonly peakDirectoryBatchEntries: number;
  /** Greatest pending DFS frontier retained at once. */
  readonly peakFrontierEntries: number;
  /** Fixed per-directory buffer supplied to `opendir`. */
  readonly directoryReadBufferSize: number;
}

/** Result of a cooperative, deterministic project filesystem walk. */
export interface TargetFilesystemWalkResult {
  /** True when the caller's abort signal stopped the walk. */
  readonly cancelled: boolean;
  /** True when a traversal work/state ceiling prevented complete enumeration. */
  readonly capped: boolean;
  /** True when the visitor deliberately stopped otherwise complete traversal. */
  readonly stoppedByVisitor: boolean;
  /** Immutable traversal metrics used to verify retained-state bounds. */
  readonly metrics: TargetFilesystemWalkMetrics;
}

/** Options for the internal bounded project walker. */
export interface TargetFilesystemWalkOptions {
  /** Cancels traversal after the current filesystem operation or checkpoint. */
  readonly signal?: AbortSignal;
}

/** A safe regular file discovered below the project root. */
export interface TargetFilesystemFile {
  /** Absolute path using the host platform's separators. */
  readonly absolutePath: string;
  /** Root-relative path using POSIX separators. */
  readonly relativePath: string;
}

interface MutableWalkState {
  cancelled: boolean;
  capped: boolean;
  stoppedByVisitor: boolean;
  visitedEntries: number;
  visitedFiles: number;
  visitedDirectories: number;
  peakDirectoryBatchEntries: number;
  peakFrontierEntries: number;
}

interface DirectoryWork {
  readonly depth: number;
  readonly relativeDirectory: string;
  readonly type: 'directory';
}

interface EntryWork {
  readonly depth: number;
  readonly entry: Dirent<string>;
  readonly kind: TargetFilesystemEntryKind;
  readonly relativeDirectory: string;
  readonly type: 'entry';
}

type PendingWork = DirectoryWork | EntryWork;

interface WalkContext {
  readonly rootDir: string;
  readonly visitor: (file: TargetFilesystemFile) => boolean | void;
  readonly options: TargetFilesystemWalkOptions;
  readonly state: MutableWalkState;
}

function isAborted(context: WalkContext): boolean {
  if (context.options.signal?.aborted !== true) return false;
  context.state.cancelled = true;
  return true;
}

function isMissingDirectory(error: unknown): boolean {
  if (typeof error !== 'object' || error === null || !('code' in error)) return false;
  const code = (error as { readonly code?: unknown }).code;
  return code === 'ENOENT' || code === 'ENOTDIR';
}

async function yieldToEventLoop(): Promise<void> {
  await new Promise<void>((resolveNow) => setImmediate(resolveNow));
}

async function checkpoint(context: WalkContext): Promise<boolean> {
  if (isAborted(context)) return false;
  if (context.state.visitedEntries % TARGET_WALK_CHECKPOINT_INTERVAL !== 0) return true;
  await yieldToEventLoop();
  return !isAborted(context);
}

function relativeChild(relativeDirectory: string, name: string): string {
  return relativeDirectory.length === 0 ? name : `${relativeDirectory}/${name}`;
}

function isCommonIgnoredEntry(name: string): boolean {
  const candidate = PLATFORM_NOCASE ? name.toLowerCase() : name;
  return COMMON_IGNORED_ENTRY_NAMES.has(candidate);
}

export type TargetFilesystemEntryKind = 'directory' | 'file' | 'other';

/** Minimal classified entry shape accepted by the deterministic comparator. */
export interface TargetFilesystemEntryOrder {
  readonly kind: TargetFilesystemEntryKind;
  readonly name: string;
}

interface ClassifiedDirectoryEntry extends TargetFilesystemEntryOrder {
  readonly entry: Dirent<string>;
}

function entrySortKey(entry: TargetFilesystemEntryOrder): string {
  return entry.kind === 'directory' ? `${entry.name}/` : entry.name;
}

/** Compare already-classified entries in canonical project-path order. */
export function compareTargetFilesystemEntries(
  left: TargetFilesystemEntryOrder,
  right: TargetFilesystemEntryOrder,
): number {
  return compareCodePointStrings(entrySortKey(left), entrySortKey(right));
}

async function safeRegularFile(absolutePath: string, context: WalkContext): Promise<boolean> {
  try {
    const fileStat = await stat(absolutePath);
    if (isAborted(context)) return false;
    return fileStat.isFile() && isPathInside(absolutePath, context.rootDir);
  } catch {
    // @swallow-ok a single entry can fail to stat (vanished between directory
    // read and stat, or a dangling symlink whose target does not exist). This
    // is a per-entry condition, not a resource-bound truncation: skip just this
    // entry and let the walk continue. `capped` is reserved for genuine
    // TARGET_WALK_MAX_* ceilings (see the main loop's `!state.capped` guard,
    // which would otherwise abandon the rest of the tree over one bad entry).
    return false;
  }
}

async function safeDirectory(absolutePath: string, context: WalkContext): Promise<boolean> {
  try {
    const directoryStat = await lstat(absolutePath);
    if (isAborted(context)) return false;
    return directoryStat.isDirectory() && isPathInside(absolutePath, context.rootDir);
  } catch {
    // @swallow-ok entries can disappear between directory read and lstat; mark
    // the walk incomplete rather than silently claiming complete evidence.
    context.state.capped = true;
    return false;
  }
}

async function classifyEntry(
  entry: Dirent<string>,
  absolutePath: string,
  context: WalkContext,
): Promise<TargetFilesystemEntryKind | undefined> {
  if (entry.isDirectory()) return 'directory';
  if (entry.isFile() || entry.isSymbolicLink()) return 'file';
  if (entry.isBlockDevice() || entry.isCharacterDevice() || entry.isFIFO() || entry.isSocket()) {
    return 'other';
  }
  try {
    const entryStat = await lstat(absolutePath);
    if (isAborted(context)) return undefined;
    if (entryStat.isDirectory()) return 'directory';
    if (entryStat.isFile() || entryStat.isSymbolicLink()) return 'file';
    return 'other';
  } catch {
    // @swallow-ok DT_UNKNOWN requires lstat; failure makes the walk incomplete.
    context.state.capped = true;
    return undefined;
  }
}

function reserveDirectory(state: MutableWalkState): boolean {
  if (state.visitedDirectories < TARGET_WALK_MAX_VISITED_DIRECTORIES) {
    state.visitedDirectories++;
    return true;
  }
  state.capped = true;
  return false;
}

async function openTargetDirectory(directoryPath: string): Promise<Dir | undefined> {
  try {
    return await opendir(directoryPath, {
      bufferSize: TARGET_WALK_DIRECTORY_READ_BUFFER_SIZE,
    });
  } catch (error) {
    if (isMissingDirectory(error)) return undefined;
    throw error;
  }
}

function reserveDirectoryEntry(retainedEntryCount: number, state: MutableWalkState): boolean {
  if (
    retainedEntryCount >= TARGET_WALK_MAX_ENTRIES_PER_DIRECTORY ||
    state.visitedEntries >= TARGET_WALK_MAX_VISITED_ENTRIES
  ) {
    state.capped = true;
    return false;
  }
  state.visitedEntries++;
  state.peakDirectoryBatchEntries = Math.max(
    state.peakDirectoryBatchEntries,
    retainedEntryCount + 1,
  );
  return true;
}

async function readDirectoryEntries(
  directory: Dir,
  directoryPath: string,
  context: WalkContext,
): Promise<readonly ClassifiedDirectoryEntry[] | undefined> {
  const entries: ClassifiedDirectoryEntry[] = [];
  while (!isAborted(context)) {
    const entry = await directory.read();
    if (isAborted(context)) return undefined;
    if (entry === null) return entries.sort(compareTargetFilesystemEntries);
    if (!reserveDirectoryEntry(entries.length, context.state)) return undefined;
    const kind = await classifyEntry(entry, join(directoryPath, entry.name), context);
    if (kind === undefined) return undefined;
    entries.push({ entry, kind, name: entry.name });
    if (!(await checkpoint(context))) return undefined;
  }
  return undefined;
}

async function readCompleteDirectory(
  work: DirectoryWork,
  context: WalkContext,
): Promise<readonly ClassifiedDirectoryEntry[] | undefined> {
  if (!reserveDirectory(context.state)) return undefined;
  const directoryPath =
    work.relativeDirectory.length === 0
      ? context.rootDir
      : join(context.rootDir, work.relativeDirectory);
  const directory = await openTargetDirectory(directoryPath);
  if (directory === undefined) {
    if (work.relativeDirectory.length > 0) context.state.capped = true;
    return work.relativeDirectory.length === 0 ? [] : undefined;
  }
  try {
    // @fitness-ignore-next-line async-waterfall-detection -- The directory must remain open until its complete bounded batch is read, then close in finally.
    return await readDirectoryEntries(directory, directoryPath, context);
  } finally {
    await directory.close();
  }
}

function pushDirectoryEntries(
  stack: PendingWork[],
  work: DirectoryWork,
  entries: readonly ClassifiedDirectoryEntry[],
  state: MutableWalkState,
): boolean {
  if (stack.length + entries.length > TARGET_WALK_MAX_FRONTIER_ENTRIES) {
    state.capped = true;
    return false;
  }
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (entry !== undefined) {
      stack.push({
        depth: work.depth,
        entry: entry.entry,
        kind: entry.kind,
        relativeDirectory: work.relativeDirectory,
        type: 'entry',
      });
    }
  }
  state.peakFrontierEntries = Math.max(state.peakFrontierEntries, stack.length);
  return true;
}

async function visitDirectoryEntry(
  work: EntryWork,
  relativePath: string,
  absolutePath: string,
  stack: PendingWork[],
  context: WalkContext,
): Promise<void> {
  const childDepth = work.depth + 1;
  if (childDepth > TARGET_WALK_MAX_DEPTH) {
    context.state.capped = true;
    return;
  }
  if (!(await safeDirectory(absolutePath, context))) return;
  stack.push({
    depth: childDepth,
    relativeDirectory: relativePath,
    type: 'directory',
  });
  context.state.peakFrontierEntries = Math.max(context.state.peakFrontierEntries, stack.length);
}

async function visitEntry(
  work: EntryWork,
  stack: PendingWork[],
  context: WalkContext,
): Promise<void> {
  // Glob 13 tests ignore candidates both with and without a trailing slash,
  // so the common `name/**` patterns exclude an exact-basename regular file
  // as well as a directory tree.
  if (isCommonIgnoredEntry(work.entry.name)) return;
  const relativePath = relativeChild(work.relativeDirectory, work.entry.name);
  const absolutePath = join(context.rootDir, relativePath);
  if (work.kind === 'directory') {
    await visitDirectoryEntry(work, relativePath, absolutePath, stack, context);
    return;
  }
  if (work.kind === 'file' && (await safeRegularFile(absolutePath, context))) {
    context.state.visitedFiles++;
    if (context.visitor({ absolutePath, relativePath }) === false) {
      context.state.stoppedByVisitor = true;
    }
  }
}

function freezeMetrics(state: MutableWalkState): TargetFilesystemWalkMetrics {
  return Object.freeze({
    visitedEntries: state.visitedEntries,
    visitedFiles: state.visitedFiles,
    visitedDirectories: state.visitedDirectories,
    peakDirectoryBatchEntries: state.peakDirectoryBatchEntries,
    peakFrontierEntries: state.peakFrontierEntries,
    directoryReadBufferSize: TARGET_WALK_DIRECTORY_READ_BUFFER_SIZE,
  });
}

/**
 * Enumerate safe regular files in code-point order within fixed work bounds.
 *
 * Each directory is manually read in full, capped at 4,096 retained entries,
 * and closed before its entries are sorted. An interrupted or over-limit batch
 * contributes no entries, so raw filesystem enumeration order never leaks into
 * partial output. Sorting directories as `name/` makes the depth-first stream
 * globally ordered by root-relative path. Directory symlinks are never
 * traversed; regular-file symlinks must realpath inside the root.
 */
export async function walkTargetFilesystem(
  rootDir: string,
  visitor: (file: TargetFilesystemFile) => boolean | void,
  options: TargetFilesystemWalkOptions = {},
): Promise<TargetFilesystemWalkResult> {
  const state: MutableWalkState = {
    cancelled: false,
    capped: false,
    stoppedByVisitor: false,
    visitedEntries: 0,
    visitedFiles: 0,
    visitedDirectories: 0,
    peakDirectoryBatchEntries: 0,
    peakFrontierEntries: 1,
  };
  const context: WalkContext = {
    rootDir: resolve(rootDir),
    visitor,
    options,
    state,
  };
  isAborted(context);
  const stack: PendingWork[] = [{ depth: 0, relativeDirectory: '', type: 'directory' }];

  // @sequential-ok — sorted DFS establishes canonical output order and one
  // bounded frontier; parallel directory reads would race that order.
  while (stack.length > 0 && !state.cancelled && !state.capped && !state.stoppedByVisitor) {
    const work = stack.pop();
    if (work === undefined) break;
    if (work.type === 'directory') {
      const entries = await readCompleteDirectory(work, context);
      if (entries !== undefined) pushDirectoryEntries(stack, work, entries, state);
    } else {
      await visitEntry(work, stack, context);
    }
    if (isAborted(context)) break;
  }

  return Object.freeze({
    cancelled: state.cancelled,
    capped: state.capped,
    stoppedByVisitor: state.stoppedByVisitor,
    metrics: freezeMetrics(state),
  });
}
