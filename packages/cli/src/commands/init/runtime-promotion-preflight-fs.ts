import { realpathSync } from 'node:fs';
import { join } from 'node:path';

import {
  EPHEMERAL_MARKER_FILE,
  EPHEMERAL_MARKER_MAX_BYTES,
  legacyEphemeralProjectCacheKey,
  readAnchoredRecord,
  resolveEphemeralProjectPaths,
  resolveProjectPaths,
  resolveUserPaths,
  type EphemeralProjectPaths,
  type RuntimeExclusiveLease,
} from '@opensip-cli/core';

import { type RuntimePromotionSource } from './runtime-promotion-journal-schema.js';
import {
  currentRuntimePromotionMarkerMatches,
  readRuntimePromotionMarkerRecord,
} from './runtime-promotion-marker.js';
import {
  runtimePromotionPathSnapshot,
  sameRuntimePromotionPathSnapshot,
  type RuntimePromotionPathSnapshot,
} from './runtime-promotion-path-snapshot.js';
import { RuntimePromotionFilesystemLeaseMismatchError } from './runtime-promotion-recovery-source-authority.js';

import type { RuntimePromotionPreflightFsDependencies } from './runtime-promotion-recovery-source-authority.js';

export {
  runtimePromotionPathSnapshot,
  sameRuntimePromotionPathSnapshot,
} from './runtime-promotion-path-snapshot.js';
export type {
  RuntimePromotionPathIdentity,
  RuntimePromotionPathPresence,
  RuntimePromotionPathSnapshot,
} from './runtime-promotion-path-snapshot.js';
export {
  assertRuntimePromotionRecoverySourceAuthority,
  assertRuntimePromotionRecoverySourceLocation,
  bindRuntimePromotionCacheChild,
  canonicalRuntimePromotionCacheChild,
  RuntimePromotionFilesystemLeaseMismatchError,
} from './runtime-promotion-recovery-source-authority.js';
export type {
  RuntimePromotionBoundCacheChild,
  RuntimePromotionCanonicalCacheChild,
  RuntimePromotionPreflightFsDependencies,
  RuntimePromotionRecoverySourceAuthorityInput,
} from './runtime-promotion-recovery-source-authority.js';

export interface RuntimePromotionSourceRevalidation {
  readonly kind: 'active' | 'legacy';
  readonly runtimeDir: string;
  readonly cacheKey: string;
  readonly markerSha256: string;
  readonly runtime: RuntimePromotionPathSnapshot;
}

export interface RuntimePromotionFilesystemInspection {
  readonly projectRoot: string;
  readonly ephemeral: Pick<
    EphemeralProjectPaths,
    'cacheKey' | 'coordinationKey' | 'identityStrength' | 'canonicalRootDigest' | 'generationDigest'
  >;
  readonly projectRootSnapshot: RuntimePromotionPathSnapshot;
  readonly activeCandidateDir: string;
  readonly activeCandidate: RuntimePromotionPathSnapshot;
  readonly legacyCandidateDir?: string;
  readonly legacyCandidate?: RuntimePromotionPathSnapshot;
  readonly destinationParentDir: string;
  readonly destinationRuntimeDir: string;
  readonly destinationParent: RuntimePromotionPathSnapshot;
  readonly destinationRuntime: RuntimePromotionPathSnapshot;
  readonly source: RuntimePromotionSource;
  readonly sourceRevalidation?: RuntimePromotionSourceRevalidation;
}

export type RuntimePromotionFilesystemConflictReason =
  | 'cache-candidates-ambiguous'
  | 'cache-marker-invalid'
  | 'cache-path-unsafe'
  | 'project-path-unsafe';

export type RuntimePromotionFilesystemInspectionResult =
  | {
      readonly status: 'ready';
      readonly inspection: RuntimePromotionFilesystemInspection;
    }
  | {
      readonly status: 'conflict';
      readonly reason: RuntimePromotionFilesystemConflictReason;
      readonly sourcePreserved: boolean;
    };

const PROJECT_PATH_UNSAFE = 'project-path-unsafe' as const;
const GENERATION_BOUND = 'generation-bound' as const;
const OWNER_CONTROLLED = 'owner-controlled' as const;

