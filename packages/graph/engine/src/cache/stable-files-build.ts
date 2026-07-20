import { SystemError } from '@opensip-cli/core';

import { computeFilesFingerprint } from './invalidate.js';

const MAX_BUILD_ATTEMPTS = 2;

export interface StableFilesBuildInput<T> {
  readonly files: readonly string[];
  /**
   * A fingerprint already used to classify an incremental build. Reusing it
   * binds that classification decision to the same snapshot as the build.
   */
  readonly initialFingerprint?: string;
  readonly build: (attempt: number) => Promise<T>;
}

export interface StableFilesBuildOutput<T> {
  readonly value: T;
  readonly filesFingerprint: string;
}

export function sourceFilesChangedDuringBuildError(): SystemError {
  return new SystemError('Source files changed repeatedly while the graph catalog was building', {
    code: 'GRAPH.CATALOG.SOURCE_CHANGED_DURING_BUILD',
  });
}

/**
 * Build against a stable source-file snapshot. If source metadata changes
 * while the build is running, retry once; repeated churn fails instead of
 * stamping stale parsed content with the newer fingerprint.
 */
export async function buildAgainstStableFiles<T>(
  input: StableFilesBuildInput<T>,
): Promise<StableFilesBuildOutput<T>> {
  let fingerprintBefore = input.initialFingerprint;
  for (let attempt = 0; attempt < MAX_BUILD_ATTEMPTS; attempt += 1) {
    fingerprintBefore ??= computeFilesFingerprint(input.files);
    const value = await input.build(attempt);
    const fingerprintAfter = computeFilesFingerprint(input.files);
    if (fingerprintBefore === fingerprintAfter) {
      return { value, filesFingerprint: fingerprintAfter };
    }
    fingerprintBefore = undefined;
  }

  throw sourceFilesChangedDuringBuildError();
}
