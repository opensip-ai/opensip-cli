import { RUNTIME_MANIFEST_DIFF_SAMPLE_LIMIT } from './runtime-manifest-model.js';

import type { RuntimeManifestEntry } from './runtime-manifest-model.js';
import type { RuntimeManifestIdentity } from './runtime-promotion-journal-schema.js';

interface ComparableRuntimeManifest {
  readonly identity: RuntimeManifestIdentity;
  readonly entries: readonly RuntimeManifestEntry[];
}

export interface RuntimeManifestDifference {
  readonly equal: boolean;
  readonly onlyLeft: number;
  readonly onlyRight: number;
  readonly changed: number;
  readonly truncated: boolean;
  readonly samples: readonly {
    readonly path: string;
    readonly difference: 'only-left' | 'only-right' | 'changed';
  }[];
}

export function sameRuntimeManifestEntry(
  left: RuntimeManifestEntry,
  right: RuntimeManifestEntry,
): boolean {
  if (left.kind !== right.kind || left.path !== right.path || left.mode !== right.mode)
    return false;
  if (left.kind === 'directory' || right.kind === 'directory') {
    return left.kind === 'directory' && right.kind === 'directory';
  }
  if (left.kind === 'file' || right.kind === 'file') {
    return (
      left.kind === 'file' &&
      right.kind === 'file' &&
      left.sizeBytes === right.sizeBytes &&
      left.sha256 === right.sha256
    );
  }
  return left.target === right.target && left.targetSha256 === right.targetSha256;
}

export function runtimeManifestIdentityEqual(
  left: RuntimeManifestIdentity,
  right: RuntimeManifestIdentity,
): boolean {
  return (
    left.digest === right.digest &&
    left.rootMode === right.rootMode &&
    left.fileCount === right.fileCount &&
    left.directoryCount === right.directoryCount &&
    left.symlinkCount === right.symlinkCount &&
    left.totalBytes === right.totalBytes &&
    (left.sqlite.status === 'absent'
      ? right.sqlite.status === 'absent'
      : right.sqlite.status === 'verified' &&
        left.sqlite.sha256 === right.sqlite.sha256 &&
        left.sqlite.userVersion === right.sqlite.userVersion)
  );
}

/** Return only bounded path samples even when the complete manifests are large. */
export function compareRuntimeManifests(
  left: ComparableRuntimeManifest,
  right: ComparableRuntimeManifest,
): RuntimeManifestDifference {
  let onlyLeft = 0;
  let onlyRight = 0;
  let changed = 0;
  const samples: RuntimeManifestDifference['samples'][number][] = [];
  const sample = (
    path: string,
    difference: RuntimeManifestDifference['samples'][number]['difference'],
  ): void => {
    if (samples.length < RUNTIME_MANIFEST_DIFF_SAMPLE_LIMIT) samples.push({ path, difference });
  };

  const leftByPath = new Map(left.entries.map((entry) => [entry.path, entry]));
  const rightByPath = new Map(right.entries.map((entry) => [entry.path, entry]));
  for (const leftEntry of left.entries) {
    const rightEntry = rightByPath.get(leftEntry.path);
    if (rightEntry === undefined) {
      onlyLeft += 1;
      sample(leftEntry.path, 'only-left');
      continue;
    }
    if (!sameRuntimeManifestEntry(leftEntry, rightEntry)) {
      changed += 1;
      sample(leftEntry.path, 'changed');
    }
  }
  for (const rightEntry of right.entries) {
    if (leftByPath.has(rightEntry.path)) continue;
    onlyRight += 1;
    sample(rightEntry.path, 'only-right');
  }
  const differenceCount = onlyLeft + onlyRight + changed;
  const equal =
    differenceCount === 0 && runtimeManifestIdentityEqual(left.identity, right.identity);
  return {
    equal,
    onlyLeft,
    onlyRight,
    changed,
    truncated: differenceCount > samples.length,
    samples,
  };
}