function inspectSource(input: {
  readonly projectRoot: string;
  readonly paths: EphemeralProjectPaths;
  readonly active: RuntimePromotionPathSnapshot;
  readonly legacy: RuntimePromotionPathSnapshot;
  readonly legacyKey: string;
  readonly legacyDir: string;
  readonly dependencies: RuntimePromotionPreflightFsDependencies;
}):
  | {
      readonly status: 'ready';
      readonly source: RuntimePromotionSource;
      readonly revalidation?: RuntimePromotionSourceRevalidation;
    }
  | {
      readonly status: 'conflict';
      readonly reason: RuntimePromotionFilesystemConflictReason;
      readonly sourcePreserved: boolean;
    } {
  const activePresent = input.active.presence !== 'absent';
  const legacyPresent = input.legacy.presence !== 'absent';
  if (activePresent && legacyPresent) {
    return {
      status: 'conflict',
      reason: 'cache-candidates-ambiguous',
      sourcePreserved: true,
    };
  }
  if (!activePresent && !legacyPresent) {
    return {
      status: 'ready',
      source: {
        classification: 'none',
        cacheKey: null,
        generationDigest: null,
        markerSha256: null,
        rootIdentity: null,
      },
    };
  }

  const selected =
    input.active.presence === 'absent'
      ? {
          kind: 'legacy' as const,
          runtimeDir: input.legacyDir,
          cacheKey: input.legacyKey,
          snapshot: input.legacy,
        }
      : {
          kind: 'active' as const,
          runtimeDir: input.paths.runtimeDir,
          cacheKey: input.paths.cacheKey,
          snapshot: input.active,
        };
  if (selected.snapshot.presence !== 'directory') {
    return {
      status: 'conflict',
      reason: 'cache-path-unsafe',
      sourcePreserved: true,
    };
  }
  const selectedIdentity = selected.snapshot.identity;
  if (selectedIdentity === undefined) {
    return {
      status: 'conflict',
      reason: 'cache-path-unsafe',
      sourcePreserved: true,
    };
  }

  const observed = readRuntimePromotionMarkerRecord(selected.runtimeDir);
  input.dependencies.afterMarkerRead?.();
  if (observed === undefined) {
    return {
      status: 'conflict',
      reason: 'cache-marker-invalid',
      sourcePreserved: true,
    };
  }
  const marker = observed.marker;
  if (marker?.marker.projectDir !== input.projectRoot) {
    return {
      status: 'conflict',
      reason: 'cache-marker-invalid',
      sourcePreserved: true,
    };
  }
  const runtimeAfter = runtimePromotionPathSnapshot(selected.runtimeDir);
  if (!sameRuntimePromotionPathSnapshot(selected.snapshot, runtimeAfter)) {
    return {
      status: 'conflict',
      reason: 'cache-path-unsafe',
      sourcePreserved: true,
    };
  }

  const exactCurrent =
    selected.kind === 'active' &&
    marker.kind === 'current' &&
    currentRuntimePromotionMarkerMatches(marker.marker, input.paths);
  const classification = exactCurrent ? input.paths.identityStrength : 'legacy';
  return {
    status: 'ready',
    source: {
      classification,
      cacheKey: selected.cacheKey,
      generationDigest:
        classification === GENERATION_BOUND ? (input.paths.generationDigest ?? null) : null,
      markerSha256: observed.sha256,
      rootIdentity: {
        device: selectedIdentity.dev,
        inode: selectedIdentity.ino,
      },
    },
    revalidation: {
      kind: selected.kind,
      runtimeDir: selected.runtimeDir,
      cacheKey: selected.cacheKey,
      markerSha256: observed.sha256,
      runtime: runtimeAfter,
    },
  };
}

function leaseMatches(lease: RuntimeExclusiveLease, paths: EphemeralProjectPaths): boolean {
  return (
    lease.kind === 'runtime-exclusive' &&
    lease.posture === 'normal' &&
    lease.coordinationKey === paths.coordinationKey
  );
}

