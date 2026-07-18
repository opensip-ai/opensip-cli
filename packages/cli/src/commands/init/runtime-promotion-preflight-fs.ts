import { createHash } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

import {
  EPHEMERAL_MARKER_FILE,
  EPHEMERAL_MARKER_MAX_BYTES,
  legacyEphemeralProjectCacheKey,
  projectCoordinationKey,
  readAnchoredRecord,
  resolveEphemeralProjectPaths,
  resolveProjectPaths,
  resolveUserPaths,
  type EphemeralMarker,
  type EphemeralProjectPaths,
  type RuntimeExclusiveLease,
} from '@opensip-cli/core';

import {
  assertStablePromotionDirectory,
  closeStablePromotionDirectory,
  openStablePromotionDirectory,
  type StablePromotionDirectory,
} from './runtime-promotion-filesystem-io.js';
import {
  RUNTIME_PROMOTION_CACHE_KEY_PATTERN,
  RUNTIME_PROMOTION_DIGEST_PATTERN,
  type RuntimePromotionSource,
} from './runtime-promotion-journal-schema.js';
import {
  currentRuntimePromotionMarkerMatches,
  parseRuntimePromotionMarker,
  readRuntimePromotionMarkerRecord,
} from './runtime-promotion-marker.js';
import {
  runtimePromotionPathSnapshot,
  sameRuntimePromotionPathSnapshot,
  type RuntimePromotionPathSnapshot,
} from './runtime-promotion-path-snapshot.js';
import { RuntimePromotionPreflightError } from './runtime-promotion-preflight-error.js';

export {
  runtimePromotionPathSnapshot,
  sameRuntimePromotionPathSnapshot,
} from './runtime-promotion-path-snapshot.js';
export type {
  RuntimePromotionPathIdentity,
  RuntimePromotionPathPresence,
  RuntimePromotionPathSnapshot,
} from './runtime-promotion-path-snapshot.js';

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

export interface RuntimePromotionPreflightFsDependencies {
  readonly afterCandidateResolution?: () => void;
  readonly afterMarkerRead?: () => void;
}

export interface RuntimePromotionRecoverySourceAuthorityInput {
  /** Already-selected canonical project root; aliases and replacements fail closed. */
  readonly projectRoot: string;
  /** Exact canonical cache path derived from the validated journal cache key. */
  readonly sourceRuntime: string;
  readonly source: RuntimePromotionSource;
  readonly lease: RuntimeExclusiveLease;
}

/**
 * Validate only the canonical location/type needed by monotonic closed
 * cleanup. Historical marker bytes are deliberately outside this proof.
 */
export function assertRuntimePromotionRecoverySourceLocation(
  input: RuntimePromotionRecoverySourceAuthorityInput,
): void {
  let canonicalProjectRoot: string;
  try {
    canonicalProjectRoot = realpathSync(input.projectRoot);
  } catch {
    recoverySourceChanged();
  }
  if (
    canonicalProjectRoot !== input.projectRoot ||
    runtimePromotionPathSnapshot(input.projectRoot).presence !== 'directory'
  ) {
    recoverySourceChanged();
  }
  if (
    input.lease.kind !== 'runtime-exclusive' ||
    input.lease.posture !== 'init-recovery' ||
    input.lease.coordinationKey !== projectCoordinationKey(input.projectRoot)
  ) {
    throw new RuntimePromotionPreflightError('lease-mismatch');
  }
  const source: RuntimePromotionSource = {
    classification: input.source.classification,
    cacheKey: input.source.cacheKey,
    generationDigest: input.source.generationDigest,
    markerSha256: input.source.markerSha256,
    rootIdentity: input.source.rootIdentity,
  };
  if (!recoverySourceShapeValid(source) || source.cacheKey === null) {
    recoverySourceChanged();
  }
  const canonical = bindRuntimePromotionCacheChild(
    resolveUserPaths().ephemeralProjectsDir,
    source.cacheKey,
  );
  if (input.sourceRuntime !== canonical.runtimeDir) {
    recoverySourceChanged();
  }
  const rootBefore = runtimePromotionPathSnapshot(canonical.cacheRoot);
  const sourceBefore = runtimePromotionPathSnapshot(canonical.runtimeDir);
  const sourceAfter = runtimePromotionPathSnapshot(canonical.runtimeDir);
  const rootAfter = runtimePromotionPathSnapshot(canonical.cacheRoot);
  if (
    rootBefore.presence !== 'directory' ||
    sourceBefore.presence !== 'directory' ||
    canonical.rootIdentity.device !== source.rootIdentity?.device ||
    canonical.rootIdentity.inode !== source.rootIdentity?.inode ||
    !sameRuntimePromotionPathSnapshot(rootBefore, rootAfter) ||
    !sameRuntimePromotionPathSnapshot(sourceBefore, sourceAfter)
  ) {
    recoverySourceChanged();
  }
}

