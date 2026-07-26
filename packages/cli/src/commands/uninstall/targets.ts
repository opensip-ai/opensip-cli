/**
 * @fileoverview Uninstall target collection + display formatting.
 *
 * Extracted from `commands/uninstall.ts` so the executor there stays
 * focused on the user/project mode dispatch and removal flow. Owns:
 *
 *  - The `Target` / `TargetBucket` types
 *  - `collectTargets` (user mode + project mode bucketing)
 *  - The pre-prompt print helpers (`printUserModeTargets`,
 *    `printProjectDefault`, `printProjectPurge`) and supporting
 *    formatters (`formatBytes`, `formatKeepLine`).
 */

import { existsSync, readdirSync, statSync, type Dirent } from 'node:fs';
import { join } from 'node:path';

import { inspectEphemeralRuntimeCandidates, resolveProjectPaths, coreErrorCatalog, createToolError  } from '@opensip-cli/core';

import { formatBytes } from '../../format-bytes.js';

/**
 * Bucket classification per target:
 *  - 'runtime'       — opensip-cli/.runtime/. Rebuildable. Removed by default.
 *  - 'active-cache'  — generation-bound user-cache entry. Removed by default.
 *  - 'legacy-cache'  — pre-v2 / path-only cache entry. Removed by default.
 *  - 'user-content'  — anything else under opensip-cli/. User-authored.
 *                      Preserved unless --purge.
 *  - 'config'        — opensip-cli.config.yml. Preserved unless --purge.
 *  - 'user-level'    — ~/.opensip-cli/ in user mode.
 */
export type TargetBucket =
  'runtime' | 'active-cache' | 'legacy-cache' | 'user-content' | 'config' | 'user-level';

/** Discrete target to remove (a file or a directory). */
export interface Target {
  readonly path: string;
  readonly kind: 'file' | 'dir';
  readonly sizeBytes: number;
  readonly bucket: TargetBucket;
  /** For user-content children: human label (e.g. 'fit/checks', 'notes'). */
  readonly displayLabel?: string;
  /** For user-content child directories: count of files inside (recursive). */
  readonly fileCount?: number;
}

export type UninstallMode = 'user' | 'project';

/** Recursively tally size of a directory. */
function dirSize(path: string): number {
  let total = 0;
  const entries = readdirSync(path, { withFileTypes: true });
  for (const e of entries) {
    const p = join(path, e.name);
    try {
      if (e.isDirectory()) {
        total += dirSize(p);
      } else if (e.isFile()) {
        total += statSync(p).size;
      }
    } catch {
      // File vanished between readdir + stat; ignore.
    }
  }
  return total;
}

/** Count files recursively under a directory; best-effort (unreadable subdirs skipped). */
function countFilesRecursive(dir: string): number {
  let count = 0;
  const walk = (d: string): void => {
    try {
      const entries = readdirSync(d, { withFileTypes: true });
      for (const e of entries) {
        const p = join(d, e.name);
        if (e.isDirectory()) walk(p);
        else if (e.isFile()) count++;
      }
    } catch {
      /* unreadable subdir — best-effort */
    }
  };
  walk(dir);
  return count;
}

/**
 * Build the bucketed list of targets that currently exist for the given mode.
 *
 * Project mode:
 *  - .runtime/                      → bucket 'runtime'
 *  - active user-cache generation   → bucket 'active-cache'
 *  - legacy user-cache (if present) → bucket 'legacy-cache'
 *  - everything else under opensip-cli/ (per top-level entry)
 *                                   → bucket 'user-content' (one entry each)
 *  - opensip-cli.config.yml       → bucket 'config'
 *
 * Cache candidates come from `inspectEphemeralRuntimeCandidates` — never from
 * marker `projectDir` fields. The user-content invariant is "everything under
 * opensip-cli/ minus .runtime/" — NOT an enumeration of known subdirs.
 */
export function collectTargets(
  mode: UninstallMode,
  userRoot: string,
  projectDir: string,
): Target[] {
  if (mode === 'user') {
    if (!existsSync(userRoot)) return [];
    return [
      {
        path: userRoot,
        kind: 'dir',
        sizeBytes: dirSize(userRoot),
        bucket: 'user-level',
      },
    ];
  }
  return collectProjectTargets(projectDir);
}

function collectProjectTargets(projectDir: string): Target[] {
  const paths = resolveProjectPaths(projectDir);
  const candidates = inspectEphemeralRuntimeCandidates(projectDir);
  const targets: Target[] = [];
  if (existsSync(paths.runtimeDir)) {
    targets.push({
      path: paths.runtimeDir,
      kind: 'dir',
      sizeBytes: dirSize(paths.runtimeDir),
      bucket: 'runtime',
    });
  }
  // Avoid double-counting when the active cache path equals project runtime
  // (should not happen, but keep the projection stable).
  if (candidates.active.exists && candidates.active.runtimeDir !== paths.runtimeDir) {
    targets.push({
      path: candidates.active.runtimeDir,
      kind: 'dir',
      sizeBytes: dirSize(candidates.active.runtimeDir),
      bucket: 'active-cache',
      displayLabel: 'user-cache (active)',
    });
  }
  if (candidates.legacy?.exists === true) {
    targets.push({
      path: candidates.legacy.runtimeDir,
      kind: 'dir',
      sizeBytes: dirSize(candidates.legacy.runtimeDir),
      bucket: 'legacy-cache',
      displayLabel: 'user-cache (legacy)',
    });
  }
  if (existsSync(paths.userSourceDir)) {
    targets.push(...collectUserContentTargets(paths.userSourceDir));
  }
  if (existsSync(paths.configFile)) {
    targets.push({
      path: paths.configFile,
      kind: 'file',
      sizeBytes: statSync(paths.configFile).size,
      bucket: 'config',
    });
  }
  return targets;
}

