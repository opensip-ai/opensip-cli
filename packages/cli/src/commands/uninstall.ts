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

import { existsSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';

import { executeProjectRemoval } from './uninstall/project-removal.js';
import {
  collectTargets,
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
   * config file (DESTRUCTIVE). Default (false) only removes rebuildable
   * runtime/cache state.
   */
  readonly purge?: boolean;
  /**
   * High-risk project break-glass: after purge, discard a stuck fixed
   * promotion journal. Requires `--project --purge`.
   */
  readonly discardRecovery?: boolean;
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
  return opts.projectContext?.projectRoot ?? opts.cwd ?? process.cwd();
}

/** Project a `Target[]` into the result-shape `{path, kind}[]`. */
function targetsForResult(
  targets: readonly Target[],
): readonly { readonly path: string; readonly kind: 'file' | 'dir' }[] {
  return targets.map((t) => ({ path: t.path, kind: t.kind }));
}

function buildUserResult(args: {
  action: UninstallDoneResult['action'];
  targets: readonly Target[];
  rootPath: string;
}): UninstallDoneResult {
  const sizeBytes = args.targets.reduce((sum, t) => sum + t.sizeBytes, 0);
  return {
    type: 'uninstall-done',
    action: args.action,
    mode: 'user',
    targets: targetsForResult(args.targets),
    sizeBytes,
    rootPath: args.rootPath,
    ...(args.targets.length > 0 ? { buckets: { user: args.targets.length } } : {}),
  };
}

async function executeUserRemoval(opts: UninstallOptions): Promise<UninstallDoneResult> {
  const userRoot = opts.rootDir ?? DEFAULT_USER_ROOT;
  const write = opts.write ?? ((s: string) => process.stdout.write(s));
  const allTargets = collectTargets('user', userRoot, '');
  if (allTargets.length === 0) {
    write(`\nNothing to remove — ${userRoot} does not exist.\n\n`);
    return buildUserResult({ action: 'empty', targets: [], rootPath: userRoot });
  }

  printUserModeTargets(write, allTargets);

  if (opts.dryRun) {
    return buildUserResult({ action: 'dry-run', targets: allTargets, rootPath: userRoot });
  }

  if (opts.yes !== true) {
    const prompt = opts.prompt ?? defaultPrompt;
    const ok = await confirm(prompt, `Proceed? [y/N] `);
    if (!ok) {
      return buildUserResult({ action: 'cancelled', targets: allTargets, rootPath: userRoot });
    }
  }

  for (const t of allTargets) {
    rmSync(t.path, { recursive: true, force: true });
  }
  return buildUserResult({ action: 'removed', targets: allTargets, rootPath: userRoot });
}

/**
 * Mode dispatcher: user vs project. Project path is lease-safe
 * ({@link executeProjectRemoval}); user path remains simple until Task 4.7.
 */
export async function executeUninstall(opts: UninstallOptions = {}): Promise<UninstallDoneResult> {
  const mode: UninstallMode = opts.project === undefined ? 'user' : 'project';
  if (mode === 'user') {
    return executeUserRemoval(opts);
  }
  return executeProjectRemoval({
    projectDir: resolveProjectDir(opts),
    purge: opts.purge,
    dryRun: opts.dryRun,
    yes: opts.yes,
    discardRecovery: opts.discardRecovery,
    write: opts.write,
    prompt: opts.prompt,
  });
}

// Re-export for tests that imported Target types from the executor path.
export type { Target, UninstallMode } from './uninstall/targets.js';