export class RuntimePromotionFilesystemLeaseMismatchError extends Error {
  constructor() {
    super('Runtime promotion filesystem inspection requires the matching exclusive lease');
    this.name = 'RuntimePromotionFilesystemLeaseMismatchError';
  }
}

function recoverySourceChanged(): never {
  throw new RuntimePromotionPreflightError('changed-after-preflight');
}

export interface RuntimePromotionCanonicalCacheChild {
  readonly cacheRoot: string;
  readonly runtimeDir: string;
}

export interface RuntimePromotionBoundCacheChild extends RuntimePromotionCanonicalCacheChild {
  readonly rootIdentity: {
    readonly device: string;
    readonly inode: string;
  };
}

/**
 * Resolve a cache-key child from the canonical cache root without following the
 * selected leaf. Callers bind the returned path to a captured leaf identity
 * before treating it as authority.
 */
export function canonicalRuntimePromotionCacheChild(
  cacheRootInput: string,
  cacheKey: string,
): RuntimePromotionCanonicalCacheChild {
  if (!RUNTIME_PROMOTION_CACHE_KEY_PATTERN.test(cacheKey)) recoverySourceChanged();
  let cacheRoot: string;
  try {
    cacheRoot = realpathSync(cacheRootInput);
  } catch {
    recoverySourceChanged();
  }
  if (runtimePromotionPathSnapshot(cacheRoot).presence !== 'directory') {
    recoverySourceChanged();
  }
  return {
    cacheRoot,
    runtimeDir: join(cacheRoot, cacheKey),
  };
}

/**
 * Bind an existing exact cache-key child to a stable directory object. Unlike
 * canonicalRuntimePromotionCacheChild, this requires the leaf to exist. Keep
 * the path-only helper for recovery phases where the source was already
 * renamed to its journal-owned tombstone.
 */
export function bindRuntimePromotionCacheChild(
  cacheRootInput: string,
  cacheKey: string,
): RuntimePromotionBoundCacheChild {
  const canonical = canonicalRuntimePromotionCacheChild(cacheRootInput, cacheKey);
  let root: StablePromotionDirectory | undefined;
  let child: StablePromotionDirectory | undefined;
  try {
    root = openStablePromotionDirectory(canonical.cacheRoot, 'the OpenSIP cache root');
    if (root.path !== canonical.cacheRoot) recoverySourceChanged();
    const exactChild = join(root.path, cacheKey);
    if (dirname(exactChild) !== root.path || basename(exactChild) !== cacheKey) {
      recoverySourceChanged();
    }
    child = openStablePromotionDirectory(exactChild, 'the selected OpenSIP cache runtime');
    if (
      child.path !== exactChild ||
      dirname(child.path) !== root.path ||
      basename(child.path) !== cacheKey
    ) {
      recoverySourceChanged();
    }
    assertStablePromotionDirectory(root, 'the OpenSIP cache root');
    assertStablePromotionDirectory(child, 'the selected OpenSIP cache runtime');
    return {
      cacheRoot: root.path,
      runtimeDir: child.path,
      rootIdentity: {
        device: child.identity.dev.toString(),
        inode: child.identity.ino.toString(),
      },
    };
  } catch {
    return recoverySourceChanged();
  } finally {
    if (child !== undefined) closeStablePromotionDirectory(child);
    if (root !== undefined) closeStablePromotionDirectory(root);
  }
}

function recoverySourceShapeValid(source: RuntimePromotionSource): boolean {
  if (
    source.classification === 'none' ||
    source.cacheKey === null ||
    source.markerSha256 === null ||
    source.rootIdentity === null ||
    !RUNTIME_PROMOTION_CACHE_KEY_PATTERN.test(source.cacheKey) ||
    !RUNTIME_PROMOTION_DIGEST_PATTERN.test(source.markerSha256)
  ) {
    return false;
  }
  return source.classification === GENERATION_BOUND
    ? source.generationDigest !== null &&
        RUNTIME_PROMOTION_DIGEST_PATTERN.test(source.generationDigest)
    : source.generationDigest === null;
}

function recoveryMarkerRead(
  cacheRoot: string,
  sourceRuntime: string,
): {
  readonly content: string;
  readonly sha256: string;
} {
  let observed;
  try {
    observed = readAnchoredRecord({
      trustedAnchorDir: cacheRoot,
      parentDir: sourceRuntime,
      basename: EPHEMERAL_MARKER_FILE,
      maxBytes: EPHEMERAL_MARKER_MAX_BYTES,
      permissionPosture: OWNER_CONTROLLED,
      recordPosture: OWNER_CONTROLLED,
    });
  } catch {
    recoverySourceChanged();
  }
  if (observed.status !== 'present') recoverySourceChanged();
  return observed;
}

