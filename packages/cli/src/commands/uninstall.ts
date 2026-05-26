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

import { existsSync, rmSync, statSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { createInterface } from 'node:readline/promises'

import { resolveProjectPaths } from '@opensip-tools/core'

import type { UninstallDoneResult } from '@opensip-tools/contracts'

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

export async function executeUninstall(opts: UninstallOptions = {}): Promise<UninstallResult> {
  const mode: UninstallMode = opts.project === undefined ? 'user' : 'project'
  const userRoot = opts.rootDir ?? DEFAULT_USER_ROOT
  const rootPath = mode === 'user' ? userRoot : resolveProjectDir(opts)
  const write = opts.write ?? ((s: string) => process.stdout.write(s))

  const targets = collectTargets(mode, userRoot, opts)
  if (targets.length === 0) {
    // Empty-target hint stays at the write layer because it serves the
    // same UX role as the pre-prompt target listing — informational
    // before any structured outcome surfaces. The structured
    // `action: 'empty'` is what tests assert against.
    const where = mode === 'user' ? userRoot : resolveProjectDir(opts)
    const note = mode === 'project'
      ? `\nNothing to remove — no opensip-tools state found at ${where}.\n\n`
      : `\nNothing to remove — ${where} does not exist.\n\n`
    write(note)
    return buildResult({ action: 'empty', mode, targets: [], rootPath })
  }

  printTargets(write, mode, targets)

  if (mode === 'project') {
    write(`Note: this removes user-authored content (custom checks, recipes) along with runtime state.\n`)
    write(`Git history is your safety net.\n\n`)
  }

  if (opts.dryRun) {
    return buildResult({ action: 'dry-run', mode, targets, rootPath })
  }

  if (!opts.yes) {
    const prompt = opts.prompt ?? defaultPrompt
    const ok = await confirm(prompt, `Proceed? [y/N] `)
    if (!ok) {
      return buildResult({ action: 'cancelled', mode, targets, rootPath })
    }
  }

  for (const t of targets) {
    rmSync(t.path, { recursive: true, force: true })
  }

  return buildResult({ action: 'removed', mode, targets, rootPath })
}