/**
 * Enumerate every top-level entry under opensip-cli/ EXCEPT .runtime/.
 * Enumeration is for display; the invariant is "not .runtime/".
 */
function collectUserContentTargets(userSourceDir: string): Target[] {
  const out: Target[] = [];
  let entries: Dirent[];
  try {
    entries = readdirSync(userSourceDir, { withFileTypes: true });
  } catch (error) {
    // FAIL CLOSED. Returning the partial accumulator made "this directory could not be read"
    // indistinguishable from "there is nothing here" — on an UNINSTALL path, where the list is
    // what the user is shown before deleting. Under-reporting what would be removed is the
    // dangerous direction, so an unreadable directory refuses rather than under-lists.
    throw createToolError(
      coreErrorCatalog.require('CORE.RUNTIME_COORDINATION.PROBE_FAILED'),
      `Cannot enumerate uninstall targets under ${userSourceDir}`,
      { cause: error, metadata: { condition: 'uninstall-target-scan' } },
    );
  }
  for (const entry of entries) {
    if (entry.name === '.runtime') continue;
    const p = join(userSourceDir, entry.name);
    const isDir = entry.isDirectory();
    let sizeBytes = 0;
    try {
      sizeBytes = isDir ? dirSize(p) : statSync(p).size;
    } catch {
      /* skip unreadable */
    }
    out.push({
      path: p,
      kind: isDir ? 'dir' : 'file',
      sizeBytes,
      bucket: 'user-content',
      displayLabel: entry.name,
      fileCount: isDir ? countFilesRecursive(p) : undefined,
    });
  }
  return out;
}

function formatKeepLine(t: Target): string {
  if (t.bucket === 'config') return 'opensip-cli.config.yml';
  if (t.displayLabel === undefined) return t.path;
  const slash = t.kind === 'dir' ? '/' : '';
  let inner = '';
  if (t.fileCount !== undefined) {
    const plural = t.fileCount === 1 ? '' : 's';
    inner = ` (${t.fileCount} file${plural})`;
  }
  return `opensip-cli/${t.displayLabel}${slash}${inner}`;
}

export function printUserModeTargets(write: (s: string) => void, targets: readonly Target[]): void {
  const totalSize = targets.reduce((sum, t) => sum + t.sizeBytes, 0);
  write('\n');
  write(`About to remove user-level state (${formatBytes(totalSize)}):\n`);
  for (const t of targets) {
    write(`  - ${t.path}${t.kind === 'dir' ? '/' : ''} (${formatBytes(t.sizeBytes)})\n`);
  }
  write('\n');
}

function projectRuntimeLabel(target: Target): string {
  switch (target.bucket) {
    case 'active-cache': {
      return 'active user cache';
    }
    case 'legacy-cache': {
      return 'legacy user cache';
    }
    case 'runtime': {
      return 'project runtime';
    }
    default: {
      return target.path;
    }
  }
}

function printProjectRemovalTargets(write: (s: string) => void, targets: readonly Target[]): void {
  if (targets.length === 0) {
    write('Nothing to remove — runtime state is already absent.\n\n');
    return;
  }

  write('This will remove (rebuildable runtime state only):\n');
  for (const target of targets) {
    const suffix = target.kind === 'dir' ? '/' : '';
    write(`  - ${target.path}${suffix}  (${formatBytes(target.sizeBytes)})\n`);
    write(`    ${projectRuntimeLabel(target)}: sessions database, cache, logs, baselines\n`);
  }
  write('\n');
}

function printProjectKeptTargets(write: (s: string) => void, targets: readonly Target[]): void {
  if (targets.length === 0) return;

  write('These will be KEPT (your authored content):\n');
  for (const target of targets) {
    write(`  ✓ ${formatKeepLine(target)}\n`);
  }
  write('\n  To also remove your authored content, re-run with --purge.\n\n');
}

export function printProjectDefault(
  write: (s: string) => void,
  toDelete: readonly Target[],
  toKeep: readonly Target[],
  projectRoot: string,
): void {
  write('\n');
  write(`Project: ${projectRoot}\n\n`);
  printProjectRemovalTargets(write, toDelete);
  printProjectKeptTargets(write, toKeep);
}

export function printProjectPurge(
  write: (s: string) => void,
  toDelete: readonly Target[],
  projectRoot: string,
): void {
  write('\n');
  write(`Project: ${projectRoot}\n\n`);
  write('⚠ This removes EVERYTHING, including your authored content:\n\n');
  for (const t of toDelete) {
    write(`  - ${t.path}${t.kind === 'dir' ? '/' : ''}  (${formatBytes(t.sizeBytes)})\n`);
  }
  write('\n  ⚠ If your custom checks are not committed to git, you will\n');
  write('    lose them. We recommend running `git status` first.\n\n');
}
