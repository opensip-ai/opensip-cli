// CLEAN fixture for `error-destructive-path-containment` — ANCHORING proof.
//
// Reduced from the REAL call site reviewers explicitly accepted:
//   packages/cli/src/commands/uninstall/project-removal-safety.ts
//   (assertTargetsContained L49-74 -> performProjectDeletion rmSync L190)
//
// Every deleted target is realpath-resolved and asserted to be inside either
// the project root or the managed user-cache root BEFORE the recursive delete
// loop runs. `target.path` is still a caller-supplied field — the point is that
// containment is PROVEN at the deletion site, so the check must stay silent.
//
// Expected: ZERO findings.

import { lstatSync, realpathSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';

import { isPathInside, resolveUserPaths } from '@opensip-cli/core';

import type { Target } from './targets.js';

/** @throws {Error} When a target escapes its authorized deletion boundary. */
function assertTargetsContained(projectDir: string, targets: readonly Target[]): void {
  let projectReal: string;
  try {
    projectReal = realpathSync(projectDir);
  } catch {
    projectReal = resolve(projectDir);
  }
  const cacheRootReal = resolve(resolveUserPaths().ephemeralProjectsDir);

  for (const target of targets) {
    let real: string;
    try {
      real = realpathSync(target.path);
    } catch {
      continue;
    }
    if (!isPathInside(real, projectReal) && !isPathInside(real, cacheRootReal)) {
      throw new Error(`Refusing project removal: target escapes allowed roots (${target.bucket}).`);
    }
  }
}

export function performProjectDeletion(
  toDelete: readonly Target[],
  projectDir: string,
): void {
  assertTargetsContained(projectDir, toDelete);
  for (const target of toDelete) {
    try {
      if (lstatSync(target.path).isSymbolicLink()) continue;
    } catch {
      continue;
    }
    rmSync(target.path, { recursive: true, force: true });
  }
}