/** @throws {RuntimePromotionFilesystemLeaseMismatchError} When the lease is not project-bound. */
export function inspectRuntimePromotionFilesystem(
  projectRootInput: string,
  lease: RuntimeExclusiveLease,
  dependencies: RuntimePromotionPreflightFsDependencies = {},
): RuntimePromotionFilesystemInspectionResult {
  let projectRoot: string;
  try {
    projectRoot = realpathSync(projectRootInput);
  } catch {
    return {
      status: 'conflict',
      reason: PROJECT_PATH_UNSAFE,
      sourcePreserved: true,
    };
  }
  const projectRootBefore = runtimePromotionPathSnapshot(projectRoot);
  if (projectRootBefore.presence !== 'directory') {
    return {
      status: 'conflict',
      reason: PROJECT_PATH_UNSAFE,
      sourcePreserved: true,
    };
  }

  let paths: EphemeralProjectPaths;
  try {
    paths = resolveEphemeralProjectPaths(projectRoot);
  } catch {
    return {
      status: 'conflict',
      reason: PROJECT_PATH_UNSAFE,
      sourcePreserved: true,
    };
  }
  if (!leaseMatches(lease, paths)) {
    throw new RuntimePromotionFilesystemLeaseMismatchError();
  }
  const projectPaths = resolveProjectPaths(projectRoot);
  const legacyKey = legacyEphemeralProjectCacheKey(projectRoot);
  const legacyDir = join(resolveUserPaths().ephemeralProjectsDir, legacyKey);
  const active = runtimePromotionPathSnapshot(paths.runtimeDir);
  const legacy =
    legacyKey === paths.cacheKey
      ? ({ presence: 'absent' } as const)
      : runtimePromotionPathSnapshot(legacyDir);
  dependencies.afterCandidateResolution?.();

  const destinationParent = runtimePromotionPathSnapshot(projectPaths.userSourceDir);
  const destinationRuntime = runtimePromotionPathSnapshot(projectPaths.runtimeDir);
  if (
    destinationParent.presence === 'unsafe' ||
    destinationRuntime.presence === 'unsafe' ||
    (destinationParent.presence === 'absent' && destinationRuntime.presence !== 'absent')
  ) {
    return {
      status: 'conflict',
      reason: PROJECT_PATH_UNSAFE,
      sourcePreserved: active.presence !== 'absent' || legacy.presence !== 'absent',
    };
  }

  const source = inspectSource({
    projectRoot,
    paths,
    active,
    legacy,
    legacyKey,
    legacyDir,
    dependencies,
  });
  if (source.status === 'conflict') return source;

  const projectRootAfter = runtimePromotionPathSnapshot(projectRoot);
  if (!sameRuntimePromotionPathSnapshot(projectRootBefore, projectRootAfter)) {
    return {
      status: 'conflict',
      reason: PROJECT_PATH_UNSAFE,
      sourcePreserved: source.source.classification !== 'none',
    };
  }
  return {
    status: 'ready',
    inspection: {
      projectRoot,
      ephemeral: {
        cacheKey: paths.cacheKey,
        coordinationKey: paths.coordinationKey,
        identityStrength: paths.identityStrength,
        canonicalRootDigest: paths.canonicalRootDigest,
        ...(paths.generationDigest === undefined
          ? {}
          : { generationDigest: paths.generationDigest }),
      },
      projectRootSnapshot: projectRootAfter,
      activeCandidateDir: paths.runtimeDir,
      activeCandidate: active,
      ...(legacyKey === paths.cacheKey
        ? {}
        : { legacyCandidateDir: legacyDir, legacyCandidate: legacy }),
      destinationParentDir: projectPaths.userSourceDir,
      destinationRuntimeDir: projectPaths.runtimeDir,
      destinationParent,
      destinationRuntime,
      source: source.source,
      ...(source.revalidation === undefined ? {} : { sourceRevalidation: source.revalidation }),
    },
  };
}

export function readRuntimePromotionMarkerSha256(
  source: RuntimePromotionSourceRevalidation,
): string | undefined {
  try {
    const observed = readAnchoredRecord({
      trustedAnchorDir: resolveUserPaths().ephemeralProjectsDir,
      parentDir: source.runtimeDir,
      basename: EPHEMERAL_MARKER_FILE,
      maxBytes: EPHEMERAL_MARKER_MAX_BYTES,
      permissionPosture: OWNER_CONTROLLED,
      recordPosture: OWNER_CONTROLLED,
    });
    return observed.status === 'present' ? observed.sha256 : undefined;
  } catch {
    return;
  }
}
