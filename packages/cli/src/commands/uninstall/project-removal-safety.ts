import { existsSync, lstatSync, realpathSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  inspectRuntimePromotionRecoveryHeader,
  isPathInside,
  resolveProjectPaths,
  resolveUserPaths,
} from '@opensip-cli/core';

import type { Target } from './targets.js';
import type { UninstallDoneResult, UninstallRemovalBuckets } from '@opensip-cli/contracts';

/** @throws {Error} When the candidate deletion leaf is a symbolic link. */
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

/** @throws {Error} When the project path or a managed layout root is unsafe. */
export function assertSafeProjectDir(projectDir: string): void {
  const resolved = resolve(projectDir);
  let stat: ReturnType<typeof lstatSync>;
  try {
    stat = lstatSync(resolved);
  } catch {
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
  const paths = resolveProjectPaths(resolved);
  assertNotSymlinkLeaf(paths.userSourceDir, 'opensip-cli/');
  assertNotSymlinkLeaf(paths.runtimeDir, 'opensip-cli/.runtime/');
  assertNotSymlinkLeaf(paths.configFile, 'opensip-cli.config.yml');
}

/** @throws {Error} When a target escapes its authorized deletion boundary. */
function assertTargetsContained(projectDir: string, targets: readonly Target[]): void {
  let projectReal: string;
  try {
    projectReal = realpathSync(projectDir);
  } catch {
    projectReal = resolve(projectDir);
  }
  let cacheRootReal: string;
  try {
    cacheRootReal = realpathSync(resolveUserPaths().ephemeralProjectsDir);
  } catch {
    cacheRootReal = resolve(resolveUserPaths().ephemeralProjectsDir);
  }

  for (const target of targets) {
    assertNotSymlinkLeaf(target.path, `target ${target.bucket}`);
    let real: string;
    try {
      real = realpathSync(target.path);
    } catch {
      // @swallow-ok fail-closed containment: a target whose realpath cannot be resolved is SKIPPED rather than deleted, which is the safe direction for a removal path
      continue;
    }
    if (!isPathInside(real, projectReal) && !isPathInside(real, cacheRootReal)) {
      throw new Error(`Refusing project removal: target escapes allowed roots (${target.bucket}).`);
    }
  }
}

export function targetFingerprint(targets: readonly Target[]): string {
  return targets
    .map((target) => `${target.bucket}\0${target.path}\0${target.kind}\0${target.sizeBytes}`)
    .sort()
    .join('\n');
}

function projectBuckets(targets: readonly Target[]): UninstallRemovalBuckets {
  let activeCache = 0;
  let legacyCache = 0;
  let projectRuntime = 0;
  let authored = 0;
  for (const target of targets) {
    switch (target.bucket) {
      case 'active-cache': {
        activeCache += 1;
        break;
      }
      case 'legacy-cache': {
        legacyCache += 1;
        break;
      }
      case 'runtime': {
        projectRuntime += 1;
        break;
      }
      case 'user-content':
      case 'config': {
        authored += 1;
        break;
      }
      default: {
        break;
      }
    }
  }
  return {
    ...(activeCache > 0 ? { activeCache } : {}),
    ...(legacyCache > 0 ? { legacyCache } : {}),
    ...(projectRuntime > 0 ? { projectRuntime } : {}),
    ...(authored > 0 ? { authored } : {}),
  };
}

export function filterProjectTargets(
  purge: boolean,
  allTargets: readonly Target[],
): { toDelete: readonly Target[]; toKeep: readonly Target[] } {
  if (purge) return { toDelete: allTargets, toKeep: [] };
  return {
    toDelete: allTargets.filter(
      (target) =>
        target.bucket === 'runtime' ||
        target.bucket === 'active-cache' ||
        target.bucket === 'legacy-cache',
    ),
    toKeep: allTargets.filter(
      (target) => target.bucket === 'user-content' || target.bucket === 'config',
    ),
  };
}

export function buildProjectResult(args: {
  action: UninstallDoneResult['action'];
  targets: readonly Target[];
  rootPath: string;
  recovery?: UninstallDoneResult['recovery'];
}): UninstallDoneResult {
  const sizeBytes = args.targets.reduce((sum, target) => sum + target.sizeBytes, 0);
  const buckets = projectBuckets(args.targets);
  return {
    type: 'uninstall-done',
    action: args.action,
    mode: 'project',
    targets: args.targets.map((target) => ({ path: target.path, kind: target.kind })),
    sizeBytes,
    rootPath: args.rootPath,
    ...(Object.keys(buckets).length > 0 ? { buckets } : {}),
    ...(args.recovery === undefined ? {} : { recovery: args.recovery }),
  };
}

export function journalBlocksRemoval(projectDir: string): {
  readonly blocked: boolean;
  readonly recovery: NonNullable<UninstallDoneResult['recovery']>;
} {
  const header = inspectRuntimePromotionRecoveryHeader(projectDir);
  if (header.status === 'absent') {
    return { blocked: false, recovery: { status: 'absent' } };
  }
  if (header.status === 'malformed') {
    return { blocked: true, recovery: { status: 'malformed', reason: header.reason } };
  }
  return {
    blocked: true,
    recovery: { status: 'present', state: header.state },
  };
}

export function performProjectDeletion(
  toDelete: readonly Target[],
  purge: boolean,
  projectDir: string,
): void {
  assertTargetsContained(projectDir, toDelete);
  for (const target of toDelete) {
    try {
      if (lstatSync(target.path).isSymbolicLink()) continue;
    } catch {
      // @swallow-ok fail-closed containment: a target that cannot be lstat-ed is skipped rather than removed
      continue;
    }
    rmSync(target.path, { recursive: true, force: true });
  }
  if (!purge) return;
  const paths = resolveProjectPaths(projectDir);
  if (!existsSync(paths.userSourceDir)) return;
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
    // Refuse unsafe shell cleanup; canonical children were already handled.
  }
}

export type ProjectJournal = ReturnType<typeof journalBlocksRemoval>;
export type ProjectTargetSelection = ReturnType<typeof filterProjectTargets>;
