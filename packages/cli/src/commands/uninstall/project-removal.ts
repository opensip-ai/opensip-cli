/**
 * Lease-safe project removal for `opensip uninstall --project`.
 *
 * Dry-run snapshots under a short project read lease. Real deletion confirms
 * first (never holding an exclusive lease across the prompt), then acquires a
 * FIFO project exclusive lease, recollects/revalidates targets, and deletes
 * only canonical identities while held.
 *
 * Does not inspect or delete global user configuration, plugins, or update
 * state (Task 4.7 owns user-mode removal).
 */

import { existsSync, lstatSync, realpathSync, rmSync } from 'node:fs';
import { resolve, sep } from 'node:path';

import {
  acquireRuntimeExclusiveLease,
  acquireRuntimeReadLease,
  discardRuntimePromotionJournal,
  inspectEphemeralRuntimeCandidates,
  inspectRuntimePromotionRecoveryHeader,
  resolveProjectPaths,
  resolveUserPaths,
  type RuntimeExclusiveLease,
  type RuntimeReadLease,
} from '@opensip-cli/core';

import {
  collectTargets,
  printProjectDefault,
  printProjectPurge,
  type Target,
} from './targets.js';

import type { UninstallDoneResult, UninstallRemovalBuckets } from '@opensip-cli/contracts';

export interface ProjectRemovalOptions {
  readonly projectDir: string;
  readonly purge?: boolean;
  readonly dryRun?: boolean;
  readonly yes?: boolean;
  /** High-risk break-glass: discard fixed promotion journal after purge. */
  readonly discardRecovery?: boolean;
  readonly write?: (s: string) => void;
  readonly prompt?: (question: string) => Promise<string>;
  /** Test hook: inject lease acquisition. */
  readonly acquireReadLease?: (projectDir: string) => Promise<RuntimeReadLease>;
  readonly acquireExclusiveLease?: (
    projectDir: string,
    posture: 'normal' | 'destructive-discard',
  ) => Promise<RuntimeExclusiveLease>;
}

async function confirm(
  prompt: (question: string) => Promise<string>,
  message: string,
): Promise<boolean> {
  const raw = await prompt(message);
  const answer = raw.trim().toLowerCase();
  return answer === 'y' || answer === 'yes';
}

function assertNotSymlinkLeaf(path: string, label: string): void {
  let stat: ReturnType<typeof lstatSync>;
  try {
    stat = lstatSync(path);
  } catch {
    return;
  }
  if (stat.isSymbolicLink()) {
    throw new Error(`Refusing project removal: ${label} is a symbolic link (${path}).`);
  }
}

function assertSafeProjectDir(projectDir: string): void {
  const resolved = resolve(projectDir);
  let stat: ReturnType<typeof lstatSync>;
  try {
    stat = lstatSync(resolved);
  } catch {
    // Missing path is fine — collectTargets will report empty.
    return;
  }
  if (stat.isSymbolicLink()) {
    throw new Error(
      `Refusing project removal: project path is a symbolic link (${resolved}). Pass a real directory.`,
    );
  }
  if (!stat.isDirectory()) {
    throw new Error(`Refusing project removal: project path is not a directory (${resolved}).`);
  }
  // Intermediate layout roots must not be symlinks either.
  const paths = resolveProjectPaths(resolved);
  assertNotSymlinkLeaf(paths.userSourceDir, 'opensip-cli/');
  assertNotSymlinkLeaf(paths.runtimeDir, 'opensip-cli/.runtime/');
  assertNotSymlinkLeaf(paths.configFile, 'opensip-cli.config.yml');
}

function isPathInside(parentReal: string, childReal: string): boolean {
  if (parentReal === childReal) return true;
  const prefix = parentReal.endsWith(sep) ? parentReal : `${parentReal}${sep}`;
  return childReal.startsWith(prefix);
}

/**
 * Ensure every deletion target resolves inside the project tree or the known
 * ephemeral cache root — never follow intermediate symlink escapes.
 */
