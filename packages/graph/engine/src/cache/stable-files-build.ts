import { SystemError } from '@opensip-cli/core';

import { graphErrorCatalog } from '../errors/graph-error-catalog.js';

import { computeFilesFingerprint } from './invalidate.js';

// Plan 01: the `GRAPH` head was mapped by nothing, so every one of these resolved to
// UNKNOWN_FAILURE — fatal and operator-only — for conditions MCP consumers branch on.
const BUILD_INCOMPLETE = graphErrorCatalog.require('GRAPH.BUILD.INCOMPLETE');

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
    code: BUILD_INCOMPLETE.code,
    definition: BUILD_INCOMPLETE,
    metadata: { view: 'source-changed' },
  });
}

/**
 * Build against a stable source-file snapshot. If source metadata changes
 * while the build is running, retry once; repeated churn fails instead of
 * stamping stale parsed content with the newer fingerprint.
 *
 * @throws {SystemError} `GRAPH.CATALOG.SOURCE_CHANGED_DURING_BUILD` if the
 *   source-file fingerprint differs before/after the build on every attempt
 *   up to {@link MAX_BUILD_ATTEMPTS} (persistent churn, not a one-off change).
 */
export async function buildAgainstStableFiles<T>(
  input: StableFilesBuildInput<T>,
): Promise<StableFilesBuildOutput<T>> {
  // A retry STATE MACHINE, not a batch: each attempt runs only after the previous
  // attempt's fingerprint proved unstable, and a stable attempt returns immediately.
  // The attempts are therefore inherently sequential — parallelizing them would
  // defeat the "retry only on churn" contract — so this is expressed as bounded
  // recursion rather than a for-await loop.
  const attemptBuild = async (attempt: number): Promise<StableFilesBuildOutput<T>> => {
    const fingerprintBefore =
      attempt === 0
        ? (input.initialFingerprint ?? computeFilesFingerprint(input.files))
        : computeFilesFingerprint(input.files);
    const value = await input.build(attempt);
    const fingerprintAfter = computeFilesFingerprint(input.files);
    if (fingerprintBefore === fingerprintAfter) {
      return { value, filesFingerprint: fingerprintAfter };
    }
    if (attempt + 1 >= MAX_BUILD_ATTEMPTS) {
      throw sourceFilesChangedDuringBuildError();
    }
    return attemptBuild(attempt + 1);
  };

  return attemptBuild(0);
}
