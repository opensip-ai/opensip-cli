import { closeSync, openSync, opendirSync, readSync, statSync } from 'node:fs';
import { sep } from 'node:path';

import { escapeRegularExpression } from '../model/value-helpers.js';
import { resolveInsideRoot } from '../runner/workspace-paths.js';

import type { Dirent } from 'node:fs';

export const TRUNCATION_MARKER = '[truncated: native-tool bounds reached]';

const EXCLUDED_DIRECTORY_NAMES = new Set([
  '.git',
  '.runtime',
  '.turbo',
  'coverage',
  'dist',
  'node_modules',
]);

export interface WalkResult {
  readonly paths: readonly string[];
  readonly truncated: boolean;
}

interface WalkState {
  readonly limits: WalkLimits;
  readonly paths: string[];
  truncated: boolean;
  visitedDirectories: number;
  visitedEntries: number;
}

export interface WalkLimits {
  readonly maxDepth: number;
  readonly maxEntriesPerDirectory: number;
  readonly maxFiles: number;
  readonly maxVisitedDirectories: number;
  readonly maxVisitedEntries: number;
}

type PendingWork =
  | {
      readonly depth: number;
      readonly relativeDirectory: string;
      readonly type: 'directory';
    }
  | {
      readonly depth: number;
      readonly entry: Dirent<string>;
      readonly relativeDirectory: string;
      readonly type: 'entry';
    };

const MAX_WALK_DEPTH = 64;
const MAX_ENTRIES_PER_DIRECTORY = 4096;
const MAX_VISITED_DIRECTORIES = 50_000;
const MAX_VISITED_ENTRIES = 200_000;

function defaultWalkLimits(maxFiles: number): WalkLimits {
  return {
    maxDepth: MAX_WALK_DEPTH,
    maxEntriesPerDirectory: MAX_ENTRIES_PER_DIRECTORY,
    maxFiles,
    maxVisitedDirectories: Math.min(MAX_VISITED_DIRECTORIES, Math.max(64, maxFiles * 2)),
    maxVisitedEntries: Math.min(MAX_VISITED_ENTRIES, Math.max(256, maxFiles * 4)),
  };
}

function posixPath(path: string): string {
  return path.split(sep).join('/');
}

function shouldExclude(relativePath: string, name: string): boolean {
  if (EXCLUDED_DIRECTORY_NAMES.has(name) || name === '__fixtures__') return true;
  const normalized = posixPath(relativePath);
  return (
    normalized === 'packages/agent-eval/results' ||
    normalized.startsWith('packages/agent-eval/results/') ||
    normalized.startsWith('__fixtures__/') ||
    normalized.includes('/__fixtures__/')
  );
}

function compareCodePoints(left: string, right: string): number {
  const leftPoints = [...left];
  const rightPoints = [...right];
  const length = Math.min(leftPoints.length, rightPoints.length);
  for (let index = 0; index < length; index += 1) {
    const leftPoint = leftPoints[index]?.codePointAt(0) ?? 0;
    const rightPoint = rightPoints[index]?.codePointAt(0) ?? 0;
    if (leftPoint !== rightPoint) return leftPoint - rightPoint;
  }
  return leftPoints.length - rightPoints.length;
}

function entrySortKey(entry: Dirent<string>): string {
  return entry.isDirectory() ? `${entry.name}/` : entry.name;
}

function compareEntries(left: Dirent<string>, right: Dirent<string>): number {
  return compareCodePoints(entrySortKey(left), entrySortKey(right));
}

function childRelativePath(relativeDirectory: string, name: string): string {
  if (relativeDirectory.length === 0) return name;
  return `${posixPath(relativeDirectory)}/${name}`;
}

function retainFile(relativePath: string, state: WalkState): boolean {
  if (state.paths.length >= state.limits.maxFiles) {
    state.truncated = true;
    return false;
  }
  state.paths.push(posixPath(relativePath));
  return true;
}

function boundedDirectoryEntries(
  workspaceRoot: string,
  relativeDirectory: string,
  state: WalkState,
): readonly Dirent<string>[] {
  if (state.visitedDirectories >= state.limits.maxVisitedDirectories) {
    state.truncated = true;
    return [];
  }
  state.visitedDirectories += 1;
  const directory =
    relativeDirectory.length === 0
      ? workspaceRoot
      : resolveInsideRoot(workspaceRoot, relativeDirectory);
  const handle = opendirSync(directory);
  const entries: Dirent<string>[] = [];
  try {
    while (true) {
      if (
        entries.length >= state.limits.maxEntriesPerDirectory ||
        state.visitedEntries >= state.limits.maxVisitedEntries
      ) {
        state.truncated = true;
        return [];
      }
      const entry = handle.readSync();
      if (entry === null) return entries.sort(compareEntries);
      entries.push(entry);
      state.visitedEntries += 1;
    }
  } finally {
    handle.closeSync();
  }
}

