/**
 * @fileoverview `opensip-tools uninstall` — remove opensip-tools state
 * from a user account and/or project.
 *
 * Two modes:
 *
 *  • Default (no flag) — remove the user-level directory
 *    `~/.opensip-tools/`. Contract: this dir holds `config.yml` only
 *    (cloud API key + per-user defaults). Persistence and logging code
 *    throws if asked to write anywhere user-global, so the dir does
 *    not grow over time. Any pre-existing `sessions/`, `reports/`,
 *    `logs/`, or `fit/` subdirectories on disk are legacy cruft from
 *    earlier versions and are swept up by the same removal.
 *
 *  • `--project [path]` — remove project-local state at `[path]` (or
 *    cwd if omitted): both `<path>/opensip-tools/` (user-authored
 *    checks + recipes plus the gitignored `.runtime/` cache) and
 *    `<path>/opensip-tools.config.yml`. Refuses to run if neither
 *    target exists at the resolved path, to avoid `rm -rf`-ing an
 *    unrelated directory.
 *
 *    The recursive removal of `<path>/opensip-tools/` transitively
 *    sweeps up `.runtime/datastore.sqlite` and its `-wal`/`-shm` SQLite
 *    sidecars introduced in v2 — no datastore-specific path needs to be
 *    enumerated here. Caveat for Windows: open file handles can block
 *    removal of WAL/SHM files; ensure no opensip-tools CLI process is
 *    active when running uninstall.
 *
 * Does NOT remove the npm global install — the running binary can't
 * safely self-delete. Prints the exact next-step command for that.
 *
 * Flags:
 *   --project [path]   Remove project-local state instead of user-level.
 *   --yes              Skip confirmation prompt.
 *   --dry-run          Print what would be removed; take no action.
 *
 * Result-shape contract (audit 2026-05-23 G5)
 * -------------------------------------------
 * `executeUninstall` returns a discriminated `UninstallResult` whose
 * `type === 'uninstall-done'` makes it a valid `CommandResult`. The
 * trailing success / cancelled / dry-run / empty notice — previously
 * raw-stdout writes that bypassed the theme — is rendered via Ink in
 * `App.tsx`'s `case 'uninstall-done':` branch. The pre-confirmation
 * target listing stays as a direct `write()` because it must appear
 * BEFORE the readline confirmation prompt; same pattern as
 * `configure.ts` printing the "current key" hint above the prompt.
 */

import { existsSync, rmSync, statSync, readdirSync, type Dirent } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { createInterface } from 'node:readline/promises'

import { resolveProjectPaths } from '@opensip-tools/core'

import type { UninstallDoneResult } from '@opensip-tools/contracts'
import type { ProjectContext } from '@opensip-tools/core'

type UninstallMode = 'user' | 'project'

export interface UninstallOptions {
  readonly yes?: boolean
  readonly dryRun?: boolean
  /**
   * If set, run in project mode and target this path. If `true`, use
   * cwd. If `undefined`, run in user-level mode.
   */
  readonly project?: string | true
  /** Override the user-level root dir (primarily for tests). */
  readonly rootDir?: string
  /** Override cwd resolution for `--project` with no arg (tests). */
  readonly cwd?: string
  /**
   * Resolved ProjectContext from pre-action-hook. Used as the primary
   * source for `resolveProjectDir` when `--project` wasn't passed —
   * without it, `uninstall` run from a subdir would target the wrong
   * .runtime/.
   */
  readonly projectContext?: ProjectContext
  /**
   * When true, in project mode also remove user-authored content and the
   * config file (DESTRUCTIVE). Default (false) only removes the
   * rebuildable .runtime/ subtree, preserving custom checks/recipes/
   * scenarios/config. `--purge` is the explicit opt-in for the old
   * destructive behavior.
   */
  readonly purge?: boolean
  /** Override stdout (primarily for tests). */
  readonly write?: (s: string) => void
  /** Override the confirmation prompt (primarily for tests). */
  readonly prompt?: (question: string) => Promise<string>
}

/**
 * Bucket classification per target:
 *  - 'runtime'      — opensip-tools/.runtime/. Rebuildable. Removed by default.
 *  - 'user-content' — anything else under opensip-tools/. User-authored.
 *                     Preserved unless --purge.
 *  - 'config'       — opensip-tools.config.yml. Preserved unless --purge.
 *  - 'user-level'   — ~/.opensip-tools/ in user mode.
 */
