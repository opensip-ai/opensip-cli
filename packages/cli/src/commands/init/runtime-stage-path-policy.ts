import { lstatSync, readlinkSync, realpathSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';

import { isPathContained } from './path-containment.js';
import {
  runtimeStageFail,
  runtimeStageIdentity,
  sameRuntimeStageIdentity,
} from './runtime-stage-stable-directory.js';

/** Validate the journal-owned destination-sibling stage basename. */
export function assertSafeStageBasename(value: string): void {
  if (
    value.length === 0 ||
    value.length > 128 ||
    value === '.' ||
    value === '..' ||
    value.includes('/') ||
    value.includes('\\') ||
    value.includes('\0')
  ) {
    runtimeStageFail('invalid-path');
  }
}

/** Prove that a source symlink and its canonical target remain inside the source root. */
export function assertSafeSourceSymlink(root: string, path: string, expectedTarget: string): void {
  const before = lstatSync(path, { bigint: true });
  if (!before.isSymbolicLink()) runtimeStageFail('changed');
  const target = readlinkSync(path);
  if (
    target !== expectedTarget ||
    target.length === 0 ||
    target.includes('\0') ||
    isAbsolute(target)
  ) {
    runtimeStageFail('changed');
  }
  const targetPath = resolve(join(path, '..'), target);
  if (!isPathContained(root, targetPath)) runtimeStageFail('symlink-escape');
  let canonicalTarget: string;
  try {
    canonicalTarget = realpathSync(targetPath);
  } catch {
    runtimeStageFail('symlink-invalid');
  }
  if (!isPathContained(root, canonicalTarget)) runtimeStageFail('symlink-escape');
  const after = lstatSync(path, { bigint: true });
  if (
    !after.isSymbolicLink() ||
    !sameRuntimeStageIdentity(runtimeStageIdentity(before), runtimeStageIdentity(after))
  ) {
    runtimeStageFail('changed');
  }
}

/** Prove one materialized source/destination path remains under its selected root. */
export function runtimeStagePathIsContained(root: string, path: string): boolean {
  return isPathContained(root, path);
}
