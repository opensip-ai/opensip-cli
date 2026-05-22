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
 */

import { existsSync, rmSync, statSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { createInterface } from 'node:readline/promises'

import { resolveProjectPaths } from '@opensip-tools/core'

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
  /** Override stdout (primarily for tests). */
  readonly write?: (s: string) => void
  /** Override the confirmation prompt (primarily for tests). */
  readonly prompt?: (question: string) => Promise<string>
}

/** Discrete target to remove (a file or a directory). */
interface Target {
  readonly path: string
  readonly kind: 'file' | 'dir'
  readonly sizeBytes: number
}

export interface UninstallResult {
  readonly type: 'uninstall'
  readonly mode: UninstallMode
  readonly removed: boolean
  readonly targets: readonly { readonly path: string; readonly kind: 'file' | 'dir' }[]
  readonly sizeBytes: number
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
  return opts.cwd ?? process.cwd()
}

/** Build the list of targets that currently exist for the given mode. */
function collectTargets(mode: UninstallMode, root: string, opts: UninstallOptions): Target[] {
  if (mode === 'user') {
    if (!existsSync(root)) return []
    return [{ path: root, kind: 'dir', sizeBytes: dirSize(root) }]
  }

  // Project mode: probe both the dir and the config file.
  const paths = resolveProjectPaths(resolveProjectDir(opts))
  const targets: Target[] = []

  if (existsSync(paths.userSourceDir)) {
    targets.push({ path: paths.userSourceDir, kind: 'dir', sizeBytes: dirSize(paths.userSourceDir) })
  }
  if (existsSync(paths.configFile)) {
    targets.push({ path: paths.configFile, kind: 'file', sizeBytes: statSync(paths.configFile).size })
  }

  return targets
}

function printTargets(write: (s: string) => void, mode: UninstallMode, targets: readonly Target[]): void {
  const totalSize = targets.reduce((sum, t) => sum + t.sizeBytes, 0)
  const label = mode === 'user' ? 'user-level state' : 'project-local state'
  write('\n')
  write(`About to remove ${label} (${formatSize(totalSize)}):\n`)
  for (const t of targets) {
    write(`  - ${t.path}${t.kind === 'dir' ? '/' : ''} (${formatSize(t.sizeBytes)})\n`)
  }
  write('\n')
}

/** Project a `Target[]` into the result-shape `{path, kind}[]`. */
function targetsForResult(targets: readonly Target[]): readonly { readonly path: string; readonly kind: 'file' | 'dir' }[] {
  return targets.map(t => ({ path: t.path, kind: t.kind }))
}

/** Render the "nothing to remove" message for the given mode. */
function handleEmptyTargets(
  mode: UninstallMode,
  opts: UninstallOptions,
  userRoot: string,
  write: (s: string) => void,
): UninstallResult {
  const where = mode === 'user' ? userRoot : resolveProjectDir(opts)
  const note = mode === 'project'
    ? `\nNothing to remove — no opensip-tools state found at ${where}.\n\n`
    : `\nNothing to remove — ${where} does not exist.\n\n`
  write(note)
  return {
    type: 'uninstall', mode, removed: false, targets: [], sizeBytes: 0,
    dryRun: opts.dryRun ?? false, cancelled: false,
  }
}

/** Print the per-mode trailing hint after a successful removal. */
function printSuccessHint(mode: UninstallMode, write: (s: string) => void): void {
  if (mode === 'user') {
    write(`  To remove the CLI itself: npm uninstall -g @opensip-tools/cli\n\n`)
  } else {
    write(`  To also remove user-level config: opensip-tools uninstall\n\n`)
  }
}

export async function executeUninstall(opts: UninstallOptions = {}): Promise<UninstallResult> {
  const mode: UninstallMode = opts.project === undefined ? 'user' : 'project'
  const userRoot = opts.rootDir ?? DEFAULT_USER_ROOT
  const write = opts.write ?? ((s: string) => process.stdout.write(s))

  const targets = collectTargets(mode, userRoot, opts)
  if (targets.length === 0) {
    return handleEmptyTargets(mode, opts, userRoot, write)
  }

  const totalSize = targets.reduce((sum, t) => sum + t.sizeBytes, 0)
  printTargets(write, mode, targets)

  if (mode === 'project') {
    write(`Note: this removes user-authored content (custom checks, recipes) along with runtime state.\n`)
    write(`Git history is your safety net.\n\n`)
  }

  if (opts.dryRun) {
    write(`[dry-run] No changes made. Re-run without --dry-run to remove.\n\n`)
    return {
      type: 'uninstall', mode, removed: false, targets: targetsForResult(targets),
      sizeBytes: totalSize, dryRun: true, cancelled: false,
    }
  }

  if (!opts.yes) {
    const prompt = opts.prompt ?? defaultPrompt
    const ok = await confirm(prompt, `Proceed? [y/N] `)
    if (!ok) {
      write(`Cancelled. No changes made.\n\n`)
      return {
        type: 'uninstall', mode, removed: false, targets: targetsForResult(targets),
        sizeBytes: totalSize, dryRun: false, cancelled: true,
      }
    }
  }

  for (const t of targets) {
    rmSync(t.path, { recursive: true, force: true })
  }

  write(`\n✓ Removed ${targets.length} target${targets.length === 1 ? '' : 's'} (${formatSize(totalSize)}).\n`)
  printSuccessHint(mode, write)

  return {
    type: 'uninstall', mode, removed: true, targets: targetsForResult(targets),
    sizeBytes: totalSize, dryRun: false, cancelled: false,
  }
}