function pushDirectoryEntries(
  stack: PendingWork[],
  relativeDirectory: string,
  depth: number,
  entries: readonly Dirent<string>[],
): void {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (entry !== undefined) {
      stack.push({ depth, entry, relativeDirectory, type: 'entry' });
    }
  }
}

function visitWork(
  workspaceRoot: string,
  work: PendingWork,
  stack: PendingWork[],
  state: WalkState,
): void {
  if (work.type === 'directory') {
    const entries = boundedDirectoryEntries(workspaceRoot, work.relativeDirectory, state);
    if (!state.truncated) pushDirectoryEntries(stack, work.relativeDirectory, work.depth, entries);
    return;
  }
  const relativePath = childRelativePath(work.relativeDirectory, work.entry.name);
  if (work.entry.isSymbolicLink()) return;
  if (work.entry.isDirectory()) {
    if (shouldExclude(relativePath, work.entry.name)) return;
    const childDepth = work.depth + 1;
    if (childDepth > state.limits.maxDepth) {
      state.truncated = true;
      return;
    }
    stack.push({ depth: childDepth, relativeDirectory: relativePath, type: 'directory' });
    return;
  }
  if (work.entry.isFile()) retainFile(relativePath, state);
}

/**
 * Enumerate files deterministically within explicit file, entry, directory,
 * per-directory, and depth budgets. A directory that cannot be enumerated in
 * full is discarded before sorting, so filesystem iteration order never leaks
 * into a partial result.
 */
export function walkFiles(
  workspaceRoot: string,
  maxFiles: number,
  limits: WalkLimits = defaultWalkLimits(maxFiles),
): WalkResult {
  const state: WalkState = {
    limits,
    paths: [],
    truncated: false,
    visitedDirectories: 0,
    visitedEntries: 0,
  };
  const stack: PendingWork[] = [{ depth: 0, relativeDirectory: '', type: 'directory' }];
  while (stack.length > 0 && !state.truncated) {
    const work = stack.pop();
    if (work !== undefined) visitWork(workspaceRoot, work, stack, state);
  }
  return { paths: state.paths, truncated: state.truncated };
}

export function globToRegex(pattern: string): RegExp {
  let expression = '^';
  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index];
    const next = pattern[index + 1];
    if (character === '*' && next === '*') {
      const after = pattern[index + 2];
      expression += after === '/' ? '(?:.*/)?' : '.*';
      index += after === '/' ? 2 : 1;
    } else if (character === '*') {
      expression += '[^/]*';
    } else if (character === '?') {
      expression += '[^/]';
    } else {
      expression += escapeRegularExpression(character ?? '');
    }
  }
  return new RegExp(`${expression}$`, 'u');
}

export function readPrefix(
  path: string,
  maximumBytes: number,
): { readonly buffer: Buffer; readonly truncated: boolean } {
  const size = statSync(path).size;
  const requested = Math.min(size, maximumBytes + 1);
  const buffer = Buffer.alloc(requested);
  const descriptor = openSync(path, 'r');
  try {
    const bytesRead = readSync(descriptor, buffer, 0, requested, 0);
    const retained = buffer.subarray(0, Math.min(bytesRead, maximumBytes));
    return {
      buffer: retained,
      truncated: size > maximumBytes || bytesRead > maximumBytes,
    };
  } finally {
    closeSync(descriptor);
  }
}

export function renderBounded(
  lines: readonly string[],
  maxBytes: number,
  truncated: boolean,
): {
  readonly rendered: string;
  readonly retainedCount: number;
  readonly truncated: boolean;
} {
  const retained: string[] = [];
  let used = 0;
  let outputTruncated = truncated;
  for (const line of lines) {
    const renderedLine = retained.length === 0 ? line : `\n${line}`;
    const bytes = Buffer.byteLength(renderedLine, 'utf8');
    if (used + bytes > maxBytes) {
      outputTruncated = true;
      break;
    }
    retained.push(line);
    used += bytes;
  }
  if (outputTruncated) {
    const markerBytes = Buffer.byteLength(TRUNCATION_MARKER, 'utf8');
    while (retained.length > 0 && used + markerBytes + 1 > maxBytes) {
      const removed = retained.pop();
      if (removed !== undefined) used -= Buffer.byteLength(removed, 'utf8') + 1;
    }
    const retainedCount = retained.length;
    if (markerBytes <= maxBytes) retained.push(TRUNCATION_MARKER);
    return {
      rendered: retained.join('\n'),
      retainedCount,
      truncated: outputTruncated,
    };
  }
  return {
    rendered: retained.join('\n'),
    retainedCount: retained.length,
    truncated: outputTruncated,
  };
}
