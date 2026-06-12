// @fitness-ignore-file error-handling-quality -- file/dir walks for uninstall planning: missing/unreadable entries (TOCTOU vanish between readdir+stat, permission-denied subdirs) are the expected non-terminal signal to skip; failure-IS-the-signal is the contract in each catch.
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
 *    formatters (`formatSize`, `formatKeepLine`).
 */

import { existsSync, readdirSync, statSync, type Dirent } from 'node:fs';
import { join } from 'node:path';

import { resolveProjectPaths } from '@opensip-cli/core';

/**
 * Bucket classification per target:
 *  - 'runtime'      — opensip-cli/.runtime/. Rebuildable. Removed by default.
 *  - 'user-content' — anything else under opensip-cli/. User-authored.
 *                     Preserved unless --purge.
 *  - 'config'       — opensip-cli.config.yml. Preserved unless --purge.
 *  - 'user-level'   — ~/.opensip-cli/ in user mode.
 */
type TargetBucket = 'runtime' | 'user-content' | 'config' | 'user-level';

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

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
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
 *  - everything else under opensip-cli/ (per top-level entry)
 *                                   → bucket 'user-content' (one entry each)
 *  - opensip-cli.config.yml       → bucket 'config'
 *
 * The user-content invariant is "everything under opensip-cli/ minus
 * .runtime/" — NOT an enumeration of known subdirs like fit/ + sim/.
 * Future tools and user-created folders (e.g. opensip-cli/notes/) are
 * preserved automatically.
 */
export function collectTargets(
  mode: UninstallMode,
  userRoot: string,
  projectDir: string,
): Target[] {
  if (mode === 'user') {
    if (!existsSync(userRoot)) return [];
    return [{ path: userRoot, kind: 'dir', sizeBytes: dirSize(userRoot), bucket: 'user-level' }];
  }
  return collectProjectTargets(projectDir);
}

function collectProjectTargets(projectDir: string): Target[] {
  const paths = resolveProjectPaths(projectDir);
  const targets: Target[] = [];
  if (existsSync(paths.runtimeDir)) {
    targets.push({
      path: paths.runtimeDir,
      kind: 'dir',
      sizeBytes: dirSize(paths.runtimeDir),
      bucket: 'runtime',
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
  } catch {
    return out;
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
  write(`About to remove user-level state (${formatSize(totalSize)}):\n`);
  for (const t of targets) {
    write(`  - ${t.path}${t.kind === 'dir' ? '/' : ''} (${formatSize(t.sizeBytes)})\n`);
  }
  write('\n');
}

export function printProjectDefault(
  write: (s: string) => void,
  toDelete: readonly Target[],
  toKeep: readonly Target[],
  projectRoot: string,
): void {
  write('\n');
  write(`Project: ${projectRoot}\n\n`);
  if (toDelete.length === 0) {
    write('Nothing to remove — runtime state is already absent.\n\n');
  } else {
    write('This will remove (rebuildable runtime state only):\n');
    for (const t of toDelete) {
      write(`  - ${t.path}${t.kind === 'dir' ? '/' : ''}  (${formatSize(t.sizeBytes)})\n`);
      if (t.bucket === 'runtime') {
        write('    sessions database, cache, logs, baselines\n');
      }
    }
    write('\n');
  }
  if (toKeep.length > 0) {
    write('These will be KEPT (your authored content):\n');
    for (const t of toKeep) {
      write(`  ✓ ${formatKeepLine(t)}\n`);
    }
    write('\n  To also remove your authored content, re-run with --purge.\n\n');
  }
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
    write(`  - ${t.path}${t.kind === 'dir' ? '/' : ''}  (${formatSize(t.sizeBytes)})\n`);
  }
  write('\n  ⚠ If your custom checks are not committed to git, you will\n');
  write('    lose them. We recommend running `git status` first.\n\n');
}