function assertTargetsContained(projectDir: string, targets: readonly Target[]): void {
  let projectReal: string;
  try {
    projectReal = realpathSync(projectDir);
  } catch {
    projectReal = resolve(projectDir);
  }
  let cacheRootReal: string | undefined;
  try {
    cacheRootReal = realpathSync(resolveUserPaths().ephemeralProjectsDir);
  } catch {
    cacheRootReal = resolve(resolveUserPaths().ephemeralProjectsDir);
  }

  for (const t of targets) {
    assertNotSymlinkLeaf(t.path, `target ${t.bucket}`);
    let real: string;
    try {
      real = realpathSync(t.path);
    } catch {
      continue; // vanished — skip
    }
    const inProject = isPathInside(projectReal, real);
    const inCache = cacheRootReal !== undefined && isPathInside(cacheRootReal, real);
    if (!inProject && !inCache) {
      throw new Error(
        `Refusing project removal: target escapes allowed roots (${t.bucket}).`,
      );
    }
  }
}

function targetFingerprint(targets: readonly Target[]): string {
  return targets
    .map((t) => `${t.bucket}\0${t.path}\0${t.kind}\0${t.sizeBytes}`)
    .sort()
    .join('\n');
}

function targetsForResult(
  targets: readonly Target[],
): readonly { readonly path: string; readonly kind: 'file' | 'dir' }[] {
  // Paths are returned for the local interactive preview only; JSON consumers
  // should prefer the path-neutral `buckets` projection.
  return targets.map((t) => ({ path: t.path, kind: t.kind }));
}

function projectBuckets(targets: readonly Target[]): UninstallRemovalBuckets {
  let activeCache = 0;
  let legacyCache = 0;
  let projectRuntime = 0;
  let authored = 0;
  for (const t of targets) {
    switch (t.bucket) {
      case 'active-cache':
        activeCache += 1;
        break;
      case 'legacy-cache':
        legacyCache += 1;
        break;
      case 'runtime':
        projectRuntime += 1;
        break;
      case 'user-content':
      case 'config':
        authored += 1;
        break;
      default:
        break;
    }
  }
  return {
    ...(activeCache > 0 ? { activeCache } : {}),
    ...(legacyCache > 0 ? { legacyCache } : {}),
    ...(projectRuntime > 0 ? { projectRuntime } : {}),
    ...(authored > 0 ? { authored } : {}),
  };
}

function filterProjectTargets(
  purge: boolean,
  allTargets: readonly Target[],
): { toDelete: readonly Target[]; toKeep: readonly Target[] } {
  if (purge) {
    return { toDelete: allTargets, toKeep: [] };
  }
  return {
    toDelete: allTargets.filter(
      (t) => t.bucket === 'runtime' || t.bucket === 'active-cache' || t.bucket === 'legacy-cache',
    ),
    toKeep: allTargets.filter(
      (t) => t.bucket === 'user-content' || t.bucket === 'config',
    ),
  };
}

function buildProjectResult(args: {
  action: UninstallDoneResult['action'];
  targets: readonly Target[];
  rootPath: string;
  recovery?: UninstallDoneResult['recovery'];
}): UninstallDoneResult {
  const sizeBytes = args.targets.reduce((sum, t) => sum + t.sizeBytes, 0);
  const buckets = projectBuckets(args.targets);
  return {
    type: 'uninstall-done',
    action: args.action,
    mode: 'project',
    targets: targetsForResult(args.targets),
    sizeBytes,
    rootPath: args.rootPath,
    ...(Object.keys(buckets).length > 0 ? { buckets } : {}),
    ...(args.recovery === undefined ? {} : { recovery: args.recovery }),
  };
}

function journalBlocksRemoval(projectDir: string): {
  readonly blocked: boolean;
  readonly recovery: NonNullable<UninstallDoneResult['recovery']>;
} {
  const header = inspectRuntimePromotionRecoveryHeader(projectDir);
  if (header.status === 'absent') {
    return { blocked: false, recovery: { status: 'absent' } };
  }
  if (header.status === 'malformed') {
    return {
      blocked: true,
      recovery: { status: 'malformed', reason: header.reason },
    };
  }
  // Open or closed both block normal project removal (closed cleanup must
  // complete via Init recovery, not uninstall).
  return {
    blocked: true,
    recovery: { status: 'present', state: header.state },
  };
}

