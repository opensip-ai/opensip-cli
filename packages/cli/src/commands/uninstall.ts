/**
 * @fileoverview `opensip-tools uninstall` — removes ~/.opensip-tools/
 * (plugins, sessions, logs, local config) for a clean-slate reset.
 *
 * Does NOT remove the npm global install — the running binary can't
 * safely self-delete. Prints the exact next-step command for that.
 *
 * Flags:
 *   --yes        Skip confirmation prompt.
 *   --dry-run    Print what would be removed; take no action.
 *
 * Designed for:
 *   1. Customers cleaning up ("I'm done with opensip-tools, remove my data").
 *   2. Our own test loop: uninstall, npm uninstall, reinstall, confirm
 *      the first-run welcome fires. Without this command the test loop
 *      requires `rm -rf ~/.opensip-tools/` by hand, which is easy to
 *      forget and not something we'd tell customers to type.
 */

import { existsSync, rmSync, statSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline/promises'

export interface UninstallOptions {
  readonly yes?: boolean
  readonly dryRun?: boolean
  /** Override the default dir (primarily for tests). */
  readonly rootDir?: string
  /** Override stdout (primarily for tests). */
  readonly write?: (s: string) => void
  /** Override the confirmation prompt (primarily for tests). */
  readonly prompt?: (question: string) => Promise<string>
}

export interface UninstallResult {
  readonly type: 'uninstall'
  readonly removed: boolean
  readonly path: string
  readonly sizeBytes: number
  readonly dryRun: boolean
  readonly cancelled: boolean
}

const DEFAULT_ROOT = join(homedir(), '.opensip-tools')

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

export async function executeUninstall(opts: UninstallOptions = {}): Promise<UninstallResult> {
  const root = opts.rootDir ?? DEFAULT_ROOT
  const write = opts.write ?? ((s: string) => process.stdout.write(s))

  if (!existsSync(root)) {
    write(`\nNothing to remove — ${root} does not exist.\n\n`)
    return { type: 'uninstall', removed: false, path: root, sizeBytes: 0, dryRun: opts.dryRun ?? false, cancelled: false }
  }

  const size = dirSize(root)
  const sizeStr = formatSize(size)

  // Enumerate top-level entries so the user sees what's about to go.
  const entries = readdirSync(root).sort()

  write('\n')
  write(`About to remove ${root} (${sizeStr}):\n`)
  for (const e of entries) {
    write(`  - ${e}\n`)
  }
  write('\n')

  if (opts.dryRun) {
    write(`[dry-run] No changes made. Re-run without --dry-run to remove.\n\n`)
    return { type: 'uninstall', removed: false, path: root, sizeBytes: size, dryRun: true, cancelled: false }
  }

  if (!opts.yes) {
    const prompt = opts.prompt ?? defaultPrompt
    const ok = await confirm(prompt, `Proceed? [y/N] `)
    if (!ok) {
      write(`Cancelled. No changes made.\n\n`)
      return { type: 'uninstall', removed: false, path: root, sizeBytes: size, dryRun: false, cancelled: true }
    }
  }

  rmSync(root, { recursive: true, force: true })
  write(`\n\u2713 Removed ${root} (${sizeStr}).\n`)
  write(`  To remove the CLI itself: npm uninstall -g @opensip-tools/cli\n\n`)

  return { type: 'uninstall', removed: true, path: root, sizeBytes: size, dryRun: false, cancelled: false }
}
