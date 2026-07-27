/**
 * Bounded filesystem projections for runtime status.
 *
 * Traversal treats symlinks and paths outside the trusted anchor as unsafe,
 * and caps both entries and bytes before projecting customer-visible state.
 */

import { lstatSync, opendirSync } from 'node:fs';
import { isAbsolute, join, relative, sep } from 'node:path';

import type {
  RuntimeEvidenceDatabaseProjection,
  RuntimeLocationProjection,
} from '@opensip-cli/contracts';

export interface RuntimeStatusSizeLimits {
  readonly maxEntries: number;
  readonly maxBytes: number;
}

interface BoundedSize {
  readonly sizeBytes: number;
  readonly sizeTruncated: boolean;
}

export type RuntimePathInspection = 'missing' | 'trusted' | 'unsafe';

interface SizeAccumulator {
  sizeBytes: number;
  sizeTruncated: boolean;
  entries: number;
}

export function safePathExists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

function safeLstat(path: string): ReturnType<typeof lstatSync> | undefined {
  try {
    return lstatSync(path);
  } catch {
    return undefined;
  }
}

function addRuntimeEntry(
  path: string,
  limits: RuntimeStatusSizeLimits,
  state: SizeAccumulator,
  pending: string[],
): void {
  state.entries++;
  if (state.entries > limits.maxEntries) {
    state.sizeTruncated = true;
    return;
  }
  const stat = safeLstat(path);
  if (stat === undefined) {
    state.sizeTruncated = true;
    return;
  }
  const remaining = limits.maxBytes - state.sizeBytes;
  if (Number(stat.size) > remaining) {
    state.sizeBytes = limits.maxBytes;
    state.sizeTruncated = true;
    return;
  }
  state.sizeBytes += Number(stat.size);
  if (stat.isDirectory() && !stat.isSymbolicLink()) pending.push(path);
}

function scanDirectory(
  directory: string,
  limits: RuntimeStatusSizeLimits,
  state: SizeAccumulator,
  pending: string[],
): void {
  let handle: ReturnType<typeof opendirSync> | undefined;
  try {
    handle = opendirSync(directory);
    while (!state.sizeTruncated) {
      const entry = handle.readSync();
      if (entry === null) break;
      addRuntimeEntry(join(directory, entry.name), limits, state, pending);
    }
  } catch {
    // @swallow-ok the flag IS the surfaced degradation — `sizeTruncated` is reported in the status output, so the coverage loss is visible to the caller
    state.sizeTruncated = true;
  } finally {
    try {
      handle?.closeSync();
    } catch {
      // @swallow-ok same surfaced degradation on the descriptor-close path; a close failure cannot invalidate sizes already collected
      state.sizeTruncated = true;
    }
  }
}

function boundedSize(root: string, limits: RuntimeStatusSizeLimits): BoundedSize | undefined {
  const rootStat = safeLstat(root);
  if (rootStat === undefined) return undefined;
  const state: SizeAccumulator = {
    sizeBytes: Math.min(Number(rootStat.size), limits.maxBytes),
    sizeTruncated: Number(rootStat.size) > limits.maxBytes,
    entries: 1,
  };
  const pending = rootStat.isDirectory() && !rootStat.isSymbolicLink() ? [root] : [];

  while (pending.length > 0 && !state.sizeTruncated) {
    const directory = pending.pop();
    if (directory === undefined) break;
    scanDirectory(directory, limits, state, pending);
  }

  return { sizeBytes: state.sizeBytes, sizeTruncated: state.sizeTruncated };
}

export function inspectRuntimePath(anchor: string, runtimeDir: string): RuntimePathInspection {
  const relativePath = relative(anchor, runtimeDir);
  if (isAbsolute(relativePath) || relativePath === '..' || relativePath.startsWith(`..${sep}`)) {
    return 'unsafe';
  }
  const parts = relativePath === '' ? [] : relativePath.split(sep);
  let current = anchor;
  for (const part of ['', ...parts]) {
    if (part !== '') current = join(current, part);
    const stat = safeLstat(current);
    if (stat === undefined) return 'missing';
    if (!stat.isDirectory() || stat.isSymbolicLink()) return 'unsafe';
  }
  return 'trusted';
}

export function locationProjection(
  runtimeDir: string,
  inspection: RuntimePathInspection,
  limits: RuntimeStatusSizeLimits,
): RuntimeLocationProjection {
  if (inspection === 'missing') return { exists: false };
  if (inspection === 'unsafe') return { exists: true, sizeTruncated: true };
  const size = boundedSize(runtimeDir, limits);
  return size === undefined ? { exists: false } : { exists: true, ...size };
}

export function evidenceDatabaseProjection(
  path: string | undefined,
): RuntimeEvidenceDatabaseProjection {
  if (path === undefined) return { exists: false };
  const stat = safeLstat(path);
  if (stat === undefined) return { exists: false };
  if (!stat.isFile() || stat.isSymbolicLink()) return { exists: true };
  return { exists: true, sizeBytes: Number(stat.size) };
}
