/**
 * @fileoverview `opensip uninstall` — remove opensip-cli state
 * from a user account and/or project.
 *
 * Two modes:
 *
 *  • Default / `--user` — remove the user-level directory
 *    `~/.opensip-cli/`. Task 4.7 owns crash-recoverable user removal;
 *    this mode remains the simple synchronous path until then.
 *
 *  • `--project [path]` — lease-safe project removal via
 *    {@link executeProjectRemoval}: every generation-bound/legacy cache
 *    candidate plus project runtime, preserving authored content unless
 *    `--purge`. Optional `--discard-recovery` is break-glass for stuck
 *    promotion journals (requires `--purge`).
 *
 * Does NOT remove the npm global install — the running binary can't
 * safely self-delete. Prints the exact next-step command for that.
 */

import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

import { executeProjectRemoval } from './uninstall/project-removal.js';
import { executeUserRemoval } from './uninstall/user-removal.js';

import type { UninstallMode } from './uninstall/targets.js';
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
   * config file (DESTRUCTIVE). Default (false) only removes rebuildable
   * runtime/cache state.
   */
  readonly purge?: boolean;
  /**
   * High-risk project break-glass: after purge, discard a stuck fixed
   * promotion journal. Requires `--project --purge`.
   */
  readonly discardRecovery?: boolean;
  /** Human-presentation sink supplied by the host renderer (or a test capture). */
  readonly write?: (s: string) => void;
  /** Override the confirmation prompt (primarily for tests). */
  readonly prompt?: (question: string) => Promise<string>;
}

const DEFAULT_USER_ROOT = join(homedir(), '.opensip-cli');

function writeToStdout(chunk: string): void {
  // @fitness-ignore-next-line only-documented-toolcli-seams -- Public library compatibility only; the mounted host command always injects its render-backed write seam.
  process.stdout.write(chunk);
}

/** Resolve the project directory for `--project [path]`. */
function resolveProjectDir(opts: UninstallOptions): string {
  if (typeof opts.project === 'string') return resolve(opts.project);
  return opts.projectContext?.projectRoot ?? opts.cwd ?? process.cwd();
}

/**
 * Mode dispatcher: user vs project.
 * User path is crash-recoverable ({@link executeUserRemoval});
 * project path is lease-safe ({@link executeProjectRemoval}).
 */
export async function executeUninstall(opts: UninstallOptions = {}): Promise<UninstallDoneResult> {
  const mode: UninstallMode = opts.project === undefined ? 'user' : 'project';
  const write = opts.write ?? writeToStdout;
  if (mode === 'user') {
    return executeUserRemoval({
      userRoot: opts.rootDir ?? DEFAULT_USER_ROOT,
      yes: opts.yes,
      dryRun: opts.dryRun,
      discardRecovery: opts.discardRecovery,
      write,
      prompt: opts.prompt,
    });
  }
  return executeProjectRemoval({
    projectDir: resolveProjectDir(opts),
    purge: opts.purge,
    dryRun: opts.dryRun,
    yes: opts.yes,
    discardRecovery: opts.discardRecovery,
    write,
    prompt: opts.prompt,
  });
}
// Re-export for tests that imported Target types from the executor path.
export type { Target, UninstallMode } from './uninstall/targets.js';
