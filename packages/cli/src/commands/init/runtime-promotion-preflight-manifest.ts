import { inspectRuntimeTree } from './runtime-manifest-io.js';

import type { RuntimeTreeManifest, RuntimeTreePosture } from './runtime-manifest-model.js';
import type { RuntimeManifestIdentity } from './runtime-promotion-journal-schema.js';

export interface RuntimePromotionRawManifestIdentity {
  readonly sha256: string;
  readonly rootMode: number;
  readonly entryCount: number;
  readonly fileCount: number;
  readonly directoryCount: number;
  readonly symlinkCount: number;
  readonly totalBytes: number;
}

export interface RuntimePromotionPreliminaryManifestProof {
  readonly source: RuntimePromotionRawManifestIdentity;
  readonly destination: RuntimePromotionRawManifestIdentity;
}

export interface RuntimePromotionRawManifestDependencies {
  readonly inspectRawTree: (
    runtimeDir: string,
    posture: Extract<RuntimeTreePosture, 'cache-source' | 'project-runtime'>,
  ) => RuntimeTreeManifest;
}

export const DEFAULT_RUNTIME_PROMOTION_RAW_MANIFEST_DEPENDENCIES: RuntimePromotionRawManifestDependencies =
  Object.freeze({
    inspectRawTree: (
      runtimeDir: string,
      posture: Extract<RuntimeTreePosture, 'cache-source' | 'project-runtime'>,
    ) => inspectRuntimeTree(runtimeDir, posture),
  });

export function runtimePromotionRawManifestIdentity(
  manifest: RuntimeTreeManifest,
): RuntimePromotionRawManifestIdentity {
  return {
    sha256: manifest.sha256,
    rootMode: manifest.rootMode,
    entryCount: manifest.entryCount,
    fileCount: manifest.fileCount,
    directoryCount: manifest.directoryCount,
    symlinkCount: manifest.symlinkCount,
    totalBytes: manifest.totalBytes,
  };
}

export function runtimePromotionRawManifestIdentityEqual(
  left: RuntimePromotionRawManifestIdentity,
  right: RuntimePromotionRawManifestIdentity,
): boolean {
  return (
    left.sha256 === right.sha256 &&
    left.rootMode === right.rootMode &&
    left.entryCount === right.entryCount &&
    left.fileCount === right.fileCount &&
    left.directoryCount === right.directoryCount &&
    left.symlinkCount === right.symlinkCount &&
    left.totalBytes === right.totalBytes
  );
}

function sameRawEntry(
  left: RuntimeTreeManifest['entries'][number],
  right: RuntimeTreeManifest['entries'][number],
): boolean {
  if (left.path !== right.path || left.kind !== right.kind || left.mode !== right.mode)
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

export function runtimePromotionRawManifestsEqual(
  left: RuntimeTreeManifest,
  right: RuntimeTreeManifest,
): boolean {
  return (
    runtimePromotionRawManifestIdentityEqual(
      runtimePromotionRawManifestIdentity(left),
      runtimePromotionRawManifestIdentity(right),
    ) &&
    left.entries.length === right.entries.length &&
    left.entries.every((entry, index) => {
      const other = right.entries[index];
      return other !== undefined && sameRawEntry(entry, other);
    })
  );
}

export function runtimePromotionRawIdentityMatchesVerified(
  raw: RuntimePromotionRawManifestIdentity,
  verified: RuntimeManifestIdentity,
): boolean {
  return (
    raw.sha256 === verified.digest &&
    raw.rootMode === verified.rootMode &&
    raw.fileCount === verified.fileCount &&
    raw.directoryCount === verified.directoryCount &&
    raw.symlinkCount === verified.symlinkCount &&
    raw.totalBytes === verified.totalBytes &&
    raw.entryCount === verified.fileCount + verified.directoryCount + verified.symlinkCount
  );
}