function expectedGenerationCacheKey(canonicalRootDigest: string, generationDigest: string): string {
  return createHash('sha256')
    .update(`opensip-ephemeral-cache-v2\0${canonicalRootDigest}\0${generationDigest}`)
    .digest('hex')
    .slice(0, 24);
}

function currentRecoveryMarkerMatches(input: {
  readonly projectRoot: string;
  readonly cacheKey: string;
  readonly source: RuntimePromotionSource;
  readonly marker: EphemeralMarker;
}): boolean {
  const canonicalRootDigest = createHash('sha256').update(input.projectRoot).digest('hex');
  if (
    input.marker.projectDir !== input.projectRoot ||
    input.marker.canonicalRootDigest !== canonicalRootDigest ||
    input.marker.identityStrength !== input.source.classification
  ) {
    return false;
  }
  if (input.source.classification === 'path-only') {
    return (
      input.marker.generationDigest === undefined &&
      input.source.generationDigest === null &&
      input.cacheKey === canonicalRootDigest.slice(0, 24)
    );
  }
  if (input.source.classification !== GENERATION_BOUND || input.source.generationDigest === null) {
    return false;
  }
  return (
    input.marker.generationDigest === input.source.generationDigest &&
    input.cacheKey ===
      expectedGenerationCacheKey(canonicalRootDigest, input.source.generationDigest)
  );
}

/**
 * Revalidate only the cache-source authority recorded by an existing promotion
 * journal. This seam never resolves current cache defaults or reclassifies the
 * recorded source.
 */
export function assertRuntimePromotionRecoverySourceAuthority(
  input: RuntimePromotionRecoverySourceAuthorityInput,
  dependencies: Pick<RuntimePromotionPreflightFsDependencies, 'afterMarkerRead'> = {},
): void {
  let canonicalProjectRoot: string;
  try {
    canonicalProjectRoot = realpathSync(input.projectRoot);
  } catch {
    recoverySourceChanged();
  }
  if (
    canonicalProjectRoot !== input.projectRoot ||
    runtimePromotionPathSnapshot(input.projectRoot).presence !== 'directory'
  ) {
    recoverySourceChanged();
  }
  if (
    input.lease.kind !== 'runtime-exclusive' ||
    input.lease.posture !== 'init-recovery' ||
    input.lease.coordinationKey !== projectCoordinationKey(input.projectRoot)
  ) {
    throw new RuntimePromotionPreflightError('lease-mismatch');
  }
  const source: RuntimePromotionSource = {
    classification: input.source.classification,
    cacheKey: input.source.cacheKey,
    generationDigest: input.source.generationDigest,
    markerSha256: input.source.markerSha256,
    rootIdentity: input.source.rootIdentity,
  };
  if (!recoverySourceShapeValid(source)) recoverySourceChanged();
  const cacheKey = source.cacheKey;
  const markerSha256 = source.markerSha256;
  if (cacheKey === null || markerSha256 === null) recoverySourceChanged();
  const canonical = bindRuntimePromotionCacheChild(
    resolveUserPaths().ephemeralProjectsDir,
    cacheKey,
  );
  if (input.sourceRuntime !== canonical.runtimeDir) recoverySourceChanged();
  if (
    source.rootIdentity?.device !== canonical.rootIdentity.device ||
    source.rootIdentity?.inode !== canonical.rootIdentity.inode
  ) {
    recoverySourceChanged();
  }

  const before = runtimePromotionPathSnapshot(canonical.runtimeDir);
  if (before.presence !== 'directory') recoverySourceChanged();
  const firstMarker = recoveryMarkerRead(canonical.cacheRoot, canonical.runtimeDir);
  dependencies.afterMarkerRead?.();
  const afterFirstRead = runtimePromotionPathSnapshot(canonical.runtimeDir);
  if (!sameRuntimePromotionPathSnapshot(before, afterFirstRead)) recoverySourceChanged();
  const confirmedMarker = recoveryMarkerRead(canonical.cacheRoot, canonical.runtimeDir);
  const afterConfirmation = runtimePromotionPathSnapshot(canonical.runtimeDir);
  if (!sameRuntimePromotionPathSnapshot(before, afterConfirmation)) recoverySourceChanged();
  if (
    firstMarker.sha256 !== markerSha256 ||
    confirmedMarker.sha256 !== markerSha256 ||
    firstMarker.content !== confirmedMarker.content
  ) {
    recoverySourceChanged();
  }
  const marker = parseRuntimePromotionMarker(confirmedMarker.content);
  if (marker?.marker.projectDir !== input.projectRoot) recoverySourceChanged();
  if (
    source.classification !== 'legacy' &&
    (marker.kind !== 'current' ||
      !currentRecoveryMarkerMatches({
        projectRoot: input.projectRoot,
        cacheKey,
        source,
        marker: marker.marker,
      }))
  ) {
    recoverySourceChanged();
  }
}

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