function performProjectDeletion(
  toDelete: readonly Target[],
  purge: boolean,
  projectDir: string,
): void {
  assertTargetsContained(projectDir, toDelete);
  for (const t of toDelete) {
    try {
      const st = lstatSync(t.path);
      if (st.isSymbolicLink()) continue;
    } catch {
      continue;
    }
    rmSync(t.path, { recursive: true, force: true });
  }
  if (!purge) return;
  const paths = resolveProjectPaths(projectDir);
  if (existsSync(paths.userSourceDir)) {
    try {
      assertNotSymlinkLeaf(paths.userSourceDir, 'opensip-cli/');
      assertTargetsContained(projectDir, [
        {
          path: paths.userSourceDir,
          kind: 'dir',
          sizeBytes: 0,
          bucket: 'user-content',
        },
      ]);
      rmSync(paths.userSourceDir, { recursive: true, force: true });
    } catch {
      /* refuse unsafe shell cleanup; children already handled */
    }
  }
}

/**
 * Project-mode uninstall: cache + project runtime (+ authored with --purge)
 * under a project exclusive lease for the mutation phase.
 */
export async function executeProjectRemoval(
  opts: ProjectRemovalOptions,
): Promise<UninstallDoneResult> {
  const projectDir = resolve(opts.projectDir);
  const write = opts.write ?? ((s: string) => process.stdout.write(s));
  const purge = opts.purge === true;
  const discardRecovery = opts.discardRecovery === true;

  assertSafeProjectDir(projectDir);

  if (discardRecovery && !purge) {
    write(
      '\n--discard-recovery requires --project --purge. It is a high-risk break-glass for stuck promotion journals.\n\n',
    );
    return buildProjectResult({
      action: 'empty',
      targets: [],
      rootPath: projectDir,
      recovery: { status: 'refused', reason: 'discard-requires-purge' },
    });
  }

  const journal = journalBlocksRemoval(projectDir);
  if (journal.blocked && !discardRecovery) {
    write(
      '\nRefusing project removal while a runtime promotion journal is present.\n' +
        '  Retry interrupted Init with: opensip init\n' +
        '  High-risk break-glass (deletes runtime/cache/authored + journal): opensip uninstall --project --purge --discard-recovery\n\n',
    );
    return buildProjectResult({
      action: 'empty',
      targets: [],
      rootPath: projectDir,
      recovery: journal.recovery,
    });
  }

  const acquireRead =
    opts.acquireReadLease ??
    ((dir: string) => acquireRuntimeReadLease({ projectDir: dir }));
  const acquireExclusive =
    opts.acquireExclusiveLease ??
    ((dir: string, posture: 'normal' | 'destructive-discard') =>
      acquireRuntimeExclusiveLease({ projectDir: dir, posture }));

  // Dry-run: short read lease around the snapshot only.
  if (opts.dryRun === true) {
    let readLease: RuntimeReadLease | undefined;
    try {
      readLease = await acquireRead(projectDir);
      const allTargets = collectTargets('project', '', projectDir);
      const { toDelete, toKeep } = filterProjectTargets(purge, allTargets);
      if (allTargets.length === 0) {
        write(`\nNothing to remove — no OpenSIP CLI state found at ${projectDir}.\n\n`);
        return buildProjectResult({ action: 'empty', targets: [], rootPath: projectDir });
      }
      if (toDelete.length === 0) {
        printProjectDefault(write, [], toKeep, projectDir);
        return buildProjectResult({ action: 'empty', targets: [], rootPath: projectDir });
      }
      if (purge) printProjectPurge(write, toDelete, projectDir);
      else printProjectDefault(write, toDelete, toKeep, projectDir);
      return buildProjectResult({
        action: 'dry-run',
        targets: toDelete,
        rootPath: projectDir,
        recovery: journal.recovery,
      });
    } finally {
      readLease?.release();
    }
  }

  // Pre-confirm snapshot (no exclusive lease yet).
  const preTargets = collectTargets('project', '', projectDir);
  const preFiltered = filterProjectTargets(purge, preTargets);
  const recoveryOnly = discardRecovery && journal.blocked && preFiltered.toDelete.length === 0;

  if (preTargets.length === 0 && !recoveryOnly) {
    write(`\nNothing to remove — no OpenSIP CLI state found at ${projectDir}.\n\n`);
    return buildProjectResult({
      action: 'empty',
      targets: [],
      rootPath: projectDir,
      recovery: journal.recovery,
    });
  }
  if (preFiltered.toDelete.length === 0 && !recoveryOnly) {
    printProjectDefault(write, [], preFiltered.toKeep, projectDir);
    return buildProjectResult({
      action: 'empty',
      targets: [],
      rootPath: projectDir,
      recovery: journal.recovery,
    });
  }

  if (recoveryOnly) {
    write(
      '\nNo rebuildable runtime/cache targets remain, but a promotion journal is still present.\n' +
        '  --discard-recovery will unlink only the fixed journal after exclusive confirmation.\n\n',
    );
  } else if (purge) {
    printProjectPurge(write, preFiltered.toDelete, projectDir);
  } else {
    printProjectDefault(write, preFiltered.toDelete, preFiltered.toKeep, projectDir);
  }

  if (discardRecovery) {
    write(
      '  ⚠ --discard-recovery will also unlink the fixed promotion journal after deleting canonical roots.\n\n',
    );
  }

  if (opts.yes !== true) {
    const prompt = opts.prompt;
    if (prompt === undefined) {
      const { createInterface } = await import('node:readline/promises');
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      try {
        const ok = await confirm((q) => rl.question(q), 'Proceed? [y/N] ');
        if (!ok) {
          return buildProjectResult({
            action: 'cancelled',
            targets: preFiltered.toDelete,
            rootPath: projectDir,
            recovery: journal.recovery,
          });
        }
      } finally {
        rl.close();
      }
    } else {
      const ok = await confirm(prompt, 'Proceed? [y/N] ');
      if (!ok) {
        return buildProjectResult({
          action: 'cancelled',
          targets: preFiltered.toDelete,
          rootPath: projectDir,
          recovery: journal.recovery,
        });
      }
    }
  }

  const posture = discardRecovery ? 'destructive-discard' : 'normal';
  let exclusive: RuntimeExclusiveLease | undefined;
  try {
    exclusive = await acquireExclusive(projectDir, posture);

    // Re-check journal under exclusive authority before any deletion.
    const lockedJournal = journalBlocksRemoval(projectDir);
    if (lockedJournal.blocked && !discardRecovery) {
      write(
        '\nRefusing project removal: a promotion journal appeared (or remains) under exclusive access.\n' +
          '  Retry interrupted Init with: opensip init\n\n',
      );
      return buildProjectResult({
        action: 'empty',
        targets: [],
        rootPath: projectDir,
        recovery: lockedJournal.recovery,
      });
    }

    // Re-collect under the exclusive lease and revalidate snapshot.
    const lockedTargets = collectTargets('project', '', projectDir);
    const lockedFiltered = filterProjectTargets(purge, lockedTargets);
    if (
      !recoveryOnly &&
      targetFingerprint(lockedFiltered.toDelete) !== targetFingerprint(preFiltered.toDelete)
    ) {
      if (opts.yes !== true) {
        write(
          '\nTarget snapshot changed while waiting for exclusive access. Re-run uninstall --project to review the new set.\n\n',
        );
        return buildProjectResult({
          action: 'cancelled',
          targets: lockedFiltered.toDelete,
          rootPath: projectDir,
          recovery: lockedJournal.recovery,
        });
      }
      // Explicit --yes: proceed with the revalidated set.
    }

    if (lockedFiltered.toDelete.length === 0 && !discardRecovery) {
      return buildProjectResult({
        action: 'empty',
        targets: [],
        rootPath: projectDir,
        recovery: lockedJournal.recovery,
      });
    }

    if (lockedFiltered.toDelete.length > 0) {
      performProjectDeletion(lockedFiltered.toDelete, purge, projectDir);
    }

    let recovery: UninstallDoneResult['recovery'] = lockedJournal.recovery;
    if (discardRecovery) {
      // Cache candidates are already proven via collectTargets → inspect.
      // Never follow marker projectDir for deletion roots.
      void inspectEphemeralRuntimeCandidates(projectDir);
      await discardRuntimePromotionJournal(exclusive);
      recovery = { status: 'discarded' };
    }

    return buildProjectResult({
      action: 'removed',
      targets: lockedFiltered.toDelete,
      rootPath: projectDir,
      recovery,
    });
  } finally {
    exclusive?.release();
  }
}