type TargetBucket = 'runtime' | 'user-content' | 'config' | 'user-level'

/** Discrete target to remove (a file or a directory). */
interface Target {
  readonly path: string
  readonly kind: 'file' | 'dir'
  readonly sizeBytes: number
  readonly bucket: TargetBucket
  /** For user-content children: human label (e.g. 'fit/checks', 'notes'). */
  readonly displayLabel?: string
  /** For user-content child directories: count of files inside (recursive). */
  readonly fileCount?: number
}

/**
 * Result returned by `executeUninstall`. Extends the contract shape
 * `UninstallDoneResult` with a few legacy convenience flags
 * (`removed`, `cancelled`, `dryRun`) the existing test suite asserts
 * against. The discriminator `action` is the canonical signal; the
 * boolean flags are derivable but kept for back-compat.
 */
export interface UninstallResult extends UninstallDoneResult {
  readonly removed: boolean
  readonly dryRun: boolean
  readonly cancelled: boolean
}

const DEFAULT_USER_ROOT = join(homedir(), '.opensip-tools')

/** Recursively tally size of a directory. */
function dirSize(path: string): number {
  let total = 0
  const entries = readdirSync(path, { withFileTypes: true })
  for (const e of entries) {
    const p = join(path, e.name)
    try {
      if (e.isDirectory()) {
        total += dirSize(p)
      } else if (e.isFile()) {
        total += statSync(p).size
      }
    } catch {
      // File vanished between readdir + stat; ignore.
    }
  }
  return total
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`
}

async function confirm(
  prompt: (question: string) => Promise<string>,
  message: string,
): Promise<boolean> {
  const raw = await prompt(message)
  const answer = raw.trim().toLowerCase()
  return answer === 'y' || answer === 'yes'
}

function defaultPrompt(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  return rl.question(question).finally(() => rl.close())
}

/** Resolve the project directory for `--project [path]`. */
function resolveProjectDir(opts: UninstallOptions): string {
  if (typeof opts.project === 'string') return resolve(opts.project)
  // Prefer the discovered project root (set by pre-action-hook). Falls
  // back to literal cwd, then process.cwd(). Without the discovered
  // root, `uninstall` from a subdir would target the wrong .runtime/.
  return opts.projectContext?.projectRoot ?? opts.cwd ?? process.cwd()
}

/** Count files recursively under a directory; best-effort (unreadable subdirs skipped). */
function countFilesRecursive(dir: string): number {
  let count = 0
  const walk = (d: string): void => {
    try {
      const entries = readdirSync(d, { withFileTypes: true })
      for (const e of entries) {
        const p = join(d, e.name)
        if (e.isDirectory()) walk(p)
        else if (e.isFile()) count++
      }
    } catch { /* unreadable subdir — best-effort */ }
  }
  walk(dir)
  return count
}

/**
 * Build the bucketed list of targets that currently exist for the given mode.
 *
 * Project mode:
 *  - .runtime/                      → bucket 'runtime'
 *  - everything else under opensip-tools/ (per top-level entry)
 *                                   → bucket 'user-content' (one entry each)
 *  - opensip-tools.config.yml       → bucket 'config'
 *
 * The user-content invariant is "everything under opensip-tools/ minus
 * .runtime/" — NOT an enumeration of known subdirs like fit/ + sim/.
 * Future tools and user-created folders (e.g. opensip-tools/notes/) are
 * preserved automatically.
 */
function collectTargets(mode: UninstallMode, root: string, opts: UninstallOptions): Target[] {
  if (mode === 'user') {
    if (!existsSync(root)) return []
    return [{ path: root, kind: 'dir', sizeBytes: dirSize(root), bucket: 'user-level' }]
  }
  return collectProjectTargets(opts)
}

function collectProjectTargets(opts: UninstallOptions): Target[] {
  const paths = resolveProjectPaths(resolveProjectDir(opts))
  const targets: Target[] = []
  if (existsSync(paths.runtimeDir)) {
    targets.push({
      path: paths.runtimeDir,
      kind: 'dir',
      sizeBytes: dirSize(paths.runtimeDir),
      bucket: 'runtime',
    })
  }
  if (existsSync(paths.userSourceDir)) {
    targets.push(...collectUserContentTargets(paths.userSourceDir))
  }
  if (existsSync(paths.configFile)) {
    targets.push({
      path: paths.configFile,
      kind: 'file',
      sizeBytes: statSync(paths.configFile).size,
      bucket: 'config',
    })
  }
  return targets
}

/**
 * Enumerate every top-level entry under opensip-tools/ EXCEPT .runtime/.
 * Enumeration is for display; the invariant is "not .runtime/".
 */
function collectUserContentTargets(userSourceDir: string): Target[] {
  const out: Target[] = []
  let entries: Dirent[]
  try {
    entries = readdirSync(userSourceDir, { withFileTypes: true })
  } catch {
    return out
  }
  for (const entry of entries) {
    if (entry.name === '.runtime') continue
    const p = join(userSourceDir, entry.name)
    const isDir = entry.isDirectory()
    let sizeBytes = 0
    try { sizeBytes = isDir ? dirSize(p) : statSync(p).size } catch { /* skip unreadable */ }
    out.push({
      path: p,
      kind: isDir ? 'dir' : 'file',
      sizeBytes,
      bucket: 'user-content',
      displayLabel: entry.name,
      fileCount: isDir ? countFilesRecursive(p) : undefined,
    })
  }
  return out
}

function formatKeepLine(t: Target): string {
  if (t.bucket === 'config') return 'opensip-tools.config.yml'
  if (t.displayLabel === undefined) return t.path
  const slash = t.kind === 'dir' ? '/' : ''
  let inner = ''
  if (t.fileCount !== undefined) {
    const plural = t.fileCount === 1 ? '' : 's'
    inner = ` (${t.fileCount} file${plural})`
  }
  return `opensip-tools/${t.displayLabel}${slash}${inner}`
}

function printUserModeTargets(write: (s: string) => void, targets: readonly Target[]): void {
  const totalSize = targets.reduce((sum, t) => sum + t.sizeBytes, 0)
  write('\n')
  write(`About to remove user-level state (${formatSize(totalSize)}):\n`)
  for (const t of targets) {
    write(`  - ${t.path}${t.kind === 'dir' ? '/' : ''} (${formatSize(t.sizeBytes)})\n`)
  }
  write('\n')
}

function printProjectDefault(
  write: (s: string) => void,
  toDelete: readonly Target[],
  toKeep: readonly Target[],
  projectRoot: string,
): void {
  write('\n')
  write(`Project: ${projectRoot}\n\n`)
  if (toDelete.length === 0) {
    write('Nothing to remove — runtime state is already absent.\n\n')
  } else {
    write('This will remove (rebuildable runtime state only):\n')
    for (const t of toDelete) {
      write(`  - ${t.path}${t.kind === 'dir' ? '/' : ''}  (${formatSize(t.sizeBytes)})\n`)
      if (t.bucket === 'runtime') {
        write('    sessions database, cache, logs, baselines\n')
      }
    }
    write('\n')
  }
  if (toKeep.length > 0) {
    write('These will be KEPT (your authored content):\n')
    for (const t of toKeep) {
      write(`  ✓ ${formatKeepLine(t)}\n`)
    }
    write('\n  To also remove your authored content, re-run with --purge.\n\n')
  }
}

function printProjectPurge(
  write: (s: string) => void,
  toDelete: readonly Target[],
  projectRoot: string,
): void {
  write('\n')
  write(`Project: ${projectRoot}\n\n`)
  write('⚠ This removes EVERYTHING, including your authored content:\n\n')
  for (const t of toDelete) {
    write(`  - ${t.path}${t.kind === 'dir' ? '/' : ''}  (${formatSize(t.sizeBytes)})\n`)
  }
  write('\n  ⚠ If your custom checks are not committed to git, you will\n')
  write('    lose them. We recommend running `git status` first.\n\n')
}

/** Project a `Target[]` into the result-shape `{path, kind}[]`. */
function targetsForResult(targets: readonly Target[]): readonly { readonly path: string; readonly kind: 'file' | 'dir' }[] {
  return targets.map(t => ({ path: t.path, kind: t.kind }))
}

/**
 * Build the canonical "no-op" / "post-removal" result. Centralises the
 * derived fields (`removed`, `dryRun`, `cancelled`) so the dispatch
 * arms stay declarative.
 */
function buildResult(args: {
  action: UninstallDoneResult['action'];
  mode: UninstallMode;
  targets: readonly Target[];
  rootPath: string;
}): UninstallResult {
  const sizeBytes = args.targets.reduce((sum, t) => sum + t.sizeBytes, 0);
  return {
    type: 'uninstall-done',
    action: args.action,
    mode: args.mode,
    targets: targetsForResult(args.targets),
    sizeBytes,
    rootPath: args.rootPath,
    removed: args.action === 'removed',
    dryRun: args.action === 'dry-run',
    cancelled: args.action === 'cancelled',
  };
}

/** Filter all-targets into (toDelete, toKeep) per mode + purge flag. */
function filterTargetsForAction(
  mode: UninstallMode,
  purge: boolean,
  allTargets: readonly Target[],
): { toDelete: readonly Target[]; toKeep: readonly Target[] } {
  if (mode === 'user' || purge) {
    return { toDelete: allTargets, toKeep: [] }
  }
  return {
    toDelete: allTargets.filter((t) => t.bucket === 'runtime'),
    toKeep: allTargets.filter((t) => t.bucket !== 'runtime'),
  }
}

/** Print the pre-prompt summary appropriate to mode + purge state. */
function printPreambleForRun(
  write: (s: string) => void,
  mode: UninstallMode,
  purge: boolean,
  toDelete: readonly Target[],
  toKeep: readonly Target[],
  rootPath: string,
): void {
  if (mode === 'user') {
    printUserModeTargets(write, toDelete)
  } else if (purge) {
    printProjectPurge(write, toDelete, rootPath)
  } else {
    printProjectDefault(write, toDelete, toKeep, rootPath)
  }
}

export async function executeUninstall(opts: UninstallOptions = {}): Promise<UninstallResult> {
  const mode: UninstallMode = opts.project === undefined ? 'user' : 'project'
  const userRoot = opts.rootDir ?? DEFAULT_USER_ROOT
  const rootPath = mode === 'user' ? userRoot : resolveProjectDir(opts)
  const write = opts.write ?? ((s: string) => process.stdout.write(s))
  const purge = opts.purge === true

  const allTargets = collectTargets(mode, userRoot, opts)
  if (allTargets.length === 0) {
    const where = mode === 'user' ? userRoot : resolveProjectDir(opts)
    const note = mode === 'project'
      ? `\nNothing to remove — no opensip-tools state found at ${where}.\n\n`
      : `\nNothing to remove — ${where} does not exist.\n\n`
    write(note)
    return buildResult({ action: 'empty', mode, targets: [], rootPath })
  }

  const { toDelete, toKeep } = filterTargetsForAction(mode, purge, allTargets)

  // Empty-after-filter (project default with no .runtime/ but existing
  // user content). Print the KEPT block so the user sees what survived.
  if (mode === 'project' && toDelete.length === 0) {
    printProjectDefault(write, [], toKeep, rootPath)
    return buildResult({ action: 'empty', mode, targets: [], rootPath })
  }

  printPreambleForRun(write, mode, purge, toDelete, toKeep, rootPath)

  if (opts.dryRun) {
    return buildResult({ action: 'dry-run', mode, targets: toDelete, rootPath })
  }

  if (opts.yes !== true) {
    const prompt = opts.prompt ?? defaultPrompt
    const ok = await confirm(prompt, `Proceed? [y/N] `)
    if (!ok) {
      return buildResult({ action: 'cancelled', mode, targets: toDelete, rootPath })
    }
  }

  performRemoval(toDelete, mode, purge, opts)

  return buildResult({ action: 'removed', mode, targets: toDelete, rootPath })
}

/**
 * Delete the resolved targets and, after --purge, tidy the now-empty
 * `opensip-tools/` shell. Extracted so executeUninstall stays under the
 * cognitive-complexity threshold.
 */
function performRemoval(
  toDelete: readonly Target[],
  mode: UninstallMode,
  purge: boolean,
  opts: UninstallOptions,
): void {
  for (const t of toDelete) {
    rmSync(t.path, { recursive: true, force: true })
  }
  if (mode !== 'project' || !purge) return
  // --purge removed children individually (each enumerated for display).
  // Tidy the parent shell so --purge matches "removes EVERYTHING."
  const paths = resolveProjectPaths(resolveProjectDir(opts))
  if (existsSync(paths.userSourceDir)) {
    try { rmSync(paths.userSourceDir, { recursive: true, force: true }) } catch { /* ignore */ }
  }
}
