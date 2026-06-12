// @fitness-ignore-file error-handling-quality -- file/dir walks for uninstall planning and best-effort tidy-up: missing/unreadable entries (TOCTOU vanish between readdir+stat, permission-denied subdirs, already-removed parent shells) are the expected non-terminal signal to skip; failure-IS-the-signal is the function contract in each catch.
/**
 * @fileoverview `opensip uninstall` — remove opensip-cli state
 * from a user account and/or project.
 *
 * Two modes:
 *
 *  • Default (no flag) — remove the user-level directory
 *    `~/.opensip-cli/`. Contract: this dir holds `config.yml` only
 *    (cloud API key + per-user defaults). Persistence and logging code
 *    throws if asked to write anywhere user-global, so the dir does
 *    not grow over time. Any pre-existing `sessions/`, `reports/`,
 *    `logs/`, or `fit/` subdirectories on disk are legacy cruft from
 *    earlier versions and are swept up by the same removal.
 *
 *  • `--project [path]` — remove project-local state at `[path]` (or
 *    cwd if omitted): both `<path>/opensip-cli/` (user-authored
 *    checks + recipes plus the gitignored `.runtime/` cache) and
 *    `<path>/opensip-cli.config.yml`. Refuses to run if neither
 *    target exists at the resolved path, to avoid `rm -rf`-ing an
 *    unrelated directory.
 *
 *    The recursive removal of `<path>/opensip-cli/` transitively
 *    sweeps up `.runtime/datastore.sqlite` and its `-wal`/`-shm` SQLite
 *    sidecars introduced in v2 — no datastore-specific path needs to be
 *    enumerated here. Caveat for Windows: open file handles can block
 *    removal of WAL/SHM files; ensure no opensip-cli CLI process is
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
 * `executeUninstall` returns a discriminated `UninstallDoneResult` whose
 * `type === 'uninstall-done'` makes it a valid `CommandResult`. The
 * trailing success / cancelled / dry-run / empty notice — previously
 * raw-stdout writes that bypassed the theme — is rendered via Ink in
 * `App.tsx`'s `case 'uninstall-done':` branch. The pre-confirmation
 * target listing stays as a direct `write()` because it must appear
 * BEFORE the readline confirmation prompt; same pattern as
 * `configure.ts` printing the "current key" hint above the prompt.
 *
 * Module layout
 * -------------
 * - This file owns `executeUninstall` and removal orchestration.
 * - `uninstall/targets.ts` owns Target collection + pre-prompt display.
 */

import { existsSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';

import { resolveProjectPaths } from '@opensip-cli/core';

import {
  collectTargets,
  printProjectDefault,
  printProjectPurge,
  printUserModeTargets,
  type Target,
  type UninstallMode,
} from './uninstall/targets.js';

import type { UninstallDoneResult } from '@opensip-cli/contracts';
import type { ProjectContext } from '@opensip-cli/core';

export interface UninstallOptions {
  readonly yes?: boolean;
  readonly dryRun?: boolean;
  /**
   * If set, run in project mode and target this path. If `true`, use
   * cwd. If `undefined`, run in user-level mode.
   */
  readonly project?: string | true;
  /** Override the user-level root dir (primarily for tests). */
  readonly rootDir?: string;
  /** Override cwd resolution for `--project` with no arg (tests). */
  readonly cwd?: string;
  /**
   * Resolved ProjectContext from pre-action-hook. Used as the primary
   * source for `resolveProjectDir` when `--project` wasn't passed —
   * without it, `uninstall` run from a subdir would target the wrong
   * .runtime/.
   */
  readonly projectContext?: ProjectContext;
  /**
   * When true, in project mode also remove user-authored content and the
   * config file (DESTRUCTIVE). Default (false) only removes the
   * rebuildable .runtime/ subtree, preserving custom checks/recipes/
   * scenarios/config. `--purge` is the explicit opt-in for the old
   * destructive behavior.
   */
  readonly purge?: boolean;
  /** Override stdout (primarily for tests). */
  readonly write?: (s: string) => void;
  /** Override the confirmation prompt (primarily for tests). */
  readonly prompt?: (question: string) => Promise<string>;
}

const DEFAULT_USER_ROOT = join(homedir(), '.opensip-cli');

async function confirm(
  prompt: (question: string) => Promise<string>,
  message: string,
): Promise<boolean> {
  const raw = await prompt(message);
  const answer = raw.trim().toLowerCase();
  return answer === 'y' || answer === 'yes';
}

function defaultPrompt(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return rl.question(question).finally(() => rl.close());
}

/** Resolve the project directory for `--project [path]`. */
function resolveProjectDir(opts: UninstallOptions): string {
  if (typeof opts.project === 'string') return resolve(opts.project);
  // Prefer the discovered project root (set by pre-action-hook). Falls
  // back to literal cwd, then process.cwd(). Without the discovered
  // root, `uninstall` from a subdir would target the wrong .runtime/.
  return opts.projectContext?.projectRoot ?? opts.cwd ?? process.cwd();
}

/** Project a `Target[]` into the result-shape `{path, kind}[]`. */
function targetsForResult(
  targets: readonly Target[],
): readonly { readonly path: string; readonly kind: 'file' | 'dir' }[] {
  return targets.map((t) => ({ path: t.path, kind: t.kind }));
}

/**
 * Build the canonical "no-op" / "post-removal" result. The `action`
 * discriminator is the single source of truth for what happened
 * (`removed` / `dry-run` / `cancelled` / `empty`); consumers branch on
 * it rather than on derived boolean flags.
 */
function buildResult(args: {
  action: UninstallDoneResult['action'];
  mode: UninstallMode;
  targets: readonly Target[];
  rootPath: string;
}): UninstallDoneResult {
  const sizeBytes = args.targets.reduce((sum, t) => sum + t.sizeBytes, 0);
  return {
    type: 'uninstall-done',
    action: args.action,
    mode: args.mode,
    targets: targetsForResult(args.targets),
    sizeBytes,
    rootPath: args.rootPath,
  };
}

/** Filter all-targets into (toDelete, toKeep) per mode + purge flag. */
function filterTargetsForAction(
  mode: UninstallMode,
  purge: boolean,
  allTargets: readonly Target[],
): { toDelete: readonly Target[]; toKeep: readonly Target[] } {
  if (mode === 'user' || purge) {
    return { toDelete: allTargets, toKeep: [] };
  }
  return {
    toDelete: allTargets.filter((t) => t.bucket === 'runtime'),
    toKeep: allTargets.filter((t) => t.bucket !== 'runtime'),
  };
}

/** The resolved uninstall plan a preamble summarizes. */
interface PreambleInput {
  mode: UninstallMode;
  purge: boolean;
  toDelete: readonly Target[];
  toKeep: readonly Target[];
  rootPath: string;
}

/** Print the pre-prompt summary appropriate to mode + purge state. */
function printPreambleForRun(write: (s: string) => void, input: PreambleInput): void {
  const { mode, purge, toDelete, toKeep, rootPath } = input;
  if (mode === 'user') {
    printUserModeTargets(write, toDelete);
  } else if (purge) {
    printProjectPurge(write, toDelete, rootPath);
  } else {
    printProjectDefault(write, toDelete, toKeep, rootPath);
  }
}

export async function executeUninstall(opts: UninstallOptions = {}): Promise<UninstallDoneResult> {
  const mode: UninstallMode = opts.project === undefined ? 'user' : 'project';
  const userRoot = opts.rootDir ?? DEFAULT_USER_ROOT;
  const projectDir = resolveProjectDir(opts);
  const rootPath = mode === 'user' ? userRoot : projectDir;
  const write = opts.write ?? ((s: string) => process.stdout.write(s));
  const purge = opts.purge === true;

  const allTargets = collectTargets(mode, userRoot, projectDir);
  if (allTargets.length === 0) {
    const where = mode === 'user' ? userRoot : projectDir;
    const note =
      mode === 'project'
        ? `\nNothing to remove — no OpenSIP CLI state found at ${where}.\n\n`
        : `\nNothing to remove — ${where} does not exist.\n\n`;
    write(note);
    return buildResult({ action: 'empty', mode, targets: [], rootPath });
  }

  const { toDelete, toKeep } = filterTargetsForAction(mode, purge, allTargets);

  // Empty-after-filter (project default with no .runtime/ but existing
  // user content). Print the KEPT block so the user sees what survived.
  if (mode === 'project' && toDelete.length === 0) {
    printProjectDefault(write, [], toKeep, rootPath);
    return buildResult({ action: 'empty', mode, targets: [], rootPath });
  }

  printPreambleForRun(write, { mode, purge, toDelete, toKeep, rootPath });

  if (opts.dryRun) {
    return buildResult({ action: 'dry-run', mode, targets: toDelete, rootPath });
  }

  if (opts.yes !== true) {
    const prompt = opts.prompt ?? defaultPrompt;
    const ok = await confirm(prompt, `Proceed? [y/N] `);
    if (!ok) {
      return buildResult({ action: 'cancelled', mode, targets: toDelete, rootPath });
    }
  }

  performRemoval(toDelete, mode, purge, projectDir);

  return buildResult({ action: 'removed', mode, targets: toDelete, rootPath });
}

/**
 * Delete the resolved targets and, after --purge, tidy the now-empty
 * `opensip-cli/` shell. Extracted so executeUninstall stays under the
 * cognitive-complexity threshold.
 */
function performRemoval(
  toDelete: readonly Target[],
  mode: UninstallMode,
  purge: boolean,
  projectDir: string,
): void {
  for (const t of toDelete) {
    rmSync(t.path, { recursive: true, force: true });
  }
  if (mode !== 'project' || !purge) return;
  // --purge removed children individually (each enumerated for display).
  // Tidy the parent shell so --purge matches "removes EVERYTHING."
  const paths = resolveProjectPaths(projectDir);
  if (existsSync(paths.userSourceDir)) {
    try {
      rmSync(paths.userSourceDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
}
